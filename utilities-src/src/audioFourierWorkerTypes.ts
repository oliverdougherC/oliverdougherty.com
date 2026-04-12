import type { AudioFourierPresetId, BuiltInAudioPresetId } from './audioPresets';

export interface AudioFourierSourceTransfer {
  sampleRate: number;
  channelBuffers: ArrayBuffer[];
  label: string;
  sourceKind: 'preset' | 'file';
  builtInPresetId?: BuiltInAudioPresetId;
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
    analysisId: number;
    presetId: AudioFourierPresetId;
    label: string;
    sourceKind: 'preset' | 'file';
    sourceDurationSeconds: number;
    proxyDurationSeconds: number;
    proxySampleRate: number;
    proxySampleCount: number;
    componentCount: number;
    bandCount: number;
    displaySampleCount: number;
    frameCount: number;
    frameSize: number;
    hopSize: number;
    sliderSteps: number;
    timingsMs: {
      proxy: number;
      analysis: number;
      bands: number;
      total: number;
    };
  };
  originalSamples: ArrayBuffer;
  bandSamples: ArrayBuffer;
  bandEndComponentCounts: ArrayBuffer;
  bandEnergyFractions: ArrayBuffer;
  fullMixFrame: ArrayBuffer;
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
