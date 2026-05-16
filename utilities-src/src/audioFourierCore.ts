import { createFftWorkspace, fft, fftInto } from './fft';
import { assertPowerOfTwo, clamp } from './math';

export interface WindowedFourierOptions {
  frameSize: number;
  hopSize: number;
  displaySampleCount: number;
  energyBandCount?: number;
}

export interface WindowedFourierAnalysis {
  samples: Float32Array;
  sampleRate: number;
  frameSize: number;
  hopSize: number;
  frameCount: number;
  binCount: number;
  displaySampleCount: number;
  coeffReal: Float32Array;
  coeffImag: Float32Array;
  componentOrder: Uint32Array;
  componentFrequencies: Float32Array;
  componentAmplitudes: Float32Array;
  componentPhases: Float32Array;
  componentEnergies: Float32Array;
  finalDisplayFrame: Float32Array;
}

export interface ComponentRenderResult {
  componentCount: number;
  displayFrame: Float32Array;
  playbackSamples: Float32Array;
}

export interface EnergyBandReconstruction {
  bandSamples: Float32Array;
  bandCount: number;
  sampleCount: number;
  bandEndComponentCounts: Uint32Array;
  bandEnergyFractions: Float32Array;
  mixedSamples: Float32Array;
  mixedDisplayFrame: Float32Array;
}

export interface SampleEnvelope {
  min: number;
  max: number;
}

export interface AudioEnvelope {
  min: Float32Array;
  max: Float32Array;
  bucketSampleCount: number;
  bucketCount: number;
  sampleCount: number;
}

export interface MixedAudioEnvelope {
  min: Float32Array;
  max: Float32Array;
  bucketSampleCount: number;
  bucketCount: number;
  sampleCount: number;
  approximate: boolean;
}

export interface EnvelopeViewportRange {
  startSample: number;
  endSample: number;
  viewportSampleCount: number;
  firstBucketIndex: number;
  lastBucketIndex: number;
  bucketOffsetFraction: number;
}

interface ReconstructionScratch {
  window: Float32Array;
  spectraReal: Float32Array;
  spectraImag: Float32Array;
  output: Float32Array;
  normalization: Float32Array;
  fftWorkspace: ReturnType<typeof createFftWorkspace>;
}

function createHannWindow(size: number) {
  const window = new Float32Array(size);
  if (size === 1) {
    window[0] = 1;
    return window;
  }
  if (size === 2) {
    window[1] = 1;
    return window;
  }
  for (let index = 0; index < size; index += 1) {
    window[index] = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1));
  }
  return window;
}

