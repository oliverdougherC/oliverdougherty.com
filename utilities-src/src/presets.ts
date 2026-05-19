import { type TransformPreset, type TransformPresetId } from './types';

const FAST_PRESET: TransformPreset = {
  id: 'fast',
  label: 'Fast',
  maxDimension: 256,
  quantizationBits: 4,
  animationDurationMs: 2400,
  animationParticleBudget: 1100
};
const BALANCED_PRESET: TransformPreset = {
  id: 'balanced',
  label: 'Balanced',
  maxDimension: 384,
  quantizationBits: 5,
  animationDurationMs: 3200,
  animationParticleBudget: 1800
};
const DETAILED_PRESET: TransformPreset = {
  id: 'detailed',
  label: 'Detailed',
  maxDimension: 512,
  quantizationBits: 6,
  animationDurationMs: 4000,
  animationParticleBudget: 2600
};

export const TRANSFORM_PRESETS = {
  fast: FAST_PRESET,
  balanced: BALANCED_PRESET,
  detailed: DETAILED_PRESET
} as const satisfies Record<TransformPresetId, TransformPreset>;

export function getPreset(presetId: TransformPresetId): TransformPreset {
  return TRANSFORM_PRESETS[presetId];
}

export const VALID_PRESET_IDS = Object.keys(TRANSFORM_PRESETS) as TransformPresetId[];

export function isTransformPresetId(value: string): value is TransformPresetId {
  return VALID_PRESET_IDS.includes(value as TransformPresetId);
}
