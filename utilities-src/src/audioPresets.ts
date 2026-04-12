export type BuiltInAudioPresetId = 'harmonic-chord' | 'bass-pulse' | 'bell-sweep' | 'vowel-stack';
export type AudioFourierPresetId = 'fast' | 'balanced' | 'detailed';

export interface BuiltInAudioPreset {
  id: BuiltInAudioPresetId;
  label: string;
  description: string;
  sampleRate: number;
  durationSeconds: number;
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

export const DEFAULT_BUILT_IN_AUDIO_PRESET_ID: BuiltInAudioPresetId = 'harmonic-chord';

export const BUILT_IN_AUDIO_PRESETS: Record<BuiltInAudioPresetId, BuiltInAudioPreset> = {
  'harmonic-chord': {
    id: 'harmonic-chord',
    label: 'Harmonic chord',
    description: 'Layered harmonic tones with slow amplitude movement.',
    sampleRate: 44_100,
    durationSeconds: 10
  },
  'bass-pulse': {
    id: 'bass-pulse',
    label: 'Bass pulse',
    description: 'Low-frequency pulses with a light syncopated overtone.',
    sampleRate: 44_100,
    durationSeconds: 10
  },
  'bell-sweep': {
    id: 'bell-sweep',
    label: 'Bell sweep',
    description: 'Decaying bell partials over a rising sweep.',
    sampleRate: 44_100,
    durationSeconds: 10
  },
  'vowel-stack': {
    id: 'vowel-stack',
    label: 'Vowel stack',
    description: 'Formant-like bands that drift through a synthetic vowel.',
    sampleRate: 44_100,
    durationSeconds: 10
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

export function getAudioFourierPreset(id: AudioFourierPresetId) {
  return AUDIO_FOURIER_PRESETS[id];
}

function envelope(phase: number) {
  const attack = Math.min(1, phase / 0.04);
  const release = Math.min(1, (1 - phase) / 0.08);
  return Math.max(0, Math.min(attack, release));
}

function pulse(phase: number, duty = 0.38) {
  const wrapped = phase - Math.floor(phase);
  const edge = 0.04;
  if (wrapped < duty) {
    return Math.min(1, wrapped / edge, (duty - wrapped) / edge);
  }
  return 0;
}

function tone(frequency: number, time: number, phase = 0) {
  return Math.sin(2 * Math.PI * frequency * time + phase);
}

export function buildGeneratedAudioPresetChannels(id: BuiltInAudioPresetId) {
  const preset = BUILT_IN_AUDIO_PRESETS[id];
  const sampleCount = Math.round(preset.sampleRate * preset.durationSeconds);
  const left = new Float32Array(sampleCount);
  const right = new Float32Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / preset.sampleRate;
    const phase = time / preset.durationSeconds;
    const amp = envelope(phase);
    let mono = 0;
    let pan = 0;

    if (id === 'harmonic-chord') {
      const wobble = 1 + 0.012 * tone(0.23, time);
      mono =
        0.34 * tone(220 * wobble, time) +
        0.24 * tone(277.18 * wobble, time, 0.4) +
        0.2 * tone(329.63 * wobble, time, 0.8) +
        0.12 * tone(440 * wobble, time, 1.2);
      mono *= 0.74 + 0.18 * tone(0.7, time);
      pan = 0.2 * tone(0.11, time);
    } else if (id === 'bass-pulse') {
      const beat = pulse(time * 2, 0.34);
      const offBeat = pulse(time * 2 + 0.5, 0.22);
      mono =
        (0.58 * tone(55, time) + 0.18 * tone(110, time) + 0.08 * tone(220, time)) * beat +
        (0.25 * tone(82.41, time, 0.2) + 0.1 * tone(164.82, time)) * offBeat +
        0.06 * tone(660, time) * pulse(time * 4 + 0.25, 0.1);
      pan = 0.12 * tone(0.5, time);
    } else if (id === 'bell-sweep') {
      const strike = Math.exp(-((time % 2.5) / 0.95));
      const sweep = 180 + 520 * phase;
      mono =
        0.28 * tone(sweep, time) +
        strike * (
          0.34 * tone(523.25, time) +
          0.19 * tone(784.88, time, 0.3) +
          0.11 * tone(1177.32, time, 0.6) +
          0.08 * tone(1661.22, time, 0.9)
        );
      pan = 0.3 * tone(0.17, time);
    } else {
      const root = 120 + 20 * tone(0.09, time);
      const formantA = 650 + 80 * tone(0.13, time);
      const formantB = 1100 + 140 * tone(0.07, time, 0.7);
      const formantC = 2450 + 190 * tone(0.05, time, 1.1);
      mono =
        0.3 * tone(root, time) +
        0.26 * tone(formantA, time, 0.15) +
        0.2 * tone(formantB, time, 0.55) +
        0.12 * tone(formantC, time, 1.05);
      mono *= 0.72 + 0.16 * tone(1.2, time);
      pan = 0.24 * tone(0.19, time);
    }

    const shaped = Math.max(-1, Math.min(1, mono * amp));
    left[index] = shaped * (1 - Math.max(0, pan) * 0.35);
    right[index] = shaped * (1 + Math.min(0, pan) * 0.35);
  }

  return {
    sampleRate: preset.sampleRate,
    channels: [left, right]
  };
}
