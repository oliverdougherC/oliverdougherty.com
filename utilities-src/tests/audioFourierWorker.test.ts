import type { AudioFourierAnalyzeRequest, AudioFourierCancelRequest, AudioFourierWorkerRequest } from '@utilities/audioFourierWorkerTypes';

describe('audio fourier worker message types', () => {
  it('analyze request contains all required fields', () => {
    const request: AudioFourierAnalyzeRequest = {
      type: 'analyze-audio-fourier',
      requestId: 1,
      presetId: 'fast',
      source: {
        sampleRate: 44100,
        channelBuffers: [new ArrayBuffer(8)],
        label: 'test',
        sourceKind: 'preset'
      }
    };
    expect(request.type).toBe('analyze-audio-fourier');
    expect(request.presetId).toBe('fast');
    expect(request.source.channelBuffers.length).toBe(1);
  });

  it('cancel request contains requestId', () => {
    const request: AudioFourierCancelRequest = {
      type: 'cancel-audio-fourier',
      requestId: 42
    };
    expect(request.type).toBe('cancel-audio-fourier');
    expect(request.requestId).toBe(42);
  });

  it('union type accepts both request kinds', () => {
    const analyzeRequest: AudioFourierWorkerRequest = {
      type: 'analyze-audio-fourier',
      requestId: 1,
      presetId: 'fast',
      source: {
        sampleRate: 44100,
        channelBuffers: [new ArrayBuffer(8)],
        label: 'test',
        sourceKind: 'file'
      }
    };
    const cancelRequest: AudioFourierWorkerRequest = {
      type: 'cancel-audio-fourier',
      requestId: 1
    };
    expect(analyzeRequest.type).toBe('analyze-audio-fourier');
    expect(cancelRequest.type).toBe('cancel-audio-fourier');
  });
});
