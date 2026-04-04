export type TransformPresetId = 'fast' | 'balanced' | 'detailed';

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
}

export interface TransformComputationResult {
  source: PreparedImageData;
  target: PreparedImageData;
  assignment: Uint32Array;
  pixelCount: number;
}

export interface PreparedImageTransfer {
  width: number;
  height: number;
  pixels: ArrayBuffer;
  originalWidth: number;
  originalHeight: number;
  scaled: boolean;
}
