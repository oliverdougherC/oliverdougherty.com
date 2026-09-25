export type StressMode = 'cpu' | 'gpu' | 'both';
export type StressState = 'idle' | 'starting' | 'running' | 'stopping' | 'unsupported' | 'error';
export type StressGpuBackend = 'webgpu-compute' | 'webgl2-fragment' | 'webgl1-fragment' | 'none';

/**
 * Where the pool size came from. `exact` is the diagnostic hook, `report` is the
 * browser's own logical-processor count, and `fallback` means no scope answered with
 * a usable number â€” a fallback pool is a small documented default, never a claim
 * that the machine's processors are all in use.
 */
export type CpuPoolSource = 'exact' | 'report' | 'fallback';

export interface CpuPoolPlanInput {
  /** `navigator.hardwareConcurrency` read in window scope. */
  pageReport?: number | null;
  /** `navigator.hardwareConcurrency` as a real dedicated worker reports it. */
  workerReport?: number | null;
  /** Diagnostic request for an exact pool size. It may exceed either report. */
  exactWorkers?: number | null;
}

export interface CpuPoolPlan {
  /** Sanitized window-scope report; 0 when it carried no usable count. */
  pageReport: number;
  /** Sanitized worker-scope report; 0 when no worker answered before the plan. */
  workerReport: number;
  /** The logical-processor count the pool is sized from; 0 if nothing reported. */
  reported: number;
  /** Exactly how many workload workers to create. Fixed for the whole run. */
  workers: number;
  /** Which input produced that number. */
  source: CpuPoolSource;
}

export interface GpuBackendSupportInput {
  hasWebGpu?: boolean;
  hasWebGl2?: boolean;
  hasWebGl1?: boolean;
}

export type StressEvent = 'start' | 'running' | 'stop' | 'stopped' | 'unsupported' | 'error' | 'reset' | 'retry';

// Used only when nothing answered with a usable processor count, i.e. a browser that
// reports nothing at all. It is a documented small default, published as
// `data-stress-cpu-pool-source="fallback"`, and it is deliberately not derived from
// anything: inventing a count is what this file exists to avoid.
export const CPU_POOL_FALLBACK_WORKERS = 4;
// One worker is constructed before the pool is sized, so that the count can be read
// in the scope the workload runs in. If it has not answered â€” it loaded, or the
// browser is wedged â€” the plan falls back to the window-scope report instead of
// leaving Start waiting forever.
export const CPU_POOL_REPORT_TIMEOUT_MS = 2000;
// Constructing a worker is main-thread work, so the pool is created in short bursts
// rather than one long task: Start stays responsive and, in combined mode, GPU
// submission keeps flowing while the pool is being built. This only spaces creation
// out; it never changes how many workers the pool ends up with.
export const CPU_POOL_SPAWN_BATCH = 8;
// A failed worker may be replaced, but only a bounded number of times, so a worker
// script that fails on startup cannot spin forever creating replacements. Replacement
// keeps the pool AT its requested size and never above it.
export const CPU_POOL_MAX_REPLACEMENTS = 8;
/**
 * Largest logical-processor count a real configuration reports today (a two-socket
 * 128-core part is 4096 threads). A "count" above it is not a processor count â€” it is
 * spoofed, virtualised nonsense, or a bug â€” and honouring it literally would mean
 * creating hundreds of thousands of workers. Inside the bound a report is honoured in
 * full: it is never halved, never rounded to a historical guess about hardware, and
 * never capped at a smaller number of the developer's choosing.
 */
export const CPU_POOL_TRUSTED_REPORT_MAX = 4096;

export function isStressMode(value: string | undefined): value is StressMode {
  return value === 'cpu' || value === 'gpu' || value === 'both';
}

export function shouldStressCpu(mode: StressMode) {
  return mode === 'cpu' || mode === 'both';
}

export function shouldStressGpu(mode: StressMode) {
  return mode === 'gpu' || mode === 'both';
}

/**
 * Reads one logical-processor report. Absent, non-numeric, non-positive, or beyond
 * CPU_POOL_TRUSTED_REPORT_MAX all mean "this scope told us nothing", which is
 * reported as 0 so the caller can see the difference between a browser that said 1
 * and a browser that did not answer.
 */
export function sanitizeLogicalProcessorReport(value: number | null | undefined) {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 1 || count > CPU_POOL_TRUSTED_REPORT_MAX) return 0;
  return Math.floor(count);
}

/**
 * Sizes the CPU pool from the browser's own logical-processor report, once, for the
 * whole run. The pool it describes is fixed: nothing here has a growth step, a
 * ceiling to grow toward, or a measurement that can revise it.
 *
 * `navigator.hardwareConcurrency` is read in two scopes, because they can disagree.
 * They are the same standard API, so a difference between them is not two different
 * quantities to reconcile â€” it is one of them having been reduced. That is not
 * hypothetical: on the 16-core/32-thread host this feature was written for, a
 * Chromium-based browser with fingerprint protection reported 12, 14, or 16 in window
 * scope from launch to launch (its protection randomizes it) while `navigator` inside
 * a dedicated worker created by the very same page reported the machine's real 32
 * every time â€” see `scripts/stress-report-trace.js`, which measures exactly this.
 * The workers are what occupy processors, so the pool is sized from the count the
 * browser is willing to state where the work actually runs. Taking the larger of the
 * two scopes is the only arithmetic performed here, and it is a choice between two
 * reported numbers, never a scale factor, multiplier, or timing inference: no
 * browser's 12 is ever converted into a 32.
 *
 * A count that is genuinely reduced in *both* scopes is a boundary this page cannot
 * cross and does not pretend to: the pool then matches the reduced report exactly,
 * and `data-stress-cpu-report-page`/`data-stress-cpu-report-worker` publish what was
 * actually said so the shortfall is visible rather than papered over.
 */
export function planCpuPool(input: CpuPoolPlanInput = {}): CpuPoolPlan {
  const pageReport = sanitizeLogicalProcessorReport(input.pageReport);
  const workerReport = sanitizeLogicalProcessorReport(input.workerReport);
  const exact = sanitizeLogicalProcessorReport(input.exactWorkers);
  if (exact > 0) {
    // The diagnostic hook is a REQUEST, and it is honoured literally â€” including a
    // count above what either scope reports, which is how a specific pool size is
    // tested on any machine. It is the only way a pool size gets overridden.
    return { pageReport, workerReport, reported: exact, workers: exact, source: 'exact' };
  }
  const reported = Math.max(pageReport, workerReport);
  if (reported > 0) {
    return { pageReport, workerReport, reported, workers: reported, source: 'report' };
  }
  return { pageReport, workerReport, reported: 0, workers: CPU_POOL_FALLBACK_WORKERS, source: 'fallback' };
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
