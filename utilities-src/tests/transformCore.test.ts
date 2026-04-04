import { getPreset } from '@utilities/presets';
import {
  buildResultPixels,
  matchPackedPixels,
  packRgbPixels,
  resolveOutputDimensions,
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
  });
});
