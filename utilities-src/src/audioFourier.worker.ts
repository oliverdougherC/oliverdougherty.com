/// <reference lib="webworker" />

import {
  buildEnergyBandEnvelopes,
  buildEnergyBandReconstruction,
  buildSampleEnvelope,
  buildWindowedFourierAnalysis,
  resolveEnvelopeBucketSampleCount
} from './audioFourierCore';
import type { AudioFourierAnalyzeRequest, AudioFourierWorkerRequest, AudioFourierWorkerResponse } from './audioFourierWorkerTypes';
import { getAudioFourierPreset } from './audioPresets';
import { prepareAudioSignal } from './audioSignal';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<number>();
const pendingRequests: AudioFourierAnalyzeRequest[] = [];
let isProcessing = false;

function asArrayBuffer(buffer: ArrayBufferLike): ArrayBuffer {
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(new Uint8Array(buffer));
  return copy.buffer;
}

function now() {
  return performance.now();
}

function postMessage(message: AudioFourierWorkerResponse, transfer?: Transferable[]) {
  workerScope.postMessage(message, transfer ?? []);
}

function assertNotCancelled(requestId: number) {
  if (cancelledRequests.has(requestId)) {
    throw new Error('Audio Fourier analysis cancelled.');
  }
}

async function handleAnalyzeRequest(request: Extract<AudioFourierWorkerRequest, { type: 'analyze-audio-fourier' }>) {
  const startedAt = now();
  const preset = getAudioFourierPreset(request.presetId);

  try {
    const channels = request.source.channelBuffers.map((buffer) => new Float32Array(buffer));
    postMessage({
      type: 'audio-fourier-progress',
      requestId: request.requestId,
      progress: 0.04,
      message: 'Building full-song analysis proxy...'
    });

    const proxyStartedAt = now();
    const prepared = prepareAudioSignal(
      {
        sampleRate: request.source.sampleRate,
        channels
      },
      preset
    );
    const proxyMs = now() - proxyStartedAt;
    assertNotCancelled(request.requestId);

    postMessage({
      type: 'audio-fourier-progress',
      requestId: request.requestId,
      progress: 0.12,
      message: 'Running windowed Fourier analysis...'
    });

    const analysisStartedAt = now();
    const analysis = buildWindowedFourierAnalysis(
      prepared.samples,
      prepared.sampleRate,
      preset,
      (progress, message) => {
        assertNotCancelled(request.requestId);
        postMessage({
          type: 'audio-fourier-progress',
          requestId: request.requestId,
          progress,
          message
        });
      }
    );
    const analysisMs = now() - analysisStartedAt;
    assertNotCancelled(request.requestId);

    postMessage({
      type: 'audio-fourier-progress',
      requestId: request.requestId,
      progress: 0.62,
      message: 'Rendering live energy bands...'
    });
    const bandsStartedAt = now();
    const bands = buildEnergyBandReconstruction(
      analysis,
      preset.energyBandCount,
      (progress, message) => {
        assertNotCancelled(request.requestId);
        postMessage({
          type: 'audio-fourier-progress',
          requestId: request.requestId,
          progress,
          message
        });
      }
    );
    const bandsMs = now() - bandsStartedAt;
    assertNotCancelled(request.requestId);

    const envelopeBucketSampleCount = resolveEnvelopeBucketSampleCount(prepared.sampleRate);
    postMessage({
      type: 'audio-fourier-progress',
      requestId: request.requestId,
      progress: 0.96,
      message: 'Building waveform envelopes...'
    });
    const originalEnvelope = buildSampleEnvelope(analysis.samples, envelopeBucketSampleCount);
    assertNotCancelled(request.requestId);
    const bandEnvelopes = buildEnergyBandEnvelopes(
      bands.bandSamples,
      bands.sampleCount,
      bands.bandCount,
      envelopeBucketSampleCount
    );
    assertNotCancelled(request.requestId);

    const totalMs = now() - startedAt;
    const bandSamplesBuffer = asArrayBuffer(bands.bandSamples.buffer);
    const originalEnvelopeMinBuffer = asArrayBuffer(originalEnvelope.min.buffer);
    const originalEnvelopeMaxBuffer = asArrayBuffer(originalEnvelope.max.buffer);
    const bandEnvelopeMinBuffer = asArrayBuffer(bandEnvelopes.min.buffer);
    const bandEnvelopeMaxBuffer = asArrayBuffer(bandEnvelopes.max.buffer);
    const bandEndComponentCountsBuffer = asArrayBuffer(bands.bandEndComponentCounts.buffer);
    const bandEnergyFractionsBuffer = asArrayBuffer(bands.bandEnergyFractions.buffer);
    const componentFrequenciesBuffer = asArrayBuffer(analysis.componentFrequencies.buffer);
    const componentAmplitudesBuffer = asArrayBuffer(analysis.componentAmplitudes.buffer);
    const componentPhasesBuffer = asArrayBuffer(analysis.componentPhases.buffer);

    postMessage(
      {
        type: 'audio-fourier-success',
        requestId: request.requestId,
        metadata: {
          analysisId: request.requestId,
          presetId: preset.id,
          label: request.source.label,
          sourceKind: request.source.sourceKind,
          sourceDurationSeconds: prepared.sourceDurationSeconds,
          proxyDurationSeconds: prepared.proxyDurationSeconds,
          proxySampleRate: prepared.sampleRate,
          proxySampleCount: prepared.samples.length,
          componentCount: analysis.componentOrder.length,
          bandCount: bands.bandCount,
          envelopeBucketSampleCount,
          envelopeBucketCount: originalEnvelope.bucketCount,
          displaySampleCount: preset.displaySampleCount,
          frameCount: analysis.frameCount,
          frameSize: preset.frameSize,
          hopSize: preset.hopSize,
          sliderSteps: preset.sliderSteps,
          timingsMs: {
            proxy: proxyMs,
            analysis: analysisMs,
            bands: bandsMs,
            total: totalMs
          }
        },
        bandSamples: bandSamplesBuffer,
        originalEnvelopeMin: originalEnvelopeMinBuffer,
        originalEnvelopeMax: originalEnvelopeMaxBuffer,
        bandEnvelopeMin: bandEnvelopeMinBuffer,
        bandEnvelopeMax: bandEnvelopeMaxBuffer,
        bandEndComponentCounts: bandEndComponentCountsBuffer,
        bandEnergyFractions: bandEnergyFractionsBuffer,
        componentFrequencies: componentFrequenciesBuffer,
        componentAmplitudes: componentAmplitudesBuffer,
        componentPhases: componentPhasesBuffer
      },
      [
        bandSamplesBuffer,
        originalEnvelopeMinBuffer,
        originalEnvelopeMaxBuffer,
        bandEnvelopeMinBuffer,
        bandEnvelopeMaxBuffer,
        bandEndComponentCountsBuffer,
        bandEnergyFractionsBuffer,
        componentFrequenciesBuffer,
        componentAmplitudesBuffer,
        componentPhasesBuffer
      ]
      // None of the above ArrayBuffers share backing stores: bands.* and envelopes are freshly allocated, and the component arrays (frequencies/amplitudes/phases) own their buffers from the analysis constructor.
    );
  } catch (error) {
    if (/cancelled/i.test(error instanceof Error ? error.message : '')) {
      postMessage({
        type: 'audio-fourier-cancelled',
        requestId: request.requestId
      });
      return;
    }

    postMessage({
      type: 'audio-fourier-error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : 'Unable to analyze this audio signal.'
    });
  } finally {
    cancelledRequests.delete(request.requestId);
  }
}

async function processQueue() {
  if (isProcessing || pendingRequests.length === 0) return;
  isProcessing = true;

  while (pendingRequests.length > 0) {
    const request = pendingRequests.shift()!;
    if (cancelledRequests.has(request.requestId)) {
      cancelledRequests.delete(request.requestId);
      continue;
    }
    await handleAnalyzeRequest(request);
  }

  isProcessing = false;
}

workerScope.onmessage = (event: MessageEvent<AudioFourierWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel-audio-fourier') {
    cancelledRequests.add(request.requestId);
    return;
  }

  if (request.type !== 'analyze-audio-fourier') {
    postMessage({
      type: 'audio-fourier-error',
      requestId: (request as any).requestId ?? 0,
      message: 'Malformed worker message: missing or unrecognized type.'
    });
    return;
  }

  if (!request.presetId) {
    postMessage({
      type: 'audio-fourier-error',
      requestId: request.requestId,
      message: 'Malformed worker message: missing presetId.'
    });
    return;
  }

  pendingRequests.push(request);
  void processQueue();
};