function downsampleForDisplay(samples: Float32Array, displaySampleCount: number) {
  const output = new Float32Array(displaySampleCount);
  const scale = samples.length / displaySampleCount;

  if (scale < 1) {
    const maxSourceIndex = Math.max(0, samples.length - 1);
    for (let index = 0; index < displaySampleCount; index += 1) {
      const sourcePosition = displaySampleCount === 1
        ? 0
        : (index / (displaySampleCount - 1)) * maxSourceIndex;
      const leftIndex = Math.floor(sourcePosition);
      const rightIndex = Math.min(maxSourceIndex, leftIndex + 1);
      const phase = sourcePosition - leftIndex;
      output[index] = samples[leftIndex] + (samples[rightIndex] - samples[leftIndex]) * phase;
    }
    return output;
  }

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

function coefficientFrequency(coefficientIndex: number, binCount: number, sampleRate: number, frameSize: number) {
  const bin = coefficientIndex % binCount;
  return bin * sampleRate / frameSize;
}

// One-sided amplitude spectrum: DC (bin 0) and Nyquist (bin = binCount-1) are divided
// by frameSize, while all other bins are divided by frameSize/2 (via 2*magnitude/frameSize).
// This is the standard convention for real-valued signals where negative-frequency bins
// are folded into the positive half. The reconstruction functions work with raw coefficients,
// so displayed amplitudes don't round-trip perfectly with fftInto's full normalization.
function coefficientAmplitude(real: number, imag: number, bin: number, binCount: number, frameSize: number) {
  const magnitude = Math.hypot(real, imag);
  return bin === 0 || bin === binCount - 1 ? magnitude / frameSize : 2 * magnitude / frameSize;
}

const SLIDER_CURVE_EXPONENT = 1.85;
const ENERGY_SLIDER_MIDPOINT = 0.5;
const ENERGY_SLIDER_MIDPOINT_VALUE = 0.8;
const ENERGY_SLIDER_LOW_REFERENCE = 0.2;
const ENERGY_SLIDER_LOW_REFERENCE_VALUE = 0.6;
const ENERGY_SLIDER_LOW_EXPONENT = Math.log(ENERGY_SLIDER_LOW_REFERENCE_VALUE / ENERGY_SLIDER_MIDPOINT_VALUE) /
  Math.log(ENERGY_SLIDER_LOW_REFERENCE / ENERGY_SLIDER_MIDPOINT);
const FFT_PROGRESS_THROTTLE = 64;
const OVERLAP_ADD_NORMALIZATION_THRESHOLD = 0.000001;
const DEFAULT_ENVELOPE_TARGET_POINTS_PER_SECOND = 420;
const VISUAL_ORIGINAL_CLAMP_START = 0.8;
const VISUAL_ORIGINAL_CLAMP_END = 0.85;

/**
 * Maps a slider value to a component count using an exponential curve for perceptually uniform selection.
 * @param value - Current slider value.
 * @param maxValue - Maximum slider value.
 * @param componentCount - Total number of available Fourier components.
 * @returns Clamped component count between 1 and `componentCount`.
 */
export function mapSliderValueToComponentCount(value: number, maxValue: number, componentCount: number) {
  if (componentCount <= 1) {
    return 1;
  }
  if (value <= 0) {
    return 1;
  }
  if (value >= maxValue) {
    return componentCount;
  }

  const phase = clamp(value / Math.max(1, maxValue), 0, 1);
  const curved = Math.pow(phase, SLIDER_CURVE_EXPONENT);
  const mapped = Math.round(Math.exp(Math.log(componentCount) * curved));
  return clamp(mapped, 1, componentCount);
}

/**
 * Maps a slider value to a perceptual energy percentage between 0 and 1.
 * @param value - Current slider value.
 * @param maxValue - Maximum slider value.
 * @returns Clamped energy fraction between 0 and 1.
 */
export function mapSliderValueToEnergyPercent(value: number, maxValue: number) {
  const phase = clamp(value / Math.max(1, maxValue), 0, 1);
  if (phase <= 0) {
    return 0;
  }
  if (phase >= 1) {
    return 1;
  }
  if (phase <= ENERGY_SLIDER_MIDPOINT) {
    return ENERGY_SLIDER_MIDPOINT_VALUE * Math.pow(
      phase / ENERGY_SLIDER_MIDPOINT,
      ENERGY_SLIDER_LOW_EXPONENT
    );
  }

  return ENERGY_SLIDER_MIDPOINT_VALUE +
    (1 - ENERGY_SLIDER_MIDPOINT_VALUE) * ((phase - ENERGY_SLIDER_MIDPOINT) / ENERGY_SLIDER_MIDPOINT);
}

/**
 * Finds the minimum and maximum sample values over a given sample range.
 * @param samples - Audio sample buffer.
 * @param startSample - Start index (fractional).
 * @param endSample - End index (fractional).
 * @returns Object containing `min` and `max` sample values.
 */
export function resolveSampleEnvelope(samples: Float32Array, startSample: number, endSample: number): SampleEnvelope {
  if (samples.length === 0) {
    return { min: 0, max: 0 };
  }

  const lower = Math.min(startSample, endSample);
  const upper = Math.max(startSample, endSample);
  const start = clamp(Math.floor(lower), 0, samples.length - 1);
  const end = clamp(Math.ceil(upper), start + 1, samples.length);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
    const value = samples[sampleIndex];
    if (!Number.isFinite(value)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    const value = samples[start] ?? 0;
    return { min: value, max: value };
  }

  return { min, max };
}

/**
 * Computes per-band gain values so the selected bands include a target fraction of total signal energy.
 * @param energyPercent - Target energy fraction between 0 and 1.
 * @param bandEnergyFractions - Cumulative energy fraction for each band (ascending).
 * @returns Gain values per band, clamped between 0 and 1.
 */
export function resolveEnergyBandGains(energyPercent: number, bandEnergyFractions: Float32Array) {
  const gains = new Float32Array(bandEnergyFractions.length);
  const target = clamp(energyPercent, 0, 1);
  let previous = 0;

  for (let index = 0; index < bandEnergyFractions.length; index += 1) {
    const next = bandEnergyFractions[index];
    if (target >= next) {
      gains[index] = 1;
    } else if (target > previous) {
      const energyFraction = (target - previous) / Math.max(0.000001, next - previous);
      gains[index] = Math.sqrt(clamp(energyFraction, 0, 1));
    } else {
      gains[index] = 0;
    }
    previous = next;
  }

  return gains;
}

/**
 * Computes a compensation gain to restore perceived loudness when energy is reduced.
 * @param energyPercent - Target energy fraction between 0 and 1.
 * @returns Gain value clamped between 1 and 2.8.
 */
export function resolveEnergyMakeupGain(energyPercent: number) {
  const resolvedEnergy = clamp(energyPercent, 0, 1);
  if (resolvedEnergy >= 0.98) {
    return 1;
  }

  return clamp(1 / Math.sqrt(Math.max(0.08, resolvedEnergy)), 1, 2.8);
}

/**
 * Builds a complete windowed Fourier analysis of an audio signal, sorting components by energy.
 * @param samples - Input audio sample buffer.
 * @param sampleRate - Audio sample rate in Hz.
 * @param options - Configuration for frame size, hop size, display sample count, and optional energy band count.
 * @param onProgress - Optional callback for progress updates.
 * @returns Complete `WindowedFourierAnalysis` object containing spectral coefficients, energy-sorted component arrays, and a display frame.
 */
export function buildWindowedFourierAnalysis(
  samples: Float32Array,
  sampleRate: number,
  options: WindowedFourierOptions,
  onProgress?: (progress: number, message: string) => void
): WindowedFourierAnalysis {
  assertPowerOfTwo(options.frameSize);
  if (options.hopSize <= 0 || options.hopSize > options.frameSize) {
    throw new Error('Audio Fourier hop size must fit inside the frame size.');
  }
  if (samples.length === 0) {
    throw new Error('Audio Fourier analysis requires samples.');
  }

  const frameSize = options.frameSize;
  const hopSize = options.hopSize;
  const frameCount = Math.max(1, Math.ceil(Math.max(0, samples.length - frameSize) / hopSize) + 1);
  const binCount = frameSize / 2 + 1;
  const coefficientCount = frameCount * binCount;
  const window = createHannWindow(frameSize);
  const coeffReal = new Float32Array(coefficientCount);
  const coeffImag = new Float32Array(coefficientCount);
  const energies = new Float32Array(coefficientCount);
  const order = Array.from({ length: coefficientCount }, (_value, index) => index);
  const frameInput = new Float32Array(frameSize);
  const fftWorkspace = createFftWorkspace(frameSize);

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    frameInput.fill(0);
    const frameStart = frameIndex * hopSize;
    for (let offset = 0; offset < frameSize; offset += 1) {
      const sampleIndex = frameStart + offset;
      frameInput[offset] = (sampleIndex < samples.length ? samples[sampleIndex] : 0) * window[offset];
    }

    const spectrum = fftInto(frameInput, undefined, false, fftWorkspace);
    const coefficientOffset = frameIndex * binCount;
    for (let bin = 0; bin < binCount; bin += 1) {
      const coefficientIndex = coefficientOffset + bin;
      const real = spectrum.real[bin];
      const imag = spectrum.imag[bin];
      coeffReal[coefficientIndex] = real;
      coeffImag[coefficientIndex] = imag;
      energies[coefficientIndex] = real * real + imag * imag;
    }

    if (frameIndex % FFT_PROGRESS_THROTTLE === 0 || frameIndex + 1 === frameCount) {
      onProgress?.(0.12 + 0.48 * ((frameIndex + 1) / frameCount), 'Analyzing full-song proxy windows...');
    }
  }

  order.sort((left, right) => {
    const byEnergy = energies[right] - energies[left];
    if (byEnergy !== 0) {
      return byEnergy;
    }
    return coefficientFrequency(left, binCount, sampleRate, frameSize) - coefficientFrequency(right, binCount, sampleRate, frameSize);
  });

  const componentOrder = Uint32Array.from(order);
  const componentFrequencies = new Float32Array(coefficientCount);
  const componentAmplitudes = new Float32Array(coefficientCount);
  const componentPhases = new Float32Array(coefficientCount);
  const componentEnergies = new Float32Array(coefficientCount);

  for (let orderedIndex = 0; orderedIndex < componentOrder.length; orderedIndex += 1) {
    const coefficientIndex = componentOrder[orderedIndex];
    const bin = coefficientIndex % binCount;
    const real = coeffReal[coefficientIndex];
    const imag = coeffImag[coefficientIndex];
    componentFrequencies[orderedIndex] = coefficientFrequency(coefficientIndex, binCount, sampleRate, frameSize);
    componentAmplitudes[orderedIndex] = coefficientAmplitude(real, imag, bin, binCount, frameSize);
    componentPhases[orderedIndex] = Math.atan2(imag, real);
    componentEnergies[orderedIndex] = energies[coefficientIndex];
  }

  return {
    samples: new Float32Array(samples),
    sampleRate,
    frameSize,
    hopSize,
    frameCount,
    binCount,
    displaySampleCount: options.displaySampleCount,
    coeffReal,
    coeffImag,
    componentOrder,
    componentFrequencies,
    componentAmplitudes,
    componentPhases,
    componentEnergies,
    finalDisplayFrame: downsampleForDisplay(samples, options.displaySampleCount)
  };
}

