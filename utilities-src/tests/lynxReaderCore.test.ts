import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizedDwells, parseText, ReaderScheduler, splitOrp, timingWeight } from '../src/lynxReaderCore';

afterEach(() => vi.useRealTimers());

describe('Lynx parsing and recognition point', () => {
  it('preserves punctuation, compounds, quotes, numbers and Unicode graphemes', () => {
    const words = ['“Don’t', 're-enter,”', '3.14159', 'cafe\u0301', '👩🏽‍💻', 'naïve', '日本語。'];
    const units = parseText(words.join('\t '));
    expect(units.map(unit => unit.text)).toEqual(words);
    expect(units.map(unit => unit.before + unit.focus + unit.after)).toEqual(words);
    expect(splitOrp('👩🏽‍💻').focus).toBe('👩🏽‍💻');
    expect(splitOrp('e\u0301').focus).toBe('e\u0301');
    expect(splitOrp('“understanding”')).toMatchObject({ before: '“und', focus: 'e', after: 'rstanding”' });
    expect(splitOrp('a')).toMatchObject({ before: '', focus: 'a', after: '' });
    expect(splitOrp('word')).toMatchObject({ before: 'w', focus: 'o', after: 'rd' });
    expect(splitOrp('abcdefghij')).toMatchObject({ before: 'abc', focus: 'd' });
    expect(splitOrp('a'.repeat(100)).before).toHaveLength(4);
  });
  it('ignores wraps but retains bounded paragraph boundaries', () => {
    expect(parseText('One\nsoft\r\nwrap.').map(u => u.boundary)).toEqual(['none', 'none', 'sentence']);
    expect(parseText('one\n \n\n\nnext')[0].boundary).toBe('paragraph');
    expect(parseText('one\n\nnext')[0].weight).toBe(parseText('one\n\n\n\nnext')[0].weight);
    expect(parseText(' \r\n\t\u200b')).toEqual([]);
  });
  it('recognizes quoted endings, ellipses and clauses without pausing at decimals or abbreviations', () => {
    const source = 'Dr. A. U.S. e.g. 3.14 1,000 example.com “Really?” wait... yes! end.” first, then; now: fine。';
    expect(parseText(source).map(u => u.boundary)).toEqual([
      'none', 'none', 'none', 'none', 'none', 'none', 'none',
      'sentence', 'sentence', 'sentence', 'sentence', 'clause', 'clause', 'clause', 'sentence'
    ]);
  });
});

describe('Lynx adaptive timing', () => {
  it('adds smooth bounded length and density weight', () => {
    const weights = [1, 5, 10, 20, 1000].map(length => timingWeight('a'.repeat(length), length, 'none'));
    expect(weights[0]).toBe(weights[1]);
    expect(weights[2]).toBeGreaterThan(weights[1]);
    expect(weights[3]).toBeGreaterThan(weights[2]);
    expect(weights[4]).toBeLessThanOrEqual(1.65);
    expect(timingWeight('123456', 6, 'none')).toBeGreaterThan(timingWeight('abcdef', 6, 'none'));
    expect(timingWeight('abc123', 6, 'none')).toBeGreaterThan(timingWeight('abcdef', 6, 'none'));
  });
  it.each([
    ['a1', true], ['1a', true], ['π9', true], ['𐐀9', true], ['é٣', false],
    ['abc 12', false], ['abc\n12', false], ['a1 2', true], ['12345', true],
    ['1234-5678', false], ['http://', true], ['https://', true], ['www.', true], ['HTTP://', false]
  ])('preserves density classification for %j', (text, dense) => {
    expect(timingWeight(text, 4, 'none')).toBe(dense ? 1.2 : 1);
  });
  it('parses a 50,000-character alphabetic token without rescanning its suffixes', () => {
    const text = 'a'.repeat(50000);
    const started = performance.now();
    const units = parseText(text);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ text, length: 50000, before: 'aaaa', focus: 'a', weight: 1.65 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(timingWeight(`${text}9`, text.length + 1, 'none')).toBeCloseTo(1.85);
  });
  it('orders semantic pauses without stacking paragraph and sentence pauses', () => {
    const weights = ['none', 'clause', 'sentence', 'paragraph'].map(boundary => timingWeight('word', 4, boundary as 'none'));
    expect(weights).toEqual([1, 1.22, 1.65, 2.25]);
  });
  it.each([150, 300, 450, 600, 1000])('normalizes effective throughput to %i WPM', wpm => {
    const units = parseText('Dr. Rivera watched the rain, then opened the window. “Wonderful!” she said.\n\nAcross the extraordinarily quiet street, 123456 lights flashed on https://example.com.');
    const times = normalizedDwells(units, wpm);
    expect(units.length * 60000 / times.reduce((a, b) => a + b, 0)).toBeCloseTo(wpm, 8);
    expect(times.every(time => time > 0)).toBe(true);
    expect(normalizedDwells([], wpm)).toEqual([]);
  });
});

describe('Lynx scheduler invalidation', () => {
  it('replaces pending advances and cancels even an already captured callback', () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const scheduler = new ReaderScheduler();
    const advance = vi.fn();
    scheduler.schedule(100, advance);
    const stale = spy.mock.calls[0][0] as () => void;
    scheduler.schedule(200, advance);
    stale();
    vi.advanceTimersByTime(100);
    expect(advance).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(advance).toHaveBeenCalledTimes(1);
    scheduler.schedule(100, advance);
    scheduler.cancel();
    vi.runAllTimers();
    expect(advance).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
