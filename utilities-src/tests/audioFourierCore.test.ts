import {
  analyzeAudioFourier,
  buildAudioFourierReconstruction,
  buildComponentSchedule,
  reconstructWithComponentCount
} from '@utilities/audioFourierCore';

function maxDifference(left: Float32Array, right: Float32Array) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference = Math.max(difference, Math.abs(left[index] - right[index]));
  }
  return difference;
}

describe('audio Fourier core', () => {
  it('keeps DC first and orders other components by energy', () => {
    const size = 1024;
    const sampleRate = 1024;
    const samples = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      samples[index] =
        0.15 +
        Math.sin(2 * Math.PI * 7 * index / size) * 0.65 +
        Math.sin(2 * Math.PI * 31 * index / size) * 0.2;
    }

    const analysis = analyzeAudioFourier(samples, sampleRate);

    expect(analysis.components[0].frequencyHz).toBe(0);
    expect(analysis.components[1].frequencyHz).toBeCloseTo(7, 5);
    expect(analysis.components[1].energy).toBeGreaterThan(analysis.components[2].energy);
  });

  it('reconstructs the exact final signal when all components are present', () => {
    const size = 1024;
    const samples = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      samples[index] =
        Math.sin(2 * Math.PI * 13 * index / size) * 0.5 +
        Math.sin(2 * Math.PI * 41 * index / size) * 0.2;
    }

    const analysis = analyzeAudioFourier(samples, 2048);
    const full = reconstructWithComponentCount(analysis, analysis.components.length);
    const partial = reconstructWithComponentCount(analysis, 2);

    expect(maxDifference(full, samples)).toBeLessThan(0.00001);
    expect(maxDifference(partial, samples)).toBeGreaterThan(0.01);
  });

  it('builds monotonic component schedules', () => {
    const schedule = buildComponentSchedule(200, 16);

    expect(schedule[0]).toBe(1);
    expect(schedule[schedule.length - 1]).toBe(200);
    for (let index = 1; index < schedule.length; index += 1) {
      expect(schedule[index]).toBeGreaterThanOrEqual(schedule[index - 1]);
    }
  });

  it('builds visual and playback buffers ending on the exact reconstruction', () => {
    const size = 1024;
    const samples = new Float32Array(size);
    for (let index = 0; index < size; index += 1) {
      samples[index] =
        Math.sin(2 * Math.PI * 5 * index / size) * 0.4 +
        Math.sin(2 * Math.PI * 19 * index / size) * 0.25;
    }

    const result = buildAudioFourierReconstruction(samples, 4096, {
      visualFrameCount: 10,
      playbackFrameCount: 8,
      displaySampleCount: 64
    });

    expect(result.visualFrames.length).toBe(640);
    expect(result.playbackSamples.length).toBe(size);
    expect(maxDifference(result.finalSamples, samples)).toBeLessThan(0.000001);
    expect(result.frameComponentCounts[result.frameComponentCounts.length - 1]).toBe(result.analysis.components.length);
  });
});
