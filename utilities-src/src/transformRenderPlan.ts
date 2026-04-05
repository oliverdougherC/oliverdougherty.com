import { analyzeTransformImages, weightedRgbDistance } from './transformIntelligence';
import { packRgbPixels } from './transformCore';
import type { PreparedImageData } from './types';

export interface TransformRenderPlan {
  finalPixels: Uint8ClampedArray;
  tintStrengthByTarget: Float32Array;
  cheatedTargetPixels: Uint8Array;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function mixChannel(sourceValue: number, targetValue: number, tintStrength: number) {
  return Math.round(sourceValue + (targetValue - sourceValue) * tintStrength);
}

export function buildTransformRenderPlan(
  source: PreparedImageData,
  target: PreparedImageData,
  assignment: Uint32Array,
  quantizationBits: number
): TransformRenderPlan {
  const analysis = analyzeTransformImages(source, target, quantizationBits);
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
    const distanceNormalized = clamp(colorDistance / 82_000, 0, 1);
    const donorDeficit = 1 - sourceUsefulness;
    const whiteMismatch = sourceNearWhite * (1 - targetNearWhite);
    let tintStrength = clamp(
      distanceNormalized * 0.48 + donorDeficit * targetNeed * 0.78 + whiteMismatch * 0.72,
      0,
      0.97
    );

    if (distanceNormalized < 0.025 && donorDeficit < 0.22) {
      tintStrength *= 0.12;
    } else if (distanceNormalized < 0.08 && sourceNearWhite < 0.28) {
      tintStrength *= 0.45;
    }

    if (targetNearWhite > 0.82 && targetNeed < 0.18) {
      tintStrength *= 0.42;
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
