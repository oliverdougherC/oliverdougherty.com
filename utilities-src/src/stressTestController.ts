import {
  CpuPoolGrowth,
  CPU_POOL_GROWTH_WINDOW_MS,
  formatStressElapsed,
  isStressMode,
  nextCpuWorkerCount,
  planCpuPool,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState,
  type CpuPoolGrowthAction,
  type CpuPoolSignal,
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
  /** Cumulative odd candidates this worker has sieved. */
  candidates: number;
  primesFound: number;
  activity: number;
  index: number;
  /** Prefetch sequence guard for this worker's next-band requests. */
  supplyId: number;
  /** Worker's own search cursor, for activity diagnostics. */
  rangeLow: number;
  busyMs: number;
  idleMs: number;
  bandWaitMs: number;
  slices: number;
  slowSlices: number;
  activityElement: HTMLElement;
  messageListener: (event: MessageEvent<StressTestWorkerResponse>) => void;
  errorListener: (event: ErrorEvent) => void;
}

type StressMetricId = 'elapsed' | 'workers' | 'gpu' | 'cadence' | 'stalls' | 'iterations';

/**
 * Pool verdict published as `data-stress-cpu-pool`. `growing` means the pool is
 * still gaining workers, `settled` that measured work-rate stopped improving,
 * `capped` that the runaway guard bound it, and `pinned` that a diagnostic
 * request fixed the size. None of these claims a thread count.
 */
type StressPoolVerdict = 'growing' | 'settled' | 'capped' | 'pinned';

const DEFAULT_MODE: StressMode = 'both';
const METRIC_INTERVAL_MS = 120;
// Workers are spawned in small bursts. A 32-worker burst is one long task, and
// in combined mode that task would delay GPU submission and pointer input; a
// short burst keeps the control panel responsive while the pool grows.
const CPU_POOL_SPAWN_BATCH = 8;
// CPU candidate throughput is compared across machines, so the reported rate is
// a true moving average over this fixed window instead of a single-tick delta.
const CANDIDATE_RATE_WINDOW_MS = 5000;
// Until the ring spans this much actual time, the average would be dominated by
// worker startup and the first heartbeat, so no throughput is claimed.
const CANDIDATE_RATE_MIN_SPAN_MS = 1000;
// Count gaps over an explicit duration, independent of display refresh rate.
// GPU callbacks report batch completions; CPU visuals report animation callbacks.
const RENDER_STALL_GAP_MS = 34;
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
 * Diagnostic hooks. Neither is part of the public UI contract, and the normal
 * user path never sets either one.
 *
 * `__OD_STRESS_TEST_WORKERS__` requests an exact pool size — including a size
 * ABOVE the browser's report — and pins it, which is how the browser checks and
 * the load harness get a known pool. `__OD_STRESS_TEST_MAX_WORKERS__` is a
 * ceiling on the automatic pool, not a request: it bounds growth but never asks
 * for workers. Both exist so a wrong `hardwareConcurrency` can be diagnosed
 * without touching the automatic policy that real users get.
 */
