import { PRIME_SEARCH_START, PRIME_SEGMENT_ODDS } from './stressTestPrimes';

export const PRIME_BLOCK_ODDS = PRIME_SEGMENT_ODDS * 64;
export const PRIME_PREFETCH_BLOCKS = 4;
export const PRIME_REFILL_THRESHOLD = 2;

export interface PrimeBlock {
  id: number;
  low: number;
  high: number;
}

/** Main-thread allocation is O(prefetch), never proportional to searched integers. */
export class PrimeBlockAllocator {
  private next = PRIME_SEARCH_START;
  private nextId = 0;
  private finished = false;

  constructor(private readonly blockOdds = PRIME_BLOCK_ODDS, private readonly limit = Number.MAX_SAFE_INTEGER,
    start = PRIME_SEARCH_START) {
    if (!Number.isSafeInteger(blockOdds) || blockOdds < 2 || blockOdds > PRIME_BLOCK_ODDS
      || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(start) || start < 1
      || start > limit || start % 2 !== 1) throw new Error('Invalid prime block allocation bounds.');
    this.next = start;
  }

  get exhausted() { return this.finished; }

  take(count: number): PrimeBlock[] {
    if (!Number.isInteger(count) || count < 1 || count > PRIME_PREFETCH_BLOCKS) {
      throw new Error('Invalid prime prefetch size.');
    }
    const blocks: PrimeBlock[] = [];
    while (blocks.length < count && !this.finished) {
      // Blocks cover consecutive integer intervals, ending just before the next odd start.
      const width = this.blockOdds * 2;
      const high = this.limit - this.next < width ? this.limit : this.next + width - 1;
      blocks.push({ id: this.nextId++, low: this.next, high });
      if (high === this.limit) this.finished = true;
      else this.next = high + 1;
    }
    return blocks;
  }
}
