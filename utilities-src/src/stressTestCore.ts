export type StressMode = 'cpu' | 'gpu' | 'both';
export type StressState = 'idle' | 'starting' | 'running' | 'stopping' | 'unsupported' | 'error';
export type StressGpuBackend = 'webgpu-compute' | 'webgl2-fragment' | 'webgl1-fragment' | 'none';

export interface CpuPoolPlanInput {
  hardwareConcurrency?: number | null;
  /** Diagnostic request for an exact pool size. It may exceed the reported count. */
  exactWorkers?: number | null;
  /** Diagnostic ceiling on the automatic pool. It is a limit, never a request. */
  maxWorkers?: number | null;
}

export interface CpuPoolPlan {
  /** Sanitized `hardwareConcurrency`: a logical-processor hint, not a core count. */
  reported: number;
  /** Workers spawned immediately at Start, before any measurement exists. */
  initial: number;
  /** Growth never passes this. Never below `reported`, so a valid higher report survives. */
  ceiling: number;
  /** True for an exact diagnostic request: the pool is pinned and never grows. */
  pinned: boolean;
}

export interface GpuBackendSupportInput {
  hasWebGpu?: boolean;
  hasWebGl2?: boolean;
  hasWebGl1?: boolean;
}

export type StressEvent = 'start' | 'running' | 'stop' | 'stopped' | 'unsupported' | 'error' | 'reset' | 'retry';

export type CpuPoolGrowthAction = 'none' | 'grow' | 'settled' | 'capped';

const DEFAULT_CPU_WORKERS = 4;

// Hard ceiling on the AUTOMATIC pool. It is a runaway guard against unbounded
// worker creation and the memory each worker's sieve costs — not a claim about
// how many threads a machine has. It never truncates a browser that legitimately
// reports more, because the effective ceiling is `max(reported, this)`.
export const CPU_POOL_MAX_WORKERS = 128;
// One growth step adds half the current pool again (at least two workers), so a
// heavily under-reporting browser reaches capacity in a handful of steps. Coarse
// on purpose: fine-grained steps only add rounds, and every step is a real
// measurement rather than a guess about processor topology.
export const CPU_POOL_GROWTH_STEP_DIVISOR = 2;
export const CPU_POOL_GROWTH_STEP_MIN = 2;
// Evaluation window for the growth signal. Short enough that a machine reporting
// one thread reaches full load in seconds, long enough that hundreds of worker
// heartbeats fill every window (workers report every ~140ms).
export const CPU_POOL_GROWTH_WINDOW_MS = 1000;
// Windows skipped after each step before the next judgement, so a spawn's own
// cost and a new worker's boot are never read as capacity or as contention.
export const CPU_POOL_GROWTH_SETTLE_WINDOWS = 1;
// Windows that report no progress at all are not evidence about capacity, they
// are evidence that nothing is running. Bounded so a stalled pool stops being
// probed instead of ticking forever.
export const CPU_POOL_MAX_IDLE_WINDOWS = 5;
// Upper bound on growth rounds, so a machine whose signal never settles still
// ends up with a fixed pool. The worker ceiling usually binds first.
export const CPU_POOL_MAX_GROWTH_ROUNDS = 24;
// Largest logical-processor count a real configuration reports today (a
// two-socket 128-core part is 4096 threads). A "hint" beyond it is not a
// processor count — it is spoofed, virtualised nonsense, or a bug — and taking
// it literally would mean creating millions of workers, which is exactly the
// runaway this whole path has to prevent. Values inside the bound are honoured
// in full and never rounded down to a historical guess about hardware.
export const CPU_POOL_TRUSTED_REPORT_MAX = 4096;
// How many closed growth windows to keep for inspection. A decision only ever
// depends on the current and previous window, so this is audit history, not
// state — long enough to see a run's whole growth, short enough to publish.
export const CPU_POOL_WINDOW_HISTORY = 16;
/**
 * A compute slice whose wall-clock time reached this multiple of its own
 * wall-clock budget was not running the whole time: the scheduler took the thread
 * away mid-slice. This is real evidence of oversubscription when it happens, but
 * it is rare — measured on a 16-core/32-thread host, 0–1% of slices overran even
 * at 64 workers on 32 threads, because a worker that ends its 8ms slice hands its
 * processor back voluntarily and is not preempted. So this is a secondary stop
 * signal and a published diagnostic; the pool's duty cycle is the primary one.
 */
