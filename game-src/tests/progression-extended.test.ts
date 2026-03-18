import { describe, expect, it } from 'vitest';
import { projectLevel, xpThresholdForLevel } from '@/core/progression';

describe('xp progression (extended)', () => {
  it('thresholds are strictly increasing across all tiers', () => {
    for (let level = 1; level < 30; level++) {
      expect(xpThresholdForLevel(level + 1)).toBeGreaterThan(
        xpThresholdForLevel(level)
      );
    }
  });

  it('thresholds are positive for all levels', () => {
    for (let level = 1; level <= 50; level++) {
      expect(xpThresholdForLevel(level)).toBeGreaterThan(0);
    }
  });

  it('clamps level below 1 to level 1', () => {
    expect(xpThresholdForLevel(0)).toBe(xpThresholdForLevel(1));
    expect(xpThresholdForLevel(-5)).toBe(xpThresholdForLevel(1));
  });

  it('floors fractional levels', () => {
    expect(xpThresholdForLevel(2.9)).toBe(xpThresholdForLevel(2));
    expect(xpThresholdForLevel(5.5)).toBe(xpThresholdForLevel(5));
  });

  it('tier transitions are smooth (no sudden jumps beyond 3x)', () => {
    // Levels 5→6 and 10→11 change formula tier. Ensure no wild jumps.
    const at5 = xpThresholdForLevel(5);
    const at6 = xpThresholdForLevel(6);
    expect(at6 / at5).toBeLessThan(3);

    const at10 = xpThresholdForLevel(10);
    const at11 = xpThresholdForLevel(11);
    expect(at11 / at10).toBeLessThan(3);
  });

  it('projectLevel returns level 1 for zero XP', () => {
    const result = projectLevel(0);
    expect(result.level).toBe(1);
    expect(result.xpIntoLevel).toBe(0);
    expect(result.xpForNext).toBe(xpThresholdForLevel(1));
  });

  it('projectLevel clamps negative XP to zero', () => {
    const result = projectLevel(-100);
    expect(result.level).toBe(1);
    expect(result.xpIntoLevel).toBe(0);
  });

  it('projectLevel floors fractional XP', () => {
    const result = projectLevel(0.9);
    expect(result.level).toBe(1);
    expect(result.xpIntoLevel).toBe(0);
  });

  it('levels up at exactly the threshold', () => {
    const threshold = xpThresholdForLevel(1);
    const result = projectLevel(threshold);
    expect(result.level).toBe(2);
    expect(result.xpIntoLevel).toBe(0);
  });

  it('cumulative XP round-trips through multiple levels', () => {
    // Accumulate XP for levels 1..10 and verify we land at level 11.
    let totalXp = 0;
    for (let level = 1; level <= 10; level++) {
      totalXp += xpThresholdForLevel(level);
    }
    const result = projectLevel(totalXp);
    expect(result.level).toBe(11);
    expect(result.xpIntoLevel).toBe(0);
  });

  it('xpForNext always matches the current level threshold', () => {
    for (let xp = 0; xp < 5000; xp += 250) {
      const result = projectLevel(xp);
      expect(result.xpForNext).toBe(xpThresholdForLevel(result.level));
    }
  });
});
