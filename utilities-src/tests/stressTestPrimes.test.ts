import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIME_SEARCH_START, PRIME_SEGMENT_ODDS, SegmentedPrimeSieve } from '../src/stressTestPrimes';
import { PRIME_WORKER_BAND, primeWorkerRange } from '../src/stressTestPrimeRanges';
import type { CpuStressProgressResponse, StressTestWorkerRequest, StressTestWorkerResponse } from '../src/stressTestWorkerTypes';

function referencePrimes(limit: number) {
  const composite = new Uint8Array(limit + 1);
  composite[0] = composite[1] = 1;
  for (let divisor = 2; divisor * divisor <= limit; divisor += 1) {
    if (composite[divisor]) continue;
    for (let multiple = divisor * divisor; multiple <= limit; multiple += divisor) composite[multiple] = 1;
  }
  return Array.from({ length: limit + 1 }, (_, value) => value).filter(value => !composite[value]);
}

function countRange(sieve: SegmentedPrimeSieve, low: number, high: number) {
  let primesFound = 0, latestPrime = 0, candidates = 0;
  for (let start = low; start <= high; start += sieve.segmentOdds * 2) {
    const result = sieve.sieve(start, Math.min(high, start + sieve.segmentOdds * 2 - 1));
    primesFound += result.primesFound;
    candidates += result.candidates;
    latestPrime = Math.max(latestPrime, result.latestPrime);
  }
  return { primesFound, latestPrime, candidates };
}

function isPrime(value: number) {
  if (!Number.isSafeInteger(value) || value < 2) return false;
  if (value % 2 === 0) return value === 2;
  for (let divisor = 3; divisor * divisor <= value; divisor += 2) {
    if (value % divisor === 0) return false;
  }
  return true;
}

