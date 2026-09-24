import {
  CpuSmtProbe,
  formatStressElapsed,
  resolveCpuWorkerCount,
  resolveGpuBackend,
  resolveGpuBackendFallbacks,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState,
  type CpuSmtProbeAction
} from '@utilities/stressTestCore';

// Drives the heartbeat-only probe through trials without timers: baseline
// windows tick at ~1 work unit/ms (1 = 800 work units per 800ms window), and
// a candidate window's delta scales its rate against the recent-window mean.
function probeDriver(probe: CpuSmtProbe) {
  let now = 400;
  let work = 100;
  const obs = (dt: number, delta: number) => {
    now += dt;
    work += delta;
    return probe.observe(now, work);
  };
  return {
    now: () => now,
    // Opens the measurement window after the settle warmup (the initial one
    // is anchored by an extra first observation), then closes the baseline
    // windows; the last closes with the spawn decision.
    baseline(cold = false, windowDeltas: number[] = [800, 800, 800]) {
      if (cold) obs(1, 1); // anchors the initial settle warmup
      obs(700, 1); // warmup ends, first window opens
      let action: CpuSmtProbeAction = { action: 'none' };
      for (const delta of windowDeltas) action = obs(800, delta);
      return action;
    },
    // Candidate windows at `windowDelta` work units each: kept on the first
    // window that beats the reference by the keep ratio, reverted on two
    // consecutive misses.
    candidate(windowDelta: number) {
      obs(700, 100); // warmup ends, candidate window opens
      const first = obs(800, windowDelta);
      if (first.action === 'keep') return first;
      return obs(800, windowDelta);
    }
  };
}

