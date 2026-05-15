import { resolveAudioPlaybackButtonLabel, resolveAudioPlaybackButtonState } from '@utilities/audioFourierUiState';

describe('audio playback UI state', () => {
  it('resolves play and replay labels from playback state', () => {
    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        elapsedSeconds: 0,
        isComplete: false,
      })
    ).toBe('Play');

    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        elapsedSeconds: 1,
        isComplete: false,
      })
    ).toBe('Play');

    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        elapsedSeconds: 1,
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
        elapsedSeconds: 0,
        isComplete: false,
      })
    ).toEqual({ icon: '\u25b6', label: 'Play' });

    expect(
      resolveAudioPlaybackButtonState({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        elapsedSeconds: 1,
        isComplete: true,
      })
    ).toEqual({ icon: '\u25b6', label: 'Replay' });
  });
});
