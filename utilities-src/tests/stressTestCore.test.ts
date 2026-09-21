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

  it('keeps the probe wave only when measured aggregate throughput grows', () => {
    const probe = new CpuSmtProbe(0);
    expect(probe.observe(100, 0)).toBe('none');
    expect(probe.observe(400, 50)).toBe('none');
    expect(probe.observe(1100, 110)).toBe('spawn');
    expect(probe.observe(1500, 140)).toBe('none');
    expect(probe.observe(2900, 300)).toBe('none');
    expect(probe.observe(3500, 500)).toBe('keep');
    expect(probe.observe(4200, 900)).toBe('none');
  });

  it('reverts the probe wave when throughput does not grow', () => {
    const probe = new CpuSmtProbe(0);
    expect(probe.observe(400, 50)).toBe('none');
    expect(probe.observe(1100, 110)).toBe('spawn');
    expect(probe.observe(2900, 300)).toBe('none');
    expect(probe.observe(3500, 330)).toBe('revert');
    expect(probe.observe(9999, 9e9)).toBe('none');
  });

  it('never spawns when the baseline window reports no progress', () => {
    const probe = new CpuSmtProbe(0);
    expect(probe.observe(400, 7)).toBe('none');
    expect(probe.observe(1100, 7)).toBe('none');
    expect(probe.observe(2900, 5000)).toBe('none');
    expect(probe.observe(3500, 9000)).toBe('none');
  });
});