/**
 * Reconstructs audio samples from the top-N energy-ranked Fourier components using overlap-add synthesis.
 * @param analysis - The windowed Fourier analysis result from `buildWindowedFourierAnalysis`.
 * @param componentCount - Number of top-energy components to include in reconstruction.
 * @returns Reconstructed audio sample buffer.
 */
export function reconstructWindowedComponentCount(
  analysis: WindowedFourierAnalysis,
  componentCount: number
): Float32Array {
  const resolvedCount = clamp(Math.round(componentCount), 1, analysis.componentOrder.length);

  if (resolvedCount >= analysis.componentOrder.length) {
    // analysis.samples is already a copy of the original input created during
    // buildWindowedFourierAnalysis, so returning a fresh copy is correct and avoids
    // re-running the expensive reconstruction path for the trivial full-count case.
    return new Float32Array(analysis.samples);
  }

  return reconstructWindowedComponentRange(analysis, 0, resolvedCount, createReconstructionScratch(analysis));
}

function createReconstructionScratch(analysis: WindowedFourierAnalysis): ReconstructionScratch {
  const outputLength = (analysis.frameCount - 1) * analysis.hopSize + analysis.frameSize;
  return {
    window: createHannWindow(analysis.frameSize),
    spectraReal: new Float32Array(analysis.frameCount * analysis.frameSize),
    spectraImag: new Float32Array(analysis.frameCount * analysis.frameSize),
    output: new Float32Array(outputLength),
    normalization: new Float32Array(outputLength),
    fftWorkspace: createFftWorkspace(analysis.frameSize)
  };
}

