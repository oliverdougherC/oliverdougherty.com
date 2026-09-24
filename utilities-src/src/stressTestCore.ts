export type StressMode = 'cpu' | 'gpu' | 'both';
export type StressState = 'idle' | 'starting' | 'running' | 'stopping' | 'unsupported' | 'error';
export type StressGpuBackend = 'webgpu-compute' | 'webgl2-fragment' | 'webgl1-fragment' | 'none';

export interface CpuWorkerResolutionInput {
  hardwareConcurrency?: number | null;
  maxWorkers?: number | null;
}

export interface GpuBackendSupportInput {
  hasWebGpu?: boolean;
  hasWebGl2?: boolean;
  hasWebGl1?: boolean;
}

export type StressEvent = 'start' | 'running' | 'stop' | 'stopped' | 'unsupported' | 'error' | 'reset' | 'retry';

const DEFAULT_CPU_WORKERS = 4;

export function isStressMode(value: string | undefined): value is StressMode {
  return value === 'cpu' || value === 'gpu' || value === 'both';
}

export function shouldStressCpu(mode: StressMode) {
  return mode === 'cpu' || mode === 'both';
}

export function shouldStressGpu(mode: StressMode) {
  return mode === 'gpu' || mode === 'both';
}

export function resolveCpuWorkerCount(input: CpuWorkerResolutionInput = {}) {
  // hardwareConcurrency is an unsigned-long browser value. Honor all reported threads.
  const raw = Number.isFinite(input.hardwareConcurrency) && Number(input.hardwareConcurrency) <= 0xffff_ffff
    ? Number(input.hardwareConcurrency)
    : DEFAULT_CPU_WORKERS;
  const requested = Math.max(1, Math.floor(raw));
  const configuredMax = Number.isFinite(input.maxWorkers)
    ? Math.max(1, Math.floor(Number(input.maxWorkers)))
    : requested;

  return Math.min(requested, configuredMax);
}

export const SMT_PROBE_SAMPLE_WINDOW_MS = 600;
export const SMT_PROBE_SPAWN_WARMUP_MS = 700;
// Short discarded settle after a wave spawn or a pause/resume flip: in-flight
// chunk work and already-sent heartbeats must not bleed into the next window.
export const SMT_PROBE_TOGGLE_WARMUP_MS = 300;
// A trial is kept while its wave has not yet squeezed the permanent workers
// below 75% of their bracketed rate, and a kept wave ALWAYS converts in full.
// OS scheduling gives the two overload regimes distinct signatures: sharing a
// physical core's SMT sibling (workers still fit on logical threads) slows a
// permanent worker only ~10–30%, while genuine oversubscription (more
// workers than logical threads) time-slices each one to ≈ capacity ÷ workers,
// under ~70%. Keeping at ≥0.75 therefore grows through the SMT-sharing region
// — where every thread still exists and still adds throughput — and reverts
// once threads run out. Converting a kept wave only partially (by a
// `ratio × trial` capacity estimate) was the previous design's fatal flaw:
// SMT-region slowdowns look like the time-slicing formula's input, so the
// estimate undershot, the partial keep bounded the search below true capacity,
// and a 32-thread machine stalled at 22.
// The measurement is the permanent workers' rate, not aggregate throughput:
// extra logical cores add workers at sub-linear aggregate gains (SMT siblings
// are not full cores, and background threads steal capacity), so an aggregate
// keep ratio would stop the search far short of the threads that exist, while
// existing-worker slowdown pinpoints thread exhaustion.
export const SMT_PROBE_KEEP_RATIO = 0.75;
export const SMT_PROBE_MAX_TOTAL_WORKERS = 128;
// Off windows measured before the trial wave spawns; the first doubles as the
// idle guard, and together they precede the interleaved on/off measurement.
export const SMT_PROBE_BASELINE_WINDOWS = 2;
// Bench-on windows per trial; between them the wave is paused again so each
// on window is bracketed by an off window at the same clock speed and
// frontier depth (see the class documentation).
export const SMT_PROBE_CANDIDATE_WINDOWS = 2;
// Refinement stops once the proven/failed worker bracket is this narrow. No
// windowed throughput comparison can resolve capacity differences finer than
// the keep threshold, so bisecting inside this tolerance would add wave churn
// without any trustworthy information.
export const SMT_PROBE_REFINE_TOLERANCE_MIN = 2;
export const SMT_PROBE_REFINE_TOLERANCE_RATIO = 0.1;

