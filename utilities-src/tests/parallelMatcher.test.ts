import { buildRankedCandidateResponse } from '@utilities/matchingWorkerLogic';
import {
  matchPackedPixelsInParallel,
  resolveParallelWorkerCount,
  shouldUseParallelMatching,
  PARALLEL_MATCH_MIN_PIXELS,
  type MatchingWorkerLike
} from '@utilities/parallelMatcher';
import { packRgbPixels, resolveTargetOrder } from '@utilities/transformCore';
import { analyzeTransformImages } from '@utilities/transformIntelligence';
import type { MatchingWorkerRequest, MatchingWorkerResponse } from '@utilities/matchingWorkerTypes';

function imageFromRgbTriples(pixels: Array<[number, number, number]>, width: number, height: number) {
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([red, green, blue], index) => {
    const offset = index * 4;
    rgba[offset] = red;
    rgba[offset + 1] = green;
    rgba[offset + 2] = blue;
    rgba[offset + 3] = 255;
  });

  return { width, height, pixels: rgba };
}

class MockMatchingWorker implements MatchingWorkerLike {
  private listener: ((event: MessageEvent<MatchingWorkerResponse>) => void) | null = null;

  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<MatchingWorkerResponse>) => void
  ) {
    this.listener = listener;
  }

  removeEventListener() {
    this.listener = null;
  }

  postMessage(message: MatchingWorkerRequest) {
    const listener = this.listener;
    if (!listener) {
      throw new Error('Message listener missing.');
    }

    queueMicrotask(() => {
      listener({
        data: buildRankedCandidateResponse(message)
      } as MessageEvent<MatchingWorkerResponse>);
    });
  }

  terminate() {}
}

class HangingMatchingWorker implements MatchingWorkerLike {
  terminated = false;

  addEventListener() {}

  removeEventListener() {}

  postMessage() {}

  terminate() {
    this.terminated = true;
  }
}

describe('parallel matcher', () => {
  it('returns a complete one-to-one assignment when ranking work is split across workers', async () => {
    const source = imageFromRgbTriples(
      [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0],
        [255, 0, 255],
        [0, 255, 255],
        [180, 80, 32],
        [90, 35, 180],
        [20, 20, 20],
        [240, 240, 240],
        [110, 130, 90],
        [35, 90, 140],
        [205, 160, 110],
        [42, 64, 92],
        [152, 24, 60],
        [18, 145, 70]
      ],
      4,
      4
    );
    const target = imageFromRgbTriples(
      [
        [18, 145, 70],
        [205, 160, 110],
        [35, 90, 140],
        [255, 0, 255],
        [255, 255, 0],
        [90, 35, 180],
        [42, 64, 92],
        [0, 255, 255],
        [20, 20, 20],
        [255, 0, 0],
        [0, 255, 0],
        [180, 80, 32],
        [152, 24, 60],
        [240, 240, 240],
        [0, 0, 255],
        [110, 130, 90]
      ],
      4,
      4
    );

    const analysis = analyzeTransformImages(source, target, 5);
    const result = await matchPackedPixelsInParallel({
      sourcePacked: packRgbPixels(source.pixels),
      targetPacked: packRgbPixels(target.pixels),
      quantizationBits: 5,
      targetOrder: resolveTargetOrder(16, analysis),
      analysis,
      createWorker: () => new MockMatchingWorker(),
      workerCount: 3
    });

    expect(result.workerCount).toBe(3);
    expect(result.assignment).toHaveLength(16);
    expect(new Set(Array.from(result.assignment)).size).toBe(16);
  });

  it('falls back out of parallel mode when the environment does not meet the threshold', () => {
    expect(resolveParallelWorkerCount(1)).toBe(1);
    expect(resolveParallelWorkerCount(12)).toBe(8);
    expect(
      shouldUseParallelMatching({
        allowExperimental: true,
        pixelCount: PARALLEL_MATCH_MIN_PIXELS - 1,
        hardwareConcurrency: 8,
        supportsNestedWorkers: true
      })
    ).toBe(false);
    expect(
      shouldUseParallelMatching({
        allowExperimental: true,
        pixelCount: PARALLEL_MATCH_MIN_PIXELS,
        hardwareConcurrency: 2,
        supportsNestedWorkers: true
      })
    ).toBe(false);
    expect(
      shouldUseParallelMatching({
        allowExperimental: true,
        pixelCount: PARALLEL_MATCH_MIN_PIXELS,
        hardwareConcurrency: 8,
        supportsNestedWorkers: false
      })
    ).toBe(false);
    expect(
      shouldUseParallelMatching({
        allowExperimental: true,
        pixelCount: PARALLEL_MATCH_MIN_PIXELS,
        hardwareConcurrency: 8,
        supportsNestedWorkers: true
      })
    ).toBe(false);
  });

  it('times out and terminates an unresponsive ranking worker', async () => {
    const source = imageFromRgbTriples([[0, 0, 0]], 1, 1);
    const target = imageFromRgbTriples([[0, 0, 0]], 1, 1);
    const analysis = analyzeTransformImages(source, target, 5);
    const worker = new HangingMatchingWorker();

    await expect(
      matchPackedPixelsInParallel({
        sourcePacked: packRgbPixels(source.pixels),
        targetPacked: packRgbPixels(target.pixels),
        quantizationBits: 5,
        targetOrder: resolveTargetOrder(1, analysis),
        analysis,
        createWorker: () => worker,
        workerCount: 1,
        workerTimeoutMs: 1
      })
    ).rejects.toThrow('timed out');
    expect(worker.terminated).toBe(true);
  });
});
