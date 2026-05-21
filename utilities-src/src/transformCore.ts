import {
  analyzeTransformImages,
  weightedRgbDistance,
  weightedRgbDistanceFromChannels,
  type TransformImageAnalysis
} from './transformIntelligence';
import type {
  PreparedImageData,
  TransformComputationResult,
  TransformMatcherStats,
  TransformStageTimingsMs
} from './types';

export class TransformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransformError';
  }
}

export class TransformDimensionMismatchError extends TransformError {
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;

  constructor(source: PreparedImageData, target: PreparedImageData) {
    super(
      `Source and target working dimensions must match. Source is ${source.width}x${source.height}; target is ${target.width}x${target.height}.`
    );
    this.name = 'TransformDimensionMismatchError';
    this.sourceWidth = source.width;
    this.sourceHeight = source.height;
    this.targetWidth = target.width;
    this.targetHeight = target.height;
  }
}

export interface TransformHooks {
  onProgress?: (completed: number, total: number) => void;
  onStageProgress?: (
    stage: 'analyzing' | 'ranking' | 'assigning',
    progress: number,
    message: string
  ) => void;
  isCancelled?: () => boolean;
}

export interface BucketState {
  sourcePacked: Uint32Array;
  targetPacked: Uint32Array;
  bucketEntryIndexByKey: Map<number, number>;
  bucketKeys: Uint32Array;
  bucketRed: Uint8Array;
  bucketGreen: Uint8Array;
  bucketBlue: Uint8Array;
  bucketFirstSourceByBucket: Int32Array;
  bucketNextSourceBySource: Int32Array;
  bucketFirstGroupByBucket: Int32Array;
  bucketNextGroupByGroup: Int32Array;
  bucketGroupOffsetByBucket: Int32Array;
  bucketGroupCountByBucket: Int32Array;
  bucketGroupIndices: Int32Array;
  bucketRemainingGroupCount: Int32Array;
  shift: number;
  bucketCount: number;
}

export interface GroupState {
  groupRgbValues: Uint32Array;
  groupRed: Uint8Array;
  groupGreen: Uint8Array;
  groupBlue: Uint8Array;
  groupNearWhiteByGroup: Float32Array;
  groupMinDonorByGroup: Int32Array;
  groupMaxDonorByGroup: Int32Array;
  groupRemainingCount: Int32Array;
  donorGroupBySource: Int32Array;
  donorBucketEntryBySource: Int32Array;
  donorNextByUsefulness: Int32Array;
  donorPrevByUsefulness: Int32Array;
  usefulnessBySource: Float32Array;
}

export interface TargetState {
  targetRed: Uint8Array;
  targetGreen: Uint8Array;
  targetBlue: Uint8Array;
  targetBucketRed: Uint8Array;
  targetBucketGreen: Uint8Array;
  targetBucketBlue: Uint8Array;
  targetBucketKeyByIndex: Int32Array;
  targetUsefulnessCoefficient: Float32Array;
  targetNearWhiteCoefficient: Float32Array;
  targetPreferMaxUsefulness: Uint8Array;
  bucketSearchOrderByTargetBucketKey: Map<number, BucketSearchOrder>;
}

export interface MatchingSearchContext extends BucketState, GroupState, TargetState {
  analysis?: TransformImageAnalysis;
}

export interface RankedCandidate {
  sourceIndex: number;
  distance: number;
}

export interface TargetSearchState {
  nextRadius: number;
  rankedCandidates: RankedCandidate[];
  initialCandidateCount: number;
}

interface FreeListState {
  head: number;
  nextFree: Int32Array;
  prevFree: Int32Array;
}

interface BucketSearchOrder {
  bucketIndices: Int32Array;
  shellDistances: Uint8Array;
}

interface PackedMatchComputation {
  assignment: Uint32Array;
  matcherStats: TransformMatcherStats;
  assignMs: number;
}

const PROGRESS_REPORT_INTERVAL = 256;
const SCORE_USEFULNESS_NEED = 50_000;
const SCORE_NEAR_WHITE_NEED = 34_000;
const SCORE_USEFULNESS_FLAT_BRIGHT = 14_000;
const OCCUPIED_BUCKET_SCAN_MIN_PIXELS = 4_096;
const INSERTION_SORT_DONOR_LIMIT = 32;

function nowMs() {
  return performance.now();
}

export interface ResolvedDimensions {
  width: number;
  height: number;
}

