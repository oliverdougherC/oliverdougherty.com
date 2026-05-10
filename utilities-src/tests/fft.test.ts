import { createFftWorkspace, fft, fftInto } from '@utilities/fft';

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

  it('shows spectral interpolation when zero-padding a signal', () => {
    const shortSignal = new Float32Array([0.8, -0.6, 0.3, 0.1]);
    const paddedSignal = new Float32Array([0.8, -0.6, 0.3, 0.1, 0, 0, 0, 0]);

    const shortSpectrum = fft(shortSignal);
    const paddedSpectrum = fft(paddedSignal);

    expect(paddedSpectrum.real.length).toBe(shortSpectrum.real.length * 2);

    let shortActiveBins = 0;
    for (let i = 0; i < shortSpectrum.real.length; i++) {
      if (Math.hypot(shortSpectrum.real[i], shortSpectrum.imag[i]) > 0.01) shortActiveBins++;
    }
    let paddedActiveBins = 0;
    for (let i = 0; i < paddedSpectrum.real.length; i++) {
      if (Math.hypot(paddedSpectrum.real[i], paddedSpectrum.imag[i]) > 0.01) paddedActiveBins++;
    }

    expect(paddedActiveBins).toBeGreaterThan(shortActiveBins);
  });

  it('places a sine wave peak at the correct frequency bin', () => {
    const N = 64;
    const freqBin = 4;
    const signal = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] = Math.sin(2 * Math.PI * freqBin * i / N);
    }

    const spectrum = fft(signal);

    let peakBin = 0;
    let peakMag = 0;
    for (let bin = 0; bin < N; bin++) {
      const mag = Math.hypot(spectrum.real[bin], spectrum.imag[bin]);
      if (mag > peakMag) {
        peakMag = mag;
        peakBin = bin;
      }
    }

    expect(peakBin).toBe(freqBin);
    expect(maxDifference(spectrum.real.slice(1, freqBin), new Float32Array(freqBin - 1))).toBeLessThan(0.000001);
  });

  it('divides by N during inverse FFT for proper normalization', () => {
    const N = 16;
    const spectrumReal = new Float32Array(N).fill(0);
    spectrumReal[0] = 1;
    const spectrumImag = new Float32Array(N);

    const inverse = fft(spectrumReal, spectrumImag, true);

    for (let i = 0; i < N; i++) {
      expect(inverse.real[i]).toBeCloseTo(1 / N, 6);
    }
    expect(maxDifference(inverse.imag, new Float32Array(N))).toBeLessThan(0.000001);
  });

  it('produces identical results when reusing a workspace', () => {
    const N = 32;
    const signal = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      signal[i] = Math.cos(2 * Math.PI * 5 * i / N) * 0.5 + Math.sin(2 * Math.PI * 2 * i / N) * 0.3;
    }

    const fresh = fft(signal);

    const workspace = createFftWorkspace(N);
    const reused = fftInto(signal, undefined, false, workspace);

    expect(maxDifference(fresh.real, reused.real)).toBeLessThan(0.000001);
    expect(maxDifference(fresh.imag, reused.imag)).toBeLessThan(0.000001);

    const reusedAgain = fftInto(signal, undefined, false, workspace);

    expect(maxDifference(reused.real, reusedAgain.real)).toBeLessThan(0.000001);
    expect(maxDifference(reused.imag, reusedAgain.imag)).toBeLessThan(0.000001);
  });
});

