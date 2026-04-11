import { fft } from './fft';

export interface FourierComponent {
  positiveBin: number;
  negativeBin: number;
  frequencyHz: number;
  amplitude: number;
  phase: number;
  energy: number;
}

export interface AudioFourierAnalysis {
  sampleRate: number;
  samples: Float32Array;
  components: FourierComponent[];
  spectrumReal: Float32Array;
  spectrumImag: Float32Array;
}

export interface AudioFourierReconstructionOptions {
  visualFrameCount: number;
  playbackFrameCount: number;
  displaySampleCount: number;
}

export interface AudioFourierReconstruction {
  analysis: AudioFourierAnalysis;
  finalSamples: Float32Array;
  visualFrames: Float32Array;
  frameComponentCounts: Uint32Array;
  playbackSamples: Float32Array;
  componentFrequencies: Float32Array;
  componentAmplitudes: Float32Array;
  componentPhases: Float32Array;
  componentEnergies: Float32Array;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(value: number) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function assertPowerOfTwo(size: number) {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new Error('Audio Fourier analysis requires a power-of-two sample count.');
  }
}

function downsampleForDisplay(samples: Float32Array, displaySampleCount: number) {
  const output = new Float32Array(displaySampleCount);
  const scale = samples.length / displaySampleCount;

  for (let index = 0; index < displaySampleCount; index += 1) {
    const start = Math.floor(index * scale);
    const end = Math.max(start + 1, Math.floor((index + 1) * scale));
    let peak = 0;

    for (let sourceIndex = start; sourceIndex < end && sourceIndex < samples.length; sourceIndex += 1) {
      const value = samples[sourceIndex];
      if (Math.abs(value) > Math.abs(peak)) {
        peak = value;
      }
    }

    output[index] = peak;
  }

  return output;
}

export function analyzeAudioFourier(samples: Float32Array, sampleRate: number): AudioFourierAnalysis {
  assertPowerOfTwo(samples.length);
  const spectrum = fft(samples);
  const halfSize = samples.length / 2;
  const components: FourierComponent[] = [];

  const dcAmplitude = Math.abs(spectrum.real[0] / samples.length);
  components.push({
    positiveBin: 0,
    negativeBin: 0,
    frequencyHz: 0,
    amplitude: dcAmplitude,
    phase: spectrum.real[0] >= 0 ? 0 : Math.PI,
    energy: spectrum.real[0] * spectrum.real[0] + spectrum.imag[0] * spectrum.imag[0]
  });

  for (let bin = 1; bin < halfSize; bin += 1) {
    const real = spectrum.real[bin];
    const imag = spectrum.imag[bin];
    const magnitude = Math.hypot(real, imag);
    components.push({
      positiveBin: bin,
      negativeBin: samples.length - bin,
      frequencyHz: bin * sampleRate / samples.length,
      amplitude: 2 * magnitude / samples.length,
      phase: Math.atan2(imag, real),
      energy: magnitude * magnitude * 2
    });
  }

  const nyquistReal = spectrum.real[halfSize];
  components.push({
    positiveBin: halfSize,
    negativeBin: halfSize,
    frequencyHz: sampleRate / 2,
    amplitude: Math.abs(nyquistReal / samples.length),
    phase: nyquistReal >= 0 ? 0 : Math.PI,
    energy: nyquistReal * nyquistReal + spectrum.imag[halfSize] * spectrum.imag[halfSize]
  });

  const [dc, ...rest] = components;
  rest.sort((left, right) => {
    const byEnergy = right.energy - left.energy;
    return byEnergy === 0 ? left.frequencyHz - right.frequencyHz : byEnergy;
  });

  return {
    sampleRate,
    samples: new Float32Array(samples),
    components: [dc, ...rest],
    spectrumReal: spectrum.real,
    spectrumImag: spectrum.imag
  };
}

