import { clamp, assertPowerOfTwo } from '@utilities/math';

describe('audio fourier controller', () => {
  // Note: The AudioFourierController class is heavily DOM-dependent and requires
  // canvas elements, buttons, sliders, and worker messaging to function.
  // Full integration tests would require a browser environment or jsdom with
  // extensive mocking. The tests below cover shared utilities used by the controller.

  describe('clamp utility', () => {
    it('returns the value when within range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
    });

    it('returns min when value is below range', () => {
      expect(clamp(-3, 0, 10)).toBe(0);
    });

    it('returns max when value is above range', () => {
      expect(clamp(15, 0, 10)).toBe(10);
    });

    it('returns min when value equals min', () => {
      expect(clamp(0, 0, 10)).toBe(0);
    });

    it('returns max when value equals max', () => {
      expect(clamp(10, 0, 10)).toBe(10);
    });
  });

  describe('assertPowerOfTwo utility', () => {
    it('accepts valid powers of two', () => {
      expect(() => assertPowerOfTwo(2)).not.toThrow();
      expect(() => assertPowerOfTwo(4)).not.toThrow();
      expect(() => assertPowerOfTwo(8)).not.toThrow();
      expect(() => assertPowerOfTwo(1024)).not.toThrow();
    });

    it('rejects valid non-power-of-two values', () => {
      expect(() => assertPowerOfTwo(3)).toThrow();
      expect(() => assertPowerOfTwo(5)).toThrow();
      expect(() => assertPowerOfTwo(6)).toThrow();
      expect(() => assertPowerOfTwo(7)).toThrow();
    });

    it('rejects zero and negative values', () => {
      expect(() => assertPowerOfTwo(0)).toThrow();
      expect(() => assertPowerOfTwo(-1)).toThrow();
    });

    it('rejects non-integer values', () => {
      expect(() => assertPowerOfTwo(1.5)).toThrow();
      expect(() => assertPowerOfTwo(4.2)).toThrow();
    });
  });
});
