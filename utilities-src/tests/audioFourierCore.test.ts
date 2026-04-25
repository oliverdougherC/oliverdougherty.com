import {
  buildEnergyBandReconstruction,
  buildWindowedFourierAnalysis,
  mapSliderValueToEnergyPercent,
  mixEnergyBands,
  resolveEnergyMakeupGain,
  renderWindowedComponentCount
} from '@utilities/audioFourierCore';

function maxDifference(left: Float32Array, right: Float32Array) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference = Math.max(difference, Math.abs(left[index] - right[index]));
  }
  return difference;
}

describe('audio Fourier core', () => {
  it('maps slider values to auditory signal energy', () => {
    const max = 1000;

    expect(mapSliderValueToEnergyPercent(0, max)).toBe(0);
    expect(mapSliderValueToEnergyPercent(500, max)).toBeCloseTo(0.8, 6);
    expect(mapSliderValueToEnergyPercent(200, max)).toBeGreaterThan(0.5);
    expect(mapSliderValueToEnergyPercent(max, max)).toBe(1);
  });

  it('boosts partial energy mixes while leaving the full signal unboosted', () => {
    expect(resolveEnergyMakeupGain(1)).toBe(1);
    expect(resolveEnergyMakeupGain(0.5)).toBeGreaterThan(1);
    expect(resolveEnergyMakeupGain(0.2)).toBeGreaterThan(resolveEnergyMakeupGain(0.5));
    expect(resolveEnergyMakeupGain(0)).toBeLessThanOrEqual(2.8);
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
