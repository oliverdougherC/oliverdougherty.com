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
export const SMT_PROBE_CANDIDATE_WINDOWS = 2;

export type CpuSmtProbeAction = 'none' | 'spawn' | 'keep' | 'revert';

/**
 * Extra workers for one throughput-probe wave. Browsers may under-report logical
 * processors — rounding to physical cores or capping the count — so the reported
 * count can leave simultaneous-multithreading siblings or entire cores idle.
 * Each wave doubles the current worker count, bounded by a total cap.
 */
export function resolveSmtProbeExtraWorkers(reportedWorkers: number) {
  if (!Number.isSafeInteger(reportedWorkers) || reportedWorkers < 1) return 0;
  return Math.max(0, Math.min(reportedWorkers, SMT_PROBE_MAX_TOTAL_WORKERS - reportedWorkers));
}

/**
 * Closed-loop SMT probe driven by worker heartbeat arrivals, never by timers.
 * Work rate is measured as executed frontier-flat sieve work units per
 * window; heartbeat gaps close windows. One unit costs the same CPU time at
 * every search frontier, so production and disposable-benchmark rates are
 * comparable despite sieving different ranges. Sieve base-extension bursts
 * and JIT phase changes make any single window noisy, so the probe keeps the
 * PEAK window rate: bursts inflate both sides of the comparison equally and
 * cannot fake or mask a capacity change. After several baseline windows it
 * spawns a disposable benchmark wave; the wave is kept when any candidate
 * window beats the baseline peak by the keep ratio, and reverted once enough
 * candidate windows all miss. A kept wave
 * re-baselines at the grown count and doubles again, so a heavily under-
 * reporting browser grows until a wave stalls or the caller reaches the
 * total-worker cap. A baseline whose best window shows no progress gives no
 * trustworthy comparison: the probe reverts without spawning.
 */
export class CpuSmtProbe {
  private phase: 'baseline' | 'settle' | 'spawned' | 'candidate' | 'done' = 'baseline';
  private windowStartAt = 0;
  private windowStartWork = 0;
  private settleAt = 0;
  private baselineWindows = 0;
  private candidateWindows = 0;
  private peakBaselineRate = 0;

  observe(now: number, totalWork: number): CpuSmtProbeAction {
    if (this.phase === 'done') return 'none';
    if (this.phase === 'settle' || this.phase === 'spawned') {
      // Discard every window that overlaps the spawn; new workers need a moment
      // before their work (or absence of it) is representative.
      if (now - this.settleAt < SMT_PROBE_SPAWN_WARMUP_MS) return 'none';
      this.windowStartAt = now;
      this.windowStartWork = totalWork;
      // A kept wave re-baselines before growing again; a spawned wave measures its candidate.
      this.phase = this.phase === 'spawned' ? 'candidate' : 'baseline';
      return 'none';
    }
    if (this.windowStartAt === 0) {
      this.windowStartAt = now;
      this.windowStartWork = totalWork;
      return 'none';
    }
    const elapsed = now - this.windowStartAt;
    if (elapsed < SMT_PROBE_SAMPLE_WINDOW_MS) return 'none';
    const rate = (totalWork - this.windowStartWork) / elapsed;
    this.windowStartAt = now;
    this.windowStartWork = totalWork;
    if (this.phase === 'baseline') {
      this.baselineWindows += 1;
      this.peakBaselineRate = Math.max(this.peakBaselineRate, rate);
      if (this.baselineWindows < SMT_PROBE_BASELINE_WINDOWS) return 'none';
      if (this.peakBaselineRate <= 0) {
        // An idle or stalled baseline gives no trustworthy comparison; revert conservatively.
        this.phase = 'done';
        return 'revert';
      }
      this.phase = 'spawned';
      this.settleAt = now;
      this.windowStartAt = 0;
      return 'spawn';
    }
    if (rate >= this.peakBaselineRate * SMT_PROBE_KEEP_RATIO) {
      this.phase = 'done';
      return 'keep';
    }
    this.candidateWindows += 1;
    if (this.candidateWindows < SMT_PROBE_CANDIDATE_WINDOWS) return 'none';
    this.phase = 'done';
    return 'revert';
  }

  /** Records that the caller installed permanent workers for a kept wave; re-baselines for the next one. */
  registerKeep(now: number) {
    if (this.phase !== 'done') throw new Error('SMT probe keep recorded outside a keep decision.');
    if (!Number.isFinite(now)) throw new Error('Invalid SMT probe keep time.');
    this.phase = 'settle';
    this.settleAt = now;
    this.windowStartAt = 0;
    this.baselineWindows = 0;
    this.candidateWindows = 0;
    this.peakBaselineRate = 0;
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
