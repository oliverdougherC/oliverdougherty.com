import {
  buildBuiltInTransformCacheKey,
  cloneCachedBuiltInTransform,
  createCachedBuiltInTransform,
  hydratePrecomputedBuiltInTransform,
  serializePrecomputedBuiltInTransform
} from '@utilities/transformCache';
import type { TransformRenderPlan } from '@utilities/transformRenderPlan';
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

function createRenderPlan(): TransformRenderPlan {
  return {
    finalPixels: new Uint8ClampedArray([7, 8, 9, 255]),
    tintStrengthByTarget: new Float32Array([0.75]),
    cheatedTargetPixels: new Uint8Array([1])
  };
}

describe('transform cache', () => {
  it('builds cache keys only for built-in demo selections', () => {
    const source = createDemoSelection('Pattern', '../../assets/utilities/image-transform/pattern.png');
    const target = createDemoSelection('Face', '../../assets/utilities/image-transform/face.png');

    expect(buildBuiltInTransformCacheKey(source, target, 'fast')).toBe(
      'fast::../../assets/utilities/image-transform/pattern.png::../../assets/utilities/image-transform/face.png'
    );
    expect(
      buildBuiltInTransformCacheKey(
        { kind: 'file', label: 'upload.png' },
        target,
        'fast'
      )
    ).toBeNull();
  });

  it('clones cached built-in animation payloads before replaying them', () => {
    const original = createCachedBuiltInTransform(createCachedMessage(), createRenderPlan());
    const cloned = cloneCachedBuiltInTransform(original, 42);

    expect(cloned).not.toBe(original);
    expect(cloned.message.requestId).toBe(42);
    expect(cloned.message.source.pixels).not.toBe(original.message.source.pixels);
    expect(cloned.message.target.pixels).not.toBe(original.message.target.pixels);
    expect(cloned.message.assignment).not.toBe(original.message.assignment);
    expect(cloned.finalPixels).not.toBe(original.finalPixels);
    expect(cloned.tintStrengthByTarget).not.toBe(original.tintStrengthByTarget);
    expect(cloned.cheatedTargetPixels).not.toBe(original.cheatedTargetPixels);

    new Uint8ClampedArray(cloned.message.source.pixels)[0] = 99;
    new Uint8ClampedArray(cloned.finalPixels)[0] = 88;
    expect(new Uint8ClampedArray(original.message.source.pixels)[0]).toBe(1);
    expect(new Uint8ClampedArray(original.finalPixels)[0]).toBe(7);
  });

  it('serializes and hydrates precomputed built-in transforms', () => {
    const serialized = serializePrecomputedBuiltInTransform(createCachedMessage(), createRenderPlan());
    const hydrated = hydratePrecomputedBuiltInTransform(serialized);

    expect(new Uint32Array(hydrated.assignment)[0]).toBe(0);
    expect(new Uint8ClampedArray(hydrated.finalPixels)[0]).toBe(7);
    expect(new Float32Array(hydrated.tintStrengthByTarget)[0]).toBeCloseTo(0.75);
    expect(new Uint8Array(hydrated.cheatedTargetPixels)[0]).toBe(1);
    expect(hydrated.metadata.presetId).toBe('balanced');
  });
});
