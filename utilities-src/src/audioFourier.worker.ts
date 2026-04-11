/// <reference lib="webworker" />

import { buildAudioFourierReconstruction } from './audioFourierCore';
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
      message: 'Selecting the strongest audio segment...'
    });

    const segmentStartedAt = now();
    const prepared = prepareAudioSignal(
      {
        sampleRate: request.source.sampleRate,
        channels
      },
      preset
    );
    const segmentMs = now() - segmentStartedAt;
    assertNotCancelled(request.requestId);

    postMessage({
      type: 'audio-fourier-progress',
      requestId: request.requestId,
      progress: 0.14,
      message: 'Running Fourier transform...'
    });

    const fftStartedAt = now();
    let fftMs = 0;
    const reconstructionStartedAt = now();
    const reconstruction = buildAudioFourierReconstruction(
      prepared.samples,
      prepared.sampleRate,
      preset,
      (progress, message) => {
        assertNotCancelled(request.requestId);
        if (fftMs === 0 && progress >= 0.18) {
          fftMs = now() - fftStartedAt;
        }
        postMessage({
          type: 'audio-fourier-progress',
          requestId: request.requestId,
          progress,
          message
        });
      }
    );
    if (fftMs === 0) {
      fftMs = now() - fftStartedAt;
    }
    const reconstructionMs = now() - reconstructionStartedAt;
    assertNotCancelled(request.requestId);

    const finalFrame = reconstruction.visualFrames.slice(
      (preset.visualFrameCount - 1) * preset.displaySampleCount,
      preset.visualFrameCount * preset.displaySampleCount
    );
    const totalMs = now() - startedAt;

    postMessage(
      {
        type: 'audio-fourier-success',
        requestId: request.requestId,
        metadata: {
          presetId: preset.id,
          label: request.source.label,
          sourceKind: request.source.sourceKind,
          sourceDurationSeconds: prepared.sourceDurationSeconds,
          segmentStartSeconds: prepared.segment.startSample / request.source.sampleRate,
          segmentDurationSeconds: prepared.segment.durationSeconds,
          sampleRate: prepared.sampleRate,
          sampleCount: prepared.samples.length,
          componentCount: reconstruction.analysis.components.length,
          displaySampleCount: preset.displaySampleCount,
          visualFrameCount: preset.visualFrameCount,
          playbackDurationSeconds: reconstruction.playbackSamples.length / prepared.sampleRate,
          timingsMs: {
            segment: segmentMs,
            fft: fftMs,
            reconstruction: reconstructionMs,
            total: totalMs
          }
        },
        visualFrames: asArrayBuffer(reconstruction.visualFrames.buffer),
        finalFrame: asArrayBuffer(finalFrame.buffer),
        playbackSamples: asArrayBuffer(reconstruction.playbackSamples.buffer),
        frameComponentCounts: asArrayBuffer(reconstruction.frameComponentCounts.buffer),
        componentFrequencies: asArrayBuffer(reconstruction.componentFrequencies.buffer),
        componentAmplitudes: asArrayBuffer(reconstruction.componentAmplitudes.buffer),
        componentPhases: asArrayBuffer(reconstruction.componentPhases.buffer),
        componentEnergies: asArrayBuffer(reconstruction.componentEnergies.buffer)
      },
      [
        asArrayBuffer(reconstruction.visualFrames.buffer),
        asArrayBuffer(finalFrame.buffer),
        asArrayBuffer(reconstruction.playbackSamples.buffer),
        asArrayBuffer(reconstruction.frameComponentCounts.buffer),
        asArrayBuffer(reconstruction.componentFrequencies.buffer),
        asArrayBuffer(reconstruction.componentAmplitudes.buffer),
        asArrayBuffer(reconstruction.componentPhases.buffer),
        asArrayBuffer(reconstruction.componentEnergies.buffer)
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
