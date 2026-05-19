import type { TransformImageAnalysis } from './transformIntelligence';

export type TransformPresetId = 'fast' | 'balanced' | 'detailed';
export type TransformMatcherStrategy = 'single-optimized' | 'parallel-experimental';

export interface TransformPreset {
  id: TransformPresetId;
  label: string;
  maxDimension: number;
  quantizationBits: number;
  animationDurationMs: number;
  animationParticleBudget: number;
}

export interface PreparedImageData {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

export interface TransformStageTimingsMs {
  decode: number;
  analyze: number;
  rank: number;
  assign: number;
  total: number;
}

export interface TransformMatcherStats {
  fallbackCount: number;
  shortlistHitRate: number;
  shortlistHitCount: number;
  shortlistRequestCount: number;
  evaluatedCandidateCount: number;
  evaluatedGroupCount: number;
  averageGroupsPerTarget: number;
}

export interface TransformMetadata {
  presetId: TransformPresetId;
  quantizationBits: number;
  outputWidth: number;
  outputHeight: number;
  pixelCount: number;
  sourceOriginalWidth: number;
  sourceOriginalHeight: number;
  targetOriginalWidth: number;
  targetOriginalHeight: number;
  sourceScaled: boolean;
  targetScaled: boolean;
  processingMs: number;
  timingsMs: TransformStageTimingsMs;
  matcherStrategy: TransformMatcherStrategy;
  fallbackCount: number;
  shortlistHitRate: number;
  evaluatedCandidateCount: number;
  evaluatedGroupCount: number;
  averageGroupsPerTarget: number;
  workerCount: number;
}

export interface TransformComputationResult {
  source: PreparedImageData;
  target: PreparedImageData;
  assignment: Uint32Array;
  analysis: TransformImageAnalysis;
  pixelCount: number;
  timingsMs: TransformStageTimingsMs;
  matcherStrategy: TransformMatcherStrategy;
  matcherStats: TransformMatcherStats;
  workerCount: number;
}

export interface PreparedImageTransfer {
  width: number;
  height: number;
  // Workers transfer prepared pixel buffers, so this intentionally excludes
  // SharedArrayBuffer and other ArrayBufferLike values.
  pixels: ArrayBuffer;
  originalWidth: number;
  originalHeight: number;
  scaled: boolean;
}
