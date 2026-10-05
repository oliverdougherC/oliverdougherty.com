/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RulesEngine, Sheet } from '../src/keiriEngine';
import { YahtzeeController } from '../src/yahtzeeController';
import { STORAGE_KEY, freshRivalry, parseRivalry } from '../src/yahtzeeCore';

vi.mock('../src/keiriEngine', () => ({ ExactEngine: class {}, loadRules: vi.fn() }));
const rules: RulesEngine = {
  preview: (sheet: Sheet, dice: number[]) => sheet.scores.map(score => score === null ? dice.reduce((a, b) => a + b, 0) : null),
  score: (sheet: Sheet, dice: number[], category: number) => ({ ...sheet, scores: sheet.scores.map((score, i) => i === category ? dice.reduce((a, b) => a + b, 0) : score) }),
  totals: (sheet: Sheet) => ({ upper: 0, upperBonus: 0, yahtzeeBonus: 0, total: sheet.scores.reduce<number>((sum, value) => sum + (value ?? 0), 0) }),
  validateSheet: () => true
};
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const roots: HTMLElement[] = [];
const controllers: YahtzeeController[] = [];
function setup(options: { load?: () => Promise<void>; decide?: () => Promise<{ kind: 'score'; category: number } | { kind: 'hold'; mask: number }>; getRules?: () => Promise<RulesEngine>; storage?: Pick<Storage, 'getItem' | 'setItem'> } = {}) {
  const root = document.createElement('section'); root.className = 'utility-shell--yahtzee'; document.body.append(root); roots.push(root);
  const exact = { load: vi.fn(options.load ?? (async () => {})), decide: vi.fn(options.decide ?? (async () => ({ kind: 'score' as const, category: 0 }))) };
  const controller = new YahtzeeController(root, { exact, rules: options.getRules ?? (async () => rules), rng: () => 3, pauseMs: 20, storage: options.storage });
  controllers.push(controller);
  controller.init();
  const click = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!.click();
  return { root, exact, click, controller };
}
async function flush() { await vi.advanceTimersByTimeAsync(0); }
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
afterEach(() => { for (const controller of controllers.splice(0)) controller.destroy(); roots.length = 0; document.body.replaceChildren(); vi.useRealTimers(); });

