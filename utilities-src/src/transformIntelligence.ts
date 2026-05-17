import type { PreparedImageData } from './types';

export interface TransformImageAnalysis {
  sourceUsefulnessByIndex: Float32Array;
  sourceNearWhiteByIndex: Float32Array;
  targetNeedByIndex: Float32Array;
  targetNearWhiteByIndex: Float32Array;
  targetPriorityByIndex: Float32Array;
}

import { clamp } from './math';

function quantizeColorKey(red: number, green: number, blue: number, shift: number) {
  return ((red >> shift) << 16) | ((green >> shift) << 8) | (blue >> shift);
}

function channelDistance(left: number, right: number) {
  return Math.abs(left - right) / 255;
}

function computeNearWhite(red: number, green: number, blue: number) {
  const brightness = (red + green + blue) / (255 * 3);
  const chroma = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
  return clamp(((brightness - 0.84) / 0.16) * (1 - chroma * 0.65), 0, 1);
}

function computeLocalContrast(pixels: Uint8ClampedArray, width: number, height: number) {
  const localContrastByIndex = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const offset = pixelIndex * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      let contrast = 0;
      let neighborCount = 0;

      if (x > 0) {
        const neighborOffset = offset - 4;
        contrast +=
          (channelDistance(red, pixels[neighborOffset]) +
            channelDistance(green, pixels[neighborOffset + 1]) +
            channelDistance(blue, pixels[neighborOffset + 2])) /
          3;
        neighborCount += 1;
      }

      if (x + 1 < width) {
        const neighborOffset = offset + 4;
        contrast +=
          (channelDistance(red, pixels[neighborOffset]) +
            channelDistance(green, pixels[neighborOffset + 1]) +
            channelDistance(blue, pixels[neighborOffset + 2])) /
          3;
        neighborCount += 1;
      }

      if (y > 0) {
        const neighborOffset = offset - width * 4;
        contrast +=
          (channelDistance(red, pixels[neighborOffset]) +
            channelDistance(green, pixels[neighborOffset + 1]) +
            channelDistance(blue, pixels[neighborOffset + 2])) /
          3;
        neighborCount += 1;
      }

      if (y + 1 < height) {
        const neighborOffset = offset + width * 4;
        contrast +=
          (channelDistance(red, pixels[neighborOffset]) +
            channelDistance(green, pixels[neighborOffset + 1]) +
            channelDistance(blue, pixels[neighborOffset + 2])) /
          3;
        neighborCount += 1;
      }

      localContrastByIndex[pixelIndex] = neighborCount > 0 ? contrast / neighborCount : 0;
    }
  }

  return localContrastByIndex;
}

function buildSourceBucketCounts(source: PreparedImageData, quantizationBits: number) {
  const shift = 8 - quantizationBits;
  const counts = new Map<number, number>();

  for (let pixelIndex = 0; pixelIndex < source.width * source.height; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const key = quantizeColorKey(
      source.pixels[offset],
      source.pixels[offset + 1],
      source.pixels[offset + 2],
      shift
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return { counts, shift };
}

export function weightedRgbDistance(left: number, right: number) {
  const leftRed = (left >> 16) & 0xff;
  const leftGreen = (left >> 8) & 0xff;
  const leftBlue = left & 0xff;
  const rightRed = (right >> 16) & 0xff;
  const rightGreen = (right >> 8) & 0xff;
  const rightBlue = right & 0xff;

  const redMean = (leftRed + rightRed) >> 1;
  const deltaRed = leftRed - rightRed;
  const deltaGreen = leftGreen - rightGreen;
  const deltaBlue = leftBlue - rightBlue;

  return (((512 + redMean) * deltaRed * deltaRed) >> 8) + 4 * deltaGreen * deltaGreen + (((767 - redMean) * deltaBlue * deltaBlue) >> 8);
}

export function analyzeTransformImages(
  source: PreparedImageData,
  target: PreparedImageData,
  quantizationBits: number
): TransformImageAnalysis {
  const sourceBucketCounts = buildSourceBucketCounts(source, quantizationBits);
  const sourceContrastByIndex = computeLocalContrast(source.pixels, source.width, source.height);
  const targetContrastByIndex = computeLocalContrast(target.pixels, target.width, target.height);
  const sourceUsefulnessByIndex = new Float32Array(source.width * source.height);
  const sourceNearWhiteByIndex = new Float32Array(source.width * source.height);
  const targetNeedByIndex = new Float32Array(target.width * target.height);
  const targetNearWhiteByIndex = new Float32Array(target.width * target.height);
  const targetPriorityByIndex = new Float32Array(target.width * target.height);

  for (let pixelIndex = 0; pixelIndex < sourceUsefulnessByIndex.length; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const red = source.pixels[offset];
    const green = source.pixels[offset + 1];
    const blue = source.pixels[offset + 2];
    const nearWhite = computeNearWhite(red, green, blue);
    const bucketKey = quantizeColorKey(red, green, blue, sourceBucketCounts.shift);
    const bucketFrequency = (sourceBucketCounts.counts.get(bucketKey) ?? 1) / sourceUsefulnessByIndex.length;
    const rarity = 1 - Math.sqrt(bucketFrequency);
    let usefulness = clamp(
      sourceContrastByIndex[pixelIndex] * 0.42 + rarity * 0.34 + (1 - nearWhite) * 0.24,
      0.02,
      1
    );

    if (nearWhite > 0.96 && sourceContrastByIndex[pixelIndex] < 0.05) {
      usefulness *= 0.12;
    } else if (nearWhite > 0.82) {
      usefulness *= 0.4;
    }

    sourceNearWhiteByIndex[pixelIndex] = nearWhite;
    sourceUsefulnessByIndex[pixelIndex] = clamp(usefulness, 0.02, 1);
  }

  for (let pixelIndex = 0; pixelIndex < targetNeedByIndex.length; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const red = target.pixels[offset];
    const green = target.pixels[offset + 1];
    const blue = target.pixels[offset + 2];
    const nearWhite = computeNearWhite(red, green, blue);
    let need = clamp((1 - nearWhite) * 0.28 + targetContrastByIndex[pixelIndex] * 0.72, 0, 1);

    if (nearWhite > 0.86 && targetContrastByIndex[pixelIndex] < 0.08) {
      need *= 0.18;
    }

    targetNearWhiteByIndex[pixelIndex] = nearWhite;
    targetNeedByIndex[pixelIndex] = need;
    targetPriorityByIndex[pixelIndex] = need * 0.82 + (1 - nearWhite) * 0.18;
  }

  return {
    sourceUsefulnessByIndex,
    sourceNearWhiteByIndex,
    targetNeedByIndex,
    targetNearWhiteByIndex,
    targetPriorityByIndex
  };
}
