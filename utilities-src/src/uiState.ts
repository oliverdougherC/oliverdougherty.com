export type SelectionKind = 'source' | 'target';
export type StateKind = 'idle' | 'processing' | 'ready' | 'animating' | 'complete' | 'error';

export interface ImageSelection {
  kind: 'file' | 'demo';
  label: string;
  file?: File;
  url?: string;
}

export const DEMOS: Record<string, { source: ImageSelection; target: ImageSelection }> = {
  'pattern-face': {
    source: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/pattern.png' },
    target: { kind: 'demo', label: 'Face', url: '../../assets/utilities/face.png' }
  },
  'source-target': {
    source: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/source.png' },
    target: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/target.png' }
  },
  'face-pattern': {
    source: { kind: 'demo', label: 'Face', url: '../../assets/utilities/face.png' },
    target: { kind: 'demo', label: 'Pattern', url: '../../assets/utilities/pattern.png' }
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