export type CpuSmtProbeAction =
  | { action: 'none' }
  | { action: 'spawn'; extra: number }
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'keep'; convert: number }
  | { action: 'revert' };

/**
 * Closed-loop CPU capacity search driven by worker heartbeat arrivals, never
 * by timers. Browsers may under-report logical processors — rounding to
 * physical cores, capping the count, or an OS reserving cores — so the
 * reported worker count can leave simultaneous-multithreading siblings or
 * entire cores idle. Doubling alone cannot fix that: it strides over the true
 * count (12 → 24 → 48 skips 32 entirely) and a failed wave that reverts and
 * stops strands the run below saturation. So this is a converging search over
 * worker counts with proven bounds: `low` is the highest count measured to
 * keep the existing workers within the keep ratio, `high` the lowest trial
 * measured to slow them past it.
 *
 * Work is executed sieve work units; heartbeat gaps close the measurement
 * windows, and the caller seeds every disposable benchmark wave at the live
 * production frontier and PAUSES it (idle, queue kept) until asked to resume.
 * A trial compares interleaved windows: two off windows (wave paused) precede
 * the spawn, then the wave flips on/off/on so every on window is bracketed by
 * off windows measured moments earlier and later. Comparing rates across time
 * — any candidate window against any earlier baseline — is poisoned by drift
 * no probe can model: the per-worker sieve rate falls as the shared frontier
 * deepens (and a bigger wave advances it faster), and CPU boost clocks sag
 * seconds into a load. Both drifts are monotone over seconds but locally
 * smooth, so an on/off/off-on interleaving cancels them: a trial's ratio is
 * mean(on windows) / mean(bracketing off windows), and drift affects
 * numerator and denominator alike.
 *
 * The ratio signal is the PERMANENT workers' rate, not aggregate throughput.
 * Aggregate scaling is a dead end as a keep test: extra logical cores join at
 * sub-linear aggregate gain — SMT siblings add a fraction of a core, memory
 * bandwidth bends the curve, and background threads eat capacity — so on a
 * real 32-thread machine a 24-on-12 trial measures ~1.6 aggregate, below any
 * sensible aggregate keep ratio, and the search stalls near 20 while half the
 * threads spin idle. Existing-worker slowdown has no such ceiling. The two
 * overload regimes read distinctly: while the trial's workers still fit on
 * logical threads, the worst a permanent worker suffers is SMT-sibling
 * sharing — a ~10–30% slowdown — but once there are more workers than
 * logical threads, fair time-slicing drops every permanent worker to
 * ≈ capacity ÷ workers, under ~70%. The trial is kept at ≥75% of the
 * bracketed rate and ALWAYS converts in full — growth walks through the
 * SMT-sharing region (every thread there is real capacity) and stops where
 * time-slicing begins. Reported 12 on a 32-thread machine: the 24-on-12 trial
 * measures ~0.85 (threads exist, siblings shared) → keeps 24 → the 48-on-24
 * trial measures ~0.6 (real oversubscription) → reverts → bisection lands at
 * ≈32. An earlier design instead trimmed keeps with a `ratio × trial`
 * capacity estimate: SMT-region slowdowns plug that fair-sharing formula
 * with values that undershoot, the trimmed keep bounds the search below
 * capacity, and the same 32-thread machine stalled at 22.
 *
 * The search stops when the bracket is inside the tolerance (the slowdown
 * signal's noise floor), the total-worker cap is reached, or the very first
 * trial fails against an unproven report — in which case the browser's own
 * count is trusted and the search stops after one trial, exactly as a
 * correctly reported machine needs. A first off window showing no progress
 * gives no trustworthy comparison, and a wave whose bench workers report no
 * work during either on window was never really measured: either ends the
 * search as a failed trial.
 *
 * A browser that OVER-reports (more workers than hardware threads) cannot be
 * corrected here: permanent workers cannot be terminated without leaving
 * holes in the production search coverage. Real-world browser misreporting is
 * under-reporting, so the search only ever adds capacity.
 */
