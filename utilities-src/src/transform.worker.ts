/// <reference lib="webworker" />

import { createWorkerRequestHandler, type PreparedBitmapResult } from './workerRuntime';
import { resolveOutputDimensions } from './transformCore';

function drawBitmapToPixels(bitmap: ImageBitmap, width: number, height: number) {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) {
    throw new Error('Unable to create an offscreen 2D context.');
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.clearRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);

  return {
    width,
    height,
    pixels: imageData.data
  };
}

async function prepareBitmaps(
  sourceBitmap: ImageBitmap,
  targetBitmap: ImageBitmap,
  maxDimension: number
): Promise<PreparedBitmapResult> {
  const sourceOriginalWidth = sourceBitmap.width;
  const sourceOriginalHeight = sourceBitmap.height;
  const targetOriginalWidth = targetBitmap.width;
  const targetOriginalHeight = targetBitmap.height;
  const outputSize = resolveOutputDimensions(targetOriginalWidth, targetOriginalHeight, maxDimension);
  const source = drawBitmapToPixels(sourceBitmap, outputSize.width, outputSize.height);
  const target = drawBitmapToPixels(targetBitmap, outputSize.width, outputSize.height);

  sourceBitmap.close();
  targetBitmap.close();

  return {
    source,
    target,
    sourceOriginalWidth,
    sourceOriginalHeight,
    targetOriginalWidth,
    targetOriginalHeight,
    sourceScaled: sourceOriginalWidth !== outputSize.width || sourceOriginalHeight !== outputSize.height,
    targetScaled: targetOriginalWidth !== outputSize.width || targetOriginalHeight !== outputSize.height
  };
}

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const handleWorkerRequest = createWorkerRequestHandler({
  prepareBitmaps,
  createMatchingWorker() {
    return new Worker(new URL('./matching.worker.ts', import.meta.url), {
      type: 'module'
    });
  },
  postMessage(message, transfer) {
    workerScope.postMessage(message, transfer ?? []);
  }
});

workerScope.onmessage = (event: MessageEvent) => {
  void handleWorkerRequest(event.data);
};
