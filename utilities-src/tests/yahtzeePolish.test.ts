/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RulesEngine, Sheet } from '../src/keiriEngine';
import { YahtzeeController } from '../src/yahtzeeController';
import { STORAGE_KEY, freshMatch, freshRivalry } from '../src/yahtzeeCore';

vi.mock('../src/keiriEngine', () => ({ ExactEngine: class {}, loadRules: vi.fn() }));
const previews = [0, 1, 6, 12, 15, 18, 21, 24, 25, 30, 40, 50, 30];
const rules: RulesEngine = {
  preview: (sheet: Sheet) => sheet.scores.map((score, category) => score === null ? previews[category] : null),
  score: (sheet: Sheet, _dice: number[], category: number) => ({ ...sheet, scores: sheet.scores.map((score, i) => i === category ? previews[category] : score) }),
  totals: (sheet: Sheet) => ({ upper: 0, upperBonus: 0, yahtzeeBonus: 0, total: sheet.scores.reduce<number>((sum, value) => sum + (value ?? 0), 0) }),
  validateSheet: () => true
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const controllers: YahtzeeController[] = [];
function setup(options: { rng?: () => number; load?: () => Promise<void>; getRules?: () => Promise<RulesEngine>; decide?: () => Promise<{ kind: 'score'; category: number }> } = {}) {
  const root = document.createElement('section');
  root.className = 'utility-shell--yahtzee';
  document.body.append(root);
  const exact = { load: vi.fn(options.load ?? (async () => {})), decide: vi.fn(options.decide ?? (async () => ({ kind: 'score' as const, category: 0 }))) };
  const controller = new YahtzeeController(root, { exact, rules: options.getRules ?? (async () => rules), rng: options.rng ?? (() => 3), pauseMs: 20 });
  controllers.push(controller);
  controller.init();
  const button = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!;
  const click = (selector: string) => button(selector).click();
  const pointer = (selector: string) => button(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  return { root, exact, controller, button, click, pointer };
}
function stored() { return JSON.parse(localStorage.getItem(STORAGE_KEY)!); }
async function flush() { await vi.advanceTimersByTimeAsync(0); }
function seedRecord() {
  const state = freshRivalry();
  state.record = { human: 3, keiri: 2, ties: 1 };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  return state;
}
function motionPreference(reduced: boolean) {
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced, media: '(prefers-reduced-motion: reduce)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
}
function animations() {
  const active: Array<{ element: Element; done: ReturnType<typeof deferred<Animation>>; cancel: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('Animation', class {});
  const animate = vi.fn(function (this: Element, _frames: Keyframe[], _options?: KeyframeAnimationOptions) {
    const done = deferred<Animation>();
    const cancel = vi.fn(() => done.reject(new DOMException('Cancelled', 'AbortError')));
    const animation = { finished: done.promise, cancel } as unknown as Animation;
    active.push({ element: this, done, cancel });
    return animation;
  });
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animate });
  return { active, animate, finish: () => active.forEach(item => item.done.resolve({} as Animation)) };
}
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate');
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); motionPreference(false); });
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.destroy());
  await flush();
  document.body.replaceChildren();
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate);
  else Reflect.deleteProperty(Element.prototype, 'animate');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Yahtzee polish behavior', () => {
  it('resets a human match immediately while preserving the rivalry across restoration', async () => {
    const original = seedRecord();
    const { root, click, controller } = setup();
    await flush(); click('[data-roll]'); click('[data-die="1"]');
    expect(stored().match.rolls).toBe(1);
    expect(stored().match.held[1]).toBe(true);
    click('[data-reset-game]');
    expect(stored()).toEqual({ ...original, match: freshMatch() });
    expect(root.dataset.turn).toBe('human');
    controller.destroy();
    const restored = setup(); await flush();
    expect(restored.root.dataset.rolls).toBe('0');
    expect(stored().record).toEqual(original.record);
  });

  it('does not restore the old match when rules and table finish after a reset', async () => {
    const original = seedRecord();
    original.match.dice = [1, 2, 3, 4, 5]; original.match.rolls = 2; original.match.held[0] = true;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(original));
    const delayedRules = deferred<RulesEngine>(); const table = deferred<void>();
    const { root, click, exact } = setup({ getRules: () => delayedRules.promise, load: () => table.promise });
    click('[data-reset-game]');
    delayedRules.resolve(rules); table.resolve(); await flush();
    expect(stored()).toEqual({ ...original, match: freshMatch() });
    expect(root.dataset.engineState).toBe('ready');
    expect(exact.decide).not.toHaveBeenCalled();
    click('[data-roll]'); expect(stored().match.rolls).toBe(1);
  });

  it('invalidates an outstanding final bot decision without counting or reviving that match', async () => {
    const state = seedRecord();
    state.match.human.scores = Array(13).fill(10);
    state.match.keiri.scores = [...Array(12).fill(5), null];
    state.match.turn = 'keiri';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    const decision = deferred<{ kind: 'score'; category: number }>();
    const { root, exact, click } = setup({ decide: () => decision.promise });
    await flush(); await vi.advanceTimersByTimeAsync(20);
    expect(exact.decide).toHaveBeenCalledTimes(1);
    click('[data-reset-game]');
    decision.resolve({ kind: 'score', category: 12 });
    await vi.advanceTimersByTimeAsync(200);
    expect(stored()).toEqual({ ...state, match: freshMatch() });
    expect(root.dataset.turn).toBe('human');
    expect(root.querySelector('[data-status]')!.textContent).not.toMatch(/wins|tie/i);
  });

  it('grades previews by absolute points while retaining zero and numeric accessible labels', async () => {
    const { root, click } = setup(); await flush(); click('[data-roll]');
    const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-score]')];
    const strength = buttons.map(button => Number(button.style.getPropertyValue('--score-strength')));
    expect(strength[0]).toBeCloseTo(0.035, 3);
    expect(strength[11]).toBeCloseTo(0.62, 3);
    for (let index = 1; index < 12; index++) expect(strength[index]).toBeGreaterThan(strength[index - 1]);
    expect(strength[9]).toBe(strength[12]);
    buttons.forEach((button, category) => {
      expect(button.textContent).toBe(String(previews[category]));
      expect(button.getAttribute('aria-label')).toContain(`${previews[category]} points`);
      expect(button.classList.contains('is-preview')).toBe(true);
    });
    click('[data-score="0"]');
    expect(root.querySelectorAll('[data-score].is-preview')).toHaveLength(0);
  });

  it('renders nine geometric pips per die and only labels held dice', async () => {
    const { root, click } = setup(); await flush(); click('[data-roll]');
    const dice = [...root.querySelectorAll('[data-die]')];
    expect(dice).toHaveLength(5);
    dice.forEach(die => {
      expect(die.querySelectorAll('.yahtzee-pip')).toHaveLength(9);
      expect(die.getAttribute('data-face')).toBe('3');
      expect(die.querySelector('.yahtzee-held')!.textContent).toBe('');
    });
    click('[data-die="2"]');
    expect(dice[2].querySelector('.yahtzee-held')!.textContent).toBe('HELD');
    expect(dice[2].getAttribute('aria-pressed')).toBe('true');
    expect(root.querySelector('.yahtzee-dice')!.textContent).not.toMatch(/ROLL|[⚀-⚅]/u);
  });

  it('persists outcomes before animation finishes, blocks input and leaves held dice still', async () => {
    const { root, button, click, pointer } = setup(); await flush();
    const motion = animations();
    click('[data-roll]'); // Keyboard/synthetic click remains immediate.
    expect(motion.animate).not.toHaveBeenCalled();
    click('[data-die="0"]');
    pointer('[data-roll]');
    expect(stored().match.rolls).toBe(2);
    expect(stored().match.dice).toEqual([3, 3, 3, 3, 3]);
    expect(root.dataset.rolling).toBe('true');
    expect(button('[data-roll]').disabled).toBe(true);
    expect(button('[data-die="1"]').disabled).toBe(true);
    expect(button('[data-score="1"]').disabled).toBe(true);
    expect(motion.active.filter(item => item.element.classList.contains('yahtzee-face'))).toHaveLength(4);
    expect(motion.active).toHaveLength(32);
    expect(motion.active.some(item => item.element.closest('[data-die="0"]'))).toBe(false);
    motion.finish(); await vi.advanceTimersByTimeAsync(300);
    expect(root.dataset.rolling).not.toBe('true');
    expect(button('[data-roll]').disabled).toBe(false);
    expect(button('[data-score="1"]').disabled).toBe(false);
  });

  it('tumbles six real faces from the previous result and lands on the persisted outcome without rerolling', async () => {
    let calls = 0;
    const { root, click, pointer } = setup({ rng: () => calls++ % 6 + 1 });
    await flush();
    click('[data-roll]');
    const previous = stored().match.dice;
    const motion = animations();
    pointer('[data-roll]');
    const outcome = stored().match.dice;
    expect(calls).toBe(10);
    expect(previous).toEqual([1, 2, 3, 4, 5]);
    expect(outcome).toEqual([6, 1, 2, 3, 4]);
    root.querySelectorAll('[data-die]').forEach((die, index) => {
      const sides = [...die.querySelectorAll<HTMLElement>('.yahtzee-cube-side')];
      const values = sides.map(side => Number(side.dataset.value));
      expect([...values].sort()).toEqual([1, 2, 3, 4, 5, 6]);
      expect(values).toEqual([1, 6, 2, 5, 3, 4]);
      expect(values[0] + values[1]).toBe(7);
      expect(values[2] + values[3]).toBe(7);
      expect(values[4] + values[5]).toBe(7);
      sides.forEach(side => expect(side.querySelectorAll('.yahtzee-cube-pip.is-visible')).toHaveLength(Number(side.dataset.value)));
    });
    const frames = motion.animate.mock.calls[0][0] as Keyframe[];
    expect(frames[0].transform).toContain('rotateY(0deg)'); // Previous one starts facing forward.
    expect(frames.at(-1)!.transform).toContain('rotateX(360deg)');
    expect(frames.at(-1)!.transform).toContain('rotateY(-180deg)'); // Back face is the persisted six.
    const cachedPanels = [...root.querySelectorAll('.yahtzee-cube-side')];
    motion.finish(); await flush();
    expect(root.querySelectorAll('.yahtzee-cube-side')).toHaveLength(0);
    expect(root.querySelectorAll('.is-tumbling')).toHaveLength(0);
    expect(stored().match.dice).toEqual(outcome);
    expect(calls).toBe(10);
    pointer('[data-roll]');
    [...root.querySelectorAll('.yahtzee-cube-side')].forEach((panel, index) => expect(panel).toBe(cachedPanels[index]));
    motion.finish(); await flush();
  });

  it.each(['reset', 'deactivate', 'destroy'])('cancels dice animations on %s without stale settlement', async action => {
    const { root, controller, click, pointer } = setup(); await flush();
    const motion = animations(); pointer('[data-roll]');
    expect(motion.active.filter(item => item.element.classList.contains('yahtzee-face'))).toHaveLength(5);
    expect(motion.active).toHaveLength(40);
    if (action === 'reset') click('[data-reset-game]');
    else if (action === 'deactivate') root.dispatchEvent(new Event('utility-deactivate'));
    else controller.destroy();
    const snapshot = root.innerHTML;
    const canonical = stored();
    motion.active.forEach(item => expect(item.cancel).toHaveBeenCalled());
    expect(root.querySelectorAll('.yahtzee-cube-side, .is-tumbling')).toHaveLength(0);
    motion.finish(); await vi.advanceTimersByTimeAsync(500);
    expect(root.innerHTML).toBe(snapshot);
    expect(stored()).toEqual(canonical);
    if (action === 'reset') expect(canonical.match).toEqual(freshMatch());
    if (action === 'deactivate') {
      root.dispatchEvent(new Event('utility-activate'));
      expect(root.dataset.rolling).not.toBe('true');
      expect(root.querySelector<HTMLButtonElement>('[data-roll]')!.disabled).toBe(false);
      expect(stored().match.rolls).toBe(1);
    }
  });

  it('skips dice motion and enables legal actions immediately for reduced motion', async () => {
    motionPreference(true);
    const { root, button, pointer } = setup(); await flush();
    const motion = animations(); pointer('[data-roll]');
    expect(motion.animate).not.toHaveBeenCalled();
    expect(root.dataset.rolling).not.toBe('true');
    expect(stored().match.rolls).toBe(1);
    expect(button('[data-die="0"]').disabled).toBe(false);
    expect(button('[data-score="1"]').disabled).toBe(false);
  });
});
