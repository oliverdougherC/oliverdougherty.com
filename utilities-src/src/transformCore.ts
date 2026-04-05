import { analyzeTransformImages, type TransformImageAnalysis } from './transformIntelligence';
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

export interface TransformHooks {
  onProgress?: (completed: number, total: number) => void;
  onStageProgress?: (
    stage: 'analyzing' | 'ranking' | 'assigning',
    progress: number,
    message: string
  ) => void;
  isCancelled?: () => boolean;
}

export interface MatchingSearchContext {
  sourcePacked: Uint32Array;
  targetPacked: Uint32Array;
  buckets: Map<number, number[]>;
  bucketGroups: Map<number, number[]>;
  bucketGroupIndicesByBucket: Int32Array[];
  bucketEntryIndexByKey: Map<number, number>;
  bucketKeys: Uint32Array;
  bucketRed: Uint8Array;
  bucketGreen: Uint8Array;
  bucketBlue: Uint8Array;
  bucketRemainingGroupCount: Int32Array;
  shift: number;
  bucketCount: number;
  groupRgbValues: Uint32Array;
  groupRed: Uint8Array;
  groupGreen: Uint8Array;
  groupBlue: Uint8Array;
  groupNearWhiteByGroup: Float32Array;
  groupMinDonorByGroup: Int32Array;
  groupMaxDonorByGroup: Int32Array;
  groupRemainingCount: Int32Array;
  donorGroupBySource: Int32Array;
  donorBucketKeyBySource: Int32Array;
  donorNextByUsefulness: Int32Array;
  donorPrevByUsefulness: Int32Array;
  usefulnessBySource: Float32Array;
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

const INITIAL_SHORTLIST_SIZE = 8;
const PROGRESS_REPORT_INTERVAL = 256;

function nowMs() {
  return performance.now();
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

function weightedDistance(left: number, right: number) {
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

  return (
    (((512 + redMean) * deltaRed * deltaRed) >> 8) +
    4 * deltaGreen * deltaGreen +
    (((767 - redMean) * deltaBlue * deltaBlue) >> 8)
  );
}

function weightedDistanceFromChannels(
  leftRed: number,
  leftGreen: number,
  leftBlue: number,
  rightRed: number,
  rightGreen: number,
  rightBlue: number
) {
  const redMean = (leftRed + rightRed) >> 1;
  const deltaRed = leftRed - rightRed;
  const deltaGreen = leftGreen - rightGreen;
  const deltaBlue = leftBlue - rightBlue;

  return (
    (((512 + redMean) * deltaRed * deltaRed) >> 8) +
    4 * deltaGreen * deltaGreen +
    (((767 - redMean) * deltaBlue * deltaBlue) >> 8)
  );
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

function buildGroupedDonorState(
  sourcePacked: Uint32Array,
  shift: number,
  analysis?: TransformImageAnalysis
) {
  const exactGroups = new Map<number, number[]>();
  for (let sourceIndex = 0; sourceIndex < sourcePacked.length; sourceIndex += 1) {
    const rgb = sourcePacked[sourceIndex];
    const existing = exactGroups.get(rgb);
    if (existing) {
      existing.push(sourceIndex);
    } else {
      exactGroups.set(rgb, [sourceIndex]);
    }
  }

  const bucketGroups = new Map<number, number[]>();
  const donorBucketKeyBySource = new Int32Array(sourcePacked.length);
  const groupRgbValues = new Uint32Array(exactGroups.size);
  const groupNearWhiteByGroup = new Float32Array(exactGroups.size);
  const groupMinDonorByGroup = new Int32Array(exactGroups.size);
  const groupMaxDonorByGroup = new Int32Array(exactGroups.size);
  const groupRemainingCount = new Int32Array(exactGroups.size);
  const donorGroupBySource = new Int32Array(sourcePacked.length);
  const donorNextByUsefulness = new Int32Array(sourcePacked.length);
  const donorPrevByUsefulness = new Int32Array(sourcePacked.length);
  donorGroupBySource.fill(-1);
  donorNextByUsefulness.fill(-1);
  donorPrevByUsefulness.fill(-1);

  const usefulnessBySource = analysis?.sourceUsefulnessByIndex
    ? Float32Array.from(analysis.sourceUsefulnessByIndex)
    : new Float32Array(sourcePacked.length).fill(0.5);
  const nearWhiteBySource = analysis?.sourceNearWhiteByIndex
    ? analysis.sourceNearWhiteByIndex
    : new Float32Array(sourcePacked.length);

  let groupIndex = 0;
  for (const [rgb, donors] of exactGroups.entries()) {
    const quantizedBucketKey = bucketKey(rgb, shift);
    const groupsForBucket = bucketGroups.get(quantizedBucketKey);
    if (groupsForBucket) {
      groupsForBucket.push(groupIndex);
    } else {
      bucketGroups.set(quantizedBucketKey, [groupIndex]);
    }

    donors.sort((left, right) => {
      const delta = usefulnessBySource[left] - usefulnessBySource[right];
      return delta === 0 ? left - right : delta;
    });

    groupRgbValues[groupIndex] = rgb;
    groupNearWhiteByGroup[groupIndex] = nearWhiteBySource[donors[0]] ?? 0;
    groupMinDonorByGroup[groupIndex] = donors[0];
    groupMaxDonorByGroup[groupIndex] = donors[donors.length - 1];
    groupRemainingCount[groupIndex] = donors.length;

    for (let donorOffset = 0; donorOffset < donors.length; donorOffset += 1) {
      const donorIndex = donors[donorOffset];
      donorGroupBySource[donorIndex] = groupIndex;
      donorBucketKeyBySource[donorIndex] = quantizedBucketKey;
      donorPrevByUsefulness[donorIndex] = donorOffset > 0 ? donors[donorOffset - 1] : -1;
      donorNextByUsefulness[donorIndex] =
        donorOffset + 1 < donors.length ? donors[donorOffset + 1] : -1;
    }

    groupIndex += 1;
  }

  return {
    bucketGroups,
    groupRgbValues,
    groupNearWhiteByGroup,
    groupMinDonorByGroup,
    groupMaxDonorByGroup,
    groupRemainingCount,
    donorGroupBySource,
    donorBucketKeyBySource,
    donorNextByUsefulness,
    donorPrevByUsefulness,
    usefulnessBySource
  };
}

function validateMatchingInputs(sourcePacked: Uint32Array, targetPacked: Uint32Array, quantizationBits: number) {
  if (sourcePacked.length !== targetPacked.length) {
    throw new TransformError('Source and target images must have the same pixel count.');
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

  for (let red = redMin; red <= redMax; red += 1) {
    for (let green = greenMin; green <= greenMax; green += 1) {
      for (let blue = blueMin; blue <= blueMax; blue += 1) {
        const shellDistance = Math.max(
          Math.abs(red - centerRed),
          Math.abs(green - centerGreen),
          Math.abs(blue - centerBlue)
        );
        if (shellDistance !== radius) {
          continue;
        }
        callback((red << 16) | (green << 8) | blue);
      }
    }
  }
}

function scoreCandidateDistance(context: MatchingSearchContext, sourceIndex: number, targetIndex: number) {
  let distance = weightedDistance(context.sourcePacked[sourceIndex], context.targetPacked[targetIndex]);

  if (context.analysis) {
    const donorUsefulness = context.analysis.sourceUsefulnessByIndex[sourceIndex];
    const donorNearWhite = context.analysis.sourceNearWhiteByIndex[sourceIndex];
    const targetNeed = context.analysis.targetNeedByIndex[targetIndex];
    const targetFlatBright = context.analysis.targetNearWhiteByIndex[targetIndex] * (1 - targetNeed);

    distance += (1 - donorUsefulness) * targetNeed * 50_000;
    distance += donorNearWhite * targetNeed * 34_000;
    distance += donorUsefulness * targetFlatBright * 14_000;
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
  const { buckets, shift, bucketCount } = buildBucketMap(sourcePacked, quantizationBits);
  const groupedDonorState = buildGroupedDonorState(sourcePacked, shift, analysis);
  const bucketKeys = Uint32Array.from(groupedDonorState.bucketGroups.keys());
  const bucketGroupIndicesByBucket = Array.from(
    bucketKeys,
    (key) => Int32Array.from(groupedDonorState.bucketGroups.get(key) ?? [])
  );
  const bucketRed = new Uint8Array(bucketKeys.length);
  const bucketGreen = new Uint8Array(bucketKeys.length);
  const bucketBlue = new Uint8Array(bucketKeys.length);
  const bucketRemainingGroupCount = new Int32Array(bucketKeys.length);
  const bucketEntryIndexByKey = new Map<number, number>();
  const groupRed = new Uint8Array(groupedDonorState.groupRgbValues.length);
  const groupGreen = new Uint8Array(groupedDonorState.groupRgbValues.length);
  const groupBlue = new Uint8Array(groupedDonorState.groupRgbValues.length);
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

  for (let bucketIndex = 0; bucketIndex < bucketKeys.length; bucketIndex += 1) {
    const key = bucketKeys[bucketIndex];
    bucketEntryIndexByKey.set(key, bucketIndex);
    bucketRed[bucketIndex] = (key >> 16) & 0xff;
    bucketGreen[bucketIndex] = (key >> 8) & 0xff;
    bucketBlue[bucketIndex] = key & 0xff;
    bucketRemainingGroupCount[bucketIndex] = bucketGroupIndicesByBucket[bucketIndex]?.length ?? 0;
  }

  for (let groupIndex = 0; groupIndex < groupedDonorState.groupRgbValues.length; groupIndex += 1) {
    const rgb = groupedDonorState.groupRgbValues[groupIndex];
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
    targetBucketRed[targetIndex] = red >> shift;
    targetBucketGreen[targetIndex] = green >> shift;
    targetBucketBlue[targetIndex] = blue >> shift;
    targetBucketKeyByIndex[targetIndex] =
      (targetBucketRed[targetIndex] << 16) |
      (targetBucketGreen[targetIndex] << 8) |
      targetBucketBlue[targetIndex];
    targetUsefulnessCoefficient[targetIndex] = -targetNeed * 50_000 + targetFlatBright * 14_000;
    targetNearWhiteCoefficient[targetIndex] = targetNeed * 34_000;
    targetPreferMaxUsefulness[targetIndex] = targetUsefulnessCoefficient[targetIndex] < 0 ? 1 : 0;
  }

  return {
    sourcePacked,
    targetPacked,
    buckets,
    bucketGroups: groupedDonorState.bucketGroups,
    bucketGroupIndicesByBucket,
    bucketEntryIndexByKey,
    bucketKeys,
    bucketRed,
    bucketGreen,
    bucketBlue,
    bucketRemainingGroupCount,
    shift,
    bucketCount,
    groupRgbValues: groupedDonorState.groupRgbValues,
    groupRed,
    groupGreen,
    groupBlue,
    groupNearWhiteByGroup: groupedDonorState.groupNearWhiteByGroup,
    groupMinDonorByGroup: groupedDonorState.groupMinDonorByGroup,
    groupMaxDonorByGroup: groupedDonorState.groupMaxDonorByGroup,
    groupRemainingCount: groupedDonorState.groupRemainingCount,
    donorGroupBySource: groupedDonorState.donorGroupBySource,
    donorBucketKeyBySource: groupedDonorState.donorBucketKeyBySource,
    donorNextByUsefulness: groupedDonorState.donorNextByUsefulness,
    donorPrevByUsefulness: groupedDonorState.donorPrevByUsefulness,
    usefulnessBySource: groupedDonorState.usefulnessBySource,
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
    const candidates = context.buckets.get(key);
    if (!candidates) {
      return;
    }

    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const sourceIndex = candidates[candidateIndex];
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

  for (let radius = 0; radius < context.bucketCount && bestIndex === -1; radius += 1) {
    forEachShellBucket(centerRed, centerGreen, centerBlue, radius, context.bucketCount, (key) => {
      const candidates = context.buckets.get(key);
      if (!candidates) {
        return;
      }

      for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const sourceIndex = candidates[candidateIndex];
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
  return context.bucketKeys.length <= 128 && context.bucketKeys.length * 4 <= searchSpaceSize;
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

      const groupIndices = context.bucketGroupIndicesByBucket[bucketIndex];
      if (!groupIndices) {
        continue;
      }

      for (let groupOffset = 0; groupOffset < groupIndices.length; groupOffset += 1) {
        const groupIndex = groupIndices[groupOffset];
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

        let distance = weightedDistanceFromChannels(
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
    for (let radius = 0; radius < context.bucketCount && bestIndex === -1; radius += 1) {
      forEachShellBucket(centerRed, centerGreen, centerBlue, radius, context.bucketCount, (key) => {
        const bucketIndex = context.bucketEntryIndexByKey.get(key);
        if (bucketIndex === undefined) {
          return;
        }

        const groupIndices = context.bucketGroupIndicesByBucket[bucketIndex];
        if (!groupIndices) {
          return;
        }

        for (let groupOffset = 0; groupOffset < groupIndices.length; groupOffset += 1) {
          const groupIndex = groupIndices[groupOffset];
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

          let distance = weightedDistanceFromChannels(
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
  const bucketKey = context.donorBucketKeyBySource[sourceIndex];

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
  if (remainingCount === 0) {
    const bucketIndex = context.bucketEntryIndexByKey.get(bucketKey);
    if (bucketIndex !== undefined) {
      context.bucketRemainingGroupCount[bucketIndex] = Math.max(
        0,
        context.bucketRemainingGroupCount[bucketIndex] - 1
      );
    }
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
  context: MatchingSearchContext,
  targetOrder: Uint32Array,
  rankedCandidatesByTarget: Array<RankedCandidate[] | undefined>,
  hooks?: TransformHooks
) {
  const assignment = new Uint32Array(context.targetPacked.length);
  const used = new Uint8Array(context.sourcePacked.length);
  const freeList = createFreeList(context.sourcePacked.length);
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
    throw new TransformError('Source and target working dimensions must match.');
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
    pixelCount: packedMatch.assignment.length,
    timingsMs,
    matcherStrategy: 'single-optimized',
    matcherStats: packedMatch.matcherStats,
    workerCount: 1
  };
}
