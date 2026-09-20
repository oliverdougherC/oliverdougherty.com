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

import { resolveGpuComputeWorkload } from '@utilities/stressTestGpu';

describe('GPU compute workload allocation', () => {
  it('never dispatches more independent lanes than its storage capacity', () => {
    for (const level of [1, 64, 4096, 1000000, Number.MAX_SAFE_INTEGER]) {
      const plan = resolveGpuComputeWorkload(level);
      expect(plan.groups * 64 * 16).toBeLessThanOrEqual(plan.storageBytes);
      expect(plan.storageBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(plan.iterations).toBeLessThanOrEqual(1024);
      expect(plan.passes).toBeLessThanOrEqual(8);
    }
  });

  it('respects reported storage and workgroup limits even below defaults', () => {
    const plan = resolveGpuComputeWorkload(100000, {
      maxBufferSize: 128 * 1024, maxStorageBufferBindingSize: 64 * 1024,
      maxComputeWorkgroupsPerDimension: 32
    });
    expect(plan.storageBytes).toBe(64 * 1024);
    expect(plan.groups).toBe(32);
    expect(plan.iterations).toBe(1024);
    expect(plan.passes).toBe(8);
  });

  it('scales beyond the old tiny storage workload with bounded sequential passes', () => {
    const plan = resolveGpuComputeWorkload(1000000);
    expect(plan.groups * 64).toBe(1048576);
    expect(plan.iterations).toBe(1024);
    expect(plan.passes).toBeGreaterThan(1);
    expect(plan.effectiveLevel).toBeGreaterThanOrEqual(1000000);
  });

  it('normalizes invalid requested workloads', () => {
    for (const level of [NaN, Infinity, -20, 0]) {
      expect(resolveGpuComputeWorkload(level).groups).toBe(1);
    }
  });
});


describe('invalid GPU limits', () => {
  it('rejects limits too small or malformed rather than exceeding them', () => {
    for (const limits of [
      { maxBufferSize: 1000 }, { maxStorageBufferBindingSize: 0 },
      { maxComputeWorkgroupsPerDimension: 0 }, { maxBufferSize: NaN },
      { maxComputeWorkgroupsPerDimension: Infinity }
    ]) {
      expect(() => resolveGpuComputeWorkload(1024, limits)).toThrow('GPU limits');
    }
  });
});
