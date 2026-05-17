import { type TransformPreset, type TransformPresetId } from './types';

export const TRANSFORM_PRESETS = {
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
} as const satisfies Record<TransformPresetId, TransformPreset>;

export function getPreset(presetId: TransformPresetId): TransformPreset {
  return TRANSFORM_PRESETS[presetId];
}

export const VALID_PRESET_IDS = Object.keys(TRANSFORM_PRESETS) as TransformPresetId[];
