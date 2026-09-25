import {
  CpuPoolGrowth,
  CPU_POOL_CONTENTION_SHARE,
  CPU_POOL_GROWTH_WINDOW_MS,
  CPU_POOL_MAX_GROWTH_ROUNDS,
  CPU_POOL_MAX_IDLE_WINDOWS,
  CPU_POOL_MAX_WORKERS,
  CPU_POOL_MIN_WINDOW_SLICES,
  CPU_POOL_TRUSTED_REPORT_MAX,
  CPU_POOL_WINDOW_HISTORY,
  formatStressElapsed,
  nextCpuWorkerCount,
  planCpuPool,
  resolveGpuBackend,
  resolveGpuBackendFallbacks,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState
} from '@utilities/stressTestCore';

/**
 * Feeds the pool-growth state machine synthetic measurement windows, one
 * CPU_POOL_GROWTH_WINDOW_MS apart. Each step states the pool size that was live
 * during the window, how many candidates it completed, and what the pool's own
 * scheduling counters said over it: `duty` is the share of wall time spent
 * sieving rather than waiting to run, and `slow` of `slices` compute slices lost
 * their thread mid-slice. A test therefore describes a machine's behaviour rather
 * than the policy's internals, and the defaults are a pool that has a processor
 * each: `duty: 1`, no overruns.
 */
function windows(growth: CpuPoolGrowth, steps: Array<{
  workers: number; work: number; slices?: number; slow?: number; duty?: number;
}>) {
  let at = 0;
  let total = 0;
  return steps.map(step => {
    at += CPU_POOL_GROWTH_WINDOW_MS;
    total += step.work;
    const slices = step.slices ?? 1000;
    const slow = step.slow ?? 0;
    return growth.observe(at, total, step.workers, {
      duty: step.duty ?? 1,
      slowShare: slices > 0 ? slow / slices : 0,
      slices
    });
  });
}

