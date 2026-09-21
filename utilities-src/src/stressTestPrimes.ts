export const PRIME_SEARCH_START = 1;
export const PRIME_SEGMENT_ODDS = 32 * 1024;

export interface PrimeSegmentResult {
  candidates: number;
  primesFound: number;
  latestPrime: number;
}

/**
 * Odd-only segmented Eratosthenes. The 32 KiB working set is reused, and the
 * base-prime cache grows geometrically using its own segmented sieve.
 * https://github.com/kimwalisch/primesieve/blob/master/doc/ALGORITHMS.md
 */
export class SegmentedPrimeSieve {
  private readonly composite: Uint8Array;
  private readonly baseComposite: Uint8Array;
  private readonly basePrimes: number[] = [];
  private baseLimit = 2;

  constructor(readonly segmentOdds = PRIME_SEGMENT_ODDS) {
    if (!Number.isSafeInteger(segmentOdds) || segmentOdds < 1 || segmentOdds > PRIME_SEGMENT_ODDS) {
      throw new Error('Invalid prime sieve segment size.');
    }
    this.composite = new Uint8Array(segmentOdds);
    this.baseComposite = new Uint8Array(PRIME_SEGMENT_ODDS);
  }

  /** Inclusive interval, at most 2 * segmentOdds integers; counts 2 exactly when included. */
  sieve(low: number, high: number): PrimeSegmentResult {
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low < 1 || high < low
      || high - low >= this.segmentOdds * 2) {
      throw new Error('Invalid prime sieve interval.');
    }
    const needed = Math.floor(Math.sqrt(high));
    if (needed > this.baseLimit) {
      this.extendBaseTo(Math.min(Math.floor(Math.sqrt(Number.MAX_SAFE_INTEGER)),
        Math.max(needed, this.baseLimit * 2, 256)));
    }
    const firstOdd = low % 2 ? low : low + 1;
    const length = firstOdd > high ? 0 : Math.floor((high - firstOdd) / 2) + 1;
    this.markComposites(firstOdd, high, this.composite, length);
    if (firstOdd === 1) this.composite[0] = 1;
    let primesFound = low <= 2 && high >= 2 ? 1 : 0;
    let latestPrime = primesFound ? 2 : 0;
    for (let index = 0; index < length; index += 1) {
      if (this.composite[index] === 0) {
        primesFound += 1;
        latestPrime = firstOdd + index * 2;
      }
    }
    return { candidates: length + Number(low <= 2 && high >= 2), primesFound, latestPrime };
  }

  private extendBaseTo(limit: number) {
    if (limit <= this.baseLimit) return;
    const root = Math.floor(Math.sqrt(limit));
    if (root > this.baseLimit) this.extendBaseTo(root);
    let low = this.baseLimit + 1;
    if (low % 2 === 0) low += 1;
    while (low <= limit) {
      const high = Math.min(limit, low + (this.baseComposite.length - 1) * 2);
      const length = Math.floor((high - low) / 2) + 1;
      this.markComposites(low, high, this.baseComposite, length);
      for (let index = 0; index < length; index += 1) {
        if (this.baseComposite[index] === 0) this.basePrimes.push(low + index * 2);
      }
      low += length * 2;
    }
    this.baseLimit = limit;
  }

  private markComposites(low: number, high: number, buffer: Uint8Array, length: number) {
    buffer.fill(0, 0, length);
    for (const prime of this.basePrimes) {
      const square = prime * prime;
      if (square > high) break;
      // Subtracting the remainder avoids rounding a quotient near MAX_SAFE_INTEGER.
      const remainder = low % prime;
      let offset = remainder === 0 ? 0 : prime - remainder;
      if (offset > high - low) continue;
      let first = low + offset;
      if (first < square) first = square;
      if (first % 2 === 0) {
        if (first > high - prime) continue;
        first += prime;
      }
      offset = (first - low) / 2;
      for (let index = offset; index < length; index += prime) buffer[index] = 1;
    }
  }
}
