import type { TransformPresetId } from './types';
import type { TransformRenderPlan } from './transformRenderPlan';
import type { ImageSelection } from './uiState';
import type { WorkerSuccessMessage } from './workerTypes';

function cloneArrayBuffer(buffer: ArrayBufferLike) {
  return buffer.slice(0) as ArrayBuffer;
}

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
  const bytes = new Uint8Array(buffer as ArrayBuffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (let index = 0; index < bytes.length; index += 1) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string) {
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(value, 'base64')).buffer;
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
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

export function createCachedBuiltInTransform(
  message: WorkerSuccessMessage,
  renderPlan: TransformRenderPlan
): CachedBuiltInTransform {
  return {
    message: cloneWorkerSuccessMessage(message),
    finalPixels: cloneArrayBuffer(renderPlan.finalPixels.buffer),
    tintStrengthByTarget: cloneArrayBuffer(renderPlan.tintStrengthByTarget.buffer),
    cheatedTargetPixels: cloneArrayBuffer(renderPlan.cheatedTargetPixels.buffer)
  };
}

export function cloneCachedBuiltInTransform(
  cached: CachedBuiltInTransform,
  requestId: number = cached.message.requestId
): CachedBuiltInTransform {
  return {
    message: cloneWorkerSuccessMessage(cached.message, requestId),
    finalPixels: cloneArrayBuffer(cached.finalPixels),
    tintStrengthByTarget: cloneArrayBuffer(cached.tintStrengthByTarget),
    cheatedTargetPixels: cloneArrayBuffer(cached.cheatedTargetPixels)
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
