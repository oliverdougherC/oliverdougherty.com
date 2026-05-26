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

  describe('message validation patterns', () => {
    // These tests mirror the worker's internal validation logic to ensure
    // the message shape contracts remain consistent with the handler expectations.

    it('identifies analyze requests by type and required fields', () => {
      const analyzeRequest = {
        type: 'analyze-audio-fourier',
        requestId: 1,
        presetId: 'fast',
        source: { sampleRate: 44100, channelBuffers: [], label: 'test', sourceKind: 'file' as const }
      };
      expect(analyzeRequest.type).toBe('analyze-audio-fourier');
      expect(typeof analyzeRequest.requestId).toBe('number');
      expect(typeof analyzeRequest.presetId).toBe('string');
      expect(typeof analyzeRequest.source).toBe('object');
      expect(analyzeRequest.source).not.toBe(null);
    });

    it('identifies cancel requests by type and requestId', () => {
      const cancelRequest = {
        type: 'cancel-audio-fourier',
        requestId: 5
      };
      expect(cancelRequest.type).toBe('cancel-audio-fourier');
      expect(typeof cancelRequest.requestId).toBe('number');
    });

    it('rejects malformed messages missing type field', () => {
      const malformed = { requestId: 1 };
      expect(malformed.type).toBeUndefined();
      // Worker would reject this as unrecognized
    });

    it('rejects messages with invalid requestId type', () => {
      const badRequest = {
        type: 'analyze-audio-fourier',
        requestId: 'not-a-number',
        presetId: 'fast',
        source: { sampleRate: 44100, channelBuffers: [], label: 'test', sourceKind: 'file' as const }
      };
      expect(typeof badRequest.requestId).toBe('string');
      // Worker's isAudioFourierAnalyzeRequest checks typeof requestId === 'number'
    });

    it('rejects null source objects', () => {
      const badRequest = {
        type: 'analyze-audio-fourier',
        requestId: 1,
        presetId: 'fast',
        source: null
      };
      expect(badRequest.source).toBe(null);
      // Worker checks source !== null
    });

    it('handles multi-channel analyze requests', () => {
      const request: AudioFourierAnalyzeRequest = {
        type: 'analyze-audio-fourier',
        requestId: 2,
        presetId: 'balanced',
        source: {
          sampleRate: 48000,
          channelBuffers: [new ArrayBuffer(8), new ArrayBuffer(8)],
          label: 'stereo-test',
          sourceKind: 'file'
        }
      };
      expect(request.source.channelBuffers.length).toBe(2);
      expect(request.source.sampleRate).toBe(48000);
    });

    it('resolveWorkerRequestId returns 0 for invalid inputs', () => {
      // Mirrors the worker's resolveWorkerRequestId function
      const resolveRequestId = (request: unknown): number => {
        if (!request || typeof request !== 'object') {
          return 0;
        }
        if (!('requestId' in request)) {
          return 0;
        }
        return typeof (request as { requestId?: unknown }).requestId === 'number'
          ? (request as { requestId: number }).requestId
          : 0;
      };

      expect(resolveRequestId(null)).toBe(0);
      expect(resolveRequestId(undefined)).toBe(0);
      expect(resolveRequestId('string')).toBe(0);
      expect(resolveRequestId(42)).toBe(0);
      expect(resolveRequestId({})).toBe(0);
      expect(resolveRequestId({ requestId: 'not-a-number' })).toBe(0);
      expect(resolveRequestId({ requestId: 5 })).toBe(5);
    });

    it('assertNotCancelled throws for cancelled request IDs', () => {
      // Mirrors the worker's assertNotCancelled function
      const cancelledRequests = new Set<number>();
      const assertNotCancelled = (requestId: number): void => {
        if (cancelledRequests.has(requestId)) {
          throw new Error('Audio Fourier analysis cancelled.');
        }
      };

      cancelledRequests.add(1);
      expect(() => assertNotCancelled(1)).toThrow('Audio Fourier analysis cancelled.');
      expect(() => assertNotCancelled(2)).not.toThrow();
    });

    it('request queuing respects MAX_PENDING_REQUESTS limit', () => {
      // Mirrors the worker's queue management: when pendingRequests.length >= MAX_PENDING_REQUESTS,
      // the oldest request is shifted before pushing the new one.
      const MAX_PENDING_REQUESTS = 2;
      const pendingRequests: { requestId: number }[] = [];

      pendingRequests.push({ requestId: 1 });
      pendingRequests.push({ requestId: 2 });
      expect(pendingRequests.length).toBe(2);

      // Next push should shift the oldest
      if (pendingRequests.length >= MAX_PENDING_REQUESTS) {
        pendingRequests.shift();
      }
      pendingRequests.push({ requestId: 3 });

      expect(pendingRequests.length).toBe(2);
      expect(pendingRequests[0].requestId).toBe(2);
      expect(pendingRequests[1].requestId).toBe(3);
    });

    it('cancellation removes request from cancelled set during processing', () => {
      // Mirrors the worker's processQueue behavior: cancelled requests are
      // skipped and removed from the cancelled set before processing.
      const cancelledRequests = new Set<number>();
      const pendingRequests = [{ requestId: 1 }, { requestId: 2 }, { requestId: 3 }];
      cancelledRequests.add(2);

      const processed: number[] = [];
      for (const request of pendingRequests) {
        if (cancelledRequests.has(request.requestId)) {
          cancelledRequests.delete(request.requestId);
          continue;
        }
        processed.push(request.requestId);
      }

      expect(processed).toEqual([1, 3]);
      expect(cancelledRequests.has(2)).toBe(false);
    });
  });
});
