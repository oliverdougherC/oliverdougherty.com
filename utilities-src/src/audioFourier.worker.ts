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
import { arrayBufferLikeToArrayBuffer } from './bufferUtils';

const cancelledRequests = new Set<number>();
const pendingRequests: AudioFourierAnalyzeRequest[] = [];
const MAX_PENDING_REQUESTS = 2;
let isProcessing = false;

function now() {
  return performance.now();
}

function postMessage(message: AudioFourierWorkerResponse, transfer?: Transferable[]) {
  self.postMessage(message, { transfer: transfer ?? [] });
}

function assertNotCancelled(requestId: number) {
  if (cancelledRequests.has(requestId)) {
    throw new Error('Audio Fourier analysis cancelled.');
  }
}

function resolveWorkerRequestId(request: unknown) {
  if (!request || typeof request !== 'object') {
    return 0;
  }
  if (!('requestId' in request)) {
    return 0;
  }
  return typeof request.requestId === 'number' ? request.requestId : 0;
}

function isAudioFourierAnalyzeRequest(request: unknown): request is AudioFourierAnalyzeRequest {
  if (!request || typeof request !== 'object') {
    return false;
  }
  return (request as { type?: unknown }).type === 'analyze-audio-fourier'
    && typeof (request as { requestId?: unknown }).requestId === 'number'
    && typeof (request as { presetId?: unknown }).presetId === 'string'
    && typeof (request as { source?: unknown }).source === 'object'
    && (request as { source?: { channelBuffers?: unknown } }).source !== null;
}

function isAudioFourierCancelRequest(request: unknown): request is Extract<AudioFourierWorkerRequest, { type: 'cancel-audio-fourier' }> {
  if (!request || typeof request !== 'object') {
    return false;
  }
  return (request as { type?: unknown }).type === 'cancel-audio-fourier'
    && typeof (request as { requestId?: unknown }).requestId === 'number';
}

function postUnexpectedWorkerError(error: unknown, requestId = 0) {
  postMessage({
    type: 'audio-fourier-error',
    requestId,
    message: error instanceof Error ? error.message : 'Unexpected worker failure during Fourier analysis.'
  });
}

async function handleAnalyzeRequest(request: Extract<AudioFourierWorkerRequest, { type: 'analyze-audio-fourier' }>) {
  const startedAt = now();
  const preset = getAudioFourierPreset(request.presetId);

  try {
    const maxSourceBytes = preset.maxProxySampleCount * Float32Array.BYTES_PER_ELEMENT * 8;
    let sourceBytes = 0;
    for (const buffer of request.source.channelBuffers) {
      sourceBytes += buffer.byteLength;
    }
    if (sourceBytes > maxSourceBytes) {
      throw new Error('Audio source is too large for worker analysis.');
    }

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
    const envelopesStartedAt = now();
    const originalEnvelope = buildSampleEnvelope(analysis.samples, envelopeBucketSampleCount);
    assertNotCancelled(request.requestId);
    const bandEnvelopes = buildEnergyBandEnvelopes(
      bands.bandSamples,
      bands.sampleCount,
      bands.bandCount,
      envelopeBucketSampleCount
    );
    const envelopesMs = now() - envelopesStartedAt;
    assertNotCancelled(request.requestId);

    const totalMs = now() - startedAt;
    const bandSamplesBuffer = arrayBufferLikeToArrayBuffer(bands.bandSamples.buffer);
    const originalEnvelopeMinBuffer = arrayBufferLikeToArrayBuffer(originalEnvelope.min.buffer);
    const originalEnvelopeMaxBuffer = arrayBufferLikeToArrayBuffer(originalEnvelope.max.buffer);
    const bandEnvelopeMinBuffer = arrayBufferLikeToArrayBuffer(bandEnvelopes.min.buffer);
    const bandEnvelopeMaxBuffer = arrayBufferLikeToArrayBuffer(bandEnvelopes.max.buffer);
    const bandEndComponentCountsBuffer = arrayBufferLikeToArrayBuffer(bands.bandEndComponentCounts.buffer);
    const bandEnergyFractionsBuffer = arrayBufferLikeToArrayBuffer(bands.bandEnergyFractions.buffer);
    const componentFrequenciesBuffer = arrayBufferLikeToArrayBuffer(analysis.componentFrequencies.buffer);
    const componentAmplitudesBuffer = arrayBufferLikeToArrayBuffer(analysis.componentAmplitudes.buffer);
    const componentPhasesBuffer = arrayBufferLikeToArrayBuffer(analysis.componentPhases.buffer);

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
            envelopes: envelopesMs,
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

  try {
    while (pendingRequests.length > 0) {
      const request = pendingRequests.shift()!;
      if (cancelledRequests.has(request.requestId)) {
        cancelledRequests.delete(request.requestId);
        continue;
      }
      await handleAnalyzeRequest(request);
    }
  } finally {
    isProcessing = false;
    if (pendingRequests.length > 0) {
      queueProcessing();
    }
  }
}

function queueProcessing() {
  void processQueue().catch((error) => {
    isProcessing = false;
    postUnexpectedWorkerError(error);
  });
}

self.onmessage = (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (isAudioFourierCancelRequest(request)) {
    cancelledRequests.add(request.requestId);
    return;
  }

  if (!isAudioFourierAnalyzeRequest(request)) {
    postMessage({
      type: 'audio-fourier-error',
      requestId: resolveWorkerRequestId(request),
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

  if (pendingRequests.length >= MAX_PENDING_REQUESTS) {
    pendingRequests.shift();
  }
  pendingRequests.push(request);
  queueProcessing();
};
