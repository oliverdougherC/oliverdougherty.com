import { resolveAudioPlaybackButtonLabel, resolveAudioPlaybackButtonState } from '@utilities/audioFourierUiState';

describe('audio playback UI state', () => {
  it('resolves play, pause, and replay labels from playback state', () => {
    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        isComplete: false,
      })
    ).toBe('Play');

    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: true,
        isComplete: false,
      })
    ).toBe('Pause');

    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        isComplete: true,
      })
    ).toBe('Replay');
  });

  it('keeps playback controls icon-only while exposing accessible labels', () => {
    expect(
      resolveAudioPlaybackButtonState({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        isComplete: false,
      })
    ).toEqual({ icon: '\u25b6', label: 'Play' });

    expect(
      resolveAudioPlaybackButtonState({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        isComplete: true,
      })
    ).toEqual({ icon: '\u21BB', label: 'Replay' });

    expect(
      resolveAudioPlaybackButtonState({
        hasResult: true,
        isProcessing: false,
        isPlaying: true,
        isComplete: false,
      })
    ).toEqual({ icon: '\u23f8', label: 'Pause' });
  });
});
