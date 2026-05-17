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
  createShaderModule(descriptor: object): unknown;
  createBuffer(descriptor: object): WebGpuBufferLike;
  createBindGroupLayout(descriptor: object): unknown;
  createPipelineLayout(descriptor: object): unknown;
  createComputePipeline(descriptor: object): unknown;
  createRenderPipeline(descriptor: object): WebGpuRenderPipelineLike;
  createBindGroup(descriptor: object): unknown;
   createCommandEncoder(): WebGpuCommandEncoderLike;
   destroy?: () => void;
   lost: Promise<{ reason: 'destroyed' | 'unknown'; message: string }>;
}

interface WebGpuBufferLike {
  destroy?: () => void;
}

interface WebGpuRenderPipelineLike {
  getBindGroupLayout(index: number): unknown;
}

interface WebGpuCommandEncoderLike {
  beginComputePass(): {
    setPipeline(pipeline: unknown): void;
    setBindGroup(index: number, bindGroup: unknown): void;
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
  };
  beginRenderPass(descriptor: object): {
    setPipeline(pipeline: unknown): void;
    setBindGroup(index: number, bindGroup: unknown): void;
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
  computePipeline: unknown;
  renderPipeline: unknown;
  renderBindGroup: unknown;
  storageBuffer: WebGpuBufferLike;
  timeBuffer: WebGpuBufferLike;
  frameId: number;
  workloadLevel: number;
}

interface ActiveWebGlStress {
  backend: 'webgl2-fragment' | 'webgl1-fragment';
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  positionBuffer: WebGLBuffer;
  timeLocation: WebGLUniformLocation | null;
  resLocation: WebGLUniformLocation | null;
  workloadLocation: WebGLUniformLocation | null;
  frameId: number;
  workloadLevel: number;
  startedAt: number;
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

const DEFAULT_MODE: StressMode = 'both';
const METRIC_INTERVAL_MS = 250;
const WEBGPU_STORAGE_ITEMS = 262144;
const WEBGL_MAX_WORKLOAD_LEVEL = 6;
const WEBGL_WORKLOAD_ITERATIONS_PER_LEVEL = 64;
const WEBGL_FRAGMENT_LOOP_BOUND = WEBGL_MAX_WORKLOAD_LEVEL * WEBGL_WORKLOAD_ITERATIONS_PER_LEVEL;
const CPU_THERMAL_NODE_COUNT = 42;
const STRESS_METRIC_HIDE_ORDER: Record<StressMode, StressMetricId[]> = {
  cpu: ['dropped', 'gpu', 'fps', 'workers', 'iterations', 'elapsed'],
  gpu: ['dropped', 'iterations', 'workers', 'fps', 'gpu', 'elapsed'],
  both: ['dropped', 'iterations', 'fps', 'gpu', 'workers', 'elapsed']
};

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
  const usage = (globalThis as { GPUBufferUsage?: Record<string, number> }).GPUBufferUsage;
  return usage?.[name] ?? 0;
}

function getWebGpuTextureUsageFlag(name: string) {
  const usage = (globalThis as { GPUTextureUsage?: Record<string, number> }).GPUTextureUsage;
  return usage?.[name] ?? 0;
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
  private canvas: HTMLCanvasElement;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  private lastGpuError = '';
  private gpuCanvasActive = false;

  private cpuVisualFrameId = 0;
  private controlPanelFitFrameId = 0;
  private canvas2dCtx: CanvasRenderingContext2D | null = null;
  private thermalNodes: ThermalNode[] = [];
  private readonly cleanupCallbacks: Array<() => void> = [];
  constructor(root: HTMLElement) {
    this.root = root;
    this.modeButtons = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-stress-mode-option]'));
    this.startButton = this.requireElement('stressStartBtn');
    this.stopButton = this.requireElement('stressStopBtn');
    this.statusText = this.requireElement('stressStatusText');
    this.elapsedLabel = this.requireElement('stressElapsed');
    this.workerCountLabel = this.requireElement('stressWorkerCount');
    this.backendLabel = this.requireElement('stressGpuBackend');
    this.fpsLabel = this.requireElement('stressFrameRate');
    this.droppedFrameLabel = this.requireElement('stressDroppedFrames');
    this.iterationLabel = this.requireElement('stressIterations');
    this.metricsPanel = this.requireElement('stressMetrics');
    this.metricCards = Array.from(this.metricsPanel.querySelectorAll<HTMLElement>('[data-stress-metric]'));
    this.canvas = this.requireElement('stressCanvas');
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
      void this.start();
    });
    this.listen(this.stopButton, 'click', () => this.stop());
    this.listen(this.root, 'utility-deactivate', () => this.stop());
    this.listen(window, 'hashchange', () => {
      if (window.location.hash !== '#stress-test') {
        this.stop();
      }
    });
    this.listen(window, 'resize', () => this.queueControlPanelFitSync());
    this.listen(window, 'pagehide', () => this.stop());
    this.listen(document, 'utility-activate', (event) => {
      const stage = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-utility-id]') : null;
      if (stage?.dataset.utilityId && stage.dataset.utilityId !== 'stress-test') {
        this.stop();
      }
    });

    this.setMode(DEFAULT_MODE);
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
    this.startedAt = performance.now();
    this.gpuBackend = 'none';
    this.gpuWorkloadLevel = 0;
    this.lastGpuError = '';
    this.gpuCanvasActive = false;
    this.clearCanvasSurface();
    this.canvas.dataset.stressIdle = 'false';
    this.setState(transitionStressState(this.state, 'start'), 'Starting stress workload...');

    try {
      if (shouldStressCpu(this.mode)) {
        this.startCpuStress(requestId);
      }

      if (shouldStressGpu(this.mode)) {
        const gpu = await this.startGpuStress();
        if (requestId !== this.requestId) {
          if (gpu && this.gpu === gpu) {
            this.stopGpuStress();
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
        this.stopCpuStress(requestId);
        this.setState('unsupported', 'GPU stress needs WebGPU, WebGL2, or WebGL in this browser.');
        this.syncMetrics(true);
        return;
      }

      if (this.mode === 'both' && !this.gpu) {
        this.setState(transitionStressState(this.state, 'running'), 'CPU stress is running. GPU stress is unavailable in this browser.');
      } else {
        this.setState(transitionStressState(this.state, 'running'), 'Stress test running until you stop it or leave this utility.');
      }

      if (!this.gpu) {
        this.startCpuVisuals();
      }

      this.startMetricLoop();
    } catch (error) {
      this.stopCpuStress(requestId);
      this.stopGpuStress();
      this.gpuBackend = 'none';
      this.lastGpuError = error instanceof Error ? error.message : 'Stress test failed to start.';
      this.setState('error', error instanceof Error ? error.message : 'Stress test failed to start.');
      this.syncMetrics(true);
    }
  }

  private stop() {
    if (this.state !== 'starting' && this.state !== 'running') {
      return;
    }

    const requestId = this.requestId;
    this.requestId += 1;
    const stoppingState = transitionStressState(this.state, 'stop');
    this.setState(stoppingState, 'Stopping stress workload...');
    this.stopCpuStress(requestId);
    this.stopGpuStress();
    this.stopCpuVisuals();
    this.stopMetricLoop();
    this.totalIterations = 0;
    this.gpuBackend = 'none';
    this.gpuWorkloadLevel = 0;
    this.gpuCanvasActive = false;
    this.setState(transitionStressState(stoppingState, 'stopped'), 'Stopped. Ready to run another stress test.');
    this.syncMetrics(true);
    this.drawIdleCanvas();
  }

  private startCpuStress(requestId: number) {
    const workerCount = resolveCpuWorkerCount({
      hardwareConcurrency: navigator.hardwareConcurrency,
      maxWorkers: getStressTestMaxWorkersOverride()
    });

    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' });
      const record: StressWorkerRecord = {
        worker,
        stopped: false,
        iterations: 0
      };
      worker.addEventListener('message', (event: MessageEvent<StressTestWorkerResponse>) => {
        this.handleWorkerMessage(record, event.data);
      });
      worker.addEventListener('error', (event: ErrorEvent) => {
        this.stopCpuStress(requestId);
        this.stopGpuStress();
        this.stopMetricLoop();
        console.error('[StressTest] CPU worker error', event.message, event.filename, event.lineno);
        this.setState(
          transitionStressState(this.state, 'error'),
          event.message ? `CPU stress worker failed: ${event.message}` : 'A CPU stress worker failed.'
        );
      });
      this.workers.push(record);
      const request: StressTestWorkerRequest = {
        type: 'start-cpu-stress',
        requestId,
        workerIndex: index
      };
      worker.postMessage(request);
    }
  }

  private stopCpuStress(_requestId: number) {
    for (const record of this.workers) {
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

    record.stopped = true;
    this.stopCpuStress(message.requestId);
    if (this.mode !== 'cpu') {
      this.stopGpuStress();
    }
    if (message.type === 'cpu-stress-error' && message.message) {
      this.lastGpuError = message.message;
      this.setState(transitionStressState(this.state, 'error'), message.message);
    } else {
      const errorMsg = `Unexpected CPU worker message type: ${message.type}`;
      this.lastGpuError = errorMsg;
      this.setState(transitionStressState(this.state, 'error'), errorMsg);
    }
    this.syncMetrics(true);
  }

  private async startGpuStress() {
    const backends = resolveGpuBackendFallbacks({
      hasWebGpu: Boolean(getNavigatorGpu()),
      hasWebGl2: this.canCreateContext('webgl2'),
      hasWebGl1: this.canCreateContext('webgl') || this.canCreateContext('experimental-webgl')
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
        this.lastGpuError = error instanceof Error ? error.message : String(error);
        this.stopGpuStress();
      }
    }

    return null;
  }

  private canCreateContext(type: 'webgl2' | 'webgl' | 'experimental-webgl') {
    const canvas = document.createElement('canvas');
    try {
      return Boolean(canvas.getContext(type, {
        antialias: false,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
        preserveDrawingBuffer: true
      }));
    } catch {
      return false;
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
      return this.canvas.getContext('webgl2', options) as WebGL2RenderingContext | null;
    }

    return (this.canvas.getContext('webgl', options) ??
      this.canvas.getContext('experimental-webgl', options)) as WebGLRenderingContext | null;
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
    const context = this.canvas.getContext('webgpu') as unknown as WebGpuCanvasContextLike | null;
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
      workloadLevel: 1
    };

    device.lost.then((info) => {
      if (this.gpu !== active) {
        return;
      }
      window.cancelAnimationFrame(active.frameId);
      active.frameId = 0;
      this.stopCpuStress(this.requestId);
      this.stopGpuStress();
      this.stopMetricLoop();
      this.stopCpuVisuals();
      const reason = info.message ?? 'Unknown reason';
      this.lastGpuError = `WebGPU device lost: ${reason}`;
      this.setState('error', this.lastGpuError);
      this.syncMetrics(true);
    });

    const frame = () => {
      if (this.gpu !== active) {
        return;
      }
      this.resizeCanvas();
      const encoder = device.createCommandEncoder();
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(computePipeline);
      computePass.setBindGroup(0, computeBindGroup);
      computePass.dispatchWorkgroups(4096);
      computePass.end();

      // Update time uniform
      const now = performance.now() - this.startedAt;
      const timeArray = new Float32Array([now * 0.001, this.canvas.width, this.canvas.height, 0]);
      device.queue.writeBuffer(timeBuffer, 0, timeArray);

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
      this.recordGpuFrame();
      active.frameId = window.requestAnimationFrame(frame);
    };

    this.gpu = active;
    active.frameId = window.requestAnimationFrame(frame);
    return active;
  }

  private startWebGlStress(backend: 'webgl2-fragment' | 'webgl1-fragment'): ActiveWebGlStress | null {
    this.prepareGpuCanvas();
    const gl = this.getWebGlContext(backend);
    if (!gl) {
      return null;
    }

    this.resizeCanvas();
    const vertexShader = this.compileShader(
      gl,
      gl.VERTEX_SHADER,
      `
      attribute vec2 a_position;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
      }`
    );
    const fragmentShader = this.compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      `
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
      const loseContext = gl.getExtension('WEBGL_lose_context');
      if (loseContext) {
        loseContext.loseContext();
      }
      throw new Error(message);
    }

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      gl.deleteProgram(program);
      const loseContext = gl.getExtension('WEBGL_lose_context');
      if (loseContext) {
        loseContext.loseContext();
      }
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
      timeLocation: gl.getUniformLocation(program, 'u_time'),
      resLocation: gl.getUniformLocation(program, 'u_resolution'),
      workloadLocation: gl.getUniformLocation(program, 'u_workload'),
      frameId: 0,
      workloadLevel: 1,
      startedAt: performance.now()
    };

    const frame = () => {
      if (this.gpu !== active) {
        return;
      }
      this.resizeCanvas();
      active.workloadLevel = this.resolveWebGlWorkloadLevel(active);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      const positionLocation = gl.getAttribLocation(program, 'a_position');
      if (positionLocation >= 0) {
        gl.enableVertexAttribArray(positionLocation);
        gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
      }
      const elapsed = performance.now() - this.startedAt;
      gl.uniform1f(active.timeLocation, elapsed * 0.001);
      gl.uniform2f(active.resLocation, this.canvas.width, this.canvas.height);
      gl.uniform1f(active.workloadLocation, 192 * active.workloadLevel);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.flush();
      this.gpuWorkloadLevel = active.workloadLevel;
      this.gpuCanvasActive = true;
      this.recordGpuFrame();
      active.frameId = window.requestAnimationFrame(frame);
    };

    this.gpu = active;
    active.frameId = window.requestAnimationFrame(frame);
    return active;
  }

  private resolveWebGlWorkloadLevel(active: ActiveWebGlStress) {
    const elapsed = performance.now() - active.startedAt;
    const rampLevel = 1 + Math.floor(elapsed / 750);
    const framePressureLevel = this.lastFps > 0 && this.lastFps < 45
      ? active.workloadLevel
      : Math.max(active.workloadLevel, rampLevel);
    return Math.min(WEBGL_MAX_WORKLOAD_LEVEL, framePressureLevel);
  }

  private stopGpuStress() {
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
    }
    this.gpu = null;
  }

  private compileShader(gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string) {
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error('Unable to create WebGL2 shader.');
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) ?? 'WebGL2 shader failed to compile.';
      gl.deleteShader(shader);
      const loseContext = gl.getExtension('WEBGL_lose_context');
      if (loseContext) {
        loseContext.loseContext();
      }
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
      this.replaceCanvasElement();
      ctx = this.canvas.getContext('2d', { alpha: true });
    }
    if (!ctx) return;

    this.resizeCanvas();
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
      this.recordGpuFrame();
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

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, w, h);

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

  private recordGpuFrame() {
    const now = performance.now();
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
    const now = performance.now();
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
    this.root.dataset.stressGpuFrameCount = String(this.frameCount);
    this.root.dataset.stressTotalRenderedFrames = String(this.frameCount);
    this.root.dataset.stressGpuWorkloadLevel = String(this.gpuWorkloadLevel);
    this.root.dataset.stressGpuCanvasActive = (this.gpuCanvasActive || this.cpuVisualFrameId > 0) ? 'true' : 'false';
    this.root.dataset.stressCanvasActive = (this.gpuCanvasActive || this.cpuVisualFrameId > 0) ? 'true' : 'false';
    this.root.dataset.stressGpuLastError = this.lastGpuError;
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
    for (const metricId of STRESS_METRIC_HIDE_ORDER[this.mode]) {
      if (controlPanel.scrollHeight <= controlPanel.clientHeight + 1) {
        break;
      }
      const card = this.metricCards.find((candidate) => candidate.dataset.stressMetric === metricId);
      if (card && !card.hidden) {
        card.hidden = true;
        hiddenCount += 1;
      }
    }

    this.root.dataset.stressMetricsHidden = hiddenCount > 0 ? 'true' : 'false';
    this.root.dataset.stressMetricsHiddenCount = String(hiddenCount);
  }

  private resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 2);
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
    const scale = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(rect.width * scale));
    this.canvas.height = Math.max(1, Math.floor(rect.height * scale));
  }

  private prepareGpuCanvas() {
    this.canvas2dCtx = null;
    this.thermalNodes = [];
    this.replaceCanvasElement();
    this.resizeCanvas();
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
    this.resizeCanvas();
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private drawIdleCanvas() {
    this.resizeCanvas();
    this.clearCanvasSurface();
    this.canvas.dataset.stressIdle = 'true';
  }

  private requireElement<T extends HTMLElement>(id: string) {
    const element = document.getElementById(id);
    if (!element) {
      throw new Error(`Missing required element: #${id}`);
    }
    return element as T;
  }
}
