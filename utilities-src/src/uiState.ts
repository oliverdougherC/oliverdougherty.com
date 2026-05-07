export type SelectionKind = 'source' | 'target';
export type StateKind = 'idle' | 'processing' | 'ready' | 'paused' | 'animating' | 'complete' | 'error';

export interface ImageSelection {
  kind: 'file' | 'demo';
  label: string;
  file?: File;
  url?: string;
}

export const DEMOS: Record<string, { source: ImageSelection; target: ImageSelection }> = {
  'pattern-face': {
    source: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/image-transform/pattern.png' },
    target: { kind: 'demo', label: 'Face', url: '../../assets/utilities/image-transform/face.png' }
  },
  'source-target': {
    source: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/image-transform/pattern.png' },
    target: { kind: 'demo', label: 'Lucki', url: '../../assets/utilities/image-transform/lucki.jpeg' }
  },
  'face-pattern': {
    source: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/image-transform/pattern.png' },
    target: { kind: 'demo', label: 'Keef', url: '../../assets/utilities/image-transform/keef.jpeg' }
  }
};

export function resolvePlaybackButtonLabel(options: {
  hasResult: boolean;
  isProcessing: boolean;
  isAnimating: boolean;
  reducedMotion: boolean;
  animationElapsedMs: number;
}) {
  if (
    !options.hasResult ||
    options.isProcessing ||
    options.isAnimating ||
    options.reducedMotion ||
    options.animationElapsedMs <= 0
  ) {
    return 'Play';
  }

  return 'Replay';
}