export const CPU_SLICE_OVERRUN_FACTOR = 1.5;
/**
 * Share of a window's compute slices that must have been descheduled mid-slice
 * before the pool counts itself as having more workers than the machine can run.
 * Measured on a 16-core/32-thread host (docs/utilities/stress-test.md has the
 * sweep): 0% at up to 1.5× the thread count, 1% at 2×, 25% at 3×, 100% at 8×. The
 * threshold sits in the gap between 1% and 25% so ordinary scheduling noise cannot
 * stop growth early, and lands the pool past the thread count — where full load was
 * measured to hold at no measurable throughput cost.
 */
export const CPU_POOL_CONTENTION_SHARE = 0.1;
/**
 * The pool's compute duty cycle: sieving time over sieving plus waiting-to-run
 * time. Published as `data-stress-cpu-busy` and recorded in every growth window,
 * because it separates a pool that cannot get integers to sieve from one that
 * cannot get processors — but it is NOT a growth input. Measured on this same host
 * it stayed at 99–100% from 4 workers all the way to 256 (8× the thread count):
 * Chrome and Windows hand these worker threads a processor the moment their slice
 * ends, so a page cannot see the queueing it would expect from oversubscription.
 * A rule that stopped on it never stopped at all; a rule that ignored the
 * difference would have no way to tell a starved pool from a loaded machine.
 */
export const CPU_POOL_MIN_WINDOW_SLICES = 8;
// A window whose pool completed fewer slices than this measured almost nothing,
// so it is not evidence about the machine. One worker produces roughly 125 slices
// per second, so this floor sits two orders of magnitude below real activity and
// only rejects a pool that is stalled or just started.

/** One closed growth measurement window, as the growth rule saw it. */
export interface CpuPoolGrowthWindow {
  /** Milliseconds since the page's time origin when the window closed. */
  at: number;
  /** Pool size that produced this window's work. */
  workers: number;
  /** Candidates tested during the window. */
  work: number;
  /** Window length in milliseconds (≥ CPU_POOL_GROWTH_WINDOW_MS). */
  elapsed: number;
  /** Candidates per millisecond across the whole pool. */
  rate: number;
  /** Candidates per millisecond per worker — where SMT sharing shows up. */
  perWorker: number;
  /** Improvement over the previous window's rate, or null for the baseline. */
  gain: number | null;
  /** Compute slices the pool completed in this window. */
  slices: number;
  /** Share of those slices that overran their wall-clock budget. */
  slowShare: number | null;
  /** The pool's compute duty cycle over the window, or null if unmeasurable. */
  duty: number | null;
  /** The decision this window produced. */
  action: CpuPoolGrowthAction;
}

/**
 * One window's scheduling measurement across the whole pool: `slowShare` the
 * fraction of compute slices descheduled mid-slice (the growth rule's input),
 * `slices` how many slices that came from — below CPU_POOL_MIN_WINDOW_SLICES it is
 * not evidence — and `duty`, the sieving-time-over-wall-time ratio, which is
 * recorded with every decision for audit but does not decide anything (see
 * CPU_POOL_MIN_WINDOW_SLICES above for the measurement that settled that).
 */
export interface CpuPoolSignal {
  duty: number;
  slowShare: number;
  slices: number;
}

export function isStressMode(value: string | undefined): value is StressMode {
  return value === 'cpu' || value === 'gpu' || value === 'both';
}

export function shouldStressCpu(mode: StressMode) {
  return mode === 'cpu' || mode === 'both';
}

export function shouldStressGpu(mode: StressMode) {
  return mode === 'gpu' || mode === 'both';
}

// A count outside 1…trustedMax carries no information about hardware, so the
// caller gets its fallback instead: the default pool for a report, "hook absent"
// for a diagnostic override (which then shows up as an automatic, non-pinned
// pool in the diagnostics rather than silently pinning something absurd).
function sanitizeWorkerCount(value: number | null | undefined, fallback: number, trustedMax = Number.MAX_SAFE_INTEGER) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0 || count > trustedMax) return fallback;
  return Math.max(1, Math.floor(count));
}

