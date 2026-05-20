import type { RetroVmEvent, RetroVmProgress, RetroVmState, RetroVmStatusView, RetroVmSupport } from './retroVmTypes';

function debugRetroVmSupport(message: string, error?: unknown) {
  if (typeof console === 'undefined' || typeof console.debug !== 'function') {
    return;
  }

  if (error === undefined) {
    console.debug(`[RetroVm] ${message}`);
    return;
  }

  console.debug(`[RetroVm] ${message}`, error);
}

function readMatchMedia(matchMediaImpl: ((query: string) => MediaQueryList) | undefined, query: string) {
  if (!matchMediaImpl) {
    return false;
  }

  try {
    return matchMediaImpl(query).matches;
  } catch (error) {
    debugRetroVmSupport(`matchMedia("${query}") failed.`, error);
    return false;
  }
}

export function detectRetroVmSupport(input: {
  hasWindow?: boolean;
  hasDocument?: boolean;
  hasWebAssembly?: boolean;
  hasWorker?: boolean;
  hasFullscreen?: boolean;
  hasPointerLock?: boolean;
  innerWidth?: number;
  maxTouchPoints?: number;
  matchMedia?: (query: string) => MediaQueryList;
} = {}): RetroVmSupport {
  const hasWindow = input.hasWindow ?? typeof window !== 'undefined';
  const hasDocument = input.hasDocument ?? typeof document !== 'undefined';
  const hasWebAssembly = input.hasWebAssembly ?? typeof WebAssembly !== 'undefined';
  const hasWorker = input.hasWorker ?? typeof Worker !== 'undefined';
  // `typeof HTMLElement` guards against SSR / non-browser environments where
  // the global is absent. In a real browser it is always defined, so this
  // effectively checks whether `requestPointerLock` exists on the prototype.
  const requestPointerLock =
    typeof HTMLElement !== 'undefined' ? HTMLElement.prototype.requestPointerLock : undefined;
  const hasFullscreen =
    input.hasFullscreen ??
    (hasDocument && typeof document.fullscreenEnabled === 'boolean' ? document.fullscreenEnabled : false);
  const hasPointerLock = input.hasPointerLock ?? typeof requestPointerLock === 'function';
  const innerWidth = input.innerWidth ?? (hasWindow ? window.innerWidth : 0);
  const hasNavigator = typeof navigator !== 'undefined';
  const maxTouchPoints = input.maxTouchPoints ?? (hasWindow && hasNavigator ? navigator.maxTouchPoints : 0);
  const matchMediaImpl = input.matchMedia ?? (hasWindow ? window.matchMedia.bind(window) : undefined);
  const coarsePointer = readMatchMedia(matchMediaImpl, '(pointer: coarse)');
  const narrowScreen = innerWidth > 0 && innerWidth < 900;
  const reducedInputDensity = coarsePointer || (maxTouchPoints > 0 && narrowScreen);
  const isMobileLike = reducedInputDensity || narrowScreen;

  if (!hasWindow || !hasDocument) {
    return {
      supported: false,
      reason: 'This VM needs a normal browser window to initialize.',
      isMobileLike: false,
      hasFullscreen: false,
      hasPointerLock: false
    };
  }

  if (!hasWebAssembly || !hasWorker) {
    return {
      supported: false,
      reason: 'Your browser is missing the WebAssembly or worker features this emulator needs.',
      isMobileLike,
      hasFullscreen,
      hasPointerLock
    };
  }

  if (isMobileLike) {
    return {
      supported: false,
      reason: 'The retro VM is desktop-first in v1. Use a keyboard-and-mouse browser window for the full experience.',
      isMobileLike: true,
      hasFullscreen,
      hasPointerLock
    };
  }

  const degradedReasons: string[] = [];
  if (!hasFullscreen) {
    degradedReasons.push('Fullscreen is unavailable, so use the embedded viewport.');
  }
  if (!hasPointerLock) {
    degradedReasons.push('Pointer lock is unavailable, so mouse capture falls back to absolute positioning.');
  }

  return {
    supported: true,
    reason: degradedReasons.length > 0 ? `Ready to launch. ${degradedReasons.join(' ')}` : 'Ready to launch.',
    isMobileLike: false,
    hasFullscreen,
    hasPointerLock
  };
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes < 1024 * 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} TB`;
}

export function formatRetroVmProgress(progress: RetroVmProgress) {
  if (progress.totalBytes && progress.totalBytes > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((progress.loadedBytes / progress.totalBytes) * 100)));
    return `${percent}% · ${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}`;
  }

  if (progress.loadedBytes > 0) {
    return `${formatBytes(progress.loadedBytes)} downloaded`;
  }

  return 'Waiting to start.';
}

function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

export function resolveRetroVmStatusView(
  state: RetroVmState,
  progress: RetroVmProgress,
  guestName = 'Guest',
  supportReason = 'Ready to launch.'
): RetroVmStatusView {
  const progressLabel = formatRetroVmProgress(progress);

  switch (state) {
    case 'idle':
      return {
        chipLabel: 'Idle',
        chipClass: 'utility-status-chip--idle',
        statusText: 'Launch a fresh local session when you are ready. Nothing persists after the tab closes.',
        progressText: progress.loadedBytes > 0 ? progressLabel : supportReason
      };
    case 'loading':
      return {
        chipLabel: 'Loading',
        chipClass: 'utility-status-chip--processing',
        statusText: 'Loading the emulator runtime and guest image on demand. The payload is deferred until launch.',
        progressText: progressLabel
      };
    case 'running':
      return {
        chipLabel: 'Running',
        chipClass: 'utility-status-chip--ready',
        statusText: `${guestName} is booting locally in your browser. Click into the screen to capture keyboard and mouse input.`,
        progressText: progress.loadedBytes > 0 ? progressLabel : 'Guest boot in progress.'
      };
    case 'fullscreen':
      return {
        chipLabel: 'Focus',
        chipClass: 'utility-status-chip--animating',
        statusText: 'Focus mode is active. Press Escape to exit fullscreen and return to the regular page layout.',
        progressText: progress.loadedBytes > 0 ? progressLabel : 'Running in fullscreen.'
      };
    case 'resetting':
      return {
        chipLabel: 'Resetting',
        chipClass: 'utility-status-chip--processing',
        statusText: 'Destroying the current guest and wiping its writable session state.',
        progressText: 'Cleaning up the current VM instance.'
      };
    case 'error':
      return {
        chipLabel: 'Error',
        chipClass: 'utility-status-chip--error',
        statusText: supportReason,
        progressText: 'Launch failed.'
      };
    case 'unsupported':
      return {
        chipLabel: 'Unsupported',
        chipClass: 'utility-status-chip--error',
        statusText: supportReason,
        progressText: 'Desktop browser required.'
      };
  }
}

export function transitionRetroVmState(current: RetroVmState, event: RetroVmEvent): RetroVmState {
  switch (event) {
    case 'unsupported':
      return 'unsupported';
    case 'launch':
      return current === 'unsupported' ? current : 'loading';
    case 'ready':
      return current === 'unsupported' ? current : 'running';
    case 'enter-fullscreen':
      return current === 'running' ? 'fullscreen' : current;
    case 'exit-fullscreen':
      return current === 'fullscreen' ? 'running' : current;
    case 'reset':
      return current === 'unsupported' ? current : 'resetting';
    case 'reset-complete':
      return current === 'unsupported' ? current : 'idle';
    case 'error':
      return 'error';
    default:
      return assertNever(event);
  }
}
