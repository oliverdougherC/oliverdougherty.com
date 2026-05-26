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

  describe('cache key encoding', () => {
    it('produces deterministic output for identical inputs', () => {
      const gains = new Float32Array([0.5, 0.8, 1.0, 0.25]);
      const key1 = encodeAudioFourierBandGainsCacheKey(gains);
      const key2 = encodeAudioFourierBandGainsCacheKey(new Float32Array([0.5, 0.8, 1.0, 0.25]));
      expect(key1).toBe(key2);
    });

    it('handles negative and zero gains', () => {
      const gains = new Float32Array([-1.0, 0, 0.000001]);
      const key = encodeAudioFourierBandGainsCacheKey(gains);
      expect(key).toBe('-1.000000,0.000000,0.000001');
    });

    it('handles empty gains array', () => {
      const key = encodeAudioFourierBandGainsCacheKey(new Float32Array(0));
      expect(key).toBe('');
    });

    it('handles negative infinity', () => {
      const gains = new Float32Array([Number.NEGATIVE_INFINITY]);
      const key = encodeAudioFourierBandGainsCacheKey(gains);
      expect(key).toBe('-Infinity');
    });
  });

  describe('debug warning host detection', () => {
    it('recognizes all localhost variants', () => {
      const hosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
      for (const host of hosts) {
        // Only the three explicit hosts are enabled; ::1 is not in the check
        if (host === '::1') {
          expect(shouldDebugAudioFourierWarnings(host)).toBe(false);
        } else {
          expect(shouldDebugAudioFourierWarnings(host)).toBe(true);
        }
      }
    });

    it('rejects production hostnames', () => {
      const productionHosts = [
        'oliverdougherty.com',
        'www.oliverdougherty.com',
        'example.com',
        'staging.example.com',
        'localhost.localdomain',
      ];
      for (const host of productionHosts) {
        expect(shouldDebugAudioFourierWarnings(host)).toBe(false);
      }
    });
  });
});