/**
 * Turns the browser's logical-processor hint into an initial pool plus growth
 * bound. `hardwareConcurrency` is an unsigned hint that browsers may round down
 * to physical cores, cap for privacy, or leave stale; it is never halved, never
 * decremented to "reserve" a core (the main thread stays light instead), and
 * never auto-interpreted as needing a simultaneous-multithreading multiplier.
 * The pool starts at the whole report so the machine is loaded immediately, and
 * whatever the report missed is recovered by growing (see CpuPoolGrowth).
 */
export function planCpuPool(input: CpuPoolPlanInput = {}): CpuPoolPlan {
  const reported = sanitizeWorkerCount(input.hardwareConcurrency, DEFAULT_CPU_WORKERS, CPU_POOL_TRUSTED_REPORT_MAX);
  const exact = sanitizeWorkerCount(input.exactWorkers, 0, CPU_POOL_TRUSTED_REPORT_MAX);
  const ceilingHint = sanitizeWorkerCount(input.maxWorkers, 0, CPU_POOL_TRUSTED_REPORT_MAX);
  if (exact > 0) {
    // An exact request is for tests and diagnosis, and it is a REQUEST: asking
    // for more workers than the browser claims is a supported diagnostic.
    return { reported, initial: exact, ceiling: exact, pinned: true } satisfies CpuPoolPlan;
  }
  const guard = Math.max(reported, CPU_POOL_MAX_WORKERS);
  const ceiling = ceilingHint > 0 ? Math.min(guard, ceilingHint) : guard;
  return { reported, initial: Math.min(reported, ceiling), ceiling, pinned: false } satisfies CpuPoolPlan;
}

/** Pool size after one growth step, clamped to the ceiling (equal when at it). */
export function nextCpuWorkerCount(current: number, ceiling: number) {
  const step = Math.max(CPU_POOL_GROWTH_STEP_MIN, Math.ceil(current / CPU_POOL_GROWTH_STEP_DIVISOR));
  return Math.min(ceiling, current + step);
}

/**
 * Decides when the CPU pool is big enough, from one measurement: how much of the
 * wall clock the pool's workers actually spend computing.
 *
 * The question this has to answer is "would another worker get its own logical
 * processor?", and aggregate work-rate cannot answer it. Measured on a
 * 16-core/32-thread host (`scripts/stress-load-harness.js`, whose output the
 * `output/stress-load/*.json` traces in the PR come from), the pool's candidate
 * rate moved only 889M → 1,046M/s — under +18% — while the same run's
 * operating-system load went from 25% to 100% of the machine. Aggregate
 * throughput saturates long before the CPUs do, because a bigger pool buys
 * processors, not a cheaper sieve: memory bandwidth, cache pressure and a deeper
 * search frontier eat what the extra threads could have added. A rule that grows
 * on throughput therefore stops with most of the machine idle, which is the
 * product failure this file exists to fix. The earlier design that read
 * per-worker slowdown stopped even sooner, because simultaneous multithreading
 * makes every worker slower at 24 workers on a machine that is only 80% loaded.
 *
 * Nor can the pool watch its slices get preempted as its only cue, and it cannot
 * watch for queueing at all. Each worker runs a slice whose budget is 8ms of wall
 * clock, checked against that same clock between segments, so a slice that overruns
 * that budget was demonstrably not on a processor the whole time — and that signal
 * is real, but it only appears once the pool is well past the machine: measured at
 * 0% up to 1.5× the thread count, 1% at 2×, 25% at 3×, 100% at 8×. The other
 * candidate, the pool's compute duty cycle (sieving time over sieving plus
 * waiting-to-run time), never moves at all: 99–100% from 4 workers to 256 on a
 * 32-thread host, because a worker whose slice ends is handed a processor again
 * immediately. Queueing that a page can measure simply does not happen here.
 *
 * So growth uses the one signal the platform answers with — the share of slices
 * descheduled mid-slice — and stops once that share passes
 * CPU_POOL_CONTENTION_SHARE, which lands the pool past the thread count. That is
 * the region measured to hold full load at no measurable throughput cost, and it is
 * the safe side of the error: the failure this file exists to fix was landing short.
 *
 * Because the share only appears well past the machine, growth is also bounded from
 * stopping too early by `floor`: the share is only trusted at or above the worker
 * count the browser's own report asked for. Below it the pool grows on the report's
 * authority. That ordering is what keeps an under-reporting browser growing —
 * without it, one noisy window could stop the pool at a fraction of the machine.
 *
 * The pool only ever grows. A worker cannot be removed without abandoning the
 * band of integers it owns, and landing past the plateau costs nothing measured
 * (40, 48, 64, 96, 128 and 256 workers all held 100% load on this host, with
 * aggregate throughput within ~5% of its peak) while stopping one step short leaves
 * 25–45% of the machine idle.
 *
 * Boundaries, all explicit: growth ends at the plan's ceiling (`capped`), after
 * CPU_POOL_MAX_GROWTH_ROUNDS rounds, or when slices start losing their thread at or
 * above the floor (`settled`). A window that produced no work, or too few slices to
 * measure anything, is not evidence about capacity: growth waits rather than
 * inflating, and after CPU_POOL_MAX_IDLE_WINDOWS such windows the pool is treated as
 * stalled.
 */
