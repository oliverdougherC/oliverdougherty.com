import { resolveGpuBackendFallbacks, type StressGpuBackend } from './stressTestCore';

interface WebGpuAdapterLike {
  limits?: {
    maxComputeWorkgroupsPerDimension?: number;
  };
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
    onSubmittedWorkDone?: () => Promise<void>;
  };
  limits?: {
    maxComputeWorkgroupsPerDimension?: number;
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

interface WebGpuRenderPipelineLike {
  getBindGroupLayout(index: number): unknown;
}

interface WebGpuBindGroupLike {}

interface WebGpuBufferLike {
  destroy?: () => void;
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

declare global {
  const GPUBufferUsage: Record<string, number> | undefined;
  const GPUTextureUsage: Record<string, number> | undefined;

  interface HTMLCanvasElement {
    getContext(contextId: 'webgpu'): WebGpuCanvasContextLike | null;
  }
}

export interface StressGpuStressHandle {
  backend: Exclude<StressGpuBackend, 'none'>;
  getWorkloadLevel(): number;
  stop(options?: { loseContext?: boolean }): void;
}

export interface StressGpuStressCallbacks {
  onFrame(): void;
  onWorkloadLevel(level: number): void;
  onCanvasActive(active: boolean): void;
  onAsyncError(message: string): void;
}

interface AdaptiveGpuWorkScalerOptions {
  initialLevel?: number;
  growAfterSamples?: number;
  aggressiveGrowthMultiplier?: number;
  steadyGrowthMultiplier?: number;
  slowBackoffMultiplier?: number;
  errorBackoffMultiplier?: number;
  fastMs?: number;
  slowMs?: number;
}

const WEBGPU_STORAGE_ITEMS = 262144;
const WEBGPU_MIN_WORKGROUPS = 256;
const WEBGPU_DEFAULT_MAX_WORKGROUPS_PER_DISPATCH = 65535;
const WEBGPU_MAX_IN_FLIGHT_SUBMISSIONS = 3;
const WEBGPU_VISUAL_INTERVAL_MS = 1000 / 30;
const WEBGPU_COMPLETION_TIMEOUT_MS = 1000;
const WEBGL_FRAGMENT_LOOP_BOUND = 512;
const WEBGL_PUMP_DELAY_MS = 0;
const WEBGL_MAX_MAIN_THREAD_BURST_MS = 14;
const WEBGL_CONTEXT_ATTRIBUTES = {
  antialias: false,
  depth: false,
  stencil: false,
  powerPreference: 'high-performance' as const,
  preserveDrawingBuffer: true
};

function readNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function getNavigatorGpu(): WebGpuLike | null {
  const gpu = (navigator as Navigator & { gpu?: WebGpuLike }).gpu;
  return gpu && typeof gpu.requestAdapter === 'function' ? gpu : null;
}

function getWebGpuUsageFlag(name: string) {
  const usage = typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage : undefined;
  return usage?.[name] ?? 0;
}

function getWebGpuTextureUsageFlag(name: string) {
  const usage = typeof GPUTextureUsage !== 'undefined' ? GPUTextureUsage : undefined;
  return usage?.[name] ?? 0;
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number) {
  let timedOut = false;
  await Promise.race([
    promise,
    delay(timeoutMs).then(() => {
      timedOut = true;
    })
  ]);
  return !timedOut;
}

function compileShader(gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string) {
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

function canCreateContext(type: 'webgl2' | 'webgl') {
  let canvas: HTMLCanvasElement | null = document.createElement('canvas');
  try {
    return Boolean(canvas.getContext(type, WEBGL_CONTEXT_ATTRIBUTES));
  } catch {
    return false;
  } finally {
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
      canvas = null;
    }
  }
}

function getWebGlContext(canvas: HTMLCanvasElement, backend: 'webgl2-fragment' | 'webgl1-fragment') {
  if (backend === 'webgl2-fragment') {
    const ctx = canvas.getContext('webgl2', WEBGL_CONTEXT_ATTRIBUTES);
    return ctx instanceof WebGL2RenderingContext ? ctx : null;
  }

  const ctx = canvas.getContext('webgl', WEBGL_CONTEXT_ATTRIBUTES);
  return ctx instanceof WebGLRenderingContext ? ctx : null;
}

function getCanvasPixelSize(canvas: HTMLCanvasElement) {
  return {
    width: Math.max(1, canvas.width),
    height: Math.max(1, canvas.height)
  };
}

function isWebGl2Context(gl: WebGLRenderingContext | WebGL2RenderingContext): gl is WebGL2RenderingContext {
  return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
}

export class AdaptiveGpuWorkScaler {
  private level: number;
  private fastSamples = 0;
  private readonly growAfterSamples: number;
  private readonly aggressiveGrowthMultiplier: number;
  private readonly steadyGrowthMultiplier: number;
  private readonly slowBackoffMultiplier: number;
  private readonly errorBackoffMultiplier: number;
  private readonly fastMs: number;
  private readonly slowMs: number;

  constructor(options: AdaptiveGpuWorkScalerOptions = {}) {
    this.level = Math.max(1, Math.floor(options.initialLevel ?? 1));
    this.growAfterSamples = Math.max(1, Math.floor(options.growAfterSamples ?? 2));
    this.aggressiveGrowthMultiplier = Math.max(1.01, options.aggressiveGrowthMultiplier ?? 2);
    this.steadyGrowthMultiplier = Math.max(1.01, options.steadyGrowthMultiplier ?? 1.18);
    this.slowBackoffMultiplier = Math.min(0.95, Math.max(0.05, options.slowBackoffMultiplier ?? 0.65));
    this.errorBackoffMultiplier = Math.min(0.95, Math.max(0.05, options.errorBackoffMultiplier ?? 0.35));
    this.fastMs = Math.max(0.1, options.fastMs ?? 6);
    this.slowMs = Math.max(this.fastMs + 0.1, options.slowMs ?? 24);
  }

  getLevel() {
    return this.level;
  }

  recordCompletion(durationMs: number) {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return this.level;
    }

    if (durationMs <= this.fastMs) {
      this.fastSamples += 1;
      if (this.fastSamples >= this.growAfterSamples) {
        this.level = Math.max(this.level + 1, Math.floor(this.level * this.aggressiveGrowthMultiplier));
        this.fastSamples = 0;
      }
      return this.level;
    }

    this.fastSamples = 0;
    if (durationMs >= this.slowMs) {
      this.level = Math.max(1, Math.floor(this.level * this.slowBackoffMultiplier));
      return this.level;
    }

    this.level = Math.max(this.level + 1, Math.floor(this.level * this.steadyGrowthMultiplier));
    return this.level;
  }

  recordBackpressure() {
    this.fastSamples = 0;
    this.level = Math.max(1, Math.floor(this.level * this.slowBackoffMultiplier));
    return this.level;
  }

  recordError() {
    this.fastSamples = 0;
    this.level = Math.max(1, Math.floor(this.level * this.errorBackoffMultiplier));
    return this.level;
  }

  reset(level = 1) {
    this.fastSamples = 0;
    this.level = Math.max(1, Math.floor(level));
  }
}

export async function startAdaptiveGpuStress(
  canvas: HTMLCanvasElement,
  callbacks: StressGpuStressCallbacks
): Promise<StressGpuStressHandle | null> {
  const backends = resolveGpuBackendFallbacks({
    hasWebGpu: Boolean(getNavigatorGpu()),
    hasWebGl2: canCreateContext('webgl2'),
    hasWebGl1: canCreateContext('webgl')
  });

  for (const backend of backends) {
    try {
      if (backend === 'webgpu-compute') {
        return await startWebGpuStress(canvas, callbacks);
      }
      if (backend === 'webgl2-fragment') {
        return startWebGlStress(canvas, callbacks, 'webgl2-fragment');
      }
      if (backend === 'webgl1-fragment') {
        return startWebGlStress(canvas, callbacks, 'webgl1-fragment');
      }
    } catch {
      callbacks.onCanvasActive(false);
    }
  }

  return null;
}

async function startWebGpuStress(
  canvas: HTMLCanvasElement,
  callbacks: StressGpuStressCallbacks
): Promise<StressGpuStressHandle> {
  const gpu = getNavigatorGpu();
  if (!gpu) {
    throw new Error('WebGPU is unavailable.');
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    throw new Error('WebGPU adapter unavailable.');
  }
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) {
    device.destroy?.();
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
        for (var i = 0u; i < 256u; i = i + 1u) {
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
        for (var i = 0u; i < 128u; i = i + 1u) {
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

        return vec4<f32>(vec3<f32>(r, g, b) * intensity * 0.85, 1.0);
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
  const maxWorkgroupsPerDispatch = Math.max(
    WEBGPU_MIN_WORKGROUPS,
    Math.floor(
      device.limits?.maxComputeWorkgroupsPerDimension ??
        adapter.limits?.maxComputeWorkgroupsPerDimension ??
        WEBGPU_DEFAULT_MAX_WORKGROUPS_PER_DISPATCH
    )
  );
  const scaler = new AdaptiveGpuWorkScaler({
    initialLevel: 1024,
    fastMs: 8,
    slowMs: 42,
    growAfterSamples: 1,
    steadyGrowthMultiplier: 1.25
  });
  const timeUniform = new Float32Array(4);
  const startedAt = readNow();
  let active = true;
  let inFlight = 0;
  let frameId = 0;
  let visualTimer = 0;

  const stop = () => {
    active = false;
    if (frameId) {
      window.cancelAnimationFrame(frameId);
      frameId = 0;
    }
    if (visualTimer) {
      window.clearTimeout(visualTimer);
      visualTimer = 0;
    }
    storageBuffer.destroy?.();
    timeBuffer.destroy?.();
    device.destroy?.();
    callbacks.onCanvasActive(false);
  };

  device.lost.then((info) => {
    if (!active) {
      return;
    }
    stop();
    callbacks.onAsyncError(`WebGPU device lost: ${info.message || info.reason || 'Unknown reason'}`);
  }).catch((error) => {
    if (!active) {
      return;
    }
    callbacks.onAsyncError(error instanceof Error ? error.message : 'WebGPU device loss handling failed.');
  });

  const submitCompute = async () => {
    if (!active || inFlight >= WEBGPU_MAX_IN_FLIGHT_SUBMISSIONS) {
      return;
    }

    inFlight += 1;
    const started = readNow();
    const workgroups = Math.max(WEBGPU_MIN_WORKGROUPS, Math.floor(scaler.getLevel()));
    const encoder = device.createCommandEncoder();
    let remaining = workgroups;
    while (remaining > 0) {
      const computePass = encoder.beginComputePass();
      computePass.setPipeline(computePipeline);
      computePass.setBindGroup(0, computeBindGroup);
      const dispatchSize = Math.max(1, Math.min(maxWorkgroupsPerDispatch, remaining));
      computePass.dispatchWorkgroups(dispatchSize);
      computePass.end();
      remaining -= dispatchSize;
    }
    device.queue.submit([encoder.finish()]);

    try {
      if (device.queue.onSubmittedWorkDone) {
        const completed = await waitWithTimeout(device.queue.onSubmittedWorkDone(), WEBGPU_COMPLETION_TIMEOUT_MS);
        if (!completed) {
          callbacks.onWorkloadLevel(scaler.recordBackpressure());
          return;
        }
      } else {
        await delay(16);
      }
      callbacks.onWorkloadLevel(scaler.recordCompletion(readNow() - started));
    } catch {
      callbacks.onWorkloadLevel(scaler.recordError());
    } finally {
      inFlight -= 1;
      while (active && inFlight < WEBGPU_MAX_IN_FLIGHT_SUBMISSIONS) {
        void submitCompute();
      }
    }
  };

  const drawVisual = () => {
    if (!active) {
      return;
    }
    const now = readNow();
    const elapsed = now - startedAt;
    const { width, height } = getCanvasPixelSize(canvas);
    timeUniform[0] = elapsed * 0.001;
    timeUniform[1] = width;
    timeUniform[2] = height;
    timeUniform[3] = scaler.getLevel();
    device.queue.writeBuffer(timeBuffer, 0, timeUniform);

    try {
      const encoder = device.createCommandEncoder();
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
      callbacks.onCanvasActive(true);
      callbacks.onFrame();
    } catch (error) {
      callbacks.onWorkloadLevel(scaler.recordError());
      callbacks.onAsyncError(error instanceof Error ? error.message : 'WebGPU render pass failed.');
      return;
    }

    visualTimer = window.setTimeout(() => {
      frameId = window.requestAnimationFrame(drawVisual);
    }, WEBGPU_VISUAL_INTERVAL_MS);
  };

  while (inFlight < WEBGPU_MAX_IN_FLIGHT_SUBMISSIONS) {
    void submitCompute();
  }
  frameId = window.requestAnimationFrame(drawVisual);
  callbacks.onWorkloadLevel(scaler.getLevel());
  callbacks.onCanvasActive(true);

  return {
    backend: 'webgpu-compute',
    getWorkloadLevel: () => scaler.getLevel(),
    stop
  };
}

function startWebGlStress(
  canvas: HTMLCanvasElement,
  callbacks: StressGpuStressCallbacks,
  backend: 'webgl2-fragment' | 'webgl1-fragment'
): StressGpuStressHandle | null {
  if (!canCreateContext(backend === 'webgl2-fragment' ? 'webgl2' : 'webgl')) {
    return null;
  }

  const gl = getWebGlContext(canvas, backend);
  if (!gl) {
    return null;
  }

  const isWebGl2 = backend === 'webgl2-fragment';
  const vertexShader = compileShader(
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
  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    isWebGl2
      ? `#version 300 es
      precision highp float;
      uniform float u_time;
      uniform vec2 u_resolution;
      out vec4 out_color;
      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
        float time = u_time;
        float value = 0.0;
        for (int i = 0; i < ${WEBGL_FRAGMENT_LOOP_BOUND}; i++) {
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
        out_color = vec4(vec3(r, g, b) * intensity * 0.85, 1.0);
      }`
      : `
      precision highp float;
      uniform float u_time;
      uniform vec2 u_resolution;
      void main() {
        vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy) / min(u_resolution.x, u_resolution.y);
        float time = u_time;
        float value = 0.0;
        for (int i = 0; i < ${WEBGL_FRAGMENT_LOOP_BOUND}; i++) {
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
        gl_FragColor = vec4(vec3(r, g, b) * intensity * 0.85, 1.0);
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

  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const timeLocation = gl.getUniformLocation(program, 'u_time');
  const resLocation = gl.getUniformLocation(program, 'u_resolution');
  const scaler = new AdaptiveGpuWorkScaler({
    initialLevel: 1,
    fastMs: 4,
    slowMs: 22,
    growAfterSamples: 1,
    aggressiveGrowthMultiplier: 2.25,
    steadyGrowthMultiplier: 1.35
  });
  const startedAt = readNow();
  let active = true;
  let timer = 0;
  let pendingSync: WebGLSync | null = null;

  const stop = ({ loseContext = false }: { loseContext?: boolean } = {}) => {
    active = false;
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    if (pendingSync && isWebGl2Context(gl)) {
      gl.deleteSync(pendingSync);
      pendingSync = null;
    }
    gl.deleteProgram(program);
    gl.deleteBuffer(positionBuffer);
    if (loseContext) {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    callbacks.onCanvasActive(false);
  };

  const drawOnce = (now: number) => {
    const { width, height } = getCanvasPixelSize(canvas);
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    if (positionLocation >= 0) {
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);
    }
    if (timeLocation) {
      gl.uniform1f(timeLocation, (now - startedAt) * 0.001);
    }
    if (resLocation) {
      gl.uniform2f(resLocation, width, height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const schedulePump = () => {
    if (!active || timer) {
      return;
    }
    timer = window.setTimeout(pump, WEBGL_PUMP_DELAY_MS);
  };

  const pump = () => {
    timer = 0;
    if (!active) {
      return;
    }

    if (pendingSync && isWebGl2Context(gl)) {
      const status = gl.clientWaitSync(pendingSync, 0, 0);
      if (status === gl.TIMEOUT_EXPIRED) {
        callbacks.onWorkloadLevel(scaler.recordBackpressure());
        schedulePump();
        return;
      }
      gl.deleteSync(pendingSync);
      pendingSync = null;
    }

    const pumpStarted = readNow();
    const requestedDraws = Math.max(1, Math.floor(scaler.getLevel()));
    let submittedDraws = 0;
    try {
      for (let index = 0; index < requestedDraws; index += 1) {
        drawOnce(readNow());
        submittedDraws += 1;
        if (readNow() - pumpStarted > WEBGL_MAX_MAIN_THREAD_BURST_MS) {
          break;
        }
      }
      gl.flush();
      const glError = gl.getError();
      if (glError !== gl.NO_ERROR) {
        callbacks.onWorkloadLevel(scaler.recordError());
      } else {
        callbacks.onWorkloadLevel(scaler.recordCompletion(readNow() - pumpStarted));
      }
      if (isWebGl2Context(gl)) {
        pendingSync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      }
    } catch (error) {
      callbacks.onWorkloadLevel(scaler.recordError());
      callbacks.onAsyncError(error instanceof Error ? error.message : `${backend} stress draw failed.`);
      return;
    }

    if (submittedDraws > 0) {
      callbacks.onCanvasActive(true);
      callbacks.onFrame();
    }
    schedulePump();
  };

  callbacks.onWorkloadLevel(scaler.getLevel());
  callbacks.onCanvasActive(true);
  schedulePump();

  return {
    backend,
    getWorkloadLevel: () => scaler.getLevel(),
    stop
  };
}
