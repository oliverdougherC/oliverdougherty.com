/// <reference lib="webworker" />

import { buildRankedCandidateResponse } from './matchingWorkerLogic';
import type { MatchingWorkerRequest, MatchingWorkerResponse } from './matchingWorkerTypes';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<MatchingWorkerRequest>) => {
  try {
    const response = buildRankedCandidateResponse(event.data);
    workerScope.postMessage(response, [
      response.targetIndices.buffer,
      response.candidateIndices.buffer,
      response.candidateScores.buffer,
      response.candidateCounts.buffer
    ]);
  } catch (error) {
    const response: MatchingWorkerResponse = {
      type: 'error',
      message: error instanceof Error ? error.message : 'Unable to rank transform candidates.'
    };
    workerScope.postMessage(response);
  }
};