export class CpuPoolGrowth {
  private windowStartAt = 0;
  private windowStartWork = 0;
  // Only kept so each window's report can show how its rate compared to the one
  // before. It is deliberately not a decision input: window-to-window rate
  // comparison is what left the last design under-loaded.
  private previousRate: number | null = null;
  // Windows to skip before judging again. The window containing a spawn also
  // contains that spawn's main-thread work and the new workers' boot, so judging
  // it would read a startup artefact as either capacity or contention.
  private settleWindows = 1;
  private idleWindows = 0;
  private rounds = 0;
  private finished = false;

  /**
   * @param ceiling pool size growth never passes (a runaway guard, not a hardware claim)
   * @param floor pool size at or above which the duty-cycle reading is trusted as
   *              evidence of a full machine; below it the pool grows on the
   *              browser's own report instead of stopping
   */
  constructor(private readonly ceiling: number, private readonly floor = 0) {
    if (!Number.isSafeInteger(ceiling) || ceiling < 1) throw new Error('Invalid CPU pool growth ceiling.');
    if (!Number.isSafeInteger(floor) || floor < 0) throw new Error('Invalid CPU pool growth floor.');
  }

  /** True once the stop rule or a bound has ended growth for this pool. */
  get done() { return this.finished; }

  /**
   * Every closed measurement window, oldest first, so a decision can be audited
   * against the numbers it was made from instead of being inferred from the
   * worker count it produced. Bounded: only the most recent windows are kept,
   * which is exactly the range a decision depends on.
   */
  readonly windows: CpuPoolGrowthWindow[] = [];

