/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RulesEngine, Sheet } from '../src/keiriEngine';
import { YahtzeeController } from '../src/yahtzeeController';
import { STORAGE_KEY, freshRivalry } from '../src/yahtzeeCore';

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