function readWorkerHook(name: '__OD_STRESS_TEST_WORKERS__' | '__OD_STRESS_TEST_MAX_WORKERS__') {
  const globalValue = (window as Window & Partial<Record<typeof name, number>>)[name];
  return Number.isFinite(globalValue) ? Number(globalValue) : null;
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
  // Serial of the next prime band to hand out. Bands tile the number line, so a
  // monotonically increasing serial is the whole allocation scheme.
  private primeBandSerial = 0;
  private poolPlan: CpuPoolPlan | null = null;
  private poolGrowth: CpuPoolGrowth | null = null;
  private poolGrowthTimer = 0;
  private poolSpawnTimer = 0;
  // Honest record of anything that stopped the pool reaching its target size.
  private poolLimitation = '';
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
  // Rolling window over the pool's own scheduling counters — sieving time,
  // waiting-to-run time, waiting-for-a-band time, and slice overruns. This is the
  // reading the growth rule decides on, and it is measured whether or not the pool
  // is still growing: a pinned diagnostic pool publishes it too, so the thresholds
  // can be checked against a real machine instead of asserted.
  private signalWindowAt = 0;
  private signalWindowBusy = 0;
  private signalWindowIdle = 0;
  private signalWindowBand = 0;
  private signalWindowSlices = 0;
  private signalWindowSlow = 0;
  private poolSignal: CpuPoolSignal = { duty: 0, slowShare: 0, slices: 0 };
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
    this.resetPoolSignalWindow();
    this.poolSignal = { duty: 0, slowShare: 0, slices: 0 };
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
          this.startCpuStress(requestId);
        } catch (error) {
          this.stopCpuStress();
          cpuStartError = error instanceof Error ? error.message : 'CPU stress failed to start.';
          if (this.mode === 'cpu') {
            throw error;
          }
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
    this.resetPoolSignalWindow();
    this.poolSignal = { duty: 0, slowShare: 0, slices: 0 };
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
   * Puts the whole CPU workload on workers, then lets the pool grow.
   *
   * `hardwareConcurrency` is a logical-processor hint that browsers round down,
   * cap, or leave stale, so the pool starts at the WHOLE hint — nothing is
   * halved and no core is reserved, the main thread stays light instead — and
   * CpuPoolGrowth then adds workers while the pool's own measured work-rate
   * keeps improving. Nothing here measures CPU utilisation (a browser cannot) or
   * reconstructs processor topology; the only question the policy answers is
   * "did more workers produce more work?", and the pool never shrinks.
   */
  private startCpuStress(requestId: number) {
    if (!supportsModuleWorkers()) {
      throw new Error('This browser does not support module workers required for CPU stress.');
    }

    const plan = planCpuPool({
      hardwareConcurrency: navigator.hardwareConcurrency,
      exactWorkers: readWorkerHook('__OD_STRESS_TEST_WORKERS__'),
      maxWorkers: readWorkerHook('__OD_STRESS_TEST_MAX_WORKERS__')
    });
    this.poolPlan = plan;
    this.primeBandSerial = 0;
    this.poolLimitation = '';
    this.root.dataset.stressCpuAlgorithm = 'segmented-sieve';
    this.root.dataset.stressCpuReported = String(plan.reported);
    delete this.root.dataset.stressCpuPoolLimitation;
    this.root.dataset.stressCpuPoolWindows = '[]';
    this.resetPoolSignalWindow();
    this.poolSignal = { duty: 0, slowShare: 0, slices: 0 };
    this.workerActivity.replaceChildren();
    this.spawnWorkerWave(requestId, plan.initial, 0);

    if (plan.pinned) {
      // An exact diagnostic request is what it says: this many workers, no
      // growth, so a test can measure a known pool on any machine.
      this.poolGrowth = null;
      this.root.dataset.stressCpuPool = 'pinned';
      return;
    }
    if (nextCpuWorkerCount(plan.initial, plan.ceiling) <= plan.initial) {
      this.finishPoolGrowth('capped');
      return;
    }
    // The report is the floor the duty-cycle reading is only trusted at: below it
    // the pool grows on the browser's own claim rather than stopping on a signal it
    // cannot attribute, which is what keeps an under-reporting browser growing.
    this.poolGrowth = new CpuPoolGrowth(plan.ceiling, plan.reported);
    this.root.dataset.stressCpuPool = 'growing';
    this.schedulePoolGrowthTick(requestId);
  }

  private schedulePoolGrowthTick(requestId: number) {
    this.poolGrowthTimer = window.setTimeout(() => {
      this.poolGrowthTimer = 0;
      this.poolGrowthTick(requestId);
    }, CPU_POOL_GROWTH_WINDOW_MS);
  }

  /**
   * One growth window. The signal is production work the pool already did, so
   * unlike a benchmark phase this never interrupts load; the timer only decides
   * whether to add workers, it never paces the compute.
   */
  private poolGrowthTick(requestId: number) {
    const growth = this.poolGrowth;
    if (!growth || requestId !== this.requestId) return;
    if (this.state !== 'running' && this.state !== 'starting') return;
    const action = growth.observe(readNow(), this.totalCandidates, this.workers.length, this.poolSignal);
    // Publish the windows the decision was made from. A worker count on its own
    // cannot be audited — this is the only way to tell a measured plateau from a
    // measurement that never saw the work the pool was doing.
    this.root.dataset.stressCpuPoolWindows = JSON.stringify(growth.windows);
    if (action === 'grow') {
      const ceiling = this.poolPlan?.ceiling ?? this.workers.length;
      this.spawnGrowthWave(requestId, nextCpuWorkerCount(this.workers.length, ceiling) - this.workers.length);
      this.schedulePoolGrowthTick(requestId);
      return;
    }
    if (action === 'settled' || action === 'capped') {
      this.finishPoolGrowth(action);
      return;
    }
    this.schedulePoolGrowthTick(requestId);
  }

  /**
   * Adds one growth step in short spawn bursts. Constructing a worker is a main
   * thread task, and in combined mode one 24-worker burst would be a long task
   * that delays GPU submission and pointer input; bursts of a few workers keep
   * the control panel responsive while the pool grows.
   */
  private spawnGrowthWave(requestId: number, remaining: number) {
    if (remaining <= 0 || requestId !== this.requestId) return;
    const batch = Math.min(CPU_POOL_SPAWN_BATCH, remaining);
    try {
      this.spawnWorkerWave(requestId, batch, this.workers.length);
    } catch (error) {
      // Bounded recovery: the run keeps the workers that did start, growth ends,
      // and the shortfall is published rather than passed off as the requested
      // workload. No restart loop.
      this.poolLimitation = error instanceof Error ? error.message : 'A CPU worker failed to start.';
      console.error('[StressTest] CPU pool growth ended after a worker failed to start', error);
      this.finishPoolGrowth('settled');
      return;
    }
    const left = remaining - batch;
    if (left > 0) {
      this.poolSpawnTimer = window.setTimeout(() => {
        this.poolSpawnTimer = 0;
        this.spawnGrowthWave(requestId, left);
      }, 0);
    }
  }

  private finishPoolGrowth(verdict: Exclude<StressPoolVerdict, 'growing'>) {
    this.poolGrowth = null;
    if (this.poolGrowthTimer !== 0) {
      window.clearTimeout(this.poolGrowthTimer);
      this.poolGrowthTimer = 0;
    }
    if (this.poolSpawnTimer !== 0) {
      window.clearTimeout(this.poolSpawnTimer);
      this.poolSpawnTimer = 0;
    }
    this.root.dataset.stressCpuPool = verdict;
    if (this.poolLimitation) {
      this.root.dataset.stressCpuPoolLimitation = this.poolLimitation;
    }
  }

  /**
   * Spawns a wave of continuously computing workers, each seeded with the band of
   * the number line it owns. Seeding costs one message per worker and then never
   * recurses into the main thread again until that worker prefetches its next
   * band, so a growing pool has no work queue to feed and a failed worker cannot
   * strand allocated search blocks that would have to be recovered.
   *
   * The worker is constructed before its activity bar so a constructor failure
   * cannot orphan a bar, and a wave that fails partway is unwound completely
   * before the error is rethrown — the initial wave fails the Start, while a
   * growth wave keeps the run that is already going and reports the shortfall.
   */
  private spawnWorkerWave(requestId: number, count: number, firstIndex: number) {
    const spawned: StressWorkerRecord[] = [];
    try {
      for (let offset = 0; offset < count; offset += 1) {
        const index = firstIndex + offset;
        const worker = new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' });
        const bar = document.createElement('span');
        bar.setAttribute('aria-label', `Worker ${index + 1}: starting`);
        this.workerActivity.append(bar);
        this.workerActivity.style.setProperty('--stress-workers', String(this.workerActivity.children.length));
        const messageListener = (event: MessageEvent<StressTestWorkerResponse>) => {
          this.handleWorkerMessage(record, event.data);
        };
        const errorListener = (event: ErrorEvent) => {
          if (requestId !== this.requestId || record.stopped) return;
          console.error('[StressTest] CPU worker error', event.message, event.filename, event.lineno);
          const details = [event.message, event.filename, event.lineno ? `line ${event.lineno}` : ''].filter(Boolean).join(' ');
          this.handleCpuStressFailure(details ? `CPU stress worker failed: ${details}` : 'A CPU stress worker failed.');
          window.dispatchEvent(new Event('utility-load-error'));
        };
        const record: StressWorkerRecord = {
          worker,
          stopped: false,
          candidates: 0,
          busyMs: 0,
          idleMs: 0,
          bandWaitMs: 0,
          slices: 0,
          slowSlices: 0,
          primesFound: 0,
          activity: 0,
          index,
          supplyId: 0,
          rangeLow: 0,
          activityElement: bar,
          messageListener,
          errorListener
        };
        worker.addEventListener('message', messageListener);
        worker.addEventListener('error', errorListener);
        this.workers.push(record);
        spawned.push(record);
        const range = primeWorkerRange(this.primeBandSerial);
        this.primeBandSerial += 1;
        record.rangeLow = range.low;
        bar.dataset.rangeLow = String(range.low);
        const request: StressTestWorkerRequest = {
          type: 'start-cpu-stress',
          requestId,
          workerIndex: index,
          low: range.low,
          limit: range.limit
        };
        worker.postMessage(request);
      }
    } catch (error) {
      for (let index = spawned.length - 1; index >= 0; index -= 1) this.removeWorkerRecord(spawned[index]);
      this.workers.length -= spawned.length;
      this.workerActivity.style.setProperty('--stress-workers', String(this.workerActivity.children.length));
      throw error;
    }
    return spawned.length;
  }

  private removeWorkerRecord(record: StressWorkerRecord) {
    record.worker.removeEventListener('message', record.messageListener);
    record.worker.removeEventListener('error', record.errorListener);
    record.worker.terminate();
    record.stopped = true;
    record.activityElement.remove();
  }

  private stopCpuStress() {
    this.poolGrowth = null;
    this.poolPlan = null;
    this.poolLimitation = '';
    if (this.poolGrowthTimer !== 0) {
      window.clearTimeout(this.poolGrowthTimer);
      this.poolGrowthTimer = 0;
    }
    if (this.poolSpawnTimer !== 0) {
      window.clearTimeout(this.poolSpawnTimer);
      this.poolSpawnTimer = 0;
    }
    delete this.root.dataset.stressCpuPool;
    delete this.root.dataset.stressCpuPoolLimitation;
    delete this.root.dataset.stressCpuPoolWindows;
    // Termination is the stop signal. A busy worker never has to acknowledge a
    // stop message before it can be torn down, which is what makes Stop work
    // while every worker is mid-chunk.
    for (const record of this.workers) this.removeWorkerRecord(record);
    this.workers = [];
    this.workerActivity.replaceChildren();
  }

  private handleWorkerMessage(record: StressWorkerRecord, message: StressTestWorkerResponse) {
    // A message from an earlier run can never touch this one: the request id is
    // bumped on every Start and Stop, and the record itself is torn down.
    if (message.requestId !== this.requestId || message.workerIndex !== record.index || record.stopped) {
      return;
    }

    if (message.type === 'cpu-stress-work-request') {
      // The worker owns a band and is prefetching the next one. Allocation is
      // O(1) and needs no bookkeeping: bands tile the number line, so the next
      // serial is disjoint from everything issued before it.
      if (message.supplyId !== record.supplyId + 1) return;
      record.supplyId = message.supplyId;
      let range;
      try {
        range = primeWorkerRange(this.primeBandSerial);
      } catch (error) {
        // The safe-integer number line is exhausted. Say so plainly rather than
        // wrapping back over already-searched integers or shrinking quietly.
        this.handleCpuStressFailure(error instanceof Error ? error.message : 'Prime band allocation failed.');
        return;
      }
      this.primeBandSerial += 1;
      record.rangeLow = range.low;
      const response: StressTestWorkerRequest = {
        type: 'continue-cpu-stress', requestId: this.requestId, workerIndex: record.index,
        supplyId: message.supplyId, low: range.low, limit: range.limit
      };
      record.worker.postMessage(response);
      return;
    }

    if (message.type === 'cpu-stress-heartbeat') {
      const previousCandidates = record.candidates;
      record.candidates = Math.max(record.candidates, message.candidates);
      record.activity = Math.max(0, record.candidates - previousCandidates);
      record.busyMs = Math.max(record.busyMs, message.busyMs);
      record.idleMs = Math.max(record.idleMs, message.idleMs);
      record.bandWaitMs = Math.max(record.bandWaitMs, message.bandWaitMs);
      record.slices = Math.max(record.slices, message.slices);
      record.slowSlices = Math.max(record.slowSlices, message.slowSlices);
      const primeDelta = Math.max(0, message.primesFound - record.primesFound);
      record.primesFound = Math.max(record.primesFound, message.primesFound);
      if (message.rangeLow > 0) record.rangeLow = message.rangeLow;
      this.totalCandidates += record.activity;
      // Workers own disjoint bands, so every prime counted here was found once,
      // and the displayed maximum is a prime some worker actually produced.
      this.latestPrime = Math.max(this.latestPrime, message.latestPrime);
      this.primesFound += primeDelta;
      this.root.dataset.stressLastChecksum = String(message.checksum);
      return;
    }

    if (message.type === 'cpu-stress-error' && message.message) {
      record.stopped = true;
      this.handleCpuStressFailure(message.message);
      return;
    }

    console.warn(`[StressTest] Ignoring unexpected CPU worker message type: ${message.type}`);
  }
  private handleCpuStressFailure(message: string) {
    this.stopCpuStress();
    this.stopCpuVisuals();
    this.lastError = message;

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
   * Closes the rolling scheduling window for the whole pool: wall time its workers
   * spent sieving, time spent waiting to be handed a processor again, and time
   * spent waiting for the page to hand out integers. `duty` is the first divided by
   * the first two, and it is what the growth rule decides on — the only in-page
   * reading that separates "one worker per logical processor" from "workers
   * queueing for one" without depending on what the work costs, how deep the search
   * has gone, or how far the clocks have sagged. Band waits are kept out of `duty`
   * and published separately: a pool that cannot get work is a page-side problem,
   * and reading it as a full machine would stop growth for the wrong reason.
   */
  private recordPoolSignal(now: number) {
    let busy = 0;
    let idle = 0;
    let band = 0;
    let slices = 0;
    let slow = 0;
    for (const record of this.workers) {
      busy += record.busyMs;
      idle += record.idleMs;
      band += record.bandWaitMs;
      slices += record.slices;
      slow += record.slowSlices;
    }
    if (this.signalWindowAt === 0) {
      // First sight of the pool: open the window rather than measure a share
      // against a baseline of zero, which would read as "nothing is wrong".
      this.resetPoolSignalWindow(now, busy, idle, band, slices, slow);
      return;
    }
    if (now - this.signalWindowAt < CPU_POOL_GROWTH_WINDOW_MS) return;
    const windowBusy = Math.max(0, busy - this.signalWindowBusy);
    const windowIdle = Math.max(0, idle - this.signalWindowIdle);
    const windowBand = Math.max(0, band - this.signalWindowBand);
    const windowSlices = Math.max(0, slices - this.signalWindowSlices);
    const windowSlow = Math.max(0, slow - this.signalWindowSlow);
    this.resetPoolSignalWindow(now, busy, idle, band, slices, slow);
    const running = windowBusy + windowIdle;
    this.poolSignal = {
      duty: running > 0 ? windowBusy / running : 0,
      slowShare: windowSlices > 0 ? windowSlow / windowSlices : 0,
      slices: windowSlices
    };
    this.root.dataset.stressCpuBusy = String(Math.round(100 * this.poolSignal.duty));
    this.root.dataset.stressCpuSliceSlow = String(Math.round(100 * this.poolSignal.slowShare));
    const waited = running + windowBand;
    this.root.dataset.stressCpuBandWait = String(waited > 0 ? Math.round(100 * windowBand / waited) : 0);
  }

  private resetPoolSignalWindow(at = 0, busy = 0, idle = 0, band = 0, slices = 0, slow = 0) {
    this.signalWindowAt = at;
    this.signalWindowBusy = busy;
    this.signalWindowIdle = idle;
    this.signalWindowBand = band;
    this.signalWindowSlices = slices;
    this.signalWindowSlow = slow;
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
    this.workerSummary.textContent = this.workers.length ? `CPU · ${this.workers.length} workers` : 'CPU ready';
    const maxActivity = Math.max(1, ...this.workers.map((record) => record.activity));
    Array.from(this.workerActivity.children).forEach((element, index) => {
      const record = this.workers[index];
      if (!(element instanceof HTMLElement) || !record) return;
      element.dataset.candidates = String(record.candidates);
      element.dataset.primesFound = String(record.primesFound);
      element.dataset.rangeLow = String(record.rangeLow);
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
    if (this.workers.length > 0) {
      this.recordPoolSignal(now);
    } else {
      delete this.root.dataset.stressCpuBusy;
      delete this.root.dataset.stressCpuSliceSlow;
      delete this.root.dataset.stressCpuBandWait;
    }
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
