import { describe, expect, it } from 'vitest';
import { observationBudget, tokenCapacity, promptWindow, tokenLabel, TOKEN_HISTORY_LIMIT } from '../src/local-assistant/observatory';
describe('observatory density', () => {
  it('makes whitespace-only tokens visible without inventing words', () => {
    expect(tokenLabel(' ')).toBe('·'); expect(tokenLabel('\n')).toBe('↵');
    expect(tokenLabel('\t')).toBe('⇥'); expect(tokenLabel(' hello')).toBe(' hello');
  });
  it('reveals more real detail as vertical space grows while bounding retained data', () => {
    const small = observationBudget(480), large = observationBudget(2050);
    expect(small.candidates).toBe(3);
    expect(large.candidates).toBe(8);
    expect(large.chartHeight).toBeGreaterThan(small.chartHeight);
    expect(tokenCapacity(1600, 1200, large.rowHeight).count).toBeGreaterThan(tokenCapacity(310, 80, small.rowHeight).count);
    expect(tokenCapacity(4000, 4000, 40).count).toBeLessThanOrEqual(TOKEN_HISTORY_LIMIT);
  });
  it('keeps the actual processing frontier inside the displayed prompt window', () => {
    for (const processed of [0, 10, 256, 1000, 1024]) {
      const start = promptWindow(1024, processed, 24);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + 24).toBeLessThanOrEqual(1024);
      expect(processed).toBeGreaterThanOrEqual(start);
      expect(processed).toBeLessThanOrEqual(start + 24);
    }
  });
});
