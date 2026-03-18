interface OverlayGameplayKeyOptions {
  key: string;
  movementKeyActive: boolean;
  targetAllowsNativeHandling: boolean;
}

export function shouldSuppressOverlayGameplayKey(options: OverlayGameplayKeyOptions): boolean {
  if (options.targetAllowsNativeHandling) return false;
  return options.movementKeyActive || options.key === ' ';
}

export function shouldHandleOverlayCloseShortcut(
  key: string,
  closeKey: string,
  targetAllowsNativeHandling: boolean
): boolean {
  return key === closeKey && !targetAllowsNativeHandling;
}
