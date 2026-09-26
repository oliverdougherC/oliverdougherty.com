import * as stressTestCore from '@utilities/stressTestCore';
import {
  CPU_POOL_FALLBACK_WORKERS,
  CPU_POOL_TRUSTED_REPORT_MAX,
  formatStressElapsed,
  planCpuPool,
  resolveGpuBackend,
  resolveGpuBackendFallbacks,
  sanitizeLogicalProcessorReport,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState
} from '@utilities/stressTestCore';

describe('stress test core helpers', () => {
  it('plans the whole reported logical-processor count, unchanged', () => {
    // No halving, no reserved core, no rounding to a topology the browser did not
    // report, no automatic SMT multiplier: the report IS the pool.
    expect(planCpuPool({ pageReport: 1 })).toEqual({
      pageReport: 1, workerReport: 0, reported: 1, workers: 1, source: 'report'
    });
    for (const count of [2, 3, 4, 6, 7, 8, 12, 14, 16, 24, 32, 48, 64, 96, 128, 256]) {
      expect(planCpuPool({ pageReport: count }).workers, String(count)).toBe(count);
    }
  });

  it.each([
    [6, 6], [12, 12], [14, 14], [22, 22], [32, 32], [48, 48], [96, 96]
  ])('sizes the pool at the full report for %i logical processors', (reported) => {
    // Non-powers of two included on purpose: nothing here prefers a "nice" number.
    const plan = planCpuPool({ pageReport: reported, workerReport: reported });
    expect(plan.workers).toBe(reported);
    expect(plan.reported).toBe(reported);
    expect(plan.source).toBe('report');
  });

  it('keeps a count a browser reported only in worker scope', () => {
    // Measured on the affected host: a browser with fingerprint protection reported
    // 12/14/16 in window scope, varying per launch, while a worker it created
    // reported the machine's real 32. The pool is sized for the threads the workers
    // actually run on — by reading the count, never by scaling the page's number.
    expect(planCpuPool({ pageReport: 12, workerReport: 32 }))
      .toEqual({ pageReport: 12, workerReport: 32, reported: 32, workers: 32, source: 'report' });
    expect(planCpuPool({ pageReport: 14, workerReport: 32 }).workers).toBe(32);
    // The other direction: a report reduced only in worker scope still gets the
    // count the window stated. The larger number is the one the browser is willing
    // to state, and it is chosen between two reports, never computed from either.
    expect(planCpuPool({ pageReport: 24, workerReport: 8 }).workers).toBe(24);
    // Equal reports agree, and one missing report is not a reason to size down.
    expect(planCpuPool({ pageReport: 32, workerReport: 32 }).workers).toBe(32);
    expect(planCpuPool({ pageReport: 32 }).workers).toBe(32);
    expect(planCpuPool({ workerReport: 32 }).workers).toBe(32);
  });

  it('honours an exact diagnostic request above the browser report', () => {
    // The regression this branch exists for: a browser reporting 12, asked for 32,
    // gets exactly 32 — and the plan still records what the browser actually said.
    expect(planCpuPool({ pageReport: 12, workerReport: 12, exactWorkers: 32 })).toEqual({
      pageReport: 12, workerReport: 12, reported: 32, workers: 32, source: 'exact'
    });
    expect(planCpuPool({ pageReport: 32, exactWorkers: 3 }).workers).toBe(3);
    expect(planCpuPool({ pageReport: 4, exactWorkers: 1 }).workers).toBe(1);
  });

  it('rejects an unusable override instead of honouring it literally', () => {
    // A hook value that is not a processor count diagnoses nothing; the pool falls
    // back to the report and says so through `source`.
    for (const exact of [0, -4, Number.NaN, CPU_POOL_TRUSTED_REPORT_MAX + 1]) {
      expect(planCpuPool({ pageReport: 8, exactWorkers: exact }).source).toBe('report');
      expect(planCpuPool({ pageReport: 8, exactWorkers: exact }).workers).toBe(8);
    }
  });

  it('refuses a report beyond the largest real configuration', () => {
    // Inside the bound a report is honoured in full; outside it the number is not a
    // processor count, and taking it literally would spawn workers by the million.
    expect(planCpuPool({ pageReport: CPU_POOL_TRUSTED_REPORT_MAX }).workers).toBe(CPU_POOL_TRUSTED_REPORT_MAX);
    expect(planCpuPool({ pageReport: CPU_POOL_TRUSTED_REPORT_MAX + 1 }).source).toBe('fallback');
    expect(planCpuPool({ pageReport: Number.MAX_SAFE_INTEGER }).workers).toBe(CPU_POOL_FALLBACK_WORKERS);
    expect(planCpuPool({ pageReport: 8, workerReport: CPU_POOL_TRUSTED_REPORT_MAX + 1 }).workers).toBe(8);
  });

  it('falls back to a documented small pool when nothing reported', () => {
    // A fallback is never presented as the machine's processor count: `reported`
    // stays 0 and `source` says `fallback`.
    expect(planCpuPool({})).toEqual({
      pageReport: 0, workerReport: 0, reported: 0, workers: CPU_POOL_FALLBACK_WORKERS, source: 'fallback'
    });
    for (const value of [0, -8, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      expect(planCpuPool({ pageReport: value as number, workerReport: value as number }).source).toBe('fallback');
    }
    // A fractional count is a count, floored, not a rejection.
    expect(planCpuPool({ pageReport: 8.9 }).workers).toBe(8);
    expect(sanitizeLogicalProcessorReport(8.9)).toBe(8);
    expect(sanitizeLogicalProcessorReport(0)).toBe(0);
    expect(sanitizeLogicalProcessorReport('x' as unknown as number)).toBe(0);
  });

  it('produces a plan with nothing left to revise', () => {
    // The plan is a fixed size and nothing else: no ceiling to grow toward, no step,
    // no verdict, no counters a resizer could act on.
    const plan = planCpuPool({ pageReport: 32, workerReport: 32 });
    expect(Object.keys(plan).sort()).toEqual(['pageReport', 'reported', 'source', 'workerReport', 'workers']);
    expect(plan.workers).toBe(plan.reported);
  });

  it('exports no growth or adaptive-sizing machinery', () => {
    // A sizing policy that is no longer in the module cannot run. Growth states,
    // step functions, measurement windows and contention thresholds are all gone
    // rather than merely unused.
    const adaptive = Object.keys(stressTestCore).filter(name =>
      /GROWTH|CONTENTION|SIGNAL|SLICE|STEP|CEILING|PROBE|WINDOW/i.test(name));
    expect(adaptive).toEqual([]);
    expect(stressTestCore).not.toHaveProperty('nextCpuWorkerCount');
    expect(stressTestCore).not.toHaveProperty('CpuPoolGrowth');
  });

  it('maps modes to the correct workload lanes', () => {
    expect(shouldStressCpu('cpu')).toBe(true);
    expect(shouldStressGpu('cpu')).toBe(false);
    expect(shouldStressCpu('gpu')).toBe(false);
    expect(shouldStressGpu('gpu')).toBe(true);
    expect(shouldStressCpu('both')).toBe(true);
    expect(shouldStressGpu('both')).toBe(true);
  });

  it('prefers WebGPU compute before WebGL fragment fallback backends', () => {
    expect(resolveGpuBackend({ hasWebGpu: true, hasWebGl2: true, hasWebGl1: true })).toBe('webgpu-compute');
    expect(resolveGpuBackend({ hasWebGpu: false, hasWebGl2: true, hasWebGl1: true })).toBe('webgl2-fragment');
    expect(resolveGpuBackend({ hasWebGpu: false, hasWebGl2: false, hasWebGl1: true })).toBe('webgl1-fragment');
    expect(resolveGpuBackend({ hasWebGpu: false, hasWebGl2: false, hasWebGl1: false })).toBe('none');
  });

  it('returns the full GPU fallback order for progressive backend startup', () => {
    expect(resolveGpuBackendFallbacks({ hasWebGpu: true, hasWebGl2: true, hasWebGl1: true })).toEqual([
      'webgpu-compute',
      'webgl2-fragment',
      'webgl1-fragment'
    ]);
    expect(resolveGpuBackendFallbacks({ hasWebGpu: false, hasWebGl2: false, hasWebGl1: true })).toEqual([
      'webgl1-fragment'
    ]);
    expect(resolveGpuBackendFallbacks({ hasWebGpu: false, hasWebGl2: false, hasWebGl1: false })).toEqual(['none']);
  });

  it('transitions through explicit run, stop, unsupported, and error states', () => {
    expect(transitionStressState('idle', 'start')).toBe('starting');
    expect(transitionStressState('starting', 'running')).toBe('running');
    expect(transitionStressState('running', 'stop')).toBe('stopping');
    expect(transitionStressState('stopping', 'stopped')).toBe('idle');
    expect(transitionStressState('starting', 'unsupported')).toBe('unsupported');
    expect(transitionStressState('running', 'error')).toBe('error');
    expect(transitionStressState('idle', 'error')).toBe('idle');
  });

  it('formats elapsed runtime for short and long stress sessions', () => {
    expect(formatStressElapsed(0)).toBe('0:00');
    expect(formatStressElapsed(65_000)).toBe('1:05');
    expect(formatStressElapsed(3_661_000)).toBe('1:01:01');
    expect(formatStressElapsed(100 * 60 * 60 * 1000)).toBe('4d 4:00:00');
  });
});
