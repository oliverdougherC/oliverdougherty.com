export function resolveAudioPlaybackButtonLabel(options: {
  hasResult: boolean;
  isProcessing: boolean;
  isPlaying: boolean;
  reducedMotion: boolean;
  elapsedSeconds: number;
}) {
  if (!options.hasResult || options.isProcessing || options.isPlaying || options.reducedMotion || options.elapsedSeconds <= 0) {
    return 'Play';
  }

  return 'Replay';
}

