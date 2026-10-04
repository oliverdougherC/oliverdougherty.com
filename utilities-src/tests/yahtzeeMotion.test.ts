import { describe, expect, it } from 'vitest';
import { CUBE_VALUES, diceKeyframes, dicePose } from '../src/yahtzeeMotion';

describe('refresh-independent dice trajectory', () => {
  it('preserves every starting and landing orientation on the fixed cube', () => {
    const angles = [[0, 0], [0, 0], [0, -90], [-90, 0], [90, 0], [0, 90], [0, 180]];
    expect([...CUBE_VALUES].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    for (let previous = 1; previous <= 6; previous++) for (let next = 1; next <= 6; next++) {
      const start = dicePose(0, previous, next, 0, 70);
      const end = dicePose(1, previous, next, 0, 70);
      expect([start.rotateX, start.rotateY]).toEqual(angles[previous]);
      const wrap = (angle: number) => ((angle % 360) + 360) % 360;
      expect(wrap(end.rotateX)).toBe(wrap(angles[next][0]));
      expect(wrap(end.rotateY)).toBe(wrap(angles[next][1]));
      expect(end.y).toBe(0);
      expect(end.x).toBeCloseTo(0);
    }
  });
  it('has no angular speed discontinuity at the former easing boundaries or settlement', () => {
    const delta = 1e-5;
    for (const time of [.24, .55, .56, .76, .78, .88, .9]) {
      const before = dicePose(time - delta, 1, 6, 0, 70).rotateY;
      const at = dicePose(time, 1, 6, 0, 70).rotateY;
      const after = dicePose(time + delta, 1, 6, 0, 70).rotateY;
      expect(Math.abs((at - before) / delta - (after - at) / delta)).toBeLessThan(.04);
    }
    for (const time of [.24, .56, .76]) {
      expect(dicePose(time, 1, 6, 0, 70).rotateY - dicePose(time + delta, 1, 6, 0, 70).rotateY).toBeGreaterThan(0);
    }
  });
  it('lands, makes a smaller rebound and supplies numeric compositor transforms', () => {
    const lift = dicePose(.39, 1, 2, 0, 70);
    const land = dicePose(.78, 1, 2, 0, 70);
    const bounce = dicePose(.89, 1, 2, 0, 70);
    expect(land.y).toBe(0);
    expect(lift.y).toBeLessThan(bounce.y);
    expect(bounce.y).toBeLessThan(0);
    const frames = diceKeyframes(3, 5, 2, 48);
    expect(frames[0].offset).toBe(0);
    expect(frames.at(-1)!.offset).toBe(1);
    expect(frames.every(frame => !/var\(|calc\(|%/.test(String(frame.transform)))).toBe(true);
  });
  it('limits human per-refresh rotation and joins the landing without a velocity jump', () => {
    const step = (1000 / 120) / 600;
    for (let previous = 1; previous <= 6; previous++) for (let next = 1; next <= 6; next++) {
      for (const index of [0, 1]) for (let time = 0; time + step <= 1; time += step) {
        const a = dicePose(time, previous, next, index, 70);
        const b = dicePose(time + step, previous, next, index, 70);
        expect(Math.hypot(b.rotateX - a.rotateX, b.rotateY - a.rotateY, b.rotateZ - a.rotateZ)).toBeLessThan(8);
      }
    }
    const delta = 1e-5;
    const before = dicePose(.78 - delta, 1, 6, 0, 70).y;
    const at = dicePose(.78, 1, 6, 0, 70).y;
    const after = dicePose(.78 + delta, 1, 6, 0, 70).y;
    expect(Math.abs((at - before) / delta - (after - at) / delta)).toBeLessThan(.02);
  });

});
