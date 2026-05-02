import { resolveAudioPlaybackButtonLabel } from '@utilities/audioFourierUiState';

describe('audio_fourier_ui_state', () => {
  it('resolves_play_and_replay_labels_from_playback_state', () => {
    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        reducedMotion: false,
        elapsedSeconds: 0,
        isComplete: false,
      })
    ).toBe('Play');

    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        reducedMotion: false,
        elapsedSeconds: 1,
        isComplete: false,
      })
    ).toBe('Play');

    expect(
      resolveAudioPlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isPlaying: false,
        reducedMotion: false,
        elapsedSeconds: 1,
        isComplete: true,
      })
    ).toBe('Replay');
  });
});
