import {
  CpuSmtProbe,
  formatStressElapsed,
  resolveCpuWorkerCount,
  resolveGpuBackend,
  resolveGpuBackendFallbacks,
  resolveSmtProbeExtraWorkers,
  shouldStressCpu,
  shouldStressGpu,
  transitionStressState
} from '@utilities/stressTestCore';

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

  it('sizes the SMT probe wave to double the reported workers under a total cap', () => {
    expect(resolveSmtProbeExtraWorkers(2)).toBe(2);
    expect(resolveSmtProbeExtraWorkers(64)).toBe(64);
    expect(resolveSmtProbeExtraWorkers(100)).toBe(28);
    expect(resolveSmtProbeExtraWorkers(128)).toBe(0);
    expect(resolveSmtProbeExtraWorkers(200)).toBe(0);
    expect(resolveSmtProbeExtraWorkers(0)).toBe(0);
    expect(resolveSmtProbeExtraWorkers(1.5)).toBe(0);
    expect(resolveSmtProbeExtraWorkers(Number.NaN)).toBe(0);
  });

  it('keeps the probe wave only when a candidate window beats the peak baseline', () => {
    const probe = new CpuSmtProbe();
    expect(probe.observe(400, 50)).toBe('none'); // baseline window opens
    expect(probe.observe(1200, 720)).toBe('none'); // w1 .8375: base-extension burst
    expect(probe.observe(2000, 790)).toBe('none'); // w2 .0875
    expect(probe.observe(2800, 860)).toBe('spawn'); // w3 .0875 → spawn on peak .8375
    expect(probe.observe(3200, 930)).toBe('none'); // spawn warmup
    expect(probe.observe(3600, 1000)).toBe('none'); // candidate window opens
    expect(probe.observe(4400, 1790)).toBe('keep'); // .9875 ≥ .8375×1.1 despite the bursty baseline
    expect(probe.observe(5200, 9e9)).toBe('none'); // decided
  });

  it('reverts the probe wave when no candidate window grows work throughput', () => {
    const probe = new CpuSmtProbe();
    expect(probe.observe(400, 50)).toBe('none');
    expect(probe.observe(1200, 610)).toBe('none'); // w1 .7
    expect(probe.observe(2000, 680)).toBe('none'); // w2 .0875
    expect(probe.observe(2800, 750)).toBe('spawn'); // w3 .0875 → spawn on peak .7
    expect(probe.observe(3200, 790)).toBe('none'); // spawn warmup
    expect(probe.observe(3600, 830)).toBe('none'); // candidate window opens
    expect(probe.observe(4400, 870)).toBe('none'); // .05: first miss
    expect(probe.observe(5200, 910)).toBe('revert'); // .05: second miss
    expect(probe.observe(9999, 9e9)).toBe('none');
  });

  it('re-baselines after a keep and spawns another wave, ending at the first stalled one', () => {
    const probe = new CpuSmtProbe();
    expect(probe.observe(400, 50)).toBe('none');
    expect(probe.observe(1200, 610)).toBe('none'); // peak .7
    expect(probe.observe(2000, 680)).toBe('none');
    expect(probe.observe(2800, 750)).toBe('spawn');
    expect(probe.observe(3200, 790)).toBe('none');
    expect(probe.observe(3600, 830)).toBe('none');
    expect(probe.observe(4400, 1600)).toBe('keep'); // .9625 ≥ .77
    probe.registerKeep(4500);
    expect(probe.observe(4900, 1700)).toBe('none'); // replacement-worker warmup
    expect(probe.observe(5300, 1800)).toBe('none'); // fresh baseline window opens
    expect(probe.observe(6100, 2360)).toBe('none'); // w1 .7
    expect(probe.observe(6900, 2430)).toBe('none');
    expect(probe.observe(7700, 2500)).toBe('spawn'); // w3 → spawn #2
    expect(probe.observe(8100, 2560)).toBe('none');
    expect(probe.observe(8500, 2620)).toBe('none'); // candidate window opens
    expect(probe.observe(9300, 2680)).toBe('none'); // .075: miss
    expect(probe.observe(10100, 2740)).toBe('revert'); // no marginal gain
    expect(probe.observe(10900, 9e9)).toBe('none');
  });

  it('rejects a keep recorded outside a keep decision', () => {
    const probe = new CpuSmtProbe();
    expect(() => probe.registerKeep(500)).toThrow('outside a keep decision');
    probe.observe(400, 50);
    probe.observe(1200, 610);
    probe.observe(2000, 680);
    expect(probe.observe(2800, 750)).toBe('spawn');
    expect(() => probe.registerKeep(2900)).toThrow('outside a keep decision');
  });

  it('reverts without spawning when every baseline window reports no progress', () => {
    const probe = new CpuSmtProbe();
    expect(probe.observe(400, 7)).toBe('none');
    expect(probe.observe(1200, 7)).toBe('none');
    expect(probe.observe(2000, 7)).toBe('none');
    expect(probe.observe(2800, 7)).toBe('revert');
    expect(probe.observe(3600, 5000)).toBe('none');
  });
});