describe('segmented prime sieve', () => {
  it('starts at 1, rejects it, and counts 2 exactly once', () => {
    const sieve = new SegmentedPrimeSieve();
    expect(PRIME_SEARCH_START).toBe(1);
    expect(sieve.sieve(1, 1)).toEqual({ candidates: 1, primesFound: 0, latestPrime: 0 });
    expect(sieve.sieve(2, 2)).toEqual({ candidates: 1, primesFound: 1, latestPrime: 2 });
    expect(sieve.sieve(1, 29)).toEqual({ candidates: 16, primesFound: 10, latestPrime: 29 });
    expect(sieve.sieve(30, 49)).toEqual({ candidates: 10, primesFound: 5, latestPrime: 47 });
  });

  it.each([[100, 25, 97], [1_000_000, 78498, 999983], [10_000_000, 664579, 9999991]])
    ('matches known π(%i) using reused segments', (limit, count, latest) => {
      const result = countRange(new SegmentedPrimeSieve(), 1, limit);
      expect(result.primesFound).toBe(count);
      expect(result.latestPrime).toBe(latest);
      expect(result.candidates).toBe(Math.ceil(limit / 2) + 1);
    });

  it('agrees with an independent sieve on arbitrary intervals and perfect-square boundaries', () => {
    const reference = referencePrimes(120000);
    const sieve = new SegmentedPrimeSieve();
    for (const [low, high] of [[4, 4], [9, 49], [24, 26], [48, 50], [90000, 110007],
      [101, 65635], [113000, 119999], [3, 2000], [99990, 100010]]) {
      const expected = reference.filter(prime => prime >= low && prime <= high);
      const actual = sieve.sieve(low, high);
      expect(actual.primesFound, `${low}–${high}`).toBe(expected.length);
      expect(actual.latestPrime).toBe(expected.at(-1) ?? 0);
    }
  });

  it('grows its base-prime cache for distant work without leaking old segment flags', () => {
    const sieve = new SegmentedPrimeSieve(32);
    const reference = referencePrimes(1_000_000);
    for (const low of [1, 997000, 101, 500001, 17, 999937]) {
      const expected = reference.filter(prime => prime >= low && prime < low + 64);
      expect(sieve.sieve(low, low + 63).primesFound).toBe(expected.length);
    }
  });

  it('matches trial division across the 2^31 SMI boundary and deep frontiers', () => {
    // Barrett reduction replaces `low % prime` past SMI range; verify exact
    // segment results where that path starts mattering and far beyond it.
    const isPrime = (n: number) => {
      if (n < 2 || (n > 2 && n % 2 === 0)) return false;
      for (let d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
      return true;
    };
    const sieve = new SegmentedPrimeSieve();
    for (const anchor of [2 ** 31 - 15, 2 ** 31 + 1, 2 ** 34 + 1, 2 ** 46 + 1]) {
      const low = anchor % 2 ? anchor : anchor + 1;
      const high = low + 41;
      const expected: number[] = [];
      for (let value = low; value <= high; value += 2) if (isPrime(value)) expected.push(value);
      const result = sieve.sieve(low, high);
      expect(result.primesFound, String(low)).toBe(expected.length);
      expect(result.latestPrime).toBe(expected.at(-1) ?? 0);
    }
  });

  it('rejects unsafe and oversized intervals', () => {
    const sieve = new SegmentedPrimeSieve();
    for (const [low, high] of [[0, 10], [3, 2], [1, PRIME_SEGMENT_ODDS * 2 + 1], [1, Infinity], [1, Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => sieve.sieve(low, high)).toThrow('Invalid prime sieve interval.');
    }
  });
});

describe('worker prime bands', () => {
  it('tiles the number line so issued bands are contiguous and disjoint', () => {
    // Disjointness by construction is what lets a pool of workers own the line
    // between them with no allocator: band k covers [1 + k·band, (k + 1)·band].
    let previous = primeWorkerRange(0);
    expect(previous).toEqual({ low: 1, limit: PRIME_WORKER_BAND });
    for (let serial = 1; serial < 8; serial += 1) {
      const band = primeWorkerRange(serial);
      expect(band.low % 2, String(serial)).toBe(1); // odd start: every segment starts on an odd
      expect(band.limit % 2, String(serial)).toBe(0); // even end: the next low stays odd
      expect(band.low, String(serial)).toBe(previous.limit + 1); // contiguous
      expect(band.low, String(serial)).toBeGreaterThan(previous.limit); // and disjoint
      expect(band.limit - band.low).toBe(PRIME_WORKER_BAND - 1);
      previous = band;
    }
  });

  it('lets independent workers cover a range exactly once between them', () => {
    // Four separate sieves, one per band — the way four workers run — must agree
    // with the reference count for the union: no integer counted twice, none
    // skipped at the seams.
    const band = 64;
    const reference = referencePrimes(4 * band);
    let primesFound = 0;
    let candidates = 0;
    let latestPrime = 0;
    for (let serial = 0; serial < 4; serial += 1) {
      const range = primeWorkerRange(serial, band);
      const result = countRange(new SegmentedPrimeSieve(), range.low, range.limit);
      primesFound += result.primesFound;
      candidates += result.candidates;
      latestPrime = Math.max(latestPrime, result.latestPrime);
    }
    expect(primesFound).toBe(reference.length);
    expect(latestPrime).toBe(reference.at(-1));
    expect(candidates).toBe(band * 2 + 1); // odds in [1, 256] plus the even 2
  });

  it('gives a lane its blocks without any allocation, so lanes never overlap', () => {
    // A worker derives block `index + k·poolSize` from two numbers it was told once.
    // Four lanes of a four-worker pool must therefore be four disjoint blocks, and
    // the fifth block of lane 0 must be the block after lane 3's first — the whole
    // line is covered exactly once, in order, with no page-side bookkeeping.
    const poolSize = 4;
    const first = Array.from({ length: poolSize }, (_, index) => primeWorkerRange(index + 0 * poolSize));
    expect(first.map(block => block.low)).toEqual([1, 1 + PRIME_WORKER_BAND, 1 + 2 * PRIME_WORKER_BAND, 1 + 3 * PRIME_WORKER_BAND]);
    expect(first[poolSize - 1].limit + 1).toBe(primeWorkerRange(0 + 1 * poolSize).low);
    for (const block of first) {
      expect(block.low % 2).toBe(1);
      expect(block.limit - block.low).toBe(PRIME_WORKER_BAND - 1);
    }
  });

  it('refuses to wrap the number line or accept a meaningless request', () => {
    // A stress run must never silently restart the search from 1.
    expect(() => primeWorkerRange(2 ** 22)).toThrow('safe integer range');
    expect(primeWorkerRange(2 ** 22 - 1).limit).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    for (const serial of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => primeWorkerRange(serial)).toThrow('Invalid prime band request');
    }
    for (const band of [0, 1, 3, 2.5, Number.NaN]) {
      expect(() => primeWorkerRange(0, band)).toThrow('Invalid prime band request');
    }
  });
});

describe('CPU prime worker compute loop', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  /**
   * Drives the real worker module against a stubbed worker global.
   *
   * The module's compute loop is continuous — it ends when the page terminates the
   * worker, which a unit test cannot do — so the stub clock throws once
   * `loopBound` readings have been taken. That is the test's stand-in for
   * termination, and it doubles as the way a runtime failure inside the loop looks
   * to the page: reported as `cpu-stress-error`, never silence. `clockStep` is the
   * milliseconds one segment of work is assumed to take, so the number of progress
   * messages a bounded loop produces is predictable.
   */
  async function harness(options: { hardwareConcurrency?: number | null; loopBound?: number; clockStep?: number } = {}) {
    const { hardwareConcurrency = 32, loopBound = 24, clockStep = 60 } = options;
    const messages: StressTestWorkerResponse[] = [];
    let readings = 0;
    let clock = 0;
    const scope = {
      onmessage: null as ((event: { data: StressTestWorkerRequest }) => void) | null,
      postMessage: (message: StressTestWorkerResponse) => { messages.push(message); }
    };
    vi.stubGlobal('self', scope);
    vi.stubGlobal('navigator', hardwareConcurrency === null ? {} : { hardwareConcurrency });
    vi.stubGlobal('performance', {
      now: () => {
        readings += 1;
        if (readings > loopBound) throw new Error('harness loop bound');
        clock += clockStep;
        return clock;
      }
    });
    await import('../src/stressTest.worker');
    return {
      messages,
      send: (data: StressTestWorkerRequest) => scope.onmessage!({ data }),
      ready: () => messages.find(message => message.type === 'cpu-stress-ready'),
      progress: () => messages.filter((message): message is CpuStressProgressResponse => message.type === 'cpu-stress-progress'),
      lastProgress: () => messages.filter((message): message is CpuStressProgressResponse => message.type === 'cpu-stress-progress').at(-1)
    };
  }

  it('announces the processor count its own scope reports, before it computes', async () => {
    // This is how the page learns the count where the workload runs. It has to be
    // the worker's own navigator: on the affected host the page-scope value is
    // spoofed by the browser's fingerprint protection while this one is not.
    const { messages, ready } = await harness({ hardwareConcurrency: 32 });
    expect(ready()).toEqual({ type: 'cpu-stress-ready', hardwareConcurrency: 32 });
    expect(messages).toHaveLength(1); // nothing computes before it is started
  });

  it('reports a null count rather than inventing one when its scope has no number', async () => {
    const { ready } = await harness({ hardwareConcurrency: null });
    expect(ready()).toEqual({ type: 'cpu-stress-ready', hardwareConcurrency: null });
  });

  it('computes continuously and reports progress without ever asking for work', async () => {
    const { messages, send, progress } = await harness({ loopBound: 24, clockStep: 60 });
    messages.length = 0;
    send({ type: 'start-cpu-stress', requestId: 7, workerIndex: 3, poolSize: 8 });
    const beats = progress();
    expect(beats.length).toBeGreaterThan(1); // progress is periodic, not one-shot
    for (const beat of beats) {
      expect(beat).toMatchObject({ requestId: 7, workerIndex: 3 });
    }
    // Work actually accumulates between reports, and every number is a delta the
    // page can trust: candidates only ever grow.
    expect(beats.at(-1)!.candidates).toBeGreaterThan(beats[0].candidates);
    expect(beats.at(-1)!.primesFound).toBeGreaterThan(0);
    expect(beats.at(-1)!.blocks).toBe(1); // one block, derived locally, never requested
    // Nothing here asks the page for anything: no work request exists in the protocol.
    expect(messages.some(message => (message as { type: string }).type === 'cpu-stress-work-request')).toBe(false);
  });

  it('sieves the block its lane number says it should, from the first segment', async () => {
    // Worker `i` of `N` owns block `i + k·N`. Worker 3 of 8 therefore starts at
    // 3·2^31 + 1 — a starting point the page never sent it, and which no other
    // lane of the same pool occupies.
    const { send, lastProgress } = await harness();
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 3, poolSize: 8 });
    const beat = lastProgress()!;
    expect(beat.rangeLow).toBeGreaterThan(primeWorkerRange(3).low);
    expect(beat.rangeLow).toBeLessThanOrEqual(primeWorkerRange(3).low + 24 * PRIME_SEGMENT_ODDS * 2);
    expect(beat.rangeLow).toBeLessThanOrEqual(primeWorkerRange(3).limit);
    expect(beat.blocks).toBe(1);
  });

  it('finds primes that are actually prime, deep in its lane', async () => {
    const { send, progress } = await harness({ loopBound: 12 });
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, poolSize: 1 });
    const beats = progress();
    expect(beats.length).toBeGreaterThan(0);
    const prime = beats.at(-1)!.latestPrime;
    expect(prime).toBeGreaterThan(2);
    expect(isPrime(prime)).toBe(true);
    // Progress is throttled, not spammed: a bounded loop yields a handful of reports.
    expect(beats.length).toBeLessThan(12);
  });

  it('reports a fault inside its compute loop instead of going quiet', async () => {
    // The loop is not interruptible by message, so the page's only knowledge of a
    // worker that stopped computing is this message. A swallowed error here is a
    // worker that looks busy forever.
    const { messages, send } = await harness({ loopBound: 3 });
    messages.length = 0;
    send({ type: 'start-cpu-stress', requestId: 4, workerIndex: 1, poolSize: 2 });
    expect(messages.at(-1)).toMatchObject({
      type: 'cpu-stress-error', requestId: 4, workerIndex: 1, message: 'harness loop bound'
    });
  });

  it.each([
    ['a lane index outside the pool', { requestId: 1, workerIndex: 4, poolSize: 4 }],
    ['a negative lane', { requestId: 1, workerIndex: -1, poolSize: 4 }],
    ['a pool size of zero', { requestId: 1, workerIndex: 0, poolSize: 0 }],
    ['a fractional pool size', { requestId: 1, workerIndex: 0, poolSize: 2.5 }]
  ])('refuses %s rather than sieving a lane the page did not ask for', async (_label, assignment) => {
    const { messages, send } = await harness();
    messages.length = 0;
    send({ type: 'start-cpu-stress', ...assignment } as StressTestWorkerRequest);
    expect(messages).toEqual([
      { type: 'cpu-stress-error', requestId: assignment.requestId, workerIndex: assignment.workerIndex,
        message: 'Invalid CPU worker assignment.' }
    ]);
  });

  it('ignores a start for a run it is not part of', async () => {
    // The controller creates fresh workers per run and terminates the old ones, so
    // a second start on a live worker is always stale: it must not restart counting.
    const { messages, send, progress } = await harness({ loopBound: 6 });
    messages.length = 0;
    send({ type: 'start-cpu-stress', requestId: 2, workerIndex: 0, poolSize: 1 });
    const beats = progress().length;
    expect(beats).toBeGreaterThan(0);
    messages.length = 0;
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, poolSize: 1 }); // older run
    send({ type: 'start-cpu-stress', requestId: 2, workerIndex: 0, poolSize: 1 }); // same run
    expect(messages).toHaveLength(0);
  });
});
