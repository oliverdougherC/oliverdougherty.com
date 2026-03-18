import { describe, expect, it } from 'vitest';
import {
  shouldHandleOverlayCloseShortcut,
  shouldSuppressOverlayGameplayKey
} from '@/runtime/overlayInput';

describe('overlay input guards', () => {
  it('allows handbook search inputs to keep wasd, h, and space', () => {
    expect(
      shouldSuppressOverlayGameplayKey({
        key: 'w',
        movementKeyActive: true,
        targetAllowsNativeHandling: true
      })
    ).toBe(false);
    expect(
      shouldSuppressOverlayGameplayKey({
        key: ' ',
        movementKeyActive: false,
        targetAllowsNativeHandling: true
      })
    ).toBe(false);
    expect(shouldHandleOverlayCloseShortcut('h', 'h', true)).toBe(false);
  });

  it('still suppresses gameplay movement keys on non-interactive overlay targets', () => {
    expect(
      shouldSuppressOverlayGameplayKey({
        key: 'a',
        movementKeyActive: true,
        targetAllowsNativeHandling: false
      })
    ).toBe(true);
    expect(
      shouldSuppressOverlayGameplayKey({
        key: ' ',
        movementKeyActive: false,
        targetAllowsNativeHandling: false
      })
    ).toBe(true);
    expect(shouldHandleOverlayCloseShortcut('h', 'h', false)).toBe(true);
  });
});
