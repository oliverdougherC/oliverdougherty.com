import { downmixToMono, normalizeSignal, prepareAudioSignal, resampleLinear } from '@utilities/audioSignal';

describe('audio signal preparation', () => {
  it('downmixes matching channels to mono', () => {
    const mono = downmixToMono([
      new Float32Array([1, 0.5, -0.5]),
      new Float32Array([-1, 0.5, 0.5])
    ]);

    expect(Array.from(mono)).toEqual([0, 0.5, 0]);
  });

  it('normalizes around zero and rejects silence', () => {
    const normalized = normalizeSignal(new Float32Array([0.25, 0.5, 0.75]));

    expect(Math.max(...Array.from(normalized.samples).map(Math.abs))).toBeCloseTo(0.92, 5);
    expect(() => normalizeSignal(new Float32Array([0, 0, 0, 0]))).toThrow(/quiet/i);
  });

  it('prepares the full signal as a proxy without truncating to a short segment', () => {
    const sourceSampleRate = 64;
    const durationSeconds = 12;
    const left = new Float32Array(sourceSampleRate * durationSeconds);
    const right = new Float32Array(sourceSampleRate * durationSeconds);
    for (let index = 0; index < left.length; index += 1) {
      left[index] = Math.sin(2 * Math.PI * index / 16) * 0.5;
      right[index] = Math.sin(2 * Math.PI * index / 16 + 0.2) * 0.5;
    }

    const prepared = prepareAudioSignal(
      { sampleRate: sourceSampleRate, channels: [left, right] },
      {
        proxySampleRate: 32,
        maxDurationSeconds: 60
      }
    );

    expect(prepared.samples.length).toBe(384);
    expect(prepared.sampleRate).toBe(32);
    expect(prepared.sourceDurationSeconds).toBeCloseTo(durationSeconds, 5);
    expect(prepared.proxyDurationSeconds).toBeCloseTo(durationSeconds, 5);
  });

  it('handles long song-length synthetic buffers through bounded proxy resampling', () => {
    const sampleRate = 100;
    const durationSeconds = 5 * 60;
    const samples = new Float32Array(sampleRate * durationSeconds);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(2 * Math.PI * 3 * index / sampleRate) * 0.5;
    }

    const prepared = prepareAudioSignal(
      { sampleRate, channels: [samples] },
      {
        proxySampleRate: 25,
        maxDurationSeconds: 8 * 60
      }
    );

    expect(prepared.samples.length).toBe(7500);
    expect(prepared.proxyDurationSeconds).toBeCloseTo(durationSeconds, 5);
  });

  it('caps proxy sample count and reports the effective proxy rate', () => {
    const sampleRate = 100;
    const durationSeconds = 10;
    const samples = new Float32Array(sampleRate * durationSeconds);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.sin(2 * Math.PI * 3 * index / sampleRate) * 0.5;
    }

    const prepared = prepareAudioSignal(
      { sampleRate, channels: [samples] },
      {
        proxySampleRate: 80,
        maxProxySampleCount: 400,
        maxDurationSeconds: 60
      }
    );

    expect(prepared.samples.length).toBe(400);
    expect(prepared.sampleRate).toBeCloseTo(40, 5);
    expect(prepared.proxyDurationSeconds).toBeCloseTo(durationSeconds, 5);
  });

  it('removes DC offset during normalization', () => {
    const dcOffset = 0.5;
    const signal = new Float32Array(128);
    for (let i = 0; i < signal.length; i++) {
      signal[i] = Math.sin(2 * Math.PI * 2 * i / signal.length) * 0.3 + dcOffset;
    }

    const result = normalizeSignal(signal);

    let sum = 0;
    for (let i = 0; i < result.samples.length; i++) {
      sum += result.samples[i];
    }
    const mean = sum / result.samples.length;

    expect(Math.abs(mean)).toBeLessThan(0.01);
  });

  it('normalizes output peak to the target value', () => {
    const target = 0.85;
    const signal = new Float32Array([0.1, 0.3, -0.2, 0.5, -0.4]);

    const result = normalizeSignal(signal, target);

    expect(result.peak).toBeCloseTo(target, 5);

    let actualPeak = 0;
    for (let i = 0; i < result.samples.length; i++) {
      actualPeak = Math.max(actualPeak, Math.abs(result.samples[i]));
    }
    expect(actualPeak).toBeCloseTo(target, 5);
  });

  it('downmixes more than two channels to mono', () => {
    const mono = downmixToMono([
      new Float32Array([0.9, 0.3, -0.1]),
      new Float32Array([0.3, 0.3, 0.5]),
      new Float32Array([-0.3, 0.3, -0.1])
    ]);

    expect(mono.length).toBe(3);
    expect(mono[0]).toBeCloseTo(0.3649427, 5);
    expect(mono[1]).toBeCloseTo(0.3, 5);
    expect(mono[2]).toBeCloseTo(0.1216476, 5);
  });

  it('linearly resamples a sine wave with acceptable quality', () => {
    const N = 256;
    const signal = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] = Math.sin(2 * Math.PI * 4 * i / N);
    }

    const resampled = resampleLinear(signal, 128);

    expect(resampled.length).toBe(128);
    expect(resampled[0]).toBeCloseTo(signal[0], 5);
    expect(resampled[resampled.length - 1]).toBeCloseTo(signal[signal.length - 1], 5);

    let maxDiff = 0;
    for (let i = 0; i < resampled.length; i++) {
      const srcIdx = Math.round(i * (N - 1) / (resampled.length - 1));
      maxDiff = Math.max(maxDiff, Math.abs(resampled[i] - signal[srcIdx]));
    }

    expect(maxDiff).toBeLessThan(0.1);
  });

  it('rejects very short audio during preparation', () => {
    const samples = new Float32Array([0.1, -0.2, 0.3]);

    expect(() =>
      prepareAudioSignal(
        { sampleRate: 44100, channels: [samples] },
        { proxySampleRate: 64, maxDurationSeconds: 60 }
      )
    ).toThrow(/too short/i);
  });

  it('rejects very long audio during preparation', () => {
    const sampleRate = 100;
    const durationSeconds = 10 * 60;
    const samples = new Float32Array(sampleRate * durationSeconds);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(2 * Math.PI * 3 * i / sampleRate) * 0.5;
    }

    expect(() =>
      prepareAudioSignal(
        { sampleRate, channels: [samples] },
        { proxySampleRate: 64, maxDurationSeconds: 5 * 60 }
      )
    ).toThrow(/too long/i);
  });

  it('rejects an invalid sample rate', () => {
    const samples = new Float32Array(1000);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin(2 * Math.PI * i / samples.length) * 0.5;
    }

    expect(() =>
      prepareAudioSignal(
        { sampleRate: -1, channels: [samples] },
        { proxySampleRate: 64, maxDurationSeconds: 60 }
      )
    ).toThrow(/invalid sample rate/i);
  });
});
