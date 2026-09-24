/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StressTestController } from '../src/stressTestController';
import { startAdaptiveGpuStress, type StressGpuStressCallbacks, type StressGpuStressHandle } from '../src/stressTestGpu';
import type { StartCpuStressRequest, StressTestWorkerResponse } from '../src/stressTestWorkerTypes';

vi.mock('../src/stressTestGpu', () => ({ startAdaptiveGpuStress: vi.fn() }));

const productionHtml = readFileSync(resolve(process.cwd(), 'pages/utilities/index.html'), 'utf8');
const gpuStart = vi.mocked(startAdaptiveGpuStress);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

class MockWorker {
  static instances: MockWorker[] = [];
  // Construction-failure simulation applies only to real workload spawns;
  // the module-worker support probe passes a string blob URL.
  static realSpawns = 0;
  static failRealAfter = Number.POSITIVE_INFINITY;
  readonly listeners = new Map<string, Set<EventListener>>();
  readonly postMessage = vi.fn();
  readonly terminate = vi.fn();
  // Running heartbeat counters the test driver maintains per worker.
  cum = 0;
  benchWork = 0;

  constructor(url?: unknown) {
    if (typeof url !== 'string' && ++MockWorker.realSpawns > MockWorker.failRealAfter) {
      throw new Error('Simulated worker quota exceeded');
    }
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }

  get request(): StartCpuStressRequest { return this.postMessage.mock.calls[0][0]; }

  receive(data: StressTestWorkerResponse) {
    for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data }));
  }

  heartbeat(latestPrime: number, primesFound: number, iterations: number, workUnits = iterations) {
    const data: StressTestWorkerResponse = {
      type: 'cpu-stress-heartbeat', requestId: this.request.requestId,
      workerIndex: this.request.workerIndex, latestPrime, primesFound, iterations, checksum: .25, workUnits
    };
    this.receive(data);
    return data;
  }
}

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  private disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) { FakeResizeObserver.instances.push(this); }
  observe() {}
  unobserve() {}
  disconnect() { this.disconnected = true; }
  fire() { if (!this.disconnected) this.callback([], this as unknown as ResizeObserver); }
}

