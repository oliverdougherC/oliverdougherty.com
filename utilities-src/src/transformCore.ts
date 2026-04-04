import { analyzeTransformImages, type TransformImageAnalysis } from './transformIntelligence';
import type { PreparedImageData, TransformComputationResult } from './types';

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

export function resolveOutputDimensions(width: number, height: number, maxDimension: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TransformError('Images must have valid dimensions.');
  }

  if (width <= maxDimension && height <= maxDimension) {
    return { width, height };
  }

  const scale = Math.min(maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

export function packRgbPixels(pixels: Uint8ClampedArray): Uint32Array {
  if (pixels.length % 4 !== 0) {
    throw new TransformError('Pixel data must be RGBA-aligned.');
  }

  const packed = new Uint32Array(pixels.length / 4);
  for (let offset = 0, index = 0; offset < pixels.length; offset += 4, index += 1) {
    packed[index] = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
  }
  return packed;
}

function bucketKey(rgb: number, shift: number) {
  const r = ((rgb >> 16) & 0xff) >> shift;
  const g = ((rgb >> 8) & 0xff) >> shift;
  const b = (rgb & 0xff) >> shift;
  return (r << 16) | (g << 8) | b;
}

function weightedDistance(left: number, right: number) {
  const lr = (left >> 16) & 0xff;
  const lg = (left >> 8) & 0xff;
  const lb = left & 0xff;
  const rr = (right >> 16) & 0xff;
  const rg = (right >> 8) & 0xff;
  const rb = right & 0xff;

  const rMean = (lr + rr) >> 1;
  const dr = lr - rr;
  const dg = lg - rg;
  const db = lb - rb;

  return (((512 + rMean) * dr * dr) >> 8) + 4 * dg * dg + (((767 - rMean) * db * db) >> 8);
}

function buildBucketMap(sourcePacked: Uint32Array, quantizationBits: number) {
  const shift = 8 - quantizationBits;
  const buckets = new Map<number, number[]>();

  for (let index = 0; index < sourcePacked.length; index += 1) {
    const key = bucketKey(sourcePacked[index], shift);
    const existing = buckets.get(key);
    if (existing) {
      existing.push(index);
    } else {
      buckets.set(key, [index]);
    }
  }

  return { buckets, shift, bucketCount: 1 << quantizationBits };
}

function forEachShellBucket(
  centerR: number,
  centerG: number,
  centerB: number,
  radius: number,
  bucketCount: number,
  callback: (key: number) => void
) {
  const rMin = Math.max(0, centerR - radius);
  const rMax = Math.min(bucketCount - 1, centerR + radius);
  const gMin = Math.max(0, centerG - radius);
  const gMax = Math.min(bucketCount - 1, centerG + radius);
  const bMin = Math.max(0, centerB - radius);
  const bMax = Math.min(bucketCount - 1, centerB + radius);

  for (let r = rMin; r <= rMax; r += 1) {
    for (let g = gMin; g <= gMax; g += 1) {
      for (let b = bMin; b <= bMax; b += 1) {
        const shellDistance = Math.max(Math.abs(r - centerR), Math.abs(g - centerG), Math.abs(b - centerB));
        if (shellDistance !== radius) {
          continue;
        }
        callback((r << 16) | (g << 8) | b);
      }
    }
  }
}

export function matchPackedPixels(
  sourcePacked: Uint32Array,
  targetPacked: Uint32Array,
  quantizationBits: number,
  hooks?: {
    onProgress?: (completed: number, total: number) => void;
    isCancelled?: () => boolean;
  },
  analysis?: TransformImageAnalysis
) {
  if (sourcePacked.length !== targetPacked.length) {
    throw new TransformError('Source and target images must have the same pixel count.');
  }

  if (quantizationBits < 4 || quantizationBits > 8) {
    throw new TransformError('Quantization bits must stay between 4 and 8.');
  }

  const { buckets, shift, bucketCount } = buildBucketMap(sourcePacked, quantizationBits);
  const assignment = new Uint32Array(targetPacked.length);
  const used = new Uint8Array(sourcePacked.length);
  const targetOrder = analysis
    ? Array.from({ length: targetPacked.length }, (_value, index) => index).sort((left, right) => {
        const delta = analysis.targetPriorityByIndex[right] - analysis.targetPriorityByIndex[left];
        return delta === 0 ? left - right : delta;
      })
    : null;

  for (let orderedIndex = 0; orderedIndex < targetPacked.length; orderedIndex += 1) {
    const targetIndex = targetOrder ? targetOrder[orderedIndex] : orderedIndex;
    if (hooks?.isCancelled?.()) {
      throw new TransformError('Transform cancelled.');
    }

    const targetRgb = targetPacked[targetIndex];
    const centerR = ((targetRgb >> 16) & 0xff) >> shift;
    const centerG = ((targetRgb >> 8) & 0xff) >> shift;
    const centerB = (targetRgb & 0xff) >> shift;

    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let radius = 0; radius < bucketCount && bestIndex === -1; radius += 1) {
      forEachShellBucket(centerR, centerG, centerB, radius, bucketCount, (key) => {
        const candidates = buckets.get(key);
        if (!candidates) {
          return;
        }

        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
          const sourceIndex = candidates[candidateIndex];
          if (used[sourceIndex]) {
            continue;
          }

          let distance = weightedDistance(sourcePacked[sourceIndex], targetRgb);
          if (analysis) {
            const donorUsefulness = analysis.sourceUsefulnessByIndex[sourceIndex];
            const donorNearWhite = analysis.sourceNearWhiteByIndex[sourceIndex];
            const targetNeed = analysis.targetNeedByIndex[targetIndex];
            const targetFlatBright = analysis.targetNearWhiteByIndex[targetIndex] * (1 - targetNeed);
            distance += (1 - donorUsefulness) * targetNeed * 50_000;
            distance += donorNearWhite * targetNeed * 34_000;
            distance += donorUsefulness * targetFlatBright * 14_000;
          }

          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = sourceIndex;
          }
        }
      });
    }

    if (bestIndex === -1) {
      bestIndex = used.findIndex((value) => value === 0);
      if (bestIndex === -1) {
        throw new TransformError('No unused pixels remained during matching.');
      }
    }

    used[bestIndex] = 1;
    assignment[targetIndex] = bestIndex;

    if (hooks?.onProgress && (orderedIndex + 1 === targetPacked.length || (orderedIndex + 1) % 256 === 0)) {
      hooks.onProgress(orderedIndex + 1, targetPacked.length);
    }
  }

  return assignment;
}

