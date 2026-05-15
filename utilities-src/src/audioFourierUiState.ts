export function resolveAudioPlaybackButtonLabel(options: {
  hasResult: boolean;
  isProcessing: boolean;
  isPlaying: boolean;
  elapsedSeconds: number;
  isComplete: boolean;
}) {
  if (!options.hasResult || options.isProcessing || options.isPlaying) {
    return 'Play';
  }

  if (options.isComplete) {
    return 'Replay';
  }

  return 'Play';
}

export function resolveAudioPlaybackButtonState(options: Parameters<typeof resolveAudioPlaybackButtonLabel>[0]) {
  const label = resolveAudioPlaybackButtonLabel(options);
  return {
    icon: '\u25b6',
    label
  };
}
