/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StressTestController } from '../src/stressTestController';
import {
  CPU_POOL_FALLBACK_WORKERS,
  CPU_POOL_MAX_REPLACEMENTS,
  CPU_POOL_REPORT_TIMEOUT_MS,
  CPU_POOL_TRUSTED_REPORT_MAX
} from '../src/stressTestCore';
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

/**
 * Stand-in for a dedicated worker.
 *
 * The real one answers with its own `navigator.hardwareConcurrency` as soon as it
 * loads and then computes until it is terminated, so this mock delivers the ready
 * report on a microtask (a worker load is never synchronous with the page) and
 * otherwise only speaks when a test puts a message in its mouth. `workerReport = null`
 * models a worker that loads and never answers, which the page must survive.
 */
class MockWorker {
  static instances: MockWorker[] = [];
  // Construction-failure simulation applies only to real workload spawns;
  // the module-worker support probe passes a string blob URL.
  static realSpawns = 0;
  static failRealAfter = Number.POSITIVE_INFINITY;
  // Models a browser where the workload chunk answers after the page's bounded
  // startup wait has run out, while an inline probe answers at once: the sizing must
  // come from the probe, because that is the case the real browser produces.
  static chunkSilent = false;
  // Models a worker script that throws as it loads: the worker answers `ready`
  // never, and its error listener fires instead.
  static failOnLoad = false;
  // What `navigator.hardwareConcurrency` reads as inside the worker. Defaults to the
  // page's mocked report, because in a browser that does not tamper with the API the
  // two scopes say the same thing.
  static workerReport: number | null = 2;

  readonly listeners = new Map<string, Set<EventListener>>();
  readonly postMessage = vi.fn();
  stopped = false;
  readonly terminate = vi.fn(() => { this.stopped = true; });
  // Running progress counters the test driver maintains per worker.
  cum = 0;
  cursor = 1;
  blocks = 0;

  constructor(url?: unknown) {
    // The workload worker is constructed with a URL object; the one-shot report probe
    // is built from a blob URL string and never joins the pool.
    const isWorkloadWorker = typeof url !== 'string';
    if (isWorkloadWorker && ++MockWorker.realSpawns > MockWorker.failRealAfter) {
      throw new Error('Simulated worker quota exceeded');
    }
    MockWorker.instances.push(this);
    if (MockWorker.failOnLoad && isWorkloadWorker) {
      const failed = new ErrorEvent('error', { message: 'worker script failed to load' });
      void Promise.resolve().then(() => {
        if (this.stopped) return;
        for (const listener of this.listeners.get('error') ?? []) listener(failed);
      });
      return;
    }
    const report = MockWorker.workerReport;
    if (report === null || (MockWorker.chunkSilent && isWorkloadWorker)) return;
    if (!isWorkloadWorker) {
      // A blob-URL worker is the report probe, whose whole protocol is one bare number.
      void Promise.resolve().then(() => {
        if (!this.stopped) this.receive(report);
      });
      return;
    }
    void Promise.resolve().then(() => {
      if (!this.stopped) this.receive({ type: 'cpu-stress-ready', hardwareConcurrency: report });
    });
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }

  get request(): StartCpuStressRequest { return this.postMessage.mock.calls[0][0]; }
  get terminated() { return this.terminate.mock.calls.length > 0; }

  receive(data: StressTestWorkerResponse | number) {
    for (const listener of this.listeners.get('message') ?? []) listener(new MessageEvent('message', { data }));
  }

  fault(message: string) {
    this.receive({ type: 'cpu-stress-error', requestId: this.request.requestId,
      workerIndex: this.request.workerIndex, message });
  }

