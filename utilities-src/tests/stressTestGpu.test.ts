import { resolveGpuBackendFallbacks } from '@utilities/stressTestCore';
import { AdaptiveGpuWorkScaler } from '@utilities/stressTestGpu';

describe('adaptive GPU stress scaling', () => {
  it('keeps growing under fast completions without an application workload ceiling', () => {
    const scaler = new AdaptiveGpuWorkScaler({
      initialLevel: 1,
      growAfterSamples: 1,
      fastMs: 5,
      slowMs: 25
    });

    for (let index = 0; index < 14; index += 1) {
      scaler.recordCompletion(1);
    }

    expect(scaler.getLevel()).toBeGreaterThan(1000);
  });

  it('backs off after slow completions and errors', () => {
    const scaler = new AdaptiveGpuWorkScaler({
      initialLevel: 256,
      slowBackoffMultiplier: 0.5,
      errorBackoffMultiplier: 0.25,
      fastMs: 5,
      slowMs: 20
    });

    expect(scaler.recordCompletion(40)).toBe(128);
    expect(scaler.recordBackpressure()).toBe(64);
    expect(scaler.recordError()).toBe(16);
  });

  it('reset keeps a cancelled pump at a valid stopped baseline', () => {
    const scaler = new AdaptiveGpuWorkScaler({ initialLevel: 32 });

    scaler.recordCompletion(1);
    scaler.reset(0);

    expect(scaler.getLevel()).toBe(1);
  });

  it('keeps the progressive browser GPU fallback order', () => {
    expect(resolveGpuBackendFallbacks({ hasWebGpu: true, hasWebGl2: true, hasWebGl1: true })).toEqual([
      'webgpu-compute',
      'webgl2-fragment',
      'webgl1-fragment'
    ]);
  });
});
