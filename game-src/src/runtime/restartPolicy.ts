import type { UIState } from '../types';

export type RestartContext = UIState;
export type RestartPolicyAction = 'none' | 'restart_same_seed' | 'restart_new_seed';

export interface RestartPolicyInput {
  key: string;
  shiftKey: boolean;
  isRepeat: boolean;
  shortcutAllowed: boolean;
  context: RestartContext;
}

const SAFE_SHORTCUT_CONTEXTS = new Set<RestartContext>(['paused', 'gameover']);

export function resolveRestartAction(input: RestartPolicyInput): RestartPolicyAction {
  const key = input.key.toLowerCase();

  if (key === 'enter' || key === ' ') {
    return input.context === 'gameover' && !input.isRepeat ? 'restart_same_seed' : 'none';
  }

  if (!input.shortcutAllowed || input.isRepeat || !input.shiftKey) return 'none';
  if (!SAFE_SHORTCUT_CONTEXTS.has(input.context)) return 'none';
  if (key === 'r') return 'restart_same_seed';
  if (key === 'n') return 'restart_new_seed';
  return 'none';
}