  progress(latestPrime: number, primesFound: number, candidates: number, rangeLow = this.cursor,
    blocks = this.blocks) {
    const data: StressTestWorkerResponse = {
      type: 'cpu-stress-progress', requestId: this.request.requestId,
      workerIndex: this.request.workerIndex, latestPrime, primesFound, candidates, checksum: .25, rangeLow, blocks
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

  // Timers are captured rather than waited out: pool creation is burst-spawned on
  // `setTimeout(…, 0)`, and the one bounded startup wait is a timer too. Every delay
  // the page asks for is recorded, because "no adaptive sizing timer exists" is only
  // meaningful as a statement about the timers that were actually requested.
  let timers: Map<number, () => void>;
  let timerId = 0;
  let timerDelays: number[];

  function fireTimers(elapsedMs = 0) {
    now += elapsedMs;
    const due = [...timers.values()];
    timers.clear();
    for (const callback of due) callback();
  }

  /** Live workers only: a terminated one never reports again in a real browser. */
  const liveWorkers = () => MockWorker.instances.filter(worker => worker.postMessage.mock.calls.length > 0 && !worker.terminated);

  async function settle(turns = 12) {
    for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
  }

  /**
   * Clicks Start and lets the run reach the pool its plan asked for, including the
   * burst-spawn follow-ups. A pool that needed a worker report waits for it first,
   * which is why this is async and everything else in the suite can stay synchronous.
   */
  async function start(mode: 'cpu' | 'gpu' | 'both' = 'both') {
    root.querySelector<HTMLButtonElement>(`[data-stress-mode-option="${mode}"]`)!.click();
    click('stressStartBtn');
    await settle();
    for (let pass = 0; pass < 40 && timers.size > 0; pass += 1) fireTimers(0);
    await settle();
    advanceFrame();
  }

  /**
   * Time passing with the pool reporting work at `perWorker` candidates a window.
   * The fixed pool has nothing to decide, so this exists to be *observed*: a test
   * that watches a pool stay the same size needs the run to keep running.
   */
  function runWindow(perWorker = 1000) {
    for (const worker of liveWorkers()) {
      worker.cum += perWorker;
      worker.blocks += 1;
      worker.progress(1_000_000_000_003, 0, Math.round(worker.cum), worker.cursor, worker.blocks);
    }
    fireTimers(0);
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
    MockWorker.failOnLoad = false;
    MockWorker.chunkSilent = false;
    MockWorker.workerReport = 2;
    now = 1000;
    frameId = 0;
    frames = new Map();
    timerDelays = [];
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
    vi.spyOn(window, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
      timerId += 1;
      timerDelays.push(Number(delay ?? 0));
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
    Reflect.deleteProperty(window, '__OD_STRESS_TEST_WORKERS__');
    document.body.innerHTML = '';
  });

  describe('fixed pool sizing', () => {
    it('creates exactly the reported number of workers and stops at that number', async () => {
      // The whole requirement, stated as an assertion: 12 reported means 12
      // workers, and no later moment in the run changes that.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(12);
      MockWorker.workerReport = 12;
      await start('cpu');
      expect(root.dataset.stressState).toBe('running');
      expect(workloadWorkers()).toHaveLength(12);
      expect(root.dataset.stressCpuReport).toBe('12');
      expect(root.dataset.stressCpuPoolSize).toBe('12');
      expect(root.dataset.stressCpuPoolSource).toBe('report');
      expect(root.dataset.stressWorkerCount).toBe('12');
      // One worker per processor, one activity bar per worker, and every worker
      // told the same pool size so its lane arithmetic matches its neighbours'.
      expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(12);
      for (const worker of workloadWorkers()) {
        expect(worker.request).toMatchObject({ type: 'start-cpu-stress', poolSize: 12 });
      }
      expect(new Set(workloadWorkers().map(worker => worker.request.workerIndex)).size).toBe(12);

      for (let window = 0; window < 20; window += 1) runWindow();
      expect(liveWorkers()).toHaveLength(12);
      // Started workers only: nothing was ever added or replaced. The module-worker
      // support probe constructs a throwaway worker that never joins the pool.
      expect(MockWorker.realSpawns).toBe(12);
    });

    it.each([1, 2, 3, 6, 7, 12, 14, 16, 22, 32, 48, 96, 128])('holds a pool of %i logical processors', async (reported) => {
      // Representative values including non-powers of two. Nothing rounds a report
      // to a topology, and nothing caps a legitimate count.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(reported);
      MockWorker.workerReport = reported;
      await start('cpu');
      expect(workloadWorkers()).toHaveLength(reported);
      expect(root.dataset.stressCpuPoolSize).toBe(String(reported));
      for (let window = 0; window < 4; window += 1) runWindow();
      expect(liveWorkers()).toHaveLength(reported);
    });

    it('sizes from the worker scope when the page report has been reduced', async () => {
      // Measured on the affected host: the browser reported 12 of 32 logical
      // processors in window scope — its fingerprint protection replaces the value,
      // and it varies between launches — while the page's own workers reported 32.
      // The pool follows the count the workers state, by reading it, not by scaling
      // the page's number: 12 never becomes 32 through arithmetic.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(12);
      MockWorker.workerReport = 32;
      await start('cpu');
      expect(root.dataset.stressCpuReportPage).toBe('12');
      expect(root.dataset.stressCpuReportWorker).toBe('32');
      expect(root.dataset.stressCpuReport).toBe('32');
      expect(workloadWorkers()).toHaveLength(32);
      for (let window = 0; window < 6; window += 1) runWindow();
      expect(liveWorkers()).toHaveLength(32);
    });

    it('sizes from the report probe when the workload worker answers too late', async () => {
      // Measured on the affected browser: its workload worker did report the machine's
      // real count, but only after the bounded startup wait had already sized the pool
      // from the reduced window number — so the pool came out short. A one-shot probe
      // with nothing to import is what gets that count in time to be used.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(16);
      MockWorker.workerReport = 32;
      MockWorker.chunkSilent = true;
      await start('cpu');
      expect(root.dataset.stressCpuReportPage).toBe('16');
      expect(root.dataset.stressCpuReportWorker).toBe('32');
      expect(root.dataset.stressCpuReport).toBe('32');
      expect(workloadWorkers()).toHaveLength(32);
      // The probe is not a pool worker: the pool is exactly the plan, and every worker
      // that was not given a lane has been terminated.
      expect(MockWorker.realSpawns).toBe(32);
      const lingering = MockWorker.instances.filter(worker => !worker.terminated
        && worker.postMessage.mock.calls.length === 0);
      expect(lingering).toHaveLength(0);
    });

    it('holds the exact diagnostic request of 32 against a report of 12', async () => {
      // The explicit regression: report 12, exact override 32 → exactly 32, and it
      // stays 32. The hook is a request, so it is never clamped to the report.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(12);
      MockWorker.workerReport = 12;
      Object.assign(window, { __OD_STRESS_TEST_WORKERS__: 32 });
      await start('cpu');
      expect(workloadWorkers()).toHaveLength(32);
      expect(root.dataset.stressCpuReport).toBe('32');
      expect(root.dataset.stressCpuPoolSize).toBe('32');
      expect(root.dataset.stressCpuPoolSource).toBe('exact');
      expect(root.dataset.stressWorkerCount).toBe('32');
      // And the plan is still visible as what the browser actually said, so a
      // diagnostic 32 is never mistaken for detected 32.
      expect(root.dataset.stressCpuReportPage).toBe('12');
      for (let window = 0; window < 10; window += 1) runWindow();
      expect(liveWorkers()).toHaveLength(32);
      expect(MockWorker.realSpawns).toBe(32); // workload workers only; the report probe is separate
    });

    it('ignores an exact request that is not a usable processor count', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
      MockWorker.workerReport = 4;
      Object.assign(window, { __OD_STRESS_TEST_WORKERS__: CPU_POOL_TRUSTED_REPORT_MAX + 1 });
      await start('cpu');
      // Spawning 4097 workers from a typo diagnoses nothing. The pool stays at the
      // report and `source` says so, rather than pretending to be an override.
      expect(workloadWorkers()).toHaveLength(4);
      expect(root.dataset.stressCpuPoolSource).toBe('report');
    });

    it('sizes from the page report when no worker ever answers', async () => {
      // The startup wait is bounded: a worker that loads and stays silent cannot
      // leave Start hanging, and the pool is then built from what the page knows.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);
      MockWorker.workerReport = null;
      root.querySelector<HTMLButtonElement>('[data-stress-mode-option="cpu"]')!.click();
      click('stressStartBtn');
      await settle();
      expect(workloadWorkers()).toHaveLength(0); // still waiting, within the bound
      expect(timerDelays).toContain(CPU_POOL_REPORT_TIMEOUT_MS);
      fireTimers(CPU_POOL_REPORT_TIMEOUT_MS); // the bound expires
      for (let pass = 0; pass < 20 && timers.size > 0; pass += 1) fireTimers(0);
      await settle();
      advanceFrame();
      expect(workloadWorkers()).toHaveLength(8);
      expect(root.dataset.stressCpuReportWorker).toBe('0');
      expect(root.dataset.stressCpuReport).toBe('8');
      expect(root.dataset.stressCpuPoolSize).toBe('8');
    });

    it('falls back to a small documented pool when nothing reports a count', async () => {
      // A fallback must never be presented as the machine's processor count: the
      // published report stays 0 and the source says `fallback`.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(0);
      MockWorker.workerReport = null;
      root.querySelector<HTMLButtonElement>('[data-stress-mode-option="cpu"]')!.click();
      click('stressStartBtn');
      await settle();
      fireTimers(CPU_POOL_REPORT_TIMEOUT_MS);
      for (let pass = 0; pass < 20 && timers.size > 0; pass += 1) fireTimers(0);
      await settle();
      advanceFrame();
      expect(workloadWorkers()).toHaveLength(CPU_POOL_FALLBACK_WORKERS);
      expect(root.dataset.stressCpuReport).toBe('0');
      expect(root.dataset.stressCpuPoolSource).toBe('fallback');
      expect(root.dataset.stressCpuPoolSize).toBe(String(CPU_POOL_FALLBACK_WORKERS));
    });

    it('holds 32 workers through a collapsing rate, block overruns and elapsed time', async () => {
      // Everything that used to move the pool, moved by a test instead of asserted
      // away: aggregate throughput falling by 90%, workers racing through their
      // blocks, elapsed time stretching, and messages arriving out of order. None of
      // it is a measurement the pool reads any more, so the count cannot move.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(32);
      MockWorker.workerReport = 32;
      await start('cpu');
      expect(liveWorkers()).toHaveLength(32);
      const workers = liveWorkers();

      for (let step = 0; step < 30; step += 1) {
        const rate = Math.max(1, 1000 * Math.pow(0.85, step)); // −90%+ collapse
        for (const [index, worker] of workers.entries()) {
          worker.cum += rate;
          worker.blocks += 4 + index; // blocks raced ahead, unevenly per lane
          worker.progress(1_000_000_000_003, 0, Math.round(worker.cum), worker.cursor, worker.blocks);
        }
        if (step % 7 === 0) now += 30_000; // long gaps between reports
        fireTimers(0);
        advanceFrame();
      }
      expect(liveWorkers()).toHaveLength(32);
      expect(MockWorker.realSpawns).toBe(32); // workload workers only; the report probe is separate
      expect(root.dataset.stressCpuPoolSize).toBe('32');
      expect(root.dataset.stressWorkerCount).toBe('32');
      Reflect.deleteProperty(window, '__OD_STRESS_TEST_WORKERS__');
    });

    it('requests no adaptive-sizing timer at any point in the run', async () => {
      // "No growth timers remain" has to mean something observable. The only timer
      // this page is allowed to ask for is the bounded startup report wait and the
      // 0-delay bursts that space worker creation; a repeating one-second window is
      // exactly what a resizing policy runs on, and it is never requested.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(12);
      MockWorker.workerReport = 12;
      await start('cpu');
      for (let window = 0; window < 10; window += 1) runWindow();
      click('stressStopBtn');
      const sizingTimers = timerDelays.filter(delay => delay >= 1000 && delay !== CPU_POOL_REPORT_TIMEOUT_MS);
      expect(sizingTimers).toEqual([]);
      expect(timerDelays.every(delay => delay === 0 || delay === CPU_POOL_REPORT_TIMEOUT_MS)).toBe(true);
    });

    it('hands every worker a distinct lane of one pool size, with nothing allocated by the page', async () => {
      // The main thread sends exactly one message per worker: its lane index and the
      // pool size. There is no second message type, because there is no work for the
      // page to hand out.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(12);
      MockWorker.workerReport = 12;
      await start('cpu');
      const workers = workloadWorkers();
      expect(workers).toHaveLength(12);
      for (const worker of workers) {
        expect(worker.postMessage.mock.calls).toHaveLength(1);
        expect(worker.request).toEqual({ type: 'start-cpu-stress', requestId: worker.request.requestId,
          workerIndex: worker.request.workerIndex, poolSize: 12 });
      }
      // A worker that asks for nothing still advances: the pool counts its progress,
      // and a lane that stops advancing is visible as one stalled number.
      workers[0].progress(1_000_000_000_163, 4, 5000, 1 + 2 ** 31, 3);
      advanceFrame();
      expect(root.dataset.stressCpuBlocks).toBe('3');
      expect((document.getElementById('stressWorkerActivity')!.children[0] as HTMLElement).dataset.blocks).toBe('3');
      expect(root.dataset.stressLatestPrime).toBe('1000000000163');
    });
  });

  describe('pool lifetime', () => {
    it('creates a fresh pool for a restart and tears the previous one down completely', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(6);
      MockWorker.workerReport = 6;
      await start('cpu');
      const first = workloadWorkers();
      expect(first).toHaveLength(6);
      click('stressStopBtn');
      expect(liveWorkers()).toHaveLength(0);
      for (const worker of first) expect(worker.terminate).toHaveBeenCalledOnce();
      expect(timers.size).toBe(0); // no startup or spawn work survived the stop

      const spawned = MockWorker.realSpawns;
      await start('cpu');
      expect(liveWorkers()).toHaveLength(6);
      expect(MockWorker.realSpawns).toBe(spawned + 6);
      // A new run is a new plan, not a continuation of the previous pool's size.
      expect(root.dataset.stressCpuPoolSize).toBe('6');
      expect(root.dataset.stressWorkerCount).toBe('6');
    });

    it('terminates every worker without waiting for one to acknowledge the stop', async () => {
      // The workers are inside a compute loop and read nothing, so termination is
      // the only stop path there is. A busy worker that must agree first would make
      // Stop depend on the workload; here it never does.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(32);
      MockWorker.workerReport = 32;
      await start('cpu');
      const workers = liveWorkers();
      expect(workers).toHaveLength(32);
      click('stressStopBtn');
      for (const worker of workers) {
        expect(worker.terminate).toHaveBeenCalledOnce();
        expect(worker.removeEventListener).toBeDefined();
      }
      expect(root.dataset.stressState).toBe('idle');
      expect(root.dataset.stressWorkerCount).toBe('0');
      expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(0);
      expect(root.dataset.stressCpuPoolSize).toBeUndefined();
      expect(root.dataset.stressCpuReport).toBeUndefined();
    });

    it('does not build a pool whose run was stopped while it waited for a report', async () => {
      // Rapid Start → Stop → Start must not leak the workers of a start that never
      // finished: the pending report wait is cancelled with the run that asked.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(16);
      MockWorker.workerReport = null; // nobody answers until the bound expires
      root.querySelector<HTMLButtonElement>('[data-stress-mode-option="cpu"]')!.click();
      click('stressStartBtn');
      await settle();
      expect(root.dataset.stressState).toBe('starting');
      click('stressStopBtn');
      expect(timers.size).toBe(0);
      const spawned = MockWorker.instances.length;
      await settle();
      expect(MockWorker.instances).toHaveLength(spawned); // nothing spawned afterwards
      expect(root.dataset.stressState).toBe('idle');
      expect(root.dataset.stressWorkerCount).toBe('0');

      MockWorker.workerReport = 16;
      await start('cpu');
      expect(liveWorkers()).toHaveLength(16); // the next run is unaffected
    });

    it('ends the start when the worker meant to be lane 0 dies while the report is awaited', async () => {
      // The served-page case this covers is a worker script that 404s: the pool's
      // first worker is constructed, never answers, and fails as it loads. The start
      // must end honestly rather than planning a pool around a record that is gone.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(8);
      MockWorker.workerReport = 8;
      MockWorker.failOnLoad = true;
      MockWorker.failRealAfter = 1 + CPU_POOL_MAX_REPLACEMENTS; // retries stay bounded
      root.querySelector<HTMLButtonElement>('[data-stress-mode-option="cpu"]')!.click();
      click('stressStartBtn');
      for (let pass = 0; pass < 8; pass += 1) await settle(6);
      expect(root.dataset.stressState).toBe('error');
      // The bounded wait then expires for a run that is already over: no pool is
      // published, and no further workers appear.
      fireTimers(CPU_POOL_REPORT_TIMEOUT_MS);
      for (let pass = 0; pass < 4; pass += 1) await settle(6);
      expect(liveWorkers()).toHaveLength(0);
      expect(MockWorker.realSpawns).toBeLessThanOrEqual(1 + CPU_POOL_MAX_REPLACEMENTS);
      expect(root.dataset.stressCpuPoolSize).toBeUndefined();
      expect(root.dataset.stressWorkerCount).toBe('0');
      expect(root.dataset.stressCpuPoolLimitation).toContain('no workers left');
      expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(0);
    });

    it('replaces a faulted worker at the same lane and keeps the requested count', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
      MockWorker.workerReport = 4;
      await start('cpu');
      expect(liveWorkers()).toHaveLength(4);
      const faulted = liveWorkers()[1];
      const lanes = liveWorkers().map(worker => worker.request.workerIndex).sort();
      faulted.fault('simulated sieve fault');
      expect(faulted.terminated).toBe(true);
      expect(liveWorkers()).toHaveLength(4); // the count the run asked for, still
      expect(liveWorkers().map(worker => worker.request.workerIndex).sort()).toEqual(lanes);
      // The replacement sieves the dead worker's lane at the original pool size, so
      // it cannot widen the pool or leave a hole in the number line.
      const replacement = liveWorkers().find(worker => worker.request.workerIndex === faulted.request.workerIndex)!;
      expect(replacement.request.poolSize).toBe(4);
      expect(root.dataset.stressState).toBe('running');
      expect(root.dataset.stressCpuPoolLimitation).toBeUndefined();
      expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(4);
    });

    it('publishes the shortfall when a faulted lane cannot be replaced', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
      MockWorker.workerReport = 4;
      await start('cpu');
      MockWorker.failRealAfter = MockWorker.realSpawns; // no replacement can be built
      liveWorkers()[0].fault('simulated sieve fault');
      expect(root.dataset.stressState).toBe('running');
      expect(liveWorkers()).toHaveLength(3);
      // A smaller pool is never presented as the pool that was asked for.
      expect(root.dataset.stressWorkerCount).toBe('3');
      expect(root.dataset.stressCpuPoolLimitation).toContain('3 of 4');
      expect(root.dataset.stressCpuPoolLimitation).toContain('simulated sieve fault');
      expect(document.getElementById('stressWorkerSummary')!.textContent).toContain('3 of 4');
    });

