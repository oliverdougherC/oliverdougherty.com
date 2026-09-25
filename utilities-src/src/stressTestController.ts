import {
  CPU_POOL_MAX_REPLACEMENTS,
  CPU_POOL_REPORT_TIMEOUT_MS,
  CPU_POOL_SPAWN_BATCH,
  formatStressElapsed,
  isStressMode,
  planCpuPool,
  sanitizeLogicalProcessorReport,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState,
  type CpuPoolPlan,
  type StressGpuBackend,
  type StressMode,
  type StressState
} from './stressTestCore';
import { startAdaptiveGpuStress, type StressGpuStressHandle } from './stressTestGpu';
import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';
import { primeWorkerRange } from './stressTestPrimeRanges';

interface StressWorkerRecord {
  worker: Worker;
  stopped: boolean;
  /** Lane this worker sieves: blocks workerIndex + k·poolSize. Survives replacement. */
  index: number;
  /** Pool size this worker was assigned, so a replacement sieves the same lane. */
  poolSize: number;
  /** Cumulative odd candidates this worker has sieved. */
  candidates: number;
  primesFound: number;
  activity: number;
  /** Worker's own search cursor, for activity diagnostics. */
  rangeLow: number;
  /** Blocks this worker has taken from its lane: a stalled lane is one number. */
  blocksTaken: number;
  activityElement: HTMLElement;
  messageListener: (event: MessageEvent<StressTestWorkerResponse>) => void;
  errorListener: (event: ErrorEvent) => void;
}

type StressMetricId = 'elapsed' | 'workers' | 'gpu' | 'cadence' | 'stalls' | 'iterations';

const DEFAULT_MODE: StressMode = 'both';
const METRIC_INTERVAL_MS = 120;
// CPU candidate throughput is compared across machines, so the reported rate is
// a true moving average over this fixed window instead of a single-tick delta.
const CANDIDATE_RATE_WINDOW_MS = 5000;
// Until the ring spans this much actual time, the average would be dominated by
// worker startup and the first heartbeat, so no throughput is claimed.
const CANDIDATE_RATE_MIN_SPAN_MS = 1000;
// Count gaps over an explicit duration, independent of display refresh rate.
// GPU callbacks report batch completions; CPU visuals report animation callbacks.
const RENDER_STALL_GAP_MS = 34;

/**
 * First integer of the block a lane sieves first — serial `index`, because a lane's
 * k-th block is `index + k·poolSize`. The main thread never allocates work; this only
 * labels an activity bar before that worker's first progress message arrives.
 */
function workerStartLow(index: number) {
  try {
    return primeWorkerRange(index).low;
  } catch (_error) {
    // Past the end of the safe-integer number line, which the worker itself reports
    // as a failure; a bar label is not where that gets said.
    return 0;
  }
}

const STRESS_METRIC_HIDE_ORDER: Record<StressMode, StressMetricId[]> = {
  // Hide least relevant metrics first when the control panel is height-limited.
  cpu: ['stalls', 'gpu', 'cadence', 'iterations', 'elapsed', 'workers'],
  gpu: ['stalls', 'iterations', 'workers', 'cadence', 'gpu', 'elapsed'],
  both: ['stalls', 'iterations', 'cadence', 'gpu', 'workers', 'elapsed']
};

let moduleWorkerSupport: boolean | null = null;

function readNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function supportsModuleWorkers() {
  if (moduleWorkerSupport !== null) {
    return moduleWorkerSupport;
  }

  let blobUrl = '';
  try {
    blobUrl = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    const worker = new Worker(blobUrl, { type: 'module' });
    worker.terminate();
    moduleWorkerSupport = true;
  } catch {
    moduleWorkerSupport = false;
  } finally {
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
    }
  }
  return moduleWorkerSupport;
}

/**
 * Diagnostic hook: `window.__OD_STRESS_TEST_WORKERS__ = N` asks for exactly N
 * workload workers. It is not part of the public UI contract, the normal user path
 * never sets it, and it does not make the page grow: it replaces the pool size for
 * the run, nothing else. It may exceed the browser's own report, which is how a
 * specific pool size is tested on a machine that reports something different, and an
 * unusable value is ignored rather than honoured, because a hook that spawns an
 * absurd number of workers diagnoses nothing.
 */
function readExactWorkersHook() {
  const globalValue = (window as Window & Partial<Record<'__OD_STRESS_TEST_WORKERS__', number>>)
    .__OD_STRESS_TEST_WORKERS__;
  return sanitizeLogicalProcessorReport(Number.isFinite(globalValue) ? Number(globalValue) : null);
}

export class StressTestController {
  private readonly root: HTMLElement;
  private readonly modeButtons: HTMLButtonElement[];
  private readonly startButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly elapsedLabel: HTMLElement;
  private readonly workerCountLabel: HTMLElement;
  private readonly backendLabel: HTMLElement;
  private readonly renderRateLabel: HTMLElement;
  private readonly stallLabel: HTMLElement;
  private readonly renderRateHeading: HTMLElement;
  private readonly candidateLabel: HTMLElement;
  private readonly metricsPanel: HTMLElement;
  private readonly metricCards: HTMLElement[];
  private readonly metricCardById = new Map<StressMetricId, HTMLElement>();
  private canvas: HTMLCanvasElement;
  private readonly reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  private reducedMotion = this.reducedMotionQuery.matches;

  private mode: StressMode = DEFAULT_MODE;
  private state: StressState = 'idle';
  private requestId = 0;
  private workers: StressWorkerRecord[] = [];
  private poolPlan: CpuPoolPlan | null = null;
  // Lane index for the next worker of the current run. Lanes are 0…poolSize-1 and a
  // replacement reuses the lane of the worker it replaces, so this counter only ever
  // fills the requested pool and can never widen it.
  private poolLanesFilled = 0;
  private poolSpawnTimer = 0;
  private replacementsLeft = 0;
  // Honest record of anything that kept the live pool below its requested size.
  private poolLimitation = '';
  // Largest worker-scope processor report seen this run, and the one outstanding
  // request for it. Both exist so the pool can be sized from the count the workers
  // themselves report; see planCpuPool.
  private workerReport = 0;
  private reportWait: { record: StressWorkerRecord; finish: (value: number) => void } | null = null;
  private reportTimer = 0;
  /** One-shot worker-scope report probe, alive only while the pool is being sized. */
  private reportProbe: Worker | null = null;
  private reportProbeUrl = '';
  private gpu: StressGpuStressHandle | null = null;
  private gpuAbort: AbortController | null = null;
  // requestId of the start generation whose GPU backend owns the canvas backing
  // store. While it matches, controller-side resize observation must not write
  // canvas dimensions; the backend drains in-flight batches before resizing.
  private gpuSurfaceClaim = 0;
  private gpuStartupError = '';
  private startedAt = 0;
  private metricFrameId = 0;
  private lastFrameAt = -1;
  private cadenceStartedAt = 0;
  private cadenceStartFrameCount = 0;
  private lastMetricAt = 0;
  private frameCount = 0;
  private callbackStalls = 0;
  private lastRenderRate = 0;
  private totalCandidates = 0;
  private latestPrime = 0;
  private primesFound = 0;
  private candidatesPerSecond = 0;
  private candidateRateSamples: Array<{ at: number; candidates: number }> = [];
  private pointerX = 0;
  private pointerY = 0;
  private readonly primeLabel: HTMLElement;
  private readonly primeCaption: HTMLElement;
  private readonly primeSummary: HTMLElement;
  private readonly workerSummary: HTMLElement;
  private readonly workerActivity: HTMLElement;
  private readonly gpuDetail: HTMLElement;
  private readonly visualPanel: HTMLElement;
  private gpuBackend: StressGpuBackend = 'none';
  private gpuWorkloadLevel = 0;
  private lastError = '';
  private gpuCanvasActive = false;

