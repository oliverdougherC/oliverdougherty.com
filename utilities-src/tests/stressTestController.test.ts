/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StressTestController } from '../src/stressTestController';
import { CPU_POOL_GROWTH_WINDOW_MS, CPU_POOL_TRUSTED_REPORT_MAX, CPU_SLICE_OVERRUN_FACTOR } from '../src/stressTestCore';
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
  cursor = 1;
  supplies = 0;
  busyMs = 0;
  idleMs = 0;
  bandWaitMs = 0;
  slices = 0;
  slowSlices = 0;

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
  get terminated() { return this.terminate.mock.calls.length > 0; }

  receive(data: StressTestWorkerResponse) {
    for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data }));
  }

  heartbeat(latestPrime: number, primesFound: number, candidates: number, rangeLow = this.cursor,
    busyMs = this.busyMs, idleMs = this.idleMs, bandWaitMs = this.bandWaitMs,
    slices = this.slices, slowSlices = this.slowSlices) {
    const data: StressTestWorkerResponse = {
      type: 'cpu-stress-heartbeat', requestId: this.request.requestId,
      workerIndex: this.request.workerIndex, latestPrime, primesFound, candidates, checksum: .25, rangeLow,
      busyMs, idleMs, bandWaitMs, slices, slowSlices
    };
    this.receive(data);
    return data;
  }

  /** Asks for the band after the one it owns, the way a running worker prefetches. */
  askForBand(supplyId = ++this.supplies, overrides: Record<string, unknown> = {}) {
    this.receive({ type: 'cpu-stress-work-request', requestId: this.request.requestId,
      workerIndex: this.request.workerIndex, supplyId, ...overrides } as StressTestWorkerResponse);
  }

  /** The `continue-cpu-stress` reply the controller sent for a given supply. */
  supply(supplyId: number) {
    return this.postMessage.mock.calls.map(call => call[0]).find(message => message.type === 'continue-cpu-stress'
      && message.supplyId === supplyId);
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

  // The automatic pool runs on real timers, so the suite captures them instead of
  // waiting: a growth window becomes a deliberate test step. Sub-passes exist
  // because a growth wave that needs more than one spawn burst queues follow-up
  // bursts behind the tick that started it, and only the growth tick's own
  // â‰¥ CPU_POOL_GROWTH_WINDOW_MS guard decides when a window actually closes.
  let timers: Map<number, () => void>;
  let timerId = 0;

  function fireTimers(elapsedMs: number) {
    now += elapsedMs;
    const due = [...timers.values()];
    timers.clear();
    for (const callback of due) callback();
  }

  /** Live workers only: a terminated one never reports again in a real browser. */
  const liveWorkers = () => MockWorker.instances.filter(worker => worker.postMessage.mock.calls.length > 0 && !worker.terminated);

  /**
   * One window of work from a machine with `threads` logical processors. A worker
   * that has a processor to itself spends the whole window sieving and is handed
   * its next slice immediately; a pool that has to share splits each worker's
   * window into sieving time and waiting-to-run time in proportion, which is what
   * the pool's duty cycle reads. A bigger pool on a small machine therefore
   * delivers about the same aggregate work either way — the property that makes
   * throughput useless for sizing this pool — while its duty cycle falls.
   */
  function beatPool(workPerWorker = 1000, threads = Number.POSITIVE_INFINITY) {
    const workers = liveWorkers();
    const share = Number.isFinite(threads) ? Math.min(1, threads / Math.max(1, workers.length)) : 1;
    const oversubscribed = Number.isFinite(threads) && workers.length / threads >= CPU_SLICE_OVERRUN_FACTOR;
    const window = CPU_POOL_GROWTH_WINDOW_MS + 200; // the window tick plus the metrics frame
    for (const worker of workers) {
      worker.cum += workPerWorker * share;
      worker.busyMs += window * share;
      worker.idleMs += window * (1 - share);
      // Roughly one 8ms slice per 8ms of wall clock, as the real worker reports.
      worker.slices += 125;
      if (oversubscribed) worker.slowSlices += 125;
      worker.heartbeat(1_000_000_000_003, 0, Math.round(worker.cum));
    }
  }

  /**
   * One measurement window: its work, then exactly one tick of the pool's
   * measurement timer, then a metrics refresh. Advancing `now` by precisely
   * CPU_POOL_GROWTH_WINDOW_MS keeps one closed window per call, so every window
   * the growth policy judges contains exactly the work this call just reported.
   */
  function measureWindow(threads = 8, workPerWorker = 1000) {
    beatPool(workPerWorker, threads);
    fireTimers(CPU_POOL_GROWTH_WINDOW_MS);
    advanceFrame();
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
    timers = new Map();
    timerId = 0;
    vi.spyOn(window, 'setTimeout').mockImplementation(((callback: () => void) => {
      timerId += 1;
      timers.set(timerId, callback);
      return timerId;
    }) as unknown as typeof window.setTimeout);
    vi.spyOn(window, 'clearTimeout').mockImplementation(((id?: number) => {
      if (id) timers.delete(id);
    }) as unknown as typeof window.clearTimeout);
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
    Reflect.deleteProperty(window, '__OD_STRESS_TEST_WORKERS__');
    document.body.innerHTML = '';
  });

  it('aggregates real worker totals without allowing slower or duplicate reports to rewind the largest prime', async () => {
    await start('cpu');
    expect(root.dataset.stressState).toBe('running');
    expect(gpuStart).not.toHaveBeenCalled();
    const [first, second] = workloadWorkers();
    expect(workloadWorkers()).toHaveLength(2);
    expect(first.request.workerIndex).toBe(0);
    expect(first.request.low).toBe(1);
    expect(second.request.workerIndex).toBe(1);
    // Each worker owns a disjoint band, so nothing needs to be de-duplicated.
    expect(second.request.low).toBe(first.request.limit + 1);
    first.heartbeat(1_000_000_000_103, 3, 100);
    second.heartbeat(1_000_000_000_039, 2, 70);
    advanceFrame();
    expect(root.dataset.stressLatestPrime).toBe('1000000000103');
    expect(document.getElementById('stressLatestPrime')!.textContent).toBe('1,000,000,000,103');
    expect(root.dataset.stressPrimesFound).toBe('5');
    expect(root.dataset.stressCandidates).toBe('170');

    first.heartbeat(1_000_000_000_163, 5, 150);
    first.heartbeat(1_000_000_000_163, 5, 150);
    second.heartbeat(1_000_000_000_039, 1, 50);
    advanceFrame();
    expect(root.dataset.stressLatestPrime).toBe('1000000000163');
    expect(root.dataset.stressPrimesFound).toBe('7');
    expect(root.dataset.stressCandidates).toBe('220');
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
    expect(root.dataset.stressCandidates).toBe('10000');
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

  it('answers the worker that asks first with the next disjoint band and ignores duplicate or stale demands', async () => {
    await start('cpu');
    const [first, second] = workloadWorkers();
    const initialEnd = second.request.limit;
    second.askForBand(1);
    second.askForBand(1); // duplicate
    second.askForBand(3); // never requested
    second.askForBand(1, { requestId: second.request.requestId - 1 }); // previous run
    expect(second.postMessage).toHaveBeenCalledTimes(2); // only the valid demand answered
    const supply = second.supply(1);
    expect(supply).toMatchObject({ type: 'continue-cpu-stress', supplyId: 1, workerIndex: 1 });
    expect(supply.low).toBe(initialEnd + 1);
    expect(supply.limit).toBeGreaterThan(supply.low);
    // The answer does not wait for a frame: a starving worker is refilled inside
    // the message that asked, so a busy main thread cannot starve the pool.
    first.askForBand(1);
    const firstSupply = first.supply(1);
    expect(firstSupply.low).toBe(supply.limit + 1); // still one tiling, no overlap
    expect(root.dataset.stressCpuAlgorithm).toBe('segmented-sieve');
    advanceFrame();
    const activity = document.getElementById('stressWorkerActivity')!;
    expect((activity.children[1] as HTMLElement).dataset.rangeLow).toBe(String(supply.low));
  });

  it('uses all 128 advertised threads and tears every worker down', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(128);
    await start('cpu');
    const workers = workloadWorkers();
    // The whole report becomes workers at once: no halving, no reserved core, and
    // at 128 the pool already sits at the growth guard, so nothing else is added.
    expect(workers).toHaveLength(128);
    expect(root.dataset.stressCpuReported).toBe('128');
    expect(root.dataset.stressCpuPool).toBe('capped');
    const bands = workers.map(worker => worker.request);
    expect(new Set(bands.map(band => band.low)).size).toBe(128);
    for (let index = 1; index < bands.length; index += 1) {
      expect(bands[index].low).toBe(bands[index - 1].limit + 1);
    }
    click('stressStopBtn');
    for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('pins the exact diagnostic worker count and resets band allocation on restart', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(128);
    Object.assign(window, { __OD_STRESS_TEST_WORKERS__: 2 });
    await start('cpu');
    const previous = workloadWorkers();
    expect(previous).toHaveLength(2);
    expect(root.dataset.stressCpuPool).toBe('pinned');
    const oldListener = [...previous[0].listeners.get('message')!][0];
    click('stressStopBtn');
    await start('cpu');
    const current = workloadWorkers().slice(2);
    expect(current).toHaveLength(2);
    expect(current[0].request).toMatchObject({ low: 1 });
    const oldDemand: StressTestWorkerResponse = { type: 'cpu-stress-work-request',
      requestId: previous[0].request.requestId, workerIndex: 0, supplyId: 1 };
    oldListener(new MessageEvent('message', { data: oldDemand }));
    expect(previous[0].postMessage).toHaveBeenCalledTimes(1); // stale demand dropped
    expect(current[0].postMessage).toHaveBeenCalledTimes(1); // no unsolicited supply
    advanceFrame();
    expect(root.dataset.stressCpuPool).toBe('pinned'); // and a pinned pool never grows
  });

  it('treats the max-workers hook as a ceiling on the automatic pool, never a request', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(128);
    Object.assign(window, { __OD_STRESS_TEST_MAX_WORKERS__: 4 });
    await start('cpu');
    // A ceiling is a limit, not a way to make the page use more workers than the
    // browser reports, and it stops growth dead at the limit.
    expect(workloadWorkers()).toHaveLength(4);
    expect(root.dataset.stressCpuPool).toBe('capped');
    for (let window = 0; window < 6; window += 1) measureWindow(128);
    expect(workloadWorkers()).toHaveLength(4);
  });

  it('honours an exact request above the reported count for diagnosis', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    Object.assign(window, { __OD_STRESS_TEST_WORKERS__: 9 });
    await start('cpu');
    // Testing a specific count is the point of the hook, so it is not clamped to
    // the (possibly wrong) report, and it stays exactly there.
    expect(workloadWorkers()).toHaveLength(9);
    expect(root.dataset.stressCpuReported).toBe('2');
    expect(root.dataset.stressCpuPool).toBe('pinned');
    for (let window = 0; window < 6; window += 1) measureWindow(2);
    expect(workloadWorkers()).toHaveLength(9);
  });

  it('ignores a diagnostic hook that asks for an absurd worker count', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
    Object.assign(window, { __OD_STRESS_TEST_WORKERS__: CPU_POOL_TRUSTED_REPORT_MAX + 1 });
    await start('cpu');
    // Refusing to spawn millions of workers, and staying visibly automatic
    // instead of pretending to be pinned at a number nobody asked for.
    expect(workloadWorkers()).toHaveLength(4);
    expect(root.dataset.stressCpuPool).toBe('growing');
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

  // Everything below drives the automatic pool. `measureWindow` states the
  // machine under test: a host with `threads` logical processors, where each live
  // worker sieves its fair share of that machine's capacity and only starts
  // overrunning its slice budget once the pool shares threads past
  // CPU_SLICE_OVERRUN_FACTOR, followed by the pool's own measurement tick.

  it('grows a browser that under-reports until its workers start sharing threads', async () => {
    // The requirement this policy exists to meet. A browser that reports 2 of
    // this machine's 8 logical processors must still end up loading all 8, and
    // the assertion that matters is on the pool the run FINISHED with — a policy
    // that simply stays alive at the reported count fails here.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    await start('cpu');
    expect(workloadWorkers()).toHaveLength(2);
    expect(root.dataset.stressCpuReported).toBe('2');
    expect(root.dataset.stressCpuPool).toBe('growing');

    const sizes: number[] = [];
    for (let window = 0; window < 14; window += 1) {
      measureWindow(8);
      sizes.push(liveWorkers().length);
    }

    const final = liveWorkers().length;
    expect(final).toBeGreaterThan(2); // never stopped at the report
    expect(final).toBeGreaterThanOrEqual(8); // reached the machine's capacity
    expect(root.dataset.stressCpuPool).toBe('settled');
    expect(root.dataset.stressWorkerCount).toBe(String(final));
    // Grow-only: the pool got there by adding workers, never by replacing them.
    expect(MockWorker.instances.filter(worker => worker.terminated)).toHaveLength(0);
    expect(sizes).toEqual([...sizes].sort((left, right) => left - right));
  });

  it('never shrinks the pool, whatever the work-rate does afterwards', async () => {
    // Boost-clock recovery, thermal state and background load all make the same
    // pool measure slower a few seconds later. That sag is why a slowdown-based
    // policy threw workers away and under-loaded the machine, so the pool is
    // grow-only and a sagging rate is not a reason to remove anything.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
    await start('cpu');
    for (let window = 0; window < 4; window += 1) measureWindow(16);
    const grown = liveWorkers().length;
    expect(grown).toBeGreaterThan(4);

    for (let step = 1; step <= 6; step += 1) measureWindow(16, 1000 * (1 - step * 0.03));
    expect(liveWorkers().length).toBeGreaterThanOrEqual(grown); // never shrank
    expect(MockWorker.instances.filter(worker => worker.terminated)).toHaveLength(0);

    // Growth ends when the workers start displacing each other, and the pool that
    // got there is then simply left alone.
    for (let window = 0; window < 10; window += 1) measureWindow(4);
    expect(root.dataset.stressCpuPool).toBe('settled');
    const settled = liveWorkers().length;
    for (let window = 0; window < 6; window += 1) measureWindow(4);
    expect(liveWorkers()).toHaveLength(settled);
  });

  it('spawns one growth step in bursts so a big step cannot block the page', async () => {
    // Constructing a worker is main-thread work. A single step that adds nine
    // workers arrives as two bursts, so combined mode keeps submitting GPU work
    // and the control panel keeps responding while the pool grows.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(12);
    await start('cpu');
    for (let window = 0; window < 3; window += 1) measureWindow(64);
    expect(liveWorkers()).toHaveLength(18); // 12 + the first bounded step

    beatPool(2000);
    fireTimers(CPU_POOL_GROWTH_WINDOW_MS); // skipped: this window held the spawn itself
    expect(liveWorkers()).toHaveLength(18);
    beatPool(2000); // still one worker per available thread
    fireTimers(CPU_POOL_GROWTH_WINDOW_MS); // the tick decides and starts spawning
    expect(liveWorkers()).toHaveLength(26); // eight now, the rest on a follow-up
    fireTimers(0);
    expect(liveWorkers()).toHaveLength(27);
  });

  it('keeps the run and reports the shortfall when a growth wave cannot start', async () => {
    // Worker creation can genuinely fail (quota, memory pressure) after the pool
    // is already loaded. Bounded recovery: the workers that run keep running,
    // growth stops, and the reason is published instead of quietly ignored.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    await start('cpu');
    measureWindow(8);
    measureWindow(8);
    measureWindow(8); // first step: 2 → 4 workers
    measureWindow(8); // the window that contained that spawn is not judged
    MockWorker.failRealAfter = MockWorker.realSpawns;
    measureWindow(8); // next step cannot be built

    expect(root.dataset.stressState).toBe('running');
    expect(liveWorkers()).toHaveLength(4); // kept the pool that was already working
    expect(root.dataset.stressCpuPool).toBe('settled');
    expect(root.dataset.stressCpuPoolLimitation).toContain('Simulated worker quota exceeded');
    // And it does not keep trying: no restart loop behind the reported failure.
    const attempts = MockWorker.realSpawns;
    for (let window = 0; window < 4; window += 1) measureWindow(8);
    expect(MockWorker.realSpawns).toBe(attempts);
  });

  it('fails the start and unwinds the pool when the initial wave cannot be built', async () => {
    // The difference between the two cases is honesty about what is running: no
    // workers means no workload, so the run reports an error rather than idling.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(6);
    MockWorker.failRealAfter = 3;
    await start('cpu');
    expect(root.dataset.stressState).toBe('error');
    expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(0);
    const spawned = workloadWorkers();
    expect(spawned).toHaveLength(3);
    for (const worker of spawned) expect(worker.terminate).toHaveBeenCalledOnce();
    advanceFrame();
    expect(root.dataset.stressWorkerCount).toBe('0');
    expect(root.dataset.stressCpuPool).toBeUndefined();
  });

  it('fails the run when a worker reports a fault, whatever wave grew it', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    await start('cpu');
    measureWindow(8);
    measureWindow(8);
    measureWindow(8);
    const grown = liveWorkers();
    expect(grown.length).toBeGreaterThan(2);
    const last = grown.at(-1)!;
    last.receive({ type: 'cpu-stress-error', requestId: last.request.requestId, workerIndex: last.request.workerIndex,
      message: 'simulated sieve fault' });
    expect(root.dataset.stressState).toBe('error');
    expect(root.dataset.stressGpuLastError).toContain('simulated sieve fault');
  });

  it('ends growth with the run and never spawns into a later one', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    await start('cpu');
    measureWindow(8);
    measureWindow(8);
    measureWindow(8);
    expect(liveWorkers().length).toBeGreaterThan(2);

    click('stressStopBtn');
    expect(timers.size).toBe(0); // no growth or spawn timer survived the stop
    const spawned = MockWorker.instances.length;
    for (let pass = 0; pass < 8; pass += 1) fireTimers(CPU_POOL_GROWTH_WINDOW_MS);
    expect(MockWorker.instances.length).toBe(spawned);

    // A restart is a fresh plan, not a continuation of the old pool's decisions.
    await start('cpu');
    expect(root.dataset.stressCpuPool).toBe('growing');
    expect(liveWorkers()).toHaveLength(2); // a new run starts from the report again
  });

  it('keeps every worker fed with its own band while the pool grows', async () => {
    // Disjoint bands are what makes a growing pool safe: a worker added later
    // must never be handed integers another worker is already sieving, or the
    // displayed prime list would contain duplicates.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    await start('cpu');
    for (let window = 0; window < 6; window += 1) {
      for (const worker of liveWorkers()) worker.askForBand();
      measureWindow(8);
    }
    const workers = liveWorkers();
    expect(workers.length).toBeGreaterThan(2);
    const lows: number[] = [];
    for (const worker of workers) {
      lows.push(worker.request.low);
      for (const call of worker.postMessage.mock.calls.slice(1)) lows.push(call[0].low);
    }
    expect(new Set(lows).size).toBe(lows.length); // no integer range issued twice
    for (const worker of workers) {
      for (const call of worker.postMessage.mock.calls.slice(1)) {
        expect(call[0].type).toBe('continue-cpu-stress');
        expect(call[0].limit).toBeGreaterThan(call[0].low);
      }
    }
  });

  it('publishes the measurement windows behind each growth decision', async () => {
    // A worker count cannot be audited after the fact; the windows the decision
    // was made from can. Without this, a pool that grew on noise and a pool that
    // grew on real capacity look identical from the outside.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    await start('cpu');
    for (let window = 0; window < 4; window += 1) measureWindow(8);
    const windows: Array<{ workers: number; rate: number; perWorker: number; action: string }> =
      JSON.parse(root.dataset.stressCpuPoolWindows ?? '[]');
    expect(windows.length).toBeGreaterThanOrEqual(3);
    expect(windows.every(window => window.workers >= 2 && window.rate > 0 && window.perWorker > 0
      && typeof window.action === 'string')).toBe(true);
    expect(windows.some(window => window.action === 'grow')).toBe(true);
    expect(windows.some(window => window.workers > 2)).toBe(true);
    expect(windows.at(-1)!.workers).toBeLessThanOrEqual(Number(root.dataset.stressWorkerCount));
  });

  it('publishes the pool\'s compute duty cycle, which falls when workers queue for processors', async () => {
    // Aggregate work-rate is blind to the difference between "the machine has no
    // more capacity" and "these workers are not getting work": both read as a
    // plateau. How much of the wall clock a worker spends sieving versus waiting
    // to be scheduled again is not, and it is what the growth rule stops on.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    Object.assign(window, { __OD_STRESS_TEST_WORKERS__: 2 });
    await start('cpu');
    measureWindow(8);
    measureWindow(8);
    expect(Number(root.dataset.stressCpuBusy)).toBeGreaterThanOrEqual(95);

    const waiting = liveWorkers()[0];
    for (let window = 0; window < 8; window += 1) {
      for (const worker of liveWorkers()) {
        worker.cum += 1000;
        // The waiting worker reports no new sieving time and a full window of
        // time between slices: it is runnable and not being handed a processor.
        if (worker !== waiting) worker.busyMs += CPU_POOL_GROWTH_WINDOW_MS + 200;
        else worker.idleMs += CPU_POOL_GROWTH_WINDOW_MS + 200;
        worker.heartbeat(1_000_000_000_003, 0, Math.round(worker.cum), worker.cursor,
          Math.round(worker.busyMs), Math.round(worker.idleMs));
      }
      fireTimers(CPU_POOL_GROWTH_WINDOW_MS);
      advanceFrame();
    }
    expect(Number(root.dataset.stressCpuBusy)).toBeLessThan(80);
  });

  it('keeps band starvation out of the duty cycle and publishes it separately', async () => {
    // The distinction the growth rule depends on. A worker with no integers to
    // sieve is the page being slow to hand work over; reading that as a full
    // machine would stop growth for the wrong reason, so the worker books the gap
    // as a band wait and the duty cycle never sees it.
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
    Object.assign(window, { __OD_STRESS_TEST_WORKERS__: 2 });
    await start('cpu');
    measureWindow(8);
    measureWindow(8);

    const starved = liveWorkers()[0];
    for (let window = 0; window < 8; window += 1) {
      for (const worker of liveWorkers()) {
        if (worker !== starved) {
          worker.cum += 1000;
          worker.busyMs += CPU_POOL_GROWTH_WINDOW_MS + 200;
        } else {
          // No new work, no new sieving time, and the gap booked as waiting for
          // the page — which must not drag the duty cycle down with it.
          worker.bandWaitMs += CPU_POOL_GROWTH_WINDOW_MS + 200;
        }
        worker.heartbeat(1_000_000_000_003, 0, Math.round(worker.cum), worker.cursor,
          Math.round(worker.busyMs), Math.round(worker.idleMs), Math.round(worker.bandWaitMs));
      }
      fireTimers(CPU_POOL_GROWTH_WINDOW_MS);
      advanceFrame();
    }
    expect(Number(root.dataset.stressCpuBusy)).toBeGreaterThanOrEqual(95);
    expect(Number(root.dataset.stressCpuBandWait)).toBeGreaterThanOrEqual(40);
  });
});
