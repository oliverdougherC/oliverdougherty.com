import type { PreparedImageTransfer, TransformMetadata, TransformPresetId } from './types';

export interface TransformBitmapRequest {
  type: 'transform';
  requestId: number;
  presetId: TransformPresetId;
  sourceBitmap: ImageBitmap;
  targetBitmap: ImageBitmap;
}

export interface TransformPreparedRequest {
  type: 'transform-prepared';
  requestId: number;
  presetId: TransformPresetId;
  source: PreparedImageTransfer;
  target: PreparedImageTransfer;
}

export interface CancelRequest {
  type: 'cancel';
  requestId: number;
}

export type WorkerRequest = TransformBitmapRequest | TransformPreparedRequest | CancelRequest;

export interface WorkerProgressMessage {
  type: 'progress';
  requestId: number;
  stage: 'decoding' | 'matching';
  progress: number;
  message: string;
}

export interface WorkerSuccessMessage {
  type: 'success';
  requestId: number;
  source: PreparedImageTransfer;
  target: PreparedImageTransfer;
  assignment: ArrayBuffer;
  metadata: TransformMetadata;
}

export interface WorkerErrorMessage {
  type: 'error';
  requestId: number;
  message: string;
}

export interface WorkerCancelledMessage {
  type: 'cancelled';
  requestId: number;
}

export type WorkerResponse =
  | WorkerProgressMessage
  | WorkerSuccessMessage
  | WorkerErrorMessage
  | WorkerCancelledMessage;
