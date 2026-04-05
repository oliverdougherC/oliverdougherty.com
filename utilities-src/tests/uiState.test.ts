import { DEMOS, resolvePlaybackButtonLabel } from '@utilities/uiState';

describe('utilities UI state', () => {
  it('keeps the source-target demo labels aligned with the pattern assets', () => {
    expect(DEMOS['source-target']).toMatchObject({
      source: { label: 'Pattern' },
      target: { label: 'Pattern' }
    });
  });

  it('switches the primary transport button from play to replay after motion has begun', () => {
    expect(
      resolvePlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isAnimating: false,
        reducedMotion: false,
        animationElapsedMs: 0
      })
    ).toBe('Play');

    expect(
      resolvePlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isAnimating: false,
        reducedMotion: false,
        animationElapsedMs: 1
      })
    ).toBe('Replay');

    expect(
      resolvePlaybackButtonLabel({
        hasResult: true,
        isProcessing: false,
        isAnimating: false,
        reducedMotion: false,
        animationElapsedMs: 3200
      })
    ).toBe('Replay');
  });
});
