import { downmixToMono, normalizeSignal, prepareAudioSignal, selectAutoSegment } from '@utilities/audioSignal';

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

  it('selects the strongest stable segment', () => {
    const sampleRate = 10;
    const samples = new Float32Array(100);
    samples.fill(0.02, 0, 30);
    samples.fill(0.35, 40, 80);

    const segment = selectAutoSegment(samples, sampleRate, {
      targetDurationSeconds: 2,
      minDurationSeconds: 1,
      maxDurationSeconds: 3
    });

    expect(segment.startSample).toBeGreaterThanOrEqual(35);
    expect(segment.startSample).toBeLessThanOrEqual(60);
    expect(segment.rms).toBeGreaterThan(0.2);
  });

  it('prepares a power-of-two analysis buffer from stereo input', () => {
    const sampleRate = 64;
    const left = new Float32Array(256);
    const right = new Float32Array(256);
    for (let index = 0; index < left.length; index += 1) {
      left[index] = Math.sin(2 * Math.PI * index / 16) * 0.5;
      right[index] = Math.sin(2 * Math.PI * index / 16 + 0.2) * 0.5;
    }

    const prepared = prepareAudioSignal(
      { sampleRate, channels: [left, right] },
      {
        sampleCount: 128,
        targetDurationSeconds: 2,
        minDurationSeconds: 1,
        maxDurationSeconds: 3
      }
    );

    expect(prepared.samples.length).toBe(128);
    expect(prepared.sampleRate).toBeGreaterThan(0);
    expect(prepared.segment.durationSeconds).toBeCloseTo(2, 1);
  });
});