export class CpuSmtProbe {
  // Every trial and the initial measurement begin settled (see beginSettle);
  // the very first settle anchors its warmup on the first heartbeat.
  private phase: 'settle' | 'off' | 'on' | 'decided' | 'finished' = 'settle';
  private settleTarget: 'off' | 'on' = 'off';
  private settleWarmupMs = SMT_PROBE_SPAWN_WARMUP_MS;
  private readonly reportedWorkers: number;
  private readonly maxTotalWorkers: number;
  // Search bounds: highest proven-grown worker count and lowest proven-stalled
  // trial total. The final permanent count is `low`.
  private low: number;
  private high: number | null = null;
  // Total worker count of the trial whose decision is live, its wave size,
  // and how many of that wave a keep decision converts.
  private trialTotal = 0;
  private trialExtra = 0;
  private pendingConvert = 0;
  // Whether this trial's (paused) benchmark wave is alive awaiting its flips.
  private waveLive = false;
  private windowStartAt = 0;
  private windowStartWork = 0;
  private windowStartBench = 0;
  private settleAt = 0;
  // Per-trial window rates of the PERMANENT workers only (off windows: wave
  // paused; on windows: wave measuring). The reference is the mean of the
  // last two off windows — the pair bracketing the on windows. Bench work
  // feeds a liveness guard, never the ratio.
  private offRates: number[] = [];
  private onRates: number[] = [];
  private onBenchDeltas: number[] = [];

  constructor(reportedWorkers: number, maxTotalWorkers = SMT_PROBE_MAX_TOTAL_WORKERS) {
    if (!Number.isSafeInteger(reportedWorkers) || reportedWorkers < 1) {
      throw new Error('Invalid SMT probe reported worker count.');
    }
    if (!Number.isSafeInteger(maxTotalWorkers) || maxTotalWorkers < reportedWorkers) {
      throw new Error('Invalid SMT probe worker cap.');
    }
    this.reportedWorkers = reportedWorkers;
    this.maxTotalWorkers = maxTotalWorkers;
    this.low = reportedWorkers;
  }

  observe(now: number, productionWork: number, benchWork: number): CpuSmtProbeAction {
    // A decision awaits the caller's registerKeep/registerRevert bookkeeping,
    // and a finished search is inert: neither may re-enter the measurement loop.
    if (this.phase === 'decided' || this.phase === 'finished') return { action: 'none' };
    if (this.phase === 'settle') {
      // Discard every window that overlaps a spawn or flip: boot work, the
      // final in-flight chunk, and heartbeats sent before the flip must not
      // represent the phase that follows it.
      if (this.settleAt === 0) this.settleAt = now;
      if (now - this.settleAt < this.settleWarmupMs) return { action: 'none' };
      this.windowStartAt = now;
      this.windowStartWork = productionWork;
      this.windowStartBench = benchWork;
      this.phase = this.settleTarget;
      return { action: 'none' };
    }
    if (this.windowStartAt === 0) {
      this.windowStartAt = now;
      this.windowStartWork = productionWork;
      this.windowStartBench = benchWork;
      return { action: 'none' };
    }
    const elapsed = now - this.windowStartAt;
    if (elapsed < SMT_PROBE_SAMPLE_WINDOW_MS) return { action: 'none' };
    const rate = (productionWork - this.windowStartWork) / elapsed;
    const benchDelta = benchWork - this.windowStartBench;
    this.windowStartAt = now;
    this.windowStartWork = productionWork;
    this.windowStartBench = benchWork;
    return this.phase === 'off' ? this.closeOffWindow(now, rate) : this.closeOnWindow(now, rate, benchDelta);
  }

  /**
   * Records that the caller installed permanent workers for a kept trial and
   * advances the search. Returns true when the search is over (cap reached or
   * bracket inside tolerance) and the caller should finalize with the current
   * worker count.
   */
  registerKeep(now: number): boolean {
    if (this.phase !== 'decided') throw new Error('SMT probe keep recorded outside a keep decision.');
    if (!Number.isFinite(now)) throw new Error('Invalid SMT probe keep time.');
    // Kept waves always convert in full (see closeOnWindow), so a keep never
    // sets the upper bound; only a reverting trial does.
    this.low += this.pendingConvert;
    return this.advanceSearch(now);
  }

  /**
   * Records that the caller discarded a failed trial and advances the search.
   * Returns true when the search is over and the caller should finalize with
   * the current worker count.
   */
  registerRevert(now: number): boolean {
    if (this.phase !== 'decided') throw new Error('SMT probe revert recorded outside a revert decision.');
    if (!Number.isFinite(now)) throw new Error('Invalid SMT probe revert time.');
    if (this.high === null && this.low === this.reportedWorkers) {
      // Nothing ever grew beyond the browser's own report: the report already
      // matches measurable capacity, so trust it and stop without refinement.
      this.phase = 'finished';
      return true;
    }
    this.high = this.high === null ? this.trialTotal : Math.min(this.high, this.trialTotal);
    return this.advanceSearch(now);
  }

