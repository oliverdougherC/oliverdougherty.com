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
export const SMT_PROBE_KEEP_RATIO = 1.1;
export const SMT_PROBE_MAX_TOTAL_WORKERS = 128;
export const SMT_PROBE_BASELINE_WINDOWS = 3;
// The keep/revert reference is the mean of only the newest baseline windows.
// Per-worker sieve rate decays as the shared frontier deepens — steepest at
// the start of a run, where it halves within the first seconds — so a
// reference taken across all baseline windows (or worse, their peak) is set
// from a shallower, cheaper frontier era that a candidate wave — which
// necessarily runs later — cannot reach even when its workers genuinely
// double throughput, and idle capacity gets falsely reverted. The newest
// windows sit closest in time (and frontier depth) to the candidate wave, and
// averaging two of them keeps tolerance for single-window bursts.
export const SMT_PROBE_REFERENCE_WINDOWS = 2;
export const SMT_PROBE_CANDIDATE_WINDOWS = 2;
// Refinement stops once the proven/failed worker bracket is this narrow. No
// windowed throughput comparison can resolve capacity differences finer than
// the keep ratio, so bisecting inside this tolerance would add wave churn
// without any trustworthy information.
export const SMT_PROBE_REFINE_TOLERANCE_MIN = 2;
export const SMT_PROBE_REFINE_TOLERANCE_RATIO = 0.1;

