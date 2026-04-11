import { resolveAudioPlaybackButtonLabel } from '@utilities/audioFourierUiState';

describe('audio Fourier UI state', () => {
  it('resolves play and replay labels from playback state', () => {
    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        reducedMotion: false,
        elapsedSeconds: 0
      })
    ).toBe('Play');

    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        reducedMotion: false,
        elapsedSeconds: 1
      })
    ).toBe('Replay');
  });
});

