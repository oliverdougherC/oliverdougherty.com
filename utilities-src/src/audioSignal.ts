import { clamp } from './math';

export interface AudioChannels {
  sampleRate: number;
  channels: Float32Array[];
}

export interface PreparedAudioSignal {
  samples: Float32Array;
  sampleRate: number;
  sourceDurationSeconds: number;
  proxyDurationSeconds: number;
  peak: number;
  rms: number;
}

export interface AudioSignalPrepareOptions {
  proxySampleRate: number;
  maxProxySampleCount?: number;
  maxDurationSeconds: number;
}

function mean(samples: Float32Array) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index];
  }
  return samples.length > 0 ? sum / samples.length : 0;
}

export function downmixToMono(channels: Float32Array[]) {
  if (channels.length === 0) {
    throw new Error('Audio file did not contain any readable channels.');
  }

  const sampleCount = channels[0].length;
  if (sampleCount === 0) {
    throw new Error('Audio file did not contain any samples.');
  }

  for (const channel of channels) {
    if (channel.length !== sampleCount) {
      throw new Error('Audio channels must have matching sample counts.');
    }
  }

  const mono = new Float32Array(sampleCount);
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    let value = 0;
    for (const channel of channels) {
      value += channel[sampleIndex];
    }
    mono[sampleIndex] = value / channels.length;
  }

  return mono;
}

export function normalizeSignal(samples: Float32Array, targetPeak = 0.92) {
  if (samples.length === 0) {
    throw new Error('Cannot normalize an empty audio signal.');
  }

  const centered = new Float32Array(samples.length);
  const dcOffset = mean(samples);
  let peak = 0;
  let sumSquares = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index] - dcOffset;
    centered[index] = value;
    peak = Math.max(peak, Math.abs(value));
    sumSquares += value * value;
  }

  if (peak < 0.00001) {
    throw new Error('Audio signal is too quiet to analyze.');
  }

  const gain = targetPeak / peak;
  for (let index = 0; index < centered.length; index += 1) {
    centered[index] = clamp(centered[index] * gain, -1, 1);
  }

  return {
    samples: centered,
    peak: targetPeak,
    rms: Math.sqrt(sumSquares / samples.length) * gain
  };
}

export function resampleLinear(samples: Float32Array, outputSampleCount: number) {
  if (samples.length === 0 || outputSampleCount <= 0) {
    throw new Error('Cannot resample an empty audio signal.');
  }
  if (samples.length === outputSampleCount) {
    return new Float32Array(samples);
  }

  const output = new Float32Array(outputSampleCount);
  const scale = (samples.length - 1) / Math.max(1, outputSampleCount - 1);

  for (let index = 0; index < outputSampleCount; index += 1) {
    const sourcePosition = index * scale;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const phase = sourcePosition - leftIndex;
    output[index] = samples[leftIndex] + (samples[rightIndex] - samples[leftIndex]) * phase;
  }

  return output;
}

export function prepareAudioSignal(input: AudioChannels, options: AudioSignalPrepareOptions): PreparedAudioSignal {
  if (input.sampleRate <= 0) {
    throw new Error('Audio file has an invalid sample rate.');
  }
  if (options.proxySampleRate <= 0) {
    throw new Error('Audio proxy sample rate must be positive.');
  }

  const mono = downmixToMono(input.channels);
  const sourceDurationSeconds = mono.length / input.sampleRate;
  if (sourceDurationSeconds < 0.25) {
    throw new Error('Audio file is too short to analyze.');
  }
  if (sourceDurationSeconds > options.maxDurationSeconds) {
    throw new Error(`Audio file is too long for this utility. Use a file under ${Math.round(options.maxDurationSeconds / 60)} minutes.`);
  }

  const normalized = normalizeSignal(mono);
  const uncappedProxySampleCount = Math.max(2, Math.round(sourceDurationSeconds * options.proxySampleRate));
  const proxySampleCount = options.maxProxySampleCount
    ? Math.min(uncappedProxySampleCount, options.maxProxySampleCount)
    : uncappedProxySampleCount;
  const effectiveProxySampleRate = proxySampleCount / sourceDurationSeconds;
  const proxy = resampleLinear(normalized.samples, proxySampleCount);
  const finalNormalized = normalizeSignal(proxy);

  return {
    samples: finalNormalized.samples,
    sampleRate: effectiveProxySampleRate,
    sourceDurationSeconds,
    proxyDurationSeconds: finalNormalized.samples.length / effectiveProxySampleRate,
    peak: finalNormalized.peak,
    rms: finalNormalized.rms
  };
}