describe('stress test core helpers', () => {
  it('plans the whole reported logical-processor hint as the initial pool', () => {
    // No halving, no reserved core, no automatic SMT multiplier: the report is
    // the starting workload, and growth beyond it is bounded but allowed.
    expect(planCpuPool({ hardwareConcurrency: 8 })).toEqual({ reported: 8, initial: 8, ceiling: CPU_POOL_MAX_WORKERS, pinned: false });
    expect(planCpuPool({ hardwareConcurrency: 32 }).initial).toBe(32);
    expect(planCpuPool({ hardwareConcurrency: 1 }).initial).toBe(1);
  });

  it('never lets the growth bound truncate a valid higher report', () => {
    // The cap is a runaway guard for growth, not a hardware claim: a browser
    // that really reports more than the guard still gets its own count.
    expect(planCpuPool({ hardwareConcurrency: 256 })).toEqual({ reported: 256, initial: 256, ceiling: 256, pinned: false });
    expect(nextCpuWorkerCount(256, 256)).toBe(256);
  });

  it('falls back to a small pool when the report is unusable', () => {
    expect(planCpuPool({ hardwareConcurrency: 0 }).initial).toBe(4);
    expect(planCpuPool({ hardwareConcurrency: -8 }).initial).toBe(4);
    expect(planCpuPool({ hardwareConcurrency: Number.NaN }).initial).toBe(4);
    expect(planCpuPool({ hardwareConcurrency: Number.POSITIVE_INFINITY }).initial).toBe(4);
    expect(planCpuPool({ hardwareConcurrency: Number.MAX_SAFE_INTEGER }).initial).toBe(4);
    expect(planCpuPool({}).initial).toBe(4);
    expect(planCpuPool({ hardwareConcurrency: 8.9 }).initial).toBe(8);
    // The largest real configuration is honoured; beyond it a "count" is not
    // hardware, and honouring it would mean spawning workers by the million.
    expect(planCpuPool({ hardwareConcurrency: CPU_POOL_TRUSTED_REPORT_MAX }).initial).toBe(CPU_POOL_TRUSTED_REPORT_MAX);
    expect(planCpuPool({ hardwareConcurrency: CPU_POOL_TRUSTED_REPORT_MAX + 1 }).initial).toBe(4);
    // An absurd diagnostic override is not honoured either, and the pool stays
    // visibly automatic instead of silently pinning a nonsense count.
    expect(planCpuPool({ hardwareConcurrency: 8, exactWorkers: CPU_POOL_TRUSTED_REPORT_MAX + 1 }).pinned).toBe(false);
  });

  it('separates an exact diagnostic request from a ceiling', () => {
    // Exact request: this many workers, no growth, and it may exceed the report.
    expect(planCpuPool({ hardwareConcurrency: 4, exactWorkers: 64 }))
      .toEqual({ reported: 4, initial: 64, ceiling: 64, pinned: true });
    expect(planCpuPool({ hardwareConcurrency: 4, exactWorkers: 1 }))
      .toEqual({ reported: 4, initial: 1, ceiling: 1, pinned: true });
    // Ceiling: a limit on the automatic pool, never a request for workers.
    expect(planCpuPool({ hardwareConcurrency: 32, maxWorkers: 2 }))
      .toEqual({ reported: 32, initial: 2, ceiling: 2, pinned: false });
    expect(planCpuPool({ hardwareConcurrency: 4, maxWorkers: 64 }).ceiling).toBe(64);
    // Exact wins over the ceiling hook: the request is what the diagnosis asked for.
    expect(planCpuPool({ hardwareConcurrency: 4, exactWorkers: 12, maxWorkers: 2 }).initial).toBe(12);
  });

  it('grows in coarse bounded steps and stops at the ceiling', () => {
    expect(nextCpuWorkerCount(1, 128)).toBe(3);
    expect(nextCpuWorkerCount(2, 128)).toBe(4);
    expect(nextCpuWorkerCount(12, 128)).toBe(18);
    expect(nextCpuWorkerCount(32, 128)).toBe(48);
    expect(nextCpuWorkerCount(47, 128)).toBe(71);
    expect(nextCpuWorkerCount(120, 128)).toBe(128); // clamped, one bounded step
    expect(nextCpuWorkerCount(128, 128)).toBe(128); // already at the ceiling
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

describe('automatic CPU pool growth', () => {
  it('rejects a meaningless growth ceiling', () => {
    expect(() => new CpuPoolGrowth(0)).toThrow('growth ceiling');
    expect(() => new CpuPoolGrowth(1.5)).toThrow('growth ceiling');
    expect(() => new CpuPoolGrowth(Number.NaN)).toThrow('growth ceiling');
    expect(() => new CpuPoolGrowth(8, -1)).toThrow('growth floor');
  });

  it('skips the window that contains its own startup before deciding anything', () => {
    const growth = new CpuPoolGrowth(128);
    const actions = windows(growth, [
      { workers: 4, work: 4000 }, // primes the window
      { workers: 4, work: 4000 }, // contains worker spawn and first-slice ramp
      { workers: 4, work: 4000 }
    ]);
    expect(actions).toEqual(['none', 'none', 'grow']);
    expect(growth.done).toBe(false);
  });

  it('keeps growing while every worker is handed a processor straight away', () => {
    // A duty cycle of 1 means no worker ever waited between slices, which is what
    // a pool that still has free logical processors to claim looks like.
    const growth = new CpuPoolGrowth(128);
    const actions = windows(growth, [
      { workers: 4, work: 4000 }, // primes
      { workers: 4, work: 4000 }, // startup window, skipped
      { workers: 4, work: 4000 }, // free capacity → step
      { workers: 6, work: 6000 }, // window containing the spawn, skipped
      { workers: 6, work: 6000 }, // still free capacity → step
      { workers: 9, work: 9000 } // skipped again after the second step
    ]);
    expect(actions).toEqual(['none', 'none', 'grow', 'none', 'grow', 'none']);
    expect(growth.done).toBe(false);
  });

  it('records a duty cycle without letting it decide anything', () => {
    // Measured on a 16-core/32-thread host, the pool's compute duty cycle stayed at
    // 99–100% from 4 workers to 256 on 32 threads: this browser and operating system
    // hand a worker a processor the instant its slice ends, so queueing a page can
    // see never happens. A stop rule built on it therefore never stopped. The ratio
    // is still recorded in every window, because it is what tells a pool that cannot
    // get integers to sieve apart from one that cannot get processors.
    const growth = new CpuPoolGrowth(128);
    const actions = windows(growth, [
      { workers: 4, work: 4000, duty: 0.2 },
      { workers: 4, work: 4000, duty: 0.2 },
      { workers: 4, work: 4000, duty: 0.2 }, // "queueing", and no slice lost → step
      { workers: 6, work: 6000, duty: 0.05 }, // skipped
      { workers: 6, work: 6000, duty: 0.05 } // still no lost slices → step again
    ]);
    expect(actions).toEqual(['none', 'none', 'grow', 'none', 'grow']);
    expect(growth.done).toBe(false);
    expect(growth.windows.at(-1)!.duty).toBeCloseTo(0.05, 6);
  });

  it('stops growing when slices start losing their thread', () => {
    // The stop condition, and the only one the platform answers with: enough
    // workers that the scheduler is demonstrably taking processors away from them
    // mid-slice. Threshold sits in the measured gap between 1% (2× the thread count,
    // already fully loaded) and 25% (3×), so noise cannot stop growth short.
    const growth = new CpuPoolGrowth(128);
    const actions = windows(growth, [
      { workers: 4, work: 4000 },
      { workers: 4, work: 4000 },
      { workers: 4, work: 4000 }, // no overruns → step
      { workers: 6, work: 6000 }, // skipped
      { workers: 6, work: 6000, slow: Math.ceil(1000 * CPU_POOL_CONTENTION_SHARE) } // → stop
    ]);
    expect(actions).toEqual(['none', 'none', 'grow', 'none', 'settled']);
    expect(growth.done).toBe(true);
  });

  it('never stops below the reported processor count on a measured share', () => {
    // The guard that keeps an under-reporting browser growing. The share only
    // appears well past the machine, and where it does appear below the count the
    // browser itself asked for it cannot be attributed to this pool — so the report
    // is the authority there, and one window of it is not enough to stop the pool.
    const growth = new CpuPoolGrowth(128, 32);
    const preempted = Math.ceil(1000 * CPU_POOL_CONTENTION_SHARE);
    const actions = windows(growth, [
      { workers: 4, work: 4000, slow: preempted },
      { workers: 4, work: 4000, slow: preempted },
      { workers: 4, work: 4000, slow: preempted }, // far below the report → still grows
      { workers: 6, work: 6000, slow: preempted }, // skipped
      { workers: 6, work: 6000, slow: preempted } // still below the report → grows
    ]);
    expect(actions).toEqual(['none', 'none', 'grow', 'none', 'grow']);
    expect(growth.done).toBe(false);
    // At the report, the same reading does end growth.
    expect(windows(new CpuPoolGrowth(128, 6), [
      { workers: 6, work: 6000 },
      { workers: 6, work: 6000 },
      { workers: 6, work: 6000, slow: preempted }
    ])[2]).toBe('settled');
  });

  it('grows even when the candidate rate falls, because work-rate is not the signal', () => {
    // The reason this policy does not decide on throughput, measured on a
    // 16-core/32-thread host: 4 → 128 workers moved the pool's aggregate rate by
    // under +18% while operating-system load went from 25% to 100%, and inside a
    // run the rate sags several percent per second on its own. A pool that grew on
    // rate therefore stops with most of the machine idle. A worker that is handed
    // its next slice immediately remains the evidence that another processor is
    // free, whatever the sieve's throughput happens to be doing.
    const growth = new CpuPoolGrowth(128);
    const actions = windows(growth, [
      { workers: 8, work: 8000 },
      { workers: 8, work: 8000 },
      { workers: 8, work: 8000 }, // free capacity → step
      { workers: 12, work: 7000 }, // skipped
      { workers: 12, work: 4800 } // −31% aggregate, duty still 1 → still step
    ]);
    expect(actions).toEqual(['none', 'none', 'grow', 'none', 'grow']);
    expect(growth.windows.at(-1)!.gain).toBeLessThan(-0.25);
  });

  it('ends growth at the runaway ceiling instead of claiming a hardware count', () => {
    const growth = new CpuPoolGrowth(4);
    const actions = windows(growth, [
      { workers: 4, work: 4000 },
      { workers: 4, work: 4000 },
      { workers: 4, work: 4000 } // would grow, but 4 is already the ceiling
    ]);
    expect(actions[2]).toBe('capped');
    expect(growth.done).toBe(true);
  });

  it('stops probing a pool that reports no progress at all', () => {
    // Zero work is not evidence about capacity, and a window with almost no
    // slices measures no contention either — an idle worker has zero overruns for
    // the same reason it has zero work. Growing on either would inflate a stalled
    // pool, so a bounded run of evidence-free windows ends growth.
    const growth = new CpuPoolGrowth(128);
    const actions = windows(growth, [
      { workers: 2, work: 2000 },
      { workers: 2, work: 0 },
      ...Array.from({ length: CPU_POOL_MAX_IDLE_WINDOWS - 1 }, () => ({ workers: 2, work: 0 }))
    ]);
    expect(actions.filter(action => action === 'settled')).toHaveLength(1);
    expect(actions.at(-1)).toBe('settled');
    expect(growth.done).toBe(true);
  });

  it('treats a window with too few slices to measure contention as no evidence', () => {
    const growth = new CpuPoolGrowth(128);
    const actions = windows(growth, Array.from({ length: CPU_POOL_MAX_IDLE_WINDOWS + 1 }, () => ({
      workers: 2, work: 500, slices: CPU_POOL_MIN_WINDOW_SLICES - 1
    })));
    expect(actions.every(action => action === 'none' || action === 'settled')).toBe(true);
    expect(actions.at(-1)).toBe('settled');
    expect(growth.done).toBe(true);
  });

  it('bounds growth rounds when the signal never settles', () => {
    // A machine that never queuees and never loses a slice must still end up with
    // a fixed pool. The worker ceiling is far away on purpose, so only the round
    // bound can stop this.
    const growth = new CpuPoolGrowth(1_000_000);
    let at = 0;
    let total = 0;
    let live = 2;
    const seen: string[] = [];
    while (at < CPU_POOL_GROWTH_WINDOW_MS * (CPU_POOL_MAX_GROWTH_ROUNDS * 4 + 20)) {
      at += CPU_POOL_GROWTH_WINDOW_MS;
      total += live * 1000;
      const action = growth.observe(at, total, live, { duty: 1, slowShare: 0, slices: 1000 });
      seen.push(action);
      if (action === 'grow') live = nextCpuWorkerCount(live, 1_000_000);
      if (action === 'settled' || action === 'capped') break;
    }
    expect(seen.filter(action => action === 'grow')).toHaveLength(CPU_POOL_MAX_GROWTH_ROUNDS);
    expect(live).toBeLessThan(1_000_000); // the round bound fired, not the ceiling
    expect(seen.at(-1)).toBe('settled');
    expect(growth.done).toBe(true);
  });

  it('records the numbers behind each decision, bounded to the recent history', () => {
    const growth = new CpuPoolGrowth(1_000_000);
    windows(growth, Array.from({ length: CPU_POOL_WINDOW_HISTORY + 6 }, (_unused, index) => ({
      workers: 4 + index, work: (4 + index) * 1000, slow: 0, duty: 0.95
    })));
    expect(growth.windows).toHaveLength(CPU_POOL_WINDOW_HISTORY);
    for (const window of growth.windows) {
      expect(window.workers).toBeGreaterThan(0);
      expect(window.rate).toBeGreaterThan(0);
      expect(window.perWorker).toBeGreaterThan(0);
      expect(window.slices).toBe(1000);
      expect(window.slowShare).toBe(0);
      expect(window.duty).toBeCloseTo(0.95, 6);
      expect(['none', 'grow', 'settled', 'capped']).toContain(window.action);
    }
    // The ring keeps the newest windows, which is the range a decision uses.
    expect(growth.windows.at(-1)!.workers).toBeGreaterThan(growth.windows[0].workers);
  });

  it('ignores incoherent observations and windows shorter than the measurement', () => {
    const growth = new CpuPoolGrowth(128);
    expect(growth.observe(Number.NaN, 10, 2)).toBe('none');
    expect(growth.observe(1000, Number.NaN, 2)).toBe('none');
    expect(growth.observe(1000, 10, 0)).toBe('none');
    expect(growth.observe(1000, 10, 1.5)).toBe('none');
    expect(growth.observe(1000, 10, 2, { duty: 1, slowShare: 0, slices: 1000 })).toBe('none'); // primes
    expect(growth.observe(1000 + CPU_POOL_GROWTH_WINDOW_MS - 1, 20, 2, { duty: 1, slowShare: 0, slices: 1000 })).toBe('none');
    // Earliest real window: still skipped as startup, whatever it says.
    expect(growth.observe(1000 + CPU_POOL_GROWTH_WINDOW_MS, 20, 2, { duty: 1, slowShare: 0, slices: 1000 })).toBe('none');
    expect(growth.done).toBe(false);
  });
});
