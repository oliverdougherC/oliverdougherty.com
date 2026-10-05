import { describe, expect, it } from 'vitest';
import { ObservatoryHistory, deltaIntensity, deltaScale, strongestAttention, waterfallColumns, tokenLabel } from '../src/local-assistant/observatory';
describe('measured observatory history', () => {
  it('makes whitespace-only tokens visible without inventing words', () => {
    expect(tokenLabel(' ')).toBe('·'); expect(tokenLabel('\n')).toBe('↵');
    expect(tokenLabel('\t')).toBe('⇥'); expect(tokenLabel(' hello')).toBe(' hello');
  });
  it('bounds snapshots and preserves a pinned sample across eviction', () => {
    const history = new ObservatoryHistory(); const first = { step: 1 };
    history.ingest(first); history.pin(first);
    for (let step = 2; step <= 1000; step++) history.ingest({ step });
    expect(history.snapshots).toHaveLength(256); expect(history.selected).toBe(first);
    history.live(); expect(history.selected?.step).toBe(1000);
    history.reset(); expect(history.selected).toBeUndefined();
  });
  it('deduplicates a completed pass without mutating its pinned reading', () => {
    const history = new ObservatoryHistory(); const first = { step: 1, deltas: [{ layer: 0, value: .1 }] };
    history.ingest(first); history.pin(first); history.ingest({ step: 1, deltas: [{ layer: 0, value: .2 }] });
    expect(history.snapshots).toHaveLength(1); expect(history.selected).toBe(first);
  });
  it('selects strongest real attention values without renormalizing their mass', () => {
    const reading = { layer: 3, queryPosition: 99, keyCount: 100, headCount: 8, entries: [{ position: 50, weight: .2 }, { position: 3, weight: .4 }, { position: 7, weight: NaN }, { position: 9, weight: -.1 }, { position: 99, weight: .07 }] };
    expect(strongestAttention(reading, 2)).toEqual([{ position: 3, weight: .4 }, { position: 50, weight: .2 }]);
  });
  it('uses a bounded width budget and measured-only delta scale', () => {
    expect(waterfallColumns(320)).toBeGreaterThan(16); expect(waterfallColumns(4000)).toBe(256);
    expect(deltaScale([{ step: 1, deltas: [{ layer: 0, value: 0 }, { layer: 1, value: NaN }, { layer: 2, value: .25 }] }])).toBe(.25);
  });
  it('maps color intensity monotonically on one shared log scale without changing zero or maximum', () => {
    const values = [0, .001, .01, .1, 1, 5].map(value => deltaIntensity(value, 5));
    expect(values[0]).toBe(0); expect(values.at(-1)).toBe(1);
    for (let index = 1; index < values.length; index++) expect(values[index]).toBeGreaterThan(values[index - 1]);
    expect(deltaIntensity(.1, 5)).toBeGreaterThan(.1 / 5);
    expect(deltaIntensity(NaN, 5)).toBe(0); expect(deltaIntensity(1, 0)).toBe(0);
    expect(deltaIntensity(10, 5)).toBe(1);
  });

});