export function buildResultPixels(source: PreparedImageData, assignment: Uint32Array) {
  const result = new Uint8ClampedArray(source.pixels.length);
  for (let targetIndex = 0; targetIndex < assignment.length; targetIndex += 1) {
    const sourceOffset = assignment[targetIndex] * 4;
    const targetOffset = targetIndex * 4;
    result[targetOffset] = source.pixels[sourceOffset];
    result[targetOffset + 1] = source.pixels[sourceOffset + 1];
    result[targetOffset + 2] = source.pixels[sourceOffset + 2];
    result[targetOffset + 3] = 255;
  }
  return result;
}

export function transformPreparedImages(
  source: PreparedImageData,
  target: PreparedImageData,
  quantizationBits: number,
  hooks?: {
    onProgress?: (completed: number, total: number) => void;
    isCancelled?: () => boolean;
  }
): TransformComputationResult {
  if (source.width !== target.width || source.height !== target.height) {
    throw new TransformError('Source and target working dimensions must match.');
  }

  const sourcePacked = packRgbPixels(source.pixels);
  const targetPacked = packRgbPixels(target.pixels);
  const analysis = analyzeTransformImages(source, target, quantizationBits);
  const assignment = matchPackedPixels(sourcePacked, targetPacked, quantizationBits, hooks, analysis);

  return {
    source,
    target,
    assignment,
    pixelCount: assignment.length
  };
}
