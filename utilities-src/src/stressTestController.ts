import {
  formatStressElapsed,
  isStressMode,
  resolveCpuWorkerCount,
  resolveGpuBackendFallbacks,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState,
  type StressGpuBackend,
  type StressMode,
  type StressState
} from './stressTestCore';
import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';

interface StressWorkerRecord {
  worker: Worker;
  stopped: boolean;
  iterations: number;
  messageListener: (event: MessageEvent<StressTestWorkerResponse>) => void;
  errorListener: (event: ErrorEvent) => void;
}

interface WebGpuAdapterLike {
  requestDevice(): Promise<WebGpuDeviceLike>;
}

interface WebGpuLike {
  requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }): Promise<WebGpuAdapterLike | null>;
  getPreferredCanvasFormat?: () => string;
}

interface WebGpuDeviceLike {
  queue: {
    submit(commands: unknown[]): void;
    writeBuffer(buffer: unknown, offset: number, data: ArrayBufferView): void;
  };
  createShaderModule(descriptor: object): WebGpuShaderModuleLike;
  createBuffer(descriptor: object): WebGpuBufferLike;
  createBindGroupLayout(descriptor: object): WebGpuBindGroupLayoutLike;
  createPipelineLayout(descriptor: object): WebGpuPipelineLayoutLike;
  createComputePipeline(descriptor: object): WebGpuComputePipelineLike;
  createRenderPipeline(descriptor: object): WebGpuRenderPipelineLike;
  createBindGroup(descriptor: object): WebGpuBindGroupLike;
  createCommandEncoder(): WebGpuCommandEncoderLike;
  destroy?: () => void;
  lost: Promise<{ reason: 'destroyed' | 'unknown'; message: string }>;
}

interface WebGpuShaderModuleLike {}

interface WebGpuBindGroupLayoutLike {}

interface WebGpuPipelineLayoutLike {}

interface WebGpuComputePipelineLike {}

interface WebGpuBindGroupLike {}

interface WebGpuBufferLike {
  destroy?: () => void;
}

interface WebGpuRenderPipelineLike {
  getBindGroupLayout(index: number): unknown;
}

interface WebGpuCommandEncoderLike {
  beginComputePass(): {
    setPipeline(pipeline: WebGpuComputePipelineLike): void;
    setBindGroup(index: number, bindGroup: WebGpuBindGroupLike): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
  };
  beginRenderPass(descriptor: object): {
    setPipeline(pipeline: WebGpuRenderPipelineLike): void;
    setBindGroup(index: number, bindGroup: WebGpuBindGroupLike): void;
    draw(vertexCount: number): void;
    end(): void;
  };
  finish(): unknown;
}

interface WebGpuCanvasContextLike {
  configure(descriptor: object): void;
  getCurrentTexture(): {
    createView(): unknown;
  };
}

interface ActiveWebGpuStress {
  backend: 'webgpu-compute';
  device: WebGpuDeviceLike;
  computePipeline: WebGpuComputePipelineLike;
  renderPipeline: WebGpuRenderPipelineLike;
  renderBindGroup: WebGpuBindGroupLike;
  storageBuffer: WebGpuBufferLike;
  timeBuffer: WebGpuBufferLike;
  frameId: number;
  workloadLevel: number;
  startedAt: number;
}

interface ActiveWebGlStress {
  backend: 'webgl2-fragment' | 'webgl1-fragment';
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  positionBuffer: WebGLBuffer;
  positionLocation: number;
  timeLocation: WebGLUniformLocation | null;
  resLocation: WebGLUniformLocation | null;
  workloadLocation: WebGLUniformLocation | null;
  frameId: number;
  workloadLevel: number;
  startedAt: number;
  rampBucket: number;
  cachedRampLevel: number;
}

type ActiveGpuStress = ActiveWebGpuStress | ActiveWebGlStress;

interface ThermalNode {
  x: number;
  y: number;
  radius: number;
  speed: number;
  phase: number;
  intensity: number;
}

type StressMetricId = 'elapsed' | 'workers' | 'gpu' | 'fps' | 'dropped' | 'iterations';

declare global {
  const GPUBufferUsage: Record<string, number> | undefined;
  const GPUTextureUsage: Record<string, number> | undefined;

  interface HTMLCanvasElement {
    getContext(contextId: 'webgpu'): WebGpuCanvasContextLike | null;
  }
}

