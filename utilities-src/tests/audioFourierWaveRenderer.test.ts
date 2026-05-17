import { resolveAudioWaveCanvasScale } from '@utilities/audioFourierWaveRenderer';

describe('audio Fourier wave renderer', () => {
  it('keeps small waveform canvases crisp while capping extreme DPR work', () => {
    expect(resolveAudioWaveCanvasScale(800, 300, 2)).toBe(2);
    expect(resolveAudioWaveCanvasScale(2160, 1800, 2)).toBeCloseTo(1.014, 3);
  });

  it('keeps extreme canvases above the minimum readability scale', () => {
    expect(resolveAudioWaveCanvasScale(4096, 4096, 2)).toBe(1);
    expect(resolveAudioWaveCanvasScale(800, 300, 0)).toBe(1);
  });

  it('allows the software canvas fallback to trade resolution for frame pacing', () => {
    expect(resolveAudioWaveCanvasScale(2160, 1800, 2, 750_000, 0.3)).toBeCloseTo(0.439, 3);
    expect(resolveAudioWaveCanvasScale(4096, 4096, 2, 750_000, 0.3)).toBe(0.3);
  });
});
