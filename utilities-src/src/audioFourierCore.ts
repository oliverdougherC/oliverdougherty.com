import { fft } from './fft';

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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function assertPowerOfTwo(size: number) {
  if (!Number.isInteger(size) || size < 2 || (size & (size - 1)) !== 0) {
    throw new Error('Audio Fourier frame size must be a power of two.');
  }
}

function createHannWindow(size: number) {
  const window = new Float32Array(size);
  if (size === 1) {
    window[0] = 1;
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

function coefficientAmplitude(real: number, imag: number, bin: number, binCount: number, frameSize: number) {
  const magnitude = Math.hypot(real, imag);
  return bin === 0 || bin === binCount - 1 ? magnitude / frameSize : 2 * magnitude / frameSize;
}

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
  const curved = Math.pow(phase, 1.85);
  const mapped = Math.round(Math.exp(Math.log(componentCount) * curved));
  return clamp(mapped, 1, componentCount);
}

export function mapSliderValueToEnergyPercent(value: number, maxValue: number) {
  const phase = clamp(value / Math.max(1, maxValue), 0, 1);
  return Math.pow(phase, Math.log(0.8) / Math.log(0.5));
}

export function resolveEnergyBandGains(energyPercent: number, bandEnergyFractions: Float32Array) {
  const gains = new Float32Array(bandEnergyFractions.length);
  const target = clamp(energyPercent, 0, 1);
  let previous = 0;

  for (let index = 0; index < bandEnergyFractions.length; index += 1) {
    const next = bandEnergyFractions[index];
    if (target >= next) {
      gains[index] = 1;
    } else if (target > previous) {
      gains[index] = (target - previous) / Math.max(0.000001, next - previous);
    } else {
      gains[index] = 0;
    }
    previous = next;
  }

  if (target >= 1 && gains.length > 0) {
    gains.fill(1);
  }

  return gains;
}

export function resolveEnergyMakeupGain(energyPercent: number) {
  const resolvedEnergy = clamp(energyPercent, 0, 1);
  if (resolvedEnergy >= 0.98) {
    return 1;
  }

  return clamp(1 / Math.sqrt(Math.max(0.08, resolvedEnergy)), 1, 2.8);
}

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

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    frameInput.fill(0);
    const frameStart = frameIndex * hopSize;
    for (let offset = 0; offset < frameSize; offset += 1) {
      const sampleIndex = frameStart + offset;
      frameInput[offset] = (sampleIndex < samples.length ? samples[sampleIndex] : 0) * window[offset];
    }

    const spectrum = fft(frameInput);
    const coefficientOffset = frameIndex * binCount;
    for (let bin = 0; bin < binCount; bin += 1) {
      const coefficientIndex = coefficientOffset + bin;
      const real = spectrum.real[bin];
      const imag = spectrum.imag[bin];
      coeffReal[coefficientIndex] = real;
      coeffImag[coefficientIndex] = imag;
      energies[coefficientIndex] = real * real + imag * imag;
    }

    if (frameIndex % 64 === 0 || frameIndex + 1 === frameCount) {
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

export function reconstructWindowedComponentCount(
  analysis: WindowedFourierAnalysis,
  componentCount: number
): Float32Array {
  const resolvedCount = clamp(Math.round(componentCount), 1, analysis.componentOrder.length);

  if (resolvedCount >= analysis.componentOrder.length) {
    return new Float32Array(analysis.samples);
  }

  const frameSize = analysis.frameSize;
  const hopSize = analysis.hopSize;
  const binCount = analysis.binCount;
  const window = createHannWindow(frameSize);
  const spectraReal = new Float32Array(analysis.frameCount * frameSize);
  const spectraImag = new Float32Array(analysis.frameCount * frameSize);
  const output = new Float32Array((analysis.frameCount - 1) * hopSize + frameSize);
  const normalization = new Float32Array(output.length);

  for (let orderedIndex = 0; orderedIndex < resolvedCount; orderedIndex += 1) {
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
    const time = fft(
      spectraReal.subarray(frameOffset, frameOffset + frameSize),
      spectraImag.subarray(frameOffset, frameOffset + frameSize),
      true
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
    trimmed[index] = norm > 0.000001 ? output[index] / norm : output[index];
  }

  return trimmed;
}

export function reconstructWindowedComponentRange(
  analysis: WindowedFourierAnalysis,
  startComponentIndex: number,
  endComponentIndex: number
): Float32Array {
  const start = clamp(Math.round(startComponentIndex), 0, analysis.componentOrder.length);
  const end = clamp(Math.round(endComponentIndex), start, analysis.componentOrder.length);
  const frameSize = analysis.frameSize;
  const hopSize = analysis.hopSize;
  const binCount = analysis.binCount;
  const window = createHannWindow(frameSize);
  const spectraReal = new Float32Array(analysis.frameCount * frameSize);
  const spectraImag = new Float32Array(analysis.frameCount * frameSize);
  const output = new Float32Array((analysis.frameCount - 1) * hopSize + frameSize);
  const normalization = new Float32Array(output.length);

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
    const time = fft(
      spectraReal.subarray(frameOffset, frameOffset + frameSize),
      spectraImag.subarray(frameOffset, frameOffset + frameSize),
      true
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
    trimmed[index] = norm > 0.000001 ? output[index] / norm : output[index];
  }

  return trimmed;
}

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

export function buildEnergyBandReconstruction(
  analysis: WindowedFourierAnalysis,
  bandCount: number,
  onProgress?: (progress: number, message: string) => void
): EnergyBandReconstruction {
  const resolvedBandCount = clamp(Math.round(bandCount), 1, analysis.componentOrder.length);
  const bandSamples = new Float32Array(resolvedBandCount * analysis.samples.length);
  const bandEndComponentCounts = new Uint32Array(resolvedBandCount);
  const bandEnergyFractions = new Float32Array(resolvedBandCount);
  const mixedSamples = new Float32Array(analysis.samples.length);
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

    const band = reconstructWindowedComponentRange(analysis, componentStart, componentEnd);
    bandSamples.set(band, bandIndex * analysis.samples.length);
    for (let sampleIndex = 0; sampleIndex < mixedSamples.length; sampleIndex += 1) {
      mixedSamples[sampleIndex] += band[sampleIndex];
    }
    bandEndComponentCounts[bandIndex] = componentEnd;
    bandEnergyFractions[bandIndex] = totalEnergy > 0 ? energySum / totalEnergy : (bandIndex + 1) / resolvedBandCount;
    componentStart = componentEnd;
    onProgress?.(0.62 + 0.33 * ((bandIndex + 1) / resolvedBandCount), 'Rendering live energy bands...');
  }

  bandEnergyFractions[resolvedBandCount - 1] = 1;
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
