import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';
import { CPU_SLICE_OVERRUN_FACTOR } from './stressTestCore';
import { PRIME_SEGMENT_ODDS, SegmentedPrimeSieve } from './stressTestPrimes';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

// Compute runs as near-continuous 8ms slices that re-post themselves through a
// MessageChannel. Nothing sleeps and no timer paces the work; the yield exists
// only so the worker's own message queue (the next band, a superseded run) can
// be seen, which a loop that never yields would starve.
const CPU_CHUNK_MS = 8;
const HEARTBEAT_INTERVAL_MS = 140;
// Prefetch: ask for the next band while this fraction of the current one is
// still in hand. At a worker's real search rate that is seconds of work left, so
// the round trip never lands in a starved worker.
const BAND_REFILL_REMAINING = 0.25;
// A worker that has actually drained its band does not spin: it waits, and pokes
// again on this interval so a lost answer cannot stall the pool forever.
const BAND_RETRY_MS = 2000;

const chunkChannel = new MessageChannel();
let sieve = new SegmentedPrimeSieve();
let activeRequestId = 0;
let workerIndex = 0;
let active = false;
let generation = 0;
let taskPending = false;
let candidates = 0;
let busyMs = 0;
let idleMs = 0;
let bandWaitMs = 0;
let slices = 0;
let slowSlices = 0;
let sliceEndedAt = 0;
let awaitingBand = false;
let checksum = 0;
let latestPrime = 0;
let primesFound = 0;
let lastHeartbeat = 0;
let bandLow = 0;
let bandLimit = 0;
let bandSpan = 0;
let nextLow = 0;
let nextLimit = 0;
let supplyId = 0;
let supplyPending = false;
let bandRetryTimer = 0;

function post(message: StressTestWorkerResponse) { workerScope.postMessage(message); }

function heartbeat() {
  lastHeartbeat = performance.now();
  post({ type: 'cpu-stress-heartbeat', requestId: activeRequestId, workerIndex,
    candidates, checksum: checksum / 1_000_003, latestPrime, primesFound, rangeLow: bandLow,
    busyMs, idleMs, bandWaitMs, slices, slowSlices });
}

function heartbeatIfDue() {
  const now = performance.now();
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) heartbeat();
}

/**
 * Ends one compute slice and books its wall time where it belongs. `busyMs` is
 * time spent sieving; `idleMs` is time between slices, which is how long the
 * scheduler took to hand this worker a processor again; `bandWaitMs` is the same
 * kind of gap but caused by the page having no integers to hand out, which is a
 * page-side problem and must never be read as the machine being full. The three
 * are cumulative so the page can difference them across a window.
 */
function accountGap(now: number) {
  if (awaitingBand) bandWaitMs += now - sliceEndedAt;
  else idleMs += now - sliceEndedAt;
  awaitingBand = false;
  sliceEndedAt = now;
}

function stopRetryWatchdog() {
  if (bandRetryTimer !== 0) {
    workerScope.clearTimeout(bandRetryTimer);
    bandRetryTimer = 0;
  }
}

function fail(error: unknown) {
  active = false;
  stopRetryWatchdog();
  post({ type: 'cpu-stress-error', requestId: activeRequestId, workerIndex,
    message: error instanceof Error ? error.message : 'CPU prime worker failed.' });
}

function schedule() {
  if (!active || taskPending) return;
  taskPending = true;
  chunkChannel.port2.postMessage(generation);
}

function requestBand() {
  if (supplyPending) return;
  supplyPending = true;
  supplyId += 1;
  post({ type: 'cpu-stress-work-request', requestId: activeRequestId, workerIndex, supplyId });
}

/** A band must be an odd-start, even-end interval that continues past every band seen. */
function validateBand(low: number, limit: number) {
  if (!Number.isSafeInteger(low) || !Number.isSafeInteger(limit) || low < 1 || limit <= low || low % 2 !== 1) {
    throw new Error('Invalid prime band bounds.');
  }
  if (activeRequestId !== 0 && bandLimit !== 0 && low <= bandLimit) {
    throw new Error('Prime band overlaps the band already owned.');
  }
}

function applyBand(low: number, limit: number) {
  bandLow = low;
  bandLimit = limit;
  bandSpan = limit - low;
  nextLow = 0;
  nextLimit = 0;
  stopRetryWatchdog();
}

