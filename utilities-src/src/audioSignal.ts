export interface AudioChannels {
  sampleRate: number;
  channels: Float32Array[];
}

export interface AudioSegmentSelection {
  startSample: number;
  sampleCount: number;
  durationSeconds: number;
  rms: number;
  peak: number;
}

export interface PreparedAudioSignal {
  samples: Float32Array;
  sampleRate: number;
  sourceDurationSeconds: number;
  segment: AudioSegmentSelection;
  peak: number;
  rms: number;
}

export interface AudioSignalPrepareOptions {
  sampleCount: number;
  targetDurationSeconds: number;
  minDurationSeconds: number;
  maxDurationSeconds: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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

export function selectAutoSegment(
  samples: Float32Array,
  sampleRate: number,
  options: Pick<AudioSignalPrepareOptions, 'targetDurationSeconds' | 'minDurationSeconds' | 'maxDurationSeconds'>
): AudioSegmentSelection {
  if (sampleRate <= 0 || samples.length === 0) {
    throw new Error('Audio signal is empty.');
  }

  const sourceDurationSeconds = samples.length / sampleRate;
  if (sourceDurationSeconds < 0.25) {
    throw new Error('Audio file is too short to analyze.');
  }

  const durationSeconds = Math.min(
    sourceDurationSeconds,
    clamp(options.targetDurationSeconds, options.minDurationSeconds, options.maxDurationSeconds)
  );
  const sampleCount = Math.max(1, Math.min(samples.length, Math.round(durationSeconds * sampleRate)));
  const stepSamples = Math.max(1, Math.round(sampleRate * 0.25));
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestStartSample = 0;
  let bestRms = 0;
  let bestPeak = 0;

  for (let startSample = 0; startSample + sampleCount <= samples.length; startSample += stepSamples) {
    let sumSquares = 0;
    let peak = 0;
    let clipped = 0;

    for (let offset = 0; offset < sampleCount; offset += 1) {
      const absoluteValue = Math.abs(samples[startSample + offset]);
      sumSquares += absoluteValue * absoluteValue;
      peak = Math.max(peak, absoluteValue);
      if (absoluteValue > 0.985) {
        clipped += 1;
      }
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    const crest = peak > 0 ? rms / peak : 0;
    const clippingPenalty = clipped / sampleCount;
    const score = rms * 1.9 + crest * 0.18 - clippingPenalty * 0.9;

    if (score > bestScore) {
      bestScore = score;
      bestStartSample = startSample;
      bestRms = rms;
      bestPeak = peak;
    }
  }

  if (bestRms < 0.00001 || bestPeak < 0.00002) {
    throw new Error('Audio signal is too quiet to analyze.');
  }

  return {
    startSample: bestStartSample,
    sampleCount,
    durationSeconds: sampleCount / sampleRate,
    rms: bestRms,
    peak: bestPeak
  };
}

export function prepareAudioSignal(input: AudioChannels, options: AudioSignalPrepareOptions): PreparedAudioSignal {
  const mono = downmixToMono(input.channels);
  const sourceDurationSeconds = mono.length / input.sampleRate;
  const segment = selectAutoSegment(mono, input.sampleRate, options);
  const selected = mono.slice(segment.startSample, segment.startSample + segment.sampleCount);
  const normalized = normalizeSignal(selected);
  const resampled = resampleLinear(normalized.samples, options.sampleCount);
  const finalNormalized = normalizeSignal(resampled);
  const sampleRate = options.sampleCount / segment.durationSeconds;

  return {
    samples: finalNormalized.samples,
    sampleRate,
    sourceDurationSeconds,
    segment,
    peak: finalNormalized.peak,
    rms: finalNormalized.rms
  };
}