  /**
   * Closes one measurement window. `totalCandidates` is the pool's cumulative
   * candidates tested, `workerCount` the live pool size, and `signal` the
   * duty-cycle and slice-overrun reading the controller measured over its own
   * trailing window across all workers.
   */
  observe(now: number, totalCandidates: number, workerCount: number,
    signal: CpuPoolSignal = { duty: 0, slowShare: 0, slices: 0 }): CpuPoolGrowthAction {
    if (this.finished) return 'none';
    if (!Number.isFinite(now) || !Number.isFinite(totalCandidates) || !Number.isSafeInteger(workerCount) || workerCount < 1) {
      return 'none';
    }
    if (this.windowStartAt === 0) {
      this.windowStartAt = now;
      this.windowStartWork = totalCandidates;
      return 'none';
    }
    const elapsed = now - this.windowStartAt;
    if (elapsed < CPU_POOL_GROWTH_WINDOW_MS) return 'none';
    const work = totalCandidates - this.windowStartWork;
    const rate = work / elapsed;
    this.windowStartAt = now;
    this.windowStartWork = totalCandidates;
    // A share computed from almost no slices says nothing: an idle worker has no
    // overruns for the same reason it has no work.
    const measurable = Number.isFinite(signal.slowShare) && signal.slices >= CPU_POOL_MIN_WINDOW_SLICES;
    const previousRate = this.previousRate;
    this.previousRate = rate;
    const record = (action: CpuPoolGrowthAction) => {
      this.windows.push({
        at: Math.round(now),
        workers: workerCount,
        work: Math.round(work),
        elapsed: Math.round(elapsed),
        rate: Math.round(rate),
        perWorker: Math.round(rate / workerCount),
        gain: previousRate && previousRate > 0 ? Number((rate / previousRate - 1).toFixed(4)) : null,
        slices: Math.round(signal.slices),
        slowShare: Number.isFinite(signal.slowShare) ? Number(signal.slowShare.toFixed(4)) : null,
        duty: Number.isFinite(signal.duty) ? Number(signal.duty.toFixed(4)) : null,
        action
      });
      if (this.windows.length > CPU_POOL_WINDOW_HISTORY) this.windows.shift();
      return action;
    };
    if (work <= 0 || !measurable) {
      // Nothing ran, or too little to measure anything. That is not a reason to
      // grow — an idle pool grown on this signal would inflate forever.
      this.idleWindows += 1;
      if (this.idleWindows >= CPU_POOL_MAX_IDLE_WINDOWS) this.finished = true;
      return record(this.finished ? 'settled' : 'none');
    }
    this.idleWindows = 0;
    if (this.settleWindows > 0) {
      this.settleWindows -= 1;
      return record('none');
    }
    // Below the reported processor count the measured share is not trusted: it only
    // appears well past the machine, and stopping on a reading the pool cannot
    // attribute is exactly how an under-reporting browser stayed under-loaded.
    if (workerCount >= this.floor && signal.slowShare >= CPU_POOL_CONTENTION_SHARE) {
      this.finished = true;
      return record('settled');
    }
    return record(this.grow(workerCount));
  }

  private grow(workerCount: number): CpuPoolGrowthAction {
    if (this.rounds >= CPU_POOL_MAX_GROWTH_ROUNDS) {
      this.finished = true;
      return 'settled';
    }
    if (nextCpuWorkerCount(workerCount, this.ceiling) <= workerCount) {
      this.finished = true;
      return 'capped';
    }
    this.rounds += 1;
    this.settleWindows = CPU_POOL_GROWTH_SETTLE_WINDOWS;
    return 'grow';
  }
}

export function resolveGpuBackend(input: GpuBackendSupportInput): StressGpuBackend {
  return resolveGpuBackendFallbacks(input)[0] ?? 'none';
}

export function resolveGpuBackendFallbacks(input: GpuBackendSupportInput): StressGpuBackend[] {
  const backends: StressGpuBackend[] = [];
  if (input.hasWebGpu) {
    backends.push('webgpu-compute');
  }
  if (input.hasWebGl2) {
    backends.push('webgl2-fragment');
  }
  if (input.hasWebGl1) {
    backends.push('webgl1-fragment');
  }
  return backends.length ? backends : ['none'];
}

export function transitionStressState(state: StressState, event: StressEvent): StressState {
  switch (event) {
    case 'reset':
      return 'idle';
    case 'retry':
      return state === 'error' || state === 'unsupported' ? 'starting' : state;
    case 'error':
      return state === 'starting' || state === 'running' || state === 'stopping' ? 'error' : state;
    case 'unsupported':
      return 'unsupported';
    case 'start':
      return state === 'idle' || state === 'unsupported' || state === 'error' ? 'starting' : state;
    case 'running':
      return state === 'starting' ? 'running' : state;
    case 'stop':
      return state === 'starting' || state === 'running' ? 'stopping' : state;
    case 'stopped':
      return state === 'stopping' ? 'idle' : state;
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

export function formatStressElapsed(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const dayRemainder = totalSeconds % 86_400;
  const hours = Math.floor(dayRemainder / 3600);
  const minutes = Math.floor((dayRemainder % 3600) / 60);
  const seconds = dayRemainder % 60;

  if (days > 0) {
    return `${days}d ${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