export function resolveOutputDimensions(width: number, height: number, maxDimension: number): ResolvedDimensions {
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

export function packRgbPixels(pixels: Uint8ClampedArray) {
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
  const red = ((rgb >> 16) & 0xff) >> shift;
  const green = ((rgb >> 8) & 0xff) >> shift;
  const blue = (rgb & 0xff) >> shift;
  return (red << 16) | (green << 8) | blue;
}

interface SourceDonorIndex {
  shift: number;
  bucketCount: number;
  bucketEntryIndexByKey: Map<number, number>;
  bucketKeys: Uint32Array;
  bucketFirstSourceByBucket: Int32Array;
  bucketNextSourceBySource: Int32Array;
  bucketFirstGroupByBucket: Int32Array;
  bucketNextGroupByGroup: Int32Array;
  bucketGroupOffsetByBucket: Int32Array;
  bucketGroupCountByBucket: Int32Array;
  bucketGroupIndices: Int32Array;
  bucketRemainingGroupCount: Int32Array;
  groupRgbValues: Uint32Array;
  groupNearWhiteByGroup: Float32Array;
  groupMinDonorByGroup: Int32Array;
  groupMaxDonorByGroup: Int32Array;
  groupRemainingCount: Int32Array;
  donorGroupBySource: Int32Array;
  donorBucketEntryBySource: Int32Array;
  donorNextByUsefulness: Int32Array;
  donorPrevByUsefulness: Int32Array;
  usefulnessBySource: Float32Array;
}

function buildSourceDonorIndex(
  sourcePacked: Uint32Array,
  quantizationBits: number,
  analysis?: TransformImageAnalysis
): SourceDonorIndex {
  const shift = 8 - quantizationBits;
  const bucketCount = 1 << quantizationBits;
  const bucketEntryIndexByKey = new Map<number, number>();
  const bucketKeys: number[] = [];
  const bucketFirstSourceByBucket: number[] = [];
  const bucketLastSourceByBucket: number[] = [];
  const bucketFirstGroupByBucket: number[] = [];
  const bucketLastGroupByBucket: number[] = [];
  const bucketRemainingGroupCount: number[] = [];
  const bucketNextSourceBySource = new Int32Array(sourcePacked.length);
  const bucketNextGroupByGroup: number[] = [];
  const groupIndexByRgb = new Map<number, number>();
  const groupRgbValues: number[] = [];
  const groupFirstDonorByGroup: number[] = [];
  const groupLastDonorByGroup: number[] = [];
  const groupBucketEntryByGroup: number[] = [];
  const groupRemainingCountValues: number[] = [];
  const donorGroupBySource = new Int32Array(sourcePacked.length);
  const donorBucketEntryBySource = new Int32Array(sourcePacked.length);
  const donorPrevByUsefulness = new Int32Array(sourcePacked.length);
  const donorNextByUsefulness = new Int32Array(sourcePacked.length);
  bucketNextSourceBySource.fill(-1);
  donorGroupBySource.fill(-1);
  donorBucketEntryBySource.fill(-1);
  donorPrevByUsefulness.fill(-1);
  donorNextByUsefulness.fill(-1);

  const usefulnessBySource = analysis?.sourceUsefulnessByIndex
    ? Float32Array.from(analysis.sourceUsefulnessByIndex)
    : new Float32Array(sourcePacked.length).fill(0.5);
  const nearWhiteBySource = analysis?.sourceNearWhiteByIndex
    ? analysis.sourceNearWhiteByIndex
    : new Float32Array(sourcePacked.length);

  for (let sourceIndex = 0; sourceIndex < sourcePacked.length; sourceIndex += 1) {
    const rgb = sourcePacked[sourceIndex];
    const quantizedBucketKey = bucketKey(rgb, shift);
    let bucketEntry = bucketEntryIndexByKey.get(quantizedBucketKey);
    if (bucketEntry === undefined) {
      bucketEntry = bucketKeys.length;
      bucketEntryIndexByKey.set(quantizedBucketKey, bucketEntry);
      bucketKeys.push(quantizedBucketKey);
      bucketFirstSourceByBucket.push(-1);
      bucketLastSourceByBucket.push(-1);
      bucketFirstGroupByBucket.push(-1);
      bucketLastGroupByBucket.push(-1);
      bucketRemainingGroupCount.push(0);
    }

    const previousBucketTail = bucketLastSourceByBucket[bucketEntry];
    if (previousBucketTail === -1) {
      bucketFirstSourceByBucket[bucketEntry] = sourceIndex;
    } else {
      bucketNextSourceBySource[previousBucketTail] = sourceIndex;
    }
    bucketLastSourceByBucket[bucketEntry] = sourceIndex;

    let groupIndex = groupIndexByRgb.get(rgb);
    if (groupIndex === undefined) {
      groupIndex = groupRgbValues.length;
      groupIndexByRgb.set(rgb, groupIndex);
      groupRgbValues.push(rgb);
      groupFirstDonorByGroup.push(sourceIndex);
      groupLastDonorByGroup.push(sourceIndex);
      groupBucketEntryByGroup.push(bucketEntry);
      groupRemainingCountValues.push(1);
      bucketNextGroupByGroup.push(-1);

      const previousGroupTail = bucketLastGroupByBucket[bucketEntry];
      if (previousGroupTail === -1) {
        bucketFirstGroupByBucket[bucketEntry] = groupIndex;
      } else {
        bucketNextGroupByGroup[previousGroupTail] = groupIndex;
      }
      bucketLastGroupByBucket[bucketEntry] = groupIndex;
      bucketRemainingGroupCount[bucketEntry] += 1;
    } else {
      const previousGroupDonorTail = groupLastDonorByGroup[groupIndex];
      donorNextByUsefulness[previousGroupDonorTail] = sourceIndex;
      groupLastDonorByGroup[groupIndex] = sourceIndex;
      groupRemainingCountValues[groupIndex] += 1;
    }

    donorGroupBySource[sourceIndex] = groupIndex;
    donorBucketEntryBySource[sourceIndex] = bucketEntry;
  }

  const typedGroupRgbValues = Uint32Array.from(groupRgbValues);
  const bucketGroupOffsetByBucket = new Int32Array(bucketKeys.length);
  const bucketGroupCountByBucket = Int32Array.from(bucketRemainingGroupCount);
  const bucketGroupIndices = new Int32Array(groupRgbValues.length);
  const groupNearWhiteByGroup = new Float32Array(groupRgbValues.length);
  const groupMinDonorByGroup = new Int32Array(groupRgbValues.length);
  const groupMaxDonorByGroup = new Int32Array(groupRgbValues.length);
  const groupRemainingCount = Int32Array.from(groupRemainingCountValues);
  const donorSortScratch = new Int32Array(sourcePacked.length);

  for (let bucketEntry = 1; bucketEntry < bucketGroupOffsetByBucket.length; bucketEntry += 1) {
    bucketGroupOffsetByBucket[bucketEntry] =
      bucketGroupOffsetByBucket[bucketEntry - 1] + bucketGroupCountByBucket[bucketEntry - 1];
  }

  const bucketGroupWriteOffsetByBucket = new Int32Array(bucketGroupOffsetByBucket);
  for (let groupIndex = 0; groupIndex < groupRgbValues.length; groupIndex += 1) {
    const bucketEntry = groupBucketEntryByGroup[groupIndex];
    const writeOffset = bucketGroupWriteOffsetByBucket[bucketEntry];
    bucketGroupIndices[writeOffset] = groupIndex;
    bucketGroupWriteOffsetByBucket[bucketEntry] += 1;
  }

  for (let groupIndex = 0; groupIndex < groupRgbValues.length; groupIndex += 1) {
    let donorCount = 0;
    for (
      let donorIndex = groupFirstDonorByGroup[groupIndex];
      donorIndex !== -1;
      donorIndex = donorNextByUsefulness[donorIndex]
    ) {
      donorSortScratch[donorCount] = donorIndex;
      donorCount += 1;
    }

    const sortedDonors = donorSortScratch.subarray(0, donorCount);
    sortDonorsByUsefulness(sortedDonors, usefulnessBySource);

    groupNearWhiteByGroup[groupIndex] = nearWhiteBySource[sortedDonors[0]] ?? 0;
    groupMinDonorByGroup[groupIndex] = sortedDonors[0];
    groupMaxDonorByGroup[groupIndex] = sortedDonors[donorCount - 1];

    for (let donorOffset = 0; donorOffset < donorCount; donorOffset += 1) {
      const donorIndex = sortedDonors[donorOffset];
      donorPrevByUsefulness[donorIndex] =
        donorOffset > 0 ? sortedDonors[donorOffset - 1] : -1;
      donorNextByUsefulness[donorIndex] =
        donorOffset + 1 < donorCount ? sortedDonors[donorOffset + 1] : -1;
    }
  }

  return {
    shift,
    bucketCount,
    bucketEntryIndexByKey,
    bucketKeys: Uint32Array.from(bucketKeys),
    bucketFirstSourceByBucket: Int32Array.from(bucketFirstSourceByBucket),
    bucketNextSourceBySource,
    bucketFirstGroupByBucket: Int32Array.from(bucketFirstGroupByBucket),
    bucketNextGroupByGroup: Int32Array.from(bucketNextGroupByGroup),
    bucketGroupOffsetByBucket,
    bucketGroupCountByBucket,
    bucketGroupIndices,
    bucketRemainingGroupCount: Int32Array.from(bucketRemainingGroupCount),
    groupRgbValues: typedGroupRgbValues,
    groupNearWhiteByGroup,
    groupMinDonorByGroup,
    groupMaxDonorByGroup,
    groupRemainingCount,
    donorGroupBySource,
    donorBucketEntryBySource,
    donorNextByUsefulness,
    donorPrevByUsefulness,
    usefulnessBySource
  };
}

function compareForDonorSort(
  left: number,
  right: number,
  usefulnessBySource: Float32Array
) {
  const delta = usefulnessBySource[left] - usefulnessBySource[right];
  return delta === 0 ? left - right : delta;
}

function sortDonorsByUsefulness(donors: Int32Array, usefulnessBySource: Float32Array) {
  // Mutates the donor view in place. Tiny exact-color groups avoid native sort
  // overhead; larger groups use the built-in typed-array comparator.
  if (donors.length <= INSERTION_SORT_DONOR_LIMIT) {
    for (let index = 1; index < donors.length; index += 1) {
      const donor = donors[index];
      let insertionIndex = index - 1;
      while (
        insertionIndex >= 0 &&
        compareForDonorSort(donors[insertionIndex], donor, usefulnessBySource) > 0
      ) {
        donors[insertionIndex + 1] = donors[insertionIndex];
        insertionIndex -= 1;
      }
      donors[insertionIndex + 1] = donor;
    }
    return;
  }

  donors.sort((left, right) => compareForDonorSort(left, right, usefulnessBySource));
}

function validateMatchingInputs(sourcePacked: Uint32Array, targetPacked: Uint32Array, quantizationBits: number) {
  if (sourcePacked.length !== targetPacked.length) {
    throw new TransformError('Source and target images must have the same pixel count.');
  }

  if (sourcePacked.length === 0) {
    throw new TransformError('Images must contain at least one pixel.');
  }

  if (quantizationBits < 4 || quantizationBits > 8) {
    throw new TransformError('Quantization bits must stay between 4 and 8.');
  }
}

function forEachShellBucket(
  centerRed: number,
  centerGreen: number,
  centerBlue: number,
  radius: number,
  bucketCount: number,
  callback: (key: number) => void
) {
  const redMin = Math.max(0, centerRed - radius);
  const redMax = Math.min(bucketCount - 1, centerRed + radius);
  const greenMin = Math.max(0, centerGreen - radius);
  const greenMax = Math.min(bucketCount - 1, centerGreen + radius);
  const blueMin = Math.max(0, centerBlue - radius);
  const blueMax = Math.min(bucketCount - 1, centerBlue + radius);

  if (radius === 0) {
    callback((centerRed << 16) | (centerGreen << 8) | centerBlue);
    return;
  }

  const redFaces = [centerRed - radius, centerRed + radius].filter(
    (red) => red >= 0 && red < bucketCount
  );
  const greenFaces = [centerGreen - radius, centerGreen + radius].filter(
    (green) => green >= 0 && green < bucketCount
  );
  const blueFaces = [centerBlue - radius, centerBlue + radius].filter(
    (blue) => blue >= 0 && blue < bucketCount
  );

  for (const red of redFaces) {
    for (let green = greenMin; green <= greenMax; green += 1) {
      for (let blue = blueMin; blue <= blueMax; blue += 1) {
        callback((red << 16) | (green << 8) | blue);
      }
    }
  }

  for (const green of greenFaces) {
    for (let red = redMin; red <= redMax; red += 1) {
      if (Math.abs(red - centerRed) === radius) {
        continue;
      }
      for (let blue = blueMin; blue <= blueMax; blue += 1) {
        callback((red << 16) | (green << 8) | blue);
      }
    }
  }

  for (const blue of blueFaces) {
    for (let red = redMin; red <= redMax; red += 1) {
      if (Math.abs(red - centerRed) === radius) {
        continue;
      }
      for (let green = greenMin; green <= greenMax; green += 1) {
        if (Math.abs(green - centerGreen) === radius) {
          continue;
        }
        callback((red << 16) | (green << 8) | blue);
      }
    }
  }
}

function scoreCandidateDistance(context: MatchingSearchContext, sourceIndex: number, targetIndex: number) {
  let distance = weightedRgbDistance(context.sourcePacked[sourceIndex], context.targetPacked[targetIndex]);

  if (context.analysis) {
    const donorUsefulness = context.analysis.sourceUsefulnessByIndex[sourceIndex];
    const donorNearWhite = context.analysis.sourceNearWhiteByIndex[sourceIndex];
    const targetNeed = context.analysis.targetNeedByIndex[targetIndex];
    const targetFlatBright = context.analysis.targetNearWhiteByIndex[targetIndex] * (1 - targetNeed);

    distance += (1 - donorUsefulness) * targetNeed * SCORE_USEFULNESS_NEED;
    distance += donorNearWhite * targetNeed * SCORE_NEAR_WHITE_NEED;
    distance += donorUsefulness * targetFlatBright * SCORE_USEFULNESS_FLAT_BRIGHT;
  }

  return distance;
}

export function createMatchingSearchContext(
  sourcePacked: Uint32Array,
  targetPacked: Uint32Array,
  quantizationBits: number,
  analysis?: TransformImageAnalysis
): MatchingSearchContext {
  validateMatchingInputs(sourcePacked, targetPacked, quantizationBits);
  const sourceDonorIndex = buildSourceDonorIndex(sourcePacked, quantizationBits, analysis);
  const bucketRed = new Uint8Array(sourceDonorIndex.bucketKeys.length);
  const bucketGreen = new Uint8Array(sourceDonorIndex.bucketKeys.length);
  const bucketBlue = new Uint8Array(sourceDonorIndex.bucketKeys.length);
  const groupRed = new Uint8Array(sourceDonorIndex.groupRgbValues.length);
  const groupGreen = new Uint8Array(sourceDonorIndex.groupRgbValues.length);
  const groupBlue = new Uint8Array(sourceDonorIndex.groupRgbValues.length);
  const targetRed = new Uint8Array(targetPacked.length);
  const targetGreen = new Uint8Array(targetPacked.length);
  const targetBlue = new Uint8Array(targetPacked.length);
  const targetBucketRed = new Uint8Array(targetPacked.length);
  const targetBucketGreen = new Uint8Array(targetPacked.length);
  const targetBucketBlue = new Uint8Array(targetPacked.length);
  const targetBucketKeyByIndex = new Int32Array(targetPacked.length);
  const targetUsefulnessCoefficient = new Float32Array(targetPacked.length);
  const targetNearWhiteCoefficient = new Float32Array(targetPacked.length);
  const targetPreferMaxUsefulness = new Uint8Array(targetPacked.length);

  for (let bucketIndex = 0; bucketIndex < sourceDonorIndex.bucketKeys.length; bucketIndex += 1) {
    const key = sourceDonorIndex.bucketKeys[bucketIndex];
    bucketRed[bucketIndex] = (key >> 16) & 0xff;
    bucketGreen[bucketIndex] = (key >> 8) & 0xff;
    bucketBlue[bucketIndex] = key & 0xff;
  }

  for (let groupIndex = 0; groupIndex < sourceDonorIndex.groupRgbValues.length; groupIndex += 1) {
    const rgb = sourceDonorIndex.groupRgbValues[groupIndex];
    groupRed[groupIndex] = (rgb >> 16) & 0xff;
    groupGreen[groupIndex] = (rgb >> 8) & 0xff;
    groupBlue[groupIndex] = rgb & 0xff;
  }

  for (let targetIndex = 0; targetIndex < targetPacked.length; targetIndex += 1) {
    const rgb = targetPacked[targetIndex];
    const red = (rgb >> 16) & 0xff;
    const green = (rgb >> 8) & 0xff;
    const blue = rgb & 0xff;
    const targetNeed = analysis?.targetNeedByIndex[targetIndex] ?? 0;
    const targetFlatBright = (analysis?.targetNearWhiteByIndex[targetIndex] ?? 0) * (1 - targetNeed);

    targetRed[targetIndex] = red;
    targetGreen[targetIndex] = green;
    targetBlue[targetIndex] = blue;
    targetBucketRed[targetIndex] = red >> sourceDonorIndex.shift;
    targetBucketGreen[targetIndex] = green >> sourceDonorIndex.shift;
    targetBucketBlue[targetIndex] = blue >> sourceDonorIndex.shift;
    targetBucketKeyByIndex[targetIndex] =
      (targetBucketRed[targetIndex] << 16) |
      (targetBucketGreen[targetIndex] << 8) |
      targetBucketBlue[targetIndex];
    targetUsefulnessCoefficient[targetIndex] = -targetNeed * SCORE_USEFULNESS_NEED + targetFlatBright * SCORE_USEFULNESS_FLAT_BRIGHT;
    targetNearWhiteCoefficient[targetIndex] = targetNeed * SCORE_NEAR_WHITE_NEED;
    targetPreferMaxUsefulness[targetIndex] = targetUsefulnessCoefficient[targetIndex] < 0 ? 1 : 0;
  }

  return {
    sourcePacked,
    targetPacked,
    bucketEntryIndexByKey: sourceDonorIndex.bucketEntryIndexByKey,
    bucketKeys: sourceDonorIndex.bucketKeys,
    bucketRed,
    bucketGreen,
    bucketBlue,
    bucketFirstSourceByBucket: sourceDonorIndex.bucketFirstSourceByBucket,
    bucketNextSourceBySource: sourceDonorIndex.bucketNextSourceBySource,
    bucketFirstGroupByBucket: sourceDonorIndex.bucketFirstGroupByBucket,
    bucketNextGroupByGroup: sourceDonorIndex.bucketNextGroupByGroup,
    bucketGroupOffsetByBucket: sourceDonorIndex.bucketGroupOffsetByBucket,
    bucketGroupCountByBucket: sourceDonorIndex.bucketGroupCountByBucket,
    bucketGroupIndices: sourceDonorIndex.bucketGroupIndices,
    bucketRemainingGroupCount: sourceDonorIndex.bucketRemainingGroupCount,
    shift: sourceDonorIndex.shift,
    bucketCount: sourceDonorIndex.bucketCount,
    groupRgbValues: sourceDonorIndex.groupRgbValues,
    groupRed,
    groupGreen,
    groupBlue,
    groupNearWhiteByGroup: sourceDonorIndex.groupNearWhiteByGroup,
    groupMinDonorByGroup: sourceDonorIndex.groupMinDonorByGroup,
    groupMaxDonorByGroup: sourceDonorIndex.groupMaxDonorByGroup,
    groupRemainingCount: sourceDonorIndex.groupRemainingCount,
    donorGroupBySource: sourceDonorIndex.donorGroupBySource,
    donorBucketEntryBySource: sourceDonorIndex.donorBucketEntryBySource,
    donorNextByUsefulness: sourceDonorIndex.donorNextByUsefulness,
    donorPrevByUsefulness: sourceDonorIndex.donorPrevByUsefulness,
    usefulnessBySource: sourceDonorIndex.usefulnessBySource,
    targetRed,
    targetGreen,
    targetBlue,
    targetBucketRed,
    targetBucketGreen,
    targetBucketBlue,
    targetBucketKeyByIndex,
    targetUsefulnessCoefficient,
    targetNearWhiteCoefficient,
    targetPreferMaxUsefulness,
    bucketSearchOrderByTargetBucketKey: new Map<number, BucketSearchOrder>(),
    analysis
  };
}

export function resolveTargetOrder(targetLength: number, analysis?: TransformImageAnalysis) {
  const order = Array.from({ length: targetLength }, (_value, index) => index);
  if (!analysis) {
    return Uint32Array.from(order);
  }

  order.sort((left, right) => {
    const delta = analysis.targetPriorityByIndex[right] - analysis.targetPriorityByIndex[left];
    return delta === 0 ? left - right : delta;
  });

  return Uint32Array.from(order);
}

function collectShellCandidates(
  context: MatchingSearchContext,
  targetIndex: number,
  radius: number
) {
  const targetRgb = context.targetPacked[targetIndex];
  const centerRed = ((targetRgb >> 16) & 0xff) >> context.shift;
  const centerGreen = ((targetRgb >> 8) & 0xff) >> context.shift;
  const centerBlue = (targetRgb & 0xff) >> context.shift;
  const shellCandidates: RankedCandidate[] = [];

  forEachShellBucket(centerRed, centerGreen, centerBlue, radius, context.bucketCount, (key) => {
    const bucketIndex = context.bucketEntryIndexByKey.get(key);
    if (bucketIndex === undefined) {
      return;
    }

    for (
      let sourceIndex = context.bucketFirstSourceByBucket[bucketIndex];
      sourceIndex !== -1;
      sourceIndex = context.bucketNextSourceBySource[sourceIndex]
    ) {
      shellCandidates.push({
        sourceIndex,
        distance: scoreCandidateDistance(context, sourceIndex, targetIndex)
      });
    }
  });

  shellCandidates.sort((left, right) =>
    left.distance === right.distance ? left.sourceIndex - right.sourceIndex : left.distance - right.distance
  );

  return shellCandidates;
}

function populateCandidateQueue(
  context: MatchingSearchContext,
  targetIndex: number,
  state: TargetSearchState,
  minimumCandidateCount: number
) {
  while (
    state.rankedCandidates.length < minimumCandidateCount &&
    state.nextRadius < context.bucketCount
  ) {
    state.rankedCandidates.push(
      ...collectShellCandidates(context, targetIndex, state.nextRadius)
    );
    state.nextRadius += 1;
  }
}

function createTargetSearchState(
  context: MatchingSearchContext,
  targetIndex: number,
  minimumCandidateCount: number
) {
  const state: TargetSearchState = {
    nextRadius: 0,
    rankedCandidates: [],
    initialCandidateCount: 0
  };
  populateCandidateQueue(context, targetIndex, state, minimumCandidateCount);
  state.initialCandidateCount = state.rankedCandidates.length;
  return state;
}

export function collectRankedCandidatesForTarget(
  context: MatchingSearchContext,
  targetIndex: number,
  minimumCandidateCount: number
) {
  return createTargetSearchState(context, targetIndex, minimumCandidateCount).rankedCandidates;
}

export function findBestAvailableSourceIndex(
  context: MatchingSearchContext,
  targetIndex: number,
  used: Uint8Array
) {
  const targetRgb = context.targetPacked[targetIndex];
  const centerRed = ((targetRgb >> 16) & 0xff) >> context.shift;
  const centerGreen = ((targetRgb >> 8) & 0xff) >> context.shift;
  const centerBlue = (targetRgb & 0xff) >> context.shift;

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let radius = 0; radius < context.bucketCount; radius += 1) {
    forEachShellBucket(centerRed, centerGreen, centerBlue, radius, context.bucketCount, (key) => {
      const bucketIndex = context.bucketEntryIndexByKey.get(key);
      if (bucketIndex === undefined) {
        return;
      }

      for (
        let sourceIndex = context.bucketFirstSourceByBucket[bucketIndex];
        sourceIndex !== -1;
        sourceIndex = context.bucketNextSourceBySource[sourceIndex]
      ) {
        if (used[sourceIndex]) {
          continue;
        }

        const distance = scoreCandidateDistance(context, sourceIndex, targetIndex);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = sourceIndex;
        }
      }
    });
  }

  return bestIndex;
}