export function buildComponentSchedule(totalComponents: number, frameCount: number) {
  const schedule = new Uint32Array(frameCount);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const phase = frameCount <= 1 ? 1 : frameIndex / (frameCount - 1);
    schedule[frameIndex] = clamp(Math.round(1 + (totalComponents - 1) * easeInOutCubic(phase)), 1, totalComponents);
  }

  schedule[0] = Math.min(totalComponents, 1);
  schedule[frameCount - 1] = totalComponents;

  for (let frameIndex = 1; frameIndex < frameCount; frameIndex += 1) {
    schedule[frameIndex] = Math.max(schedule[frameIndex], schedule[frameIndex - 1]);
  }

  return schedule;
}

export function reconstructWithComponentCount(analysis: AudioFourierAnalysis, componentCount: number) {
  const size = analysis.samples.length;
  const real = new Float32Array(size);
  const imag = new Float32Array(size);
  const resolvedCount = clamp(Math.round(componentCount), 1, analysis.components.length);

  for (let index = 0; index < resolvedCount; index += 1) {
    const component = analysis.components[index];
    real[component.positiveBin] = analysis.spectrumReal[component.positiveBin];
    imag[component.positiveBin] = analysis.spectrumImag[component.positiveBin];
    if (component.negativeBin !== component.positiveBin) {
      real[component.negativeBin] = analysis.spectrumReal[component.negativeBin];
      imag[component.negativeBin] = analysis.spectrumImag[component.negativeBin];
    }
  }

  return fft(real, imag, true).real;
}

export function buildAudioFourierReconstruction(
  samples: Float32Array,
  sampleRate: number,
  options: AudioFourierReconstructionOptions,
  onProgress?: (progress: number, message: string) => void
): AudioFourierReconstruction {
  const analysis = analyzeAudioFourier(samples, sampleRate);
  const visualSchedule = buildComponentSchedule(analysis.components.length, options.visualFrameCount);
  const playbackSchedule = buildComponentSchedule(analysis.components.length, options.playbackFrameCount);
  const visualFrames = new Float32Array(options.visualFrameCount * options.displaySampleCount);
  const playbackSamples = new Float32Array(samples.length);
  const componentFrequencies = new Float32Array(analysis.components.length);
  const componentAmplitudes = new Float32Array(analysis.components.length);
  const componentPhases = new Float32Array(analysis.components.length);
  const componentEnergies = new Float32Array(analysis.components.length);

  analysis.components.forEach((component, index) => {
    componentFrequencies[index] = component.frequencyHz;
    componentAmplitudes[index] = component.amplitude;
    componentPhases[index] = component.phase;
    componentEnergies[index] = component.energy;
  });

  onProgress?.(0.18, 'Fourier spectrum ordered by energy.');

  for (let frameIndex = 0; frameIndex < options.visualFrameCount; frameIndex += 1) {
    const frameSamples =
      frameIndex === options.visualFrameCount - 1
        ? analysis.samples
        : reconstructWithComponentCount(analysis, visualSchedule[frameIndex]);
    visualFrames.set(downsampleForDisplay(frameSamples, options.displaySampleCount), frameIndex * options.displaySampleCount);
    if (frameIndex % 6 === 0 || frameIndex + 1 === options.visualFrameCount) {
      onProgress?.(0.18 + 0.42 * ((frameIndex + 1) / options.visualFrameCount), 'Rendering visual reconstruction frames...');
    }
  }

  for (let frameIndex = 0; frameIndex < options.playbackFrameCount; frameIndex += 1) {
    const start = Math.floor(frameIndex * samples.length / options.playbackFrameCount);
    const end = Math.floor((frameIndex + 1) * samples.length / options.playbackFrameCount);
    const frameSamples =
      frameIndex === options.playbackFrameCount - 1
        ? analysis.samples
        : reconstructWithComponentCount(analysis, playbackSchedule[frameIndex]);

    playbackSamples.set(frameSamples.subarray(start, end), start);
    if (frameIndex % 4 === 0 || frameIndex + 1 === options.playbackFrameCount) {
      onProgress?.(0.6 + 0.38 * ((frameIndex + 1) / options.playbackFrameCount), 'Rendering additive playback buffer...');
    }
  }

  return {
    analysis,
    finalSamples: new Float32Array(analysis.samples),
    visualFrames,
    frameComponentCounts: visualSchedule,
    playbackSamples,
    componentFrequencies,
    componentAmplitudes,
    componentPhases,
    componentEnergies
  };
}

