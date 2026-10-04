import type { RulesEngine, Sheet } from './keiriEngine';

export const CATEGORIES = ['Ones', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Three of a kind', 'Four of a kind', 'Full house', 'Small straight', 'Large straight', 'Yahtzee', 'Chance'];
export const STORAGE_KEY = 'od.yahtzee-keiri.v1';
export interface Match {
  human: Sheet;
  keiri: Sheet;
  turn: 'human' | 'keiri' | 'complete';
  dice: number[];
  held: boolean[];
  rolls: number;
}
export interface Rivalry {
  version: 1;
  record: { human: number; keiri: number; ties: number };
  match: Match;
}
export type DieSource = () => number;
export const blankSheet = (): Sheet => ({ scores: Array(13).fill(null), yahtzeeBonus: 0 });
export const freshMatch = (): Match => ({ human: blankSheet(), keiri: blankSheet(), turn: 'human', dice: [], held: Array(5).fill(false), rolls: 0 });
export const freshRivalry = (): Rivalry => ({ version: 1, record: { human: 0, keiri: 0, ties: 0 }, match: freshMatch() });
export const filled = (sheet: Sheet): number => sheet.scores.filter(score => score !== null).length;

// Reject the four excess Uint32 outcomes instead of introducing modulo bias.
export function cryptoDie(): number {
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0] >= 4294967292);
  return sample[0] % 6 + 1;
}
export function rollDice(dice: number[], held: boolean[], rng: DieSource): number[] {
  return Array.from({ length: 5 }, (_, index) => {
    const face = dice.length === 5 && held[index] ? dice[index] : rng();
    if (!Number.isInteger(face) || face < 1 || face > 6) throw new Error('Invalid die outcome');
    return face;
  });
}
export function rollHuman(state: Rivalry, rng: DieSource): Rivalry {
  const match = state.match;
  if (match.turn !== 'human' || match.rolls >= 3) return state;
  return { ...state, match: { ...match, dice: rollDice(match.dice, match.held, rng), rolls: match.rolls + 1 } };
}
export function toggleHold(state: Rivalry, index: number): Rivalry {
  const match = state.match;
  if (match.turn !== 'human' || !match.rolls || match.rolls >= 3 || index < 0 || index >= 5 || !Number.isInteger(index)) return state;
  return { ...state, match: { ...match, held: match.held.map((hold, i) => i === index ? !hold : hold) } };
}
export function scoreHuman(state: Rivalry, category: number, rules: RulesEngine): Rivalry {
  const match = state.match;
  if (match.turn !== 'human' || !match.rolls || rules.preview(match.human, match.dice)[category] == null) return state;
  return { ...state, match: { ...match, human: rules.score(match.human, match.dice, category), turn: 'keiri', dice: [], held: Array(5).fill(false), rolls: 0 } };
}
export function scoreKeiri(state: Rivalry, dice: number[], category: number, rules: RulesEngine): Rivalry {
  if (state.match.turn !== 'keiri') return state;
  const keiri = rules.score(state.match.keiri, dice, category);
  const complete = filled(keiri) === 13 && filled(state.match.human) === 13;
  const match: Match = { ...state.match, keiri, turn: complete ? 'complete' : 'human', dice: [], held: Array(5).fill(false), rolls: 0 };
  if (!complete) return { ...state, match };
  const difference = rules.totals(match.human).total - rules.totals(keiri).total;
  const winner = difference > 0 ? 'human' : difference < 0 ? 'keiri' : 'ties';
  return { ...state, match, record: { ...state.record, [winner]: state.record[winner] + 1 } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function safeCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < Number.MAX_SAFE_INTEGER;
}
function validSheet(value: unknown): value is Sheet {
  if (!isObject(value) || !Array.isArray(value.scores) || value.scores.length !== 13) return false;
  return value.scores.every(score => score === null || (safeCounter(score) && score <= 50)) &&
    safeCounter(value.yahtzeeBonus) && value.yahtzeeBonus <= 1200 && value.yahtzeeBonus % 100 === 0 &&
    (value.yahtzeeBonus === 0 || value.scores[11] === 50);
}
export function parseRivalry(raw: string | null, rules?: RulesEngine): Rivalry | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!isObject(value) || value.version !== 1 || !isObject(value.record) || !isObject(value.match)) return null;
    if (!['human', 'keiri', 'ties'].every(key => safeCounter((value.record as Record<string, unknown>)[key]))) return null;
    const match = value.match;
    if (!validSheet(match.human) || !validSheet(match.keiri)) return null;
    if (rules && (!rules.validateSheet(match.human) || !rules.validateSheet(match.keiri))) return null;
    if (!Array.isArray(match.dice) || !Array.isArray(match.held) || match.held.length !== 5 || !match.held.every(hold => typeof hold === 'boolean')) return null;
    if (!Number.isInteger(match.rolls) || (match.rolls as number) < 0 || (match.rolls as number) > 3) return null;
    if (match.rolls === 0 ? match.dice.length !== 0 || match.held.some(Boolean) : match.dice.length !== 5 || !match.dice.every(face => Number.isInteger(face) && face >= 1 && face <= 6)) return null;
    const humanCount = filled(match.human);
    const keiriCount = filled(match.keiri);
    if (match.turn === 'human') {
      if (humanCount !== keiriCount || humanCount === 13) return null;
    } else if (match.turn === 'keiri') {
      if (humanCount !== keiriCount + 1 || match.rolls !== 0) return null;
    } else if (match.turn === 'complete') {
      if (humanCount !== 13 || keiriCount !== 13 || match.rolls !== 0) return null;
    } else return null;
    return value as unknown as Rivalry;
  } catch { return null; }
}
