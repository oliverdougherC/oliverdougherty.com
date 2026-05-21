export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function assertPowerOfTwo(size: number): void {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new Error('Size must be a power of two.');
  }
}