function runChunk() {
  if (!active) return;
  // One clock reading starts the slice: it books the gap since the previous slice
  // ended and is the reference this slice's wall-clock budget is measured against.
  const sliceStart = performance.now();
  if (sliceEndedAt === 0) sliceEndedAt = sliceStart;
  else accountGap(sliceStart);
  const sliceDeadline = sliceStart + CPU_CHUNK_MS;
  let now = sliceStart;
  try {
    for (;;) {
      if (bandLow > bandLimit) {
        if (nextLow !== 0) {
          // The prefetched band already arrived: take it and keep computing.
          bandLow = nextLow;
          bandLimit = nextLimit;
          bandSpan = bandLimit - bandLow;
          nextLow = 0;
          nextLimit = 0;
          continue;
        }
        // Genuinely drained. Request (or keep the request outstanding), report,
        // and stop scheduling: an idle worker must not spin on the message port.
        requestBand();
        if (bandRetryTimer === 0) {
          bandRetryTimer = workerScope.setTimeout(() => {
            bandRetryTimer = 0;
            if (!active) return;
            supplyPending = false;
            requestBand();
            schedule();
          }, BAND_RETRY_MS);
        }
        now = performance.now();
        busyMs += now - sliceStart;
        // Whatever gap follows this return is the page being slow to supply work,
        // not the machine being out of processors.
        awaitingBand = true;
        sliceEndedAt = now;
        heartbeatIfDue();
        return;
      }
      const high = Math.min(bandLow + PRIME_SEGMENT_ODDS * 2 - 1, bandLimit);
      const result = sieve.sieve(bandLow, high);
      candidates += result.candidates;
      primesFound += result.primesFound;
      latestPrime = Math.max(latestPrime, result.latestPrime);
      checksum = (checksum + result.primesFound + result.latestPrime % 1_000_003) % 1_000_003;
      bandLow = high + 1;
      if (bandLimit - bandLow <= bandSpan * BAND_REFILL_REMAINING) requestBand();
      // The same reading that ends the slice judges it: no extra clock access in
      // the hot loop, and the overrun is measured against the slice's own budget.
      now = performance.now();
      if (now >= sliceDeadline) break;
    }
    // One more measured slice. A slice that overran its wall-clock budget by a
    // clear margin was descheduled in the middle of it. Measured on a
    // 16-core/32-thread host this is rare even at twice the thread count (0–1% of
    // slices at 64 workers), because a worker that yields every 8ms hands its
    // processor over voluntarily; the cost of oversubscription appears in `idleMs`
    // instead. So the overrun share is published as a diagnostic and is a second,
    // weaker reason to stop growing — never the primary one.
    slices += 1;
    if (now - sliceStart >= CPU_CHUNK_MS * CPU_SLICE_OVERRUN_FACTOR) slowSlices += 1;
    busyMs += now - sliceStart;
    // Without this mark the next slice's gap would be measured from the start of
    // this one, re-booking the slice's own compute time as waiting time — which
    // reads as a flat ~50% duty cycle no matter how loaded the machine is.
    sliceEndedAt = now;
    heartbeatIfDue();
    schedule();
  } catch (error) {
    fail(error);
  }
}

chunkChannel.port1.onmessage = (event: MessageEvent<number>) => {
  // A queued slice from an earlier run must not clear the current run's flag.
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
    workerIndex = request.workerIndex;
    active = true;
    taskPending = false;
    candidates = 0;
    busyMs = 0;
    idleMs = 0;
    bandWaitMs = 0;
    slices = 0;
    slowSlices = 0;
    sliceEndedAt = 0;
    awaitingBand = false;
    checksum = 0;
    latestPrime = 0;
    primesFound = 0;
    lastHeartbeat = 0;
    nextLow = 0;
    nextLimit = 0;
    supplyId = 0;
    supplyPending = false;
    bandLow = 0;
    bandLimit = 0;
    bandSpan = 0;
    sieve = new SegmentedPrimeSieve();
    try {
      validateBand(request.low, request.limit);
      applyBand(request.low, request.limit);
    } catch (error) {
      fail(error);
      return;
    }
    schedule();
    return;
  }
  if (request.type === 'continue-cpu-stress') {
    if (!active || request.requestId !== activeRequestId || request.workerIndex !== workerIndex) return;
    // Reject duplicate, stale and unsolicited supplies rather than double-owning
    // a range: two workers sieving the same integer would double-count primes.
    if (!supplyPending || request.supplyId !== supplyId) return;
    supplyPending = false;
    try {
      validateBand(request.low, request.limit);
    } catch (error) {
      fail(error);
      return;
    }
    if (bandLow > bandLimit) applyBand(request.low, request.limit);
    else {
      nextLow = request.low;
      nextLimit = request.limit;
    }
    schedule();
  }
};
