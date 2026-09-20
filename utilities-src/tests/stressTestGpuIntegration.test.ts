/** @vitest-environment jsdom */
/**
 * Composed lifecycle coverage: the real StressTestController driving the real
 * startAdaptiveGpuStress factory against fixture adapters. The exact coupling
 * under test is the resize/ownership race, so neither the controller's resize
 * observation nor the backend completion policy is mocked away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StressTestController } from '../src/stressTestController';

const productionHtml = readFileSync(resolve(process.cwd(), 'pages/utilities/index.html'), 'utf8');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

class MockWorker {
  static instances: MockWorker[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();

  constructor() { MockWorker.instances.push(this); }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
}

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  private disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) { ResizeObserverStub.instances.push(this); }

  observe() {}
  unobserve() {}
  disconnect() { this.disconnected = true; }

  fire() { if (!this.disconnected) this.callback([], this as unknown as ResizeObserver); }
}

function webGpuFixture() {
  const completions: ReturnType<typeof deferred<void>>[] = [];
  const lost = deferred<{ reason: string; message: string }>();
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), draw: vi.fn(), end: vi.fn() };
  const context = { configure: vi.fn(), unconfigure: vi.fn(), getCurrentTexture: () => ({ createView: vi.fn() }) };
  const buffer = { destroy: vi.fn() };
  const device = {
    limits: { maxStorageBufferBindingSize: 1024 * 1024, maxComputeWorkgroupsPerDimension: 64, maxTextureDimension2D: 8192 },
    queue: { submit: vi.fn(), writeBuffer: vi.fn(), onSubmittedWorkDone: vi.fn(() => {
      const completion = deferred<void>();
      completions.push(completion);
      return completion.promise;
    }) },
    createShaderModule: vi.fn(), createComputePipeline: () => ({ getBindGroupLayout: vi.fn() }),
    createRenderPipeline: () => ({ getBindGroupLayout: vi.fn() }), createBuffer: () => buffer,
    createBindGroup: vi.fn(), createCommandEncoder: () => ({ beginComputePass: () => pass,
      beginRenderPass: () => pass, finish: vi.fn() }),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(async () => null as { message: string } | null),
    lost: lost.promise, destroy: vi.fn()
  };
  const adapter = { info: { description: 'Integration adapter' }, requestDevice: vi.fn(async () => device) };
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
    requestAdapter: vi.fn(async () => adapter), getPreferredCanvasFormat: () => 'bgra8unorm'
  } });
  return { completions, lost, context, device, adapter };
}

function webGl2Fixture() {
  let sequence = 0;
  const completed = new Set<WebGLSync>();
  const fences: WebGLSync[] = [];
  const gl = {
    VERTEX_SHADER: 1, FRAGMENT_SHADER: 2, COMPILE_STATUS: 3, LINK_STATUS: 4,
    MAX_VIEWPORT_DIMS: 5, MAX_RENDERBUFFER_SIZE: 6, WAIT_FAILED: 7,
    TIMEOUT_EXPIRED: 8, CONDITION_SATISFIED: 9, HIGH_FLOAT: 10,
    ARRAY_BUFFER: 11, STATIC_DRAW: 12, FLOAT: 13, BLEND: 14, ONE: 15,
    COLOR_BUFFER_BIT: 16, TRIANGLES: 17, SYNC_GPU_COMMANDS_COMPLETE: 18,
    createShader: vi.fn(() => ({})), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), getShaderPrecisionFormat: () => ({ precision: 23 }),
    createProgram: vi.fn(() => ({})), attachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: () => true, createBuffer: () => ({}), bindBuffer: vi.fn(), bufferData: vi.fn(),
    getAttribLocation: () => 0, getUniformLocation: () => ({}),
    getParameter: (parameter: number) => parameter === 5 ? new Int32Array([4096, 4096]) : 4096,
    getExtension: () => null, viewport: vi.fn(), useProgram: vi.fn(), enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(), uniform2f: vi.fn(), uniform4f: vi.fn(), enable: vi.fn(), blendFunc: vi.fn(),
    clearColor: vi.fn(), clear: vi.fn(), drawArrays: vi.fn(), isContextLost: () => false,
    fenceSync: vi.fn(() => {
      const fence = { sequence: sequence++ } as WebGLSync;
      fences.push(fence);
      return fence;
    }),
    clientWaitSync: vi.fn((fence: WebGLSync): number => completed.has(fence) ? 9 : 8),
    flush: vi.fn(), finish: vi.fn(), deleteSync: vi.fn(), deleteShader: vi.fn(),
    deleteProgram: vi.fn(), deleteBuffer: vi.fn(), getProgramInfoLog: () => '', getShaderInfoLog: () => ''
  };
  return { gl, completed, fences };
}

describe('stress controller + backend composition', () => {
  let controller: StressTestController;
  let root: HTMLElement;
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  let rectState: { width: number; height: number };
  let context2d: { clearRect: () => void; fillRect: () => void; fillStyle: string };
  let gpu: ReturnType<typeof webGpuFixture> | null;
  let gl2: ReturnType<typeof webGl2Fixture> | null;

  const canvasEl = () => document.getElementById('stressCanvas') as HTMLCanvasElement;
  const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();

  function drainFrames() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(performance.now());
  }

  function setDpr(value: number) {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value });
  }

  function fireResize() {
    ResizeObserverStub.instances.forEach(observer => observer.fire());
    window.dispatchEvent(new Event('resize'));
    drainFrames();
  }

  async function settle() {
    await vi.advanceTimersByTimeAsync(200);
    drainFrames();
  }

  async function startStress(mode: 'cpu' | 'gpu' | 'both') {
    root.querySelector<HTMLButtonElement>(`[data-stress-mode-option="${mode}"]`)!.click();
    click('stressStartBtn');
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    MockWorker.instances = [];
    ResizeObserverStub.instances = [];
    frames = new Map();
    frameId = 0;
    rectState = { width: 400, height: 300 };
    gpu = null;
    gl2 = null;
    context2d = { clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: '' };

    document.body.innerHTML = new DOMParser().parseFromString(productionHtml, 'text/html')
      .getElementById('stressTestApp')!.outerHTML;
    root = document.getElementById('stressTestApp')!;
    window.history.replaceState(null, '', '#stress-test');

    setDpr(1);
    vi.stubGlobal('Worker', MockWorker);
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:module-worker-probe');
      static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
      .mockImplementation(() => ({ ...rectState }) as DOMRect);

    // Browsers bind one context type per canvas; the mock keeps that contract so
    // the controller's replace-on-mismatch path stays exercised.
    const contextTypes = new WeakMap<HTMLCanvasElement, string>();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
      const owned = contextTypes.get(this);
      if (owned && owned !== type) return null;
      let context: unknown = null;
      if (type === '2d') context = context2d;
      else if (type === 'webgpu' && gpu) context = gpu.context;
      else if (type === 'webgl2' && gl2) context = gl2.gl;
      if (context) contextTypes.set(this, type);
      return context as ReturnType<HTMLCanvasElement['getContext']>;
    } as HTMLCanvasElement['getContext']);

    controller = new StressTestController(root);
    controller.init();
    drainFrames();
  });

  afterEach(() => {
    controller?.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'gpu');
    document.body.innerHTML = '';
  });

  it('keeps the backing store frozen while a WebGPU backend drains, then resizes at DPR 2', async () => {
    gpu = webGpuFixture();
    await startStress('gpu');

    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressGpuBackend).toBe('webgpu-compute');
    expect(canvasEl().width).toBe(400);
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(2);

    rectState.width = 600;
    setDpr(2);
    fireResize();
    expect(canvasEl().width).toBe(400);

    gpu.completions[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(canvasEl().width).toBe(400);
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(2);

    gpu.completions[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(canvasEl().width).toBe(1200);
    expect(canvasEl().height).toBe(600);
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(4);

    click('stressStopBtn');
    await vi.advanceTimersByTimeAsync(0);
    expect(root.dataset.stressState).toBe('idle');

    rectState.width = 500;
    fireResize();
    expect(canvasEl().width).toBe(1000);
    expect(canvasEl().height).toBe(600);
  });

  it('releases resize ownership when stopped mid-drain and ignores late completions', async () => {
    gpu = webGpuFixture();
    await startStress('gpu');
    rectState.width = 600;
    setDpr(2);
    fireResize();
    gpu.completions[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(canvasEl().width).toBe(400);

    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    for (const completion of gpu.completions) completion.resolve();
    await vi.advanceTimersByTimeAsync(1000);
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(2);
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
    expect(gpu.context.unconfigure).toHaveBeenCalledTimes(1);

    rectState.width = 500;
    fireResize();
    expect(canvasEl().width).toBe(1000);
  });

  it('holds controller writes until WebGL2 fences retire, then applies the new density', async () => {
    Reflect.deleteProperty(navigator, 'gpu');
    gl2 = webGl2Fixture();
    await startStress('gpu');

    expect(root.dataset.stressGpuBackend).toBe('webgl2-fragment');
    expect(canvasEl().width).toBe(800);
    expect(gl2.fences).toHaveLength(2);

    rectState.width = 600;
    setDpr(2);
    fireResize();
    await vi.advanceTimersByTimeAsync(3);
    expect(canvasEl().width).toBe(800);

    gl2.completed.add(gl2.fences[0]);
    await vi.advanceTimersByTimeAsync(3);
    expect(canvasEl().width).toBe(800);

    gl2.completed.add(gl2.fences[1]);
    await vi.advanceTimersByTimeAsync(3);
    expect(canvasEl().width).toBeGreaterThanOrEqual(1200);
    expect(canvasEl().width).not.toBe(800);

    click('stressStopBtn');
    rectState.width = 400;
    fireResize();
    await vi.advanceTimersByTimeAsync(10);
    expect(canvasEl().width).toBe(800);
    expect(canvasEl().height).toBe(600);
    expect(gl2.fences).toHaveLength(4);
  });

  it('sizes the surface itself with a DPR cap of 3 when no GPU backend exists', async () => {
    Reflect.deleteProperty(navigator, 'gpu');
    await startStress('both');
    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressGpuBackend).toBe('none');

    rectState.width = 500;
    setDpr(4);
    fireResize();
    expect(canvasEl().width).toBe(1500);
    expect(canvasEl().height).toBe(900);
  });

  it('reports combined-mode CPU fallback when the WebGPU device is lost during initialization', async () => {
    gpu = webGpuFixture();
    const validation = deferred<{ message: string } | null>();
    gpu.device.popErrorScope.mockReturnValue(validation.promise);

    root.querySelector<HTMLButtonElement>('[data-stress-mode-option="both"]')!.click();
    click('stressStartBtn');
    await vi.advanceTimersByTimeAsync(0);
    gpu.lost.resolve({ reason: 'unknown', message: 'Adapter disconnected' });
    validation.resolve(null);
    await settle();

    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressGpuBackend).toBe('none');
    expect(root.dataset.stressGpuLastError).toBe('WebGPU device lost: Adapter disconnected');
    expect(document.getElementById('stressStatusText')!.textContent)
      .toBe('CPU stress is running. GPU stress failed: WebGPU device lost: Adapter disconnected');
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
    expect(MockWorker.instances.filter(worker => worker.postMessage.mock.calls.length > 0)).toHaveLength(2);

    rectState.width = 500;
    setDpr(2);
    fireResize();
    expect(canvasEl().width).toBe(1000);
  });

  it('ends GPU-only mode in an honest error when device loss precedes handle installation', async () => {
    gpu = webGpuFixture();
    const validation = deferred<{ message: string } | null>();
    gpu.device.popErrorScope.mockReturnValue(validation.promise);

    await startStress('gpu');
    gpu.lost.resolve({ reason: 'unknown', message: 'Driver crashed' });
    validation.resolve(null);
    await settle();

    expect(root.dataset.stressState).toBe('error');
    expect(root.dataset.stressGpuBackend).toBe('none');
    expect(document.getElementById('stressStatusText')!.textContent)
      .toBe('WebGPU device lost: Driver crashed');
    expect(MockWorker.instances.filter(worker => worker.postMessage.mock.calls.length > 0)).toHaveLength(0);
    expect(gpu.device.queue.submit).not.toHaveBeenCalled();

    // A restarted run claims a fresh generation and reports its own outcome.
    click('stressStartBtn');
    await settle();
    expect(root.dataset.stressState).toBe('error');
    expect(gpu.device.destroy).toHaveBeenCalledTimes(2);
  });
});
