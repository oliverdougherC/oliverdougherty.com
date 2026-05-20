import type { WindowedFourierOptions } from './audioFourierCore';

export type BuiltInAudioPresetId = 'best-friends' | 'i-cant-wait-to-get-there' | 'tell-your-friends';
export type AudioFourierPresetId = 'fast' | 'balanced' | 'detailed';

export interface BuiltInAudioPreset {
  id: BuiltInAudioPresetId;
  label: string;
  description: string;
  url: string;
}

export interface AudioFourierPreset extends WindowedFourierOptions {
  id: AudioFourierPresetId;
  label: string;
  proxySampleRate: number;
  maxProxySampleCount: number;
  maxDurationSeconds: number;
  sliderSteps: number;
  energyBandCount: number;
}

const FOURIER_DECOMPOSE_ASSET_BASE = '../../assets/utilities/fourier-decompose';

export const DEFAULT_BUILT_IN_AUDIO_PRESET_ID: BuiltInAudioPresetId = 'best-friends';

export const BUILT_IN_AUDIO_PRESETS: Record<BuiltInAudioPresetId, BuiltInAudioPreset> = {
  'best-friends': {
    id: 'best-friends',
    label: 'Best Friends',
    description: 'Song source for Fourier proxy reconstruction.',
    url: `${FOURIER_DECOMPOSE_ASSET_BASE}/Best Friends.flac`
  },
  'i-cant-wait-to-get-there': {
    id: 'i-cant-wait-to-get-there',
    label: "I Can't Wait To Get There",
    description: 'Song source for Fourier proxy reconstruction.',
    url: `${FOURIER_DECOMPOSE_ASSET_BASE}/I Can't Wait To Get There.flac`
  },
  'tell-your-friends': {
    id: 'tell-your-friends',
    label: 'Tell Your Friends',
    description: 'Song source for Fourier proxy reconstruction.',
    url: `${FOURIER_DECOMPOSE_ASSET_BASE}/Tell Your Friends.flac`
  }
};

export const AUDIO_FOURIER_PRESETS: Record<AudioFourierPresetId, AudioFourierPreset> = {
  fast: {
    id: 'fast',
    label: 'Fast',
    proxySampleRate: 8000,
    maxProxySampleCount: 2_800_000,
    maxDurationSeconds: 8 * 60,
    frameSize: 1024,
    hopSize: 512,
    displaySampleCount: 768,
    sliderSteps: 80,
    energyBandCount: 8
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    proxySampleRate: 22_050,
    maxProxySampleCount: 7_000_000,
    maxDurationSeconds: 8 * 60,
    frameSize: 2048,
    hopSize: 1024,
    displaySampleCount: 1024,
    sliderSteps: 100,
    energyBandCount: 12
  },
  detailed: {
    id: 'detailed',
    label: 'Detailed',
    proxySampleRate: 32_000,
    maxProxySampleCount: 8_000_000,
    maxDurationSeconds: 8 * 60,
    frameSize: 4096,
    hopSize: 2048,
    displaySampleCount: 1280,
    sliderSteps: 120,
    energyBandCount: 20
  }
};

export function isAudioFourierPresetId(id: string): id is AudioFourierPresetId {
  return Object.prototype.hasOwnProperty.call(AUDIO_FOURIER_PRESETS, id);
}

export function isBuiltInAudioPresetId(id: string): id is BuiltInAudioPresetId {
  return Object.prototype.hasOwnProperty.call(BUILT_IN_AUDIO_PRESETS, id);
}

export function getAudioFourierPreset(id: string): AudioFourierPreset {
  if (!isAudioFourierPresetId(id)) {
    throw new Error(`Unknown audio Fourier preset: ${id}`);
  }
  return AUDIO_FOURIER_PRESETS[id];
}
