import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIME_SEARCH_START, PRIME_SEGMENT_ODDS, SegmentedPrimeSieve } from '../src/stressTestPrimes';
import { PrimeBlockAllocator, PRIME_PREFETCH_BLOCKS, PRIME_REFILL_THRESHOLD, type PrimeBlock } from '../src/stressTestPrimeScheduler';
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

  it('rejects unsafe and oversized intervals', () => {
    const sieve = new SegmentedPrimeSieve();
    for (const [low, high] of [[0, 10], [3, 2], [1, PRIME_SEGMENT_ODDS * 2 + 1], [1, Infinity], [1, Number.MAX_SAFE_INTEGER + 1]]) {
      expect(() => sieve.sieve(low, high)).toThrow('Invalid prime sieve interval.');
    }
  });
});

describe('demand-driven prime blocks', () => {
  it.each([1, 2, 8, 128])('covers every candidate once across %i heterogeneous workers', workerCount => {
    const allocator = new PrimeBlockAllocator(64, 100000);
    const lanes = Array.from({ length: workerCount }, (_, index) => ({
      queue: allocator.take(PRIME_PREFETCH_BLOCKS), sieve: new SegmentedPrimeSieve(),
      readyAt: index % 5 + 1, speed: index % 5 + 1, completed: 0
    }));
    const completed: PrimeBlock[] = [];
    let count = 0, latest = 0, candidates = 0;
    while (lanes.some(lane => lane.queue.length > 0)) {
      const lane = lanes.filter(item => item.queue.length).sort((a, b) => a.readyAt - b.readyAt)[0];
      const block = lane.queue.shift()!;
      const result = countRange(lane.sieve, block.low, block.high);
      count += result.primesFound;
      candidates += result.candidates;
      latest = Math.max(latest, result.latestPrime);
      completed.push(block);
      lane.completed += 1;
      lane.readyAt += lane.speed;
      if (lane.queue.length <= PRIME_REFILL_THRESHOLD && !allocator.exhausted) {
        lane.queue.push(...allocator.take(PRIME_PREFETCH_BLOCKS - lane.queue.length));
      }
    }
    const sorted = completed.sort((a, b) => a.low - b.low);
    expect(new Set(sorted.map(block => block.id)).size).toBe(sorted.length);
    expect(sorted[0].low).toBe(1);
    for (let index = 1; index < sorted.length; index += 1) expect(sorted[index].low).toBe(sorted[index - 1].high + 1);
    expect(sorted.at(-1)?.high).toBe(100000);
    expect(candidates).toBe(50001);
    expect(count).toBe(9592);
    expect(latest).toBe(99991);
    if (workerCount > 2) expect(lanes[0].completed).toBeGreaterThan(lanes[4]?.completed ?? lanes[1].completed);
  });

  it('finishes the last inclusive block without exceeding safe integers', () => {
    const end = Number.MAX_SAFE_INTEGER;
    const allocator = new PrimeBlockAllocator(2, end, end - 6);
    expect(allocator.take(4)).toEqual([
      { id: 0, low: end - 6, high: end - 3 }, { id: 1, low: end - 2, high: end }
    ]);
    expect(allocator.exhausted).toBe(true);
    expect(allocator.take(4)).toEqual([]);
    expect(() => allocator.take(5)).toThrow();
  });
});

