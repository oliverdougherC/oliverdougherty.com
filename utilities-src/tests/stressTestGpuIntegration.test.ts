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
  const gpuInterface = {
    requestAdapter: vi.fn(async () => adapter), getPreferredCanvasFormat: () => 'bgra8unorm'
  };
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: gpuInterface });
  return { completions, lost, context, device, adapter, gpuInterface };
}

function webGl2Fixture(renderer = 'Fixture hardware') {
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
    getParameter: (parameter: number) => parameter === 5 ? new Int32Array([4096, 4096]) : parameter === 99 ? renderer : 4096,
    getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 99 } : null, viewport: vi.fn(), useProgram: vi.fn(), enableVertexAttribArray: vi.fn(),
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

let controller: StressTestController;
let root: HTMLElement;
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let rectState: { width: number; height: number };
let context2d: { clearRect: () => void; fillRect: () => void; fillStyle: string };
let gpu: ReturnType<typeof webGpuFixture> | null;
let gl2: ReturnType<typeof webGl2Fixture> | null;
let contextRequests: { canvas: HTMLCanvasElement; type: string }[];
let motionQuery: EventTarget & { matches: boolean };

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

// Shared jsdom harness: production markup, controllable animation frames, and a
// one-context-type-per-canvas mock that records which canvas each request
// touched. installHarness() leaves every animation frame queued by init()
// pending; each describe chooses whether to drain them immediately or race them
// against later lifecycle transitions.
function installHarness() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
  MockWorker.instances = [];
  ResizeObserverStub.instances = [];
  frames = new Map();
  frameId = 0;
  rectState = { width: 400, height: 300 };
  gpu = null;
  gl2 = null;
  contextRequests = [];
  motionQuery = Object.assign(new EventTarget(), { matches: false });
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
  vi.stubGlobal('matchMedia', () => motionQuery);
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => ({ ...rectState }) as DOMRect);

  // Browsers bind one context type per canvas; the mock keeps that contract so
  // the controller's replace-on-mismatch path stays exercised. Every request
  // is recorded so ownership tests can name the exact canvas a context touched.
  const contextTypes = new WeakMap<HTMLCanvasElement, string>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string) {
    contextRequests.push({ canvas: this, type });
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
}

function disposeHarness() {
  controller?.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'gpu');
  document.body.innerHTML = '';
}

