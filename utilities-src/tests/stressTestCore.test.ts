import {
  CpuSmtProbe,
  formatStressElapsed,
  resolveCpuWorkerCount,
  resolveGpuBackend,
  resolveGpuBackendFallbacks,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState
} from '@utilities/stressTestCore';

// Drives the heartbeat-only probe through interleaved trials without timers.
// A window closes on a heartbeat ≥600ms after the window opened; every action
// settles first, so a window is opened by a beat clearing the settle warmup
// and closed 600ms later. Production off windows default to 600 work units
// (rate 1.0); the keep decision compares production on-window rates against
// the bracketing off windows — bench deltas ride along for the liveness guard.
function probeDriver(probe: CpuSmtProbe) {
  let now = 400;
  let work = 100;
  let bench = 0;
  const beat = (dt: number, delta: number, benchDelta = 0) => {
    now += dt;
    work += delta;
    bench += benchDelta;
    return probe.observe(now, work, bench);
  };
  const open = (warmupMs: number) => beat(warmupMs + 100, 0);
  const close = (delta: number, benchDelta = 0) => beat(600, delta, benchDelta);
  return {
    now: () => now,
    beat,
    // The first heartbeat anchors the initial settle warmup.
    anchor() {
      beat(1, 1);
    },
    // Two pre-spawn off windows; the second close decides the spawn. The
    // first close may already revert via the idle guard.
    baseline(offDelta = 600) {
      open(700);
      const first = close(offDelta);
      if (first.action !== 'none') return first;
      return close(offDelta);
    },
    // One full trial flip: off3 → resume, on1 → pause, off4 → resume,
    // on2 → keep/revert decision. `onDelta` is the permanent workers' rate
    // under the wave; bench workers report `benchDelta` per on window.
    trial(onDelta: number, offDelta = 600, benchDelta = 600) {
      open(700);
      expect(close(offDelta)).toEqual({ action: 'resume' });
      open(300);
      expect(close(onDelta, benchDelta)).toEqual({ action: 'pause' });
      open(300);
      expect(close(offDelta)).toEqual({ action: 'resume' });
      open(300);
      return close(onDelta, benchDelta);
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
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 3 }); // trial 6
    expect(driver.trial(600)).toEqual({ action: 'keep', convert: 3 }); // no slowdown → capacity ≥ 6
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 6 }); // trial 12
    expect(driver.trial(600)).toEqual({ action: 'keep', convert: 6 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 12 }); // trial 24
  });

  it('converts a slowed SMT-region trial in full instead of trimming it', () => {
    // Reported 12 on a 16-physical/32-logical machine: the 48-total trial
    // shares some permanent workers with SMT siblings and measures 0.8 —
    // threads still exist, so the wave converts in full. Trimming keeps by a
    // fair-sharing capacity estimate was the old bug: it read this
    // sharing-caused slowdown as oversubscription, converted only part of the
    // wave, and capped the search below the machine's real capacity.
    const probe = new CpuSmtProbe(12);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 12 }); // trial 24
    expect(driver.trial(600)).toEqual({ action: 'keep', convert: 12 }); // full 2× wave
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 24 }); // trial 48
    expect(driver.trial(480)).toEqual({ action: 'keep', convert: 24 }); // 0.8×: SMT sharing, not time-slicing
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 48 }); // trial 96
  });

  it('refines by bisecting between the last grown and first oversubscribed trial', () => {
    // Reported 12 on a simulated 32-thread machine: a trial total T above the
    // thread count reads ≈ 32 ÷ T permanent-worker slowdown (pure
    // time-slicing). 48 slows to 0.67 → revert; 36 (0.89) and 42 (0.76) stay
    // within the keep ratio → convert; 45 (0.71) reverts inside tolerance.
    const probe = new CpuSmtProbe(12);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 12 }); // trial 24
    expect(driver.trial(600)).toEqual({ action: 'keep', convert: 12 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 24 }); // trial 48
    expect(driver.trial(400)).toEqual({ action: 'revert' }); // 0.67 < 0.75
    expect(probe.registerRevert(driver.now())).toBe(false); // bracket [24, 48]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 12 }); // trial 36
    expect(driver.trial(533)).toEqual({ action: 'keep', convert: 12 }); // 0.89
    expect(probe.registerKeep(driver.now())).toBe(false); // bracket [36, 48]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 6 }); // trial 42
    expect(driver.trial(457)).toEqual({ action: 'keep', convert: 6 }); // 0.76
    expect(probe.registerKeep(driver.now())).toBe(false); // bracket [42, 48]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 3 }); // trial 45
    expect(driver.trial(426)).toEqual({ action: 'revert' }); // 0.71
    // Bracket [42, 45] is inside tolerance: the run keeps the proven 42.
    expect(probe.registerRevert(driver.now())).toBe(true);
  });

  it('measures each on window against bracketing off windows, immune to drift', () => {
    // The regression this protocol exists for: CPU boost sag and frontier
    // decay cut every worker's rate ~30% between the pre-spawn windows and
    // the trial. A sequential comparison would read the on windows against
    // the earlier (faster-clock) baseline as a 30% slowdown and revert a
    // wave that never touched existing workers; the interleaved ratio
    // compares same-moment rates, measures 1.0, and converts the whole wave.
    const probe = new CpuSmtProbe(12);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline(960)).toEqual({ action: 'spawn', extra: 12 }); // trial 24
    expect(driver.trial(672, 672)).toEqual({ action: 'keep', convert: 12 }); // on/off = 1.0
    expect(probe.registerKeep(driver.now())).toBe(false); // capacity not yet bounded
  });

  it('reverts when a silent benchmark wave makes the trial unmeasurable', () => {
    const probe = new CpuSmtProbe(2);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 2 });
    // Permanent workers are unimpeded (ratio 1.0) but the wave itself did no
    // work during either on window — nothing was measured, nothing is kept.
    expect(driver.trial(600, 600, 0)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true); // report never grew
  });

  it('stops after one failed wave when the browser report never grew', () => {
    // A correctly reported machine must pay exactly one disposable wave and
    // keep its reported workers — no refinement churn.
    const probe = new CpuSmtProbe(32);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 32 });
    expect(driver.trial(30)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'none' });
  });

  it('stops at the total-worker cap', () => {
    const probe = new CpuSmtProbe(100, 128);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 28 }); // capped trial 128
    expect(driver.trial(600)).toEqual({ action: 'keep', convert: 28 });
    expect(probe.registerKeep(driver.now())).toBe(true); // cap reached
  });

  it('keeps waves slowed up to the keep ratio and reverts slower ones', () => {
    const kept = new CpuSmtProbe(2);
    const keptDriver = probeDriver(kept);
    keptDriver.anchor();
    expect(keptDriver.baseline()).toEqual({ action: 'spawn', extra: 2 });
    expect(keptDriver.trial(450)).toEqual({ action: 'keep', convert: 2 }); // exactly 0.75: SMT-region sharing
    const reverted = new CpuSmtProbe(2);
    const revertedDriver = probeDriver(reverted);
    revertedDriver.anchor();
    expect(revertedDriver.baseline()).toEqual({ action: 'spawn', extra: 2 });
    expect(revertedDriver.trial(435)).toEqual({ action: 'revert' }); // 0.725: time-slicing began
  });

  it('re-baselines after a keep and refines after the next wave slows workers', () => {
    const probe = new CpuSmtProbe(2);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 2 }); // trial 4
    expect(driver.trial(600)).toEqual({ action: 'keep', convert: 2 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 4 }); // trial 8
    expect(driver.trial(30)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(false); // bracket [4, 8]
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 2 }); // trial 6
    expect(driver.trial(30)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true); // bracket [4, 6] inside tolerance
  });

  it('rejects keep and revert recorded outside their decisions', () => {
    const probe = new CpuSmtProbe(2);
    expect(() => probe.registerKeep(500)).toThrow('outside a keep decision');
    expect(() => probe.registerRevert(500)).toThrow('outside a revert decision');
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline()).toEqual({ action: 'spawn', extra: 2 });
    expect(() => probe.registerKeep(driver.now())).toThrow('outside a keep decision');
    expect(driver.trial(600)).toEqual({ action: 'keep', convert: 2 });
    expect(probe.registerKeep(driver.now())).toBe(false);
    expect(() => probe.registerRevert(driver.now())).toThrow('outside a revert decision');
  });

  it('reverts without spawning when the first off window reports no progress', () => {
    const probe = new CpuSmtProbe(4);
    const driver = probeDriver(probe);
    driver.anchor();
    expect(driver.baseline(0)).toEqual({ action: 'revert' });
    expect(probe.registerRevert(driver.now())).toBe(true);
    driver.anchor();
    expect(driver.baseline(1200)).toEqual({ action: 'none' });
  });
});
