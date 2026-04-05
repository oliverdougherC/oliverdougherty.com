import { createWorkerRequestHandler } from '@utilities/workerRuntime';
import type { WorkerResponse } from '@utilities/workerTypes';

describe('worker runtime', () => {
  it('emits progress and success for prepared-image requests', async () => {
    const messages: WorkerResponse[] = [];
    const handler = createWorkerRequestHandler({
      prepareBitmaps: async () => {
        throw new Error('Bitmap path should not be used in this test.');
      },
      postMessage(message) {
        messages.push(message);
      }
    });

    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
      0, 0, 255, 255,
      255, 255, 0, 255
    ]);

    await handler({
      type: 'transform-prepared',
      requestId: 1,
      presetId: 'fast',
      source: {
        width: 2,
        height: 2,
        pixels: pixels.slice().buffer,
        originalWidth: 2,
        originalHeight: 2,
        scaled: false
      },
      target: {
        width: 2,
        height: 2,
        pixels: pixels.slice().buffer,
        originalWidth: 2,
        originalHeight: 2,
        scaled: false
      }
    });

    expect(messages.some((message) => message.type === 'progress')).toBe(true);
    const success = messages.find((message) => message.type === 'success');
    expect(success).toBeDefined();
    expect(success && success.type === 'success' ? success.metadata.pixelCount : 0).toBe(4);
    expect(success && success.type === 'success' ? success.metadata.matcherStrategy : 'parallel-experimental').toBe('single-optimized');
    expect(success && success.type === 'success' ? success.metadata.timingsMs.total : 0).toBeGreaterThanOrEqual(0);
    expect(success && success.type === 'success' ? success.metadata.fallbackCount : -1).toBeGreaterThanOrEqual(0);
    expect(success && success.type === 'success' ? success.metadata.evaluatedCandidateCount : 0).toBeGreaterThan(0);
    expect(success && success.type === 'success' ? success.metadata.evaluatedGroupCount : 0).toBeGreaterThan(0);
    expect(success && success.type === 'success' ? success.metadata.workerCount : 0).toBe(1);
  });

  it('emits an error for mismatched prepared images', async () => {
    const messages: WorkerResponse[] = [];
    const handler = createWorkerRequestHandler({
      prepareBitmaps: async () => {
        throw new Error('Bitmap path should not be used in this test.');
      },
      postMessage(message) {
        messages.push(message);
      }
    });

    await handler({
      type: 'transform-prepared',
      requestId: 2,
      presetId: 'fast',
      source: {
        width: 2,
        height: 2,
        pixels: new Uint8ClampedArray(16).buffer,
        originalWidth: 2,
        originalHeight: 2,
        scaled: false
      },
      target: {
        width: 3,
        height: 2,
        pixels: new Uint8ClampedArray(24).buffer,
        originalWidth: 3,
        originalHeight: 2,
        scaled: false
      }
    });

    const error = messages.find((message) => message.type === 'error');
    expect(error).toBeDefined();
    expect(error && error.type === 'error' ? error.message : '').toMatch(/dimensions must match/i);
  });
});