describe('stress test controller lifecycle', () => {
  let controller: StressTestController;
  let root: HTMLElement;
  let now: number;
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;
  let capturedGpuCallbacks: StressGpuStressCallbacks | null;

  const workloadWorkers = () => MockWorker.instances.filter(worker => worker.postMessage.mock.calls.length > 0);
  const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();

  function advanceFrame() {
    now += 200;
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  }

  async function start(mode: 'cpu' | 'gpu' | 'both' = 'both') {
    root.querySelector<HTMLButtonElement>(`[data-stress-mode-option="${mode}"]`)!.click();
    click('stressStartBtn');
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    advanceFrame();
  }

  function availableGpu() {
    const handle = {
      backend: 'webgpu-compute' as const,
      getWorkloadLevel: () => 1,
      stop: vi.fn(),
      setPointer: vi.fn(),
      setReducedMotion: vi.fn()
    };
    gpuStart.mockImplementation(async (_canvas, callbacks) => {
      capturedGpuCallbacks = callbacks;
      callbacks.onCanvasActive(true);
      return handle;
    });
    return handle;
  }

  beforeEach(() => {
    MockWorker.instances = [];
    MockWorker.realSpawns = 0;
    MockWorker.failRealAfter = Number.POSITIVE_INFINITY;
    now = 1000;
    frameId = 0;
    frames = new Map();
    capturedGpuCallbacks = null;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    gpuStart.mockReset().mockResolvedValue(null);
    document.body.innerHTML = new DOMParser().parseFromString(productionHtml, 'text/html').getElementById('stressTestApp')!.outerHTML;
    root = document.getElementById('stressTestApp')!;
    window.history.replaceState(null, '', '#stress-test');
    vi.stubGlobal('Worker', MockWorker);
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:module-worker-probe');
      static revokeObjectURL = vi.fn();
    });
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: false }));
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.set(++frameId, callback);
      return frameId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    const context = {
      clearRect: vi.fn(), fillRect: vi.fn(), fillStyle: '',
      createLinearGradient: () => ({ addColorStop: vi.fn() })
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as unknown as ReturnType<HTMLCanvasElement['getContext']>);
    controller = new StressTestController(root);
    controller.init();
    advanceFrame();
  });

  afterEach(() => {
    controller?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(window, '__OD_STRESS_TEST_MAX_WORKERS__');
    document.body.innerHTML = '';
  });

  it('aggregates real worker totals without allowing slower or duplicate reports to rewind the largest prime', async () => {
    await start('cpu');
    expect(root.dataset.stressState).toBe('running');
    expect(gpuStart).not.toHaveBeenCalled();
    const [first, second] = workloadWorkers();
    expect(workloadWorkers()).toHaveLength(2);
    expect(first.request.workerIndex).toBe(0);
    expect(first.request.blocks).toHaveLength(4);
    expect(first.request.blocks[0].low).toBe(1);
    expect(second.request.workerIndex).toBe(1);
    expect(second.request.blocks[0].low).toBe(first.request.blocks.at(-1)!.high + 1);
    first.heartbeat(1_000_000_000_103, 3, 100);
    second.heartbeat(1_000_000_000_039, 2, 70);
    advanceFrame();
    expect(root.dataset.stressLatestPrime).toBe('1000000000103');
    expect(document.getElementById('stressLatestPrime')!.textContent).toBe('1,000,000,000,103');
    expect(root.dataset.stressPrimesFound).toBe('5');
    expect(root.dataset.stressIterations).toBe('170');

    first.heartbeat(1_000_000_000_163, 5, 150);
    first.heartbeat(1_000_000_000_163, 5, 150);
    second.heartbeat(1_000_000_000_039, 1, 50);
    advanceFrame();
    expect(root.dataset.stressLatestPrime).toBe('1000000000163');
    expect(root.dataset.stressPrimesFound).toBe('7');
    expect(root.dataset.stressIterations).toBe('220');
    expect(document.getElementById('stressPrimeSummary')!.textContent).toContain('7 primes found');
  });

  it('reports candidate throughput as a moving average over the trailing window', async () => {
    await start('cpu');
    const [first, second] = workloadWorkers();
    expect(root.dataset.stressCandidatesPerSecond).toBe('0');

    // Actual steady throughput: two workers add 500 candidates per 200 ms frame.
    for (let tick = 1; tick <= 10; tick += 1) {
      first.heartbeat(1_000_000_000_003, 1, tick * 500);
      second.heartbeat(1_000_000_000_009, 1, tick * 500);
      advanceFrame();
    }
    expect(root.dataset.stressIterations).toBe('10000');
    expect(root.dataset.stressCandidatesPerSecond).toBe('5000');
    expect(document.getElementById('stressPrimeSummary')!.textContent).toContain('5,000 candidates/s');

    // With no new candidates for 3 s, the 5 s window holds only 2 s of measured
    // work, so the moving average decays to exactly 2/5 of the steady rate.
    for (let tick = 0; tick < 15; tick += 1) advanceFrame();
    expect(root.dataset.stressCandidatesPerSecond).toBe('2000');

    // Advancing past the whole window, the recorded work ages out of the
    // trailing 5 s entirely and the reading reaches 0. A cumulative
    // since-start average could not report 0 here, so this pins the window
    // clamp and the interpolation-anchor pruning in recordCandidateRate.
    for (let tick = 0; tick < 10; tick += 1) advanceFrame();
    expect(root.dataset.stressCandidatesPerSecond).toBe('0');

    // A removed CPU workload reports no stale throughput.
    click('stressStopBtn');
    expect(root.dataset.stressCandidatesPerSecond).toBe('0');
    expect(document.getElementById('stressPrimeSummary')!.textContent).toContain('0 candidates/s');
  });

  it('stops both workloads, clears worker activity, preserves the result, and ignores an already queued heartbeat', async () => {
    const gpu = availableGpu();
    await start();
    const workers = workloadWorkers();
    const staleListener = [...workers[0].listeners.get('message')!][0];
    const staleMessage = workers[0].heartbeat(1_000_000_000_039, 1, 50);
    advanceFrame();
    expect(root.dataset.stressGpuCanvasActive).toBe('true');
    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    expect(gpu.stop).toHaveBeenCalledOnce();
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(0);
    expect(root.dataset.stressWorkerCount).toBe('0');
    expect(root.dataset.stressGpuCanvasActive).toBe('false');
    expect(root.dataset.stressCanvasActive).toBe('false');
    expect(root.dataset.stressLatestPrime).toBe('1000000000039');
    staleListener(new MessageEvent('message', { data: { ...staleMessage, latestPrime: 1_000_000_000_163, primesFound: 99, checksum: .75 } }));
    advanceFrame();
    // Checksum is written immediately by the handler, even without a metric frame.
    expect(root.dataset.stressLastChecksum).toBe('0.25');
    expect(root.dataset.stressLatestPrime).toBe('1000000000039');
    expect(root.dataset.stressPrimesFound).toBe('1');
    expect((document.getElementById('stressStartBtn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('runs GPU-only mode without creating CPU workers', async () => {
    availableGpu();
    await start('gpu');
    expect(root.dataset.stressState).toBe('running');
    expect(workloadWorkers()).toHaveLength(0);
    expect(root.dataset.stressWorkerCount).toBe('0');
    expect(root.dataset.stressGpuBackend).toBe('webgpu-compute');
    expect(root.dataset.stressGpuCanvasActive).toBe('true');
  });

  it('refills the worker that asks first with unique blocks and ignores duplicate or stale demands', async () => {
    await start('cpu');
    const [first, second] = workloadWorkers();
    const initialEnd = second.request.blocks.at(-1)!.high;
    const demand = { type: 'cpu-stress-work-request' as const, requestId: second.request.requestId,
      workerIndex: 1, supplyId: 1, count: 2 };
    second.receive(demand);
    second.receive(demand);
    second.receive({ ...demand, supplyId: 3 });
    second.receive({ ...demand, requestId: demand.requestId - 1, supplyId: 2 });
    expect(second.postMessage).toHaveBeenCalledTimes(2);
    const supply = second.postMessage.mock.calls[1][0];
    expect(supply).toMatchObject({ type: 'supply-cpu-stress-work', supplyId: 1, workerIndex: 1 });
    expect(supply.blocks[0].low).toBe(initialEnd + 1);
    first.receive({ ...demand, workerIndex: 0 });
    expect(first.postMessage.mock.calls[1][0].blocks[0].low).toBe(supply.blocks.at(-1)!.high + 1);
    advanceFrame();
    expect(root.dataset.stressCpuAlgorithm).toBe('segmented-sieve');
    expect(root.dataset.stressCpuBlocksAssigned).toBe('12');
    expect(root.dataset.stressCpuRefills).toBe('2');
    const activity = document.getElementById('stressWorkerActivity')!;
    expect((activity.children[1] as HTMLElement).dataset.blocksAssigned).toBe('6');
    expect((activity.children[1] as HTMLElement).dataset.refills).toBe('1');
  });

  it('uses all 128 advertised threads and tears every worker down', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(128);
    await start('cpu');
    const workers = workloadWorkers();
    expect(workers).toHaveLength(128);
    const blocks = workers.flatMap(worker => worker.request.blocks);
    expect(new Set(blocks.map(block => block.id)).size).toBe(512);
    for (let index = 1; index < blocks.length; index += 1) expect(blocks[index].low).toBe(blocks[index - 1].high + 1);
    click('stressStopBtn');
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('honors the explicit test-worker override and resets allocation on restart', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(128);
    Object.assign(window, { __OD_STRESS_TEST_MAX_WORKERS__: 2 });
    await start('cpu');
    const previous = workloadWorkers();
    expect(previous).toHaveLength(2);
    const oldListener = [...previous[0].listeners.get('message')!][0];
    click('stressStopBtn');
    await start('cpu');
    const current = workloadWorkers().slice(2);
    expect(current).toHaveLength(2);
    expect(current[0].request.blocks[0]).toMatchObject({ id: 0, low: 1 });
    const oldDemand: StressTestWorkerResponse = { type: 'cpu-stress-work-request', requestId: previous[0].request.requestId,
      workerIndex: 0, supplyId: 1, count: 2 };
    oldListener(new MessageEvent('message', { data: oldDemand }));
    expect(previous[0].postMessage).toHaveBeenCalledTimes(1);
    expect(current[0].postMessage).toHaveBeenCalledTimes(1);
    expect(root.dataset.stressCpuRefills).toBe('0');
  });

  it('stops all workloads when the page becomes hidden', async () => {
    const gpu = availableGpu();
    await start();
    const workers = workloadWorkers();
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(root.dataset.stressState).toBe('idle');
    expect(gpu.stop).toHaveBeenCalledOnce();
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
    expect(root.dataset.stressCanvasActive).toBe('false');
  });

  it('keeps CPU search and its visual active when combined mode has no GPU backend', async () => {
    await start();
    expect(root.dataset.stressState).toBe('running');
    expect(workloadWorkers()).toHaveLength(2);
    expect(root.dataset.stressGpuBackend).toBe('none');
    expect(root.dataset.stressGpuCanvasActive).toBe('false');
    expect(root.dataset.stressCanvasActive).toBe('true');
  });

  it('releases a GPU backend that finishes initializing after stop', async () => {
    let resolveGpu!: (gpu: StressGpuStressHandle) => void;
    gpuStart.mockReturnValue(new Promise(resolve => { resolveGpu = resolve; }));
    await start('gpu');
    expect(root.dataset.stressState).toBe('starting');
    click('stressStopBtn');
    const lateGpu = { backend: 'webgpu-compute' as const, getWorkloadLevel: () => 1, stop: vi.fn() };
    resolveGpu(lateGpu);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(lateGpu.stop).toHaveBeenCalledWith({ loseContext: true });
    expect(root.dataset.stressState).toBe('idle');
    expect(root.dataset.stressGpuCanvasActive).toBe('false');
  });

  it('does not revive combined mode when CPU failure precedes a pending GPU startup', async () => {
    let resolveGpu!: (gpu: StressGpuStressHandle) => void;
    gpuStart.mockReturnValue(new Promise(resolve => { resolveGpu = resolve; }));
    await start('both');
    const first = workloadWorkers()[0];
    first.receive({ type: 'cpu-stress-error', requestId: first.request.requestId,
      workerIndex: first.request.workerIndex, message: 'Worker failed.' });
    const lateGpu = { backend: 'webgpu-compute' as const, getWorkloadLevel: () => 1, stop: vi.fn() };
    resolveGpu(lateGpu);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(root.dataset.stressState).toBe('error');
    expect(lateGpu.stop).toHaveBeenCalledWith({ loseContext: true });
    for (const worker of workloadWorkers()) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('never installs a GPU handle whose failure callback resolves before the factory does', async () => {
    const handle: StressGpuStressHandle = {
      backend: 'webgpu-compute', getWorkloadLevel: () => 1, stop: vi.fn()
    };
    gpuStart.mockImplementation(async (_canvas, callbacks) => {
      callbacks.onAsyncError('WebGPU device lost: Adapter disconnected');
      return handle;
    });
    await start('gpu');
    expect(root.dataset.stressState).toBe('error');
    expect(root.dataset.stressGpuBackend).toBe('none');
    expect(root.dataset.stressGpuLastError).toBe('WebGPU device lost: Adapter disconnected');
    expect(handle.stop).toHaveBeenCalledWith({ loseContext: true });
  });

  it('keeps CPU stress running when GPU startup fails in combined mode', async () => {
    gpuStart.mockImplementation(async (_canvas, callbacks) => {
      callbacks.onAsyncError('GPU stopped responding.');
      return null;
    });
    await start('both');
    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressWorkerCount).toBe('2');
    expect(root.dataset.stressGpuBackend).toBe('none');
    expect(root.dataset.stressGpuLastError).toBe('GPU stopped responding.');
    advanceFrame();
    expect(root.dataset.stressCanvasActive).toBe('true');
  });

  it('drops GPU callbacks that arrive after stop superseded their startup', async () => {
    const staleHandle: StressGpuStressHandle = {
      backend: 'webgpu-compute', getWorkloadLevel: () => 1, stop: vi.fn()
    };
    const startup = deferred<StressGpuStressHandle | null>();
    let staleCallbacks: StressGpuStressCallbacks | null = null;
    gpuStart.mockImplementationOnce((_canvas, callbacks) => {
      staleCallbacks = callbacks;
      return startup.promise;
    });
    click('stressStartBtn');
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    click('stressStopBtn');
    startup.resolve(staleHandle);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    expect(staleHandle.stop).toHaveBeenCalledWith({ loseContext: true });
    staleCallbacks!.onFrame();
    staleCallbacks!.onAsyncError('late device loss');
    staleCallbacks!.onCanvasActive(true);
    advanceFrame();
    expect(root.dataset.stressState).toBe('idle');
    expect(root.dataset.stressGpuLastError).toBe('');
    expect(root.dataset.stressGpuCanvasActive).toBe('false');
    expect(root.dataset.stressTotalRenderedFrames).toBe('0');
  });

  it('counts one stall per oversized render-callback gap and no stall for bursts or the exact threshold', async () => {
    availableGpu();
    await start('gpu');
    const callbacks = capturedGpuCallbacks!;
    const stalls = document.getElementById('stressCallbackStalls') as HTMLElement;
    expect((document.getElementById('stressRenderRateLabel') as HTMLElement).textContent).toBe('GPU batches/s');

    callbacks.onFrame();
    callbacks.onFrame();
    callbacks.onFrame();
    advanceFrame();
    expect(stalls.textContent).toBe('0');

    now += 40;
    callbacks.onFrame();
    now += 34;
    callbacks.onFrame();
    now += 34.5;
    callbacks.onFrame();
    advanceFrame();
    expect(stalls.textContent).toBe('2');
    expect(root.dataset.stressCallbackStalls).toBe('2');
    expect(root.dataset.stressTotalRenderedFrames).toBe('6');
    expect(root.dataset.stressRenderRate).not.toBe('0.0');
  });

  it.each(['gpu', 'both'] as const)('rejects device loss between installation awaits in %s mode', async (mode) => {
    const handle = availableGpu();
    gpuStart.mockImplementation(async (_canvas, callbacks) => {
      callbacks.onCanvasActive(true);
      queueMicrotask(() => queueMicrotask(() => callbacks.onAsyncError('Lost between awaits')));
      return handle;
    });
    await start(mode);
    expect(root.dataset.stressState).toBe(mode === 'gpu' ? 'error' : 'running');
    expect(root.dataset.stressGpuBackend).toBe('none');
    expect(root.dataset.stressGpuCanvasActive).toBe('false');
    expect(root.dataset.stressWorkerCount).toBe(mode === 'gpu' ? '0' : '2');
    expect(root.dataset.stressGpuLastError).toContain('Lost between awaits');
    expect(handle.stop).toHaveBeenCalled();
  });

  it('starts a fresh cadence sample when GPU completions give way to CPU callbacks', async () => {
    availableGpu();
    await start('both');
    for (let i = 0; i < 40; i++) capturedGpuCallbacks!.onFrame();
    now += 50;
    capturedGpuCallbacks!.onFrame();
    advanceFrame();
    expect(Number(root.dataset.stressRenderRate)).toBeGreaterThan(20);
    expect(root.dataset.stressCallbackStalls).toBe('1');
    capturedGpuCallbacks!.onAsyncError('Device disconnected');
    expect(root.dataset.stressRenderRate).toBe('0.0');
    expect(root.dataset.stressCallbackStalls).toBe('0');
    expect(root.dataset.stressTotalRenderedFrames).toBe('41');
    advanceFrame();
    advanceFrame();
    expect(Number(root.dataset.stressRenderRate)).toBeGreaterThan(0);
    expect(Number(root.dataset.stressRenderRate)).toBeLessThanOrEqual(2);
  });

  it('relabels the cadence metric when a GPU failure falls back to CPU visual frames', async () => {
    availableGpu();
    await start('both');
    const heading = document.getElementById('stressRenderRateLabel') as HTMLElement;
    expect(heading.textContent).toBe('GPU batches/s');
    capturedGpuCallbacks!.onAsyncError('WebGPU device lost: graphics device was reset');
    expect(root.dataset.stressState).toBe('running');
    expect(heading.textContent).toBe('Visual callbacks/s');
    advanceFrame();
    advanceFrame();
    expect(root.dataset.stressRenderRate).not.toBe('0.0');
  });

  it('keeps zero render telemetry when reduced motion suppresses CPU visuals without a GPU', async () => {
    controller.dispose();
    vi.stubGlobal('matchMedia', () => Object.assign(new EventTarget(), { matches: true }));
    controller = new StressTestController(root);
    controller.init();
    advanceFrame();
    await start('both');
    expect(root.dataset.stressState).toBe('running');
    expect((document.getElementById('stressRenderRate') as HTMLElement).textContent).toBe('0.0');
    expect((document.getElementById('stressCallbackStalls') as HTMLElement).textContent).toBe('0');
    expect(root.dataset.stressCanvasActive).toBe('false');
  });

  it('leaves backing-store sizing to the installed GPU backend across resize and DPR changes', async () => {
    availableGpu();
    await start('gpu');
    const canvas = document.getElementById('stressCanvas') as HTMLCanvasElement;
    canvas.width = 400;
    canvas.height = 300;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    canvas.getBoundingClientRect = () => ({ width: 600, height: 300 }) as DOMRect;

    FakeResizeObserver.instances.forEach(observer => observer.fire());
    window.dispatchEvent(new Event('resize'));
    advanceFrame();
    expect(canvas.width).toBe(400);

    click('stressStopBtn');
    expect(canvas.width).toBe(1200);
    expect(canvas.height).toBe(600);
  });

  it('claims the canvas while a GPU backend is still starting so observers cannot resize it', async () => {
    const startup = deferred<StressGpuStressHandle | null>();
    gpuStart.mockImplementationOnce(() => startup.promise);
    click('stressStartBtn');
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    const canvas = document.getElementById('stressCanvas') as HTMLCanvasElement;
    canvas.width = 1;
    canvas.height = 1;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    canvas.getBoundingClientRect = () => ({ width: 600, height: 300 }) as DOMRect;
    FakeResizeObserver.instances.forEach(observer => observer.fire());
    advanceFrame();
    expect(canvas.width).toBe(1);

    startup.resolve(null);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
    expect(canvas.width).toBe(1200);
  });

  // Advances the probe by one 600ms measurement window: after `openFrames`
  // 200ms frames (4 past the 700ms spawn/keep/revert settles, 2 past the
  // 300ms pause/resume settles, 0 when a window directly follows another
  // window's close) an opening beat starts the window; 200ms later all delta
  // beats report work (absorbed, too early to close); 600ms after the opening
  // a zero-delta beat closes it. Production workers beat on every phase,
  // each adding `delta` work per window to its running counter; bench workers
  // beat only when listed, mirroring the pause flip: a paused wave is silent.
  function smtWindow(
    permanent: readonly MockWorker[],
    bench: readonly MockWorker[],
    delta: number,
    benchDelta = 0,
    openFrames = 0
  ) {
    for (let frame = 0; frame < openFrames; frame += 1) advanceFrame();
    for (const worker of permanent) worker.heartbeat(7, 2, worker.cum); // opening beat
    advanceFrame();
    for (const worker of bench) {
      worker.benchWork += benchDelta;
      worker.heartbeat(7, 0, worker.benchWork);
    }
    for (const worker of permanent) {
      worker.cum += delta;
      worker.heartbeat(7, 2, worker.cum);
    }
    for (let frame = 0; frame < 2; frame += 1) advanceFrame();
    for (const worker of permanent) worker.heartbeat(7, 2, worker.cum); // closing beat
  }

  // Runs one interleaved trial against the live paused wave: an off window
  // (clearing the spawn settle), then on/off/on flips. The keep signal is the
  // permanent workers' rate under the wave versus the bracketing off windows
  // (`onProdDelta < prodDelta` simulates thread oversubscription slowing them).
  function smtTrial(
    permanent: readonly MockWorker[],
    bench: readonly MockWorker[],
    benchDelta: number,
    prodDelta = 300,
    onProdDelta = prodDelta
  ) {
    smtWindow(permanent, [], prodDelta, 0, 4); // off window after the spawn settle → resume
    smtWindow(permanent, bench, onProdDelta, benchDelta, 2); // on window after the flip settle → pause
    smtWindow(permanent, [], prodDelta, 0, 2); // bracketing off window → resume
    smtWindow(permanent, bench, onProdDelta, benchDelta, 2); // second on window → decision
  }

  // Starts CPU stress and drives heartbeats through the two pre-spawn off
  // windows until the probe spawns its first (paused) benchmark wave; returns
  // the permanent workers. Production beats 300 work units per worker per
  // window (aggregate rate 1.0 work/ms).
  async function startCpuThroughProbeSpawn() {
    await start('cpu');
    const [first, second] = workloadWorkers();
    first.heartbeat(7, 1, 100); first.cum = 100;
    second.heartbeat(7, 1, 150); second.cum = 150; // anchors the initial settle
    smtWindow([first, second], [], 300, 0, 4); // off window 1 (opens after the warmup)
    smtWindow([first, second], [], 300); // off window 2 → spawn the paused wave
    return { first, second };
  }

  // Regression: a wave seeded at a fixed range measures the range's cheapness,
  // not the work the next permanent workers would really do — work units at a
  // stale cheap frontier made the old aggregate metric fake capacity gains on
  // pinned CPUs, and cheap seeded waves would also under-contend the trial's
  // threads. Every disposable wave must seed exactly at the production
  // frontier current when that wave spawns.
  it('seeds every disposable probe wave at the live production frontier', async () => {
    await start('cpu');
    const [first, second] = workloadWorkers();
    // Advance the production frontier well past its spawn fill before probing.
    first.receive({ type: 'cpu-stress-work-request', requestId: first.request.requestId,
      workerIndex: 0, supplyId: 1, count: 4 });
    second.receive({ type: 'cpu-stress-work-request', requestId: second.request.requestId,
      workerIndex: 1, supplyId: 1, count: 4 });
    const frontier = second.postMessage.mock.calls[1][0].blocks.at(-1).high + 1;
    first.heartbeat(7, 1, 100); first.cum = 100;
    second.heartbeat(7, 1, 150); second.cum = 150; // anchors the initial settle
    smtWindow([first, second], [], 300, 0, 4); // off window 1
    smtWindow([first, second], [], 300); // off window 2 → spawn the paused wave
    const [, , benchA, benchB] = workloadWorkers();
    expect(benchA.request.blocks[0].low).toBe(frontier); // the advanced frontier, not a constant
    expect(benchB.request.blocks[0].low).toBe(benchA.request.blocks.at(-1)!.high + 1);
    // Production resumption is unaffected: its next block starts at exactly
    // the frontier the wave was seeded from.
    first.receive({ type: 'cpu-stress-work-request', requestId: first.request.requestId,
      workerIndex: 0, supplyId: 2, count: 2 });
    expect(first.postMessage.mock.calls[2][0].blocks[0].low).toBe(frontier);
  });

  it('reverts the benchmark probe wave on stalled throughput and keeps production coverage gapless', async () => {
    const { first, second } = await startCpuThroughProbeSpawn();
    expect(root.dataset.stressCpuSmtProbe).toBe('probing');
    expect(workloadWorkers()).toHaveLength(4);
    const [, , benchA, benchB] = workloadWorkers();
    // The disposable wave seeds at the live production frontier and sieves
    // its own allocator: it never consumes nor skips any production block.
    expect(benchA.request.blocks[0].low).toBe(second.request.blocks.at(-1)!.high + 1);
    expect(benchB.request.blocks[0].low).toBe(benchA.request.blocks.at(-1)!.high + 1);

    const permanent = [first, second];
    // The bench workers' on windows slow the permanent workers to ~67% — the
    // trial's threads no longer fit — so the trial reverts.
    smtTrial(permanent, [benchA, benchB], 300, 300, 200);

    expect(root.dataset.stressCpuSmtProbe).toBe('reverted');
    expect(benchA.terminate).toHaveBeenCalledOnce();
    expect(benchB.terminate).toHaveBeenCalledOnce();
    expect(first.terminate).not.toHaveBeenCalled();
    expect(second.terminate).not.toHaveBeenCalled();
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(2);
    advanceFrame();
    expect(root.dataset.stressWorkerCount).toBe('2');

    // Regression: a refill after a revert must continue the production frontier.
    // Consuming production blocks for disposable probe work used to skip them.
    first.receive({ type: 'cpu-stress-work-request', requestId: first.request.requestId,
      workerIndex: 0, supplyId: 1, count: 2 });
    const supply = first.postMessage.mock.calls[1][0];
    expect(supply.blocks[0]).toMatchObject({ id: 8, low: second.request.blocks.at(-1)!.high + 1 });
    advanceFrame();
    expect(root.dataset.stressCpuBlocksAssigned).toBe('10');
  });

  it('converts kept probe waves into permanent workers and iterates until growth stalls', async () => {
    const { first, second } = await startCpuThroughProbeSpawn();
    const [, , benchA, benchB] = workloadWorkers();
    const permanent = [first, second];

    // The wave costs the permanent workers nothing (their on-window rate is
    // unchanged) → keep converts the entire wave.
    smtTrial(permanent, [benchA, benchB], 300);

    // The disposable wave is traded for permanent workers fed by the production allocator.
    expect(benchA.terminate).toHaveBeenCalledOnce();
    expect(benchB.terminate).toHaveBeenCalledOnce();
    expect(workloadWorkers()).toHaveLength(6);
    const [third, fourth] = workloadWorkers().slice(4);
    expect(third.request.workerIndex).toBe(2);
    expect(fourth.request.workerIndex).toBe(3);
    expect(third.request.blocks[0].id).toBe(8);
    expect(third.request.blocks[0].low).toBe(second.request.blocks.at(-1)!.high + 1);
    expect(fourth.request.blocks[0].low).toBe(third.request.blocks.at(-1)!.high + 1);
    expect(root.dataset.stressCpuSmtProbe).toBe('probing'); // another exponential trial is pending
    advanceFrame();
    expect(root.dataset.stressIterations).toBe('3850'); // benchmark iterations never counted
    expect(root.dataset.stressPrimesFound).toBe('4'); // benchmark primes never counted
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(4);

    // Wave two re-baselines at the kept four workers and spawns the trial-8
    // wave of four disposable benchmark workers.
    const grown = [first, second, third, fourth];
    smtWindow(grown, [], 300, 0, 4); // re-baseline off window 1
    smtWindow(grown, [], 300); // off window 2 → spawn
    expect(workloadWorkers()).toHaveLength(10); // four disposable benchmark workers
    const waveTwo = workloadWorkers().slice(6);
    // Wave two re-seeds at the frontier the kept permanent replacements just
    // advanced; a stale seed would compare mismatched-cost ranges.
    expect(waveTwo[0].request.blocks[0].low).toBe(fourth.request.blocks.at(-1)!.high + 1);
    for (let index = 1; index < waveTwo.length; index += 1) {
      expect(waveTwo[index].request.blocks[0].low).toBe(waveTwo[index - 1].request.blocks.at(-1)!.high + 1);
    }
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(8);

    // Wave two's on windows slow the permanent workers to ~67% — those trial
    // threads do not fit → revert. Because an earlier wave was kept,
    // the search is not over: the slowed trial becomes the failed bound and
    // the probe re-baselines to bisect the bracket.
    smtTrial(grown, waveTwo, 300, 300, 200);
    for (const worker of waveTwo) expect(worker.terminate).toHaveBeenCalledOnce();
    expect(root.dataset.stressCpuSmtProbe).toBe('probing'); // refining the bracket [4, 8] now
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(4);

    // The refinement trial bisects to six, so its disposable wave has two
    // members, not the exponential phase's four.
    smtWindow(grown, [], 300, 0, 4); // re-baseline off window 1
    smtWindow(grown, [], 300); // off window 2 → spawn two
    const refinementWave = workloadWorkers().slice(10);
    expect(refinementWave).toHaveLength(2);
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(6);

    // The refinement trial slows workers to ~67% too; the bracket [4, 6] is
    // inside the tolerance, so the search ends with the overall grown count.
    smtTrial(grown, refinementWave, 300, 300, 200);

    expect(root.dataset.stressCpuSmtProbe).toBe('kept'); // capacity still grew overall
    for (const worker of refinementWave) expect(worker.terminate).toHaveBeenCalledOnce();
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(4);
    advanceFrame();
    expect(root.dataset.stressWorkerCount).toBe('4');

    // Coverage stays gapless across every keep and revert: the frontier is the last
    // permanent replacement's final block, with benchmark waves never consuming it.
    third.receive({ type: 'cpu-stress-work-request', requestId: third.request.requestId,
      workerIndex: 2, supplyId: 1, count: 2 });
    const supply = third.postMessage.mock.calls[1][0];
    expect(supply.blocks[0]).toMatchObject({ id: 16, low: fourth.request.blocks.at(-1)!.high + 1 });
  });

  it('keeps a wave on rising scan work even as candidate throughput decays with the frontier', async () => {
    const { first, second } = await startCpuThroughProbeSpawn();
    const [, , benchA, benchB] = workloadWorkers();
    // The bench workers report pure scan work and zero candidates, and the
    // production set itself slows down as the frontier advances (300 → 200
    // units per window). A candidate-based or time-sequential metric sees
    // attenuating windows and would revert; the interleaved comparison sees
    // the same slowdown in on and off windows alike, measures the wave as
    // costing the permanent workers nothing, and converts it in full.
    smtTrial([first, second], [benchA, benchB], 900, 200);
    expect(root.dataset.stressCpuSmtProbe).toBe('probing'); // keep decided; next trial pending
    expect(benchA.terminate).toHaveBeenCalledOnce();
    expect(benchB.terminate).toHaveBeenCalledOnce();
    expect(workloadWorkers()).toHaveLength(6); // permanent replacements installed
    click('stressStopBtn');
    expect(root.dataset.stressState).toBe('idle');
  });

  it('isolates a probe worker error to the probe wave', async () => {
    const { first, second } = await startCpuThroughProbeSpawn();
    const [, , benchA] = workloadWorkers();
    const utilityErrors: Event[] = [];
    const onUtilityError = (event: Event) => utilityErrors.push(event);
    window.addEventListener('utility-load-error', onUtilityError);
    try {
      for (const listener of benchA.listeners.get('error')!) {
        listener(new ErrorEvent('error', { message: 'probe worker exploded' }));
      }
      expect(root.dataset.stressState).toBe('running');
      expect(root.dataset.stressCpuSmtProbe).toBe('reverted');
      expect(first.terminate).not.toHaveBeenCalled();
      expect(second.terminate).not.toHaveBeenCalled();
      expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(2);
      expect(utilityErrors).toHaveLength(0);
      advanceFrame();
      expect(root.dataset.stressWorkerCount).toBe('2');
    } finally {
      window.removeEventListener('utility-load-error', onUtilityError);
    }
  });

  it('treats a reported probe worker failure as a wave revert, not a run failure', async () => {
    const { first, second } = await startCpuThroughProbeSpawn();
    const [, , benchA] = workloadWorkers();
    benchA.receive({ type: 'cpu-stress-error', requestId: benchA.request.requestId,
      workerIndex: benchA.request.workerIndex, message: 'benchmark sieve fault' });
    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressCpuSmtProbe).toBe('reverted');
    expect(first.terminate).not.toHaveBeenCalled();
    expect(second.terminate).not.toHaveBeenCalled();
  });

  it('rolls back a partially constructed probe wave without orphan bars', async () => {
    MockWorker.failRealAfter = 3; // the second benchmark worker's constructor throws
    const { first, second } = await startCpuThroughProbeSpawn();
    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressCpuSmtProbe).toBe('reverted');
    expect(first.terminate).not.toHaveBeenCalled();
    expect(second.terminate).not.toHaveBeenCalled();
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(2);
    const partial = workloadWorkers().at(-1)!; // the half-wave that did get constructed
    expect(partial.terminate).toHaveBeenCalledOnce();
    first.receive({ type: 'cpu-stress-work-request', requestId: first.request.requestId,
      workerIndex: 0, supplyId: 1, count: 2 });
    const supply = first.postMessage.mock.calls[1][0];
    expect(supply.blocks[0].low).toBe(second.request.blocks.at(-1)!.high + 1);
  });

  it('reclaims production blocks when a permanent replacement wave fails partway', async () => {
    // Regression: a kept wave trades disposable workers for permanent ones.
    // The first replacement consumes four production blocks before the second
    // replacement's constructor throws; the rollback must rewind the frontier
    // so surviving workers resume gaplessly instead of skipping the blocks.
    MockWorker.failRealAfter = 5; // the second permanent replacement throws
    const { first, second } = await startCpuThroughProbeSpawn();
    const [, , benchA, benchB] = workloadWorkers();
    smtTrial([first, second], [benchA, benchB], 300); // 2× ratio → keep → replacements spawn

    expect(root.dataset.stressState).toBe('running');
    expect(root.dataset.stressCpuSmtProbe).toBe('reverted'); // probe ends with no extra capacity
    expect(benchA.terminate).toHaveBeenCalledOnce();
    const replacement = workloadWorkers().at(-1)!; // the half-spawned permanent worker
    expect(replacement.terminate).toHaveBeenCalledOnce();
    expect(first.terminate).not.toHaveBeenCalled();
    expect(second.terminate).not.toHaveBeenCalled();
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(2);
    advanceFrame();
    expect(root.dataset.stressWorkerCount).toBe('2');
    expect(root.dataset.stressCpuBlocksAssigned).toBe('8'); // replacement blocks reclaimed

    // The frontier is exact: the next refill resumes after the last block the
    // surviving permanent workers ever received.
    first.receive({ type: 'cpu-stress-work-request', requestId: first.request.requestId,
      workerIndex: 0, supplyId: 1, count: 2 });
    const supply = first.postMessage.mock.calls[1][0];
    expect(supply.blocks[0]).toMatchObject({ id: 8, low: second.request.blocks.at(-1)!.high + 1 });
  });

  it('unwinds a partially constructed baseline wave on start failure', async () => {
    MockWorker.failRealAfter = 1;
    await start('cpu');
    expect(root.dataset.stressState).toBe('error');
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(0);
    const only = workloadWorkers();
    expect(only).toHaveLength(1);
    expect(only[0].terminate).toHaveBeenCalledOnce();
    advanceFrame();
    expect(root.dataset.stressWorkerCount).toBe('0');
  });

  it('skips the SMT probe entirely when the explicit worker cap is set', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(128);
    Object.assign(window, { __OD_STRESS_TEST_MAX_WORKERS__: 2 });
    await start('cpu');
    expect(workloadWorkers()).toHaveLength(2);
    const [first, second] = workloadWorkers();

    first.heartbeat(7, 1, 1000);
    second.heartbeat(7, 1, 1000);
    for (let step = 0; step < 12; step += 1) {
      advanceFrame();
      first.heartbeat(7, step + 2, 1000 + step * 5000);
      second.heartbeat(7, step + 2, 1000 + step * 5000);
    }

    expect(workloadWorkers()).toHaveLength(2);
    expect(root.dataset.stressCpuSmtProbe).toBeUndefined();
  });
});
