import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';
import { PRIME_SEGMENT_ODDS, SegmentedPrimeSieve } from './stressTestPrimes';
import { PRIME_BLOCK_ODDS, PRIME_PREFETCH_BLOCKS, PRIME_REFILL_THRESHOLD, type PrimeBlock } from './stressTestPrimeScheduler';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const chunkChannel = new MessageChannel();
let sieve = new SegmentedPrimeSieve();
let activeRequestId = 0;
let activeWorkerIndex = 0;
let active = false;
let generation = 0;
let taskPending = false;
let iterations = 0;
let checksum = 0;
let latestPrime = 0;
let primesFound = 0;
let lastHeartbeat = 0;
let blocks: PrimeBlock[] = [];
let lastBlockId = -1;
let lastBlockHigh = 0;
let supplyId = 0;
let supplyPending = false;
let exhausted = false;
let paused = false;

function post(message: StressTestWorkerResponse) { workerScope.postMessage(message); }

function heartbeat() {
  lastHeartbeat = performance.now();
  post({ type: 'cpu-stress-heartbeat', requestId: activeRequestId, workerIndex: activeWorkerIndex,
    iterations, checksum: checksum / 1_000_003, latestPrime, primesFound, workUnits: sieve.workUnits });
}

function fail(error: unknown) {
  active = false;
  post({ type: 'cpu-stress-error', requestId: activeRequestId, workerIndex: activeWorkerIndex,
    message: error instanceof Error ? error.message : 'CPU prime worker failed.' });
}

function schedule() {
  if (!active || paused || taskPending || blocks.length === 0) return;
  taskPending = true;
  chunkChannel.port2.postMessage(generation);
}

function refill() {
  if (exhausted || supplyPending || blocks.length > PRIME_REFILL_THRESHOLD) return;
  supplyPending = true;
  post({ type: 'cpu-stress-work-request', requestId: activeRequestId, workerIndex: activeWorkerIndex,
    supplyId: ++supplyId, count: PRIME_PREFETCH_BLOCKS - blocks.length });
}

function acceptBlocks(incoming: PrimeBlock[]) {
  if (incoming.length + blocks.length > PRIME_PREFETCH_BLOCKS) throw new Error('Prime work queue exceeded its bound.');
  for (const block of incoming) {
    if (!Number.isSafeInteger(block.id) || block.id <= lastBlockId
      || !Number.isSafeInteger(block.low) || block.low <= lastBlockHigh || block.low % 2 !== 1
      || !Number.isSafeInteger(block.high) || block.high < block.low
      || block.high - block.low >= PRIME_BLOCK_ODDS * 2) {
      throw new Error('Invalid or overlapping prime work block.');
    }
    blocks.push({ ...block });
    lastBlockId = block.id;
    lastBlockHigh = block.high;
  }
}

function runChunk() {
  if (!active || paused) return; // a paused worker idles silent at a chunk boundary
  try {
    const deadline = performance.now() + 8;
    do {
      const block = blocks[0];
      if (!block) break;
      const high = block.high - block.low < PRIME_SEGMENT_ODDS * 2
        ? block.high : block.low + PRIME_SEGMENT_ODDS * 2 - 1;
      const result = sieve.sieve(block.low, high);
      iterations += result.candidates;
      primesFound += result.primesFound;
      latestPrime = Math.max(latestPrime, result.latestPrime);
      checksum = (checksum + result.primesFound + result.latestPrime % 1_000_003) % 1_000_003;
      if (high === block.high) {
        blocks.shift();
        refill();
      } else block.low = high + 1;
    } while (blocks.length > 0 && performance.now() < deadline);

    if (performance.now() - lastHeartbeat >= 140 || blocks.length === 0) heartbeat();
    if (blocks.length === 0 && exhausted) {
      active = false;
      post({ type: 'cpu-stress-exhausted', requestId: activeRequestId, workerIndex: activeWorkerIndex });
    } else {
      refill();
      schedule();
    }
  } catch (error) { fail(error); }
}

chunkChannel.port1.onmessage = (event: MessageEvent<number>) => {
  // A queued task from an old run cannot clear a new run's scheduled-task flag.
  if (event.data !== generation) return;
  taskPending = false;
  runChunk();
};

workerScope.onmessage = (event: MessageEvent<StressTestWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'start-cpu-stress') {
    if (request.requestId <= activeRequestId) return;
    generation += 1;
    activeRequestId = request.requestId;
    activeWorkerIndex = request.workerIndex;
    active = true;
    taskPending = false;
    iterations = 0;
    primesFound = 0;
    latestPrime = 0;
    checksum = 0;
    lastHeartbeat = 0;
    blocks = [];
    lastBlockId = -1;
    lastBlockHigh = 0;
    supplyId = 0;
    supplyPending = false;
    exhausted = request.exhausted;
    paused = false;
    sieve = new SegmentedPrimeSieve();
    try {
      acceptBlocks(request.blocks);
      // An exhausted allocator may have no blocks left for the last-created workers.
      if (blocks.length === 0) runChunk();
      else schedule();
    } catch (error) { fail(error); }
    return;
  }
  if (request.requestId !== undefined && request.requestId !== activeRequestId) return;
  if (request.type === 'stop-cpu-stress') {
    if (!active) return;
    heartbeat();
    active = false;
    generation += 1;
    blocks = [];
    taskPending = false;
    post({ type: 'cpu-stress-stopped', requestId: activeRequestId, workerIndex: activeWorkerIndex });
    return;
  }
  if (request.type === 'pause-cpu-stress') {
    if (!active || request.workerIndex !== activeWorkerIndex) return;
    paused = true;
    return;
  }
  if (request.type === 'resume-cpu-stress') {
    if (!active || request.workerIndex !== activeWorkerIndex) return;
    paused = false;
    schedule();
    return;
  }
  if (request.type === 'supply-cpu-stress-work') {
    if (!active || request.workerIndex !== activeWorkerIndex || !supplyPending || request.supplyId !== supplyId) return;
    try {
      acceptBlocks(request.blocks);
      exhausted = request.exhausted;
      supplyPending = false;
      if (blocks.length === 0) runChunk();
      else { refill(); schedule(); }
    } catch (error) { fail(error); }
  }
};