interface GroupedSearchResult {
  sourceIndex: number;
  evaluatedCandidateCount: number;
  evaluatedGroupCount: number;
}

function shouldUseOccupiedBucketScan(context: MatchingSearchContext) {
  const searchSpaceSize = context.bucketCount * context.bucketCount * context.bucketCount;
  return (
    context.sourcePacked.length >= OCCUPIED_BUCKET_SCAN_MIN_PIXELS ||
    (context.bucketKeys.length <= 128 && context.bucketKeys.length * 4 <= searchSpaceSize)
  );
}

function getBucketSearchOrder(
  context: MatchingSearchContext,
  targetBucketKey: number,
  centerRed: number,
  centerGreen: number,
  centerBlue: number
) {
  const cached = context.bucketSearchOrderByTargetBucketKey.get(targetBucketKey);
  if (cached) {
    return cached;
  }

  const order = Array.from({ length: context.bucketKeys.length }, (_value, bucketIndex) => {
    const shellDistance = Math.max(
      Math.abs(context.bucketRed[bucketIndex] - centerRed),
      Math.abs(context.bucketGreen[bucketIndex] - centerGreen),
      Math.abs(context.bucketBlue[bucketIndex] - centerBlue)
    );

    return {
      bucketIndex,
      shellDistance
    };
  });

  order.sort((left, right) =>
    left.shellDistance === right.shellDistance
      ? left.bucketIndex - right.bucketIndex
      : left.shellDistance - right.shellDistance
  );

  const bucketSearchOrder: BucketSearchOrder = {
    bucketIndices: Int32Array.from(order, (entry) => entry.bucketIndex),
    shellDistances: Uint8Array.from(order, (entry) => entry.shellDistance)
  };
  context.bucketSearchOrderByTargetBucketKey.set(targetBucketKey, bucketSearchOrder);
  return bucketSearchOrder;
}

