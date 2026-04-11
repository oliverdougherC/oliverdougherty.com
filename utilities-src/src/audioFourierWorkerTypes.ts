import type { AudioFourierPresetId, GeneratedAudioPresetId } from './audioPresets';

export interface AudioFourierSourceTransfer {
  sampleRate: number;
  channelBuffers: ArrayBuffer[];
  label: string;
  sourceKind: 'preset' | 'file';
  generatedPresetId?: GeneratedAudioPresetId;
}

export interface AudioFourierAnalyzeRequest {
  type: 'analyze-audio-fourier';
  requestId: number;
  presetId: AudioFourierPresetId;
  source: AudioFourierSourceTransfer;
}

export interface AudioFourierCancelRequest {
  type: 'cancel-audio-fourier';
  requestId: number;
}

export type AudioFourierWorkerRequest = AudioFourierAnalyzeRequest | AudioFourierCancelRequest;

export interface AudioFourierProgressMessage {
  type: 'audio-fourier-progress';
  requestId: number;
  progress: number;
  message: string;
}

export interface AudioFourierSuccessMessage {
  type: 'audio-fourier-success';
  requestId: number;
  metadata: {
    presetId: AudioFourierPresetId;
    label: string;
    sourceKind: 'preset' | 'file';
    sourceDurationSeconds: number;
    segmentStartSeconds: number;
    segmentDurationSeconds: number;
    sampleRate: number;
    sampleCount: number;
    componentCount: number;
    displaySampleCount: number;
    visualFrameCount: number;
    playbackDurationSeconds: number;
    timingsMs: {
      segment: number;
      fft: number;
      reconstruction: number;
      total: number;
    };
  };
  visualFrames: ArrayBuffer;
  finalFrame: ArrayBuffer;
  playbackSamples: ArrayBuffer;
  frameComponentCounts: ArrayBuffer;
  componentFrequencies: ArrayBuffer;
  componentAmplitudes: ArrayBuffer;
  componentPhases: ArrayBuffer;
  componentEnergies: ArrayBuffer;
}

export interface AudioFourierErrorMessage {
  type: 'audio-fourier-error';
  requestId: number;
  message: string;
}

export interface AudioFourierCancelledMessage {
  type: 'audio-fourier-cancelled';
  requestId: number;
}

export type AudioFourierWorkerResponse =
  | AudioFourierProgressMessage
  | AudioFourierSuccessMessage
  | AudioFourierErrorMessage
  | AudioFourierCancelledMessage;

