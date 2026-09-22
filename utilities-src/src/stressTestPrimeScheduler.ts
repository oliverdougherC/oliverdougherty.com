import { PRIME_SEARCH_START, PRIME_SEGMENT_ODDS } from './stressTestPrimes';

export const PRIME_BLOCK_ODDS = PRIME_SEGMENT_ODDS * 64;
export const PRIME_PREFETCH_BLOCKS = 4;
export const PRIME_REFILL_THRESHOLD = 2;

export interface PrimeBlock {
  id: number;
  low: number;
  high: number;
}

/** Allocator position a partially failed spawn wave can be rewound to. */
export interface PrimeAllocatorMark {
  next: number;
  nextId: number;
  finished: boolean;
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

  mark(): PrimeAllocatorMark {
    return { next: this.next, nextId: this.nextId, finished: this.finished };
  }

  /**
   * Rewinds the frontier to `mark`, returning every block issued since. Legal
   * only as the immediate rollback of a failed allocation sequence: wave
   * spawning is synchronous, so no refill can interleave and none of the
   * rewound blocks can have reached a live worker.
   */
  rewindTo(mark: PrimeAllocatorMark) {
    if (this.next < mark.next || this.nextId < mark.nextId) {
      throw new Error('Prime allocator rewound outside its rollback window.');
    }
    this.next = mark.next;
    this.nextId = mark.nextId;
    this.finished = mark.finished;
  }
}

/**
 * Disposable benchmark range for SMT throughput waves. Probe workers sieve from
 * their own start through a private allocator so a keep/revert decision can
 * never consume, skip, or reclaim production blocks: the production allocator's
 * disjoint, consecutive coverage invariant survives every probe outcome.
 */
export const BENCHMARK_PRIME_SEARCH_START = 1_000_000_001;

export function createBenchmarkPrimeAllocator() {
  return new PrimeBlockAllocator(PRIME_BLOCK_ODDS, Number.MAX_SAFE_INTEGER, BENCHMARK_PRIME_SEARCH_START);
}
