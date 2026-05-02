export function resolveAudioPlaybackButtonLabel(options: {
  hasResult: boolean;
  isProcessing: boolean;
  isPlaying: boolean;
  reducedMotion: boolean;
  elapsedSeconds: number;
  isComplete: boolean;
}) {
  if (!options.hasResult || options.isProcessing || options.isPlaying || options.reducedMotion) {
    return 'Play';
  }

  if (options.isComplete) {
    return 'Replay';
  }

  return 'Play';
}

