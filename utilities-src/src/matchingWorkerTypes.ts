import type { TransformImageAnalysis } from './transformIntelligence';

export interface MatchingWorkerRequest {
  type: 'rank';
  sourcePacked: Uint32Array;
  targetPacked: Uint32Array;
  quantizationBits: number;
  targetIndices: Uint32Array;
  limit: number;
  analysis: TransformImageAnalysis;
}

export interface MatchingWorkerSuccessResponse {
  type: 'ranked';
  targetIndices: Uint32Array;
  candidateIndices: Int32Array;
  candidateScores: Float32Array;
  candidateCounts: Uint8Array;
}

export interface MatchingWorkerErrorResponse {
  type: 'error';
  message: string;
}

export type MatchingWorkerResponse = MatchingWorkerSuccessResponse | MatchingWorkerErrorResponse;