describe('stress controller + backend composition', () => {
  beforeEach(() => {
    installHarness();
    drainFrames();
  });

  afterEach(disposeHarness);

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

  it('bounds software rendering so real GL work leaves the browser compositor responsive', async () => {
    Reflect.deleteProperty(navigator, 'gpu');
    gl2 = webGl2Fixture('ANGLE (Google, SwiftShader Device)');
    rectState = { width: 1600, height: 900 };
    setDpr(3);
    await startStress('gpu');
    expect(root.dataset.stressGpuBackend).toBe('webgl2-fragment');
    expect(canvasEl().width).toBeLessThanOrEqual(512);
    expect(canvasEl().height).toBeLessThanOrEqual(512);
    for (let i = 0; i < 5; i++) {
      gl2.fences.forEach(fence => gl2!.completed.add(fence));
      await vi.advanceTimersByTimeAsync(5);
    }
    drainFrames();
    expect(canvasEl().width * canvasEl().height).toBeLessThanOrEqual(512 * 512);
    expect(root.dataset.stressGpuWorkloadLevel).toBe('1');
    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
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

  // The factory only sees the reduced-motion preference snapshotted before it
  // awaits an adapter/device. A toggle while startup is pending must reach the
  // handle at the controller's installation boundary; uniform payload[0] is
  // the backend's animation clock — 0 while reduced motion is active, and
  // non-zero elapsed time otherwise — so the assertion reads actual submitted
  // work instead of trusting a setter call.
  async function submittedAnimationClocksAfterDeferredStartup(startReduced: boolean) {
    const fixture = webGpuFixture();
    gpu = fixture;
    // writeBuffer receives one reused Float32Array per backend, so copy each
    // payload as submitted; spy call references would all alias the last write.
    const submitted: number[][] = [];
    fixture.device.queue.writeBuffer.mockImplementation((_buffer: unknown, _offset: number, data: Float32Array) => {
      submitted.push(Array.from(data));
    });
    const startup = deferred<void>();
    fixture.gpuInterface.requestAdapter.mockImplementation(async () => {
      await startup.promise;
      return fixture.adapter;
    });
    if (startReduced) {
      motionQuery.matches = true;
      motionQuery.dispatchEvent(new Event('change'));
    }

    root.querySelector<HTMLButtonElement>('[data-stress-mode-option="gpu"]')!.click();
    click('stressStartBtn');
    await vi.advanceTimersByTimeAsync(0);
    expect(root.dataset.stressState).toBe('starting');
    expect(submitted).toHaveLength(0);

    // The preference flips while the adapter request is still pending, so no
    // installed handle exists to receive the change listener's update.
    motionQuery.matches = !startReduced;
    motionQuery.dispatchEvent(new Event('change'));

    startup.resolve();
    // Settle past the metric throttle so the installed backend is published,
    // and so controlled time moves well past installation.
    await settle();
    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressGpuBackend).toBe('webgpu-compute');

    // Retire the queued batches so the backend submits fresh work whose
    // animation clock is observably ahead of installation.
    const preRefill = submitted.length;
    [...fixture.completions].forEach(completion => completion.resolve());
    await vi.advanceTimersByTimeAsync(0);
    const animationClocks = submitted.slice(preRefill).map(payload => payload[0]);
    expect(animationClocks.length).toBeGreaterThan(0);
    return animationClocks;
  }

  it('keeps submitted animation time frozen when reduced motion turns on during GPU startup', async () => {
    const animationClocks = await submittedAnimationClocksAfterDeferredStartup(false);
    expect(animationClocks.every(time => time === 0)).toBe(true);
  });

  it('resumes the submitted animation clock when reduced motion turns off during GPU startup', async () => {
    const animationClocks = await submittedAnimationClocksAfterDeferredStartup(true);
    expect(animationClocks.every(time => time > 0)).toBe(true);
  });
});

// init() queues the control-panel fit sync and the initial idle paint before
// any run exists. These harnesses capture both queued callbacks by reference so
// tests can execute them after start, stop, or dispose transitions — even
// after the controller has cancelled the frames — the way a late animation
// frame can land against newer lifecycle state. The last callback init() queues
// is the initial idle paint.
describe('queued initial idle paint vs GPU surface ownership', () => {
  let startupCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    installHarness();
    startupCallbacks = [...frames.values()];
  });

  afterEach(disposeHarness);

  const canvasBoundTo = (type: string): HTMLCanvasElement =>
    contextRequests.filter(request => request.type === type).at(-1)!.canvas;
  const twoDRequestsOn = (canvas: HTMLCanvasElement) =>
    contextRequests.filter(request => request.canvas === canvas && request.type === '2d');

  function flushStartupCallbacks() {
    for (const callback of startupCallbacks) callback(performance.now());
  }

  // Timers and microtasks only: draining frames would consume the queued
  // initial callbacks before a test can race them against startup.
  async function startWithStartupCallbacksQueued(mode: 'cpu' | 'gpu' | 'both') {
    root.querySelector<HTMLButtonElement>(`[data-stress-mode-option="${mode}"]`)!.click();
    click('stressStartBtn');
    await vi.advanceTimersByTimeAsync(200);
  }

  it('still paints the idle surface when nothing ever started', () => {
    const original = canvasEl();

    flushStartupCallbacks();

    expect(canvasEl()).toBe(original);
    expect(original.dataset.stressIdle).toBe('true');
    expect([original.width, original.height]).toEqual([400, 300]);
  });

  it('leaves the live WebGPU canvas alone when the queued initial idle paint lands after startup', async () => {
    gpu = webGpuFixture();
    await startWithStartupCallbacksQueued('gpu');

    expect(root.dataset.stressState).toBe('running');
    // The backend label dataset only updates on a metric frame, which these
    // harnesses keep queued; a controller canvas bound to WebGPU with two
    // submitted batches is the frame-independent proof of the live backend.
    const gpuCanvas = canvasBoundTo('webgpu');
    expect(gpuCanvas).toBe(canvasEl());
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(2);

    rectState.width = 700;
    flushStartupCallbacks();

    expect(canvasEl()).toBe(gpuCanvas);
    expect(gpuCanvas.isConnected).toBe(true);
    expect(gpuCanvas.dataset.stressIdle).not.toBe('true');
    expect(twoDRequestsOn(gpuCanvas)).toHaveLength(0);
    expect([gpuCanvas.width, gpuCanvas.height]).toEqual([400, 300]);

    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a 2D context off the startup-claimed canvas when idle paint lands mid-adapter-startup', async () => {
    gpu = webGpuFixture();
    const device = gpu.device;
    const deviceStartup = deferred<typeof device>();
    gpu.adapter.requestDevice.mockImplementation(() => deviceStartup.promise);

    await startWithStartupCallbacksQueued('gpu');
    expect(root.dataset.stressState).toBe('starting');

    const startupCanvas = canvasEl();
    flushStartupCallbacks();

    expect(twoDRequestsOn(startupCanvas)).toHaveLength(0);
    expect(startupCanvas.dataset.stressIdle).not.toBe('true');
    expect(canvasEl()).toBe(startupCanvas);

    deviceStartup.resolve(gpu.device);
    await vi.advanceTimersByTimeAsync(200);
    expect(root.dataset.stressState).toBe('running');
    expect(canvasEl()).toBe(startupCanvas);
    expect(canvasBoundTo('webgpu')).toBe(startupCanvas);

    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
  });

  it('causes no DOM mutation or new render work when queued startup callbacks are flushed after dispose', () => {
    controller.dispose();
    const domSnapshot = document.body.innerHTML;
    expect(frames.size).toBe(0);
    const pendingFrames = frames.size;
    const pendingContextRequests = contextRequests.length;

    flushStartupCallbacks();

    expect(document.body.innerHTML).toBe(domSnapshot);
    expect(frames.size).toBe(pendingFrames);
    expect(contextRequests).toHaveLength(pendingContextRequests);
    expect(canvasEl().dataset.stressIdle).toBeUndefined();
  });

  it('keeps a stale initial idle callback from touching a restarted GPU run', async () => {
    gpu = webGpuFixture();
    await startWithStartupCallbacksQueued('gpu');
    expect(root.dataset.stressState).toBe('running');

    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');

    click('stressStartBtn');
    await vi.advanceTimersByTimeAsync(200);
    expect(root.dataset.stressState).toBe('running');
    const gpuCanvas = canvasBoundTo('webgpu');
    expect(canvasEl()).toBe(gpuCanvas);
    expect(gpu.device.queue.submit).toHaveBeenCalledTimes(4);

    flushStartupCallbacks();

    expect(canvasEl()).toBe(gpuCanvas);
    expect(gpuCanvas.isConnected).toBe(true);
    expect(gpuCanvas.dataset.stressIdle).not.toBe('true');
    expect(twoDRequestsOn(gpuCanvas)).toHaveLength(0);

    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
  });

  it('keeps the WebGL2 startup-claimed canvas out of the idle path before the handle resolves', async () => {
    Reflect.deleteProperty(navigator, 'gpu');
    gl2 = webGl2Fixture();
    root.querySelector<HTMLButtonElement>('[data-stress-mode-option="gpu"]')!.click();
    click('stressStartBtn');

    // The factory built the WebGL2 backend synchronously; only the handle's
    // promise handoff back to the controller is still pending.
    const startupCanvas = canvasBoundTo('webgl2');
    expect(canvasEl()).toBe(startupCanvas);
    flushStartupCallbacks();

    expect(twoDRequestsOn(startupCanvas)).toHaveLength(0);
    expect(canvasEl()).toBe(startupCanvas);

    await vi.advanceTimersByTimeAsync(200);
    expect(root.dataset.stressState).toBe('running');
    expect(canvasBoundTo('webgl2')).toBe(canvasEl());
    expect(canvasEl()).toBe(startupCanvas);
    expect(startupCanvas.isConnected).toBe(true);
    expect(startupCanvas.dataset.stressIdle).not.toBe('true');
    expect(gl2.fences).toHaveLength(2);

    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
  });

  it('keeps reduced-motion handling off the startup-claimed canvas and still installs the backend', async () => {
    gpu = webGpuFixture();
    const device = gpu.device;
    const deviceStartup = deferred<typeof device>();
    gpu.adapter.requestDevice.mockImplementation(() => deviceStartup.promise);

    await startWithStartupCallbacksQueued('both');
    expect(root.dataset.stressState).toBe('starting');

    motionQuery.matches = true;
    motionQuery.dispatchEvent(new Event('change'));

    const startupCanvas = canvasEl();
    expect(twoDRequestsOn(startupCanvas)).toHaveLength(0);
    expect(startupCanvas.dataset.stressIdle).not.toBe('true');
    expect(canvasEl()).toBe(startupCanvas);

    deviceStartup.resolve(gpu.device);
    await vi.advanceTimersByTimeAsync(200);
    expect(root.dataset.stressState).toBe('running');
    expect(canvasBoundTo('webgpu')).toBe(startupCanvas);
    expect(canvasEl()).toBe(startupCanvas);

    motionQuery.matches = false;
    motionQuery.dispatchEvent(new Event('change'));
    expect(canvasEl()).toBe(startupCanvas);

    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
  });
  it('keeps CPU-only rendering active when an initial idle callback arrives late', async () => {
    await startWithStartupCallbacksQueued('cpu');
    const cpuCanvas = canvasEl();
    flushStartupCallbacks();
    drainFrames();
    expect(root.dataset.stressState).toBe('running');
    expect(canvasEl()).toBe(cpuCanvas);
    expect(cpuCanvas.dataset.stressIdle).toBe('false');
    expect(context2d.fillRect).toHaveBeenCalled();
    click('stressStopBtn');
    expect(canvasEl().dataset.stressIdle).toBe('true');
  });

  it('permits backend canvas replacement after a reduced-motion change during WebGPU validation', async () => {
    gpu = webGpuFixture();
    gl2 = webGl2Fixture();
    const validation = deferred<{ message: string } | null>();
    gpu.device.popErrorScope.mockReturnValue(validation.promise);
    await startWithStartupCallbacksQueued('gpu');
    const webGpuCanvas = canvasEl();
    expect(canvasBoundTo('webgpu')).toBe(webGpuCanvas);

    motionQuery.matches = true;
    motionQuery.dispatchEvent(new Event('change'));
    flushStartupCallbacks();
    expect(canvasEl()).toBe(webGpuCanvas);
    expect(twoDRequestsOn(webGpuCanvas)).toHaveLength(0);

    validation.resolve({ message: 'Fixture pipeline rejected' });
    await vi.advanceTimersByTimeAsync(200);
    const webGlCanvas = canvasEl();
    expect(root.dataset.stressState).toBe('running');
    expect(webGlCanvas).toBe(canvasBoundTo('webgl2'));
    expect(webGlCanvas).not.toBe(webGpuCanvas);
    expect(webGlCanvas.isConnected).toBe(true);
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
    expect(gpu.context.unconfigure).toHaveBeenCalledTimes(1);
    expect(gl2.fences).toHaveLength(2);

    // The same retained callback is also harmless after WebGL installation.
    flushStartupCallbacks();
    expect(canvasEl()).toBe(webGlCanvas);
    expect(twoDRequestsOn(webGlCanvas)).toHaveLength(0);
    expect(webGlCanvas.dataset.stressIdle).toBe('false');
    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    expect(gl2.gl.deleteProgram).toHaveBeenCalled();
    expect(canvasEl().dataset.stressIdle).toBe('true');
  });

  it('resumes CPU visuals after reduced-motion startup loses its GPU backend', async () => {
    gpu = webGpuFixture();
    const validation = deferred<{ message: string } | null>();
    gpu.device.popErrorScope.mockReturnValue(validation.promise);
    await startWithStartupCallbacksQueued('both');
    const gpuCanvas = canvasEl();
    motionQuery.matches = true;
    motionQuery.dispatchEvent(new Event('change'));
    flushStartupCallbacks();
    expect(twoDRequestsOn(gpuCanvas)).toHaveLength(0);
    expect(canvasEl()).toBe(gpuCanvas);

    gpu.lost.resolve({ reason: 'unknown', message: 'Fixture device lost' });
    validation.resolve(null);
    await vi.advanceTimersByTimeAsync(200);
    expect(root.dataset.stressState).toBe('running');
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
    expect(gpu.device.queue.submit).not.toHaveBeenCalled();
    expect(context2d.fillRect).not.toHaveBeenCalled();

    motionQuery.matches = false;
    motionQuery.dispatchEvent(new Event('change'));
    drainFrames();
    expect(root.dataset.stressGpuBackend).toBe('none');
    expect(canvasEl()).not.toBe(gpuCanvas);
    expect(canvasEl().isConnected).toBe(true);
    expect(context2d.fillRect).toHaveBeenCalled();
    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    expect(canvasEl().dataset.stressIdle).toBe('true');
  });

  it('stops pending startup after a reduced-motion change without letting its late device touch the idle canvas', async () => {
    gpu = webGpuFixture();
    const deviceStartup = deferred<typeof gpu.device>();
    gpu.adapter.requestDevice.mockImplementation(() => deviceStartup.promise);
    await startWithStartupCallbacksQueued('gpu');
    const startupCanvas = canvasEl();
    motionQuery.matches = true;
    motionQuery.dispatchEvent(new Event('change'));
    expect(twoDRequestsOn(startupCanvas)).toHaveLength(0);
    click('stressStopBtn');
    const idleCanvas = canvasEl();
    expect(idleCanvas.dataset.stressIdle).toBe('true');
    const contextCount = contextRequests.length;
    deviceStartup.resolve(gpu.device);
    await vi.advanceTimersByTimeAsync(200);
    flushStartupCallbacks();
    expect(root.dataset.stressState).toBe('idle');
    expect(canvasEl()).toBe(idleCanvas);
    expect(contextRequests).toHaveLength(contextCount);
    expect(gpu.device.queue.submit).not.toHaveBeenCalled();
    expect(gpu.device.destroy).toHaveBeenCalledTimes(1);
  });

});