/**
 * Reconstructs audio from a specific contiguous range of energy-sorted components, with optional scratch buffer reuse.
 * @param analysis - The windowed Fourier analysis result from `buildWindowedFourierAnalysis`.
 * @param startComponentIndex - Start index in the energy-sorted component order (inclusive).
 * @param endComponentIndex - End index in the energy-sorted component order (exclusive).
 * @param scratch - Optional pre-allocated scratch buffers to reuse for performance.
 * @returns Reconstructed audio sample buffer.
 */
export function reconstructWindowedComponentRange(
  analysis: WindowedFourierAnalysis,
  startComponentIndex: number,
  endComponentIndex: number,
  scratch?: ReconstructionScratch
): Float32Array {
  const start = clamp(Math.round(startComponentIndex), 0, analysis.componentOrder.length);
  const end = clamp(Math.round(endComponentIndex), start, analysis.componentOrder.length);
  const frameSize = analysis.frameSize;
  const hopSize = analysis.hopSize;
  const binCount = analysis.binCount;
  const resolvedScratch = scratch ?? createReconstructionScratch(analysis);
  const { window, spectraReal, spectraImag, output, normalization, fftWorkspace } = resolvedScratch;
  spectraReal.fill(0);
  spectraImag.fill(0);
  output.fill(0);
  normalization.fill(0);

  for (let orderedIndex = start; orderedIndex < end; orderedIndex += 1) {
    const coefficientIndex = analysis.componentOrder[orderedIndex];
    const frameIndex = Math.floor(coefficientIndex / binCount);
    const bin = coefficientIndex % binCount;
    const frameOffset = frameIndex * frameSize;
    const real = analysis.coeffReal[coefficientIndex];
    const imag = analysis.coeffImag[coefficientIndex];
    spectraReal[frameOffset + bin] = real;
    spectraImag[frameOffset + bin] = imag;
    if (bin > 0 && bin < binCount - 1) {
      spectraReal[frameOffset + frameSize - bin] = real;
      spectraImag[frameOffset + frameSize - bin] = -imag;
    }
  }

  for (let frameIndex = 0; frameIndex < analysis.frameCount; frameIndex += 1) {
    const frameOffset = frameIndex * frameSize;
    const time = fftInto(
      spectraReal.subarray(frameOffset, frameOffset + frameSize),
      spectraImag.subarray(frameOffset, frameOffset + frameSize),
      true,
      fftWorkspace
    ).real;
    const sampleStart = frameIndex * hopSize;

    for (let offset = 0; offset < frameSize; offset += 1) {
      const sampleIndex = sampleStart + offset;
      const windowValue = window[offset];
      output[sampleIndex] += time[offset] * windowValue;
      normalization[sampleIndex] += windowValue * windowValue;
    }
  }

  const trimmed = new Float32Array(analysis.samples.length);
  for (let index = 0; index < trimmed.length; index += 1) {
    const norm = normalization[index];
     trimmed[index] = norm > OVERLAP_ADD_NORMALIZATION_THRESHOLD ? output[index] / norm : output[index];
  }

  return trimmed;
}

