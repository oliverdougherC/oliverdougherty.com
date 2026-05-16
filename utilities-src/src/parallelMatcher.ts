import type { TransformImageAnalysis } from './transformIntelligence';
import {
  mergeRankedCandidatesIntoAssignment,
  type RankedCandidate,
  type TransformHooks
} from './transformCore';
import type { MatchingWorkerRequest, MatchingWorkerResponse } from './matchingWorkerTypes';

export const PARALLEL_MATCH_MIN_PIXELS = 160_000;
export const PARALLEL_MATCH_CANDIDATE_LIMIT = 8;
const PARALLEL_MATCH_MAX_WORKERS = 8;
const DEFAULT_RANKING_WORKER_TIMEOUT_MS = 30_000;
export const EXPERIMENTAL_PARALLEL_MATCHER_ENABLED = false;

export interface MatchingWorkerLike {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<MatchingWorkerResponse>) => void,
    options?: AddEventListenerOptions | boolean
  ): void;
  removeEventListener?: (
    type: 'message',
    listener: (event: MessageEvent<MatchingWorkerResponse>) => void,
    options?: EventListenerOptions | boolean
  ) => void;
  postMessage(message: MatchingWorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface ParallelMatchProgressHooks extends TransformHooks {
  onShortlistProgress?: (completed: number, total: number, workerCount: number) => void;
  onMergeProgress?: (completed: number, total: number, workerCount: number) => void;
}

export interface ParallelMatchRequest {
  sourcePacked: Uint32Array;
  targetPacked: Uint32Array;
  quantizationBits: number;
  targetOrder: Uint32Array;
  analysis: TransformImageAnalysis;
  createWorker: () => MatchingWorkerLike;
  workerCount: number;
  workerTimeoutMs?: number;
  hooks?: ParallelMatchProgressHooks;
}

export function resolveParallelWorkerCount(hardwareConcurrency: number) {
  if (!Number.isFinite(hardwareConcurrency)) {
    return 1;
  }

  return Math.max(1, Math.min(PARALLEL_MATCH_MAX_WORKERS, Math.floor(hardwareConcurrency) - 1));
}

export function shouldUseParallelMatching(options: {
  allowExperimental?: boolean;
  pixelCount: number;
  hardwareConcurrency: number;
  supportsNestedWorkers: boolean;
}) {
  return (
    Boolean(options.allowExperimental) &&
    EXPERIMENTAL_PARALLEL_MATCHER_ENABLED &&
    options.supportsNestedWorkers &&
    options.pixelCount >= PARALLEL_MATCH_MIN_PIXELS &&
    resolveParallelWorkerCount(options.hardwareConcurrency) >= 4
  );
}

function splitTargetOrderIntoChunks(targetOrder: Uint32Array, workerCount: number) {
  const chunkCount = Math.min(workerCount, targetOrder.length);
  const chunks: Uint32Array[] = [];
  let start = 0;

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const remainingTargets = targetOrder.length - start;
    const remainingChunks = chunkCount - chunkIndex;
    const chunkSize = Math.ceil(remainingTargets / remainingChunks);
    chunks.push(targetOrder.slice(start, start + chunkSize));
    start += chunkSize;
  }

  return chunks;
}

function runRankingWorker(
  createWorker: () => MatchingWorkerLike,
  request: MatchingWorkerRequest,
  timeoutMs = DEFAULT_RANKING_WORKER_TIMEOUT_MS
) {
  return new Promise<MatchingWorkerResponse>((resolve, reject) => {
    const worker = createWorker();
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      worker.removeEventListener?.('message', handleMessage);
      worker.terminate();
      reject(new Error('Matching worker timed out.'));
    }, timeoutMs);
    const handleMessage = (event: MessageEvent<MatchingWorkerResponse>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      worker.removeEventListener?.('message', handleMessage);
      worker.terminate();
      resolve(event.data);
    };

    try {
      worker.addEventListener('message', handleMessage, { once: true });
      worker.postMessage(request);
    } catch (error) {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
      }
      worker.removeEventListener?.('message', handleMessage);
      worker.terminate();
      reject(error);
    }
  });
}

export async function matchPackedPixelsInParallel(request: ParallelMatchRequest) {
  const workerCount = Math.min(request.workerCount, request.targetOrder.length);
  const targetChunks = splitTargetOrderIntoChunks(request.targetOrder, workerCount);
  const rankedCandidatesByTarget: Array<RankedCandidate[] | undefined> = new Array(
    request.targetPacked.length
  );

  let completedShortlists = 0;
  const shortlistResponses = await Promise.all(
    targetChunks.map(async (targetIndices) => {
      if (request.hooks?.isCancelled?.()) {
        throw new Error('Transform cancelled.');
      }

      const response = await runRankingWorker(
        request.createWorker,
        {
          type: 'rank',
          sourcePacked: request.sourcePacked,
          targetPacked: request.targetPacked,
          quantizationBits: request.quantizationBits,
          targetIndices,
          limit: PARALLEL_MATCH_CANDIDATE_LIMIT,
          analysis: request.analysis
        },
        request.workerTimeoutMs
      );

      if (response.type === 'error') {
        throw new Error(response.message);
      }

      completedShortlists += targetIndices.length;
      request.hooks?.onShortlistProgress?.(
        completedShortlists,
        request.targetOrder.length,
        workerCount
      );

      return response;
    })
  );

  for (let responseIndex = 0; responseIndex < shortlistResponses.length; responseIndex += 1) {
    const response = shortlistResponses[responseIndex];

    for (let targetOffset = 0; targetOffset < response.targetIndices.length; targetOffset += 1) {
      const targetIndex = response.targetIndices[targetOffset];
      const candidateCount = response.candidateCounts[targetOffset];
      const rankedCandidates: RankedCandidate[] = [];

      for (let candidateOffset = 0; candidateOffset < candidateCount; candidateOffset += 1) {
        const resultOffset = targetOffset * PARALLEL_MATCH_CANDIDATE_LIMIT + candidateOffset;
        const sourceIndex = response.candidateIndices[resultOffset];
        if (sourceIndex < 0) {
          continue;
        }
        rankedCandidates.push({
          sourceIndex,
          distance: response.candidateScores[resultOffset]
        });
      }

      rankedCandidatesByTarget[targetIndex] = rankedCandidates;
    }
  }

  const merged = mergeRankedCandidatesIntoAssignment(
    {
      sourceLength: request.sourcePacked.length,
      targetLength: request.targetPacked.length
    },
    request.targetOrder,
    rankedCandidatesByTarget,
    {
      isCancelled: request.hooks?.isCancelled,
      onProgress: (completed, total) => {
        request.hooks?.onMergeProgress?.(completed, total, workerCount);
      }
    }
  );

  return {
    assignment: merged.assignment,
    matcherStats: merged.matcherStats,
    workerCount
  };
}
