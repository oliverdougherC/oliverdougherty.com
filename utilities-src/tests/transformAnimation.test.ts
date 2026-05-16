import { getPreset } from '@utilities/presets';
import {
  createTransformAnimationState,
  renderTransformAnimationPixels
} from '@utilities/transformAnimation';
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

function countMatchingPixels(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  let matches = 0;

  for (let offset = 0; offset < left.length; offset += 4) {
    if (
      left[offset] === right[offset] &&
      left[offset + 1] === right[offset + 1] &&
      left[offset + 2] === right[offset + 2] &&
      left[offset + 3] === right[offset + 3]
    ) {
      matches += 1;
    }
  }

  return matches;
}

function totalAbsoluteDifference(left: Uint8ClampedArray, right: Uint8ClampedArray) {
  let difference = 0;

  for (let offset = 0; offset < left.length; offset += 1) {
    difference += Math.abs(left[offset] - right[offset]);
  }

  return difference;
}

function renderFrame(state: ReturnType<typeof createTransformAnimationState>, phase: number) {
  return renderTransformAnimationPixels(state, phase, new Uint8ClampedArray(state.finalPixels.length));
}

describe('transform animation', () => {
  it('starts from the source image and ends on the final reconstruction', () => {
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
        [255, 255, 0],
        [255, 0, 0],
        [0, 255, 0]
      ],
      2,
      2
    );

    const result = transformPreparedImages(source, target, 5);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);
    const finalPixels = renderPlan.finalPixels;
    const state = createTransformAnimationState({
      width: source.width,
      height: source.height,
      sourcePixels: source.pixels,
      finalPixels,
      assignment: result.assignment,
      tintStrengthByTarget: renderPlan.tintStrengthByTarget,
      cheatedTargetPixels: renderPlan.cheatedTargetPixels,
      preset: getPreset('fast')
    });

    expect(Array.from(renderFrame(state, 0))).toEqual(Array.from(source.pixels));
    expect(Array.from(renderFrame(state, 1))).toEqual(Array.from(finalPixels));
  });

  it('reveals the final arrangement before the animation completes', () => {
    const width = 5;
    const height = 5;
    const sourceTriples = Array.from({ length: width * height }, (_, index) => [
      (index * 47) % 256,
      (index * 91) % 256,
      (index * 137) % 256
    ] as [number, number, number]);
    const targetTriples = sourceTriples.map((_, index) => sourceTriples[(index * 7) % sourceTriples.length]);
    const source = imageFromRgbTriples(sourceTriples, width, height);
    const target = imageFromRgbTriples(targetTriples, width, height);

    const result = transformPreparedImages(source, target, 5);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);
    const finalPixels = renderPlan.finalPixels;
    const state = createTransformAnimationState({
      width,
      height,
      sourcePixels: source.pixels,
      finalPixels,
      assignment: result.assignment,
      tintStrengthByTarget: renderPlan.tintStrengthByTarget,
      cheatedTargetPixels: renderPlan.cheatedTargetPixels,
      preset: getPreset('fast')
    });

    const midFrame = renderFrame(state, 0.75);
    const matchingSourcePixels = countMatchingPixels(midFrame, source.pixels);
    const differenceToSource = totalAbsoluteDifference(midFrame, source.pixels);
    const differenceToFinal = totalAbsoluteDifference(midFrame, finalPixels);

    expect(matchingSourcePixels).toBeLessThan(width * height);
    expect(differenceToFinal).toBeLessThan(differenceToSource);
  });

  it('keeps late frames shy of exact final while pixels are still shifting', () => {
    const width = 16;
    const height = 16;
    const sourceTriples = Array.from({ length: width * height }, (_value, index) =>
      index % 5 === 0
        ? ([255, 255, 255] as [number, number, number])
        : ([(index * 37) % 256, (index * 73) % 256, (index * 109) % 256] as [number, number, number])
    );
    const targetTriples = sourceTriples.map((_value, index) =>
      ([(index * 53) % 256, (index * 89) % 256, (index * 131) % 256] as [number, number, number])
    );
    const source = imageFromRgbTriples(sourceTriples, width, height);
    const target = imageFromRgbTriples(targetTriples, width, height);
    const result = transformPreparedImages(source, target, 5);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);
    const finalPixels = renderPlan.finalPixels;
    const state = createTransformAnimationState({
      width,
      height,
      sourcePixels: source.pixels,
      finalPixels,
      assignment: result.assignment,
      tintStrengthByTarget: renderPlan.tintStrengthByTarget,
      cheatedTargetPixels: renderPlan.cheatedTargetPixels,
      preset: getPreset('fast')
    });

    const lateFrame = renderFrame(state, 0.92);

    expect(totalAbsoluteDifference(lateFrame, finalPixels)).toBeGreaterThan(0);
    expect(totalAbsoluteDifference(lateFrame, source.pixels)).toBeGreaterThan(0);
  });

  it('never reaches exact final before completion', () => {
    const width = 16;
    const height = 16;
    const sourceTriples = Array.from({ length: width * height }, (_value, index) =>
      index % 4 === 0
        ? ([255, 255, 255] as [number, number, number])
        : ([(index * 29) % 256, (index * 59) % 256, (index * 97) % 256] as [number, number, number])
    );
    const targetTriples = Array.from({ length: width * height }, (_value, index) => [
      (index * 61) % 256,
      (index * 101) % 256,
      (index * 149) % 256
    ] as [number, number, number]);
    const source = imageFromRgbTriples(sourceTriples, width, height);
    const target = imageFromRgbTriples(targetTriples, width, height);
    const result = transformPreparedImages(source, target, 5);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);
    const finalPixels = renderPlan.finalPixels;
    const state = createTransformAnimationState({
      width,
      height,
      sourcePixels: source.pixels,
      finalPixels,
      assignment: result.assignment,
      tintStrengthByTarget: renderPlan.tintStrengthByTarget,
      cheatedTargetPixels: renderPlan.cheatedTargetPixels,
      preset: getPreset('fast')
    });

    for (const phase of [0.85, 0.88, 0.9, 0.92, 0.95, 0.98]) {
      const frame = renderFrame(state, phase);
      expect(totalAbsoluteDifference(frame, finalPixels)).toBeGreaterThan(0);
    }
  });

  it('requires callers to reuse the destination frame buffer', () => {
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
        [255, 255, 0],
        [0, 0, 255],
        [0, 255, 0],
        [255, 0, 0]
      ],
      2,
      2
    );

    const result = transformPreparedImages(source, target, 5);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);
    const state = createTransformAnimationState({
      width: source.width,
      height: source.height,
      sourcePixels: source.pixels,
      finalPixels: renderPlan.finalPixels,
      assignment: result.assignment,
      tintStrengthByTarget: renderPlan.tintStrengthByTarget,
      cheatedTargetPixels: renderPlan.cheatedTargetPixels,
      preset: getPreset('fast')
    });

    const frameBuffer = new Uint8ClampedArray(renderPlan.finalPixels.length);
    const firstFrame = renderTransformAnimationPixels(state, 0.25, frameBuffer);
    const secondFrame = renderTransformAnimationPixels(state, 0.7, frameBuffer);

    expect(firstFrame).toBe(frameBuffer);
    expect(secondFrame).toBe(frameBuffer);
    expect(() => renderTransformAnimationPixels(state, 0.5, new Uint8ClampedArray(1))).toThrow(
      'Animation destination buffer'
    );
  });

  it('tints cheated pixels toward the arrival color during flight', () => {
    const source = imageFromRgbTriples(
      [
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255],
        [255, 255, 255]
      ],
      2,
      2
    );
    const target = imageFromRgbTriples(
      [
        [32, 64, 128],
        [40, 82, 140],
        [28, 56, 120],
        [35, 70, 132]
      ],
      2,
      2
    );

    const result = transformPreparedImages(source, target, 5);
    const renderPlan = buildTransformRenderPlan(source, target, result.assignment, 5);
    const state = createTransformAnimationState({
      width: source.width,
      height: source.height,
      sourcePixels: source.pixels,
      finalPixels: renderPlan.finalPixels,
      assignment: result.assignment,
      tintStrengthByTarget: renderPlan.tintStrengthByTarget,
      cheatedTargetPixels: renderPlan.cheatedTargetPixels,
      preset: getPreset('fast')
    });

    const midFlight = renderFrame(state, 0.55);
    const lateFlight = renderFrame(state, 0.9);

    expect(totalAbsoluteDifference(midFlight, source.pixels)).toBeGreaterThan(0);
    expect(totalAbsoluteDifference(lateFlight, renderPlan.finalPixels)).toBeLessThan(
      totalAbsoluteDifference(midFlight, renderPlan.finalPixels)
    );
  });
});