/**
 * Reconstructs audio and produces a downsampled display frame for a given component count.
 * @param analysis - The windowed Fourier analysis result from `buildWindowedFourierAnalysis`.
 * @param componentCount - Number of top-energy components to include in reconstruction.
 * @returns Object with resolved component count, downsampled display frame, and full playback samples.
 */
export function renderWindowedComponentCount(
  analysis: WindowedFourierAnalysis,
  componentCount: number
): ComponentRenderResult {
  const resolvedCount = clamp(Math.round(componentCount), 1, analysis.componentOrder.length);
  const playbackSamples = reconstructWindowedComponentCount(analysis, resolvedCount);

  return {
    componentCount: resolvedCount,
    displayFrame: resolvedCount >= analysis.componentOrder.length
      ? new Float32Array(analysis.finalDisplayFrame)
      : downsampleForDisplay(playbackSamples, analysis.displaySampleCount),
    playbackSamples
  };
}

/**
 * Partitions Fourier components into equal-energy bands and reconstructs each band independently.
 * @param analysis - The windowed Fourier analysis result from `buildWindowedFourierAnalysis`.
 * @param bandCount - Number of equal-energy bands to partition components into.
 * @param onProgress - Optional callback for progress updates.
 * @returns Object with per-band samples, component boundaries, energy fractions, and a mixed output.
 */
