import { fft } from '@utilities/fft';

function maxDifference(left: Float32Array, right: Float32Array) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference = Math.max(difference, Math.abs(left[index] - right[index]));
  }
  return difference;
}

describe('fft', () => {
  it('transforms an impulse into a flat spectrum', () => {
    const impulse = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    const spectrum = fft(impulse);

    expect(Array.from(spectrum.real)).toEqual(Array.from(new Float32Array(8).fill(1)));
    expect(maxDifference(spectrum.imag, new Float32Array(8))).toBeLessThan(0.000001);
  });

  it('roundtrips a signal without mutating the input', () => {
    const signal = new Float32Array([0.1, 0.4, -0.2, 0.9, 0.3, -0.7, 0.15, -0.05]);
    const original = new Float32Array(signal);
    const spectrum = fft(signal);
    const roundtrip = fft(spectrum.real, spectrum.imag, true);

    expect(Array.from(signal)).toEqual(Array.from(original));
    expect(maxDifference(roundtrip.real, original)).toBeLessThan(0.000001);
    expect(maxDifference(roundtrip.imag, new Float32Array(signal.length))).toBeLessThan(0.000001);
  });

  it('rejects non-power-of-two inputs', () => {
    expect(() => fft(new Float32Array(6))).toThrow(/power of two/i);
  });
});

