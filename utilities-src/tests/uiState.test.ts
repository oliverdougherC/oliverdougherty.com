import { DEMOS, resolvePlaybackButtonLabel } from '@utilities/uiState';

describe('utilities UI state', () => {
  it('maps the source-target demo to Pattern and Lucki', () => {
    expect(DEMOS['source-target']).toMatchObject({
      source: { label: 'Pattern', url: '../../assets/utilities/image-transform/pattern.png' },
      target: { label: 'Lucki', url: '../../assets/utilities/image-transform/lucki.jpeg' }
    });
  });

  it('maps the face-pattern demo key to Pattern and Keef', () => {
    expect(DEMOS['face-pattern']).toMatchObject({
      source: { label: 'Pattern', url: '../../assets/utilities/image-transform/pattern.png' },
      target: { label: 'Keef', url: '../../assets/utilities/image-transform/keef.jpeg' }
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