export function buildEnergyBandReconstruction(
  analysis: WindowedFourierAnalysis,
  bandCount: number,
  onProgress?: (progress: number, message: string) => void
): EnergyBandReconstruction {
  // Memory note: bandSamples allocates O(bandCount × sampleCount).
  // For a 7M sample signal with 12 bands this is ~336 MB. The bands are
  // reconstructed once and stored for fast slider-driven mixing.
  const resolvedBandCount = clamp(Math.round(bandCount), 1, analysis.componentOrder.length);
  const bandSamples = new Float32Array(resolvedBandCount * analysis.samples.length);
  const bandEndComponentCounts = new Uint32Array(resolvedBandCount);
  const bandEnergyFractions = new Float32Array(resolvedBandCount);
  const mixedSamples = new Float32Array(analysis.samples.length);
  const reconstructionScratch = createReconstructionScratch(analysis);
  let totalEnergy = 0;
  for (let index = 0; index < analysis.componentEnergies.length; index += 1) {
    totalEnergy += analysis.componentEnergies[index];
  }

  let componentStart = 0;
  let energySum = 0;
  for (let bandIndex = 0; bandIndex < resolvedBandCount; bandIndex += 1) {
    const targetEnergy = totalEnergy * ((bandIndex + 1) / resolvedBandCount);
    let componentEnd = componentStart;
    while (componentEnd < analysis.componentEnergies.length && (energySum < targetEnergy || componentEnd <= componentStart)) {
      energySum += analysis.componentEnergies[componentEnd];
      componentEnd += 1;
    }

    if (bandIndex === resolvedBandCount - 1) {
      componentEnd = analysis.componentEnergies.length;
      energySum = totalEnergy;
    }

    const band = reconstructWindowedComponentRange(analysis, componentStart, componentEnd, reconstructionScratch);
    bandSamples.set(band, bandIndex * analysis.samples.length);
    bandEndComponentCounts[bandIndex] = componentEnd;
    bandEnergyFractions[bandIndex] = totalEnergy > 0 ? energySum / totalEnergy : (bandIndex + 1) / resolvedBandCount;
    componentStart = componentEnd;
    onProgress?.(0.62 + 0.33 * ((bandIndex + 1) / resolvedBandCount), 'Rendering live energy bands...');
  }

  bandEnergyFractions[resolvedBandCount - 1] = 1;
  const allOnes = new Float32Array(resolvedBandCount).fill(1);
  mixEnergyBands(bandSamples, analysis.samples.length, allOnes, mixedSamples);
  const finalBandOffset = (resolvedBandCount - 1) * analysis.samples.length;
  for (let sampleIndex = 0; sampleIndex < mixedSamples.length; sampleIndex += 1) {
    const residual = analysis.samples[sampleIndex] - mixedSamples[sampleIndex];
    bandSamples[finalBandOffset + sampleIndex] += residual;
    mixedSamples[sampleIndex] += residual;
  }

  return {
    bandSamples,
    bandCount: resolvedBandCount,
    sampleCount: analysis.samples.length,
    bandEndComponentCounts,
    bandEnergyFractions,
    mixedSamples,
    mixedDisplayFrame: downsampleForDisplay(mixedSamples, analysis.displaySampleCount)
  };
}

/**
 * Combines per-band audio samples with per-band gain values into a single mixed output.
 * @param bandSamples - Concatenated sample buffers for each band (length: `bandCount * sampleCount`).
 * @param sampleCount - Number of samples per band.
 * @param gains - Per-band gain multipliers.
 * @param destination - Optional output buffer; allocated if not provided.
 * @returns The mixed audio sample buffer.
 */
export function mixEnergyBands(
  bandSamples: Float32Array,
  sampleCount: number,
  gains: Float32Array,
  destination = new Float32Array(sampleCount)
) {
  destination.fill(0);
  for (let bandIndex = 0; bandIndex < gains.length; bandIndex += 1) {
    const gain = gains[bandIndex];
    if (gain === 0) {
      continue;
    }
    const offset = bandIndex * sampleCount;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      destination[sampleIndex] += bandSamples[offset + sampleIndex] * gain;
    }
  }
  return destination;
}

