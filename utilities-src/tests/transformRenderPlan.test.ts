import { buildTransformRenderPlan } from '@utilities/transformRenderPlan';
import { transformPreparedImages } from '@utilities/transformCore';

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

function totalAbsoluteDifference(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }

  return difference;
}

describe('transform render plan', () => {
  it('keeps matched pixels near honest provenance and strongly tints bad white mismatches', () => {
    const source = imageFromRgbTriples(
      [
        [255, 255, 255],
        [52, 106, 62],
        [255, 255, 255],
        [36, 64, 116]
      ],
      2,
      2
    );
    const target = imageFromRgbTriples(
      [
        [28, 56, 112],
        [52, 106, 62],
        [34, 68, 122],
        [36, 64, 116]
      ],
      2,
      2
    );

    const result = transformPreparedImages(source, target, 5);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);

    expect(Math.min(...Array.from(renderPlan.tintStrengthByTarget))).toBeLessThan(0.08);
    expect(Math.max(...Array.from(renderPlan.tintStrengthByTarget))).toBeGreaterThan(0.7);
    expect(Array.from(renderPlan.cheatedTargetPixels).some((value) => value === 1)).toBe(true);
  });

  it('produces a final arrival image closer to target than the raw assigned colors', () => {
    const source = imageFromRgbTriples(
      [
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [22, 24, 30],
        [46, 90, 54],
        [172, 124, 96],
        [38, 66, 120],
        [255, 255, 255]
      ],
      3,
      3
    );
    const target = imageFromRgbTriples(
      [
        [210, 196, 180],
        [26, 30, 36],
        [206, 192, 176],
        [202, 188, 172],
        [46, 90, 54],
        [180, 126, 100],
        [228, 214, 198],
        [42, 72, 124],
        [220, 206, 190]
      ],
      3,
      3
    );

    const result = transformPreparedImages(source, target, 5);
    const strictPixels = new Uint8ClampedArray(target.pixels.length);

    for (let targetIndex = 0; targetIndex < result.assignment.length; targetIndex += 1) {
      const sourceOffset = result.assignment[targetIndex] * 4;
      const targetOffset = targetIndex * 4;
      strictPixels[targetOffset] = source.pixels[sourceOffset];
      strictPixels[targetOffset + 1] = source.pixels[sourceOffset + 1];
      strictPixels[targetOffset + 2] = source.pixels[sourceOffset + 2];
      strictPixels[targetOffset + 3] = 255;
    }

    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);

    expect(totalAbsoluteDifference(renderPlan.finalPixels, target.pixels)).toBeLessThan(
      totalAbsoluteDifference(strictPixels, target.pixels)
    );
  });
});
