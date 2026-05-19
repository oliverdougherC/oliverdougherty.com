import { getPreset } from './presets';
import { transformPreparedImages } from './transformCore';
import type { MatchingWorkerLike } from './parallelMatcher';
import type { PreparedImageData, PreparedImageTransfer, TransformMetadata } from './types';
import type { WorkerRequest, WorkerResponse } from './workerTypes';
import { arrayBufferLikeToArrayBuffer, sliceArrayBufferView } from './bufferUtils';

class CancelledTransformError extends Error {
  constructor() {
    super('Transform cancelled.');
  }
}

export interface PreparedBitmapResult {
  source: PreparedImageData;
  target: PreparedImageData;
  sourceOriginalWidth: number;
  sourceOriginalHeight: number;
  targetOriginalWidth: number;
  targetOriginalHeight: number;
  sourceScaled: boolean;
  targetScaled: boolean;
}

function inflatePreparedImage(transfer: PreparedImageTransfer): PreparedImageData {
  return {
    width: transfer.width,
    height: transfer.height,
    pixels: new Uint8ClampedArray(transfer.pixels)
  };
}

function deflatePreparedImage(
  image: PreparedImageData,
  originalWidth: number,
  originalHeight: number,
  scaled: boolean
): PreparedImageTransfer {
  return {
    width: image.width,
    height: image.height,
    pixels: sliceArrayBufferView(image.pixels),
    originalWidth,
    originalHeight,
    scaled
  };
}

export function createWorkerRequestHandler(options: {
  prepareBitmaps: (
    sourceBitmap: ImageBitmap,
    targetBitmap: ImageBitmap,
    maxDimension: number
  ) => Promise<PreparedBitmapResult>;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
  createMatchingWorker?: () => MatchingWorkerLike;
  hardwareConcurrency?: number;
  supportsNestedWorkers?: boolean;
  experimentalParallelEnabled?: boolean;
}) {
  const cancelled = new Set<number>();

  return async function handleWorkerRequest(request: WorkerRequest) {
    if (request.type === 'cancel') {
      cancelled.add(request.requestId);
      return;
    }

    const requestId = request.requestId;
    const preset = getPreset(request.presetId);
    const isCancelled = () => cancelled.has(requestId);
    const postProgress = (
      stage: 'decoding' | 'analyzing' | 'ranking' | 'assigning',
      progress: number,
      message: string
    ) => {
      options.postMessage({
        type: 'progress',
        requestId,
        stage,
        progress,
        message
      });
    };

    try {
      const decodeStartedAt = performance.now();
      postProgress('decoding', 0.02, 'Preparing working image data…');

      let preparedSource: PreparedImageData;
      let preparedTarget: PreparedImageData;
      let sourceOriginalWidth: number;
      let sourceOriginalHeight: number;
      let targetOriginalWidth: number;
      let targetOriginalHeight: number;
      let sourceScaled: boolean;
      let targetScaled: boolean;

      if (request.type === 'transform') {
        const prepared = await options.prepareBitmaps(
          request.sourceBitmap,
          request.targetBitmap,
          preset.maxDimension
        );

        preparedSource = prepared.source;
        preparedTarget = prepared.target;
        sourceOriginalWidth = prepared.sourceOriginalWidth;
        sourceOriginalHeight = prepared.sourceOriginalHeight;
        targetOriginalWidth = prepared.targetOriginalWidth;
        targetOriginalHeight = prepared.targetOriginalHeight;
        sourceScaled = prepared.sourceScaled;
        targetScaled = prepared.targetScaled;
      } else {
        preparedSource = inflatePreparedImage(request.source);
        preparedTarget = inflatePreparedImage(request.target);
        sourceOriginalWidth = request.source.originalWidth;
        sourceOriginalHeight = request.source.originalHeight;
        targetOriginalWidth = request.target.originalWidth;
        targetOriginalHeight = request.target.originalHeight;
        sourceScaled = request.source.scaled;
        targetScaled = request.target.scaled;
      }

      if (isCancelled()) {
        throw new CancelledTransformError();
      }

      const decodeMs = performance.now() - decodeStartedAt;
      const result = transformPreparedImages(preparedSource, preparedTarget, preset.quantizationBits, {
        isCancelled,
        onStageProgress(stage, progress, message) {
          const stageWeight =
            stage === 'analyzing'
              ? { start: 0.12, span: 0.14 }
              : stage === 'ranking'
                ? { start: 0.26, span: 0.22 }
                : { start: 0.48, span: 0.52 };
          postProgress(stage, stageWeight.start + progress * stageWeight.span, message);
        }
      });

      let workerCount = 1;
      let matcherStrategy = result.matcherStrategy;
      let fallbackCount = result.matcherStats.fallbackCount;
      let shortlistHitRate = result.matcherStats.shortlistHitRate;
      let evaluatedCandidateCount = result.matcherStats.evaluatedCandidateCount;
      let evaluatedGroupCount = result.matcherStats.evaluatedGroupCount;
      let averageGroupsPerTarget = result.matcherStats.averageGroupsPerTarget;
      let timingsMs = {
        ...result.timingsMs,
        decode: decodeMs,
        total: decodeMs + result.timingsMs.total
      };
      let assignment = result.assignment;

      if (isCancelled()) {
        throw new CancelledTransformError();
      }

      const metadata: TransformMetadata = {
        presetId: preset.id,
        quantizationBits: preset.quantizationBits,
        outputWidth: preparedSource.width,
        outputHeight: preparedSource.height,
        pixelCount: assignment.length,
        sourceOriginalWidth,
        sourceOriginalHeight,
        targetOriginalWidth,
        targetOriginalHeight,
        sourceScaled,
        targetScaled,
        processingMs: timingsMs.total,
        timingsMs,
        matcherStrategy,
        fallbackCount,
        shortlistHitRate,
        evaluatedCandidateCount,
        evaluatedGroupCount,
        averageGroupsPerTarget,
        workerCount
      };

      const sourceTransfer = deflatePreparedImage(
        preparedSource,
        sourceOriginalWidth,
        sourceOriginalHeight,
        sourceScaled
      );
      const targetTransfer = deflatePreparedImage(
        preparedTarget,
        targetOriginalWidth,
        targetOriginalHeight,
        targetScaled
      );

      options.postMessage(
        {
          type: 'success',
          requestId,
          source: sourceTransfer,
          target: targetTransfer,
          assignment: arrayBufferLikeToArrayBuffer(assignment.buffer),
          metadata
        },
        [sourceTransfer.pixels, targetTransfer.pixels, arrayBufferLikeToArrayBuffer(assignment.buffer)]
      );
    } catch (error) {
      if (error instanceof CancelledTransformError) {
        options.postMessage({
          type: 'cancelled',
          requestId
        });
        return;
      }

      options.postMessage({
        type: 'error',
        requestId,
        message: error instanceof Error ? error.message : 'Unknown worker error.'
      });
    } finally {
      cancelled.delete(requestId);
    }
  };
}
