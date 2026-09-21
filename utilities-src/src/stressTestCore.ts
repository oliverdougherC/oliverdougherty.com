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

export const SMT_PROBE_WARMUP_MS = 300;
export const SMT_PROBE_SAMPLE_WINDOW_MS = 600;
export const SMT_PROBE_SPAWN_WARMUP_MS = 700;
export const SMT_PROBE_KEEP_RATIO = 1.1;
export const SMT_PROBE_MAX_TOTAL_WORKERS = 128;

export type CpuSmtProbeAction = 'none' | 'spawn' | 'keep' | 'revert';

/**
 * Extra workers for one throughput-probe wave. Browsers may under-report logical
 * processors — rounding to physical cores or capping the count — so the reported
 * count can leave simultaneous-multithreading siblings idle. The probe wave is
 * sized to double the reported worker count, bounded by a total cap.
 */
export function resolveSmtProbeExtraWorkers(reportedWorkers: number) {
  if (!Number.isSafeInteger(reportedWorkers) || reportedWorkers < 1) return 0;
  return Math.max(0, Math.min(reportedWorkers, SMT_PROBE_MAX_TOTAL_WORKERS - reportedWorkers));
}

/**
 * Closed-loop SMT probe driven by worker heartbeat arrivals, never by timers.
 * Measures aggregate iteration throughput for the reported worker count, spawns
 * one extra wave, and reports whether measured throughput grew enough to keep
 * the extra workers. A second wave on an honest report yields no aggregate gain
 * and is reverted; a second wave on SMT siblings adds real throughput.
 */
export class CpuSmtProbe {
  private phase: 'baseline' | 'spawned' | 'candidate' | 'done' = 'baseline';
  private windowStartAt = 0;
  private windowStartIterations = 0;
  private spawnAt = 0;
  private baselineRate = 0;

  constructor(private readonly startedAt: number) {
    if (!Number.isFinite(startedAt)) throw new Error('Invalid SMT probe start time.');
  }

  observe(now: number, totalIterations: number): CpuSmtProbeAction {
    if (this.phase === 'baseline') {
      if (now - this.startedAt < SMT_PROBE_WARMUP_MS) return 'none';
      if (this.windowStartAt === 0) {
        this.windowStartAt = now;
        this.windowStartIterations = totalIterations;
        return 'none';
      }
      const elapsed = now - this.windowStartAt;
      if (elapsed < SMT_PROBE_SAMPLE_WINDOW_MS) return 'none';
      const gained = totalIterations - this.windowStartIterations;
      this.windowStartAt = 0;
      if (gained <= 0) {
        // An idle or stalled baseline gives no trustworthy comparison; stay conservative.
        this.phase = 'done';
        return 'none';
      }
      this.baselineRate = gained / elapsed;
      this.spawnAt = now;
      this.phase = 'spawned';
      return 'spawn';
    }
    if (this.phase === 'spawned') {
      if (now - this.spawnAt < SMT_PROBE_SPAWN_WARMUP_MS) return 'none';
      this.windowStartAt = now;
      this.windowStartIterations = totalIterations;
      this.phase = 'candidate';
      return 'none';
    }
    if (this.phase === 'candidate') {
      const elapsed = now - this.windowStartAt;
      if (elapsed < SMT_PROBE_SAMPLE_WINDOW_MS) return 'none';
      const rate = (totalIterations - this.windowStartIterations) / elapsed;
      this.phase = 'done';
      return rate >= this.baselineRate * SMT_PROBE_KEEP_RATIO ? 'keep' : 'revert';
    }
    return 'none';
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