function findBestGroupedSourceIndex(
  context: MatchingSearchContext,
  targetIndex: number
): GroupedSearchResult {
  const centerRed = context.targetBucketRed[targetIndex];
  const centerGreen = context.targetBucketGreen[targetIndex];
  const centerBlue = context.targetBucketBlue[targetIndex];
  const targetBucketKey = context.targetBucketKeyByIndex[targetIndex];
  const usefulnessCoefficient = context.targetUsefulnessCoefficient[targetIndex];
  const nearWhiteCoefficient = context.targetNearWhiteCoefficient[targetIndex];
  const preferMaxUsefulness = context.targetPreferMaxUsefulness[targetIndex] === 1;
  const targetRed = context.targetRed[targetIndex];
  const targetGreen = context.targetGreen[targetIndex];
  const targetBlue = context.targetBlue[targetIndex];

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let evaluatedGroupCount = 0;
  let evaluatedCandidateCount = 0;
  if (shouldUseOccupiedBucketScan(context)) {
    const bucketSearchOrder = getBucketSearchOrder(
      context,
      targetBucketKey,
      centerRed,
      centerGreen,
      centerBlue
    );
    let nearestShellDistance = -1;

    for (
      let orderedBucketIndex = 0;
      orderedBucketIndex < bucketSearchOrder.bucketIndices.length;
      orderedBucketIndex += 1
    ) {
      const bucketIndex = bucketSearchOrder.bucketIndices[orderedBucketIndex];
      if (context.bucketRemainingGroupCount[bucketIndex] <= 0) {
        continue;
      }

      const shellDistance = bucketSearchOrder.shellDistances[orderedBucketIndex];
      if (nearestShellDistance === -1) {
        nearestShellDistance = shellDistance;
      } else if (shellDistance !== nearestShellDistance) {
        break;
      }

      const groupEnd =
        context.bucketGroupOffsetByBucket[bucketIndex] + context.bucketGroupCountByBucket[bucketIndex];
      for (
        let groupOffset = context.bucketGroupOffsetByBucket[bucketIndex];
        groupOffset < groupEnd;
        groupOffset += 1
      ) {
        const groupIndex = context.bucketGroupIndices[groupOffset];
        if (context.groupRemainingCount[groupIndex] <= 0) {
          continue;
        }

        const sourceIndex = preferMaxUsefulness
          ? context.groupMaxDonorByGroup[groupIndex]
          : context.groupMinDonorByGroup[groupIndex];
        if (sourceIndex < 0) {
          continue;
        }

        evaluatedGroupCount += 1;
        evaluatedCandidateCount += 1;

        let distance = weightedRgbDistanceFromChannels(
          context.groupRed[groupIndex],
          context.groupGreen[groupIndex],
          context.groupBlue[groupIndex],
          targetRed,
          targetGreen,
          targetBlue
        );
        distance += usefulnessCoefficient * context.usefulnessBySource[sourceIndex];
        distance += nearWhiteCoefficient * context.groupNearWhiteByGroup[groupIndex];

        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = sourceIndex;
        }
      }
    }
  } else {
    for (let radius = 0; radius < context.bucketCount; radius += 1) {
      forEachShellBucket(centerRed, centerGreen, centerBlue, radius, context.bucketCount, (key) => {
        const bucketIndex = context.bucketEntryIndexByKey.get(key);
        if (bucketIndex === undefined) {
          return;
        }

        const groupEnd =
          context.bucketGroupOffsetByBucket[bucketIndex] + context.bucketGroupCountByBucket[bucketIndex];
        for (
          let groupOffset = context.bucketGroupOffsetByBucket[bucketIndex];
          groupOffset < groupEnd;
          groupOffset += 1
        ) {
          const groupIndex = context.bucketGroupIndices[groupOffset];
          if (context.groupRemainingCount[groupIndex] <= 0) {
            continue;
          }

          const sourceIndex = preferMaxUsefulness
            ? context.groupMaxDonorByGroup[groupIndex]
            : context.groupMinDonorByGroup[groupIndex];
          if (sourceIndex < 0) {
            continue;
          }

          evaluatedGroupCount += 1;
          evaluatedCandidateCount += 1;

          let distance = weightedRgbDistanceFromChannels(
            context.groupRed[groupIndex],
            context.groupGreen[groupIndex],
            context.groupBlue[groupIndex],
            targetRed,
            targetGreen,
            targetBlue
          );
          distance += usefulnessCoefficient * context.usefulnessBySource[sourceIndex];
          distance += nearWhiteCoefficient * context.groupNearWhiteByGroup[groupIndex];

          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = sourceIndex;
          }
        }
      });
    }
  }

  return {
    sourceIndex: bestIndex,
    evaluatedCandidateCount,
    evaluatedGroupCount
  };
}

