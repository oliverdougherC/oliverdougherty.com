export type SelectionKind = 'source' | 'target';
export type StateKind = 'idle' | 'processing' | 'ready' | 'paused' | 'animating' | 'complete' | 'error';

export interface ImageSelection {
  kind: 'file' | 'demo';
  label: string;
  file?: File;
  url?: string;
}

export const TRANSFORM_DEMO_ASSET_URLS = {
  pattern: '../../assets/utilities/image-transform/pattern.png',
  face: '../../assets/utilities/image-transform/face.png',
  lucki: '../../assets/utilities/image-transform/lucki.jpeg',
  keef: '../../assets/utilities/image-transform/keef.jpeg'
} as const;

export const DEMOS: Record<string, { source: ImageSelection; target: ImageSelection }> = {
  'pattern-face': {
    source: { kind: 'demo', label: 'Pattern', url: TRANSFORM_DEMO_ASSET_URLS.pattern },
    target: { kind: 'demo', label: 'Face', url: TRANSFORM_DEMO_ASSET_URLS.face }
  },
  'source-target': {
    source: { kind: 'demo', label: 'Pattern', url: TRANSFORM_DEMO_ASSET_URLS.pattern },
    target: { kind: 'demo', label: 'Lucki', url: TRANSFORM_DEMO_ASSET_URLS.lucki }
  },
  'face-pattern': {
    source: { kind: 'demo', label: 'Pattern', url: TRANSFORM_DEMO_ASSET_URLS.pattern },
    target: { kind: 'demo', label: 'Keef', url: TRANSFORM_DEMO_ASSET_URLS.keef }
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