export function resolveEnvelopeBucketSampleCount(sampleRate: number, targetPointsPerSecond = DEFAULT_ENVELOPE_TARGET_POINTS_PER_SECOND) {
  return Math.max(1, Math.round(sampleRate / Math.max(1, targetPointsPerSecond)));
}

export function buildSampleEnvelope(samples: Float32Array, bucketSampleCount: number): AudioEnvelope {
  const resolvedBucketSampleCount = Math.max(1, Math.round(bucketSampleCount));
  const bucketCount = Math.max(1, Math.ceil(samples.length / resolvedBucketSampleCount));
  const min = new Float32Array(bucketCount);
  const max = new Float32Array(bucketCount);

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = bucketIndex * resolvedBucketSampleCount;
    const end = Math.min(samples.length, start + resolvedBucketSampleCount);
    let bucketMin = Number.POSITIVE_INFINITY;
    let bucketMax = Number.NEGATIVE_INFINITY;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const value = samples[sampleIndex];
      if (!Number.isFinite(value)) {
        continue;
      }
      bucketMin = Math.min(bucketMin, value);
      bucketMax = Math.max(bucketMax, value);
    }

    if (!Number.isFinite(bucketMin) || !Number.isFinite(bucketMax)) {
      bucketMin = 0;
      bucketMax = 0;
    }
    min[bucketIndex] = bucketMin;
    max[bucketIndex] = bucketMax;
  }

  return {
    min,
    max,
    bucketSampleCount: resolvedBucketSampleCount,
    bucketCount,
    sampleCount: samples.length
  };
}

export function buildEnergyBandEnvelopes(
  bandSamples: Float32Array,
  sampleCount: number,
  bandCount: number,
  bucketSampleCount: number
) {
  const resolvedBandCount = Math.max(1, Math.round(bandCount));
  const resolvedBucketSampleCount = Math.max(1, Math.round(bucketSampleCount));
  const bucketCount = Math.max(1, Math.ceil(sampleCount / resolvedBucketSampleCount));
  const min = new Float32Array(resolvedBandCount * bucketCount);
  const max = new Float32Array(resolvedBandCount * bucketCount);

  for (let bandIndex = 0; bandIndex < resolvedBandCount; bandIndex += 1) {
    const bandOffset = bandIndex * sampleCount;
    const envelopeOffset = bandIndex * bucketCount;
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const start = bucketIndex * resolvedBucketSampleCount;
      const end = Math.min(sampleCount, start + resolvedBucketSampleCount);
      let bucketMin = Number.POSITIVE_INFINITY;
      let bucketMax = Number.NEGATIVE_INFINITY;

      for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
        const value = bandSamples[bandOffset + sampleIndex];
        if (!Number.isFinite(value)) {
          continue;
        }
        bucketMin = Math.min(bucketMin, value);
        bucketMax = Math.max(bucketMax, value);
      }

      if (!Number.isFinite(bucketMin) || !Number.isFinite(bucketMax)) {
        bucketMin = 0;
        bucketMax = 0;
      }
      min[envelopeOffset + bucketIndex] = bucketMin;
      max[envelopeOffset + bucketIndex] = bucketMax;
    }
  }

  return {
    min,
    max,
    bucketSampleCount: resolvedBucketSampleCount,
    bucketCount,
    sampleCount,
    bandCount: resolvedBandCount
  };
}

export function mixEnergyBandEnvelopes(
  bandMin: Float32Array,
  bandMax: Float32Array,
  bucketCount: number,
  sampleCount: number,
  bucketSampleCount: number,
  gains: Float32Array,
  destination: MixedAudioEnvelope = {
    min: new Float32Array(bucketCount),
    max: new Float32Array(bucketCount),
    bucketSampleCount,
    bucketCount,
    sampleCount,
    approximate: true
  }
): MixedAudioEnvelope {
  if (destination.min.length !== bucketCount || destination.max.length !== bucketCount) {
    destination = {
      min: new Float32Array(bucketCount),
      max: new Float32Array(bucketCount),
      bucketSampleCount,
      bucketCount,
      sampleCount,
      approximate: true
    };
  }

  destination.min.fill(0);
  destination.max.fill(0);
  destination.bucketSampleCount = bucketSampleCount;
  destination.bucketCount = bucketCount;
  destination.sampleCount = sampleCount;
  destination.approximate = true;

  for (let bandIndex = 0; bandIndex < gains.length; bandIndex += 1) {
    const gain = Math.max(0, gains[bandIndex]);
    if (gain === 0) {
      continue;
    }
    const offset = bandIndex * bucketCount;
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      destination.min[bucketIndex] += bandMin[offset + bucketIndex] * gain;
      destination.max[bucketIndex] += bandMax[offset + bucketIndex] * gain;
    }
  }

  return destination;
}

