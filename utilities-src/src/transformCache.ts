import type { TransformPresetId } from './types';
import type { TransformRenderPlan } from './transformRenderPlan';
import type { ImageSelection } from './uiState';
import type { WorkerSuccessMessage } from './workerTypes';
import { arrayBufferLikeToArrayBuffer, copyArrayBuffer } from './bufferUtils';

export interface CachedBuiltInTransform {
  message: WorkerSuccessMessage;
  finalPixels: ArrayBuffer;
  tintStrengthByTarget: ArrayBuffer;
  cheatedTargetPixels: ArrayBuffer;
}

export interface SerializedPrecomputedBuiltInTransform {
  metadata: WorkerSuccessMessage['metadata'];
  assignment: string;
  finalPixels: string;
  tintStrengthByTarget: string;
  cheatedTargetPixels: string;
}

export interface HydratedPrecomputedBuiltInTransform {
  metadata: WorkerSuccessMessage['metadata'];
  assignment: ArrayBuffer;
  finalPixels: ArrayBuffer;
  tintStrengthByTarget: ArrayBuffer;
  cheatedTargetPixels: ArrayBuffer;
}

function arrayBufferToBase64(buffer: ArrayBufferLike) {
  const bytes = new Uint8Array(arrayBufferLikeToArrayBuffer(buffer));
  // Buffer is available during Node cache generation; browser builds use btoa.
  // The 32KB fallback chunks stay below V8's ~65K apply/spread argument limit.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  const chunkSize = 0x8000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)));
  }
  return btoa(chunks.join(''));
}

function base64ToArrayBuffer(value: string) {
  if (typeof Buffer !== 'undefined') {
    const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
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

  return `${presetId}\u001f${sourceSelection.url}\u001f${targetSelection.url}`;
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
      pixels: copyArrayBuffer(message.source.pixels)
    },
    target: {
      ...message.target,
      pixels: copyArrayBuffer(message.target.pixels)
    },
    assignment: copyArrayBuffer(message.assignment)
  };
}

export function createCachedBuiltInTransform(
  message: WorkerSuccessMessage,
  renderPlan: TransformRenderPlan
): CachedBuiltInTransform {
  return {
    message: cloneWorkerSuccessMessage(message),
    finalPixels: copyArrayBuffer(renderPlan.finalPixels.buffer),
    tintStrengthByTarget: copyArrayBuffer(renderPlan.tintStrengthByTarget.buffer),
    cheatedTargetPixels: copyArrayBuffer(renderPlan.cheatedTargetPixels.buffer)
  };
}

export function cloneCachedBuiltInTransform(
  cached: CachedBuiltInTransform,
  requestId: number = cached.message.requestId
): CachedBuiltInTransform {
  return {
    message: cloneWorkerSuccessMessage(cached.message, requestId),
    finalPixels: copyArrayBuffer(cached.finalPixels),
    tintStrengthByTarget: copyArrayBuffer(cached.tintStrengthByTarget),
    cheatedTargetPixels: copyArrayBuffer(cached.cheatedTargetPixels)
  };
}

export function serializePrecomputedBuiltInTransform(
  message: WorkerSuccessMessage,
  renderPlan: TransformRenderPlan
): SerializedPrecomputedBuiltInTransform {
  return {
    metadata: message.metadata,
    assignment: arrayBufferToBase64(message.assignment),
    finalPixels: arrayBufferToBase64(renderPlan.finalPixels.buffer),
    tintStrengthByTarget: arrayBufferToBase64(renderPlan.tintStrengthByTarget.buffer),
    cheatedTargetPixels: arrayBufferToBase64(renderPlan.cheatedTargetPixels.buffer)
  };
}

export function hydratePrecomputedBuiltInTransform(
  serialized: SerializedPrecomputedBuiltInTransform
): HydratedPrecomputedBuiltInTransform {
  return {
    metadata: serialized.metadata,
    assignment: base64ToArrayBuffer(serialized.assignment),
    finalPixels: base64ToArrayBuffer(serialized.finalPixels),
    tintStrengthByTarget: base64ToArrayBuffer(serialized.tintStrengthByTarget),
    cheatedTargetPixels: base64ToArrayBuffer(serialized.cheatedTargetPixels)
  };
}
