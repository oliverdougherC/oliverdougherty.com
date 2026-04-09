import { buildBuiltInTransformCacheKey, cloneWorkerSuccessMessage } from '@utilities/transformCache';
import type { ImageSelection } from '@utilities/uiState';
import type { WorkerSuccessMessage } from '@utilities/workerTypes';

function createDemoSelection(label: string, url: string): ImageSelection {
  return {
    kind: 'demo',
    label,
    url
  };
}

function createCachedMessage(): WorkerSuccessMessage {
  return {
    type: 'success',
    requestId: 7,
    source: {
      width: 1,
      height: 1,
      pixels: new Uint8ClampedArray([1, 2, 3, 255]).buffer,
      originalWidth: 1,
      originalHeight: 1,
      scaled: false
    },
    target: {
      width: 1,
      height: 1,
      pixels: new Uint8ClampedArray([4, 5, 6, 255]).buffer,
      originalWidth: 1,
      originalHeight: 1,
      scaled: false
    },
    assignment: new Uint32Array([0]).buffer,
    metadata: {
      presetId: 'balanced',
      quantizationBits: 5,
      outputWidth: 1,
      outputHeight: 1,
      pixelCount: 1,
      sourceOriginalWidth: 1,
      sourceOriginalHeight: 1,
      targetOriginalWidth: 1,
      targetOriginalHeight: 1,
      sourceScaled: false,
      targetScaled: false,
      processingMs: 1,
      timingsMs: {
        decode: 0,
        analyze: 0,
        rank: 0,
        assign: 1,
        total: 1
      },
      matcherStrategy: 'single-optimized',
      fallbackCount: 0,
      shortlistHitRate: 1,
      evaluatedCandidateCount: 1,
      evaluatedGroupCount: 1,
      averageGroupsPerTarget: 1,
      workerCount: 1
    }
  };
}

describe('transform cache', () => {
  it('builds cache keys only for built-in demo selections', () => {
    const source = createDemoSelection('Pattern', '../../assets/utilities/pattern.png');
    const target = createDemoSelection('Face', '../../assets/utilities/face.png');

    expect(buildBuiltInTransformCacheKey(source, target, 'fast')).toBe(
      'fast::../../assets/utilities/pattern.png::../../assets/utilities/face.png'
    );
    expect(
      buildBuiltInTransformCacheKey(
        { kind: 'file', label: 'upload.png' },
        target,
        'fast'
      )
    ).toBeNull();
  });

  it('clones cached worker payloads before replaying them', () => {
    const original = createCachedMessage();
    const cloned = cloneWorkerSuccessMessage(original, 42);

    expect(cloned).not.toBe(original);
    expect(cloned.requestId).toBe(42);
    expect(cloned.source.pixels).not.toBe(original.source.pixels);
    expect(cloned.target.pixels).not.toBe(original.target.pixels);
    expect(cloned.assignment).not.toBe(original.assignment);

    new Uint8ClampedArray(cloned.source.pixels)[0] = 99;
    expect(new Uint8ClampedArray(original.source.pixels)[0]).toBe(1);
  });
});
