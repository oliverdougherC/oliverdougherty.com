import { type StressGpuBackend } from './stressTestCore';
import { gpuComputeWgsl, gpuSceneGlsl, gpuSceneWgsl } from './stressTestGpuShaders';

interface GpuLimits {
  maxComputeWorkgroupsPerDimension?: number;
  maxStorageBufferBindingSize?: number;
  maxBufferSize?: number;
  maxTextureDimension2D?: number;
}
interface GpuBuffer { destroy(): void }
interface GpuPipeline { getBindGroupLayout(index: number): unknown }
interface GpuPass {
  setPipeline(pipeline: GpuPipeline): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  dispatchWorkgroups(count: number): void;
  draw(count: number): void;
  end(): void;
}
interface GpuDevice {
  limits: GpuLimits;
  queue: {
    submit(commands: unknown[]): void;
    writeBuffer(buffer: GpuBuffer, offset: number, data: Float32Array): void;
    onSubmittedWorkDone(): Promise<void>;
  };
  createShaderModule(options: object): unknown;
  createComputePipeline(options: object): GpuPipeline;
  createRenderPipeline(options: object): GpuPipeline;
  createBuffer(options: object): GpuBuffer;
  createBindGroup(options: object): unknown;
  createCommandEncoder(): {
    beginComputePass(): GpuPass;
    beginRenderPass(options: object): GpuPass;
    finish(): unknown;
  };
  pushErrorScope(filter: string): void;
  popErrorScope(): Promise<{ message: string } | null>;
  lost: Promise<{ reason: string; message: string }>;
  destroy(): void;
}
interface GpuContext {
  configure(options: object): void;
  unconfigure(): void;
  getCurrentTexture(): { createView(): unknown };
}
interface NavigatorGpu {
  requestAdapter(options: object): Promise<{
    info?: { description?: string; vendor?: string; architecture?: string; device?: string };
    requestDevice(): Promise<GpuDevice>;
  } | null>;
  getPreferredCanvasFormat(): string;
}

