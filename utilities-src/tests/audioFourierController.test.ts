import {
  encodeAudioFourierBandGainsCacheKey,
  shouldDebugAudioFourierWarnings
} from '@utilities/audioFourierController';

describe('audio fourier controller', () => {
  it('encodes stable cache keys for band gains', () => {
    expect(encodeAudioFourierBandGainsCacheKey(new Float32Array([0.1 + 0.2, 1, 0]))).toBe('0.300000,1.000000,0.000000');
    expect(encodeAudioFourierBandGainsCacheKey(new Float32Array([Number.NaN, Number.POSITIVE_INFINITY]))).toBe('NaN,Infinity');
  });

  it('only enables controller warning logs on local debug hosts', () => {
    expect(shouldDebugAudioFourierWarnings('localhost')).toBe(true);
    expect(shouldDebugAudioFourierWarnings('127.0.0.1')).toBe(true);
    expect(shouldDebugAudioFourierWarnings('0.0.0.0')).toBe(true);
    expect(shouldDebugAudioFourierWarnings('oliverdougherty.com')).toBe(false);
    expect(shouldDebugAudioFourierWarnings(undefined)).toBe(false);
  });
});
