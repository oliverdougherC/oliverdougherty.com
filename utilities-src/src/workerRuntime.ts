import { getPreset } from './presets';
import { transformPreparedImages } from './transformCore';
import type { PreparedImageData, PreparedImageTransfer, TransformMetadata } from './types';
import type { WorkerRequest, WorkerResponse } from './workerTypes';

class CancelledTransformError extends Error {
  constructor() {
    super('Transform cancelled.');
  }
}

function asArrayBuffer(buffer: ArrayBufferLike) {
  return buffer as ArrayBuffer;
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
    pixels: asArrayBuffer(image.pixels.buffer),
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
    const postProgress = (stage: 'decoding' | 'matching', progress: number, message: string) => {
      options.postMessage({
        type: 'progress',
        requestId,
        stage,
        progress,
        message
      });
    };

    try {
      postProgress('decoding', 0.02, 'Decoding images…');

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

      postProgress(
        'matching',
        0.08,
        `Matching ${preparedTarget.width}×${preparedTarget.height} working pixels…`
      );

      const startedAt = performance.now();
      const result = transformPreparedImages(preparedSource, preparedTarget, preset.quantizationBits, {
        isCancelled,
        onProgress(completed, total) {
          postProgress('matching', completed / total, `Matching pixels… ${completed}/${total}`);
        }
      });
      const processingMs = performance.now() - startedAt;

      if (isCancelled()) {
        throw new CancelledTransformError();
      }

      const metadata: TransformMetadata = {
        presetId: preset.id,
        quantizationBits: preset.quantizationBits,
        outputWidth: result.source.width,
        outputHeight: result.source.height,
        pixelCount: result.pixelCount,
        sourceOriginalWidth,
        sourceOriginalHeight,
        targetOriginalWidth,
        targetOriginalHeight,
        sourceScaled,
        targetScaled,
        processingMs
      };

      const sourceTransfer = deflatePreparedImage(
        result.source,
        sourceOriginalWidth,
        sourceOriginalHeight,
        sourceScaled
      );
      const targetTransfer = deflatePreparedImage(
        result.target,
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
          assignment: asArrayBuffer(result.assignment.buffer),
          metadata
        },
        [sourceTransfer.pixels, targetTransfer.pixels, asArrayBuffer(result.assignment.buffer)]
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
