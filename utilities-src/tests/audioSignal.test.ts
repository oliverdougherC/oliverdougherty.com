import { downmixToMono, normalizeSignal, prepareAudioSignal } from '@utilities/audioSignal';

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
});
