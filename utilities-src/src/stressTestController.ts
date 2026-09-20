import {
  formatStressElapsed,
  isStressMode,
  resolveCpuWorkerCount,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState,
  type StressGpuBackend,
  type StressMode,
  type StressState
} from './stressTestCore';
import { startAdaptiveGpuStress, type StressGpuStressHandle } from './stressTestGpu';
import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';
import { PrimeBlockAllocator, PRIME_PREFETCH_BLOCKS } from './stressTestPrimeScheduler';

interface StressWorkerRecord {
  worker: Worker;
  stopped: boolean;
  iterations: number;
  primesFound: number;
  activity: number;
  index: number;
  supplyId: number;
  blocksAssigned: number;
  refills: number;
  activityElement: HTMLElement;
  messageListener: (event: MessageEvent<StressTestWorkerResponse>) => void;
  errorListener: (event: ErrorEvent) => void;
}

type StressMetricId = 'elapsed' | 'workers' | 'gpu' | 'cadence' | 'stalls' | 'iterations';

const DEFAULT_MODE: StressMode = 'both';
const METRIC_INTERVAL_MS = 120;
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
  private readonly statusText: HTMLElement;
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
  private cpuRefills = 0;
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
  private latestPrime = 0;
  private primesFound = 0;
  private candidatesPerSecond = 0;
  private previousIterations = 0;
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
    this.statusText = this.requireElement('stressStatusText') as HTMLElement;
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
    this.listen(this.requireElement('stressOrbit'), 'keydown', (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'];
      if (!keys.includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') { this.pointerX = 0; this.pointerY = 0; }
      else {
        this.pointerX = Math.max(-1, Math.min(1, this.pointerX + (event.key === 'ArrowRight' ? .15 : event.key === 'ArrowLeft' ? -.15 : 0)));
        this.pointerY = Math.max(-1, Math.min(1, this.pointerY + (event.key === 'ArrowDown' ? .15 : event.key === 'ArrowUp' ? -.15 : 0)));
      }
      this.gpu?.setPointer?.(this.pointerX, this.pointerY);
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
    this.setState('idle', 'Ready. Starting this will make your browser hot, loud, slow, and power hungry.');
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
    this.latestPrime = 0;
    this.primesFound = 0;
    this.previousIterations = 0;
    this.candidatesPerSecond = 0;
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
    this.setState(transitionStressState(this.state, 'start'), 'Starting stress workload...');

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
          this.setState('error', this.lastError);
        } else {
          this.setState('unsupported', 'GPU stress needs WebGPU, WebGL2, or WebGL in this browser.');
        }
        this.syncMetrics(true);
        return;
      }

      if (this.mode === 'both' && this.gpu && cpuStartError) {
        this.lastError = cpuStartError;
        this.setState(transitionStressState(this.state, 'running'), 'GPU stress is running. CPU stress is unavailable in this browser.');
      } else if (this.mode === 'both' && !this.gpu && !this.workers.length) {
        this.lastError = cpuStartError || this.lastError || 'No stress backend was available.';
        this.setState(transitionStressState(this.state, 'error'), this.lastError);
        this.syncMetrics(true);
        return;
      } else if (this.mode === 'both' && !this.gpu) {
        this.setState(transitionStressState(this.state, 'running'), this.gpuStartupError
          ? `CPU stress is running. GPU stress failed: ${this.gpuStartupError}`
          : 'CPU stress is running. GPU stress is unavailable in this browser.');
      } else {
        this.setState(transitionStressState(this.state, 'running'), 'Running until stopped or hidden. CPU utilization and GPU watts depend on your hardware and browser.');
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
      this.setState('error', this.lastError);
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
    this.setState('error', message);
    this.syncMetrics(true);
  }

  private stop() {
    if (this.state !== 'starting' && this.state !== 'running') {
      return;
    }

    this.requestId += 1;
    const stoppingState = transitionStressState(this.state, 'stop');
    this.setState(stoppingState, 'Stopping stress workload...');
    this.stopCpuStress();
    this.stopGpuStress();
    this.stopCpuVisuals();
    this.stopMetricLoop();
    this.candidatesPerSecond = 0;
    this.frameCount = 0;
    this.callbackStalls = 0;
    this.lastRenderRate = 0;
    this.gpuBackend = 'none';
    this.gpuWorkloadLevel = 0;
    this.gpuCanvasActive = false;
    this.setState(transitionStressState(stoppingState, 'stopped'), 'Stopped. Ready to run another stress test.');
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
    this.cpuRefills = 0;
    this.root.dataset.stressCpuAlgorithm = 'segmented-sieve';
    this.root.dataset.stressCpuBlocksAssigned = '0';
    this.root.dataset.stressCpuRefills = '0';
    this.workerActivity.style.setProperty('--stress-workers', String(workerCount));

    this.workerActivity.replaceChildren(...Array.from({ length: workerCount }, (_, index) => {
      const bar = document.createElement('span');
      bar.setAttribute('aria-label', `Worker ${index + 1}: starting`);
      return bar;
    }));
    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' });
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
        iterations: 0,
        primesFound: 0,
        activity: 0,
        index,
        supplyId: 0,
        blocksAssigned: 0,
        refills: 0,
        activityElement: this.workerActivity.children[index] as HTMLElement,
        messageListener,
        errorListener
      };
      worker.addEventListener('message', messageListener);
      worker.addEventListener('error', errorListener);
      this.workers.push(record);
      const blocks = this.primeAllocator.take(PRIME_PREFETCH_BLOCKS);
      record.blocksAssigned = blocks.length;
      this.blocksAssigned += blocks.length;
      record.activityElement.dataset.blocksAssigned = String(blocks.length);
      record.activityElement.dataset.refills = '0';
      const request: StressTestWorkerRequest = {
        type: 'start-cpu-stress',
        requestId,
        workerIndex: index,
        blocks,
        exhausted: this.primeAllocator.exhausted
      };
      worker.postMessage(request);
    }
    this.root.dataset.stressCpuBlocksAssigned = String(this.blocksAssigned);
  }

  private stopCpuStress() {
    for (const record of this.workers) {
      record.worker.removeEventListener('message', record.messageListener);
      record.worker.removeEventListener('error', record.errorListener);
      record.worker.terminate();
      record.stopped = true;
    }
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
      const blocks = this.primeAllocator.take(message.count);
      record.blocksAssigned += blocks.length;
      record.refills += 1;
      this.blocksAssigned += blocks.length;
      this.cpuRefills += 1;
      const response: StressTestWorkerRequest = {
        type: 'supply-cpu-stress-work', requestId: this.requestId, workerIndex: record.index,
        supplyId: message.supplyId, blocks, exhausted: this.primeAllocator.exhausted
      };
      record.worker.postMessage(response);
      return;
    }

    if (message.type === 'cpu-stress-heartbeat') {
      const previousIterations = record.iterations;
      record.iterations = Math.max(record.iterations, message.iterations);
      record.activity = Math.max(0, record.iterations - previousIterations);
      this.totalIterations += record.activity;
      this.latestPrime = Math.max(this.latestPrime, message.latestPrime);
      this.primesFound += Math.max(0, message.primesFound - record.primesFound);
      record.primesFound = Math.max(record.primesFound, message.primesFound);
      this.root.dataset.stressLastChecksum = String(message.checksum);
      return;
    }

    if (message.type === 'cpu-stress-stopped') {
      record.stopped = true;
      return;
    }

    if (message.type === 'cpu-stress-exhausted') {
      record.stopped = true;
      if (this.workers.every(worker => worker.stopped)) {
        this.stopCpuStress();
        this.stopCpuVisuals();
        if (!this.gpu) {
          this.stopMetricLoop();
          this.setState('idle', 'Prime search reached the safe integer limit.');
        }
        this.syncMetrics(true);
      }
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
      this.setState(transitionStressState(this.state, 'running'), 'GPU stress is still running. CPU stress worker failed.');
      this.syncMetrics(true);
      return;
    }

    // Cancel a GPU initialization that may still be awaiting an adapter/device.
    this.requestId += 1;
    this.stopGpuStress({ loseContext: true });
    this.stopMetricLoop();
    this.setState(transitionStressState(this.state, 'error'), message);
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
      this.setState(transitionStressState(this.state, 'running'), 'GPU stress stopped; CPU stress is still running.');
      this.startCpuVisuals();
    } else {
      this.stopCpuStress();
      this.stopMetricLoop();
      this.stopCpuVisuals();
      this.resetRenderCadence();
      this.setState('error', message);
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

    const sampleMs = now - this.lastMetricAt;
    if (sampleMs > 0 && this.workers.length) {
      this.candidatesPerSecond = Math.max(0, (this.totalIterations - this.previousIterations) * 1000 / sampleMs);
    }
    this.previousIterations = this.totalIterations;
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
    this.root.dataset.stressGpuBackend = this.gpuBackend;
    this.root.dataset.stressTotalRenderedFrames = String(this.frameCount);
    this.root.dataset.stressGpuWorkloadLevel = String(this.gpuWorkloadLevel);
    this.root.dataset.stressGpuCanvasActive = this.gpuCanvasActive ? 'true' : 'false';
    this.root.dataset.stressCanvasActive = (this.gpuCanvasActive || this.cpuVisualFrameId > 0) ? 'true' : 'false';
    this.root.dataset.stressGpuLastError = this.lastError;
    this.root.dataset.stressIterations = String(this.totalIterations);
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

  private setState(state: StressState, message: string) {
    this.state = state;
    (this.requireElement('stressSceneState') as HTMLElement).textContent = state === 'running' ? 'LIVE' : state === 'starting' ? 'WARMING UP' : state === 'error' || state === 'unsupported' ? 'UNAVAILABLE' : 'STANDBY';
    this.root.dataset.stressState = state;
    this.statusText.textContent = message;
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