describe('CPU prime worker queue lifecycle', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  async function harness() {
    const messages: StressTestWorkerResponse[] = [];
    const tasks: Array<() => void> = [];
    const scope = {
      onmessage: null as ((event: { data: StressTestWorkerRequest }) => void) | null,
      postMessage: (message: StressTestWorkerResponse) => messages.push(message)
    };
    let clock = 0;
    vi.stubGlobal('self', scope);
    vi.stubGlobal('performance', { now: () => { clock += 50; return clock; } });
    vi.stubGlobal('MessageChannel', class {
      port1 = { onmessage: null as ((event: { data: number }) => void) | null };
      port2 = { postMessage: (data: number) => tasks.push(() => this.port1.onmessage?.({ data })) };
    });
    await import('../src/stressTest.worker');
    return { messages, tasks, send: (data: StressTestWorkerRequest) => scope.onmessage!({ data }) };
  }

  it('computes real small primes, requests ahead, and never advances after stop', async () => {
    const { messages, tasks, send } = await harness();
    const allocator = new PrimeBlockAllocator(32);
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, blocks: allocator.take(4), exhausted: false });
    expect(messages).toHaveLength(0);
    tasks.shift()!();
    expect(messages.find(message => message.type === 'cpu-stress-heartbeat')).toMatchObject({
      iterations: 33, latestPrime: 61, primesFound: 18
    });
    tasks.shift()!();
    expect(messages.find(message => message.type === 'cpu-stress-work-request')).toMatchObject({ supplyId: 1, count: 2 });
    expect(tasks).toHaveLength(1); // Useful prefetched work remains while the reply travels.
    send({ type: 'stop-cpu-stress', requestId: 1 });
    const stoppedLength = messages.length;
    while (tasks.length) tasks.shift()!();
    send({ type: 'stop-cpu-stress', requestId: 1 });
    expect(messages).toHaveLength(stoppedLength);
    expect(messages.filter(message => message.type === 'cpu-stress-stopped')).toHaveLength(1);
  });

  it('accepts each supply once, ignores stale/out-of-order replies, and drains exact totals', async () => {
    const { messages, tasks, send } = await harness();
    const allocator = new PrimeBlockAllocator(32, 1000);
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, blocks: allocator.take(4), exhausted: false });
    let cursor = 0;
    for (let turn = 0; turn < 100 && tasks.length; turn += 1) {
      tasks.shift()!();
      const incoming = messages.slice(cursor);
      cursor = messages.length;
      for (const message of incoming) {
        if (message.type !== 'cpu-stress-work-request') continue;
        const blocks = allocator.take(message.count);
        const reply = { type: 'supply-cpu-stress-work' as const, requestId: 1, workerIndex: 0,
          supplyId: message.supplyId, blocks, exhausted: allocator.exhausted };
        send({ ...reply, supplyId: message.supplyId + 1 });
        send({ ...reply, requestId: 99 });
        send(reply);
        send(reply);
      }
    }
    const last = messages.filter((message): message is CpuStressHeartbeatResponse => message.type === 'cpu-stress-heartbeat').at(-1)!;
    expect(last).toMatchObject({ iterations: 501, primesFound: 168, latestPrime: 997 });
    expect(last.checksum).toBeGreaterThanOrEqual(0);
    expect(last.checksum).toBeLessThan(1);
    expect(messages.filter(message => message.type === 'cpu-stress-exhausted')).toHaveLength(1);
    expect(messages.some(message => message.type === 'cpu-stress-error')).toBe(false);
  });

  it('resets on restart without letting old tasks or supplies advance the new run', async () => {
    const { messages, tasks, send } = await harness();
    const first = new PrimeBlockAllocator(32);
    send({ type: 'start-cpu-stress', requestId: 1, workerIndex: 0, blocks: first.take(4), exhausted: false });
    tasks.shift()!(); tasks.shift()!();
    const next = new PrimeBlockAllocator(32);
    send({ type: 'start-cpu-stress', requestId: 2, workerIndex: 0, blocks: next.take(4), exhausted: false });
    messages.length = 0;
    send({ type: 'stop-cpu-stress', requestId: 1 });
    send({ type: 'supply-cpu-stress-work', requestId: 1, workerIndex: 0, supplyId: 1, blocks: first.take(2), exhausted: false });
    tasks.shift()!(); // Stale generation task.
    expect(messages).toHaveLength(0);
    tasks.shift()!();
    expect(messages.find(message => message.type === 'cpu-stress-heartbeat')).toMatchObject({
      requestId: 2, iterations: 33, primesFound: 18, latestPrime: 61
    });
    send({ type: 'stop-cpu-stress', requestId: 2 });
  });
});
