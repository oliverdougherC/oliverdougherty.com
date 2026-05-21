import {
  detectRetroVmSupport,
  formatRetroVmProgress,
  resolveRetroVmStatusView,
  transitionRetroVmState
} from '@utilities/retroVmSupport';

function createMediaQueryList(query: string, matches: boolean): MediaQueryList {
  const target = new EventTarget();
  return {
    matches,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target)
  };
}

function createMatchMedia(matchesForQuery: (query: string) => boolean) {
  return (query: string) => createMediaQueryList(query, matchesForQuery(query));
}

describe('retro VM support helpers', () => {
  it('blocks mobile-like environments in v1', () => {
    const coarseMatchMedia = createMatchMedia((query) => query === '(pointer: coarse)');

    const support = detectRetroVmSupport({
      hasWindow: true,
      hasDocument: true,
      hasWebAssembly: true,
      hasWorker: true,
      hasFullscreen: true,
      hasPointerLock: true,
      innerWidth: 390,
      maxTouchPoints: 5,
      matchMedia: coarseMatchMedia
    });

    expect(support.supported).toBe(false);
    expect(support.isMobileLike).toBe(true);
    expect(support.reason).toMatch(/desktop-first/i);
  });

  it('allows capable desktop environments', () => {
    const desktopMatchMedia = createMatchMedia(() => false);

    const support = detectRetroVmSupport({
      hasWindow: true,
      hasDocument: true,
      hasWebAssembly: true,
      hasWorker: true,
      hasFullscreen: true,
      hasPointerLock: true,
      innerWidth: 1440,
      maxTouchPoints: 0,
      matchMedia: desktopMatchMedia
    });

    expect(support.supported).toBe(true);
    expect(support.reason).toMatch(/ready/i);
    expect(support.hasFullscreen).toBe(true);
    expect(support.hasPointerLock).toBe(true);
  });

  it('falls back cleanly when matchMedia throws during support detection', () => {
    const support = detectRetroVmSupport({
      hasWindow: true,
      hasDocument: true,
      hasWebAssembly: true,
      hasWorker: true,
      hasFullscreen: true,
      hasPointerLock: true,
      innerWidth: 1440,
      maxTouchPoints: 0,
      matchMedia: () => {
        throw new Error('matchMedia unavailable');
      }
    });

    expect(support.supported).toBe(true);
    expect(support.isMobileLike).toBe(false);
  });

  it('allows desktop launch with degraded fullscreen and pointer-lock copy', () => {
    const desktopMatchMedia = createMatchMedia(() => false);

    const support = detectRetroVmSupport({
      hasWindow: true,
      hasDocument: true,
      hasWebAssembly: true,
      hasWorker: true,
      hasFullscreen: false,
      hasPointerLock: false,
      innerWidth: 1440,
      maxTouchPoints: 0,
      matchMedia: desktopMatchMedia
    });

    expect(support.supported).toBe(true);
    expect(support.reason).toMatch(/fullscreen is unavailable/i);
    expect(support.reason).toMatch(/pointer lock is unavailable/i);
    expect(support.hasFullscreen).toBe(false);
    expect(support.hasPointerLock).toBe(false);
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

  it('formats kilobyte progress with decimal precision', () => {
    expect(formatRetroVmProgress({ loadedBytes: 1536, totalBytes: null })).toBe('1.5 KB downloaded');
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

  it('propagates supportReason into statusText for the error state', () => {
    const view = resolveRetroVmStatusView(
      'error',
      { loadedBytes: 0, totalBytes: null },
      'Tiny Core',
      'WebAssembly initialization failed.'
    );

    expect(view.chipLabel).toBe('Error');
    expect(view.chipClass).toBe('utility-status-chip--error');
    expect(view.statusText).toBe('WebAssembly initialization failed.');
    expect(view.progressText).toBe('Launch failed.');
  });

  it('propagates supportReason into statusText for the unsupported state', () => {
    const view = resolveRetroVmStatusView(
      'unsupported',
      { loadedBytes: 0, totalBytes: null },
      'Tiny Core',
      'The retro VM is desktop-first in v1. Use a keyboard-and-mouse browser window for the full experience.'
    );

    expect(view.chipLabel).toBe('Unsupported');
    expect(view.chipClass).toBe('utility-status-chip--error');
    expect(view.statusText).toMatch(/desktop-first/i);
    expect(view.progressText).toBe('Desktop browser required.');
  });

  it('keeps state unchanged on invalid transitions', () => {
    // 'enter-fullscreen' is only valid from 'running'
    expect(transitionRetroVmState('idle', 'enter-fullscreen')).toBe('idle');
    expect(transitionRetroVmState('loading', 'enter-fullscreen')).toBe('loading');
    expect(transitionRetroVmState('error', 'enter-fullscreen')).toBe('error');

    // 'exit-fullscreen' is only valid from 'fullscreen'
    expect(transitionRetroVmState('idle', 'exit-fullscreen')).toBe('idle');
    expect(transitionRetroVmState('running', 'exit-fullscreen')).toBe('running');

    // 'ready' transitions to 'running' from any state except 'unsupported'
    expect(transitionRetroVmState('idle', 'ready')).toBe('running');
    expect(transitionRetroVmState('running', 'ready')).toBe('running');

    // 'reset-complete' transitions to 'idle' from any state except 'unsupported'
    expect(transitionRetroVmState('idle', 'reset-complete')).toBe('idle');
    expect(transitionRetroVmState('running', 'reset-complete')).toBe('idle');

    // 'reset' should not affect 'idle' or 'loading' (goes to 'resetting')
    expect(transitionRetroVmState('idle', 'reset')).toBe('resetting');
    expect(transitionRetroVmState('loading', 'reset')).toBe('resetting');
  });

  it('stays in unsupported state on launch, ready, reset, and reset-complete events', () => {
    expect(transitionRetroVmState('unsupported', 'launch')).toBe('unsupported');
    expect(transitionRetroVmState('unsupported', 'ready')).toBe('unsupported');
    expect(transitionRetroVmState('unsupported', 'reset')).toBe('unsupported');
    expect(transitionRetroVmState('unsupported', 'reset-complete')).toBe('unsupported');
  });

  it('transitions to error state regardless of current state', () => {
    expect(transitionRetroVmState('idle', 'error')).toBe('error');
    expect(transitionRetroVmState('loading', 'error')).toBe('error');
    expect(transitionRetroVmState('running', 'error')).toBe('error');
    expect(transitionRetroVmState('fullscreen', 'error')).toBe('error');
    expect(transitionRetroVmState('resetting', 'error')).toBe('error');
    expect(transitionRetroVmState('error', 'error')).toBe('error');
    expect(transitionRetroVmState('unsupported', 'error')).toBe('error');
  });

  it('formats gigabyte and terabyte sizes correctly', () => {
    expect(formatRetroVmProgress({ loadedBytes: 2 * 1024 * 1024 * 1024, totalBytes: null })).toBe('2.0 GB downloaded');
    expect(formatRetroVmProgress({ loadedBytes: 1.5 * 1024 * 1024 * 1024 * 1024, totalBytes: null })).toBe('1.5 TB downloaded');
    expect(formatRetroVmProgress({ loadedBytes: 1024 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 * 1024 })).toMatch(/25% .* 1.0 GB .* 4.0 GB/);
  });
});
