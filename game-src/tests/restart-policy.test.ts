import { describe, expect, it } from 'vitest';
import { resolveRestartAction } from '@/runtime/restartPolicy';

describe('restart policy', () => {
  it('blocks restart shortcuts while actively playing', () => {
    expect(resolveRestartAction({
      key: 'r',
      shiftKey: true,
      isRepeat: false,
      shortcutAllowed: true,
      context: 'playing'
    })).toBe('none');
    expect(resolveRestartAction({
      key: 'n',
      shiftKey: true,
      isRepeat: false,
      shortcutAllowed: true,
      context: 'chest'
    })).toBe('none');
  });

  it('requires shift chord and safe context for r/n shortcuts', () => {
    expect(resolveRestartAction({
      key: 'r',
      shiftKey: false,
      isRepeat: false,
      shortcutAllowed: true,
      context: 'paused'
    })).toBe('none');
    expect(resolveRestartAction({
      key: 'r',
      shiftKey: true,
      isRepeat: false,
      shortcutAllowed: true,
      context: 'paused'
    })).toBe('restart_same_seed');
    expect(resolveRestartAction({
      key: 'n',
      shiftKey: true,
      isRepeat: false,
      shortcutAllowed: true,
      context: 'gameover'
    })).toBe('restart_new_seed');
  });

  it('allows gameover enter/space restart only on non-repeat keydown', () => {
    expect(resolveRestartAction({
      key: 'Enter',
      shiftKey: false,
      isRepeat: false,
      shortcutAllowed: true,
      context: 'gameover'
    })).toBe('restart_same_seed');
    expect(resolveRestartAction({
      key: ' ',
      shiftKey: false,
      isRepeat: true,
      shortcutAllowed: true,
      context: 'gameover'
    })).toBe('none');
  });
});