const DEFAULT_MODE: StressMode = 'both';
const METRIC_INTERVAL_MS = 250;
// 1MB keeps the WebGPU stress buffer broadly compatible with integrated GPUs.
const WEBGPU_STORAGE_ITEMS = 262144;
// Conservative fragment workload ceiling: 6 * 64 = 384 loop iterations.
const WEBGL_MAX_WORKLOAD_LEVEL = 6;
const WEBGL_WORKLOAD_ITERATIONS_PER_LEVEL = 64;
const WEBGL_FRAGMENT_LOOP_BOUND = WEBGL_MAX_WORKLOAD_LEVEL * WEBGL_WORKLOAD_ITERATIONS_PER_LEVEL;
const CPU_THERMAL_NODE_COUNT = 42;
const STRESS_METRIC_HIDE_ORDER: Record<StressMode, StressMetricId[]> = {
  // Hide least relevant metrics first when the control panel is height-limited.
  cpu: ['dropped', 'gpu', 'fps', 'iterations', 'elapsed', 'workers'],
  gpu: ['dropped', 'iterations', 'workers', 'fps', 'gpu', 'elapsed'],
  both: ['dropped', 'iterations', 'fps', 'gpu', 'workers', 'elapsed']
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

function getNavigatorGpu(): WebGpuLike | null {
  const gpu = (navigator as Navigator & { gpu?: WebGpuLike }).gpu;
  return gpu && typeof gpu.requestAdapter === 'function' ? gpu : null;
}

function getWebGpuUsageFlag(name: string) {
  const usage = typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage : undefined;
  const value = usage?.[name] ?? 0;
  if (value === 0) {
    console.warn(`[StressTest] GPUBufferUsage.${name} is unavailable.`);
  }
  return value;
}

function getWebGpuTextureUsageFlag(name: string) {
  const usage = typeof GPUTextureUsage !== 'undefined' ? GPUTextureUsage : undefined;
  const value = usage?.[name] ?? 0;
  if (value === 0) {
    console.warn(`[StressTest] GPUTextureUsage.${name} is unavailable.`);
  }
  return value;
}

function resolveDisplayRefreshRate() {
  const refreshRate = (window.screen as Screen & { refreshRate?: number }).refreshRate;
  return typeof refreshRate === 'number' && Number.isFinite(refreshRate) && refreshRate > 0 ? refreshRate : 60;
}

function debugStressTest(message: string, error?: unknown) {
  if (typeof console === 'undefined' || typeof console.debug !== 'function') {
    return;
  }

  if (error === undefined) {
    console.debug(`[StressTest] ${message}`);
    return;
  }

  console.debug(`[StressTest] ${message}`, error);
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
  private readonly fpsLabel: HTMLElement;
  private readonly droppedFrameLabel: HTMLElement;
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
  private gpu: ActiveGpuStress | null = null;
  private startedAt = 0;
  private metricFrameId = 0;
  private lastFrameAt = 0;
  private lastMetricAt = 0;
  private frameCount = 0;
  private droppedFrames = 0;
  private lastFps = 0;
  private totalIterations = 0;
  private gpuBackend: StressGpuBackend = 'none';
  private gpuWorkloadLevel = 0;
  private lastError = '';
  private gpuCanvasActive = false;

  private cpuVisualFrameId = 0;
  private controlPanelFitFrameId = 0;
  private canvasResizeFrameId = 0;
  private canvas2dCtx: CanvasRenderingContext2D | null = null;
  private canvasResizeObserver: ResizeObserver | null = null;
  private thermalNodes: ThermalNode[] = [];
  private readonly cleanupCallbacks: Array<() => void> = [];
  constructor(root: HTMLElement) {
    this.root = root;
    this.modeButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-stress-mode-option]'));
    this.startButton = this.requireElement('stressStartBtn', HTMLButtonElement);
    this.stopButton = this.requireElement('stressStopBtn', HTMLButtonElement);
    this.statusText = this.requireElement('stressStatusText', HTMLElement);
    this.elapsedLabel = this.requireElement('stressElapsed', HTMLElement);
    this.workerCountLabel = this.requireElement('stressWorkerCount', HTMLElement);
    this.backendLabel = this.requireElement('stressGpuBackend', HTMLElement);
    this.fpsLabel = this.requireElement('stressFrameRate', HTMLElement);
    this.droppedFrameLabel = this.requireElement('stressDroppedFrames', HTMLElement);
    this.iterationLabel = this.requireElement('stressIterations', HTMLElement);
    this.metricsPanel = this.requireElement('stressMetrics', HTMLElement);
    this.metricCards = Array.from(this.metricsPanel.querySelectorAll<HTMLElement>('[data-stress-metric]'));
    this.canvas = this.requireElement('stressCanvas', HTMLCanvasElement);
    this.metricCards.forEach((card) => {
      const metricId = card.dataset.stressMetric;
      if (metricId === 'elapsed' || metricId === 'workers' || metricId === 'gpu' || metricId === 'fps' || metricId === 'dropped' || metricId === 'iterations') {
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
    this.listen(this.reducedMotionQuery, 'change', () => {
      this.reducedMotion = this.reducedMotionQuery.matches;
      this.root.dataset.stressReducedMotion = this.reducedMotion ? 'true' : 'false';
      if (this.reducedMotion) {
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
    this.drawIdleCanvas();
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
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.lastFps = 0;
    this.lastFrameAt = 0;
    this.lastMetricAt = 0;
    this.startedAt = readNow();
    this.gpuBackend = 'none';
    this.gpuWorkloadLevel = 0;
    this.lastError = '';
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
          cpuStartError = error instanceof Error ? error.message : 'CPU stress failed to start.';
          if (this.mode === 'cpu') {
            throw error;
          }
        }
      }

      if (shouldStressGpu(this.mode)) {
        const gpu = await this.startGpuStress();
        if (requestId !== this.requestId) {
          if (gpu && this.gpu === gpu) {
            this.stopGpuStress({ loseContext: true });
          }
          return;
        }
        this.gpu = gpu;
        this.gpuBackend = gpu?.backend ?? 'none';
      }

      if (requestId !== this.requestId) {
        return;
      }

      if (this.mode === 'gpu' && !this.gpu) {
        this.stopCpuStress();
        this.setState('unsupported', 'GPU stress needs WebGPU, WebGL2, or WebGL in this browser.');
        this.syncMetrics(true);
        return;
      }

      if (this.mode === 'both' && this.gpu && cpuStartError) {
        this.lastError = cpuStartError;
        this.setState(transitionStressState(this.state, 'running'), 'GPU stress is running. CPU stress is unavailable in this browser.');
      } else if (this.mode === 'both' && !this.gpu && !this.workers.length) {
        this.lastError = cpuStartError || 'No stress backend was available.';
        this.setState(transitionStressState(this.state, 'error'), this.lastError);
        this.syncMetrics(true);
        return;
      } else if (this.mode === 'both' && !this.gpu) {
        this.setState(transitionStressState(this.state, 'running'), 'CPU stress is running. GPU stress is unavailable in this browser.');
      } else {
        this.setState(transitionStressState(this.state, 'running'), 'Stress test running until you stop it or leave this utility.');
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

    const requestId = this.requestId;
    this.requestId += 1;
    const stoppingState = transitionStressState(this.state, 'stop');
    this.setState(stoppingState, 'Stopping stress workload...');
    this.stopCpuStress();
    this.stopGpuStress();
    this.stopCpuVisuals();
    this.stopMetricLoop();
    this.totalIterations = 0;
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.lastFps = 0;
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

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' });
      const messageListener = (event: MessageEvent<StressTestWorkerResponse>) => {
        this.handleWorkerMessage(record, event.data);
      };
      const errorListener = (event: ErrorEvent) => {
        console.error('[StressTest] CPU worker error', event.message, event.filename, event.lineno);
        const details = [event.message, event.filename, event.lineno ? `line ${event.lineno}` : ''].filter(Boolean).join(' ');
        this.handleCpuStressFailure(details ? `CPU stress worker failed: ${details}` : 'A CPU stress worker failed.');
      };
      const record: StressWorkerRecord = {
        worker,
        stopped: false,
        iterations: 0,
        messageListener,
        errorListener
      };
      worker.addEventListener('message', messageListener);
      worker.addEventListener('error', errorListener);
      this.workers.push(record);
      const request: StressTestWorkerRequest = {
        type: 'start-cpu-stress',
        requestId,
        workerIndex: index
      };
      worker.postMessage(request);
    }
  }

  private stopCpuStress() {
    for (const record of this.workers) {
      record.worker.removeEventListener('message', record.messageListener);
      record.worker.removeEventListener('error', record.errorListener);
      record.worker.terminate();
      record.stopped = true;
    }
    this.workers = [];
  }

  private handleWorkerMessage(record: StressWorkerRecord, message: StressTestWorkerResponse) {
    if (message.requestId !== this.requestId || record.stopped) {
      return;
    }

    if (message.type === 'cpu-stress-heartbeat') {
      const previousIterations = record.iterations;
      record.iterations = Math.max(record.iterations, message.iterations);
      this.totalIterations += Math.max(0, record.iterations - previousIterations);
      this.root.dataset.stressLastChecksum = String(message.checksum);
      return;
    }

    if (message.type === 'cpu-stress-stopped') {
      record.stopped = true;
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

    this.stopGpuStress({ loseContext: true });
    this.stopMetricLoop();
    this.setState(transitionStressState(this.state, 'error'), message);
    this.syncMetrics(true);
  }

  private async startGpuStress() {
    const backends = resolveGpuBackendFallbacks({
      hasWebGpu: Boolean(getNavigatorGpu()),
      hasWebGl2: this.canCreateContext('webgl2'),
      hasWebGl1: this.canCreateContext('webgl')
    });

    for (const backend of backends) {
      try {
        if (backend === 'webgpu-compute') {
          return await this.startWebGpuStress();
        }
        if (backend === 'webgl2-fragment') {
          return this.startWebGlStress('webgl2-fragment');
        }
        if (backend === 'webgl1-fragment') {
          return this.startWebGlStress('webgl1-fragment');
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.stopGpuStress({ loseContext: true });
      }
    }

    return null;
  }

  private canCreateContext(type: 'webgl2' | 'webgl') {
    let canvas: HTMLCanvasElement | null = document.createElement('canvas');
    try {
      return Boolean(canvas.getContext(type, {
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance'
      }));
    } catch (error) {
      debugStressTest(`Context probe for "${type}" failed.`, error);
      return false;
    } finally {
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
    }
  }

  private getWebGlContext(backend: 'webgl2-fragment' | 'webgl1-fragment') {
    const options = {
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance' as const,
      preserveDrawingBuffer: true
    };

    if (backend === 'webgl2-fragment') {
      const ctx = this.canvas.getContext('webgl2', options);
      return ctx instanceof WebGL2RenderingContext ? ctx : null;
    }

    const ctx = this.canvas.getContext('webgl', options);
    return ctx instanceof WebGLRenderingContext ? ctx : null;
  }

  private async startWebGpuStress(): Promise<ActiveWebGpuStress> {
    const gpu = getNavigatorGpu();
    if (!gpu) {
      throw new Error('WebGPU is unavailable.');
    }
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new Error('WebGPU adapter unavailable.');
    }
    const device = await adapter.requestDevice();
    this.prepareGpuCanvas();
    this.syncCanvasSize();
    const context = this.canvas.getContext('webgpu');
    if (!context) {
      throw new Error('WebGPU canvas context unavailable.');
    }

    const format = gpu.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
    context.configure({
      device,
      format,
      usage: getWebGpuTextureUsageFlag('RENDER_ATTACHMENT'),
      alphaMode: 'opaque'
    });

    const computeModule = device.createShaderModule({
      code: `
        struct StressBuffer { values: array<f32> };
        @group(0) @binding(0) var<storage, read_write> stress: StressBuffer;

        @compute @workgroup_size(256)
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          let index = id.x % ${WEBGPU_STORAGE_ITEMS}u;
          var value = stress.values[index] + f32(id.x) * 0.000001;
          for (var i = 0u; i < 128u; i = i + 1u) {
            value = sin(value) * cos(value + 0.001) + sqrt(abs(value) + 1.0);
          }
          stress.values[index] = fract(value);
        }
      `
    });
    const renderModule = device.createShaderModule({
      code: `
        @group(0) @binding(0) var<uniform> uTime: vec4<f32>;

        @vertex
        fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4<f32> {
          var positions = array<vec2<f32>, 3>(
            vec2<f32>(-1.0, -1.0),
            vec2<f32>(3.0, -1.0),
            vec2<f32>(-1.0, 3.0)
          );
          return vec4<f32>(positions[vertexIndex], 0.0, 1.0);
        }

        @fragment
        fn fragmentMain(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
          let time = uTime.x;
          let res = vec2<f32>(uTime.y, uTime.z);
          let uv = (position.xy - 0.5 * res) / min(res.x, res.y);

          var value = 0.0;
          for (var i = 0u; i < 96u; i = i + 1u) {
            let fi = f32(i);
            let r = length(uv) * 8.0 + fi * 0.03 - time * 0.5;
            let a = atan2(uv.y, uv.x) + fi * 0.1 + time * 0.05;
            value = value + sin(r) * cos(a + fi * 0.2) * 0.05;
          }

          let dist = length(uv);
          let intensity = smoothstep(1.2, 0.0, dist);

          let hue = value * 0.5 + time * 0.1 + dist * 0.3;
          let r = sin(hue * 6.28318 + 0.0) * 0.5 + 0.5;
          let g = sin(hue * 6.28318 + 2.09439) * 0.5 + 0.5;
          let b = sin(hue * 6.28318 + 4.18879) * 0.5 + 0.5;

          let col = vec3<f32>(r, g, b) * intensity * 0.85;
          return vec4<f32>(col, 1.0);
        }
      `
    });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 4,
          buffer: { type: 'storage' }
        }
      ]
    });
    const pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout]
    });
    const computePipeline = device.createComputePipeline({
      layout: pipelineLayout,
      compute: {
        module: computeModule,
        entryPoint: 'main'
      }
    });
    const renderPipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: renderModule,
        entryPoint: 'vertexMain'
      },
      fragment: {
        module: renderModule,
        entryPoint: 'fragmentMain',
        targets: [{ format }]
      },
      primitive: {
        topology: 'triangle-list'
      }
    });
    const storageBuffer = device.createBuffer({
      size: WEBGPU_STORAGE_ITEMS * 4,
      usage: getWebGpuUsageFlag('STORAGE') | getWebGpuUsageFlag('COPY_DST')
    });
    const computeBindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: storageBuffer }
        }
      ]
    });

    const timeBuffer = device.createBuffer({
      size: 16,
      usage: getWebGpuUsageFlag('UNIFORM') | getWebGpuUsageFlag('COPY_DST')
    });
    const renderBindGroup = device.createBindGroup({
      layout: renderPipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: { buffer: timeBuffer }
        }
      ]
    });

    const active: ActiveWebGpuStress = {
      backend: 'webgpu-compute',
      device,
      computePipeline,
      renderPipeline,
      renderBindGroup,
      storageBuffer,
      timeBuffer,
      frameId: 0,
      workloadLevel: 1,
      startedAt: 0
    };
    const timeUniform = new Float32Array(4);

    device.lost.then((info) => {
      if (this.gpu !== active) {
        return;
      }
      window.cancelAnimationFrame(active.frameId);
      active.frameId = 0;
      this.stopGpuStress({ loseContext: true });
      const reason = info.message ?? 'Unknown reason';
      this.lastError = `WebGPU device lost: ${reason}`;
      this.gpuBackend = 'none';
      if (this.mode === 'both' && this.workers.length > 0) {
        this.setState(transitionStressState(this.state, 'running'), 'GPU device was lost; CPU stress is still running.');
        this.startCpuVisuals();
      } else {
        this.stopCpuStress();
        this.stopMetricLoop();
        this.stopCpuVisuals();
        this.setState('error', this.lastError);
      }
      this.syncMetrics(true);
    }).catch((error) => {
      console.error('[StressTest] WebGPU device loss handling failed.', error);
    });

    const frame = () => {
      if (this.gpu !== active) {
        return;
      }
      active.startedAt ||= readNow();
      const encoder = device.createCommandEncoder();
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(computePipeline);
      computePass.setBindGroup(0, computeBindGroup);
      computePass.dispatchWorkgroups(4096);
      computePass.end();

      // Update time uniform
      const now = readNow() - active.startedAt;
      timeUniform[0] = now * 0.001;
      timeUniform[1] = this.canvas.width;
      timeUniform[2] = this.canvas.height;
      timeUniform[3] = 0;
      device.queue.writeBuffer(timeBuffer, 0, timeUniform);

      const renderPass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear',
            storeOp: 'store'
          }
        ]
      });
      renderPass.setPipeline(renderPipeline);
      renderPass.setBindGroup(0, renderBindGroup);
      renderPass.draw(3);
      renderPass.end();
      device.queue.submit([encoder.finish()]);
      this.gpuWorkloadLevel = active.workloadLevel;
      this.gpuCanvasActive = true;
      this.recordRenderFrame();
      active.frameId = window.requestAnimationFrame(frame);
    };

    this.gpu = active;
    active.frameId = window.requestAnimationFrame(frame);
    return active;
  }

  private startWebGlStress(backend: 'webgl2-fragment' | 'webgl1-fragment'): ActiveWebGlStress | null {
    const contextType = backend === 'webgl2-fragment' ? 'webgl2' : 'webgl';
    if (!this.canCreateContext(contextType)) {
      return null;
    }

    this.prepareGpuCanvas();
    const gl = this.getWebGlContext(backend);
    if (!gl) {
      return null;
    }

    this.syncCanvasSize();
    const isWebGl2 = backend === 'webgl2-fragment';
    const vertexShader = this.compileShader(
      gl,
      gl.VERTEX_SHADER,
      isWebGl2
        ? `#version 300 es
      in vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }`
        : `
      attribute vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }`
    );
    const fragmentShader = this.compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      isWebGl2
        ? `#version 300 es
      precision highp float;
      uniform float u_time;
      uniform vec2 u_resolution;
      uniform float u_workload;
      out vec4 out_color;
      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
        float time = u_time;

        float value = 0.0;
        for (int i = 0; i < ${WEBGL_FRAGMENT_LOOP_BOUND}; i++) {
          if (float(i) >= u_workload) {
            break;
          }
          float fi = float(i);
          float r = length(uv) * 8.0 + fi * 0.03 - time * 0.5;
          float a = atan(uv.y, uv.x) + fi * 0.1 + time * 0.05;
          value = value + sin(r) * cos(a + fi * 0.2) * 0.05;
        }

        float dist = length(uv);
        float intensity = smoothstep(1.2, 0.0, dist);

        float hue = value * 0.5 + time * 0.1 + dist * 0.3;
        float r = sin(hue * 6.28318 + 0.0) * 0.5 + 0.5;
        float g = sin(hue * 6.28318 + 2.09439) * 0.5 + 0.5;
        float b = sin(hue * 6.28318 + 4.18879) * 0.5 + 0.5;

        vec3 col = vec3(r, g, b) * intensity * 0.85;
        out_color = vec4(col, 1.0);
      }`
        : `
      precision highp float;
      uniform float u_time;
      uniform vec2 u_resolution;
      uniform float u_workload;
      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
        float time = u_time;

        float value = 0.0;
        for (int i = 0; i < ${WEBGL_FRAGMENT_LOOP_BOUND}; i++) {
          if (float(i) >= u_workload) {
            break;
          }
          float fi = float(i);
          float r = length(uv) * 8.0 + fi * 0.03 - time * 0.5;
          float a = atan(uv.y, uv.x) + fi * 0.1 + time * 0.05;
          value = value + sin(r) * cos(a + fi * 0.2) * 0.05;
        }

        float dist = length(uv);
        float intensity = smoothstep(1.2, 0.0, dist);

        float hue = value * 0.5 + time * 0.1 + dist * 0.3;
        float r = sin(hue * 6.28318 + 0.0) * 0.5 + 0.5;
        float g = sin(hue * 6.28318 + 2.09439) * 0.5 + 0.5;
        float b = sin(hue * 6.28318 + 4.18879) * 0.5 + 0.5;

        vec3 col = vec3(r, g, b) * intensity * 0.85;
        gl_FragColor = vec4(col, 1.0);
      }`
    );
    const program = gl.createProgram();
    if (!program) {
      return null;
    }
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? `${backend} stress shader failed to link.`;
      gl.deleteProgram(program);
      throw new Error(message);
    }

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      gl.deleteProgram(program);
      return null;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW
    );

    const active: ActiveWebGlStress = {
      backend,
      gl,
      program,
      positionBuffer,
      positionLocation: gl.getAttribLocation(program, 'a_position'),
      timeLocation: gl.getUniformLocation(program, 'u_time'),
      resLocation: gl.getUniformLocation(program, 'u_resolution'),
      workloadLocation: gl.getUniformLocation(program, 'u_workload'),
      frameId: 0,
      workloadLevel: 1,
      startedAt: 0,
      rampBucket: -1,
      cachedRampLevel: 1
    };

    const frame = () => {
      if (this.gpu !== active) {
        return;
      }
      const now = readNow();
      active.startedAt ||= now;
      active.workloadLevel = this.resolveWebGlWorkloadLevel(active, now);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      if (active.positionLocation >= 0) {
        gl.enableVertexAttribArray(active.positionLocation);
        gl.vertexAttribPointer(active.positionLocation, 2, gl.FLOAT, false, 0, 0);
      }
      const elapsed = now - active.startedAt;
      if (active.timeLocation) {
        gl.uniform1f(active.timeLocation, elapsed * 0.001);
      }
      if (active.resLocation) {
        gl.uniform2f(active.resLocation, this.canvas.width, this.canvas.height);
      }
      if (active.workloadLocation) {
        gl.uniform1f(active.workloadLocation, 192 * active.workloadLevel);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
      this.gpuWorkloadLevel = active.workloadLevel;
      this.gpuCanvasActive = true;
      this.recordRenderFrame();
      active.frameId = window.requestAnimationFrame(frame);
    };

    this.gpu = active;
    active.frameId = window.requestAnimationFrame(frame);
    return active;
  }

  private resolveWebGlWorkloadLevel(active: ActiveWebGlStress, now: number) {
    const elapsed = now - active.startedAt;
    const rampBucket = Math.floor(elapsed / 750);
    if (active.rampBucket !== rampBucket) {
      active.rampBucket = rampBucket;
      active.cachedRampLevel = 1 + rampBucket;
    }
    const targetRefreshRate = resolveDisplayRefreshRate();
    const framePressureLevel = this.lastFps > 0 && this.lastFps < targetRefreshRate * 0.75
      ? active.workloadLevel
      : Math.max(active.workloadLevel, active.cachedRampLevel);
    return Math.min(WEBGL_MAX_WORKLOAD_LEVEL, framePressureLevel);
  }

  private stopGpuStress({ loseContext = false }: { loseContext?: boolean } = {}) {
    if (!this.gpu) {
      return;
    }

    window.cancelAnimationFrame(this.gpu.frameId);
    if (this.gpu.backend === 'webgpu-compute') {
      this.gpu.storageBuffer.destroy?.();
      this.gpu.timeBuffer.destroy?.();
      this.gpu.device.destroy?.();
    } else {
      const gl = this.gpu.gl;
      gl.deleteProgram(this.gpu.program);
      gl.deleteBuffer(this.gpu.positionBuffer);
      if (loseContext) {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
    }
    this.gpu = null;
  }

  private compileShader(gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string) {
    if (type !== gl.VERTEX_SHADER && type !== gl.FRAGMENT_SHADER) {
      throw new Error(`Unsupported WebGL shader type: ${type}`);
    }
    const shader = gl.createShader(type);
    const backendLabel = 'texImage3D' in gl ? 'WebGL2' : 'WebGL1';
    if (!shader) {
      throw new Error(`Unable to create ${backendLabel} shader.`);
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) ?? `${backendLabel} shader failed to compile.`;
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  private startCpuVisuals() {
    if (this.cpuVisualFrameId || this.reducedMotion) {
      return;
    }

    let ctx = this.canvas.getContext('2d', { alpha: true });
    if (!ctx) {
      const parent = this.canvas.parentElement;
      if (parent) {
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
        ctx = this.canvas.getContext('2d', { alpha: true });
      }
    }
    if (!ctx) return;

    this.syncCanvasSize();
    this.canvas2dCtx = ctx;
    this.thermalNodes = [];
    for (let i = 0; i < CPU_THERMAL_NODE_COUNT; i++) {
      const column = i % 7;
      const row = Math.floor(i / 7);
      this.thermalNodes.push({
        x: (column + 0.5 + ((row % 2) * 0.28)) / 7,
        y: (row + 0.55) / 6,
        radius: 0.08 + ((i % 5) * 0.018),
        speed: 0.55 + ((i * 17) % 9) * 0.08,
        phase: i * 0.73,
        intensity: 0.42 + ((i * 11) % 8) * 0.055
      });
    }

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
    this.thermalNodes = [];
  }

  private renderCpuVisualsFrame(time: number) {
    const ctx = this.canvas2dCtx;
    const canvas = this.canvas;
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const t = time * 0.001;

    const cx = w * 0.5;
    const cy = h * 0.5;
    const minDim = Math.min(w, h);

    const workerLoad = Math.max(1, this.workers.length);
    const iterationSignal = Math.min(1, Math.log10(this.totalIterations + 10) / 8);
    const heat = 0.42 + iterationSignal * 0.5;
    const baseHue = 18 + iterationSignal * 20;

    const background = ctx.createLinearGradient(0, 0, w, h);
    background.addColorStop(0, '#050101');
    background.addColorStop(0.48, '#160603');
    background.addColorStop(1, '#030000');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const node of this.thermalNodes) {
      const pulse = 0.65 + Math.sin(t * node.speed + node.phase + iterationSignal * 8) * 0.35;
      const orbit = Math.sin(t * 0.33 + node.phase) * minDim * 0.025;
      const x = node.x * w + orbit;
      const y = node.y * h + Math.cos(t * 0.29 + node.phase) * minDim * 0.02;
      const radius = minDim * node.radius * (0.8 + pulse * 0.55);
      const alpha = node.intensity * heat * pulse;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
      glow.addColorStop(0, `hsla(${baseHue + 20}, 100%, 76%, ${alpha * 0.42})`);
      glow.addColorStop(0.35, `hsla(${baseHue}, 95%, 52%, ${alpha * 0.16})`);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.lineWidth = Math.max(1, minDim * 0.002);
    for (let lane = 0; lane < workerLoad; lane += 1) {
      const y = ((lane + 0.7) / (workerLoad + 0.4)) * h;
      const phase = (t * (0.35 + lane * 0.015) + lane * 0.19) % 1;
      const x = phase * w;
      const laneAlpha = 0.16 + 0.22 * iterationSignal;
      ctx.strokeStyle = `hsla(${baseHue + lane * 7}, 95%, 62%, ${laneAlpha})`;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let xStep = 0; xStep <= w; xStep += Math.max(24, w / 36)) {
        const wave = Math.sin(xStep * 0.015 + t * 3 + lane) * minDim * 0.018;
        ctx.lineTo(xStep, y + wave);
      }
      ctx.stroke();

      const packet = ctx.createLinearGradient(x - w * 0.12, y, x + w * 0.12, y);
      packet.addColorStop(0, 'rgba(255, 90, 36, 0)');
      packet.addColorStop(0.5, `rgba(255, 196, 104, ${0.34 + iterationSignal * 0.28})`);
      packet.addColorStop(1, 'rgba(255, 90, 36, 0)');
      ctx.fillStyle = packet;
      ctx.fillRect(x - w * 0.12, y - 2, w * 0.24, 4);
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.2 + iterationSignal * 0.16;
    ctx.strokeStyle = 'rgba(255, 120, 72, 0.42)';
    ctx.lineWidth = 1;
    const grid = Math.max(26, Math.floor(minDim / 18));
    for (let x = (t * 18) % grid; x < w; x += grid) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = (t * 11) % grid; y < h; y += grid) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.lineWidth = 1;
    for (let i = 0; i < 8; i++) {
      const radius = ((t * (36 + iterationSignal * 40) + i * 34) % (minDim * 0.5));
      const alpha = 0.12 * (1.0 - radius / (minDim * 0.5));
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.strokeStyle = `hsla(${baseHue + i * 10}, 95%, 70%, ${alpha})`;
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.fillStyle = '#000000';
    for (let y = 0; y < h; y += 4) {
      ctx.fillRect(0, y, w, 1);
    }
    ctx.restore();
  }

  private recordRenderFrame() {
    const now = readNow();
    if (this.lastFrameAt > 0) {
      const delta = now - this.lastFrameAt;
      if (delta > 34) {
        this.droppedFrames += Math.max(1, Math.floor(delta / 16.7) - 1);
      }
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
      this.lastFps = this.frameCount / Math.max(1, elapsed / 1000);
    }

    this.elapsedLabel.textContent = formatStressElapsed(elapsed);
    this.workerCountLabel.textContent = String(this.workers.length);
    this.backendLabel.textContent = this.gpuBackend;
    this.fpsLabel.textContent = (this.gpu || this.cpuVisualFrameId) ? this.lastFps.toFixed(1) : '0.0';
    this.droppedFrameLabel.textContent = String(this.droppedFrames);
    this.iterationLabel.textContent = this.totalIterations > 0 ? this.totalIterations.toLocaleString() : '0';
    this.root.dataset.stressWorkerCount = String(this.workers.length);
    this.root.dataset.stressGpuBackend = this.gpuBackend;
    this.root.dataset.stressTotalRenderedFrames = String(this.frameCount);
    this.root.dataset.stressGpuWorkloadLevel = String(this.gpuWorkloadLevel);
    this.root.dataset.stressGpuCanvasActive = (this.gpuCanvasActive || this.cpuVisualFrameId > 0) ? 'true' : 'false';
    this.root.dataset.stressCanvasActive = (this.gpuCanvasActive || this.cpuVisualFrameId > 0) ? 'true' : 'false';
    this.root.dataset.stressGpuLastError = this.lastError;
    this.root.dataset.stressIterations = String(this.totalIterations);
    this.root.dataset.stressDroppedFrames = String(this.droppedFrames);
    this.root.dataset.stressFrameRate = (this.gpu || this.cpuVisualFrameId) ? this.lastFps.toFixed(1) : '0.0';
    this.lastMetricAt = now;
    this.queueControlPanelFitSync();
  }

  private setMode(mode: StressMode) {
    this.mode = mode;
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
    this.thermalNodes = [];
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

  private requireElement<T extends HTMLElement>(id: string, constructor: new () => T) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing required element: #${id}`);
    }
    if (!(element instanceof constructor)) {
      throw new Error(`Element #${id} is not a ${constructor.name}.`);
    }
    return element;
  }
}
