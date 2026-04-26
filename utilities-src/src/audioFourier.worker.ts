/// <reference lib="webworker" />

import {
  buildEnergyBandReconstruction,
  buildWindowedFourierAnalysis
} from './audioFourierCore';
import type { AudioFourierWorkerRequest, AudioFourierWorkerResponse } from './audioFourierWorkerTypes';
import { getAudioFourierPreset } from './audioPresets';
import { prepareAudioSignal } from './audioSignal';

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const cancelledRequests = new Set<number>();

function asArrayBuffer(buffer: ArrayBufferLike) {
  return buffer as ArrayBuffer;
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
      progress: 0.1,
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
      progress: 0.82,
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

    const totalMs = now() - startedAt;

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
        originalSamples: asArrayBuffer(analysis.samples.buffer),
        bandSamples: asArrayBuffer(bands.bandSamples.buffer),
        bandEndComponentCounts: asArrayBuffer(bands.bandEndComponentCounts.buffer),
        bandEnergyFractions: asArrayBuffer(bands.bandEnergyFractions.buffer),
        componentFrequencies: asArrayBuffer(analysis.componentFrequencies.buffer),
        componentAmplitudes: asArrayBuffer(analysis.componentAmplitudes.buffer),
        componentPhases: asArrayBuffer(analysis.componentPhases.buffer)
      },
      [
        asArrayBuffer(analysis.samples.buffer),
        asArrayBuffer(bands.bandSamples.buffer),
        asArrayBuffer(bands.bandEndComponentCounts.buffer),
        asArrayBuffer(bands.bandEnergyFractions.buffer),
        asArrayBuffer(analysis.componentFrequencies.buffer),
        asArrayBuffer(analysis.componentAmplitudes.buffer),
        asArrayBuffer(analysis.componentPhases.buffer)
      ]
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

workerScope.onmessage = (event: MessageEvent<AudioFourierWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'cancel-audio-fourier') {
    cancelledRequests.add(request.requestId);
    return;
  }

  void handleAnalyzeRequest(request);
};
