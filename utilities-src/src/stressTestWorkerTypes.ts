/**
 * CPU worker protocol.
 *
 * A worker owns a band of the number line and sieves it without asking. The main
 * thread therefore never sits in the compute path: it starts a worker, receives
 * throttled heartbeats, and hands out the next band when the worker's own
 * prefetch threshold says it is running low. Stopping is `Worker.terminate()` —
 * a busy worker never has to acknowledge anything.
 */

/** Seeds a worker with the inclusive integer band it owns for this run. */
export interface StartCpuStressRequest {
  type: 'start-cpu-stress';
  requestId: number;
  workerIndex: number;
  low: number;
  limit: number;
}

/** Answers a worker's own prefetch with the next contiguous band. */
export interface ContinueCpuStressRequest {
  type: 'continue-cpu-stress';
  requestId: number;
  workerIndex: number;
  supplyId: number;
  low: number;
  limit: number;
}

export type StressTestWorkerRequest = StartCpuStressRequest | ContinueCpuStressRequest;

export interface CpuStressHeartbeatResponse {
  type: 'cpu-stress-heartbeat';
  requestId: number;
  workerIndex: number;
  /** Cumulative odd candidates this worker has sieved. */
  candidates: number;
  checksum: number;
  /** Largest prime this worker has actually found in its own bands. */
  latestPrime: number;
  primesFound: number;
  /**
   * The worker's search cursor: the lowest integer in its band that it has not
   * sieved yet (past the band end once it is waiting for the next one). Purely
   * for activity diagnostics — it shows which neighbourhood each worker owns.
   */
  rangeLow: number;
  /**
   * Cumulative milliseconds this worker has spent inside a compute slice, and
   * cumulative milliseconds it spent *between* slices. Candidate counts alone
   * cannot tell a saturated machine from a starved pool: both look like "workers
   * are slow". A worker that keeps getting a processor returns to its next slice
   * within microseconds, so `busyMs / (busyMs + idleMs)` near 1 means the pool is
   * still finding free logical processors, and a falling ratio means workers have
   * started queueing for one. See the controller's `data-stress-cpu-busy`.
   */
  busyMs: number;
  idleMs: number;
  /**
   * Cumulative milliseconds spent waiting for the page to hand over a band. Kept
   * apart from `idleMs` on purpose: a pool that cannot get work is a page-side
   * problem, and it must never be read as the machine being full.
   */
  bandWaitMs: number;
  /**
   * Cumulative compute slices completed, and how many of them overran their
   * wall-clock budget by `CPU_SLICE_OVERRUN_FACTOR` — a thread taken away
   * mid-slice. Workers that yield every slice hand their processor over
   * voluntarily, so this stays near zero even at twice the thread count; it is a
   * diagnostic and a secondary stop signal, not the primary measurement.
   */
  slices: number;
  slowSlices: number;
}

/** Worker prefetch: it is running low and needs the band after its current one. */
export interface CpuStressWorkRequestResponse {
  type: 'cpu-stress-work-request';
  requestId: number;
  workerIndex: number;
  supplyId: number;
}

export interface CpuStressErrorResponse {
  type: 'cpu-stress-error';
  requestId: number;
  workerIndex: number;
  message: string;
}

export type StressTestWorkerResponse = CpuStressHeartbeatResponse | CpuStressWorkRequestResponse
  | CpuStressErrorResponse;