  private closeOffWindow(now: number, rate: number): CpuSmtProbeAction {
    this.offRates.push(rate);
    if (this.offRates.length === 1 && rate <= 0) {
      // An idle or stalled machine gives no trustworthy comparison; a failed
      // trial against the current count ends the search with what it proves.
      this.trialTotal = this.low;
      this.trialExtra = 0;
      this.phase = 'decided';
      return { action: 'revert' };
    }
    if (!this.waveLive) {
      if (this.offRates.length < SMT_PROBE_BASELINE_WINDOWS) return { action: 'none' };
      this.trialTotal = this.nextTrialTotal();
      this.trialExtra = this.trialTotal - this.low;
      if (this.trialExtra <= 0) {
        // Unreachable while registerKeep/registerRevert gate continuation on
        // the tolerance and cap; treat it as a failed trial so the search can
        // still terminate cleanly.
        this.phase = 'decided';
        return { action: 'revert' };
      }
      this.waveLive = true;
      this.beginSettle('off', SMT_PROBE_SPAWN_WARMUP_MS, now);
      // The caller spawns the wave paused; it contributes nothing until the
      // resume flip, so this trial's off windows continue seamlessly.
      return { action: 'spawn', extra: this.trialExtra };
    }
    if (this.onRates.length < SMT_PROBE_CANDIDATE_WINDOWS) {
      this.beginSettle('on', SMT_PROBE_TOGGLE_WARMUP_MS, now);
      return { action: 'resume' };
    }
    // Unreachable: the trial decides on the last on window's close.
    return { action: 'none' };
  }

  private closeOnWindow(now: number, rate: number, benchDelta: number): CpuSmtProbeAction {
    this.onRates.push(rate);
    this.onBenchDeltas.push(benchDelta);
    if (this.onRates.length < SMT_PROBE_CANDIDATE_WINDOWS) {
      this.beginSettle('off', SMT_PROBE_TOGGLE_WARMUP_MS, now);
      return { action: 'pause' };
    }
    if (this.onBenchDeltas.every(delta => delta <= 0)) {
      // The wave contributed no work during either on window — a wave that
      // stalled, starved, or never really resumed. Nothing was measured, so
      // treat it as a failed trial rather than a slowdown of 1.0.
      this.phase = 'decided';
      return { action: 'revert' };
    }
    const bracket = this.offRates.slice(-SMT_PROBE_BASELINE_WINDOWS);
    const reference = bracket.reduce((sum, value) => sum + value, 0) / bracket.length;
    const ratio = reference > 0 ? (this.onRates.reduce((sum, value) => sum + value, 0) / this.onRates.length) / reference : 0;
    this.phase = 'decided';
    if (ratio >= SMT_PROBE_KEEP_RATIO) {
      // Threads still absorb the wave (unshared or only SMT-shared): every
      // trial worker becomes permanent. No capacity estimate trims the keep —
      // SMT-region slowdowns read like the fair-sharing formula's input and
      // would undershoot, and a trimmed keep bounds the search below capacity.
      this.pendingConvert = this.trialExtra;
      return { action: 'keep', convert: this.trialExtra };
    }
    return { action: 'revert' };
  }

  private beginSettle(target: 'off' | 'on', warmupMs: number, now: number) {
    this.phase = 'settle';
    this.settleTarget = target;
    this.settleWarmupMs = warmupMs;
    this.settleAt = now;
    this.windowStartAt = 0;
  }

  private advanceSearch(now: number): boolean {
    if (this.low >= this.maxTotalWorkers || (this.high !== null && this.high - this.low <= this.refineTolerance())) {
      this.phase = 'finished';
      return true;
    }
    this.waveLive = false;
    this.offRates = [];
    this.onRates = [];
    this.onBenchDeltas = [];
    // The caller discarded (or converted) the wave and installed permanent
    // replacements, so the next trial needs the full spawn warmup settle.
    this.beginSettle('off', SMT_PROBE_SPAWN_WARMUP_MS, now);
    return false;
  }

  private refineTolerance() {
    return Math.max(SMT_PROBE_REFINE_TOLERANCE_MIN, Math.ceil(this.low * SMT_PROBE_REFINE_TOLERANCE_RATIO));
  }

  private nextTrialTotal() {
    if (this.high === null) return Math.min(this.low * 2, this.maxTotalWorkers);
    return this.low + Math.floor((this.high - this.low) / 2);
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
