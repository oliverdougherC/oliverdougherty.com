import { collectRankedCandidatesForTarget, createMatchingSearchContext } from './transformCore';
import type { MatchingWorkerRequest, MatchingWorkerSuccessResponse } from './matchingWorkerTypes';

export function buildRankedCandidateResponse(
  request: MatchingWorkerRequest
): MatchingWorkerSuccessResponse {
  const targetIndices = request.targetIndices.slice();
  const candidateIndices = new Int32Array(targetIndices.length * request.limit);
  const candidateScores = new Float32Array(targetIndices.length * request.limit);
  const candidateCounts = new Uint8Array(targetIndices.length);
  candidateIndices.fill(-1);

  const context = createMatchingSearchContext(
    request.sourcePacked,
    request.targetPacked,
    request.quantizationBits,
    request.analysis
  );

  for (let targetOffset = 0; targetOffset < targetIndices.length; targetOffset += 1) {
    const targetIndex = targetIndices[targetOffset];
    const rankedCandidates = collectRankedCandidatesForTarget(context, targetIndex, request.limit);
    candidateCounts[targetOffset] = rankedCandidates.length;

    for (let candidateOffset = 0; candidateOffset < rankedCandidates.length; candidateOffset += 1) {
      const resultOffset = targetOffset * request.limit + candidateOffset;
      candidateIndices[resultOffset] = rankedCandidates[candidateOffset].sourceIndex;
      candidateScores[resultOffset] = rankedCandidates[candidateOffset].distance;
    }
  }

  return {
    type: 'ranked',
    targetIndices,
    candidateIndices,
    candidateScores,
    candidateCounts
  };
}