function removeFromGroupedDonorState(context: MatchingSearchContext, sourceIndex: number) {
  const groupIndex = context.donorGroupBySource[sourceIndex];
  if (groupIndex < 0) {
    return;
  }
  const bucketIndex = context.donorBucketEntryBySource[sourceIndex];

  const previousIndex = context.donorPrevByUsefulness[sourceIndex];
  const nextIndex = context.donorNextByUsefulness[sourceIndex];

  if (previousIndex !== -1) {
    context.donorNextByUsefulness[previousIndex] = nextIndex;
  } else {
    context.groupMinDonorByGroup[groupIndex] = nextIndex;
  }

  if (nextIndex !== -1) {
    context.donorPrevByUsefulness[nextIndex] = previousIndex;
  } else {
    context.groupMaxDonorByGroup[groupIndex] = previousIndex;
  }

  context.donorPrevByUsefulness[sourceIndex] = -1;
  context.donorNextByUsefulness[sourceIndex] = -1;
  const remainingCount = Math.max(0, context.groupRemainingCount[groupIndex] - 1);
  context.groupRemainingCount[groupIndex] = remainingCount;
  if (remainingCount === 0 && bucketIndex >= 0) {
    context.bucketRemainingGroupCount[bucketIndex] = Math.max(
      0,
      context.bucketRemainingGroupCount[bucketIndex] - 1
    );
  }
}

