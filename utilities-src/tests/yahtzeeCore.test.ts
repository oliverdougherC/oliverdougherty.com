import { describe, expect, it, vi } from 'vitest';
import type { RulesEngine, Sheet } from '../src/keiriEngine';
import { cryptoDie, freshRivalry, parseRivalry, rollDice, rollHuman, scoreHuman, scoreKeiri, toggleHold } from '../src/yahtzeeCore';

const rules: RulesEngine = {
  preview: (sheet: Sheet, dice: number[]) => sheet.scores.map(score => score === null ? dice.reduce((a, b) => a + b, 0) : null),
  score: (sheet: Sheet, dice: number[], category: number) => {
    if (sheet.scores[category] !== null) throw new Error('Filled category');
    return { ...sheet, scores: sheet.scores.map((score, i) => i === category ? dice.reduce((a, b) => a + b, 0) : score) };
  },
  totals: (sheet: Sheet) => ({ upper: 0, upperBonus: 0, yahtzeeBonus: sheet.yahtzeeBonus, total: sheet.scores.reduce<number>((sum, value) => sum + (value ?? 0), 0) }),
  validateSheet: () => true
};

describe('Yahtzee match transitions', () => {
  it('starts the human, preserves held dice and caps the turn at three rolls', () => {
    let next = 0;
    const rng = () => (++next % 6) + 1;
    let state = rollHuman(freshRivalry(), rng);
    const first = state.match.dice[0];
    state = toggleHold(state, 0);
    state = rollHuman(state, rng);
    expect(state.match.dice[0]).toBe(first);
    state = rollHuman(state, rng);
    expect(rollHuman(state, rng)).toBe(state);
    expect(toggleHold(state, 0)).toBe(state);
    expect(state.match.rolls).toBe(3);
  });
  it('does not score unrolled or filled categories and persists bot at its canonical start', () => {
    const initial = freshRivalry();
    expect(scoreHuman(initial, 0, rules)).toBe(initial);
    let state = scoreHuman(rollHuman(initial, () => 1), 0, rules);
    expect(state.match).toMatchObject({ turn: 'keiri', dice: [], rolls: 0, held: [false, false, false, false, false] });
    expect(rollHuman(state, () => 6)).toBe(state);
    state = scoreKeiri(state, [2, 2, 2, 2, 2], 0, rules);
    expect(state.match.turn).toBe('human');
    state = rollHuman(state, () => 1);
    expect(scoreHuman(state, 0, rules)).toBe(state);
  });
  it('replays a complete deterministic fixture and records the result exactly once', () => {
    let state = freshRivalry();
    for (let category = 0; category < 13; category++) {
      state = scoreHuman(rollHuman(state, () => 3), category, rules);
      state = scoreKeiri(state, [2, 2, 2, 2, 2], category, rules);
    }
    expect(state.match.turn).toBe('complete');
    expect(state.record).toEqual({ human: 1, keiri: 0, ties: 0 });
    expect(scoreKeiri(state, [2, 2, 2, 2, 2], 12, rules)).toBe(state);
    expect(parseRivalry(JSON.stringify(state), rules)).toEqual(state);
  });
  it('uses rejection sampling and rejects a broken injected die source', () => {
    let calls = 0;
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      (array as Uint32Array)[0] = calls++ === 0 ? 4294967295 : 9;
      return array;
    });
    expect(cryptoDie()).toBe(4);
    expect(calls).toBe(2);
    spy.mockRestore();
    expect(() => rollDice([], [], () => 0)).toThrow('Invalid die outcome');
  });
});

describe('versioned match recovery', () => {
  it('restores the entire current human turn', () => {
    const state = toggleHold(rollHuman(freshRivalry(), () => 5), 2);
    expect(parseRivalry(JSON.stringify(state), rules)).toEqual(state);
  });
  it.each([
    (state: any) => { state.version = 0; },
    (state: any) => { state.record.human = -1; },
    (state: any) => { state.match.rolls = 4; },
    (state: any) => { state.match.dice = [7, 1, 1, 1, 1]; state.match.rolls = 1; },
    (state: any) => { state.match.held[0] = true; },
    (state: any) => { state.match.human.scores.pop(); },
    (state: any) => { state.match.human.yahtzeeBonus = 100; },
    (state: any) => { state.match.turn = 'keiri'; },
    (state: any) => { state.match.human.scores[0] = 1; },
    (state: any) => { state.match.turn = 'complete'; }
  ])('rejects a malformed or inconsistent state (%#)', mutate => {
    const state = freshRivalry(); mutate(state);
    expect(parseRivalry(JSON.stringify(state), rules)).toBeNull();
  });
  it('rejects unreadable JSON and sheets rejected by the Rust boundary', () => {
    expect(parseRivalry('{broken')).toBeNull();
    expect(parseRivalry(JSON.stringify(freshRivalry()), { ...rules, validateSheet: () => false })).toBeNull();
  });
});
