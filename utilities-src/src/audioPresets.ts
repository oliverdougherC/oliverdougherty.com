import type { AudioChannels } from './audioSignal';

export type GeneratedAudioPresetId = 'harmonic-chord' | 'bass-pulse' | 'bell-sweep' | 'vowel-stack';
export type AudioFourierPresetId = 'fast' | 'balanced' | 'detailed';

export interface GeneratedAudioPreset {
  id: GeneratedAudioPresetId;
  label: string;
  description: string;
}

export interface AudioFourierPreset {
  id: AudioFourierPresetId;
  label: string;
  proxySampleRate: number;
  maxProxySampleCount: number;
  maxDurationSeconds: number;
  frameSize: number;
  hopSize: number;
  displaySampleCount: number;
  sliderSteps: number;
  energyBandCount: number;
}

export const GENERATED_AUDIO_PRESETS: Record<GeneratedAudioPresetId, GeneratedAudioPreset> = {
  'harmonic-chord': {
    id: 'harmonic-chord',
    label: 'Harmonic chord',
    description: 'Layered sine harmonics with a slow phase bloom.'
  },
  'bass-pulse': {
    id: 'bass-pulse',
    label: 'Bass pulse',
    description: 'Sub pulses and crisp upper harmonics.'
  },
  'bell-sweep': {
    id: 'bell-sweep',
    label: 'Bell sweep',
    description: 'Inharmonic partials with a bright decay.'
  },
  'vowel-stack': {
    id: 'vowel-stack',
    label: 'Vowel stack',
    description: 'Voice-like formants shaped from harmonic bands.'
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
    sliderSteps: 100,
    energyBandCount: 12
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
    sliderSteps: 100,
    energyBandCount: 12
  }
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function envelope(time: number, duration: number) {
  const attack = clamp(time / 0.18, 0, 1);
  const release = clamp((duration - time) / 0.72, 0, 1);
  return Math.sin(attack * Math.PI * 0.5) * Math.sin(release * Math.PI * 0.5);
}

function softClip(value: number) {
  return Math.tanh(value * 1.15);
}

export function getAudioFourierPreset(id: AudioFourierPresetId) {
  return AUDIO_FOURIER_PRESETS[id];
}

export function buildGeneratedAudioPreset(id: GeneratedAudioPresetId, durationSeconds = 8, sampleRate = 22_050): AudioChannels {
  const sampleCount = Math.round(durationSeconds * sampleRate);
  const samples = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const phase = time / durationSeconds;
    let value = 0;

    if (id === 'harmonic-chord') {
      const root = 146.83;
      const notes = [1, 5 / 4, 3 / 2, 2, 5 / 2];
      for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
        const frequency = root * notes[noteIndex] * (1 + 0.002 * Math.sin(time * 0.7 + noteIndex));
        value += Math.sin(2 * Math.PI * frequency * time + noteIndex * 0.31) * (0.34 / (noteIndex + 1));
      }
      value += Math.sin(2 * Math.PI * 36.7 * time) * 0.08;
    } else if (id === 'bass-pulse') {
      const pulse = 0.45 + 0.55 * Math.max(0, Math.sin(2 * Math.PI * 1.35 * time));
      value += Math.sin(2 * Math.PI * 55 * time) * 0.5 * pulse;
      value += Math.sin(2 * Math.PI * 110 * time + 0.4) * 0.22 * pulse;
      value += Math.sin(2 * Math.PI * 660 * time) * 0.08 * Math.pow(pulse, 4);
    } else if (id === 'bell-sweep') {
      const base = 220 + 80 * Math.sin(phase * Math.PI);
      const partials = [1, 2.01, 2.76, 4.22, 5.47, 7.12];
      for (let partialIndex = 0; partialIndex < partials.length; partialIndex += 1) {
        const decay = Math.exp(-phase * (1.3 + partialIndex * 0.38));
        value += Math.sin(2 * Math.PI * base * partials[partialIndex] * time) * decay * (0.34 / (partialIndex + 1));
      }
    } else {
      const fundamental = 118;
      const formants = [620, 1040, 2460];
      for (let harmonic = 1; harmonic <= 28; harmonic += 1) {
        const frequency = fundamental * harmonic;
        let weight = 0;
        for (const formant of formants) {
          const distance = (frequency - formant) / 150;
          weight += Math.exp(-distance * distance);
        }
        value += Math.sin(2 * Math.PI * frequency * time + harmonic * 0.09) * weight * 0.04;
      }
      value += Math.sin(2 * Math.PI * fundamental * time) * 0.18;
    }

    samples[index] = softClip(value * envelope(time, durationSeconds));
  }

  return {
    sampleRate,
    channels: [samples]
  };
}
