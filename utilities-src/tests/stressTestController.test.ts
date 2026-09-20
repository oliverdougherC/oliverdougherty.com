/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StressTestController } from '../src/stressTestController';
import { startAdaptiveGpuStress, type StressGpuStressHandle } from '../src/stressTestGpu';
import type { StartCpuStressRequest, StressTestWorkerResponse } from '../src/stressTestWorkerTypes';

vi.mock('../src/stressTestGpu', () => ({ startAdaptiveGpuStress: vi.fn() }));

const productionHtml = readFileSync(resolve(process.cwd(), 'pages/utilities/index.html'), 'utf8');
const gpuStart = vi.mocked(startAdaptiveGpuStress);

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

  get request(): StartCpuStressRequest { return this.postMessage.mock.calls[0][0]; }

  receive(data: StressTestWorkerResponse) {
    for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data }));
  }

  heartbeat(latestPrime: number, primesFound: number, iterations: number) {
    const data: StressTestWorkerResponse = {
      type: 'cpu-stress-heartbeat', requestId: this.request.requestId,
      workerIndex: this.request.workerIndex, latestPrime, primesFound, iterations, checksum: .25
    };
    this.receive(data);
    return data;
  }
}

describe('stress test controller lifecycle', () => {
  let controller: StressTestController;
  let root: HTMLElement;
  let now: number;
  let frameId: number;
  let frames: Map<number, FrameRequestCallback>;

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
      callbacks.onCanvasActive(true);
      return handle;
    });
    return handle;
  }

  beforeEach(() => {
    MockWorker.instances = [];
    now = 1000;
    frameId = 0;
    frames = new Map();
    gpuStart.mockReset().mockResolvedValue(null);
    document.body.innerHTML = new DOMParser().parseFromString(productionHtml, 'text/html').getElementById('stressTestApp')!.outerHTML;
    root = document.getElementById('stressTestApp')!;
    window.history.replaceState(null, '', '#stress-test');
    vi.stubGlobal('Worker', MockWorker);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
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
    expect(document.getElementById('stressStatusText')!.textContent).toContain('GPU stress is unavailable');
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
});
