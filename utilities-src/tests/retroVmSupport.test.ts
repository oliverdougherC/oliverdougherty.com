import {
  detectRetroVmSupport,
  formatRetroVmProgress,
  resolveRetroVmStatusView,
  transitionRetroVmState
} from '@utilities/retroVmSupport';

describe('retro VM support helpers', () => {
  it('blocks mobile-like environments in v1', () => {
    const coarseMatchMedia = ((query: string) => ({ matches: query === '(pointer: coarse)' } as MediaQueryList)) as unknown as (
      query: string
    ) => MediaQueryList;

    const support = detectRetroVmSupport({
      hasWindow: true,
      hasDocument: true,
      hasWebAssembly: true,
      hasWorker: true,
      innerWidth: 390,
      maxTouchPoints: 5,
      matchMedia: coarseMatchMedia
    });

    expect(support.supported).toBe(false);
    expect(support.isMobileLike).toBe(true);
    expect(support.reason).toMatch(/desktop-first/i);
  });

  it('allows capable desktop environments', () => {
    const desktopMatchMedia = (() => ({ matches: false } as MediaQueryList)) as unknown as (query: string) => MediaQueryList;

    const support = detectRetroVmSupport({
      hasWindow: true,
      hasDocument: true,
      hasWebAssembly: true,
      hasWorker: true,
      innerWidth: 1440,
      maxTouchPoints: 0,
      matchMedia: desktopMatchMedia
    });

    expect(support.supported).toBe(true);
    expect(support.reason).toMatch(/ready/i);
  });

  it('transitions between launch, fullscreen, and reset states', () => {
    expect(transitionRetroVmState('idle', 'launch')).toBe('loading');
    expect(transitionRetroVmState('loading', 'ready')).toBe('running');
    expect(transitionRetroVmState('running', 'enter-fullscreen')).toBe('fullscreen');
    expect(transitionRetroVmState('fullscreen', 'exit-fullscreen')).toBe('running');
    expect(transitionRetroVmState('running', 'reset')).toBe('resetting');
    expect(transitionRetroVmState('resetting', 'reset-complete')).toBe('idle');
  });

  it('formats progress and status text for the loading state', () => {
    const progress = formatRetroVmProgress({
      loadedBytes: 5 * 1024 * 1024,
      totalBytes: 20 * 1024 * 1024
    });

    expect(progress).toMatch(/25%/i);

    const view = resolveRetroVmStatusView('loading', {
      loadedBytes: 5 * 1024 * 1024,
      totalBytes: 20 * 1024 * 1024
    });

    expect(view.chipLabel).toBe('Loading');
    expect(view.progressText).toMatch(/25%/i);
  });

  it('uses the configured guest name in running copy', () => {
    const view = resolveRetroVmStatusView(
      'running',
      {
        loadedBytes: 0,
        totalBytes: null
      },
      'Alpine'
    );

    expect(view.statusText).toMatch(/Alpine is booting locally/i);
  });
});
