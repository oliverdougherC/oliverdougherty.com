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