function createFreeList(length: number): FreeListState {
  const nextFree = new Int32Array(length);
  const prevFree = new Int32Array(length);

  for (let index = 0; index < length; index += 1) {
    nextFree[index] = index + 1 < length ? index + 1 : -1;
    prevFree[index] = index - 1;
  }

  return {
    head: length > 0 ? 0 : -1,
    nextFree,
    prevFree
  };
}

function removeFromFreeList(freeList: FreeListState, index: number) {
  const previousIndex = freeList.prevFree[index];
  const nextIndex = freeList.nextFree[index];

  if (previousIndex !== -1) {
    freeList.nextFree[previousIndex] = nextIndex;
  } else {
    freeList.head = nextIndex;
  }

  if (nextIndex !== -1) {
    freeList.prevFree[nextIndex] = previousIndex;
  }

  freeList.nextFree[index] = -1;
  freeList.prevFree[index] = -1;
}

function maybeReportProgress(
  stage: 'ranking' | 'assigning',
  completed: number,
  total: number,
  hooks?: TransformHooks,
  message?: string
) {
  if (!hooks?.onStageProgress) {
    return;
  }

  if (completed !== total && completed % PROGRESS_REPORT_INTERVAL !== 0) {
    return;
  }

  hooks.onStageProgress(
    stage,
    completed / total,
    message ?? `${stage[0].toUpperCase()}${stage.slice(1)}… ${completed}/${total}`
  );
}

