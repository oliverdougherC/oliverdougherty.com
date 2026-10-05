/** Plain-text reading units; punctuation stays attached and soft wraps are ignored. */
export interface ReadingUnit {
  text: string;
  before: string;
  focus: string;
  after: string;
  length: number;
  boundary: 'none' | 'clause' | 'sentence' | 'paragraph';
  punctuation: 'none' | 'clause' | 'sentence';
  weight: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const abbreviations = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|a\.m|p\.m|no|fig|approx|inc|ltd)\.$/iu;
const closing = /["'”’»›）)\]}]+$/u;

export function splitOrp(text: string) {
  const chars = Array.from(graphemes.segment(text), part => part.segment);
  const visible = chars.map((char, i) => /[\p{L}\p{N}\p{S}]/u.test(char) ? i : -1).filter(i => i >= 0);
  const length = visible.length || chars.length;
  const point = length <= 1 ? 0 : length <= 5 ? 1 : length <= 9 ? 2 : length <= 13 ? 3 : 4;
  const index = visible.length ? visible[Math.min(point, visible.length - 1)] : Math.min(point, chars.length - 1);
  return { before: chars.slice(0, index).join(''), focus: chars[index] || '', after: chars.slice(index + 1).join(''), length };
}

function hasDenseContent(text: string): boolean {
  if (text.includes('http://') || text.includes('https://') || text.includes('www.')) return true;
  let hasLetter = false;
  let hasDigit = false;
  let digitRun = 0;
  // A mixed alphanumeric segment must not cross whitespace. Scan each code
  // point once; unanchored lookaheads retry the remaining suffix quadratically.
  for (const char of text) {
    const digit = char >= '0' && char <= '9';
    digitRun = digit ? digitRun + 1 : 0;
    if (digitRun >= 5) return true;
    if (/\s/u.test(char)) { hasLetter = false; hasDigit = false; }
    else {
      hasDigit ||= digit;
      hasLetter ||= /\p{L}/u.test(char);
      if (hasLetter && hasDigit) return true;
    }
  }
  return false;
}

export function timingWeight(text: string, length: number, boundary: ReadingUnit['boundary']) {
  const longWord = 0.65 * (1 - Math.exp(-Math.max(0, length - 5) / 14));
  const dense = hasDenseContent(text) ? 0.2 : 0;
  const pause = { none: 0, clause: 0.22, sentence: 0.65, paragraph: 1.25 }[boundary];
  return 1 + longWord + dense + pause;
}

export function parseText(source: string): ReadingUnit[] {
  // Strip nonprinting controls, retaining newlines, tabs, combining marks and ZWJ emoji.
  const clean = source.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f\u200b\u202a-\u202e\u2066-\u2069]/g, '');
  const matches = Array.from(clean.matchAll(/\S+/gu));
  return matches.map((match, i) => {
    const text = match[0];
    const end = match.index! + text.length;
    const gap = clean.slice(end, matches[i + 1]?.index ?? clean.length);
    const bare = text.replace(closing, '').replace(/^["'“‘«‹（(\[{]+/u, '');
    let boundary: ReadingUnit['boundary'] = 'none';
    if (/[,;:，；：]$/u.test(bare)) boundary = 'clause';
    if (/[!?…。！？]$/u.test(bare) || (/\.$/u.test(bare) && !abbreviations.test(bare) && !/^(?:\p{L}\.)+$/u.test(bare))) boundary = 'sentence';
    const punctuation = boundary;
    if (/\n[\t \f]*\n/u.test(gap)) boundary = 'paragraph';
    const orp = splitOrp(text);
    return { text, ...orp, boundary, punctuation, weight: timingWeight(text, orp.length, boundary) };
  });
}

export interface ReaderPauses { clause: number; sentence: number }
export const DEFAULT_PAUSES: ReaderPauses = { clause: 0.22, sentence: 0.65 };

/** Skip the current sentence entirely in either direction. Paragraphs also start a sentence. */
export function sentenceTarget(units: ReadingUnit[], index: number, direction: -1 | 1): number {
  const endsSentence = (i: number) => units[i].boundary === 'sentence' || units[i].boundary === 'paragraph';
  if (direction === 1) {
    for (let i = index; i < units.length - 1; i++) if (endsSentence(i)) return i + 1;
    return Math.max(0, units.length - 1);
  }
  let start = index;
  while (start > 0 && !endsSentence(start - 1)) start--;
  if (start > 0) start--;
  while (start > 0 && !endsSentence(start - 1)) start--;
  return start;
}

export function normalizedDwells(units: ReadingUnit[], wpm: number, pauses: ReaderPauses = DEFAULT_PAUSES): number[] {
  if (!units.length) return [];
  // Keep punctuation adjustable at paragraph endings too. The extra paragraph
  // time remains, and default settings preserve the original cadence exactly.
  const weights = units.map(unit => unit.weight + (unit.punctuation === 'clause' || unit.punctuation === 'sentence'
    ? pauses[unit.punctuation] - DEFAULT_PAUSES[unit.punctuation] : 0));
  const mean = weights.reduce((sum, weight) => sum + weight, 0) / units.length;
  const base = 60000 / Math.max(100, Math.min(1000, Number.isFinite(wpm) ? wpm : 300));
  return weights.map(weight => base * weight / mean);
}

/** One cancellable advance; even a callback already queued cannot mutate a new session. */
export class ReaderScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  cancel() {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  schedule(delay: number, advance: () => void) {
    this.cancel();
    const generation = this.generation;
    this.timer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.timer = undefined;
      advance();
    }, delay);
  }
}
