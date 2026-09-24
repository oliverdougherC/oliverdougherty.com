import {
  CpuSmtProbe,
  formatStressElapsed,
  isStressMode,
  resolveCpuWorkerCount,
  shouldStressCpu,
  shouldStressGpu,
  SMT_PROBE_MAX_TOTAL_WORKERS,
  transitionStressState,
  type CpuSmtProbeAction,
  type StressGpuBackend,
  type StressMode,
  type StressState
} from './stressTestCore';
import { startAdaptiveGpuStress, type StressGpuStressHandle } from './stressTestGpu';
import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';
import {
  createBenchmarkPrimeAllocator,
  PrimeBlockAllocator,
  PRIME_PREFETCH_BLOCKS
} from './stressTestPrimeScheduler';

interface StressWorkerRecord {
  worker: Worker;
  stopped: boolean;
  iterations: number;
  workUnits: number;
  primesFound: number;
  activity: number;
  index: number;
  supplyId: number;
  blocksAssigned: number;
  refills: number;
  // Disposable SMT benchmark capacity: never counted in production results and
  // never able to fail the permanent workload.
  benchmark: boolean;
  // The allocator this record refills from: the permanent production allocator
  // for production waves, or its wave's disposable allocator for probe capacity.
  allocator: PrimeBlockAllocator;
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

function getStressTestMaxWorkersOverride() {
  // Internal debug hook for local thermal/load testing. Not part of the public UI contract.
  const globalValue = (window as Window & { __OD_STRESS_TEST_MAX_WORKERS__?: number }).__OD_STRESS_TEST_MAX_WORKERS__;
  return Number.isFinite(globalValue) ? globalValue : null;
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
  private readonly iterationLabel: HTMLElement;
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
  private primeAllocator = new PrimeBlockAllocator();
  private blocksAssigned = 0;
  private benchIterations = 0;
  private benchWorkUnits = 0;
  private cpuRefills = 0;
  private smtProbe: CpuSmtProbe | null = null;
  private smtProbeWave = 0;
  private smtProbeBaseline = 0;
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
  private totalIterations = 0;
  private totalWorkUnits = 0;
  private latestPrime = 0;
  private primesFound = 0;
  private candidatesPerSecond = 0;
  private candidateRateSamples: Array<{ at: number; iterations: number }> = [];
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
    this.iterationLabel = this.requireElement('stressIterations') as HTMLElement;
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
    this.totalIterations = 0;
    this.totalWorkUnits = 0;
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

  private startCpuStress(requestId: number) {
    if (!supportsModuleWorkers()) {
      throw new Error('This browser does not support module workers required for CPU stress.');
    }

    const workerCount = resolveCpuWorkerCount({
      hardwareConcurrency: navigator.hardwareConcurrency,
      maxWorkers: getStressTestMaxWorkersOverride()
    });

    this.primeAllocator = new PrimeBlockAllocator();
    this.blocksAssigned = 0;
    this.benchIterations = 0;
    this.benchWorkUnits = 0;
    this.cpuRefills = 0;
    this.root.dataset.stressCpuAlgorithm = 'segmented-sieve';
    this.root.dataset.stressCpuBlocksAssigned = '0';
    this.root.dataset.stressCpuRefills = '0';
    this.workerActivity.replaceChildren();
    this.spawnWorkerWave(requestId, workerCount, 0, false);
    this.root.dataset.stressCpuBlocksAssigned = String(this.blocksAssigned);

    // Browsers may report fewer logical processors than the machine actually
    // has — rounding to physical cores, capping the count, or an OS reserving
    // cores — leaving idle capacity on multithreaded CPUs. A throughput search
    // grows the worker count with disposable benchmark waves: exponentially
    // while aggregate measured work keeps rising, then by bisecting between
    // the last grown count and the first stalled one, converting proven waves
    // into permanent workers. The search lands at or just above measured
    // saturation instead of striding past it in doublings (12 → 24 → 48 → 24
    // never reaches a 32-thread machine; the search converges near it). Each
    // wave sieves its own disposable allocator seeded at the live production
    // frontier, so probe and permanent work units cost the same and a revert
    // can never leave a hole in the production search. The explicit worker cap
    // pins the count and skips the search.
    this.smtProbeWave = 0;
    this.smtProbeBaseline = workerCount;
    this.smtProbe = getStressTestMaxWorkersOverride() === null && workerCount < SMT_PROBE_MAX_TOTAL_WORKERS
      ? new CpuSmtProbe(workerCount)
      : null;
    if (this.smtProbe) {
      this.root.dataset.stressCpuSmtProbe = 'probing';
    }
  }

  /**
   * Spawns one wave of workers and seeds each with its prefetch fill. Benchmark
   * waves sieve a fresh disposable allocator seeded at the live production
   * frontier — the exact work the permanent workers are about to perform — so
   * probe and permanent work units are cost-comparable, and are flagged probe
   * capacity. The worker is constructed before its activity bar so a
   * constructor failure can not orphan a bar. A wave that fails partway is
   * fully unwound before the error is rethrown: every block the wave consumed
   * is returned to its allocator and its assignment counters reversed, so even
   * a partially failed permanent replacement wave cannot leave a hole in the
   * production frontier.
   */
  private spawnWorkerWave(requestId: number, count: number, firstIndex: number, benchmark: boolean) {
    const spawned: StressWorkerRecord[] = [];
    const allocator = benchmark
      ? createBenchmarkPrimeAllocator(this.primeAllocator.frontier)
      : this.primeAllocator;
    // Spawning is synchronous, so no refill allocation can interleave behind
    // this mark; rewinding it can only reclaim blocks this wave just consumed.
    const mark = allocator.mark();
    let consumedBlocks = 0;
    try {
      for (let offset = 0; offset < count; offset += 1) {
        const index = firstIndex + offset;
        const worker = new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' });
        const bar = document.createElement('span');
        bar.setAttribute('aria-label', benchmark ? `Probe worker ${index + 1}: starting` : `Worker ${index + 1}: starting`);
        if (benchmark) bar.dataset.benchmark = 'true';
        this.workerActivity.append(bar);
        this.workerActivity.style.setProperty('--stress-workers', String(this.workerActivity.children.length));
        const messageListener = (event: MessageEvent<StressTestWorkerResponse>) => {
          this.handleWorkerMessage(record, event.data);
        };
        const errorListener = (event: ErrorEvent) => {
          if (requestId !== this.requestId || record.stopped) return;
          console.error('[StressTest] CPU worker error', event.message, event.filename, event.lineno);
          if (record.benchmark) {
            // Disposable probe capacity failing must not stop the permanent workload.
            this.terminateSmtProbeWave();
            this.finishSmtProbe();
            return;
          }
          const details = [event.message, event.filename, event.lineno ? `line ${event.lineno}` : ''].filter(Boolean).join(' ');
          this.handleCpuStressFailure(details ? `CPU stress worker failed: ${details}` : 'A CPU stress worker failed.');
          window.dispatchEvent(new Event('utility-load-error'));
        };
        const record: StressWorkerRecord = {
          worker,
          stopped: false,
          iterations: 0,
          workUnits: 0,
          primesFound: 0,
          activity: 0,
          index,
          supplyId: 0,
          blocksAssigned: 0,
          refills: 0,
          benchmark,
          allocator,
          activityElement: bar,
          messageListener,
          errorListener
        };
        worker.addEventListener('message', messageListener);
        worker.addEventListener('error', errorListener);
        this.workers.push(record);
        spawned.push(record);
        const blocks = allocator.take(PRIME_PREFETCH_BLOCKS);
        consumedBlocks += blocks.length;
        record.blocksAssigned = blocks.length;
        if (!benchmark) this.blocksAssigned += blocks.length;
        bar.dataset.blocksAssigned = String(blocks.length);
        bar.dataset.refills = '0';
        const request: StressTestWorkerRequest = {
          type: 'start-cpu-stress',
          requestId,
          workerIndex: index,
          blocks,
          exhausted: allocator.exhausted
        };
        worker.postMessage(request);
      }
    } catch (error) {
      allocator.rewindTo(mark);
      if (!benchmark) this.blocksAssigned -= consumedBlocks;
      for (let index = spawned.length - 1; index >= 0; index -= 1) this.removeWorkerRecord(spawned[index]);
      this.workers.length -= spawned.length;
      this.workerActivity.style.setProperty('--stress-workers', String(this.workerActivity.children.length));
      throw error;
    }
    if (benchmark) this.smtProbeWave += spawned.length;
    return spawned.length;
  }

  private removeWorkerRecord(record: StressWorkerRecord) {
    record.worker.removeEventListener('message', record.messageListener);
    record.worker.removeEventListener('error', record.errorListener);
    record.worker.terminate();
    record.stopped = true;
    record.activityElement.remove();
  }

  /** Drops the disposable probe wave only: its seeded allocator dies with the records and the production frontier is untouched. */
  private terminateSmtProbeWave() {
    for (let index = this.workers.length - 1; index >= this.workers.length - this.smtProbeWave; index -= 1) {
      this.removeWorkerRecord(this.workers[index]);
    }
    this.workers.length -= this.smtProbeWave;
    this.smtProbeWave = 0;
    this.benchIterations = 0;
    this.benchWorkUnits = 0;
    this.workerActivity.style.setProperty('--stress-workers', String(this.workerActivity.children.length));
  }

  private finishSmtProbe() {
    this.smtProbe = null;
    this.root.dataset.stressCpuSmtProbe = this.workers.length > this.smtProbeBaseline ? 'kept' : 'reverted';
  }

  private applySmtProbeAction(action: CpuSmtProbeAction) {
    if (action.action === 'none' || !this.smtProbe) return;
    if (action.action === 'spawn') {
      try {
        this.spawnWorkerWave(this.requestId, action.extra, this.workers.length, true);
      } catch (error) {
        // The probe wave is optional capacity; the permanent run stays valid.
        console.error('[StressTest] CPU probe worker wave failed to start', error);
        this.finishSmtProbe();
      }
      return;
    }
    if (action.action === 'revert') {
      // Discarding a failed trial does not necessarily end the search: once a
      // wave was ever kept, a revert lowers the bisection bound and the probe
      // re-baselines for a smaller trial. Only a finished search finalizes.
      this.terminateSmtProbeWave();
      if (this.smtProbe.registerRevert(readNow())) this.finishSmtProbe();
      return;
    }
    // keep: benchmark work is disposable, so trade the wave for permanent
    // workers fed by the production allocator — but only as many as the
    // machine's measured throughput can explain (the probe's capacity
    // estimate), then re-baseline and either attempt another exponential wave
    // or a refinement bisect, until the bracket converges, the total cap is
    // reached, or a trial fails against the never-exceeded reported count. A
    // replacement wave that fails partway rewinds the production allocator,
    // so continuing with the old permanent workers is safe: their next refill
    // resumes the exact frontier, gapless.
    const replacement = action.convert;
    this.terminateSmtProbeWave();
    try {
      this.spawnWorkerWave(this.requestId, replacement, this.workers.length, false);
    } catch (error) {
      console.error('[StressTest] CPU post-probe worker wave failed to start', error);
      this.finishSmtProbe();
      return;
    }
    if (this.smtProbe.registerKeep(readNow())) this.finishSmtProbe();
  }

  private stopCpuStress() {
    this.smtProbe = null;
    this.smtProbeWave = 0;
    this.smtProbeBaseline = 0;
    this.benchIterations = 0;
    this.benchWorkUnits = 0;
    delete this.root.dataset.stressCpuSmtProbe;
    for (const record of this.workers) this.removeWorkerRecord(record);
    this.workers = [];
    this.workerActivity.replaceChildren();
  }

  private handleWorkerMessage(record: StressWorkerRecord, message: StressTestWorkerResponse) {
    if (message.requestId !== this.requestId || message.workerIndex !== record.index || record.stopped) {
      return;
    }

    if (message.type === 'cpu-stress-work-request') {
      if (message.supplyId !== record.supplyId + 1 || !Number.isInteger(message.count)
        || message.count < 1 || message.count > PRIME_PREFETCH_BLOCKS) return;
      record.supplyId = message.supplyId;
      // Each record refills from the allocator that seeded its wave: permanent
      // workers from the production allocator, probe workers from their wave's
      // disposable allocator, so probe capacity can never touch production coverage.
      const allocator = record.allocator;
      const blocks = allocator.take(message.count);
      record.blocksAssigned += blocks.length;
      record.refills += 1;
      if (!record.benchmark) {
        this.blocksAssigned += blocks.length;
        this.cpuRefills += 1;
      }
      const response: StressTestWorkerRequest = {
        type: 'supply-cpu-stress-work', requestId: this.requestId, workerIndex: record.index,
        supplyId: message.supplyId, blocks, exhausted: allocator.exhausted
      };
      record.worker.postMessage(response);
      return;
    }

    if (message.type === 'cpu-stress-heartbeat') {
      const previousIterations = record.iterations;
      record.iterations = Math.max(record.iterations, message.iterations);
      record.activity = Math.max(0, record.iterations - previousIterations);
      const primeDelta = Math.max(0, message.primesFound - record.primesFound);
      record.primesFound = Math.max(record.primesFound, message.primesFound);
      const workDelta = Math.max(0, message.workUnits - record.workUnits);
      record.workUnits = Math.max(record.workUnits, message.workUnits);
      if (record.benchmark) {
        // Disposable benchmark work feeds only the probe's rate measurement.
        this.benchIterations += record.activity;
        this.benchWorkUnits += workDelta;
      } else {
        this.totalIterations += record.activity;
        this.totalWorkUnits += workDelta;
        this.latestPrime = Math.max(this.latestPrime, message.latestPrime);
        this.primesFound += primeDelta;
        this.root.dataset.stressLastChecksum = String(message.checksum);
      }
      if (this.smtProbe) {
        // Work units measure CPU work actually executed, and disposable waves
        // seed at the production frontier, so benchmark and permanent units
        // cost the same. Candidates/s would decay with the frontier and
        // per-prime scan counts would drift cheaper, hiding or faking capacity.
        this.applySmtProbeAction(this.smtProbe.observe(readNow(), this.totalWorkUnits + this.benchWorkUnits));
      }
      return;
    }

    if (message.type === 'cpu-stress-stopped') {
      record.stopped = true;
      return;
    }

    if (message.type === 'cpu-stress-exhausted') {
      record.stopped = true;
      // Only the permanent workload completing ends the search; a disposable
      // benchmark wave never gates shutdown.
      if (this.workers.every(worker => worker.benchmark || worker.stopped)) {
        this.stopCpuStress();
        this.stopCpuVisuals();
        if (!this.gpu) {
          this.stopMetricLoop();
          this.setState('idle');
        }
        this.syncMetrics(true);
      }
      return;
    }

    if (message.type === 'cpu-stress-error' && message.message) {
      record.stopped = true;
      if (record.benchmark) {
        console.error('[StressTest] CPU probe worker reported a failure', message.message);
        this.terminateSmtProbeWave();
        this.finishSmtProbe();
        return;
      }
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
      samples.push({ at: now, iterations: this.totalIterations });
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
    return Math.max(0, (latest.iterations - this.candidatesTestedAt(samples, windowStart)) * 1000 / spanMs);
  }

  // Linear estimate of the actual cumulative count at a window edge, taken
  // between the two samples that bracket it. Before the first sample the
  // observed count was already its recorded value, so no extrapolation occurs.
  private candidatesTestedAt(samples: Array<{ at: number; iterations: number }>, at: number) {
    const first = samples[0];
    if (at <= first.at) {
      return first.iterations;
    }
    const last = samples[samples.length - 1];
    if (at >= last.at) {
      return last.iterations;
    }
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].at >= at) {
        const previous = samples[index - 1];
        const gapMs = samples[index].at - previous.at;
        return gapMs > 0
          ? previous.iterations + (samples[index].iterations - previous.iterations) * (at - previous.at) / gapMs
          : samples[index].iterations;
      }
    }
    return last.iterations;
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
    this.root.dataset.stressCpuBlocksAssigned = String(this.blocksAssigned);
    this.root.dataset.stressCpuRefills = String(this.cpuRefills);
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
      element.dataset.blocksAssigned = String(record.blocksAssigned);
      element.dataset.refills = String(record.refills);
      element.dataset.iterations = String(record.iterations);
      element.dataset.primesFound = String(record.primesFound);
      element.style.transform = `scaleY(${.1 + .9 * record.activity / maxActivity})`;
      element.setAttribute('aria-label', `Worker ${index + 1}: ${record.iterations.toLocaleString()} candidates, ${record.primesFound.toLocaleString()} primes`);
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
    this.iterationLabel.textContent = this.totalIterations > 0 ? this.totalIterations.toLocaleString() : '0';
    this.iterationLabel.style.setProperty('--readout-chars', String(this.iterationLabel.textContent.length));
    this.root.dataset.stressWorkerCount = String(this.workers.length);
    this.root.dataset.stressTotalWorkUnits = String(this.totalWorkUnits + this.benchWorkUnits);
    this.root.dataset.stressGpuBackend = this.gpuBackend;
    this.root.dataset.stressTotalRenderedFrames = String(this.frameCount);
    this.root.dataset.stressGpuWorkloadLevel = String(this.gpuWorkloadLevel);
    this.root.dataset.stressGpuCanvasActive = this.gpuCanvasActive ? 'true' : 'false';
    this.root.dataset.stressCanvasActive = (this.gpuCanvasActive || this.cpuVisualFrameId > 0) ? 'true' : 'false';
    this.root.dataset.stressGpuLastError = this.lastError;
    this.root.dataset.stressIterations = String(this.totalIterations);
    this.root.dataset.stressCandidatesPerSecond = String(Math.round(this.candidatesPerSecond));
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