export type CpuSmtProbeAction =
  | { action: 'none' }
  | { action: 'spawn'; extra: number }
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
 * raise aggregate work, `high` the lowest trial measured not to.
 *
 * Measurement is executed sieve work units per window; heartbeat gaps close
 * windows, and the caller seeds every disposable benchmark wave at the live
 * production frontier so both sides sieve same-cost ranges. Two biases must be
 * removed before rates are comparable across time, because a trial wave is
 * always measured seconds after its baseline:
 *
 * - Frontier decay: per-worker rate falls as the shared sieve frontier
 *   deepens, steepest in the first seconds of a run. Comparing candidate
 *   windows against the best-ever baseline window (as the original probe did)
 *   sets a threshold from a shallower, cheaper frontier era that genuinely
 *   doubled throughput cannot beat — idle capacity gets falsely reverted,
 *   and the bias worsens with every kept wave because more workers advance
 *   the frontier faster. The search instead measures its reference from the
 *   newest baseline windows only (mean of the last two, which keeps
 *   tolerance for single-window bursts), and every phase — including the
 *   very first baseline — begins with a settle warmup that discards the
 *   steepest startup windows.
 * - Overshoot: keeping means converting only the workers the machine's
 *   measured aggregate throughput can explain. While every worker owns a
 *   hardware thread, aggregate rate scales with the worker count, so the
 *   candidate's rate ratio against its reference estimates the machine's
 *   measured saturation point: keep converts `low × ratio` (clamped to the
 *   trial and to at least one) workers into permanent ones. A doubling wave
 *   that strides past capacity is therefore trimmed to the estimated capacity
 *   instead of being installed whole, which is what lets the final count
 *   land at (not above) saturation: reported 12 on a 32-thread machine keeps
 *   12 → 24 in full, converts only 8 of the 24-member 48 trial (12×32/24 →
 *   32 total), then refines [32, 48] down and stops at 32.
 *
 * Waves are kept exponentially (doubling) while aggregate measured work keeps
 * rising, so a heavily under-reporting browser reaches capacity in a few
 * waves. Once a wave reverts — but only if at least one wave was kept, i.e.
 * the browser's report was proven wrong — `high` is set and the search refines
 * by bisecting the bracket: a kept trial raises `low`, a reverted trial lowers
 * `high`. The search stops when the bracket is inside the tolerance (the keep
 * ratio's noise floor), the total-worker cap is reached, or the very first
 * wave fails against an unproven report — in which case the browser's own
 * count is trusted and the search stops after one wave, exactly as a correctly
 * reported machine needs. A baseline whose reference windows show no progress
 * gives no trustworthy comparison: the search treats it as a failed trial and
 * stops.
 *
 * A browser that OVER-reports (more workers than hardware threads) cannot be
 * corrected here: permanent workers cannot be terminated without leaving
 * holes in the production search coverage. Real-world browser misreporting is
 * under-reporting, so the search only ever adds capacity.
 */
export class CpuSmtProbe {
  // The search always begins settled: the initial baseline skips the steepest
  // startup windows exactly like every later re-baseline does.
  private phase: 'baseline' | 'settle' | 'spawned' | 'candidate' | 'decided' | 'finished' = 'settle';
  private readonly reportedWorkers: number;
  private readonly maxTotalWorkers: number;
  // Search bounds: highest proven-grown worker count and lowest proven-stalled
  // trial total. The final permanent count is `low`.
  private low: number;
  private high: number | null = null;
  // Total worker count of the trial whose spawn/keep/revert decision is live,
  // its wave size, and how many of that wave a keep decision converts.
  private trialTotal = 0;
  private trialExtra = 0;
  private pendingConvert = 0;
  private windowStartAt = 0;
  private windowStartWork = 0;
  private settleAt = 0;
  private baselineWindows = 0;
  private candidateWindows = 0;
  // Rates of the newest baseline windows; their mean is the candidate
  // comparison reference (see SMT_PROBE_REFERENCE_WINDOWS).
  private referenceRates: number[] = [];

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

  observe(now: number, totalWork: number): CpuSmtProbeAction {
    // A decision awaits the caller's registerKeep/registerRevert bookkeeping,
    // and a finished search is inert: neither may re-enter the measurement loop.
    if (this.phase === 'decided' || this.phase === 'finished') return { action: 'none' };
    if (this.phase === 'settle' || this.phase === 'spawned') {
      // Discard every window that overlaps the spawn or a replacement wave; new
      // workers need a moment before their work (or absence of it) is
      // representative. The initial settle anchors its warmup on the first
      // heartbeat, so the search never measures the startup burst windows.
      if (this.settleAt === 0) this.settleAt = now;
      if (now - this.settleAt < SMT_PROBE_SPAWN_WARMUP_MS) return { action: 'none' };
      this.windowStartAt = now;
      this.windowStartWork = totalWork;
      // A kept wave re-baselines before growing again; a spawned wave measures its candidate.
      this.phase = this.phase === 'spawned' ? 'candidate' : 'baseline';
      return { action: 'none' };
    }
    if (this.windowStartAt === 0) {
      this.windowStartAt = now;
      this.windowStartWork = totalWork;
      return { action: 'none' };
    }
    const elapsed = now - this.windowStartAt;
    if (elapsed < SMT_PROBE_SAMPLE_WINDOW_MS) return { action: 'none' };
    const rate = (totalWork - this.windowStartWork) / elapsed;
    this.windowStartAt = now;
    this.windowStartWork = totalWork;
    if (this.phase === 'baseline') {
      this.baselineWindows += 1;
      this.referenceRates.push(rate);
      if (this.referenceRates.length > SMT_PROBE_REFERENCE_WINDOWS) this.referenceRates.shift();
      if (this.baselineWindows < SMT_PROBE_BASELINE_WINDOWS) return { action: 'none' };
      if (this.referenceAt() <= 0) {
        // An idle or stalled baseline gives no trustworthy comparison; a failed
        // trial against the current count ends the search with what it proves.
        this.trialTotal = this.low;
        this.trialExtra = 0;
        this.phase = 'decided';
        return { action: 'revert' };
      }
      this.trialTotal = this.nextTrialTotal();
      this.trialExtra = this.trialTotal - this.low;
      if (this.trialExtra <= 0) {
        // Unreachable while registerKeep/registerRevert gate continuation on
        // the tolerance and cap; treat it as a failed trial so the search can
        // still terminate cleanly.
        this.phase = 'decided';
        return { action: 'revert' };
      }
      this.phase = 'spawned';
      this.settleAt = now;
      this.windowStartAt = 0;
      return { action: 'spawn', extra: this.trialExtra };
    }
    const reference = this.referenceAt();
    if (reference > 0 && rate >= reference * SMT_PROBE_KEEP_RATIO) {
      // Aggregate throughput scales with the number of workers as long as each
      // one gets its own hardware thread, so the rate ratio estimates the
      // machine's measured saturation point; convert only up to it. A trial
      // that stays at or below capacity estimates at or above its own total
      // and converts fully.
      const estimatedCapacity = Math.round(this.low * (rate / reference));
      this.pendingConvert = Math.min(this.trialExtra, Math.max(1, estimatedCapacity - this.low));
      this.phase = 'decided';
      return { action: 'keep', convert: this.pendingConvert };
    }
    this.candidateWindows += 1;
    if (this.candidateWindows < SMT_PROBE_CANDIDATE_WINDOWS) return { action: 'none' };
    this.phase = 'decided';
    return { action: 'revert' };
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
    this.low += this.pendingConvert;
    // A partially converted trial proved the whole trial total overshot
    // capacity: it stands as the search's upper bound.
    if (this.pendingConvert < this.trialExtra) {
      this.high = this.high === null ? this.trialTotal : Math.min(this.high, this.trialTotal);
    }
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

  /**
   * The candidate comparison reference: the mean of the newest baseline
   * window rates, temporally adjacent to the candidate wave so frontier decay
   * shifts both sides of the comparison alike.
   */
  private referenceAt() {
    if (this.referenceRates.length === 0) return 0;
    return this.referenceRates.reduce((sum, rate) => sum + rate, 0) / this.referenceRates.length;
  }

  private advanceSearch(now: number): boolean {
    if (this.low >= this.maxTotalWorkers || (this.high !== null && this.high - this.low <= this.refineTolerance())) {
      this.phase = 'finished';
      return true;
    }
    this.phase = 'settle';
    this.settleAt = now;
    this.windowStartAt = 0;
    this.baselineWindows = 0;
    this.candidateWindows = 0;
    this.referenceRates = [];
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
