import { analyzeTransformImages, weightedRgbDistance, type TransformImageAnalysis } from './transformIntelligence';
import { packRgbPixels } from './transformCore';
import type { PreparedImageData } from './types';

export interface TransformRenderPlan {
  finalPixels: Uint8ClampedArray;
  tintStrengthByTarget: Float32Array;
  cheatedTargetPixels: Uint8Array;
}

// CIE76-like weighted RGB scoring can exceed the Euclidean 255-channel range
// once donor quality penalties are mixed in. This denominator preserves useful
// tint contrast while keeping worst-case distances clamped.
const MAX_WEIGHTED_RGB_DISTANCE = 82_000;
const DISTANCE_TINT_WEIGHT = 0.48;
const DONOR_DEFICIT_TINT_WEIGHT = 0.78;
const WHITE_MISMATCH_TINT_WEIGHT = 0.72;
const EXACT_MATCH_TINT_MULTIPLIER = 0.12;
const CLOSE_MATCH_TINT_MULTIPLIER = 0.45;
const FLAT_BRIGHT_TINT_MULTIPLIER = 0.42;

import { clamp } from './math';

function mixChannel(sourceValue: number, targetValue: number, tintStrength: number) {
  return Math.round(sourceValue + (targetValue - sourceValue) * tintStrength);
}

export function buildTransformRenderPlan(
  source: PreparedImageData,
  target: PreparedImageData,
  assignment: Uint32Array,
  quantizationBits: number,
  analysis: TransformImageAnalysis = analyzeTransformImages(source, target, quantizationBits)
): TransformRenderPlan {
  const sourcePacked = packRgbPixels(source.pixels);
  const targetPacked = packRgbPixels(target.pixels);
  const finalPixels = new Uint8ClampedArray(target.pixels.length);
  const tintStrengthByTarget = new Float32Array(assignment.length);
  const cheatedTargetPixels = new Uint8Array(assignment.length);

  for (let targetIndex = 0; targetIndex < assignment.length; targetIndex += 1) {
    const sourceIndex = assignment[targetIndex];
    const sourceOffset = sourceIndex * 4;
    const targetOffset = targetIndex * 4;
    const sourceUsefulness = analysis.sourceUsefulnessByIndex[sourceIndex];
    const sourceNearWhite = analysis.sourceNearWhiteByIndex[sourceIndex];
    const targetNeed = analysis.targetNeedByIndex[targetIndex];
    const targetNearWhite = analysis.targetNearWhiteByIndex[targetIndex];
    const colorDistance = weightedRgbDistance(sourcePacked[sourceIndex], targetPacked[targetIndex]);
    const distanceNormalized = clamp(colorDistance / MAX_WEIGHTED_RGB_DISTANCE, 0, 1);
    const donorDeficit = 1 - sourceUsefulness;
    const whiteMismatch = sourceNearWhite * (1 - targetNearWhite);
    let tintStrength = clamp(
      distanceNormalized * DISTANCE_TINT_WEIGHT +
        donorDeficit * targetNeed * DONOR_DEFICIT_TINT_WEIGHT +
        whiteMismatch * WHITE_MISMATCH_TINT_WEIGHT,
      0,
      0.97
    );

    if (distanceNormalized < 0.025 && donorDeficit < 0.22) {
      tintStrength *= EXACT_MATCH_TINT_MULTIPLIER;
    } else if (distanceNormalized < 0.08 && sourceNearWhite < 0.28) {
      tintStrength *= CLOSE_MATCH_TINT_MULTIPLIER;
    }

    if (targetNearWhite > 0.82 && targetNeed < 0.18) {
      tintStrength *= FLAT_BRIGHT_TINT_MULTIPLIER;
    }

    tintStrengthByTarget[targetIndex] = tintStrength;
    cheatedTargetPixels[targetIndex] = tintStrength > 0.08 ? 1 : 0;
    finalPixels[targetOffset] = mixChannel(source.pixels[sourceOffset], target.pixels[targetOffset], tintStrength);
    finalPixels[targetOffset + 1] = mixChannel(
      source.pixels[sourceOffset + 1],
      target.pixels[targetOffset + 1],
      tintStrength
    );
    finalPixels[targetOffset + 2] = mixChannel(
      source.pixels[sourceOffset + 2],
      target.pixels[targetOffset + 2],
      tintStrength
    );
    finalPixels[targetOffset + 3] = 255;
  }

  return {
    finalPixels,
    tintStrengthByTarget,
    cheatedTargetPixels
  };
}
