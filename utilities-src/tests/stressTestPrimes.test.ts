import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIME_SEARCH_START, PRIME_SEGMENT_ODDS, SegmentedPrimeSieve } from '../src/stressTestPrimes';
import { PRIME_WORKER_BAND, primeWorkerRange } from '../src/stressTestPrimeRanges';
import type { StressTestWorkerRequest, StressTestWorkerResponse, CpuStressHeartbeatResponse } from '../src/stressTestWorkerTypes';

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
    // Disjointness by construction is what lets the pool report one prime count
    // without any allocator: band k covers [1 + k·band, (k + 1)·band].
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

describe('CPU prime worker band lifecycle', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  /**
   * Drives the real worker module against a stubbed worker global. `tasks` are
   * the queued compute slices the worker posts to itself; `timers` are its
   * drained-band watchdogs. The stub clock advances 50ms per reading, so one
   * task runs one compute slice and heartbeats come due as they do in a browser.
   */
  async function harness() {
    const messages: StressTestWorkerResponse[] = [];
    const tasks: Array<() => void> = [];
    const timers = new Map<number, () => void>();
    let timerId = 0;
    const scope = {
      onmessage: null as ((event: { data: StressTestWorkerRequest }) => void) | null,
      postMessage: (message: StressTestWorkerResponse) => messages.push(message),
      setTimeout: (callback: () => void) => { timerId += 1; timers.set(timerId, callback); return timerId; },
      clearTimeout: (id: number) => { timers.delete(id); }
    };
    let clock = 0;
    // One millisecond per clock reading by default is what makes an 8ms compute
    // slice run a predictable number of segments. `setClockStep` and `advance`
    // let a test model a scheduler that is slow to hand the worker a processor
    // again, which is the only way to test the worker's busy/idle split.
    let clockStep = 50;
    vi.stubGlobal('self', scope);
    vi.stubGlobal('performance', { now: () => { clock += clockStep; return clock; } });
    vi.stubGlobal('MessageChannel', class {
      port1 = { onmessage: null as ((event: { data: number }) => void) | null };
      port2 = { postMessage: (data: number) => tasks.push(() => this.port1.onmessage?.({ data })) };
    });
    await import('../src/stressTest.worker');
    return {
      messages,
      tasks,
      timers,
      send: (data: StressTestWorkerRequest) => scope.onmessage!({ data }),
      runTask: () => { tasks.shift()?.(); },
      setClockStep: (step: number) => { clockStep = step; },
      advance: (ms: number) => { clock += ms; },
      fireOldestTimer: () => {
        const oldest = timers.entries().next();
        if (oldest.done) return false;
        timers.delete(oldest.value[0]);
        oldest.value[1]();
        return true;
      },
      heartbeats: () => messages.filter((message): message is CpuStressHeartbeatResponse => message.type === 'cpu-stress-heartbeat'),
      lastHeartbeat: () => messages.filter((message): message is CpuStressHeartbeatResponse => message.type === 'cpu-stress-heartbeat').at(-1)
    };
  }

  it('computes real primes for its band and prefetches the next one before draining', async () => {
    const { messages, tasks, send, runTask, heartbeats } = await harness();
    send({ type: 'start-cpu-stress', requestId: 7, workerIndex: 3, low: 1, limit: 64 });
    expect(messages).toHaveLength(0); // no work happens until a slice is queued

    runTask();
    expect(heartbeats()[0]).toMatchObject({
      requestId: 7, workerIndex: 3, candidates: 33, primesFound: 18, latestPrime: 61, rangeLow: 65
    });
    // The band is small, so the worker is nearly drained and asks for the next
    // one now — seconds of real search before it could ever go idle. The
    // reported rangeLow is its cursor: the next integer it has not sieved.
    expect(messages.find(message => message.type === 'cpu-stress-work-request'))
      .toMatchObject({ requestId: 7, workerIndex: 3, supplyId: 1 });

    send({ type: 'continue-cpu-stress', requestId: 7, workerIndex: 3, supplyId: 1, low: 65, limit: 128 });
    runTask();
    expect(heartbeats().at(-1)).toMatchObject({ candidates: 65, primesFound: 31, latestPrime: 127, rangeLow: 129 });
    expect(messages.some(message => message.type === 'cpu-stress-error')).toBe(false);
  });

  it('stops scheduling work when its band is drained instead of spinning, then resumes', async () => {
    const { messages, tasks, timers, send, runTask, fireOldestTimer } = await harness();
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, low: 1, limit: 64 });
    runTask(); // sieves the whole band and asks for more
    const requests = messages.filter(message => message.type === 'cpu-stress-work-request');
    expect(requests).toHaveLength(1);

    runTask(); // next slice finds nothing left to sieve
    expect(tasks).toHaveLength(0); // and the worker stops queueing itself
    expect(messages.filter(message => message.type === 'cpu-stress-work-request')).toHaveLength(1); // request still outstanding
    expect(timers.size).toBe(1); // one bounded watchdog instead of a busy loop

    // A dropped answer cannot stall the pool forever: the watchdog re-asks.
    expect(fireOldestTimer()).toBe(true);
    expect(messages.filter(message => message.type === 'cpu-stress-work-request')).toHaveLength(2);
    const second = messages.filter(message => message.type === 'cpu-stress-work-request').at(-1)!;
    expect(second).toMatchObject({ supplyId: 2 });

    send({ type: 'continue-cpu-stress', requestId: 1, workerIndex: 0, supplyId: 2, low: 65, limit: 128 });
    runTask();
    expect(messages.filter(message => message.type === 'cpu-stress-heartbeat').at(-1))
      .toMatchObject({ candidates: 65, rangeLow: 129 });
  });

  it('rejects an overlapping or malformed band rather than double-sieving integers', async () => {
    const { messages, tasks, send, runTask } = await harness();
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, low: 1, limit: 64 });
    runTask();
    const before = messages.length;
    // 33 sits inside the band this worker already owns.
    send({ type: 'continue-cpu-stress', requestId: 1, workerIndex: 0, supplyId: 1, low: 33, limit: 128 });
    expect(messages.slice(before).map(message => message.type)).toEqual(['cpu-stress-error']);
    expect(messages.at(-1)).toMatchObject({ message: 'Prime band overlaps the band already owned.' });

    messages.length = 0;
    runTask(); // the failed worker must not keep computing
    expect(messages).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  it.each([
    ['an even low', { low: 2, limit: 128 }],
    ['an end below its start', { low: 65, limit: 65 }]
  ])('reports a band with %s as an error', async (_label, band) => {
    const { messages, send, runTask } = await harness();
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, low: 1, limit: 64 });
    runTask();
    send({ type: 'continue-cpu-stress', requestId: 1, workerIndex: 0, supplyId: 1, ...band });
    expect(messages.at(-1)).toMatchObject({ type: 'cpu-stress-error', message: 'Invalid prime band bounds.' });
  });

  it('accepts each supply exactly once and ignores stale or unsolicited replies', async () => {
    const { messages, send, runTask, lastHeartbeat } = await harness();
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, low: 1, limit: 64 });
    runTask();
    const before = messages.length;
    send({ type: 'continue-cpu-stress', requestId: 99, workerIndex: 0, supplyId: 1, low: 65, limit: 128 }); // wrong run
    send({ type: 'continue-cpu-stress', requestId: 1, workerIndex: 4, supplyId: 1, low: 65, limit: 128 }); // wrong worker
    send({ type: 'continue-cpu-stress', requestId: 1, workerIndex: 0, supplyId: 2, low: 65, limit: 128 }); // never requested
    expect(messages.length).toBe(before); // nothing accepted, nothing errored

    send({ type: 'continue-cpu-stress', requestId: 1, workerIndex: 0, supplyId: 1, low: 65, limit: 128 });
    send({ type: 'continue-cpu-stress', requestId: 1, workerIndex: 0, supplyId: 1, low: 129, limit: 192 }); // duplicate
    runTask();
    // One band's work advanced the totals: the duplicate never took effect.
    expect(lastHeartbeat()).toMatchObject({ candidates: 65, primesFound: 31, latestPrime: 127, rangeLow: 129 });
  });

  it('resets for a newer run so queued slices from the old one cannot advance it', async () => {
    const { messages, tasks, send, runTask, heartbeats } = await harness();
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, low: 1, limit: 64 });
    runTask();
    expect(heartbeats()[0]).toMatchObject({ requestId: 1, candidates: 33 });
    expect(tasks.length).toBeGreaterThan(0); // a slice from the first run is queued

    send({ type: 'start-cpu-stress', requestId: 2, workerIndex: 0, low: 1, limit: 64 });
    messages.length = 0;
    runTask(); // stale generation slice: dropped by the generation guard
    expect(messages).toHaveLength(0);
    runTask(); // the new run's own slice
    expect(heartbeats()[0]).toMatchObject({ requestId: 2, candidates: 33, primesFound: 18, latestPrime: 61 });
    // Restart counts are per run: the new run starts from zero, not from 33.
    expect(heartbeats().filter(message => message.candidates === 33)).toHaveLength(1);
  });

  it('books sieving time as busy time and the wait for the next slice as idle time', async () => {
    // The pool's growth rule decides on busy/(busy+idle), so neither may absorb the
    // other. Letting a slice's own compute time also count as waiting — the mistake
    // this test exists to catch — reads as a flat ~50% duty cycle whether the
    // machine is 16% loaded or fully loaded, which is why this is measured against a
    // real machine as well as asserted here.
    const { send, runTask, setClockStep, advance, lastHeartbeat } = await harness();
    setClockStep(1); // 1ms per reading: an 8ms slice runs eight segments
    send({ type: 'start-cpu-stress', requestId: 4, workerIndex: 1, low: 1, limit: 20_000_001 });
    for (let slice = 0; slice < 6; slice += 1) {
      advance(200); // the scheduler takes this long to hand the worker a processor
      runTask();
    }
    const beat = lastHeartbeat()!;
    expect(beat.candidates).toBeGreaterThan(0);
    // Exactly eight milliseconds of sieving per slice: the wait never enters it.
    expect(beat.busyMs).toBe(48);
    // The waits are booked as idle — and only the waits, plus the clock readings
    // around them. There is no gap before the first slice to book at all.
    expect(beat.idleMs).toBeGreaterThanOrEqual(5 * 200);
    expect(beat.idleMs).toBeLessThanOrEqual(5 * 204);
    expect(beat.bandWaitMs).toBe(0);
    expect(beat.slices).toBe(6);
    expect(beat.slowSlices).toBe(0); // an 8ms slice is not 1.5× over its own budget
  });

  it('books a wait for integers as neither busy nor idle time', async () => {
    // A worker with nothing left to sieve is the page being slow to hand out work.
    // Booking that gap as queueing-for-a-processor would end the pool's growth for
    // a page-side reason, so it gets its own counter and stays out of the ratio.
    const { send, runTask, setClockStep, advance, lastHeartbeat } = await harness();
    setClockStep(1);
    send({ type: 'start-cpu-stress', requestId: 5, workerIndex: 2, low: 1, limit: 64 });
    runTask(); // sieves the whole small band, then asks for the next one
    advance(900); // the page takes a long time to answer
    send({ type: 'continue-cpu-stress', requestId: 5, workerIndex: 2, supplyId: 1, low: 65, limit: 128 });
    runTask();
    const beat = lastHeartbeat()!;
    expect(beat.bandWaitMs).toBeGreaterThanOrEqual(900);
    expect(beat.idleMs).toBe(0); // never read as the machine being out of processors
  });
});
