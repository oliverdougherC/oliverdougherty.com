/**
 * CPU worker protocol.
 *
 * A worker is told its index and the pool size, and from those two numbers it owns a
 * lane of the number line and derives every block it will ever sieve. The main thread
 * therefore has no part in the compute path at all: it sizes the pool, starts it,
 * receives throttled progress, and terminates the workers. There is no range request,
 * no refill, and no stop acknowledgement, because a busy worker never has to answer
 * anything for any of that to work.
 */

/**
 * Posted by the worker script as soon as it loads, before it is started and before it
 * computes anything. It is how the page reads `navigator.hardwareConcurrency` in the
 * scope the workload will actually run in — see planCpuPool — and it is also the
 * signal that the worker script loaded at all.
 */
export interface CpuStressReadyResponse {
  type: 'cpu-stress-ready';
  hardwareConcurrency: number | null;
}

/**
 * The only message a worker is ever sent. `workerIndex` and `poolSize` are the whole
 * work assignment: worker `i` of `N` sieves blocks `i`, `i + N`, `i + 2N`, … of the
 * tiled number line, so lanes are disjoint by construction and the pool needs no
 * allocator, reservation, or coverage bookkeeping.
 */
export interface StartCpuStressRequest {
  type: 'start-cpu-stress';
  requestId: number;
  workerIndex: number;
  poolSize: number;
}

export type StressTestWorkerRequest = StartCpuStressRequest;

/** Throttled progress from a running worker. Cumulative, so the page only differences. */
export interface CpuStressProgressResponse {
  type: 'cpu-stress-progress';
  requestId: number;
  workerIndex: number;
  /** Cumulative odd candidates this worker has sieved. */
  candidates: number;
  checksum: number;
  /** Largest prime this worker has actually found. */
  latestPrime: number;
  primesFound: number;
  /** The worker's search cursor: the lowest integer in its lane it has not sieved yet. */
  rangeLow: number;
  /** Blocks this worker has taken from its lane, so a stalled lane is one number. */
  blocks: number;
}

export interface CpuStressErrorResponse {
  type: 'cpu-stress-error';
  requestId: number;
  workerIndex: number;
  message: string;
}

export type StressTestWorkerResponse = CpuStressReadyResponse | CpuStressProgressResponse | CpuStressErrorResponse;
