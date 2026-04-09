import type { TransformPresetId } from './types';
import type { ImageSelection } from './uiState';
import type { WorkerSuccessMessage } from './workerTypes';

function cloneArrayBuffer(buffer: ArrayBuffer) {
  return buffer.slice(0);
}

export function buildBuiltInTransformCacheKey(
  sourceSelection: ImageSelection | null,
  targetSelection: ImageSelection | null,
  presetId: TransformPresetId
) {
  if (
    !sourceSelection ||
    !targetSelection ||
    sourceSelection.kind !== 'demo' ||
    targetSelection.kind !== 'demo' ||
    !sourceSelection.url ||
    !targetSelection.url
  ) {
    return null;
  }

  return `${presetId}::${sourceSelection.url}::${targetSelection.url}`;
}

export function cloneWorkerSuccessMessage(
  message: WorkerSuccessMessage,
  requestId: number = message.requestId
): WorkerSuccessMessage {
  return {
    ...message,
    requestId,
    source: {
      ...message.source,
      pixels: cloneArrayBuffer(message.source.pixels)
    },
    target: {
      ...message.target,
      pixels: cloneArrayBuffer(message.target.pixels)
    },
    assignment: cloneArrayBuffer(message.assignment)
  };
}
