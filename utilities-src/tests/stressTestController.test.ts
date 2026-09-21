/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StressTestController } from '../src/stressTestController';
import { startAdaptiveGpuStress, type StressGpuStressCallbacks, type StressGpuStressHandle } from '../src/stressTestGpu';
import type { StartCpuStressRequest, StressTestWorkerResponse } from '../src/stressTestWorkerTypes';
import { BENCHMARK_PRIME_SEARCH_START } from '../src/stressTestPrimeScheduler';

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

  heartbeat(latestPrime: number, primesFound: number, iterations: number, scans = iterations) {
    const data: StressTestWorkerResponse = {
      type: 'cpu-stress-heartbeat', requestId: this.request.requestId,
      workerIndex: this.request.workerIndex, latestPrime, primesFound, iterations, checksum: .25, scans
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

  // Starts CPU stress and drives heartbeats through the baseline windows until
  // the probe spawns its first benchmark wave; returns the permanent workers.
  // Peak-window probe: paired beats every 800ms each close one baseline window.
  // Window rates .5625, .375, .375 → peak .5625, spawn on the third window.
  async function startCpuThroughProbeSpawn() {
    await start('cpu');
    const [first, second] = workloadWorkers();
    first.heartbeat(7, 1, 100);
    second.heartbeat(7, 1, 150); // baseline window opens at total scan 250
    for (let step = 0; step < 3; step += 1) {
      for (let frame = 0; frame < 4; frame += 1) advanceFrame();
      first.heartbeat(7, step + 2, 350 + step * 150);
      second.heartbeat(7, step + 2, 350 + step * 150);
    }
    return { first, second };
  }

  it('reverts the benchmark probe wave on stalled throughput and keeps production coverage gapless', async () => {
    const { first, second } = await startCpuThroughProbeSpawn();
    expect(root.dataset.stressCpuSmtProbe).toBe('probing');
    expect(workloadWorkers()).toHaveLength(4);
    const [, , benchA, benchB] = workloadWorkers();
    // Probe workers sieve the disposable benchmark range, never production blocks.
    expect(benchA.request.blocks[0].low).toBe(BENCHMARK_PRIME_SEARCH_START);
    expect(benchB.request.blocks[0].low).toBe(benchA.request.blocks.at(-1)!.high + 1);

    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    first.heartbeat(7, 4, 660); // spawn warmup: window discarded
    advanceFrame();
    first.heartbeat(7, 4, 665); // candidate window opens at total scan 1315
    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    first.heartbeat(7, 4, 700); // .058 work/ms: first miss
    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    first.heartbeat(7, 4, 735); // second miss → revert

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

    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    first.heartbeat(7, 4, 660); // spawn warmup
    advanceFrame();
    first.heartbeat(7, 4, 665); // candidate window opens
    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    benchA.heartbeat(7, 0, 4000); // benchmark scan work arrives
    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    benchB.heartbeat(7, 0, 9000); // window beats the baseline peak → keep

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
    expect(root.dataset.stressCpuSmtProbe).toBe('probing'); // another doubling wave is pending
    advanceFrame();
    expect(root.dataset.stressIterations).toBe('1315'); // benchmark iterations never counted
    expect(root.dataset.stressPrimesFound).toBe('8'); // benchmark primes never counted
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(4);

    // Wave two re-baselines at the kept count: paired four-worker beats every
    // 800ms give windows of 1.5 work/ms; the third spawns four disposable workers.
    for (let step = 0; step < 4; step += 1) {
      for (let frame = 0; frame < 4; frame += 1) advanceFrame();
      first.heartbeat(7, 5, 700 + step * 300);
      second.heartbeat(7, 4, 660 + step * 300);
      third.heartbeat(7, 1, 40 + step * 300);
      fourth.heartbeat(7, 1, 30 + step * 300);
    }
    expect(workloadWorkers()).toHaveLength(10); // four disposable benchmark workers
    const waveTwo = workloadWorkers().slice(6);
    for (const worker of waveTwo) expect(worker.request.blocks[0].low).toBeGreaterThan(BENCHMARK_PRIME_SEARCH_START);
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(8);

    // The second wave's candidate windows stay at the baseline production rate
    // while the benchmark workers report nothing → revert.
    for (let step = 0; step < 2; step += 1) {
      for (let frame = 0; frame < 2; frame += 1) advanceFrame();
      first.heartbeat(7, 5, 1630 + step * 30);
      second.heartbeat(7, 4, 1590 + step * 30);
      third.heartbeat(7, 1, 970 + step * 30);
      fourth.heartbeat(7, 1, 960 + step * 30);
    }
    for (let step = 0; step < 2; step += 1) {
      for (let frame = 0; frame < 3; frame += 1) advanceFrame();
      first.heartbeat(7, 5, 1750 + step * 60);
      second.heartbeat(7, 4, 1710 + step * 60);
      third.heartbeat(7, 1, 1090 + step * 60);
      fourth.heartbeat(7, 1, 1080 + step * 60);
    }

    expect(root.dataset.stressCpuSmtProbe).toBe('kept'); // capacity still grew overall
    for (const worker of waveTwo) expect(worker.terminate).toHaveBeenCalledOnce();
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
    const { first } = await startCpuThroughProbeSpawn();
    const [, , benchA] = workloadWorkers();
    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    first.heartbeat(7, 4, 660); // spawn warmup
    advanceFrame();
    first.heartbeat(7, 4, 665, 665); // candidate window opens on scan work only
    for (let frame = 0; frame < 3; frame += 1) advanceFrame();
    // The bench worker reports pure scan work and zero candidates. A
    // candidate-based metric would see flat aggregate throughput and revert;
    // executed sieve work more than doubled, so the wave is kept.
    benchA.heartbeat(7, 0, 0, 5000);
    expect(root.dataset.stressCpuSmtProbe).toBe('probing'); // keep decided; next wave pending
    expect(benchA.terminate).toHaveBeenCalledOnce();
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