  private cpuVisualFrameId = 0;
  private controlPanelFitFrameId = 0;
  private canvasResizeFrameId = 0;
  private canvas2dCtx: CanvasRenderingContext2D | null = null;
  private canvasResizeObserver: ResizeObserver | null = null;
  private readonly cleanupCallbacks: Array<() => void> = [];
  constructor(root: HTMLElement) {
    this.root = root;
    this.primeLabel = this.requireElement('stressLatestPrime') as HTMLElement;
    this.primeCaption = this.requireElement('stressPrimeCaption') as HTMLElement;
    this.primeSummary = this.requireElement('stressPrimeSummary') as HTMLElement;
    this.workerSummary = this.requireElement('stressWorkerSummary') as HTMLElement;
    this.workerActivity = this.requireElement('stressWorkerActivity') as HTMLElement;
    this.gpuDetail = this.requireElement('stressGpuDetail') as HTMLElement;
    this.visualPanel = this.requireElement('stressVisualPanel') as HTMLElement;
    this.modeButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-stress-mode-option]'));
    const startEl = this.requireElement('stressStartBtn');
    if (!(startEl instanceof HTMLButtonElement)) {
      throw new Error('Element #stressStartBtn is not an HTMLButtonElement.');
    }
    this.startButton = startEl;
    const stopEl = this.requireElement('stressStopBtn');
    if (!(stopEl instanceof HTMLButtonElement)) {
      throw new Error('Element #stressStopBtn is not an HTMLButtonElement.');
    }
    this.stopButton = stopEl;
    this.elapsedLabel = this.requireElement('stressElapsed') as HTMLElement;
    this.workerCountLabel = this.requireElement('stressWorkerCount') as HTMLElement;
    this.backendLabel = this.requireElement('stressGpuBackend') as HTMLElement;
    this.renderRateLabel = this.requireElement('stressRenderRate') as HTMLElement;
    this.stallLabel = this.requireElement('stressCallbackStalls') as HTMLElement;
    this.renderRateHeading = this.requireElement('stressRenderRateLabel') as HTMLElement;
    this.candidateLabel = this.requireElement('stressCandidates') as HTMLElement;
    this.metricsPanel = this.requireElement('stressMetrics') as HTMLElement;
    this.metricCards = Array.from(this.metricsPanel.querySelectorAll<HTMLElement>('[data-stress-metric]'));
    const canvasEl = this.requireElement('stressCanvas');
    if (!(canvasEl instanceof HTMLCanvasElement)) {
      throw new Error('Element #stressCanvas is not an HTMLCanvasElement.');
    }
    this.canvas = canvasEl;
    this.metricCards.forEach((card) => {
      const metricId = card.dataset.stressMetric;
      if (metricId === 'elapsed' || metricId === 'workers' || metricId === 'gpu' || metricId === 'cadence' || metricId === 'stalls' || metricId === 'iterations') {
        this.metricCardById.set(metricId, card);
      }
    });
  }

  init() {
    this.root.dataset.stressReducedMotion = this.reducedMotion ? 'true' : 'false';
    this.modeButtons.forEach((button) => {
      this.listen(button, 'click', () => {
        if (this.state === 'running' || this.state === 'starting') {
          return;
        }
        const nextMode = button.dataset.stressModeOption;
        if (isStressMode(nextMode)) {
          this.setMode(nextMode);
        }
      });
    });
    this.listen(this.startButton, 'click', () => {
      this.start().catch((error) => this.handleStartFailure(error));
    });
    this.listen(this.stopButton, 'click', () => this.stop());
    this.listen(this.visualPanel, 'pointermove', (event) => {
      if (!(event instanceof PointerEvent) || !this.gpu) return;
      const rect = this.visualPanel.getBoundingClientRect();
      this.pointerX = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1));
      this.pointerY = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1));
      this.gpu.setPointer?.(this.pointerX, this.pointerY);
    });
    this.listen(this.root, 'utility-deactivate', () => this.stop());
    this.listen(window, 'hashchange', () => {
      if (window.location.hash !== '#stress-test') {
        this.stop();
      }
    });
    this.listen(window, 'resize', () => {
      this.queueControlPanelFitSync();
      this.queueCanvasResizeSync();
    });
    this.listen(window, 'pagehide', () => this.stop());
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.stop(); });
    this.listen(this.reducedMotionQuery, 'change', () => {
      this.reducedMotion = this.reducedMotionQuery.matches;
      this.root.dataset.stressReducedMotion = this.reducedMotion ? 'true' : 'false';
      this.gpu?.setReducedMotion?.(this.reducedMotion);
      if (this.reducedMotion && !this.gpu) {
        this.stopCpuVisuals();
      } else if (!this.gpu && this.state === 'running') {
        this.startCpuVisuals();
      }
    });
    this.listen(document, 'utility-activate', (event) => {
      const stage = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-utility-id]') : null;
      if (stage?.dataset.utilityId && stage.dataset.utilityId !== 'stress-test') {
        this.stop();
      }
    });

    this.setMode(DEFAULT_MODE);
    this.bindCanvasResizeObserver();
    this.setState('idle');
    this.syncMetrics(true);
    this.queueControlPanelFitSync();
    window.requestAnimationFrame(() => this.drawIdleCanvas());
  }

  dispose() {
    this.stop();
    this.stopCpuVisuals();
    this.stopMetricLoop();
    if (this.controlPanelFitFrameId) {
      window.cancelAnimationFrame(this.controlPanelFitFrameId);
      this.controlPanelFitFrameId = 0;
    }
    if (this.canvasResizeFrameId) {
      window.cancelAnimationFrame(this.canvasResizeFrameId);
      this.canvasResizeFrameId = 0;
    }
    this.canvasResizeObserver?.disconnect();
    this.canvasResizeObserver = null;
    while (this.cleanupCallbacks.length > 0) {
      this.cleanupCallbacks.pop()?.();
    }
  }

  public deactivate() {
    this.stop();
  }

  private listen(target: EventTarget, type: string, listener: EventListener) {
    target.addEventListener(type, listener);
    this.cleanupCallbacks.push(() => target.removeEventListener(type, listener));
  }

  private async start() {
    if (this.state === 'starting' || this.state === 'running') {
      return;
    }

    this.requestId += 1;
    const requestId = this.requestId;
    this.totalCandidates = 0;
    this.latestPrime = 0;
    this.primesFound = 0;
    this.candidatesPerSecond = 0;
    this.candidateRateSamples = [];
    this.frameCount = 0;
    this.callbackStalls = 0;
    this.lastRenderRate = 0;
    this.lastFrameAt = -1;
    this.lastMetricAt = 0;
    this.startedAt = readNow();
    this.gpuBackend = 'none';
    this.gpuWorkloadLevel = 0;
    this.lastError = '';
    this.gpuStartupError = '';
    this.gpuCanvasActive = false;
    this.clearCanvasSurface();
    this.canvas.dataset.stressIdle = 'false';
    this.setState(transitionStressState(this.state, 'start'));

    let cpuStartError = '';
    try {
      if (shouldStressCpu(this.mode)) {
        try {
          await this.startCpuStress(requestId);
        } catch (error) {
          this.stopCpuStress();
          cpuStartError = error instanceof Error ? error.message : 'CPU stress failed to start.';
          if (this.mode === 'cpu') {
            throw error;
          }
        }
        // Sizing the pool waits on one worker, so Stop can land inside that wait.
        // A superseded start installs nothing: stopCpuStress already ended the run.
        if (requestId !== this.requestId) {
          return;
        }
      }

      if (shouldStressGpu(this.mode)) {
        let gpu = await this.startGpuStress();
        if (requestId !== this.requestId) {
          gpu?.stop({ loseContext: true });
          return;
        }
        // Validate at the actual installation boundary, after both awaits.
        // A device-loss microtask can land after startGpuStress has returned.
        if (this.gpuStartupError) {
          gpu?.stop({ loseContext: true });
          gpu = null;
          this.gpuSurfaceClaim = 0;
          this.gpuCanvasActive = false;
        }
        this.gpu = gpu;
        this.gpuBackend = gpu?.backend ?? 'none';
        if (!gpu && this.gpuStartupError) {
          this.lastError = this.gpuStartupError;
        }
      }

      if (requestId !== this.requestId) {
        return;
      }

      // A GPU failure that landed before installation aborts startup: GPU-only
      // mode reports the honest error, combined mode keeps the documented CPU
      // fallback. Never install an already-failed handle.
      if (this.mode === 'gpu' && !this.gpu) {
        this.stopCpuStress();
        if (this.gpuStartupError) {
          this.setState('error');
        } else {
          this.setState('unsupported');
        }
        this.syncMetrics(true);
        return;
      }

      if (this.mode === 'both' && this.gpu && cpuStartError) {
        this.lastError = cpuStartError;
        this.setState(transitionStressState(this.state, 'running'));
      } else if (this.mode === 'both' && !this.gpu && !this.workers.length) {
        this.lastError = cpuStartError || this.lastError || 'No stress backend was available.';
        this.setState(transitionStressState(this.state, 'error'));
        this.syncMetrics(true);
        return;
      } else if (this.mode === 'both' && !this.gpu) {
        this.setState(transitionStressState(this.state, 'running'));
      } else {
        this.setState(transitionStressState(this.state, 'running'));
      }

      if (!this.gpu && this.workers.length > 0) {
        this.startCpuVisuals();
      }

      this.startMetricLoop();
    } catch (error) {
      this.stopCpuStress();
      this.stopGpuStress({ loseContext: true });
      this.gpuBackend = 'none';
      this.lastError = error instanceof Error ? error.message : 'Stress test failed to start.';
      this.setState('error');
      this.syncMetrics(true);
    }
  }

  private handleStartFailure(error: unknown) {
    this.stopCpuStress();
    this.stopGpuStress({ loseContext: true });
    this.stopMetricLoop();
    const message = error instanceof Error ? error.message : 'Stress test failed to start.';
    this.gpuBackend = 'none';
    this.lastError = message;
    this.setState('error');
    this.syncMetrics(true);
  }

  private stop() {
    if (this.state !== 'starting' && this.state !== 'running') {
      return;
    }

    this.requestId += 1;
    const stoppingState = transitionStressState(this.state, 'stop');
    this.setState(stoppingState);
    this.stopCpuStress();
    this.stopGpuStress();
    this.stopCpuVisuals();
    this.stopMetricLoop();
    this.candidatesPerSecond = 0;
    this.candidateRateSamples = [];
    this.frameCount = 0;
    this.callbackStalls = 0;
    this.lastRenderRate = 0;
    this.gpuBackend = 'none';
    this.gpuWorkloadLevel = 0;
    this.gpuCanvasActive = false;
    this.setState(transitionStressState(stoppingState, 'stopped'));
    this.syncMetrics(true);
    this.drawIdleCanvas();
  }

  /**
   * Creates the CPU workload: one exact pool of continuously computing workers.
   *
   * The sequence is: read the browser's logical-processor report, create ONE worker,
   * read the same report from inside it, size the pool, then create exactly that many
   * workers and never revisit the number for the rest of the run. Nothing here grows,
   * shrinks, or resizes in response to how much work the pool is doing — the only
   * input to the size is the count the browser itself states (see planCpuPool), and
   * the only thing that can change the live count is Stop or a bounded replacement of
   * a failed worker, which restores the requested size rather than exceeding it.
   *
   * The first worker is not a disposable probe: it is lane 0 of the pool it sized.
   */
  private async startCpuStress(requestId: number) {
    if (!supportsModuleWorkers()) {
      throw new Error('This browser does not support module workers required for CPU stress.');
    }

    const pageReport = sanitizeLogicalProcessorReport(navigator.hardwareConcurrency);
    const exactWorkers = readExactWorkersHook();
    this.poolLimitation = '';
    this.replacementsLeft = CPU_POOL_MAX_REPLACEMENTS;
    this.workerReport = 0;
    this.poolLanesFilled = 0;
    // The previous run's plan is not this run's request: until the new plan exists, a
    // failure has no requested count to restore, and must not borrow the old one.
    this.poolPlan = null;
    this.workerActivity.replaceChildren();

    // Created before the pool is sized so the count can be read in the scope the
    // workload runs in. A construction failure propagates: a run with no workers is
    // an error, not an idle page.
    const first = this.createWorkerRecord(requestId, 0);
    this.poolLanesFilled = 1;
    this.workers.push(first);
    let workerReport = 0;
    if (exactWorkers === 0) {
      // An exact diagnostic request already is the pool size, so it does not wait.
      workerReport = await this.readWorkerScopeReport(first, requestId);
      if (requestId !== this.requestId) return;
      // The first worker can fail while this is awaited; the failure path has already
      // removed it (and possibly ended the run), so do not plan a pool around a record
      // that is gone.
      if (first.stopped) return;
    }

    const plan = planCpuPool({ pageReport, workerReport, exactWorkers });
    this.poolPlan = plan;
    this.root.dataset.stressCpuAlgorithm = 'segmented-sieve';
    this.root.dataset.stressCpuReportPage = String(plan.pageReport);
    this.root.dataset.stressCpuReportWorker = String(plan.workerReport);
    this.root.dataset.stressCpuReport = String(plan.reported);
    this.root.dataset.stressCpuPoolSize = String(plan.workers);
    this.root.dataset.stressCpuPoolSource = plan.source;
    delete this.root.dataset.stressCpuPoolLimitation;

    this.startWorkerRecord(first, plan.workers, requestId);
    this.spawnPoolLanes(requestId, plan.workers - 1, plan.workers);
  }

  /**
   * Reads `navigator.hardwareConcurrency` from inside a dedicated worker, once, before
   * the pool is sized.
   *
   * Two workers are asked at the same time and the first answer wins: the pool's own
   * lane-0 worker, and a one-message probe built from an inline blob that does nothing
   * else. The probe exists because this measurement has to be fast as well as correct.
   * On the browser this sizing was written for, the workload worker took longer to load
   * its module graph than the bounded wait allows, so the page planned from the
   * window-scope number and built the reduced pool the user reported — while that same
   * worker's own report of the true count arrived a moment too late to be used. A probe
   * with no imports answers in milliseconds, and it is not part of the workload: it
   * computes nothing, it is terminated here, and it is never counted as a pool worker.
   */
  private async readWorkerScopeReport(record: StressWorkerRecord, requestId: number): Promise<number> {
    this.createReportProbe();
    try {
      return await this.readWorkerReport(record, requestId);
    } finally {
      this.disposeReportProbe();
    }
  }

  /**
   * The report probe: a dedicated module worker whose entire script posts the count its
   * own scope reports. Both scopes are `DedicatedWorkerGlobalScope`, which is the point
   * — it is the same API the workload worker reads, asked in the same kind of scope. A
   * browser that blocks blob workers leaves the probe silent, and the page then sizes
   * from the workload worker's answer or from the window scope, as it would anyway.
   */
  private createReportProbe() {
    let url = '';
    try {
      url = URL.createObjectURL(new Blob([
        'postMessage(typeof navigator !== "undefined"'
        + ' && typeof navigator.hardwareConcurrency === "number"'
        + ' ? navigator.hardwareConcurrency : null);'
      ], { type: 'text/javascript' }));
      const probe = new Worker(url, { type: 'module' });
      probe.addEventListener('message', (event: MessageEvent<number | null>) => {
        this.noteWorkerReport(event.data);
      });
      // A blocked or broken probe must not read as a workload failure: the wait simply
      // runs out and the window-scope report is used.
      probe.addEventListener('error', () => { this.noteWorkerReport(null); });
      this.reportProbe = probe;
      this.reportProbeUrl = url;
    } catch (_error) {
      if (url) URL.revokeObjectURL(url);
    }
  }

  private disposeReportProbe() {
    const probe = this.reportProbe;
    this.reportProbe = null;
    if (this.reportProbeUrl) {
      URL.revokeObjectURL(this.reportProbeUrl);
      this.reportProbeUrl = '';
    }
    probe?.terminate();
  }

  /**
   * Waits (bounded) for one worker to report its own scope's processor count. The
   * wait is on a worker that has nothing else to do yet, so it costs one message
   * round trip; if the worker never answers, the timeout hands back whatever report
   * arrived from another worker, and the planner uses the window-scope report if
   * there is none. Start cannot hang on it, and Stop cancels it outright.
   */
  private readWorkerReport(record: StressWorkerRecord, requestId: number): Promise<number> {
    return new Promise(resolve => {
      // The probe can be quicker than this call: a report already in hand is used at
      // once rather than waited out.
      if (this.workerReport > 0) {
        resolve(this.workerReport);
        return;
      }
      let settled = false;
      const finish = (value: number) => {
        if (settled) return;
        settled = true;
        if (this.reportWait?.record === record) this.reportWait = null;
        if (this.reportTimer !== 0) {
          window.clearTimeout(this.reportTimer);
          this.reportTimer = 0;
        }
        if (requestId === this.requestId || value === 0) resolve(value);
        else resolve(0);
      };
      this.reportWait = { record, finish };
      this.reportTimer = window.setTimeout(() => finish(this.workerReport), CPU_POOL_REPORT_TIMEOUT_MS);
    });
  }

  /** Records a worker-scope report. The largest one seen wins; the plan never revises. */
  private noteWorkerReport(report: number | null) {
    const count = sanitizeLogicalProcessorReport(report);
    if (count === 0) return;
    const running = this.state === 'running' || this.state === 'starting';
    if (count > this.workerReport) {
      this.workerReport = count;
      // Auditable even after the plan was made: an answer that arrived too late to be
      // used is exactly what a diagnosis needs, so it is still published.
      if (running) this.root.dataset.stressCpuReportWorker = String(count);
    }
    const waiting = this.reportWait;
    if (waiting) {
      this.reportWait = null;
      waiting.finish(count);
    }
  }

  /**
   * Creates the remaining lanes of the pool in short bursts. Constructing a worker is
   * main-thread work, and in combined mode one 32-worker burst would be a long task
   * that delays GPU submission and pointer input, so the pool is built a few workers
   * at a time. This only spaces creation out: the pool ends at exactly the requested
   * size, and each burst starts the workers it created immediately.
   */
  private spawnPoolLanes(requestId: number, remaining: number, poolSize: number) {
    if (remaining <= 0 || requestId !== this.requestId) return;
    const batch = Math.min(CPU_POOL_SPAWN_BATCH, remaining);
    try {
      for (let offset = 0; offset < batch; offset += 1) {
        const index = this.poolLanesFilled;
        const record = this.createWorkerRecord(requestId, index);
        this.poolLanesFilled += 1;
        this.workers.push(record);
        this.startWorkerRecord(record, poolSize, requestId);
      }
    } catch (error) {
      // Worker creation can genuinely fail (worker quota, memory pressure). The
      // workers that did get created keep computing, the remaining lanes are not
      // retried in a loop, and the shortfall is published: a pool smaller than the
      // one that was asked for is never presented as the full workload.
      this.poolLimitation = error instanceof Error ? error.message : 'A CPU worker failed to start.';
      console.error('[StressTest] CPU pool is smaller than requested after a worker failed to start', error);
      this.root.dataset.stressCpuPoolLimitation = this.poolLimitation;
      this.syncMetrics(true);
      return;
    }
    const left = remaining - batch;
    if (left > 0) {
      this.poolSpawnTimer = window.setTimeout(() => {
        this.poolSpawnTimer = 0;
        this.spawnPoolLanes(requestId, left, poolSize);
      }, 0);
      return;
    }
    if (this.poolLimitation) {
      this.root.dataset.stressCpuPoolLimitation = this.poolLimitation;
    }
  }

  /**
   * One worker plus the activity bar that represents it, in that order, so a
   * constructor failure cannot leave a bar without a worker behind it. Nothing is
   * started here: a worker only computes once it has been told the final pool size.
   */
  private createWorkerRecord(requestId: number, index: number): StressWorkerRecord {
    const worker = new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' });
    const bar = document.createElement('span');
    bar.setAttribute('aria-label', `Worker ${index + 1}: starting`);
    bar.dataset.rangeLow = String(workerStartLow(index));
    this.workerActivity.append(bar);
    this.workerActivity.style.setProperty('--stress-workers', String(this.workerActivity.children.length));
    const messageListener = (event: MessageEvent<StressTestWorkerResponse>) => {
      this.handleWorkerMessage(record, event.data);
    };
    const errorListener = (event: ErrorEvent) => {
      if (requestId !== this.requestId || record.stopped) return;
      console.error('[StressTest] CPU worker error', event.message, event.filename, event.lineno);
      const details = [event.message, event.filename, event.lineno ? `line ${event.lineno}` : ''].filter(Boolean).join(' ');
      window.dispatchEvent(new Event('utility-load-error'));
      this.handleWorkerFailure(record, details ? `CPU stress worker failed: ${details}` : 'A CPU stress worker failed.');
    };
    const record: StressWorkerRecord = {
      worker,
      stopped: false,
      index,
      poolSize: 0,
      candidates: 0,
      primesFound: 0,
      activity: 0,
      rangeLow: workerStartLow(index),
      blocksTaken: 0,
      activityElement: bar,
      messageListener,
      errorListener
    };
    worker.addEventListener('message', messageListener);
    worker.addEventListener('error', errorListener);
    return record;
  }

  /** The whole work assignment: which lane this worker sieves, and how wide the lane grid is. */
  private startWorkerRecord(record: StressWorkerRecord, poolSize: number, requestId: number) {
    const request: StressTestWorkerRequest = {
      type: 'start-cpu-stress',
      requestId,
      workerIndex: record.index,
      poolSize
    };
    record.poolSize = poolSize;
    record.worker.postMessage(request);
  }

  private removeWorkerRecord(record: StressWorkerRecord) {
    record.worker.removeEventListener('message', record.messageListener);
    record.worker.removeEventListener('error', record.errorListener);
    record.worker.terminate();
    record.stopped = true;
    record.activityElement.remove();
    const position = this.workers.indexOf(record);
    if (position >= 0) this.workers.splice(position, 1);
    this.workerActivity.style.setProperty('--stress-workers', String(this.workerActivity.children.length));
  }

  private stopCpuStress() {
    this.poolPlan = null;
    this.poolLimitation = '';
    this.replacementsLeft = 0;
    this.poolLanesFilled = 0;
    this.workerReport = 0;
    // Startup work is cancelled, not left to land later: a pending report wait would
    // otherwise resolve into a run that has already been replaced or ended.
    this.disposeReportProbe();
    if (this.reportWait) {
      const waiting = this.reportWait;
      this.reportWait = null;
      waiting.finish(0);
    }
    if (this.reportTimer !== 0) {
      window.clearTimeout(this.reportTimer);
      this.reportTimer = 0;
    }
    if (this.poolSpawnTimer !== 0) {
      window.clearTimeout(this.poolSpawnTimer);
      this.poolSpawnTimer = 0;
    }
    delete this.root.dataset.stressCpuReportPage;
    delete this.root.dataset.stressCpuReportWorker;
    delete this.root.dataset.stressCpuReport;
    delete this.root.dataset.stressCpuPoolSize;
    delete this.root.dataset.stressCpuPoolSource;
    delete this.root.dataset.stressCpuPoolLimitation;
    delete this.root.dataset.stressCpuBlocks;
    // Termination is the stop signal. A busy worker never has to acknowledge a
    // stop message before it can be torn down — it is in a compute loop and reads
    // nothing — which is what makes Stop work while every worker is mid-sieve.
    for (const record of [...this.workers]) this.removeWorkerRecord(record);
    this.workers = [];
    this.workerActivity.replaceChildren();
  }

  private handleWorkerMessage(record: StressWorkerRecord, message: StressTestWorkerResponse) {
    if (record.stopped) return;

    // Posted by the worker script as it loads, before this worker has a run or a lane
    // to match against — the one message without a request id.
    if (message.type === 'cpu-stress-ready') {
      this.noteWorkerReport(message.hardwareConcurrency);
      return;
    }

    // A message from an earlier run can never touch this one: the request id is
    // bumped on every Start and Stop, and the record itself is torn down.
    if (message.requestId !== this.requestId || message.workerIndex !== record.index) return;

    if (message.type === 'cpu-stress-progress') {
      const previousCandidates = record.candidates;
      record.candidates = Math.max(record.candidates, message.candidates);
      record.activity = Math.max(0, record.candidates - previousCandidates);
      const primeDelta = Math.max(0, message.primesFound - record.primesFound);
      record.primesFound = Math.max(record.primesFound, message.primesFound);
      record.blocksTaken = Math.max(record.blocksTaken, message.blocks);
      if (message.rangeLow > 0) record.rangeLow = message.rangeLow;
      this.totalCandidates += record.activity;
      // Lanes are disjoint by construction, so every prime counted here was found
      // once, and the displayed maximum is a prime some worker actually produced.
      this.latestPrime = Math.max(this.latestPrime, message.latestPrime);
      this.primesFound += primeDelta;
      this.root.dataset.stressLastChecksum = String(message.checksum);
      return;
    }

    if (message.type === 'cpu-stress-error' && message.message) {
      this.handleWorkerFailure(record, message.message);
      return;
    }

    console.warn(`[StressTest] Ignoring unexpected CPU worker message type: ${message.type}`);
  }

  /**
   * A worker that stopped computing. Its lane is worth keeping, so it is replaced by
   * one worker with the same lane index and the same pool size: the live pool returns
   * to the size it was asked for and never goes past it. Replacement is bounded, so a
   * worker script that fails the moment it loads cannot spin creating replacements
   * forever. A pool that ends up below the requested size says so — a smaller pool is
   * never presented as the workload that was asked for — and a pool with nothing left
   * has no workload, which is an error rather than a quiet idle page.
   */
  private handleWorkerFailure(record: StressWorkerRecord, message: string) {
    if (record.stopped) return;
    const requested = this.poolPlan?.workers ?? this.workers.length;
    this.removeWorkerRecord(record);
    if (this.state !== 'running' && this.state !== 'starting') return;

    let detail = message;
    if (this.workers.length < requested) {
      if (this.replacementsLeft > 0) {
        this.replacementsLeft -= 1;
        try {
          const replacement = this.createWorkerRecord(this.requestId, record.index);
          this.workers.push(replacement);
          this.startWorkerRecord(replacement, requested, this.requestId);
          detail = `${message}; lane ${record.index} restarted`;
        } catch (error) {
          detail = `${message}; the lane could not be restarted: ${error instanceof Error ? error.message : 'unknown error'}`;
        }
      } else {
        detail = `${message}; the replacement budget for this run is exhausted`;
      }
    }

    if (this.workers.length === 0) {
      this.handleCpuStressFailure(`CPU pool stopped with no workers left — ${detail}`);
      return;
    }
    if (this.workers.length < requested) {
      this.poolLimitation = `CPU pool is running ${this.workers.length} of ${requested} workers — ${detail}`;
      this.root.dataset.stressCpuPoolLimitation = this.poolLimitation;
    } else {
      this.poolLimitation = '';
      delete this.root.dataset.stressCpuPoolLimitation;
    }
    console.error('[StressTest] CPU worker faulted:', detail);
    this.syncMetrics(true);
  }

  private handleCpuStressFailure(message: string) {
    this.stopCpuStress();
    this.stopCpuVisuals();
    this.lastError = message;
    // `stopCpuStress` cleared the pool's diagnostics because there is no pool; say
    // why, so an ended CPU workload never reads back as a page that was never asked
    // to compute. Combined mode keeps the GPU running and still reports this.
    this.root.dataset.stressCpuPoolLimitation = message;

    if (this.mode === 'both' && this.gpu) {
      this.setState(transitionStressState(this.state, 'running'));
      this.syncMetrics(true);
      return;
    }

    // Cancel a GPU initialization that may still be awaiting an adapter/device.
    this.requestId += 1;
    this.stopGpuStress({ loseContext: true });
    this.stopMetricLoop();
    this.setState(transitionStressState(this.state, 'error'));
    this.syncMetrics(true);
  }

  private async startGpuStress() {
    const requestId = this.requestId;
    this.resetRenderCadence();
    this.prepareGpuCanvas();
    this.gpuSurfaceClaim = requestId;
    this.gpuAbort = new AbortController();
    const gpu = await startAdaptiveGpuStress(this.canvas, {
      onFrame: () => {
        if (requestId !== this.requestId) return;
        this.recordRenderFrame();
      },
      onWorkloadLevel: (level) => {
        if (requestId !== this.requestId) return;
        this.gpuWorkloadLevel = Math.max(0, Math.floor(level));
      },
      onCanvasActive: (active) => {
        if (requestId !== this.requestId) return;
        this.gpuCanvasActive = active;
      },
      onAsyncError: (message) => {
        if (requestId !== this.requestId) return;
        if (this.gpu) {
          this.handleGpuStressFailure(message);
          return;
        }
        // Device loss or an async failure can resolve before the factory hands
        // back its handle. Remember it and abort the pending startup so the
        // failed handle is never installed or reported as running.
        this.gpuStartupError = message;
        this.gpuAbort?.abort();
      },
      onCanvasReplace: (canvas) => {
        if (requestId !== this.requestId) return;
        this.canvas = canvas;
        this.bindCanvasResizeObserver();
      }
    }, { reducedMotion: this.reducedMotion, signal: this.gpuAbort.signal });

    if (!gpu && requestId === this.requestId) {
      this.gpuSurfaceClaim = 0;
    }
    return gpu;
  }

  private handleGpuStressFailure(message: string) {
    if (!this.gpu) {
      return;
    }

    this.stopGpuStress({ loseContext: true });
    this.gpuBackend = 'none';
    this.gpuWorkloadLevel = 0;
    this.gpuCanvasActive = false;
    this.lastError = message;

    if (this.mode === 'both' && this.workers.length > 0) {
      this.setState(transitionStressState(this.state, 'running'));
      this.startCpuVisuals();
    } else {
      this.stopCpuStress();
      this.stopMetricLoop();
      this.stopCpuVisuals();
      this.resetRenderCadence();
      this.setState('error');
    }
    this.syncMetrics(true);
  }

  private stopGpuStress({ loseContext = true }: { loseContext?: boolean } = {}) {
    this.gpu?.stop({ loseContext });
    this.gpu = null;
    this.gpuAbort?.abort();
    this.gpuAbort = null;
    this.gpuSurfaceClaim = 0;
  }

  private startCpuVisuals() {
    if (this.cpuVisualFrameId) return;
    this.resetRenderCadence();
    if (this.reducedMotion) return;

    let ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      this.replaceCanvasElement();
      ctx = this.canvas.getContext('2d', { alpha: true });
    }
    if (!ctx) return;

    this.syncCanvasSize();
    this.canvas2dCtx = ctx;
    const frame = (time: number) => {
      if (!this.cpuVisualFrameId) return;
      this.renderCpuVisualsFrame(time);
      this.recordRenderFrame();
      this.cpuVisualFrameId = window.requestAnimationFrame(frame);
    };
    this.cpuVisualFrameId = window.requestAnimationFrame(frame);
  }

  private stopCpuVisuals() {
    if (this.cpuVisualFrameId) {
      window.cancelAnimationFrame(this.cpuVisualFrameId);
      this.cpuVisualFrameId = 0;
    }
    this.clearCanvasSurface();
    this.canvas2dCtx = null;
  }

  private renderCpuVisualsFrame(_time: number) {
    const ctx = this.canvas2dCtx;
    if (!ctx) return;
    const { width: w, height: h } = this.canvas;
    ctx.clearRect(0, 0, w, h);
    // Each lane represents a real worker; incoming candidate counts drive its brightness.
    const lanes = Math.max(1, this.workers.length);
    const spacing = w / lanes;
    for (let i = 0; i < lanes; i++) {
      const activity = this.workers[i]?.activity ?? 0;
      const brightness = Math.min(1, Math.log10(activity + 1) / 5);
      const x = (i + .5) * spacing;
      ctx.fillStyle = `rgba(112, 80, 192, ${.025 + brightness * .05})`;
      ctx.fillRect(x, h * (1 - brightness), 1, h * brightness);
    }
  }

  private resetRenderCadence() {
    this.cadenceStartedAt = readNow();
    this.cadenceStartFrameCount = this.frameCount;
    this.lastFrameAt = -1;
    this.callbackStalls = 0;
    this.lastRenderRate = 0;
  }

  private recordRenderFrame() {
    const now = readNow();
    if (this.lastFrameAt >= 0 && now - this.lastFrameAt > RENDER_STALL_GAP_MS) {
      // One qualified stall per oversized gap between render callbacks; not a
      // count of dropped display presentations.
      this.callbackStalls += 1;
    }
    this.lastFrameAt = now;
    this.frameCount += 1;
  }

  private startMetricLoop() {
    this.stopMetricLoop();
    const tick = () => {
      this.syncMetrics();
      if (this.state === 'running' || this.state === 'starting') {
        this.metricFrameId = window.requestAnimationFrame(tick);
      }
    };
    this.metricFrameId = window.requestAnimationFrame(tick);
  }

  private stopMetricLoop() {
    if (this.metricFrameId) {
      window.cancelAnimationFrame(this.metricFrameId);
      this.metricFrameId = 0;
    }
  }

  // The moving average is a benchmark-grade reading, so it must not inherit the
  // timing noise of heartbeat delivery. Each metric tick records the actual
  // cumulative candidate count with its actual timestamp; the rate is the count
  // difference across the trailing window divided by the window. The window
  // edge is interpolated between the two bracketing real samples, which keeps
  // the window length constant and lets a stalled CPU decay out of the average
  // smoothly instead of freezing until a stale boundary is replaced.
  private recordCandidateRate(now: number) {
    const samples = this.candidateRateSamples;
    if (this.workers.length === 0) {
      samples.length = 0;
      return 0;
    }

    const last = samples[samples.length - 1];
    // Metric ticks are already throttled; this only rejects a forced sync that
    // would add a near-duplicate sample and could grow the ring unboundedly.
    if (!last || now - last.at >= METRIC_INTERVAL_MS) {
      samples.push({ at: now, candidates: this.totalCandidates });
      // Keep the newest sample older than the window as the interpolation
      // anchor; everything strictly inside the window is needed for the edge.
      while (samples.length > 2 && samples[1].at < now - CANDIDATE_RATE_WINDOW_MS) {
        samples.shift();
      }
    }

    const latest = samples[samples.length - 1];
    const windowStart = Math.max(samples[0].at, latest.at - CANDIDATE_RATE_WINDOW_MS);
    const spanMs = latest.at - windowStart;
    if (spanMs < CANDIDATE_RATE_MIN_SPAN_MS) {
      return 0;
    }
    return Math.max(0, (latest.candidates - this.candidatesTestedAt(samples, windowStart)) * 1000 / spanMs);
  }

  /**
   * The CPU summary line: how many workers are computing. When that is fewer than
   * the pool the run asked for, the same line says so — a reduced pool must never
   * read back as the full workload the page requested.
   */
  private workerPoolSummary() {
    const workers = this.workers.length;
    if (!workers) return 'CPU ready';
    const requested = this.poolPlan?.workers ?? workers;
    return `CPU · ${workers} workers${workers < requested ? ` (${workers} of ${requested} requested)` : ''}`;
  }

  /**
   * Closes nothing and decides nothing: the pool has no measurement window because it
   * has nothing to decide after it is built. What the metric loop publishes is what
   * the workers reported — how far each lane has advanced, which is how a stalled
   * worker is told apart from a worker that is merely slow.
   */
  private poolBlocksTaken() {
    let blocks = 0;
    for (const record of this.workers) blocks += record.blocksTaken;
    return blocks;
  }

  // Linear estimate of the actual cumulative count at a window edge, taken
  // between the two samples that bracket it. Before the first sample the
  // observed count was already its recorded value, so no extrapolation occurs.
  private candidatesTestedAt(samples: Array<{ at: number; candidates: number }>, at: number) {
    const first = samples[0];
    if (at <= first.at) {
      return first.candidates;
    }
    const last = samples[samples.length - 1];
    if (at >= last.at) {
      return last.candidates;
    }
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].at >= at) {
        const previous = samples[index - 1];
        const gapMs = samples[index].at - previous.at;
        return gapMs > 0
          ? previous.candidates + (samples[index].candidates - previous.candidates) * (at - previous.at) / gapMs
          : samples[index].candidates;
      }
    }
    return last.candidates;
  }

  private syncMetrics(force = false) {
    const now = readNow();
    if (!force && now - this.lastMetricAt < METRIC_INTERVAL_MS) {
      return;
    }

    const elapsed = this.startedAt > 0 && (this.state === 'running' || this.state === 'starting' || this.state === 'stopping')
      ? now - this.startedAt
      : 0;
    if (elapsed > 0) {
      this.lastRenderRate = (this.frameCount - this.cadenceStartFrameCount)
        / Math.max(1, (now - this.cadenceStartedAt) / 1000);
    }

    this.candidatesPerSecond = this.recordCandidateRate(now);
    this.primeLabel.textContent = this.latestPrime > 0 ? this.latestPrime.toLocaleString('en-US') : '1';
    this.primeLabel.style.setProperty('--prime-digits', String(this.primeLabel.textContent.length));
    this.primeCaption.textContent = this.latestPrime > 0 ? 'Largest prime' : this.workers.length ? 'Searching from 1' : 'Search from 1';
    this.primeSummary.textContent = this.latestPrime > 0
      ? `${this.primesFound.toLocaleString()} primes found · ${Math.round(this.candidatesPerSecond).toLocaleString()} candidates/s`
      : '0 primes found';
    this.workerSummary.textContent = this.workerPoolSummary();
    const maxActivity = Math.max(1, ...this.workers.map((record) => record.activity));
    Array.from(this.workerActivity.children).forEach((element, index) => {
      const record = this.workers[index];
      if (!(element instanceof HTMLElement) || !record) return;
      element.dataset.candidates = String(record.candidates);
      element.dataset.primesFound = String(record.primesFound);
      element.dataset.rangeLow = String(record.rangeLow);
      element.dataset.blocks = String(record.blocksTaken);
      element.style.transform = `scaleY(${.1 + .9 * record.activity / maxActivity})`;
      element.setAttribute('aria-label', `Worker ${index + 1}: ${record.candidates.toLocaleString()} candidates, ${record.primesFound.toLocaleString()} primes`);
    });
    const diagnostic = this.gpu?.getDiagnostics?.();
    this.gpuDetail.textContent = diagnostic ? `${diagnostic.adapter} · ${diagnostic.detail}` : 'GPU ready';
    this.root.dataset.stressLatestPrime = String(this.latestPrime);
    this.root.dataset.stressPrimesFound = String(this.primesFound);
    this.elapsedLabel.textContent = formatStressElapsed(elapsed);
    this.workerCountLabel.textContent = String(this.workers.length);
    this.backendLabel.textContent = this.gpuBackend;
    const renderRateActive = Boolean(this.gpu) || this.cpuVisualFrameId > 0;
    const renderRate = renderRateActive ? this.lastRenderRate.toFixed(1) : '0.0';
    this.renderRateHeading.textContent = this.gpu ? 'GPU batches/s' : 'Visual callbacks/s';
    this.renderRateLabel.textContent = renderRate;
    this.stallLabel.textContent = String(this.callbackStalls);
    this.candidateLabel.textContent = this.totalCandidates > 0 ? this.totalCandidates.toLocaleString() : '0';
    this.candidateLabel.style.setProperty('--readout-chars', String(this.candidateLabel.textContent.length));
    this.root.dataset.stressWorkerCount = String(this.workers.length);
    this.root.dataset.stressGpuBackend = this.gpuBackend;
    this.root.dataset.stressTotalRenderedFrames = String(this.frameCount);
    this.root.dataset.stressGpuWorkloadLevel = String(this.gpuWorkloadLevel);
    this.root.dataset.stressGpuCanvasActive = this.gpuCanvasActive ? 'true' : 'false';
    this.root.dataset.stressCanvasActive = (this.gpuCanvasActive || this.cpuVisualFrameId > 0) ? 'true' : 'false';
    this.root.dataset.stressGpuLastError = this.lastError;
    this.root.dataset.stressCandidates = String(this.totalCandidates);
    this.root.dataset.stressCandidatesPerSecond = String(Math.round(this.candidatesPerSecond));
    this.root.dataset.stressCpuBlocks = String(this.poolBlocksTaken());
    this.root.dataset.stressCallbackStalls = String(this.callbackStalls);
    this.root.dataset.stressRenderRate = renderRate;
    this.lastMetricAt = now;
    this.queueControlPanelFitSync();
  }

  private setMode(mode: StressMode) {
    this.mode = mode;
    (this.requireElement('stressSceneTitle') as HTMLElement).textContent = mode === 'cpu' ? 'CPU' : mode === 'gpu' ? 'GPU' : 'CPU + GPU';
    this.root.dataset.stressMode = mode;
    this.modeButtons.forEach((button) => {
      const isActive = button.dataset.stressModeOption === mode;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-pressed', String(isActive));
    });
    this.queueControlPanelFitSync();
  }

  private setState(state: StressState) {
    this.state = state;
    (this.requireElement('stressSceneState') as HTMLElement).textContent = state === 'starting' ? 'WARMING UP' : state === 'error' || state === 'unsupported' ? 'UNAVAILABLE' : '';
    this.root.dataset.stressState = state;
    const active = state === 'running' || state === 'starting';
    this.startButton.disabled = active;
    this.stopButton.disabled = !active;
    this.modeButtons.forEach((button) => {
      button.disabled = active;
    });
    this.queueControlPanelFitSync();
  }


  private queueControlPanelFitSync() {
    if (this.controlPanelFitFrameId) {
      return;
    }
    this.controlPanelFitFrameId = window.requestAnimationFrame(() => {
      this.controlPanelFitFrameId = 0;
      this.syncControlPanelFit();
    });
  }

  private syncControlPanelFit() {
    const controlPanel = this.metricsPanel.closest<HTMLElement>('.stress-control-panel');
    if (!controlPanel) {
      return;
    }

    for (const card of this.metricCards) {
      card.hidden = false;
    }
    this.root.dataset.stressMetricsHidden = 'false';
    this.root.dataset.stressMetricsHiddenCount = '0';

    let hiddenCount = 0;
    let remainingOverflow = controlPanel.scrollHeight - controlPanel.clientHeight;
    if (remainingOverflow > 1) {
      const gapValue = window.getComputedStyle(this.metricsPanel).gap || window.getComputedStyle(this.metricsPanel).rowGap;
      const rowGap = Number.parseFloat(gapValue || '0') || 0;
      const cardsToHide: HTMLElement[] = [];

      for (const metricId of STRESS_METRIC_HIDE_ORDER[this.mode]) {
        if (remainingOverflow <= 1) {
          break;
        }
        const card = this.metricCardById.get(metricId);
        if (!card) {
          continue;
        }
        cardsToHide.push(card);
        remainingOverflow -= card.getBoundingClientRect().height + rowGap;
      }

      for (const card of cardsToHide) {
        card.hidden = true;
      }
      hiddenCount = cardsToHide.length;
    }

    this.root.dataset.stressMetricsHidden = hiddenCount > 0 ? 'true' : 'false';
    this.root.dataset.stressMetricsHiddenCount = String(hiddenCount);
  }

  private bindCanvasResizeObserver() {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    this.canvasResizeObserver?.disconnect();
    this.canvasResizeObserver = new ResizeObserver(() => {
      this.queueCanvasResizeSync();
    });
    this.canvasResizeObserver.observe(this.canvas);
  }

  private queueCanvasResizeSync() {
    if (this.canvasResizeFrameId) {
      return;
    }

    this.canvasResizeFrameId = window.requestAnimationFrame(() => {
      this.canvasResizeFrameId = 0;
      this.syncCanvasSize();
    });
  }

  private syncCanvasSize() {
    // While a GPU backend is starting or rendering it owns the canvas backing
    // store: it compares CSS size against its own limits and only resizes after
    // in-flight batches complete. A controller-side observer or resize write
    // would swap the drawing buffer under queued work, so observation stops here.
    // Generation ids start at 1 (requestId increments before any start), so a
    // zero claim always means "unowned".
    if (this.gpu || (this.gpuSurfaceClaim !== 0 && this.gpuSurfaceClaim === this.requestId)) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.max(1, Math.floor(rect.width * scale));
    const height = Math.max(1, Math.floor(rect.height * scale));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  private replaceCanvasElement() {
    const parent = this.canvas.parentElement;
    if (!parent) {
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    const nextCanvas = document.createElement('canvas');
    nextCanvas.id = this.canvas.id;
    nextCanvas.setAttribute('aria-label', this.canvas.getAttribute('aria-label') ?? 'Stress test output');
    nextCanvas.dataset.stressIdle = this.canvas.dataset.stressIdle ?? 'true';
    nextCanvas.style.cssText = this.canvas.style.cssText;
    parent.replaceChild(nextCanvas, this.canvas);
    this.canvas = nextCanvas;
    this.bindCanvasResizeObserver();
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    this.canvas.width = Math.max(1, Math.floor(rect.width * scale));
    this.canvas.height = Math.max(1, Math.floor(rect.height * scale));
  }

  private prepareGpuCanvas() {
    this.canvas2dCtx = null;
    this.replaceCanvasElement();
    this.syncCanvasSize();
    this.canvas.dataset.stressIdle = 'false';
  }

  private clearCanvasSurface() {
    let ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      this.replaceCanvasElement();
      ctx = this.canvas.getContext('2d', { alpha: true });
    }
    if (!ctx) {
      return;
    }
    this.syncCanvasSize();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawIdleCanvas() {
    this.syncCanvasSize();
    this.clearCanvasSurface();
    this.canvas.dataset.stressIdle = 'true';
  }

  private requireElement(id: string): Element {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing required element: #${id}`);
    }
    return element;
  }
}