export function resolveHighEnergyVisualAmplitude(
  originalAmplitude: number,
  reconstructedAmplitude: number,
  energyPercent: number
) {
  const original = Math.max(0, originalAmplitude);
  const reconstructed = Math.max(0, reconstructedAmplitude);
  const bounded = Math.min(reconstructed, original);
  const energy = clamp(energyPercent, 0, 1);

  if (energy <= VISUAL_ORIGINAL_CLAMP_START) {
    return reconstructed;
  }
  if (energy >= VISUAL_ORIGINAL_CLAMP_END) {
    return bounded;
  }

  const phase = (energy - VISUAL_ORIGINAL_CLAMP_START) /
    (VISUAL_ORIGINAL_CLAMP_END - VISUAL_ORIGINAL_CLAMP_START);
  return reconstructed + (bounded - reconstructed) * phase;
}

/**
 * Calculates a time-centered viewport range for audio waveform display.
 * @param currentTimeSeconds - Current playback position in seconds.
 * @param durationSeconds - Total audio duration in seconds.
 * @param sampleRate - Audio sample rate in Hz.
 * @param viewportSeconds - Window width in seconds centered on the current time.
 * @returns Object with `startSample`, `endSample`, and `viewportSampleCount`.
 */
export function resolveViewportRange(
  currentTimeSeconds: number,
  durationSeconds: number,
  sampleRate: number,
  viewportSeconds = 2
) {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const viewportSampleCount = Math.max(1, Math.min(sampleCount, Math.round(viewportSeconds * sampleRate)));
  const centerSample = clamp(Math.round(currentTimeSeconds * sampleRate), 0, sampleCount - 1);
  const startSample = clamp(centerSample - Math.floor(viewportSampleCount / 2), 0, Math.max(0, sampleCount - viewportSampleCount));

  return {
    startSample,
    endSample: startSample + viewportSampleCount,
    viewportSampleCount
  };
}

export function resolveEnvelopeViewportRange(
  currentTimeSeconds: number,
  durationSeconds: number,
  sampleRate: number,
  viewportSeconds: number,
  bucketSampleCount: number
): EnvelopeViewportRange {
  const sampleCount = Math.max(1, Math.round(durationSeconds * sampleRate));
  const viewportSampleCount = Math.max(1, Math.min(sampleCount, Math.round(viewportSeconds * sampleRate)));
  const maxStartSample = Math.max(0, sampleCount - viewportSampleCount);
  const centerSample = clamp(currentTimeSeconds * sampleRate, 0, sampleCount - 1);
  const startSample = clamp(centerSample - viewportSampleCount / 2, 0, maxStartSample);
  const resolvedBucketSampleCount = Math.max(1, Math.round(bucketSampleCount));
  const startBucket = startSample / resolvedBucketSampleCount;
  const firstBucketIndex = Math.max(0, Math.floor(startBucket) - 1);
  const visibleBucketCount = Math.ceil(viewportSampleCount / resolvedBucketSampleCount);
  const bucketCount = Math.max(1, Math.ceil(sampleCount / resolvedBucketSampleCount));
  const lastBucketIndex = Math.min(bucketCount, Math.ceil(startBucket) + visibleBucketCount + 2);

  return {
    startSample,
    endSample: startSample + viewportSampleCount,
    viewportSampleCount,
    firstBucketIndex,
    lastBucketIndex,
    bucketOffsetFraction: startBucket - Math.floor(startBucket)
  };
}