function computePackedPixelAssignment(
  context: MatchingSearchContext,
  targetOrder: Uint32Array,
  hooks?: TransformHooks
): PackedMatchComputation {
  const assignment = new Uint32Array(context.targetPacked.length);
  const freeList = createFreeList(context.sourcePacked.length);
  let shortlistHitCount = 0;
  let fallbackCount = 0;
  let evaluatedCandidateCount = 0;
  let evaluatedGroupCount = 0;

  const assignStartedAt = nowMs();
  for (let orderedIndex = 0; orderedIndex < targetOrder.length; orderedIndex += 1) {
    if (hooks?.isCancelled?.()) {
      throw new TransformError('Transform cancelled.');
    }

    const targetIndex = targetOrder[orderedIndex];
    const groupedResult = findBestGroupedSourceIndex(context, targetIndex);
    evaluatedCandidateCount += groupedResult.evaluatedCandidateCount;
    evaluatedGroupCount += groupedResult.evaluatedGroupCount;

    let sourceIndex = groupedResult.sourceIndex;
    if (sourceIndex === -1) {
      sourceIndex = freeList.head;
      fallbackCount += 1;
    } else {
      shortlistHitCount += 1;
    }

    if (sourceIndex === -1) {
      throw new TransformError('No unused pixels remained during matching.');
    }

    removeFromFreeList(freeList, sourceIndex);
    removeFromGroupedDonorState(context, sourceIndex);
    assignment[targetIndex] = sourceIndex;

    if (
      hooks?.onProgress &&
      (orderedIndex + 1 === targetOrder.length || (orderedIndex + 1) % PROGRESS_REPORT_INTERVAL === 0)
    ) {
      hooks.onProgress(orderedIndex + 1, targetOrder.length);
    }

    maybeReportProgress(
      'assigning',
      orderedIndex + 1,
      targetOrder.length,
      hooks,
      `Assigning donors… ${orderedIndex + 1}/${targetOrder.length}`
    );
  }
  const assignMs = nowMs() - assignStartedAt;

  return {
    assignment,
    matcherStats: {
      fallbackCount,
      shortlistHitRate: targetOrder.length > 0 ? shortlistHitCount / targetOrder.length : 1,
      shortlistHitCount,
      shortlistRequestCount: targetOrder.length,
      evaluatedCandidateCount,
      evaluatedGroupCount,
      averageGroupsPerTarget: targetOrder.length > 0 ? evaluatedGroupCount / targetOrder.length : 0
    },
    assignMs
  };
}

