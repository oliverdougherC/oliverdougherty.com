import type { StressTestWorkerRequest, StressTestWorkerResponse } from './stressTestWorkerTypes';
import { PRIME_SEGMENT_ODDS, SegmentedPrimeSieve } from './stressTestPrimes';
import { primeWorkerRange } from './stressTestPrimeRanges';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Progress is the only traffic a running worker produces. The page throttles its own
 * display regardless, so this is deliberately sparse: at 250ms a 32-worker pool posts
 * about 128 small messages a second, which is what keeps the main thread light enough
 * to paint and to accept Stop without the workload having to slow down for it.
 */
const PROGRESS_INTERVAL_MS = 250;

let sieve = new SegmentedPrimeSieve();
let activeRequestId = 0;
let workerIndex = 0;
let poolSize = 0;
/**
 * Blocks this worker has taken from its lane. Worker `i` of `N` sieves block
 * `i + k·N`, so lanes never overlap and the worker never has to ask for work: its
 * next integers are a multiplication away. That is the whole reason the compute path
 * has no message traffic in it.
 */
let blocksTaken = 0;
let cursor = 0;
// No block in hand until the compute loop takes one, which is what makes its first
// iteration take lane block 0 instead of sieving an empty range.
let blockLimit = -1;
let candidates = 0;
let primesFound = 0;
let latestPrime = 0;
let checksum = 0;

function post(message: StressTestWorkerResponse) { workerScope.postMessage(message); }

function report() {
  post({ type: 'cpu-stress-progress', requestId: activeRequestId, workerIndex,
    candidates, checksum: checksum / 1_000_003, latestPrime, primesFound,
    rangeLow: cursor, blocks: blocksTaken });
}

function fail(error: unknown) {
  post({ type: 'cpu-stress-error', requestId: activeRequestId, workerIndex,
    message: error instanceof Error ? error.message : 'CPU prime worker failed.' });
}

/**
 * The compute loop: continuous until the worker is terminated, with no yield, no
 * timer, no sleep, and no dependency on the page. Nothing here waits on the main
 * thread, because nothing here needs anything from it — the integers come from the
 * worker's own lane arithmetic and Stop is `Worker.terminate()`, which a busy worker
 * never has to agree to. The only outgoing traffic is the throttled progress report,
 * which is a `postMessage` and does not require a reply.
 *
 * It runs segments of a fixed size out of one reused buffer, so a run that goes for
 * hours allocates nothing per candidate. It ends by throwing when the number line
 * runs out of safe integers, which the page reports as a failed worker rather than
 * wrapping around over already-searched integers.
 */
function compute() {
  let lastReport = performance.now();
  for (;;) {
    // `cursor > blockLimit` means "no integers left in hand", which is also how the
    // state looks before the first block is taken: cursor starts one past the first
    // integer to sieve, block limit starts below it.
    if (cursor > blockLimit) {
      const block = primeWorkerRange(workerIndex + blocksTaken * poolSize);
      cursor = block.low;
      blockLimit = block.limit;
      blocksTaken += 1;
    }
    const high = Math.min(cursor + PRIME_SEGMENT_ODDS * 2 - 1, blockLimit);
    const result = sieve.sieve(cursor, high);
    candidates += result.candidates;
    primesFound += result.primesFound;
    if (result.latestPrime > latestPrime) latestPrime = result.latestPrime;
    checksum = (checksum + result.primesFound + result.latestPrime % 1_000_003) % 1_000_003;
    cursor = high + 1;
    const now = performance.now();
    if (now - lastReport >= PROGRESS_INTERVAL_MS) {
      report();
      lastReport = now;
    }
  }
}

/**
 * Announces the worker's own view of the machine before it does anything else. This
 * is the one thing the page cannot read from the window: fingerprint protection in
 * the browser under test replaces `navigator.hardwareConcurrency` in page scope (it
 * reported 12, 14 and 16 on launch-to-launch of a 32-thread host) while a worker
 * created by that same page reports the machine's real count — see planCpuPool in
 * stressTestCore.ts and scripts/stress-report-trace.js.
 */
post({ type: 'cpu-stress-ready',
  hardwareConcurrency: typeof navigator?.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null });

workerScope.onmessage = (event: MessageEvent<StressTestWorkerRequest>) => {
  const request = event.data;
  if (request.type !== 'start-cpu-stress') return;
  // One worker serves one run: a later Start gets freshly created workers, and the
  // generation check only exists so a queued message cannot restart this one.
  if (request.requestId <= activeRequestId) return;
  if (!Number.isSafeInteger(request.workerIndex) || request.workerIndex < 0
    || !Number.isSafeInteger(request.poolSize) || request.poolSize <= request.workerIndex) {
    // Answered against the ids the page sent, before this run is accepted: a
    // rejected assignment must be attributable to the start that asked for it.
    post({ type: 'cpu-stress-error', requestId: request.requestId, workerIndex: request.workerIndex,
      message: 'Invalid CPU worker assignment.' });
    return;
  }
  activeRequestId = request.requestId;
  workerIndex = request.workerIndex;
  poolSize = request.poolSize;
  blocksTaken = 0;
  cursor = 0;
  blockLimit = -1;
  candidates = 0;
  primesFound = 0;
  latestPrime = 0;
  checksum = 0;
  sieve = new SegmentedPrimeSieve();
  // Never returns in normal operation: the loop ends when the page terminates this
  // worker, or by throwing, which is reported instead of dying silently.
  try {
    compute();
  } catch (error) {
    fail(error);
  }
};
