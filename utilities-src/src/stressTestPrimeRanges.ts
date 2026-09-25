import { PRIME_SEARCH_START } from './stressTestPrimes';

/**
 * Integers one worker sieves before it moves on to its next block.
 *
 * A single worker tests on the order of 10^8 candidates per second, so one block is
 * roughly a few seconds of that worker's search. That is the whole trade: large
 * enough that a worker takes a new block every few seconds instead of constantly,
 * and small enough that the live pool occupies one neighbourhood of the number line —
 * shallowest to deepest worker spans about `pool size × band` — which keeps the cost
 * of a candidate comparable across the pool and bounds each worker's base-prime cache
 * to the depth it actually searches.
 *
 * The worker derives which block it takes from what it was told once at the start of
 * the run — its lane and the pool size — so the main thread never allocates work and a
 * worker never waits for an assignment.
 */
export const PRIME_WORKER_BAND = 2 ** 31;

export interface PrimeWorkerRange {
  /** First integer of the block; always odd, so every segment starts on an odd. */
  low: number;
  /** Last integer of the block; always even, so the next segment's low stays odd. */
  limit: number;
}

/**
 * Block `serial` of a tiling of the number line: block k covers
 * `[1 + k·band, (k + 1)·band]`, so blocks issued from a monotonically increasing
 * serial are disjoint and contiguous without any allocator, reservation, rollback,
 * or coverage bookkeeping. Two workers can never sieve the same integer, which is
 * what makes the reported primes unique for the run, and a worker that dies cannot
 * leave a hole that needs recovering — the search is a stress workload, not a proof
 * that every integer below N has been examined.
 *
 * A fixed pool of N workers reads the tiling with a stride: worker i sieves blocks
 * i, i+N, i+2N …, which partitions the line across the pool with no shared state and
 * lets a replacement worker take over exactly the lane its predecessor had.
 *
 * Reaching the end of the safe integer range is an explicit failure rather than a
 * silent wrap-around (blocks never restart from 1), matching the sieve's own
 * safe-integer limit.
 */
export function primeWorkerRange(serial: number, band = PRIME_WORKER_BAND): PrimeWorkerRange {
  if (!Number.isSafeInteger(serial) || serial < 0 || !Number.isSafeInteger(band) || band < 2 || band % 2 !== 0) {
    throw new Error('Invalid prime band request.');
  }
  const low = PRIME_SEARCH_START + serial * band;
  const limit = low + band - 1;
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(limit) || limit > Number.MAX_SAFE_INTEGER) {
    throw new Error('Prime search range exceeded the safe integer range.');
  }
  return { low, limit };
}