export function mergeRankedCandidatesIntoAssignment(
  context: MatchingSearchContext | { sourceLength: number; targetLength: number },
  targetOrder: Uint32Array,
  rankedCandidatesByTarget: Array<RankedCandidate[] | undefined>,
  hooks?: TransformHooks
) {
  const sourceLength = 'sourcePacked' in context ? context.sourcePacked.length : context.sourceLength;
  const targetLength = 'targetPacked' in context ? context.targetPacked.length : context.targetLength;
  const assignment = new Uint32Array(targetLength);
  const used = new Uint8Array(sourceLength);
  const freeList = createFreeList(sourceLength);
  let shortlistHitCount = 0;
  let fallbackCount = 0;

  for (let orderedIndex = 0; orderedIndex < targetOrder.length; orderedIndex += 1) {
    const targetIndex = targetOrder[orderedIndex];

    if (hooks?.isCancelled?.()) {
      throw new TransformError('Transform cancelled.');
    }

    let sourceIndex = -1;
    const rankedCandidates = rankedCandidatesByTarget[targetIndex];
    if (rankedCandidates) {
      for (let candidateIndex = 0; candidateIndex < rankedCandidates.length; candidateIndex += 1) {
        const candidateSourceIndex = rankedCandidates[candidateIndex].sourceIndex;
        if (!used[candidateSourceIndex]) {
          sourceIndex = candidateSourceIndex;
          shortlistHitCount += 1;
          break;
        }
      }
    }

    if (sourceIndex === -1) {
      sourceIndex = freeList.head;
      fallbackCount += 1;
    }

    if (sourceIndex === -1) {
      throw new TransformError('No unused pixels remained during matching.');
    }

    used[sourceIndex] = 1;
    removeFromFreeList(freeList, sourceIndex);
    assignment[targetIndex] = sourceIndex;

    if (
      hooks?.onProgress &&
      (orderedIndex + 1 === targetOrder.length || (orderedIndex + 1) % PROGRESS_REPORT_INTERVAL === 0)
    ) {
      hooks.onProgress(orderedIndex + 1, targetOrder.length);
    }
  }

  return {
    assignment,
    matcherStats: {
      fallbackCount,
      shortlistHitRate: targetOrder.length > 0 ? shortlistHitCount / targetOrder.length : 1,
      shortlistHitCount,
      shortlistRequestCount: targetOrder.length,
      evaluatedCandidateCount: shortlistHitCount,
      evaluatedGroupCount: shortlistHitCount,
      averageGroupsPerTarget: targetOrder.length > 0 ? shortlistHitCount / targetOrder.length : 0
    }
  };
}

export function matchPackedPixels(
  sourcePacked: Uint32Array,
  targetPacked: Uint32Array,
  quantizationBits: number,
  hooks?: TransformHooks,
  analysis?: TransformImageAnalysis
) {
  const context = createMatchingSearchContext(sourcePacked, targetPacked, quantizationBits, analysis);
  const targetOrder = resolveTargetOrder(targetPacked.length, analysis);
  return computePackedPixelAssignment(context, targetOrder, hooks).assignment;
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
  hooks?: TransformHooks
): TransformComputationResult {
  if (source.width !== target.width || source.height !== target.height) {
    throw new TransformDimensionMismatchError(source, target);
  }

  const totalStartedAt = nowMs();
  hooks?.onStageProgress?.('analyzing', 0, 'Analyzing image structure…');
  const analyzeStartedAt = nowMs();
  const analysis = analyzeTransformImages(source, target, quantizationBits);
  const analyzeMs = nowMs() - analyzeStartedAt;
  hooks?.onStageProgress?.('analyzing', 1, 'Image analysis complete.');

  const sourcePacked = packRgbPixels(source.pixels);
  const targetPacked = packRgbPixels(target.pixels);
  hooks?.onStageProgress?.('ranking', 0, 'Prioritizing target regions…');
  const rankStartedAt = nowMs();
  const context = createMatchingSearchContext(sourcePacked, targetPacked, quantizationBits, analysis);
  const targetOrder = resolveTargetOrder(targetPacked.length, analysis);
  const rankMs = nowMs() - rankStartedAt;
  hooks?.onStageProgress?.('ranking', 1, 'Target prioritization complete.');
  const packedMatch = computePackedPixelAssignment(context, targetOrder, hooks);
  hooks?.onStageProgress?.('assigning', 1, 'Donor assignment complete.');

  const timingsMs: TransformStageTimingsMs = {
    decode: 0,
    analyze: analyzeMs,
    rank: rankMs,
    assign: packedMatch.assignMs,
    total: nowMs() - totalStartedAt
  };

  return {
    source,
    target,
    assignment: packedMatch.assignment,
    analysis,
    pixelCount: packedMatch.assignment.length,
    timingsMs,
    matcherStrategy: 'single-optimized',
    matcherStats: packedMatch.matcherStats,
    workerCount: 1
  };
}
