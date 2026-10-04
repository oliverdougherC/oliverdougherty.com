import { describe, expect, it } from 'vitest';
import { CUBE_VALUES, diceAnimationTracks, diceFaceShades, dicePose } from '../src/yahtzeeMotion';

function scaleOf(transform: unknown): number {
  const match = String(transform).match(/scale(?:X|3d)?\(\s*([-+.\deE]+)/);
  expect(match, 'Ground shadow has a scale component').not.toBeNull();
  return Number(match![1]);
}
function expectGroundTransform(transform: unknown, size: number) {
  const value = String(transform);
  expect(value).not.toMatch(/rotate|perspective|translateZ|var\(|calc\(|%/);
  for (const match of value.matchAll(/(translate(?:3d|X|Y)?)\(([^)]+)\)/g)) {
    const coordinates = match[2].split(/[\s,]+/).filter(Boolean).map(Number.parseFloat);
    const groundY = match[1] === 'translateY' ? coordinates[0] : match[1] === 'translate3d' || match[1] === 'translate' ? coordinates[1] ?? 0 : 0;
    // The upper-left light projects a small positive offset onto the ground;
    // the die's negative airborne lift must never be applied to the shadow.
    expect(groundY).toBeGreaterThanOrEqual(0);
    expect(groundY).toBeLessThanOrEqual(size * .045 + 1e-8);
    if (match[1] === 'translate3d') expect(coordinates[2]).toBeCloseTo(0, 8);
  }
}

describe('world-fixed dice lighting and ground shadow', () => {
  it('starts and lands every numbered face on the same unshaded white material', () => {
    for (let previous = 1; previous <= 6; previous++) for (let next = 1; next <= 6; next++) {
      for (const index of [0, 1]) {
        const start = diceFaceShades(dicePose(0, previous, next, index, 70));
        const end = diceFaceShades(dicePose(1, previous, next, index, 70));
        expect(start[CUBE_VALUES.indexOf(previous as typeof CUBE_VALUES[number])]).toBeCloseTo(0, 8);
        expect(end[CUBE_VALUES.indexOf(next as typeof CUBE_VALUES[number])]).toBeCloseTo(0, 8);
      }
    }
  });

  it('illuminates left and upper normals from the fixed upper-left light', () => {
    const neutral = dicePose(0, 1, 1, 0, 70);
    const shades = diceFaceShades(neutral);
    expect(shades).toHaveLength(6);
    // Cube order is front/back, right/left, top/bottom.
    expect(shades[0]).toBe(0);
    expect(shades[1]).toBeGreaterThan(shades[0]);
    expect(shades[3]).toBeLessThan(shades[2]);
    expect(shades[4]).toBeLessThan(shades[5]);
  });

  it('turns a previously dark side white as it faces the viewer, independent of its pips', () => {
    const initial = diceFaceShades(dicePose(0, 1, 6, 0, 70));
    const landed = diceFaceShades(dicePose(1, 1, 6, 0, 70));
    const back = CUBE_VALUES.indexOf(6);
    expect(initial[back]).toBeGreaterThan(.1);
    expect(landed[back]).toBeCloseTo(0, 8);
    const justBefore = diceFaceShades(dicePose(.999, 1, 6, 0, 70));
    expect(Math.abs(justBefore[back] - landed[back])).toBeLessThan(.001);
    const pose = dicePose(.37, 3, 5, 0, 70);
    const translated = { ...pose, x: pose.x + 300, y: pose.y - 200, z: pose.z + 90 };
    expect(diceFaceShades(translated)).toEqual(diceFaceShades(pose));
    const fullTurns = { ...pose, rotateX: pose.rotateX + 360, rotateY: pose.rotateY - 720, rotateZ: pose.rotateZ + 360 };
    diceFaceShades(fullTurns).forEach((shade, face) => expect(shade).toBeCloseTo(diceFaceShades(pose)[face], 8));
  });

  it('keeps all shades finite and bounded throughout every start/landing combination', () => {
    for (let previous = 1; previous <= 6; previous++) for (let next = 1; next <= 6; next++) {
      for (let sample = 0; sample <= 40; sample++) {
        const shades = diceFaceShades(dicePose(sample / 40, previous, next, previous % 2, 48));
        shades.forEach(shade => {
          expect(Number.isFinite(shade)).toBe(true);
          expect(shade).toBeGreaterThanOrEqual(0);
          expect(shade).toBeLessThanOrEqual(1);
        });
      }
    }
  });

  it('uses synchronized native opacity tracks without painting lighting properties each frame', () => {
    const tracks = diceAnimationTracks(2, 5, 1, 70);
    expect(tracks.lighting).toHaveLength(6);
    const offsets = tracks.motion.map(frame => frame.offset);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(1);
    tracks.lighting.forEach((track, face) => {
      expect(track[0].offset).toBe(0);
      expect(track.at(-1)!.offset).toBe(1);
      expect(track.length).toBeLessThan(offsets.length);
      for (const offset of offsets as number[]) {
        const next = track.findIndex(frame => Number(frame.offset) >= offset);
        const right = track[Math.max(0, next)];
        const left = track[Math.max(0, next - 1)];
        const span = Number(right.offset) - Number(left.offset);
        const amount = span ? (offset - Number(left.offset)) / span : 0;
        const interpolated = Number(left.opacity) + (Number(right.opacity) - Number(left.opacity)) * amount;
        const exact = diceFaceShades(dicePose(offset, 2, 5, 1, 70))[face];
        expect(Math.abs(interpolated - exact)).toBeLessThanOrEqual(1 / 1024 + 1e-10);
      }
      track.forEach(frame => {
        expect(Object.keys(frame).every(key => ['offset', 'opacity', 'easing', 'composite'].includes(key))).toBe(true);
        expect(Number(frame.opacity)).toBeGreaterThanOrEqual(0);
        expect(Number(frame.opacity)).toBeLessThanOrEqual(1);
      });
    });
    expect(tracks.shadow.map(frame => frame.offset)).toEqual(offsets);
    tracks.motion.forEach(frame => expect(String(frame.transform)).not.toMatch(/var\(|calc\(|%/));
  });

  it('broadens and fades the anchored ground shadow at height and returns it smoothly to rest', () => {
    const tracks = diceAnimationTracks(1, 4, 0, 70);
    const first = tracks.shadow[0];
    const last = tracks.shadow.at(-1)!;
    const apex = tracks.shadow.reduce((best, frame) => Math.abs(Number(frame.offset) - .39) < Math.abs(Number(best.offset) - .39) ? frame : best);
    expect(Number(first.opacity)).toBeCloseTo(.14, 8);
    expect(Number(last.opacity)).toBeCloseTo(.14, 8);
    expect(Number(apex.opacity)).toBeLessThan(Number(first.opacity));
    expect(scaleOf(apex.transform)).toBeGreaterThan(scaleOf(first.transform));
    expect(scaleOf(first.transform)).toBeCloseTo(1, 8);
    expect(scaleOf(last.transform)).toBeCloseTo(1, 8);
    tracks.shadow.forEach(frame => {
      expectGroundTransform(frame.transform, 70);
      expect(Object.keys(frame).every(key => ['offset', 'opacity', 'transform', 'easing', 'composite'].includes(key))).toBe(true);
    });
    const penultimate = tracks.shadow.at(-2)!;
    expect(Math.abs(Number(penultimate.opacity) - Number(last.opacity))).toBeLessThan(.025);
  });
});