describe('Yahtzee controller lifecycle', () => {
  it('lets the human roll, hold and commit while the exact table is pending', async () => {
    const table = deferred<void>();
    const { root, exact, click } = setup({ load: () => table.promise });
    click('[data-roll]');
    expect(root.dataset.rolls).toBe('1');
    await flush();
    click('[data-die="0"]');
    expect(root.querySelector('[data-die="0"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-score="0"]')!.textContent).toBe('15');
    expect(root.querySelector('[data-keiri-score="0"]')!.textContent).toBe('—');
    click('[data-score="0"]');
    expect(root.dataset.turn).toBe('keiri');
    expect(exact.decide).not.toHaveBeenCalled();
    table.resolve(); await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(root.dataset.turn).toBe('human');
    expect(root.querySelector('[data-keiri-score="0"]')!.textContent).toBe('15');
  });
  it.each([false, true])('retains interactive text nodes across background load failure (rolled: %s)', async rolled => {
    const table = deferred<void>();
    const { root, click } = setup({ load: () => table.promise });
    await flush();
    if (rolled) { click('[data-roll]'); click('[data-die="0"]'); }
    const selectors = ['[data-roll]', '[data-reset]', '[data-score="0"]', ...(rolled ? ['[data-die="0"] .yahtzee-held'] : [])];
    const labels = selectors.map(selector => {
      const element = root.querySelector(selector)!;
      return { element, child: element.firstChild, text: element.textContent };
    });

    table.reject(new Error('Exact table unavailable'));
    await flush();

    expect(root.dataset.engineState).toBe('failed');
    for (const { element, child, text } of labels) {
      expect(element.textContent).toBe(text);
      // WebKit cancels a pressed control's click when its text node is replaced.
      expect(element.firstChild).toBe(child);
    }
  });
  it('ignores a decision completing after deactivation and resumes only one canonical turn', async () => {
    const decision = deferred<{ kind: 'score'; category: number }>();
    const { root, exact, click } = setup({ decide: () => decision.promise });
    await flush(); click('[data-roll]'); click('[data-score="0"]');
    await vi.advanceTimersByTimeAsync(20);
    root.dispatchEvent(new Event('utility-deactivate'));
    const snapshot = root.innerHTML;
    decision.resolve({ kind: 'score', category: 0 });
    await vi.advanceTimersByTimeAsync(100);
    expect(root.innerHTML).toBe(snapshot);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).match.keiri.scores[0]).toBeNull();
    root.dispatchEvent(new Event('utility-activate'));
    await vi.advanceTimersByTimeAsync(60);
    expect(exact.decide).toHaveBeenCalledTimes(2);
    expect(root.dataset.turn).toBe('human');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).match.keiri.scores.filter((s: unknown) => s !== null)).toHaveLength(1);
  });
  it('does not mutate hidden markup on download completion and does not initialize twice', async () => {
    const table = deferred<void>(); const { root, exact, controller } = setup({ load: () => table.promise });
    root.dispatchEvent(new Event('utility-deactivate'));
    const snapshot = root.innerHTML; table.resolve(); await flush();
    expect(root.innerHTML).toBe(snapshot);
    controller.init(); expect(exact.load).toHaveBeenCalledTimes(1);
    root.dispatchEvent(new Event('utility-activate'));
    expect(root.dataset.engineState).toBe('ready');
  });
  it('preserves a finished human turn on failed loading and retry', async () => {
    let attempt = 0;
    const { root, click } = setup({ load: async () => { if (++attempt === 1) throw new Error('404'); } });
    await flush(); click('[data-roll]'); click('[data-score="0"]');
    expect(root.dataset.engineState).toBe('failed');
    expect(root.querySelector<HTMLButtonElement>('[data-retry]')!.hidden).toBe(false);
    click('[data-retry]'); await flush(); await vi.advanceTimersByTimeAsync(60);
    expect(root.dataset.turn).toBe('human');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).match.human.scores[0]).toBe(15);
  });
  it.each([
    ['malformed JSON', '{invalid JSON'],
    ['obsolete version', JSON.stringify({ ...freshRivalry(), version: 0 })],
    ['invalid structure', JSON.stringify({ version: 1, record: { human: 0, keiri: 0, ties: 0 }, match: {} })]
  ])('preserves fresh-game progress after %s recovery while rules are delayed', async (_label, raw) => {
    localStorage.setItem(STORAGE_KEY, raw);
    const delayedRules = deferred<RulesEngine>();
    const { root, click } = setup({ getRules: () => delayedRules.promise });
    click('[data-roll]');
    click('[data-die="1"]');
    click('[data-roll]');
    const before = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(before.match.rolls).toBe(2);
    expect(before.match.held[1]).toBe(true);
    expect(root.querySelector<HTMLButtonElement>('[data-score="0"]')!.disabled).toBe(true);

    delayedRules.resolve(rules); await flush();

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(before);
    expect(root.dataset.rolls).toBe('2');
    expect(root.querySelector('[data-die="1"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>('[data-score="0"]')!.disabled).toBe(false);
  });
  it.each([3, 4])('keeps a saved Twos score of %i pending until semantic validation, independently of the table', async twos => {
    const candidate = freshRivalry();
    candidate.record.human = 2;
    candidate.match.human.scores[1] = twos;
    candidate.match.keiri.scores[1] = twos;
    candidate.match.dice = [2, 3, 4, 5, 6];
    candidate.match.rolls = 1;
    candidate.match.held[0] = true;
    const raw = JSON.stringify(candidate);
    expect(parseRivalry(raw)).toEqual(candidate);
    localStorage.setItem(STORAGE_KEY, raw);
    const delayedRules = deferred<RulesEngine>();
    const table = deferred<void>();
    const { root, click } = setup({ getRules: () => delayedRules.promise, load: () => table.promise });
    expect(root.querySelector('[data-status]')!.textContent).toBe('Checking saved game…');
    expect(root.querySelector('[data-keiri-score="1"]')!.textContent).toBe('—');
    for (const selector of ['[data-roll]', '[data-die="0"]', '[data-score="0"]', '[data-reset-game]', '[data-reset]', '[data-again]']) {
      expect(root.querySelector<HTMLButtonElement>(selector)!.disabled).toBe(true);
      click(selector);
    }
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    root.dispatchEvent(new Event('utility-deactivate'));
    const hidden = root.innerHTML;
    const validateSheet = vi.fn((sheet: Sheet) => sheet.scores[1] !== 3);
    delayedRules.resolve({ ...rules, validateSheet }); await flush();
    expect(validateSheet).toHaveBeenCalled();
    expect(root.innerHTML).toBe(hidden);
    root.dispatchEvent(new Event('utility-activate'));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual(twos === 3 ? freshRivalry() : candidate);
    if (twos === 3) expect(root.querySelector('[data-status]')!.textContent).toContain('Saved game could not be restored');
    expect(root.dataset.engineState).toBe('download');
    click('[data-roll]'); click('[data-die="1"]');
    const beforeTable = localStorage.getItem(STORAGE_KEY);
    expect(JSON.parse(beforeTable!).match.rolls).toBe(twos === 3 ? 1 : 2);
    expect(JSON.parse(beforeTable!).match.held[1]).toBe(true);
    table.resolve(); await flush();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(beforeTable);
  });
  it('keeps a pending restore intact across rules failure, retry and BFCache', async () => {
    const raw = JSON.stringify(freshRivalry());
    localStorage.setItem(STORAGE_KEY, raw);
    const retriedRules = deferred<RulesEngine>();
    let attempts = 0;
    const { root, click } = setup({ getRules: () => ++attempts === 1 ? Promise.reject(new Error('offline')) : retriedRules.promise });
    await flush();
    expect(root.dataset.engineState).toBe('failed');
    expect(root.querySelector<HTMLButtonElement>('[data-roll]')!.disabled).toBe(true);
    click('[data-retry]'); await flush();
    expect(attempts).toBe(2);
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('pageshow'));
    click('[data-roll]'); click('[data-reset-game]');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    retriedRules.resolve(rules); await flush();
    click('[data-roll]');
    expect(root.dataset.rolls).toBe('1');
  });
  it('keeps human rolls made before delayed rules become available', async () => {
    const delayedRules = deferred<RulesEngine>();
    const { root, click } = setup({ getRules: () => delayedRules.promise });
    click('[data-roll]'); click('[data-die="1"]'); click('[data-roll]');
    expect(root.dataset.rolls).toBe('2');
    delayedRules.resolve(rules); await flush();
    expect(root.dataset.rolls).toBe('2');
    expect(root.querySelector('[data-die="1"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector<HTMLButtonElement>('[data-score="0"]')!.disabled).toBe(false);
  });
  it('settles both load branches before retry and ignores completion after destruction', async () => {
    const delayedRules = deferred<RulesEngine>();
    let attempts = 0;
    const { root, click, exact, controller } = setup({ getRules: () => delayedRules.promise, load: async () => { if (++attempts === 1) throw new Error('failed table'); } });
    await flush();
    expect(exact.load).toHaveBeenCalledTimes(1);
    delayedRules.resolve(rules); await flush();
    expect(root.dataset.engineState).toBe('failed');
    click('[data-retry]'); await flush();
    expect(root.dataset.engineState).toBe('ready');
    expect(exact.load).toHaveBeenCalledTimes(2);
    controller.destroy();
    const snapshot = root.innerHTML;
    root.dispatchEvent(new Event('utility-activate')); click('[data-roll]');
    expect(root.innerHTML).toBe(snapshot);
    const table = deferred<void>();
    const other = setup({ load: () => table.promise });
    other.controller.destroy(); const hiddenSnapshot = other.root.innerHTML;
    table.resolve(); await flush(); expect(other.root.innerHTML).toBe(hiddenSnapshot);
  });
  it('cancels pending timers across back-forward cache suspension', async () => {
    const { root, exact, click } = setup(); await flush();
    click('[data-roll]'); click('[data-score="0"]');
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(100);
    expect(exact.decide).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pageshow'));
    await vi.advanceTimersByTimeAsync(60);
    expect(exact.decide).toHaveBeenCalledTimes(1); expect(root.dataset.turn).toBe('human');
  });
  it('shows bot holds and rerolls before a single score commitment', async () => {
    let decision = 0;
    const { root, click } = setup({ decide: async () => ++decision < 3 ? { kind: 'hold', mask: 3 } : { kind: 'score', category: 0 } });
    await flush(); click('[data-roll]'); click('[data-score="0"]');
    await vi.advanceTimersByTimeAsync(20);
    expect(root.querySelector('[data-die="0"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('[data-die="2"]')!.getAttribute('aria-pressed')).toBe('false');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).match.dice).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(decision).toBe(3); expect(root.dataset.turn).toBe('human');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).match.keiri.scores[0]).toBe(15);
  });
  it('counts a final bot score once and Play Again keeps the record with the human first', async () => {
    const state = freshRivalry(); state.match.human.scores = Array(13).fill(15);
    state.match.keiri.scores = [...Array(12).fill(10), null]; state.match.turn = 'keiri';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const { root, click } = setup({ decide: async () => ({ kind: 'score', category: 12 }) });
    await flush(); await vi.advanceTimersByTimeAsync(50);
    expect(root.dataset.turn).toBe('complete');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).record.human).toBe(1);
    root.dispatchEvent(new Event('utility-deactivate')); root.dispatchEvent(new Event('utility-activate'));
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).record.human).toBe(1);
    click('[data-again]');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.match.turn).toBe('human'); expect(saved.match.human.scores).toEqual(Array(13).fill(null));
    expect(saved.record.human).toBe(1);
  });
  it('requires a deliberate confirmation for record reset without resetting the match', async () => {
    const state = freshRivalry(); state.record = { human: 3, keiri: 2, ties: 1 }; localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const { click } = setup(); await flush(); click('[data-roll]'); click('[data-reset]');
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).record.human).toBe(3);
    click('[data-reset-cancel]'); click('[data-reset]'); click('[data-reset]');
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(saved.record).toEqual({ human: 0, keiri: 0, ties: 0 }); expect(saved.match.rolls).toBe(1);
  });
  it('survives inaccessible storage and rules-invalid persisted sheets', async () => {
    const { root, click } = setup({ storage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } });
    await flush(); click('[data-roll]'); expect(root.dataset.rolls).toBe('1');
    expect(root.querySelector<HTMLElement>('[data-storage]')!.hidden).toBe(false);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(freshRivalry()));
    const invalid = setup({ getRules: async () => ({ ...rules, validateSheet: () => false }) });
    await flush(); expect(invalid.root.textContent).toContain('Saved game could not be restored');
    invalid.click('[data-roll]');
    expect(invalid.root.querySelector('[data-status]')!.textContent).not.toContain('Saved game could not be restored');
  });
});