export interface StressGpuStressHandle {
  backend: Exclude<StressGpuBackend, 'none'>;
  getWorkloadLevel(): number;
  getDiagnostics?(): { adapter: string; detail: string };
  setReducedMotion?(value: boolean): void;
  setPointer?(x: number, y: number): void;
  stop(options?: { loseContext?: boolean }): void;
}
export interface StressGpuStressCallbacks {
  onFrame(): void;
  onWorkloadLevel(level: number): void;
  onCanvasActive(active: boolean): void;
  onAsyncError(message: string): void;
  onCanvasReplace?(canvas: HTMLCanvasElement): void;
}
export interface StressGpuStressOptions {
  reducedMotion?: boolean;
  signal?: AbortSignal;
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

const WORKGROUP_SIZE = 64;
const STORAGE_BUDGET = 16 * 1024 * 1024;
const MAX_COMPUTE_PASSES = 8;
const GL_ATTRIBUTES: WebGLContextAttributes = {
  antialias: false, depth: false, stencil: false,
  powerPreference: 'high-performance', preserveDrawingBuffer: false
};
const readNow = () => performance.now();
const getNavigatorGpu = () => (navigator as Navigator & { gpu?: NavigatorGpu }).gpu;

// Level is measured in workgroups at 64 iterations each. Increase independent
// invocations first, then iterations and sequential passes within bounded memory.
export function resolveGpuComputeWorkload(level: number, limits: GpuLimits = {}) {
  const bytes = Math.min(STORAGE_BUDGET, limits.maxStorageBufferBindingSize ?? STORAGE_BUDGET,
    limits.maxBufferSize ?? STORAGE_BUDGET);
  const groupLimit = limits.maxComputeWorkgroupsPerDimension ?? 65535;
  if (!Number.isFinite(bytes) || bytes < 16 * WORKGROUP_SIZE ||
      !Number.isFinite(groupLimit) || groupLimit < 1) {
    throw new Error('GPU limits cannot support a compute workgroup.');
  }
  const capacity = Math.floor(bytes / (16 * WORKGROUP_SIZE));
  const maxGroups = Math.min(capacity, Math.floor(groupLimit));
  const requested = Math.max(1, Number.isFinite(level) ? Math.floor(level) : 1);
  const groups = Math.max(1, Math.min(maxGroups, requested));
  const iterations = Math.max(64, Math.min(1024, Math.ceil(requested / groups) * 64));
  const passes = Math.max(1, Math.min(MAX_COMPUTE_PASSES, Math.ceil(requested / (groups * iterations / 64))));
  return { groups, iterations, passes, storageBytes: capacity * WORKGROUP_SIZE * 16,
    effectiveLevel: groups * iterations / 64 * passes };
}

function drawingSize(canvas: HTMLCanvasElement, scale: number, maxDimension: number, maxPixels: number, apply = true) {
  const rect = canvas.getBoundingClientRect();
  const density = Math.min(window.devicePixelRatio || 1, 2);
  let width = Math.max(1, Math.floor((rect.width || 640) * density * scale));
  let height = Math.max(1, Math.floor((rect.height || 360) * density * scale));
  const reduction = Math.min(1, maxDimension / width, maxDimension / height, Math.sqrt(maxPixels / (width * height)));
  width = Math.max(1, Math.floor(width * reduction));
  height = Math.max(1, Math.floor(height * reduction));
  if (apply && (canvas.width !== width || canvas.height !== height)) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}

function compileShader(gl: WebGLRenderingContext | WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Unable to allocate shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || 'GPU shader failed to compile.';
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
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
  callbacks: StressGpuStressCallbacks,
  options: StressGpuStressOptions = {}
): Promise<StressGpuStressHandle | null> {
  const backends = getNavigatorGpu()
    ? ['webgpu-compute', 'webgl2-fragment', 'webgl1-fragment'] as const
    : ['webgl2-fragment', 'webgl1-fragment'] as const;
  let target = canvas;
  // Device loss can resolve while startup is still awaiting an adapter, device,
  // or pipeline validation. A failure that arrives before the caller receives a
  // handle invalidates the whole startup: the failed handle is released and the
  // factory resolves null instead of installing dead work.
  let installed = false;
  let failedDuringStartup = false;
  const startupCallbacks: StressGpuStressCallbacks = Object.assign({}, callbacks, {
    onAsyncError: (message: string) => {
      if (installed) {
        callbacks.onAsyncError(message);
        return;
      }
      failedDuringStartup = true;
      callbacks.onAsyncError(message);
    }
  });
  for (let index = 0; index < backends.length; index++) {
    if (options.signal?.aborted || failedDuringStartup) return null;
    // A canvas cannot change context type, including after a failed pipeline.
    if (index > 0) {
      const replacement = target.cloneNode(false) as HTMLCanvasElement;
      target.replaceWith(replacement);
      target = replacement;
      callbacks.onCanvasReplace?.(replacement);
    }
    try {
      const backend = backends[index];
      const handle = backend === 'webgpu-compute'
        ? await startWebGpuStress(target, startupCallbacks, options)
        : startWebGlStress(target, startupCallbacks, backend, options);
      if (failedDuringStartup) {
        handle.stop({ loseContext: true });
        return null;
      }
      if (options.signal?.aborted) { handle.stop(); return null; }
      const stop = handle.stop;
      const abort = () => handle.stop();
      options.signal?.addEventListener('abort', abort, { once: true });
      handle.stop = stopOptions => {
        options.signal?.removeEventListener('abort', abort);
        stop(stopOptions);
      };
      installed = true;
      return handle;
    } catch {
      callbacks.onCanvasActive(false);
    }
  }
  return null;
}

async function startWebGpuStress(canvas: HTMLCanvasElement, callbacks: StressGpuStressCallbacks,
  options: StressGpuStressOptions): Promise<StressGpuStressHandle> {
  const gpu = getNavigatorGpu();
  const adapter = await gpu?.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter || !gpu) throw new Error('WebGPU adapter unavailable.');
  const device = await adapter.requestDevice();
  let context: GpuContext | null = null;
  let storage: GpuBuffer | undefined;
  let uniforms: GpuBuffer | undefined;
  let timer = 0;
  let stallTimer = 0;
  let active = true;
  let reducedMotion = Boolean(options.reducedMotion);
  let pointerX = 0;
  let pointerY = 0;
  let detail = 'Preparing compute + ray tracing';
  const stop = () => {
    if (!active) return;
    active = false;
    window.clearTimeout(timer);
    window.clearTimeout(stallTimer);
    context?.unconfigure();
    storage?.destroy();
    uniforms?.destroy();
    device.destroy();
    callbacks.onCanvasActive(false);
  };
  try {
    if (options.signal?.aborted) throw new Error('GPU startup cancelled.');
    if (!device.queue.onSubmittedWorkDone) throw new Error('WebGPU completion tracking unavailable.');
    context = (canvas as unknown as { getContext(type: 'webgpu'): GpuContext | null }).getContext('webgpu');
    if (!context) throw new Error('WebGPU canvas unavailable.');
    const format = gpu.getPreferredCanvasFormat();
    context.configure({ device, format, alphaMode: 'opaque' });
    device.pushErrorScope('validation');
    const compute = device.createComputePipeline({ layout: 'auto',
      compute: { module: device.createShaderModule({ code: gpuComputeWgsl }), entryPoint: 'main' } });
    const renderModule = device.createShaderModule({ code: gpuSceneWgsl });
    const render = device.createRenderPipeline({ layout: 'auto',
      vertex: { module: renderModule, entryPoint: 'vertexMain' },
      fragment: { module: renderModule, entryPoint: 'fragmentMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' } });
    const capacity = resolveGpuComputeWorkload(1, device.limits);
    // WebGPU's standard flag values: STORAGE=128, UNIFORM=64, COPY_DST=8.
    storage = device.createBuffer({ size: capacity.storageBytes, usage: 128 });
    uniforms = device.createBuffer({ size: 32, usage: 64 | 8 });
    const computeBindings = device.createBindGroup({ layout: compute.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: storage } }, { binding: 1, resource: { buffer: uniforms } }
    ] });
    const renderBindings = device.createBindGroup({ layout: render.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniforms } }
    ] });
    const validationError = await device.popErrorScope();
    if (validationError) throw new Error(validationError.message);
    if (options.signal?.aborted) throw new Error('GPU startup cancelled.');
    const scaler = new AdaptiveGpuWorkScaler({ initialLevel: 1024, growAfterSamples: 1,
      fastMs: 8, slowMs: 24, aggressiveGrowthMultiplier: 2, steadyGrowthMultiplier: 1.12,
      slowBackoffMultiplier: 0.65 });
    const started = readNow();
    const data = new Float32Array(8);
    let renderScale = 1;
    const fail = (error: unknown) => {
      if (!active) return;
      stop();
      callbacks.onAsyncError(error instanceof Error ? error.message : 'GPU workload failed.');
    };
    void device.lost.then(info => {
      if (active) fail(new Error(`WebGPU device lost: ${info.message || info.reason}`));
    }).catch(fail);
    let inFlight = 0;
    const maximum = resolveGpuComputeWorkload(Number.MAX_SAFE_INTEGER, device.limits).effectiveLevel;
    const armWatchdog = () => {
      window.clearTimeout(stallTimer);
      stallTimer = window.setTimeout(() => fail(new Error('GPU stopped responding.')), 10000);
    };
    const fillQueue = () => {
      timer = 0;
      if (!active) return;
      try {
        // Retire old canvas work before replacing its drawing buffer. Once the
        // queue drains, submit both new batches with the same dimensions.
        const size = drawingSize(canvas, renderScale, device.limits.maxTextureDimension2D ?? 8192, 2400000, false);
        if (canvas.width !== size.width || canvas.height !== size.height) {
          if (inFlight) return;
          canvas.width = size.width;
          canvas.height = size.height;
        }
        while (active && inFlight < 2) {
          const began = readNow();
          const workload = resolveGpuComputeWorkload(scaler.getLevel(), device.limits);
          data.set([reducedMotion ? 0 : (began - started) / 1000, size.width, size.height, 0,
            pointerX, pointerY, workload.iterations, 0]);
          // writeBuffer and submit are ordered on the same queue: each batch
          // sees its own uniforms even though the next batch reuses the buffer.
          device.queue.writeBuffer(uniforms!, 0, data);
          const encoder = device.createCommandEncoder();
          const visual = encoder.beginRenderPass({ colorAttachments: [{
            view: context!.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',
            clearValue: { r: 0.969, g: 0.969, b: 0.961, a: 1 }
          }] });
          visual.setPipeline(render);
          visual.setBindGroup(0, renderBindings);
          visual.draw(3);
          visual.end();
          // Separate passes provide storage barriers; every invocation writes
          // its own vec4 and feeds the next batch's state.
          for (let index = 0; index < workload.passes; index++) {
            const pass = encoder.beginComputePass();
            pass.setPipeline(compute);
            pass.setBindGroup(0, computeBindings);
            pass.dispatchWorkgroups(workload.groups);
            pass.end();
          }
          device.queue.submit([encoder.finish()]);
          const queueDepth = ++inFlight;
          if (queueDepth === 1) armWatchdog();
          // Snapshot completion before submitting the next batch. Keeping two
          // bounded batches queued covers host wake-up latency without a RAF
          // or timer gap between submissions, or an unbounded command backlog.
          void device.queue.onSubmittedWorkDone().then(() => {
            if (!active) return;
            inFlight--;
            const elapsed = (readNow() - began) / queueDepth;
            if (scaler.getLevel() === 1 && elapsed > 24) {
              renderScale = Math.max(0.125, renderScale * 0.8);
            } else if (renderScale < 1 && elapsed < 8) {
              renderScale = Math.min(1, renderScale * 1.1);
            }
            // Completion latency includes queue/host overhead; this tunes batch
            // responsiveness, and is deliberately not presented as GPU usage.
            const level = scaler.recordCompletion(elapsed);
            if (level > maximum) scaler.reset(maximum);
            detail = `${(workload.groups * WORKGROUP_SIZE).toLocaleString()} lanes · ${workload.iterations} iterations · ${workload.passes} ${workload.passes === 1 ? 'pass' : 'passes'}`;
            armWatchdog();
            fillQueue();
            if (!active) return;
            callbacks.onWorkloadLevel(scaler.getLevel());
            callbacks.onCanvasActive(true);
            callbacks.onFrame();
          }).catch(fail);
        }
      } catch (error) { fail(error); }
    };
    timer = window.setTimeout(fillQueue, 0);
    callbacks.onWorkloadLevel(scaler.getLevel());
    const info = adapter.info;
    const adapterName = info?.description || [info?.vendor, info?.architecture].filter(Boolean).join(' ') || 'WebGPU adapter';
    return {
      backend: 'webgpu-compute', getWorkloadLevel: () => scaler.getLevel(),
      getDiagnostics: () => ({ adapter: adapterName, detail }),
      setReducedMotion: value => { reducedMotion = value; },
      setPointer: (x, y) => { pointerX = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
        pointerY = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0; },
      stop
    };
  } catch (error) { stop(); throw error; }
}

