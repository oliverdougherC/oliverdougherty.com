import type { TransformPreset, TransformPresetId } from './types';

export const TRANSFORM_PRESETS: Record<TransformPresetId, TransformPreset> = {
  fast: {
    id: 'fast',
    label: 'Fast',
    maxDimension: 256,
    quantizationBits: 4,
    animationDurationMs: 2400,
    animationParticleBudget: 1100
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    maxDimension: 384,
    quantizationBits: 5,
    animationDurationMs: 3200,
    animationParticleBudget: 1800
  },
  detailed: {
    id: 'detailed',
    label: 'Detailed',
    maxDimension: 512,
    quantizationBits: 6,
    animationDurationMs: 4000,
    animationParticleBudget: 2600
  }
};

export function getPreset(presetId: TransformPresetId): TransformPreset {
  return TRANSFORM_PRESETS[presetId];
}
