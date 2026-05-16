import { getPreset } from '@utilities/presets';
import { buildTransformRenderPlan } from '@utilities/transformRenderPlan';
import { analyzeTransformImages } from '@utilities/transformIntelligence';
import {
  buildResultPixels,
  createMatchingSearchContext,
  findBestAvailableSourceIndex,
  matchPackedPixels,
  packRgbPixels,
  resolveOutputDimensions,
  TransformDimensionMismatchError,
  transformPreparedImages
} from '@utilities/transformCore';

function imageFromRgbTriples(pixels: Array<[number, number, number]>, width: number, height: number) {
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach(([r, g, b], index) => {
    const offset = index * 4;
    rgba[offset] = r;
    rgba[offset + 1] = g;
    rgba[offset + 2] = b;
    rgba[offset + 3] = 255;
  });

  return { width, height, pixels: rgba };
}

function totalAbsoluteDifference(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference;
}

describe('transform core', () => {
  it('resolves bounded dimensions while preserving aspect ratio', () => {
    expect(resolveOutputDimensions(2400, 1200, getPreset('balanced').maxDimension)).toEqual({
      width: 384,
      height: 192
    });
  });

  it('matches deterministically and uses each source pixel once', () => {
    const source = imageFromRgbTriples(
      [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0]
      ],
      2,
      2
    );
    const target = imageFromRgbTriples(
      [
        [0, 0, 255],
        [255, 0, 0],
        [255, 255, 0],
        [0, 255, 0]
      ],
      2,
      2
    );

    const first = matchPackedPixels(packRgbPixels(source.pixels), packRgbPixels(target.pixels), 5);
    const second = matchPackedPixels(packRgbPixels(source.pixels), packRgbPixels(target.pixels), 5);

    expect(Array.from(first)).toEqual(Array.from(second));
    expect(new Set(Array.from(first)).size).toBe(first.length);
  });

  it('builds a final image with every source pixel placed once', () => {
    const source = imageFromRgbTriples(
      [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 0]
      ],
      2,
      2
    );
    const target = imageFromRgbTriples(
      [
        [0, 255, 0],
        [255, 255, 0],
        [255, 0, 0],
        [0, 0, 255]
      ],
      2,
      2
    );

    const result = transformPreparedImages(source, target, 5);
    const finalPixels = buildResultPixels(source, result.assignment);

    expect(finalPixels).toHaveLength(source.pixels.length);
    expect(Array.from(finalPixels.slice(0, 4))).toEqual([0, 255, 0, 255]);
    expect(result.matcherStrategy).toBe('single-optimized');
    expect(result.matcherStats.shortlistRequestCount).toBe(4);
    expect(result.timingsMs.analyze).toBeGreaterThanOrEqual(0);
    expect(result.timingsMs.rank).toBeGreaterThanOrEqual(0);
    expect(result.timingsMs.assign).toBeGreaterThanOrEqual(0);
    expect(result.matcherStats.evaluatedCandidateCount).toBeGreaterThan(0);
    expect(result.matcherStats.evaluatedGroupCount).toBeGreaterThan(0);
    expect(result.matcherStats.averageGroupsPerTarget).toBeGreaterThan(0);
  });

  it('preserves informative donors for high-need target regions', () => {
    const source = imageFromRgbTriples(
      [
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [28, 48, 62],
        [42, 90, 38],
        [183, 124, 98],
        [15, 18, 28]
      ],
      4,
      2
    );
    const target = imageFromRgbTriples(
      [
        [25, 45, 60],
        [46, 94, 40],
        [176, 126, 100],
        [18, 20, 30],
        [250, 250, 248],
        [252, 250, 246],
        [247, 247, 245],
        [253, 252, 250]
      ],
      4,
      2
    );

    const result = transformPreparedImages(source, target, 5);
    const analysis = analyzeTransformImages(source, target, 5);
    const highNeedAverage =
      (analysis.sourceUsefulnessByIndex[result.assignment[0]] +
        analysis.sourceUsefulnessByIndex[result.assignment[1]] +
        analysis.sourceUsefulnessByIndex[result.assignment[2]] +
        analysis.sourceUsefulnessByIndex[result.assignment[3]]) /
      4;
    const lowNeedAverage =
      (analysis.sourceUsefulnessByIndex[result.assignment[4]] +
        analysis.sourceUsefulnessByIndex[result.assignment[5]] +
        analysis.sourceUsefulnessByIndex[result.assignment[6]] +
        analysis.sourceUsefulnessByIndex[result.assignment[7]]) /
      4;

    expect(highNeedAverage).toBeGreaterThan(lowNeedAverage);
  });

  it('builds a cheat-aware arrival image that is materially closer to target for white-heavy sources', () => {
    const source = imageFromRgbTriples(
      [
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [30, 30, 30],
        [52, 106, 62],
        [182, 128, 98],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [34, 64, 114],
        [15, 17, 24]
      ],
      4,
      4
    );
    const target = imageFromRgbTriples(
      [
        [214, 197, 178],
        [35, 41, 55],
        [24, 28, 38],
        [212, 198, 180],
        [208, 193, 176],
        [64, 110, 71],
        [48, 82, 136],
        [205, 191, 174],
        [202, 188, 171],
        [180, 128, 100],
        [146, 100, 78],
        [198, 184, 169],
        [230, 216, 201],
        [40, 70, 120],
        [18, 20, 28],
        [226, 212, 198]
      ],
      4,
      4
    );

    const result = transformPreparedImages(source, target, 5);
    const strictPixels = buildResultPixels(source, result.assignment);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);
    const strictDifference = totalAbsoluteDifference(strictPixels, target.pixels);
    const cheatedDifference = totalAbsoluteDifference(renderPlan.finalPixels, target.pixels);

    expect(cheatedDifference).toBeLessThan(strictDifference);
    expect(Array.from(renderPlan.cheatedTargetPixels).some((value) => value === 1)).toBe(true);
  });

  it('uses duplicate exact-rgb donors to favor informative placements in high-need target regions', () => {
    const donor = [40, 60, 80] as [number, number, number];
    const similar = [42, 62, 82] as [number, number, number];
    const source = imageFromRgbTriples(
      [
        donor, [255, 255, 255], donor, [255, 255, 255],
        [255, 255, 255], donor, [255, 255, 255], donor,
        donor, similar, donor, similar,
        similar, donor, similar, donor
      ],
      4,
      4
    );
    const target = imageFromRgbTriples(
      [
        donor, [248, 248, 248], donor, [248, 248, 248],
        [248, 248, 248], donor, [248, 248, 248], donor,
        donor, similar, donor, similar,
        similar, donor, similar, donor
      ],
      4,
      4
    );

    const result = transformPreparedImages(source, target, 5);
    const analysis = analyzeTransformImages(source, target, 5);
    const highNeedAverage =
      (analysis.sourceUsefulnessByIndex[result.assignment[0]] +
        analysis.sourceUsefulnessByIndex[result.assignment[2]] +
        analysis.sourceUsefulnessByIndex[result.assignment[5]] +
        analysis.sourceUsefulnessByIndex[result.assignment[7]]) /
      4;
    const lowNeedAverage =
      (analysis.sourceUsefulnessByIndex[result.assignment[8]] +
        analysis.sourceUsefulnessByIndex[result.assignment[10]] +
        analysis.sourceUsefulnessByIndex[result.assignment[13]] +
        analysis.sourceUsefulnessByIndex[result.assignment[15]]) /
      4;

    expect(new Set(Array.from(result.assignment)).size).toBe(result.assignment.length);
    expect(highNeedAverage).toBeGreaterThan(lowNeedAverage);
    expect(result.matcherStats.fallbackCount).toBe(0);
  });

  it('keeps fallback work bounded on collision-heavy inputs', () => {
    const pixels = Array.from({ length: 64 }, (_, index) => {
      const bucket = index % 4;
      if (bucket === 0) return [184, 164, 142] as [number, number, number];
      if (bucket === 1) return [186, 166, 144] as [number, number, number];
      if (bucket === 2) return [52, 66, 84] as [number, number, number];
      return [24, 28, 36] as [number, number, number];
    });
    const source = imageFromRgbTriples(pixels, 8, 8);
    const target = imageFromRgbTriples([...pixels].reverse(), 8, 8);

    const result = transformPreparedImages(source, target, 5);

    expect(new Set(Array.from(result.assignment)).size).toBe(result.assignment.length);
    expect(result.matcherStats.fallbackCount).toBe(0);
    expect(result.matcherStats.shortlistHitRate).toBe(1);
    expect(result.matcherStats.averageGroupsPerTarget).toBeLessThanOrEqual(4.1);
    expect(result.matcherStats.evaluatedGroupCount).toBeLessThanOrEqual(256);
    expect(result.matcherStats.evaluatedCandidateCount).toBe(result.matcherStats.evaluatedGroupCount);
  });

  it('validates empty matching inputs before building search state', () => {
    expect(() => createMatchingSearchContext(new Uint32Array(), new Uint32Array(), 5)).toThrow(
      'at least one pixel'
    );
  });

  it('reports structured dimension mismatch details', () => {
    const source = imageFromRgbTriples([[0, 0, 0]], 1, 1);
    const target = imageFromRgbTriples(
      [
        [0, 0, 0],
        [255, 255, 255]
      ],
      2,
      1
    );

    expect(() => transformPreparedImages(source, target, 5)).toThrow(TransformDimensionMismatchError);
    try {
      transformPreparedImages(source, target, 5);
    } catch (error) {
      expect(error).toMatchObject({
        sourceWidth: 1,
        sourceHeight: 1,
        targetWidth: 2,
        targetHeight: 1
      });
    }
  });

  it('continues fallback search past the first occupied shell for a better color match', () => {
    const source = imageFromRgbTriples(
      [
        [0, 0, 0],
        [16, 16, 16]
      ],
      2,
      1
    );
    const target = imageFromRgbTriples(
      [
        [15, 15, 15],
        [0, 0, 0]
      ],
      2,
      1
    );
    const context = createMatchingSearchContext(packRgbPixels(source.pixels), packRgbPixels(target.pixels), 4);

    expect(findBestAvailableSourceIndex(context, 0, new Uint8Array(2))).toBe(1);
  });

  it('continues grouped shell search past the first occupied shell for a better color match', () => {
    const sourcePixels: Array<[number, number, number]> = [
      [0, 0, 0],
      [16, 16, 16]
    ];

    for (let red = 0; red < 16 && sourcePixels.length < 129; red += 1) {
      for (let green = 0; green < 16 && sourcePixels.length < 129; green += 1) {
        for (let blue = 0; blue < 16 && sourcePixels.length < 129; blue += 1) {
          const bucketKey = (red << 16) | (green << 8) | blue;
          if (bucketKey === 0 || bucketKey === 0x010101) {
            continue;
          }
          sourcePixels.push([red << 4, green << 4, blue << 4]);
        }
      }
    }

    const targetPixels = sourcePixels.slice();
    targetPixels[0] = [15, 15, 15];
    const source = imageFromRgbTriples(sourcePixels, sourcePixels.length, 1);
    const target = imageFromRgbTriples(targetPixels, targetPixels.length, 1);
    const assignment = matchPackedPixels(packRgbPixels(source.pixels), packRgbPixels(target.pixels), 4);

    expect(assignment[0]).toBe(1);
  });
});