    it('bounds replacement so a worker that fails on load cannot spin forever', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
      MockWorker.workerReport = 4;
      await start('cpu');
      expect(liveWorkers()).toHaveLength(4);
      const built = MockWorker.realSpawns;
      // Every replacement dies as it loads. Without a bound the page would keep
      // creating workers into a script that cannot run.
      MockWorker.failOnLoad = true;
      for (const worker of [...liveWorkers()]) worker.fault('simulated sieve fault');
      for (let pass = 0; pass < 60; pass += 1) await settle(4);
      expect(root.dataset.stressState).toBe('error');
      expect(liveWorkers()).toHaveLength(0);
      expect(MockWorker.realSpawns - built).toBeLessThanOrEqual(CPU_POOL_MAX_REPLACEMENTS + 1);
      expect(root.dataset.stressCpuPoolLimitation).toContain('no workers left');
    });

    it('ends the CPU workload when the last worker faults and keeps the GPU running', async () => {
      const gpu = availableGpu();
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
      MockWorker.workerReport = 2;
      MockWorker.failRealAfter = 2; // the two workers start; nothing can replace them
      await start('both');
      expect(root.dataset.stressState).toBe('running');
      for (const worker of [...liveWorkers()]) worker.fault('simulated sieve fault');
      // Documented combined-mode behaviour: the CPU workload says it died, the GPU
      // keeps running, and the page does not pretend both are still loaded.
      expect(root.dataset.stressState).toBe('running');
      expect(gpu.stop).not.toHaveBeenCalled();
      expect(root.dataset.stressWorkerCount).toBe('0');
      expect(root.dataset.stressCpuPoolLimitation).toContain('no workers left');
      expect(root.dataset.stressCpuPoolLimitation).toContain('simulated sieve fault');
      expect(root.dataset.stressGpuBackend).toBe('webgpu-compute');
      click('stressStopBtn');
      expect(root.dataset.stressState).toBe('idle');
    });

    it('reports an error rather than an idle page when the CPU-only run has no workers left', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(1);
      MockWorker.workerReport = 1;
      MockWorker.failRealAfter = 1; // the single worker starts; no replacement possible
      await start('cpu');
      expect(liveWorkers()).toHaveLength(1);
      liveWorkers()[0].fault('simulated sieve fault');
      expect(root.dataset.stressState).toBe('error');
      expect(root.dataset.stressGpuLastError).toContain('simulated sieve fault');
    });

    it('reports the shortfall and keeps the run when the pool cannot be built as requested', async () => {
      // Worker creation can genuinely fail (quota, memory pressure). The workers
      // that did get created keep computing and the gap is published — but a run
      // with no workers at all is an error, not an idle page.
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(20);
      MockWorker.workerReport = 20;
      MockWorker.failRealAfter = 10;
      root.querySelector<HTMLButtonElement>('[data-stress-mode-option="cpu"]')!.click();
      click('stressStartBtn');
      await settle();
      for (let pass = 0; pass < 20 && timers.size > 0; pass += 1) fireTimers(0);
      await settle();
      advanceFrame();
      expect(root.dataset.stressState).toBe('running');
      expect(liveWorkers()).toHaveLength(10);
      expect(root.dataset.stressCpuPoolSize).toBe('20'); // what was asked for
      expect(root.dataset.stressWorkerCount).toBe('10'); // what is actually running
      expect(root.dataset.stressCpuPoolLimitation).toContain('Simulated worker quota exceeded');
      const attempts = MockWorker.realSpawns;
      for (let window = 0; window < 4; window += 1) runWindow();
      expect(MockWorker.realSpawns).toBe(attempts); // and it does not keep trying
    });

    it('fails the start when the pool cannot be built at all', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(6);
      MockWorker.workerReport = 6;
      MockWorker.failRealAfter = 0; // even the first worker cannot be constructed
      await start('cpu');
      expect(root.dataset.stressState).toBe('error');
      expect(document.getElementById('stressWorkerActivity')!.children).toHaveLength(0);
      expect(root.dataset.stressWorkerCount).toBe('0');
      expect(root.dataset.stressCpuPoolSize).toBeUndefined();
    });

    it('ignores progress and faults from a worker of an earlier run', async () => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(2);
      MockWorker.workerReport = 2;
      await start('cpu');
      const previous = workloadWorkers();
      const staleListener = [...previous[0].listeners.get('message')!][0];
      const staleMessage = previous[0].progress(1_000_000_000_039, 1, 50) as StressTestWorkerResponse;
      click('stressStopBtn');
      await start('cpu');
      const spawns = MockWorker.realSpawns;
      staleListener(new MessageEvent('message', { data: { ...staleMessage, type: 'cpu-stress-progress',
        latestPrime: 1_000_000_000_163, primesFound: 99, candidates: 9e9 } }));
      staleListener(new MessageEvent('message', { data: { type: 'cpu-stress-error',
        requestId: previous[0].request.requestId, workerIndex: 0, message: 'stale fault' } }));
      advanceFrame();
      // The new run is untouched by the old one's messages: no phantom work, and no
      // replacement triggered by a fault that belongs to a terminated worker.
      expect(root.dataset.stressLatestPrime).toBe('0');
      expect(root.dataset.stressCandidates).toBe('0');
      expect(liveWorkers()).toHaveLength(2);
      expect(MockWorker.realSpawns).toBe(spawns);
    });
  });

  describe('aggregation and reporting', () => {
    it('aggregates real worker totals without allowing slower or duplicate reports to rewind the largest prime', async () => {
      await start('cpu');
      expect(root.dataset.stressState).toBe('running');
      expect(gpuStart).not.toHaveBeenCalled();
      const [first, second] = workloadWorkers();
      expect(workloadWorkers()).toHaveLength(2);
      expect(first.request.workerIndex).toBe(0);
      expect(second.request.workerIndex).toBe(1);
      // Lanes are disjoint by construction: worker i owns block i of the pool.
      expect(second.request.poolSize).toBe(first.request.poolSize);
      first.progress(1_000_000_000_103, 3, 100);
      second.progress(1_000_000_000_039, 2, 70);
      advanceFrame();
      expect(root.dataset.stressLatestPrime).toBe('1000000000103');
      expect(document.getElementById('stressLatestPrime')!.textContent).toBe('1,000,000,000,103');
      expect(root.dataset.stressPrimesFound).toBe('5');
      expect(root.dataset.stressCandidates).toBe('170');

      first.progress(1_000_000_000_163, 5, 150);
      first.progress(1_000_000_000_163, 5, 150);
      second.progress(1_000_000_000_039, 1, 50);
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

      for (let tick = 1; tick <= 10; tick += 1) {
        first.progress(1_000_000_000_003, 1, tick * 500);
        second.progress(1_000_000_000_009, 1, tick * 500);
        advanceFrame();
      }
      expect(root.dataset.stressCandidates).toBe('10000');
      expect(root.dataset.stressCandidatesPerSecond).toBe('5000');
      expect(document.getElementById('stressPrimeSummary')!.textContent).toContain('5,000 candidates/s');

      for (let tick = 0; tick < 15; tick += 1) advanceFrame();
      expect(root.dataset.stressCandidatesPerSecond).toBe('2000');
      for (let tick = 0; tick < 10; tick += 1) advanceFrame();
      expect(root.dataset.stressCandidatesPerSecond).toBe('0');

      click('stressStopBtn');
      expect(root.dataset.stressCandidatesPerSecond).toBe('0');
      expect(document.getElementById('stressPrimeSummary')!.textContent).toContain('0 candidates/s');
    });

    it('stops both workloads, clears worker activity, preserves the result, and ignores an already queued heartbeat', async () => {
      const gpu = availableGpu();
      await start();
      const workers = workloadWorkers();
      const staleListener = [...workers[0].listeners.get('message')!][0];
      const staleMessage = workers[0].progress(1_000_000_000_039, 1, 50);
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
      staleListener(new MessageEvent('message', { data: { ...staleMessage, type: 'cpu-stress-progress',
        latestPrime: 1_000_000_000_163, primesFound: 99, checksum: .75 } }));
      advanceFrame();
      // Checksum is written immediately by the handler, even without a metric frame.
      expect(root.dataset.stressLastChecksum).toBe('0.25');
      expect(root.dataset.stressLatestPrime).toBe('1000000000039');
      expect(root.dataset.stressPrimesFound).toBe('1');
      expect((document.getElementById('stressStartBtn') as HTMLButtonElement).disabled).toBe(false);
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

    it('terminates every worker when the controller is disposed mid-run', async () => {
      await start('cpu');
      const workers = workloadWorkers();
      controller.dispose();
      controller = null as unknown as StressTestController;
      for (const worker of workers) expect(worker.terminate).toHaveBeenCalledOnce();
      expect(timers.size).toBe(0);
    });
  });

  describe('gpu and combined modes', () => {
    it('runs GPU-only mode without creating CPU workers', async () => {
      availableGpu();
      await start('gpu');
      expect(root.dataset.stressState).toBe('running');
      expect(workloadWorkers()).toHaveLength(0);
      expect(root.dataset.stressWorkerCount).toBe('0');
      expect(root.dataset.stressGpuBackend).toBe('webgpu-compute');
      expect(root.dataset.stressGpuCanvasActive).toBe('true');
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

    it('does not revive combined mode when the CPU workload dies before a pending GPU startup', async () => {
      // The CPU workload is already dead by the time the adapter arrives: the late
      // handle is released instead of being installed onto a run that errored out.
      let resolveGpu!: (gpu: StressGpuStressHandle) => void;
      gpuStart.mockReturnValue(new Promise(resolve => { resolveGpu = resolve; }));
      MockWorker.failRealAfter = 2; // no lane can be replaced
      await start('both');
      expect(root.dataset.stressState).toBe('starting');
      for (const worker of [...liveWorkers()]) worker.fault('worker failed');
      expect(root.dataset.stressState).toBe('error');
      const lateGpu = { backend: 'webgpu-compute' as const, getWorkloadLevel: () => 1, stop: vi.fn() };
      resolveGpu(lateGpu);
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
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
  });
});
