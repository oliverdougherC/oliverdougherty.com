import {
  buildEnergyBandReconstruction,
  buildEnergyBandEnvelopes,
  buildSampleEnvelope,
  buildWindowedFourierAnalysis,
  mapSliderValueToEnergyPercent,
  mixEnergyBandEnvelopes,
  mixEnergyBands,
  resolveEnergyBandGains,
  resolveEnvelopeViewportRange,
  resolveEnvelopeBucketSampleCount,
  resolveEnergyMakeupGain,
  resolveHighEnergyVisualAmplitude,
  resolveSampleEnvelope,
  resolveViewportRange,
  renderWindowedComponentCount
} from '@utilities/audioFourierCore';

function maxDifference(left: Float32Array, right: Float32Array) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference = Math.max(difference, Math.abs(left[index] - right[index]));
  }
  return difference;
}

function expectArrayCloseTo(actual: Float32Array, expected: number[]) {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index], 6);
  }
}

describe('audio Fourier core', () => {
  it('maps slider values to auditory signal energy', () => {
    const max = 1000;

    expect(mapSliderValueToEnergyPercent(0, max)).toBe(0);
    expect(mapSliderValueToEnergyPercent(500, max)).toBeCloseTo(0.8, 6);
    expect(mapSliderValueToEnergyPercent(200, max)).toBeCloseTo(0.6, 6);
    expect(mapSliderValueToEnergyPercent(max, max)).toBe(1);
  });

  it('boosts partial energy mixes while leaving the full signal unboosted', () => {
    expect(resolveEnergyMakeupGain(1)).toBe(1);
    expect(resolveEnergyMakeupGain(0.5)).toBeGreaterThan(1);
    expect(resolveEnergyMakeupGain(0.2)).toBeGreaterThan(resolveEnergyMakeupGain(0.5));
    expect(resolveEnergyMakeupGain(0)).toBeLessThanOrEqual(2.8);
  });

  it('resolves waveform envelopes from fractional viewport ranges', () => {
    const samples = new Float32Array([0.1, -0.4, 0.7, -0.2, 0.3]);
    const fractionalEnvelope = resolveSampleEnvelope(samples, 0.5, 3.2);
    const singleEnvelope = resolveSampleEnvelope(samples, 2.8, 2.9);
    const clampedEnvelope = resolveSampleEnvelope(samples, -3, 99);

    expect(fractionalEnvelope.min).toBeCloseTo(-0.4, 6);
    expect(fractionalEnvelope.max).toBeCloseTo(0.7, 6);
    expect(singleEnvelope.min).toBeCloseTo(0.7, 6);
    expect(singleEnvelope.max).toBeCloseTo(0.7, 6);
    expect(clampedEnvelope.min).toBeCloseTo(-0.4, 6);
    expect(clampedEnvelope.max).toBeCloseTo(0.7, 6);
  });

  it('orders dominant tones early in the windowed component list', () => {
    const sampleRate = 1024;
    const samples = new Float32Array(2048);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] =
        Math.sin(2 * Math.PI * 64 * index / sampleRate) * 0.7 +
        Math.sin(2 * Math.PI * 180 * index / sampleRate) * 0.18;
    }

    const analysis = buildWindowedFourierAnalysis(samples, sampleRate, {
      frameSize: 256,
      hopSize: 128,
      displaySampleCount: 128
    });

    expect(analysis.componentFrequencies[0]).toBeCloseTo(64, 0);
    expect(analysis.componentAmplitudes[0]).toBeGreaterThan(analysis.componentAmplitudes[20]);
  });

  it('reconstructs the full proxy when every retained component is selected', () => {
    const sampleRate = 1024;
    const samples = new Float32Array(2048);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] =
        Math.sin(2 * Math.PI * 37 * index / sampleRate) * 0.45 +
        Math.sin(2 * Math.PI * 93 * index / sampleRate) * 0.22;
    }

    const analysis = buildWindowedFourierAnalysis(samples, sampleRate, {
      frameSize: 256,
      hopSize: 128,
      displaySampleCount: 128
    });
    const full = renderWindowedComponentCount(analysis, analysis.componentOrder.length);
    const partial = renderWindowedComponentCount(analysis, 4);

    expect(maxDifference(full.playbackSamples, samples)).toBeLessThan(0.000001);
    expect(maxDifference(partial.playbackSamples, samples)).toBeGreaterThan(0.01);
    expect(full.displayFrame.length).toBe(128);
  });

  it('partitions retained components into additive energy bands', () => {
    const sampleRate = 1024;
    const samples = new Float32Array(2048);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] =
        Math.sin(2 * Math.PI * 40 * index / sampleRate) * 0.45 +
        Math.sin(2 * Math.PI * 120 * index / sampleRate) * 0.2;
    }

    const analysis = buildWindowedFourierAnalysis(samples, sampleRate, {
      frameSize: 256,
      hopSize: 128,
      displaySampleCount: 128
    });
    const bands = buildEnergyBandReconstruction(analysis, 8);
    const allGains = new Float32Array(8).fill(1);
    const halfGains = new Float32Array(8).fill(0);
    halfGains.fill(1, 0, 4);
    const fullMix = mixEnergyBands(bands.bandSamples, bands.sampleCount, allGains);
    const halfMix = mixEnergyBands(bands.bandSamples, bands.sampleCount, halfGains);

    expect(bands.bandEndComponentCounts[bands.bandEndComponentCounts.length - 1]).toBe(analysis.componentOrder.length);
    expect(bands.bandEnergyFractions[bands.bandEnergyFractions.length - 1]).toBe(1);
    expect(maxDifference(bands.mixedSamples, samples)).toBeLessThan(0.00001);
    expect(maxDifference(fullMix, bands.mixedSamples)).toBeLessThan(0.00001);
    expect(maxDifference(halfMix, fullMix)).toBeGreaterThan(0.01);
  });

  it('computes partial gains for middle bands when target falls between energy fractions', () => {
    const fractions = new Float32Array([0.2, 0.5, 0.8, 1.0]);

    const gainsAt03 = resolveEnergyBandGains(0.3, fractions);
    expect(gainsAt03[0]).toBe(1);
    expect(gainsAt03[1]).toBeGreaterThan(0);
    expect(gainsAt03[1]).toBeLessThan(1);
    expect(gainsAt03[2]).toBe(0);
    expect(gainsAt03[3]).toBe(0);

    const gainsAt065 = resolveEnergyBandGains(0.65, fractions);
    expect(gainsAt065[0]).toBe(1);
    expect(gainsAt065[1]).toBe(1);
    expect(gainsAt065[2]).toBeGreaterThan(0);
    expect(gainsAt065[2]).toBeLessThan(1);
    expect(gainsAt065[3]).toBe(0);
  });

  it('resolves viewport range at start of track boundary', () => {
    const { startSample, endSample, viewportSampleCount } = resolveViewportRange(
      0,
      10,
      64,
      2
    );

    expect(startSample).toBe(0);
    expect(endSample).toBe(128);
    expect(viewportSampleCount).toBe(128);
  });

  it('resolves viewport range at end of track boundary', () => {
    const { startSample, endSample, viewportSampleCount } = resolveViewportRange(
      10,
      10,
      64,
      2
    );

    const totalSamples = 10 * 64;
    expect(viewportSampleCount).toBe(128);
    expect(startSample).toBe(totalSamples - 128);
    expect(endSample).toBe(totalSamples);
  });

  it('handles displaySampleCount larger than signal length via renderWindowedComponentCount', () => {
    const sampleRate = 256;
    const samples = new Float32Array(512);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(2 * Math.PI * 8 * i / sampleRate) * 0.6;
    }

    const analysis = buildWindowedFourierAnalysis(samples, sampleRate, {
      frameSize: 64,
      hopSize: 32,
      displaySampleCount: 4096
    });

    const result = renderWindowedComponentCount(analysis, analysis.componentOrder.length);

    expect(result.displayFrame.length).toBe(4096);
    expect(result.playbackSamples.length).toBe(512);
  });

  it('builds analysis with only one frame when samples length is less than frameSize', () => {
    const sampleRate = 256;
    const samples = new Float32Array(32);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(2 * Math.PI * 2 * i / sampleRate) * 0.5;
    }

    const analysis = buildWindowedFourierAnalysis(samples, sampleRate, {
      frameSize: 64,
      hopSize: 32,
      displaySampleCount: 32
    });

    expect(analysis.frameCount).toBe(1);
    expect(analysis.binCount).toBe(33);
    expect(analysis.componentOrder.length).toBe(33);
  });

  it('reconstruction with component count of 1 produces valid output', () => {
    const sampleRate = 512;
    const samples = new Float32Array(1024);
    for (let i = 0; i < samples.length; i++) {
      samples[i] =
        Math.sin(2 * Math.PI * 10 * i / sampleRate) * 0.6 +
        Math.sin(2 * Math.PI * 37 * i / sampleRate) * 0.3;
    }

    const analysis = buildWindowedFourierAnalysis(samples, sampleRate, {
      frameSize: 128,
      hopSize: 64,
      displaySampleCount: 128
    });

    const result = renderWindowedComponentCount(analysis, 1);

    expect(result.componentCount).toBe(1);
    expect(result.playbackSamples.length).toBe(1024);
    expect(result.displayFrame.length).toBe(128);

    let maxVal = 0;
    for (let i = 0; i < result.playbackSamples.length; i++) {
      maxVal = Math.max(maxVal, Math.abs(result.playbackSamples[i]));
    }
    expect(maxVal).toBeGreaterThan(0);
  });

  it('returns all-zero gains when target energy is 0', () => {
    const fractions = new Float32Array([0.25, 0.5, 0.75, 1.0]);
    const gains = resolveEnergyBandGains(0, fractions);

    for (let i = 0; i < gains.length; i++) {
      expect(gains[i]).toBe(0);
    }
  });

  it('returns all-ones gains when target energy is 1', () => {
    const fractions = new Float32Array([0.25, 0.5, 0.75, 1.0]);
    const gains = resolveEnergyBandGains(1, fractions);

    for (let i = 0; i < gains.length; i++) {
      expect(gains[i]).toBe(1);
    }
  });

  it('builds fixed sample envelopes that preserve bucket min and max bounds', () => {
    const samples = new Float32Array([0.1, -0.7, 0.4, 0.8, -0.2, 0.3, -0.5]);
    const envelope = buildSampleEnvelope(samples, 3);

    expect(envelope.bucketSampleCount).toBe(3);
    expectArrayCloseTo(envelope.min, [-0.7, -0.2, -0.5]);
    expectArrayCloseTo(envelope.max, [0.4, 0.8, -0.5]);
  });

  it('resolves adjacent envelope viewports as sub-bucket translations', () => {
    const sampleRate = 1000;
    const bucketSampleCount = resolveEnvelopeBucketSampleCount(sampleRate, 100);
    const first = resolveEnvelopeViewportRange(1, 10, sampleRate, 2, bucketSampleCount);
    const adjacent = resolveEnvelopeViewportRange(1.004, 10, sampleRate, 2, bucketSampleCount);

    expect(bucketSampleCount).toBe(10);
    expect(adjacent.firstBucketIndex).toBe(first.firstBucketIndex);
    expect(adjacent.lastBucketIndex - first.lastBucketIndex).toBeLessThanOrEqual(1);
    expect(adjacent.bucketOffsetFraction).toBeGreaterThan(first.bucketOffsetFraction);
  });

  it('mixes energy band envelopes from gains without full sample remixing', () => {
    const sampleCount = 6;
    const bandSamples = new Float32Array([
      -0.2, 0.1, 0.5, -0.4, 0.2, 0.3,
      -0.1, 0.4, -0.3, 0.2, -0.6, 0.1
    ]);
    const envelopes = buildEnergyBandEnvelopes(bandSamples, sampleCount, 2, 2);
    const firstOnly = mixEnergyBandEnvelopes(
      envelopes.min,
      envelopes.max,
      envelopes.bucketCount,
      envelopes.sampleCount,
      envelopes.bucketSampleCount,
      new Float32Array([1, 0])
    );
    const mixed = mixEnergyBandEnvelopes(
      envelopes.min,
      envelopes.max,
      envelopes.bucketCount,
      envelopes.sampleCount,
      envelopes.bucketSampleCount,
      new Float32Array([1, 0.5])
    );

    expectArrayCloseTo(firstOnly.min, [-0.2, -0.4, 0.2]);
    expectArrayCloseTo(firstOnly.max, [0.1, 0.5, 0.3]);
    expectArrayCloseTo(mixed.min, [-0.25, -0.55, -0.1]);
    expectArrayCloseTo(mixed.max, [0.3, 0.6, 0.35]);
  });

  it('visually clamps high-energy reconstruction amplitudes to the original envelope', () => {
    expect(resolveHighEnergyVisualAmplitude(0.5, 0.8, 0.6)).toBeCloseTo(0.8, 6);
    expect(resolveHighEnergyVisualAmplitude(0.5, 0.8, 0.825)).toBeCloseTo(0.65, 6);
    expect(resolveHighEnergyVisualAmplitude(0.5, 0.8, 0.85)).toBeCloseTo(0.5, 6);
    expect(resolveHighEnergyVisualAmplitude(0.5, 0.3, 0.95)).toBeCloseTo(0.3, 6);
  });

  it('keeps song-length proxy analysis bounded by frame options', () => {
    const sampleRate = 64;
    const durationSeconds = 5 * 60;
    const samples = new Float32Array(sampleRate * durationSeconds);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(2 * Math.PI * 5 * index / sampleRate) * 0.5;
    }

    const analysis = buildWindowedFourierAnalysis(samples, sampleRate, {
      frameSize: 128,
      hopSize: 64,
      displaySampleCount: 256
    });

    expect(analysis.frameCount).toBeGreaterThan(250);
    expect(analysis.componentOrder.length).toBe(analysis.frameCount * analysis.binCount);
    expect(analysis.finalDisplayFrame.length).toBe(256);
  });
});