function startWebGlStress(canvas: HTMLCanvasElement, callbacks: StressGpuStressCallbacks,
  backend: 'webgl2-fragment' | 'webgl1-fragment', options: StressGpuStressOptions): StressGpuStressHandle {
  const webgl2 = backend === 'webgl2-fragment';
  const gl = canvas.getContext(webgl2 ? 'webgl2' : 'webgl', GL_ATTRIBUTES) as WebGLRenderingContext | WebGL2RenderingContext | null;
  if (!gl) throw new Error('WebGL unavailable.');
  const gl2 = webgl2 ? gl as WebGL2RenderingContext : null;
  let vertex: WebGLShader | null = null;
  let fragment: WebGLShader | null = null;
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  const pending: { fence: WebGLSync; began: number; depth: number }[] = [];
  let timer = 0;
  let active = true;
  let reducedMotion = Boolean(options.reducedMotion);
  let pointerX = 0;
  let pointerY = 0;
  let detail = 'Preparing ray tracing';
  const stop = ({ loseContext = false }: { loseContext?: boolean } = {}) => {
    if (!active) return;
    active = false;
    window.clearTimeout(timer);
    canvas.removeEventListener('webglcontextlost', lost);
    for (const batch of pending) gl2?.deleteSync(batch.fence);
    pending.length = 0;
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    if (loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
    callbacks.onCanvasActive(false);
  };
  const fail = (error: unknown) => {
    if (!active) return;
    stop();
    callbacks.onAsyncError(error instanceof Error ? error.message : 'WebGL workload failed.');
  };
  function lost(event: Event) {
    event.preventDefault();
    fail(new Error('WebGL context lost. Restart the test to reconnect.'));
  }
  canvas.addEventListener('webglcontextlost', lost);
  try {
    vertex = compileShader(gl, gl.VERTEX_SHADER, `${webgl2 ? '#version 300 es' : ''}
      ${webgl2 ? 'in' : 'attribute'} vec2 a_position;
      void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`);
    const highp = Boolean(gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)?.precision);
    fragment = compileShader(gl, gl.FRAGMENT_SHADER, gpuSceneGlsl(webgl2, highp));
    program = gl.createProgram();
    if (!program) throw new Error('Unable to allocate GPU program.');
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'GPU program failed to link.');
    buffer = gl.createBuffer();
    if (!buffer) throw new Error('Unable to allocate GPU geometry.');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_position');
    const scene = gl.getUniformLocation(program, 'u_scene');
    const pointer = gl.getUniformLocation(program, 'u_pointer');
    const sample = gl.getUniformLocation(program, 'u_sample');
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    const deviceMaxDimension = Math.max(1, Math.min(viewport[0], viewport[1], gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number));
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const adapterName = (debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) as string : '') || (webgl2 ? 'WebGL 2 adapter' : 'WebGL 1 adapter');
    // A software GL device shares CPU/compositor resources with the UI. Large
    // supersampled batches can otherwise block Stop and even browser capture.
    // Keep real shader work sustained but bounded; hardware keeps full scaling.
    const software = /swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render/i.test(adapterName);
    const maxDimension = Math.min(deviceMaxDimension, software ? 512 : deviceMaxDimension);
    const maxBackingPixels = software ? 512 * 512 : webgl2 ? 16000000 : 4000000;
    const maxWorkloadLevel = software ? 1 : 128;
    const scaler = new AdaptiveGpuWorkScaler({ initialLevel: webgl2 && !software ? 4 : 1, growAfterSamples: 1,
      fastMs: 8, slowMs: 24, aggressiveGrowthMultiplier: 2, steadyGrowthMultiplier: 1.1 });
    const started = readNow();
    let baseScale = 1;
    const completed = (elapsed: number) => {
      if (!active) return;
      if (scaler.getLevel() === 1 && elapsed > 24) {
        baseScale = Math.max(0.125, baseScale * 0.8);
      } else if (baseScale < 1 && elapsed < 8) {
        baseScale = Math.min(1, baseScale * 1.1);
      }
      const level = scaler.recordCompletion(elapsed);
      // Supersampling and repeated geometry/lighting passes are bounded by
      // viewport/memory limits and eight passes per batch.
      if (level > maxWorkloadLevel) scaler.reset(maxWorkloadLevel);
      callbacks.onWorkloadLevel(scaler.getLevel());
      callbacks.onCanvasActive(true);
      callbacks.onFrame();
    };
    const draw = () => {
      const batchStart = readNow();
      const level = scaler.getLevel();
      const scale = baseScale * Math.min(4, Math.sqrt(level));
      const passes = Math.min(8, Math.ceil(level / 16));
      const size = drawingSize(canvas, scale, maxDimension, maxBackingPixels, false);
      // Resizing invalidates the drawing buffer; let existing fenced batches
      // finish first. Never block JavaScript waiting on a WebGL 2 fence.
      if (canvas.width !== size.width || canvas.height !== size.height) {
        if (pending.length) return false;
        canvas.width = size.width;
        canvas.height = size.height;
      }
      const { width, height } = size;
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform2f(pointer, pointerX, pointerY);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      for (let index = 0; index < passes; index++) {
        gl.uniform2f(sample, index, passes);
        gl.uniform4f(scene, reducedMotion ? 0 : (batchStart - started) / 1000 + index * 0.00001, width, height, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      detail = `${width.toLocaleString()} × ${height.toLocaleString()} · ${passes} ${passes === 1 ? 'pass' : 'passes'} · 150 ray steps`;
      if (gl.isContextLost()) throw new Error('WebGL context lost.');
      if (gl2) {
        const fence = gl2.fenceSync(gl2.SYNC_GPU_COMMANDS_COMPLETE, 0);
        if (!fence) throw new Error('Unable to track GPU completion.');
        pending.push({ fence, began: batchStart, depth: pending.length + 1 });
        gl.flush();
      } else {
        // WebGL 1 has no asynchronous completion fence. finish measures actual
        // completed work and bounds the queue; task yields keep Stop responsive.
        gl.finish();
        completed(readNow() - batchStart);
      }
      return true;
    };
    const pump = () => {
      timer = 0;
      if (!active) return;
      try {
        if (gl2) {
          // Check only previously submitted work. Newly created fences need an
          // event-loop turn before clientWaitSync can observe their completion.
          while (active && pending.length) {
            const batch = pending[0];
            const status = gl2.clientWaitSync(batch.fence, 0, 0);
            if (status === gl2.WAIT_FAILED) throw new Error('GPU completion tracking failed.');
            if (status === gl2.TIMEOUT_EXPIRED) {
              if (readNow() - batch.began > 10000) throw new Error('GPU stopped responding.');
              break;
            }
            pending.shift();
            gl2.deleteSync(batch.fence);
            completed((readNow() - batch.began) / batch.depth);
          }
          while (active && pending.length < 2 && draw()) { /* bounded queue refill */ }
          if (active) timer = window.setTimeout(pump, software ? 16 : 1);
        } else {
          draw();
          // A self-posting MessageChannel can starve compositor/input work,
          // particularly with synchronous software GL. Timers give it a turn.
          if (active) timer = window.setTimeout(pump, software ? 16 : 0);
        }
      } catch (error) { fail(error); }
    };
    callbacks.onWorkloadLevel(scaler.getLevel());
    timer = window.setTimeout(pump, 0);
    return {
      backend, getWorkloadLevel: () => scaler.getLevel(),
      getDiagnostics: () => ({ adapter: adapterName, detail }),
      setReducedMotion: value => { reducedMotion = value; },
      setPointer: (x, y) => { pointerX = Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
        pointerY = Number.isFinite(y) ? Math.max(-1, Math.min(1, y)) : 0; },
      stop
    };
  } catch (error) { stop({ loseContext: true }); throw error; }
}