describe('stress test core helpers', () => {
  it('resolves CPU worker count from hardware concurrency without a production cap', () => {
    expect(resolveCpuWorkerCount({ hardwareConcurrency: 8 })).toBe(8);
    expect(resolveCpuWorkerCount({ hardwareConcurrency: 0 })).toBe(1);
    expect(resolveCpuWorkerCount({ hardwareConcurrency: 128 })).toBe(128);
    expect(resolveCpuWorkerCount({ hardwareConcurrency: 16, maxWorkers: 2 })).toBe(2);
    expect(resolveCpuWorkerCount({ hardwareConcurrency: NaN })).toBe(4);
    expect(resolveCpuWorkerCount({ hardwareConcurrency: Infinity })).toBe(4);
    expect(resolveCpuWorkerCount({ hardwareConcurrency: Number.MAX_SAFE_INTEGER })).toBe(4);
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

  it('rejects an unusable reported worker count or cap', () => {
    expect(() => new CpuSmtProbe(0)).toThrow('reported worker count');
    expect(() => new CpuSmtProbe(1.5)).toThrow('reported worker count');
    expect(() => new CpuSmtProbe(Number.NaN)).toThrow('reported worker count');
    expect(() => new CpuSmtProbe(64, 32)).toThrow('worker cap');
  });

  it('doubles the exponential phase and converts kept waves in full', () => {
    const probe = new CpuSmtProbe(3);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 3 }); // trial 6
    expect(driver.candidate(1600)).toEqual({ action: 'keep', convert: 3 }); // 2× rate → capacity 6
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 6 }); // trial 12
    expect(driver.candidate(1600)).toEqual({ action: 'keep', convert: 6 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 12 }); // trial 24
  });

  it('trims a kept wave that strides past the measured capacity', () => {
    // Reported 12 on a machine whose measured capacity is ~32: the 24-member
    // 48 wave only raises aggregate throughput 32/24, so keep converts just
    // the 8 workers the ratio explains (12 × 32/24 = 32 total) instead of
    // installing all 24 — the count lands at capacity, not above it.
    const probe = new CpuSmtProbe(12);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 12 }); // trial 24
    expect(driver.candidate(2400)).toEqual({ action: 'keep', convert: 12 }); // full 2× wave
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 24 }); // trial 48
    expect(driver.candidate(1067)).toEqual({ action: 'keep', convert: 8 }); // 1.33× → capacity ≈ 32
    expect(probe.registerKeep(driver.now())).toBe(false); // bracket [32, 48]
  });

  it('refines by bisecting between the last grown and first stalled count', () => {
    const probe = new CpuSmtProbe(12);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 12 }); // trial 24
    expect(driver.candidate(2400)).toEqual({ action: 'keep', convert: 12 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 24 }); // trial 48
    expect(driver.candidate(40)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(false); // bracket [24, 48]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 12 }); // trial 36
    expect(driver.candidate(1200)).toEqual({ action: 'keep', convert: 12 });
    expect(probe.registerKeep(driver.now())).toBe(false); // bracket [36, 48]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 6 }); // trial 42
    expect(driver.candidate(40)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(false); // bracket [36, 42]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 3 }); // trial 39
    expect(driver.candidate(40)).toEqual({ action: 'revert' });
    // Bracket [36, 39] is inside tolerance: the run keeps the proven 36.
    expect(probe.registerRevert(driver.now())).toBe(true);
    expect(driver.candidate(40)).toEqual({ action: 'none' });
  });

  it('compares candidate windows against the newest baseline windows, not the startup peak', () => {
    // Frontier decay traced on a real browser: a lone worker runs 2.0 units/ms
    // at the shallow frontier and decays to 1.1 within the baseline phase.
    // The wave (2 workers on a multi-threaded machine) aggregates 1.75 — far
    // below the startup peak (which the original probe kept and reverted on),
    // but clearly above the recent-window mean of 1.3.
    const probe = new CpuSmtProbe(1);
    const driver = probeDriver(probe);
    expect(driver.baseline(true, [1600, 1200, 880])).toEqual({ action: 'spawn', extra: 1 });
    expect(driver.candidate(1400)).toEqual({ action: 'keep', convert: 1 });
    expect(probe.registerKeep(driver.now())).toBe(false);
  });

  it('stops after one failed wave when the browser report never grew', () => {
    // A correctly reported machine must pay exactly one disposable wave and
    // keep its reported workers — no refinement churn.
    const probe = new CpuSmtProbe(32);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 32 });
    expect(driver.candidate(40)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true);
    expect(driver.baseline()).toEqual({ action: 'none' });
  });

  it('stops at the total-worker cap', () => {
    const probe = new CpuSmtProbe(100, 128);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 28 }); // capped trial 128
    expect(driver.candidate(1600)).toEqual({ action: 'keep', convert: 28 });
    expect(probe.registerKeep(driver.now())).toBe(true); // cap reached
  });

  it('keeps the probe wave only when a candidate window beats the recent baseline mean', () => {
    const probe = new CpuSmtProbe(2);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 2 });
    expect(driver.candidate(960)).toEqual({ action: 'keep', convert: 1 }); // 1.2×: barely over the ratio
    expect(driver.candidate(7200)).toEqual({ action: 'none' }); // decided
  });

  it('reverts the probe wave when no candidate window grows work throughput', () => {
    const probe = new CpuSmtProbe(2);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 2 });
    expect(driver.candidate(40)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true); // report never grew
  });

  it('re-baselines after a keep and refines after the next wave stalls', () => {
    const probe = new CpuSmtProbe(2);
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 2 }); // trial 4
    expect(driver.candidate(1600)).toEqual({ action: 'keep', convert: 2 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 4 }); // trial 8
    expect(driver.candidate(40)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(false); // bracket [4, 8]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 2 }); // trial 6
    expect(driver.candidate(40)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true); // bracket [4, 6] inside tolerance
  });

  it('rejects keep and revert recorded outside their decisions', () => {
    const probe = new CpuSmtProbe(2);
    expect(() => probe.registerKeep(500)).toThrow('outside a keep decision');
    expect(() => probe.registerRevert(500)).toThrow('outside a revert decision');
    const driver = probeDriver(probe);
    expect(driver.baseline(true)).toEqual({ action: 'spawn', extra: 2 });
    expect(() => probe.registerKeep(driver.now())).toThrow('outside a keep decision');
    expect(driver.candidate(1600)).toEqual({ action: 'keep', convert: 2 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(() => probe.registerRevert(driver.now())).toThrow('outside a revert decision');
  });

  it('reverts without spawning when every baseline window reports no progress', () => {
    const probe = new CpuSmtProbe(4);
    const driver = probeDriver(probe);
    expect(driver.baseline(true, [0, 0, 0])).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true);
    expect(driver.candidate(1600)).toEqual({ action: 'none' });
  });
});
