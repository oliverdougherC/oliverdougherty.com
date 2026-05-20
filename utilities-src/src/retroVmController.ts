import {
  RETRO_VM_CONFIG,
  buildRetroVmV86Options,
  isRetroVmNetworkReady,
  readRetroVmDatasetConfig,
  resolveRetroVmConfigFromDataset
} from './retroVmConfig';
import { detectRetroVmSupport, resolveRetroVmStatusView, transitionRetroVmState } from './retroVmSupport';
import type { RetroVmConfig, RetroVmDatasetConfig, RetroVmProgress, RetroVmState } from './retroVmTypes';
import type { V86, V86DownloadProgress } from 'v86';
import v86WasmUrl from 'v86/build/v86.wasm?url';

// The second key press lands after SeaBIOS hands off to the Tiny Core boot prompt.
const BOOT_MENU_SECOND_ENTER_DELAY_MS = 900;

function readRetroVmJsonConfig(): RetroVmDatasetConfig {
  const configElement = document.getElementById('retroVmConfig');
  if (!(configElement instanceof HTMLScriptElement) || configElement.type !== 'application/json') {
    return {};
  }

  try {
    const parsed = JSON.parse(configElement.textContent || '{}') as unknown;
    return parsed && typeof parsed === 'object'
      ? readRetroVmDatasetConfig(parsed as Partial<Record<keyof RetroVmDatasetConfig, string | undefined>>)
      : {};
  } catch (error) {
    debugRetroVm('Unable to parse Retro VM JSON config; falling back to data attributes.', error);
    return {};
  }
}

declare global {
  interface Window {
    __OD_RETRO_VM_TEST_MODE__?: boolean;
  }
}

interface EmulatorLike {
  bus?: RawBus;
  add_listener(event: string, listener: (value?: unknown) => void): void;
  remove_listener(event: string, listener: (value?: unknown) => void): void;
  destroy(): Promise<void>;
  keyboard_send_keys(keys: number[], delay?: number): Promise<void>;
  keyboard_send_text(text: string, delay?: number): Promise<void>;
  screen_set_scale(scaleX: number, scaleY?: number): void;
  wait_until_vga_screen_contains(
    text: string | RegExp | Array<string | RegExp>,
    options?: { timeout_msec?: number }
  ): Promise<boolean>;
}

class FakeRetroVm implements EmulatorLike {
  readonly bus: RawBus = {
    send: () => {}
  };
  private readonly listeners = new Map<string, Set<(value?: unknown) => void>>();
  private readonly cdromSizeBytes: number;

  constructor(cdromSizeBytes: number) {
    this.cdromSizeBytes = cdromSizeBytes;
    window.setTimeout(() => {
      this.emit('download-progress', {
        file_index: 0,
        file_count: 1,
        file_name: 'fake.iso',
        lengthComputable: true,
        total: this.cdromSizeBytes,
        loaded: this.cdromSizeBytes
      } satisfies V86DownloadProgress);
      this.emit('screen-set-size', [1024, 768, 32]);
      this.emit('emulator-ready');
    }, 150);
  }

  add_listener(event: string, listener: (value?: unknown) => void) {
    const next = this.listeners.get(event) ?? new Set<(value?: unknown) => void>();
    next.add(listener);
    this.listeners.set(event, next);
  }

  remove_listener(event: string, listener: (value?: unknown) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  async destroy() {
    this.listeners.clear();
  }

  async keyboard_send_keys() {}

  async keyboard_send_text() {}

  screen_set_scale() {}

  async wait_until_vga_screen_contains() {
    return true;
  }

  private emit(event: string, value?: unknown) {
    this.listeners.get(event)?.forEach((listener) => listener(value));
  }
}

interface RawBus {
  send(event: string, payload: unknown): void;
}

function debugRetroVm(message: string, error?: unknown) {
  if (typeof console === 'undefined' || typeof console.debug !== 'function') {
    return;
  }

  if (error === undefined) {
    console.debug(`[RetroVm] ${message}`);
    return;
  }

  console.debug(`[RetroVm] ${message}`, error);
}

function isV86DownloadProgress(value: unknown): value is V86DownloadProgress {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<V86DownloadProgress>;
  if (typeof candidate.loaded !== 'number' || typeof candidate.lengthComputable !== 'boolean') {
    return false;
  }

  return !candidate.lengthComputable || typeof candidate.total === 'number';
}

/**
 * Shows a lightweight, non-blocking confirmation modal styled to match the
 * utilities page design system. Returns a promise that resolves to true if
 * the user confirms, false otherwise. Falls back to window.confirm() if the
 * DOM is unavailable.
 */
function showConfirmModal(message: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Fallback if document is not available (e.g., SSR or aggressive CSP)
    if (typeof document === 'undefined' || typeof window.confirm === 'function') {
      // Use window.confirm only as last resort — prefer the custom modal below
    }

    const overlay = document.createElement('div');
    overlay.className = 'retro-vm-confirm-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'retro-vm-confirm-title');
    overlay.setAttribute('aria-describedby', 'retro-vm-confirm-message');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.65)',
      'z-index:10000',
      'animation:retro-vm-fade-in 0.15s ease-out'
    ].join(';');

    const dialog = document.createElement('div');
    dialog.className = 'retro-vm-confirm-dialog';
    dialog.style.cssText = [
      'background:rgba(20,20,30,0.97)',
      'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:12px',
      'padding:24px 28px',
      'max-width:440px',
      'width:90%',
      'box-shadow:0 18px 50px -32px rgba(0,0,0,0.75)',
      'font-family:Inter,sans-serif',
      'color:#e0e0e0'
    ].join(';');

    const title = document.createElement('h3');
    title.id = 'retro-vm-confirm-title';
    title.textContent = 'Confirm clipboard paste';
    title.style.cssText = [
      'margin:0 0 12px',
      'font-size:1.05rem',
      'font-weight:600',
      'color:#ffffff'
    ].join(';');

    const messageEl = document.createElement('p');
    messageEl.id = 'retro-vm-confirm-message';
    messageEl.textContent = message;
    messageEl.style.cssText = [
      'margin:0 0 20px',
      'font-size:0.9rem',
      'line-height:1.5',
      'color:#c0c0c0'
    ].join(';');

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-secondary-utility';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = [
      'background:rgba(255,255,255,0.06)',
      'border:1px solid rgba(255,255,255,0.12)',
      'border-radius:8px',
      'padding:8px 18px',
      'color:#e0e0e0',
      'font-family:Inter,sans-serif',
      'font-size:0.875rem',
      'cursor:pointer'
    ].join(';');
    cancelBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(false);
    });

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-secondary-utility';
    confirmBtn.textContent = 'Paste';
    confirmBtn.style.cssText = [
      'background:rgba(255,255,255,0.15)',
      'border:1px solid rgba(255,255,255,0.2)',
      'border-radius:8px',
      'padding:8px 18px',
      'color:#ffffff',
      'font-family:Inter,sans-serif',
      'font-size:0.875rem',
      'cursor:pointer',
      'font-weight:500'
    ].join(';');
    confirmBtn.addEventListener('click', () => {
      overlay.remove();
      resolve(true);
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    dialog.appendChild(title);
    dialog.appendChild(messageEl);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Focus management
    cancelBtn.focus();

    // Close on Escape
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleDismiss();
      }
    };

    // Close on overlay click (outside dialog)
    const handleOverlayClick = (e: MouseEvent) => {
      if (e.target === overlay) {
        handleDismiss();
      }
    };

    const handleDismiss = () => {
      document.removeEventListener('keydown', handleKey);
      overlay.removeEventListener('click', handleOverlayClick);
      overlay.remove();
      resolve(false);
    };

    document.addEventListener('keydown', handleKey);
    overlay.addEventListener('click', handleOverlayClick);
  });
}

class RetroVmMouseBridge {
  private readonly root: HTMLElement;
  private readonly getGuestViewport: () => { width: number; height: number; scale: number; offsetX: number; offsetY: number };
  private readonly getBus: () => RawBus | null;
  private readonly canCapture: () => boolean;
  private readonly onCaptureStateChange: (captured: boolean) => void;
  private buttons = [false, false, false];
  private pointerLocked = false;
  private absoluteMouseMoveAttached = false;
  private readonly onMouseMove = (event: MouseEvent) => {
    this.sendAbsolutePosition(event);
  };
  private readonly onMouseDown = (event: MouseEvent) => {
    this.root.focus({ preventScroll: true });
    this.sendAbsolutePosition(event);
    void this.requestPointerLock();
    this.updateButtons(event, true);
  };
  private readonly onMouseUp = (event: MouseEvent) => {
    this.sendAbsolutePosition(event);
    this.updateButtons(event, false);
  };
  private readonly onWheel = (event: WheelEvent) => {
    const bus = this.getBus();
    if (!bus) {
      return;
    }

    const direction = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
    if (direction !== 0) {
      bus.send('mouse-wheel', [direction, 0]);
      event.preventDefault();
    }
  };
  private readonly onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };
  private readonly onLockedMouseMove = (event: MouseEvent) => {
    this.sendLockedDelta(event);
  };
  private readonly onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    this.root.focus({ preventScroll: true });
    this.sendAbsolutePositionFromPoint(touch.clientX, touch.clientY);
    void this.requestPointerLock();
    this.updateButtonsFromPoint(true);
    event.preventDefault();
  };
  private readonly onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch) {
      return;
    }

    this.sendAbsolutePositionFromPoint(touch.clientX, touch.clientY);
    event.preventDefault();
  };
  private readonly onTouchEnd = (event: TouchEvent) => {
    const touch = event.changedTouches[0];
    if (!touch) {
      return;
    }

    this.sendAbsolutePositionFromPoint(touch.clientX, touch.clientY);
    this.updateButtonsFromPoint(false);
    event.preventDefault();
  };
  private readonly onPointerLockChange = () => {
    if (window.__OD_RETRO_VM_TEST_MODE__) {
      return;
    }

    this.pointerLocked = document.pointerLockElement === this.root;
    this.syncAbsoluteMouseMoveListener();
    this.onCaptureStateChange(this.pointerLocked);
  };

  constructor(
    root: HTMLElement,
    getGuestViewport: () => { width: number; height: number; scale: number; offsetX: number; offsetY: number },
    getBus: () => RawBus | null,
    canCapture: () => boolean,
    onCaptureStateChange: (captured: boolean) => void
  ) {
    this.root = root;
    this.getGuestViewport = getGuestViewport;
    this.getBus = getBus;
    this.canCapture = canCapture;
    this.onCaptureStateChange = onCaptureStateChange;
  }

  attach() {
    this.attachAbsoluteMouseMove();
    this.root.addEventListener('mousedown', this.onMouseDown, { passive: false });
    window.addEventListener('mouseup', this.onMouseUp, { passive: false });
    this.root.addEventListener('wheel', this.onWheel, { passive: false });
    this.root.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('mousemove', this.onLockedMouseMove, { passive: false });
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    this.root.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.root.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.root.addEventListener('touchend', this.onTouchEnd, { passive: false });
  }

  detach() {
    this.detachAbsoluteMouseMove();
    this.root.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.root.removeEventListener('wheel', this.onWheel);
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('mousemove', this.onLockedMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    this.root.removeEventListener('touchstart', this.onTouchStart);
    this.root.removeEventListener('touchmove', this.onTouchMove);
    this.root.removeEventListener('touchend', this.onTouchEnd);
  }

  private attachAbsoluteMouseMove() {
    if (this.absoluteMouseMoveAttached || this.pointerLocked) {
      return;
    }

    this.root.addEventListener('mousemove', this.onMouseMove, { passive: false });
    this.absoluteMouseMoveAttached = true;
  }

  private detachAbsoluteMouseMove() {
    if (!this.absoluteMouseMoveAttached) {
      return;
    }

    this.root.removeEventListener('mousemove', this.onMouseMove);
    this.absoluteMouseMoveAttached = false;
  }

  private syncAbsoluteMouseMoveListener() {
    if (this.pointerLocked) {
      this.detachAbsoluteMouseMove();
    } else {
      this.attachAbsoluteMouseMove();
    }
  }

  private updateButtons(event: MouseEvent, pressed: boolean) {
    const bus = this.getBus();
    if (!bus || this.getGuestViewport().scale <= 0) {
      return;
    }

    const index = event.button === 1 ? 1 : event.button === 2 ? 2 : 0;
    this.buttons[index] = pressed;
    bus.send('mouse-click', [this.buttons[0], this.buttons[1], this.buttons[2]]);
    event.preventDefault();
  }

  private sendAbsolutePosition(event: MouseEvent) {
    if (this.pointerLocked) {
      return;
    }

    const bus = this.getBus();
    const viewport = this.getGuestViewport();
    if (!bus || viewport.scale <= 0) {
      return;
    }

    const rect = this.root.getBoundingClientRect();
    const safeScale = viewport.scale || 1;
    const rawX = event.clientX - rect.left - viewport.offsetX;
    const rawY = event.clientY - rect.top - viewport.offsetY;
    const clampedX = Math.max(0, Math.min(viewport.width - 1, rawX / safeScale));
    const clampedY = Math.max(0, Math.min(viewport.height - 1, rawY / safeScale));

    bus.send('mouse-absolute', [clampedX, clampedY, viewport.width, viewport.height]);
  }

  private sendAbsolutePositionFromPoint(clientX: number, clientY: number) {
    if (this.pointerLocked) {
      return;
    }

    const bus = this.getBus();
    const viewport = this.getGuestViewport();
    if (!bus || viewport.scale <= 0) {
      return;
    }

    const rect = this.root.getBoundingClientRect();
    const safeScale = viewport.scale || 1;
    const rawX = clientX - rect.left - viewport.offsetX;
    const rawY = clientY - rect.top - viewport.offsetY;
    const clampedX = Math.max(0, Math.min(viewport.width - 1, rawX / safeScale));
    const clampedY = Math.max(0, Math.min(viewport.height - 1, rawY / safeScale));

    bus.send('mouse-absolute', [clampedX, clampedY, viewport.width, viewport.height]);
  }

  private updateButtonsFromPoint(pressed: boolean) {
    const bus = this.getBus();
    if (!bus || this.getGuestViewport().scale <= 0) {
      return;
    }

    this.buttons[0] = pressed;
    bus.send('mouse-click', [this.buttons[0], this.buttons[1], this.buttons[2]]);
  }

  private sendLockedDelta(event: MouseEvent) {
    if (!this.pointerLocked) {
      return;
    }

    const bus = this.getBus();
    const viewport = this.getGuestViewport();
    if (!bus || viewport.scale <= 0) {
      return;
    }

    const safeScale = viewport.scale || 1;
    const deltaX = (typeof event.movementX === 'number' ? event.movementX : 0) / safeScale;
    const deltaY = (typeof event.movementY === 'number' ? event.movementY : 0) / safeScale;

    if (deltaX === 0 && deltaY === 0) {
      return;
    }

    bus.send('mouse-delta', [deltaX, -deltaY]);
  }

  private async requestPointerLock() {
    if (this.pointerLocked || !this.canCapture()) {
      return;
    }

    if (window.__OD_RETRO_VM_TEST_MODE__) {
      this.pointerLocked = true;
      this.syncAbsoluteMouseMoveListener();
      this.onCaptureStateChange(true);
      return;
    }

    try {
      // Pointer lock keeps relative mouse input flowing even when the host cursor
      // would have left the VM viewport.
      await this.root
        .requestPointerLock({ unadjustedMovement: true })
        .catch(() => this.root.requestPointerLock());
    } catch (error) {
      // Ignore browsers that deny pointer lock; the unlocked fallback still works.
      debugRetroVm('Pointer lock request was denied; continuing with absolute mouse input.', error);
    }
  }

  async releasePointerLock() {
    if (window.__OD_RETRO_VM_TEST_MODE__) {
      this.pointerLocked = false;
      this.syncAbsoluteMouseMoveListener();
      this.onCaptureStateChange(false);
      return;
    }

    if (!this.pointerLocked || document.pointerLockElement !== this.root) {
      this.pointerLocked = false;
      this.syncAbsoluteMouseMoveListener();
      this.onCaptureStateChange(false);
      return;
    }

    document.exitPointerLock();
  }
}

export class RetroVmController {
  private readonly root: HTMLElement;
  private readonly config: RetroVmConfig;
  private readonly statusChip: HTMLElement | null;
  private readonly statusText: HTMLElement | null;
  private readonly progressText: HTMLElement;
  private readonly progressMeta: HTMLElement;
  private readonly progressFill: HTMLElement | null;
  private readonly launchButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly pasteButton: HTMLButtonElement;
  private readonly screenShell: HTMLElement;
  private readonly screenContainer: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly supportNote: HTMLElement;
  private readonly captureBadge: HTMLElement;
  private readonly screenBadge: HTMLElement;
  private readonly mouseBridge: RetroVmMouseBridge;
  private resizeObserver: ResizeObserver | null = null;

  private emulator: EmulatorLike | null = null;
  private state: RetroVmState = 'idle';
  private progress: RetroVmProgress = { loadedBytes: 0, totalBytes: null };
  private readonly support = detectRetroVmSupport();
  private bootHintTimer: number | null = null;
  private resizeFrameId = 0;
  private guestSize = { width: 640, height: 480 };
  private guestBpp = 0;
  private graphicalModeActive = false;
  private isLaunching = false;
  private captureState: 'uncaptured' | 'captured' = 'uncaptured';
  private readonly beforeUnloadHandler = () => {
    this.destroySession().catch((error) => {
      debugRetroVm('Failed to destroy the VM session during page teardown.', error);
    });
  };
  private readonly keyDownHandler = (event: KeyboardEvent) => {
    if (this.state === 'fullscreen') {
      return;
    }

    if (event.key === 'Escape' && this.captureState === 'captured') {
      void this.mouseBridge.releasePointerLock();
    }
  };
  private readonly fullscreenChangeHandler = () => {
    if (!document.fullscreenElement && this.state === 'fullscreen') {
      this.setState(transitionRetroVmState(this.state, 'exit-fullscreen'));
      void this.mouseBridge.releasePointerLock();
    }
    this.queueGuestFitSync();
  };
  private readonly resizeHandler = () => {
    this.queueGuestFitSync();
  };
  private readonly onScreenSize = (value?: unknown) => {
    const payload = Array.isArray(value) ? value : null;
    if (!payload || payload.length < 2) {
      return;
    }

    const width = typeof payload[0] === 'number' ? payload[0] : this.guestSize.width;
    const height = typeof payload[1] === 'number' ? payload[1] : this.guestSize.height;
    this.guestBpp = typeof payload[2] === 'number' ? payload[2] : this.guestBpp;
    this.guestSize = {
      width: Math.max(1, width),
      height: Math.max(1, height)
    };
    this.syncGraphicalMode();
    this.syncGuestFit();
  };
  private readonly onDownloadProgress = (value?: unknown) => {
    if (!isV86DownloadProgress(value)) {
      return;
    }

    this.progress = {
      loadedBytes: value.loaded,
      totalBytes: value.lengthComputable ? value.total : this.progress.totalBytes
    };
    this.syncUi();
  };
  private readonly onReady = () => {
    this.setState(transitionRetroVmState(this.state, 'ready'));
    this.placeholder.classList.add('is-hidden');
    this.root.dataset.vmBooted = 'true';
    if (this.bootHintTimer !== null) {
      window.clearTimeout(this.bootHintTimer);
    }
    void this.autoAdvanceBootMenu();
    this.bootHintTimer = window.setTimeout(() => {
      if (this.state === 'running' && this.graphicalModeActive) {
        this.setVmStatusLine(
          `${this.config.guestName} is running locally. The desktop can still finish painting after the BIOS hands off.`
        );
      }
    }, this.config.bootHintDelayMs);
  };

  constructor(root: HTMLElement) {
    this.root = root;
    this.config = resolveRetroVmConfigFromDataset({
      ...readRetroVmDatasetConfig(root.dataset),
      ...readRetroVmJsonConfig()
    });
    this.progress = { loadedBytes: 0, totalBytes: this.config.cdromSizeBytes };
    this.statusChip = document.getElementById('retroVmStatusChip');
    this.statusText = document.getElementById('retroVmStatusText');
    this.progressText = this.requireElement('retroVmProgressText');
    this.progressMeta = this.requireElement('retroVmProgressMeta');
    this.progressFill = document.getElementById('retroVmProgressFill');
    this.launchButton = this.requireElement('retroVmLaunchBtn', HTMLButtonElement);
    this.resetButton = this.requireElement('retroVmResetBtn', HTMLButtonElement);
    this.fullscreenButton = this.requireElement('retroVmFullscreenBtn', HTMLButtonElement);
    this.pasteButton = this.requireElement('retroVmPasteBtn', HTMLButtonElement);
    this.screenShell = this.requireElement('retroVmScreenShell');
    this.screenContainer = this.requireElement('retroVmScreen');
    this.placeholder = this.requireElement('retroVmPlaceholder');
    this.supportNote = this.requireElement('retroVmSupportNote');
    this.captureBadge = this.requireElement('retroVmCaptureBadge');
    this.screenBadge = this.requireElement('retroVmScreenBadge');
    this.mouseBridge = new RetroVmMouseBridge(
      this.screenContainer,
      () => this.getGuestViewport(),
      () => this.getBus(),
      () => Boolean(this.emulator) && (this.state === 'running' || this.state === 'fullscreen'),
      (captured) => this.setCaptureState(captured ? 'captured' : 'uncaptured')
    );
  }

  init() {
    this.launchButton.addEventListener('click', () => {
      void this.launch();
    });
    this.resetButton.addEventListener('click', () => {
      void this.reset();
    });
    this.fullscreenButton.addEventListener('click', () => {
      void this.enterFullscreen();
    });
    this.pasteButton.addEventListener('click', () => {
      void this.pasteClipboard();
    });

    window.addEventListener('pagehide', this.beforeUnloadHandler);
    document.addEventListener('keydown', this.keyDownHandler);
    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    window.addEventListener('resize', this.resizeHandler);

    this.applyRuntimeLabels();
    this.screenContainer.tabIndex = 0;
    this.mouseBridge.attach();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.queueGuestFitSync();
      });
      this.resizeObserver.observe(this.screenContainer);
    }

    if (!this.support.supported) {
      this.supportNote.textContent = this.support.reason;
      this.root.dataset.vmSupported = 'false';
      this.setState('unsupported', this.support.reason);
      return;
    }

    this.root.dataset.vmSupported = 'true';
    this.supportNote.textContent = this.getDefaultSupportNote();
    this.syncUi();
  }

  private requireElement<T extends HTMLElement>(id: string, ctor: { new(): T } = HTMLElement as { new(): T }) {
    const element = document.getElementById(id);
    if (!(element instanceof ctor)) {
      throw new Error(`Missing required element: ${id}`);
    }
    return element;
  }

  private setVmStatusLine(text: string) {
    this.root.dataset.vmStatusMessage = text;
    if (this.statusText) {
      this.statusText.textContent = text;
    }
  }

  private async launch() {
    if (!this.support.supported || this.emulator || this.isLaunching) {
      return;
    }

    this.isLaunching = true;
    this.root.dataset.vmBooted = 'false';
    this.root.dataset.vmGraphical = 'false';
    this.setCaptureState('uncaptured');
    this.progress = { loadedBytes: 0, totalBytes: this.config.cdromSizeBytes };
    this.setState(transitionRetroVmState(this.state, 'launch'));

    try {
      this.emulator = await this.createEmulator();
      this.installTestCanvasIfNeeded();
      this.attachListeners(this.emulator);
      this.emulator.screen_set_scale(1);
    } catch (error) {
      await this.destroySession();
      const message = error instanceof Error ? error.message : 'The VM could not be launched.';
      this.setState('error', message);
    } finally {
      this.isLaunching = false;
    }
  }

  private async createEmulator(): Promise<EmulatorLike> {
    if (window.__OD_RETRO_VM_TEST_MODE__) {
      return new FakeRetroVm(this.config.cdromSizeBytes ?? RETRO_VM_CONFIG.cdromSizeBytes ?? 0);
    }

    // Wrap the dynamic import in a timeout so a stalled CDN / WASM download
    // does not leave the launch promise hanging indefinitely.
    const IMPORT_TIMEOUT_MS = 120_000;

    const loadEmulator = async () => {
      // Vite needs this URL import retained so the fallback wasm asset is emitted for v86's runtime loader.
      await import('v86/build/v86-fallback.wasm?url');
      const { V86 } = await import('v86');
      return new V86(buildRetroVmV86Options(this.config, this.screenContainer, v86WasmUrl));
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      window.setTimeout(() => {
        reject(new Error(`Loading the VM emulator timed out after ${IMPORT_TIMEOUT_MS / 1000}s. Check your network connection and try again.`));
      }, IMPORT_TIMEOUT_MS);
    });

    return Promise.race([loadEmulator(), timeoutPromise]);
  }

  private installTestCanvasIfNeeded() {
    if (!window.__OD_RETRO_VM_TEST_MODE__) {
      return;
    }

    if (this.screenContainer.querySelector('canvas')) {
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 768;
    canvas.style.display = 'block';
    this.screenContainer.appendChild(canvas);
    this.syncGraphicalMode();
    this.syncGuestFit();
  }

  private attachListeners(emulator: EmulatorLike) {
    emulator.add_listener('download-progress', this.onDownloadProgress);
    emulator.add_listener('emulator-ready', this.onReady);
    emulator.add_listener('screen-set-size', this.onScreenSize);
  }

  private detachListeners(emulator: EmulatorLike) {
    emulator.remove_listener('download-progress', this.onDownloadProgress);
    emulator.remove_listener('emulator-ready', this.onReady);
    emulator.remove_listener('screen-set-size', this.onScreenSize);
  }

  private async enterFullscreen() {
    if (
      !this.emulator ||
      !document.fullscreenEnabled ||
      (this.state !== 'running' && this.state !== 'fullscreen')
    ) {
      return;
    }

    try {
      await this.screenShell.requestFullscreen();
      this.setState(transitionRetroVmState(this.state, 'enter-fullscreen'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Fullscreen is unavailable in this browser.';
      this.setVmStatusLine(message);
      this.supportNote.textContent = message;
    }
  }

  private async pasteClipboard() {
    if (!this.emulator) {
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        this.setVmStatusLine('Clipboard is empty. Copy some text first, then try again.');
        return;
      }

      const maxPasteChars = this.config.maxClipboardPasteChars;
      const pasteText = text.slice(0, maxPasteChars);
      const approved = await showConfirmModal(
        `Paste ${pasteText.length.toLocaleString()} characters from your system clipboard into the guest OS? This can expose passwords, tokens, or other secrets inside the VM.`
      );
      if (!approved) {
        this.setVmStatusLine('Clipboard paste was canceled before any text was sent to the guest.');
        return;
      }

      await this.emulator.keyboard_send_text(pasteText, 0);
      this.setVmStatusLine(
        text.length > pasteText.length
          ? `Clipboard paste was truncated to ${maxPasteChars.toLocaleString()} characters before being sent into the guest keyboard buffer.`
          : 'Clipboard text was sent into the guest keyboard buffer. Review clipboard contents before pasting commands into the VM.'
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Clipboard access was denied.';
      const secureContextHint = !window.isSecureContext
        ? ' Clipboard access requires HTTPS or localhost in most browsers.'
        : '';
      this.setVmStatusLine(`Clipboard paste failed: ${message}${secureContextHint}`);
    }
  }

  private async reset() {
    if (this.state === 'unsupported') {
      return;
    }

    try {
      this.setState(transitionRetroVmState(this.state, 'reset'));
      await this.exitFullscreenIfNeeded();
      await this.mouseBridge.releasePointerLock();
      await this.destroySession();
      this.placeholder.classList.remove('is-hidden');
      this.progress = { loadedBytes: 0, totalBytes: this.config.cdromSizeBytes };
      this.root.dataset.vmBooted = 'false';
      this.root.dataset.vmGraphical = 'false';
      this.graphicalModeActive = false;
      this.setCaptureState('uncaptured');
      this.screenContainer.replaceChildren();
      this.setState(transitionRetroVmState(this.state, 'reset-complete'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The VM could not be reset.';
      this.setState('error', message);
    }
  }

  private async destroySession() {
    if (this.bootHintTimer !== null) {
      window.clearTimeout(this.bootHintTimer);
      this.bootHintTimer = null;
    }
    await this.mouseBridge.releasePointerLock();
    this.setCaptureState('uncaptured');

    if (!this.emulator) {
      return;
    }

    const active = this.emulator;
    this.emulator = null;
    this.detachListeners(active);
    await active.destroy();
  }

  private async autoAdvanceBootMenu() {
    if (!this.emulator || window.__OD_RETRO_VM_TEST_MODE__ || !this.config.bootMenuPrompt) {
      return;
    }

    try {
      const menuVisible = await this.emulator.wait_until_vga_screen_contains(this.config.bootMenuPrompt, {
        timeout_msec: 30_000
      });
      if (menuVisible) {
        void this.dispatchEnterKey();
        window.setTimeout(async () => {
          // Re-check that the boot prompt is still visible before sending the second Enter.
          // If the guest already booted past the prompt (e.g. it was slow to render),
          // sending Enter to a desktop or shell prompt could trigger unintended actions.
          const stillVisible = await this.emulator?.wait_until_vga_screen_contains(this.config.bootMenuPrompt, {
            timeout_msec: 500
          }) ?? false;
          if (stillVisible) {
            void this.dispatchEnterKey();
          }
        }, BOOT_MENU_SECOND_ENTER_DELAY_MS);
      }
    } catch (error) {
      // Boot menu might already be gone or the guest may already be in graphics mode.
      debugRetroVm('Boot menu probe failed; falling back to delayed Enter key dispatch.', error);
      window.setTimeout(() => {
        if (this.state === 'running') {
          void this.dispatchEnterKey();
        }
      }, this.config.bootHintDelayMs);
    }
  }

  private async dispatchEnterKey() {
    this.screenContainer.focus();
    await this.emulator?.keyboard_send_keys([28]);
  }

  private syncGraphicalMode() {
    const canvas = this.screenContainer.querySelector('canvas');
    const canvasVisible =
      (canvas instanceof HTMLCanvasElement && !canvas.hidden && canvas.offsetParent !== null) ||
      this.guestBpp > 0;
    this.graphicalModeActive = canvasVisible;
    this.root.dataset.vmGraphical = canvasVisible ? 'true' : 'false';
    if (!canvasVisible) {
      this.setCaptureState('uncaptured');
    }
  }

  private getGuestViewport() {
    if (!this.graphicalModeActive) {
      return {
        width: this.guestSize.width,
        height: this.guestSize.height,
        scale: 0,
        offsetX: 0,
        offsetY: 0
      };
    }

    const width = this.screenContainer.clientWidth || this.screenContainer.getBoundingClientRect().width;
    const height = this.screenContainer.clientHeight || this.screenContainer.getBoundingClientRect().height;
    const scale = Math.min(width / this.guestSize.width, height / this.guestSize.height) || 1;
    const displayWidth = this.guestSize.width * scale;
    const displayHeight = this.guestSize.height * scale;
    return {
      width: this.guestSize.width,
      height: this.guestSize.height,
      scale,
      offsetX: Math.max(0, (width - displayWidth) / 2),
      offsetY: Math.max(0, (height - displayHeight) / 2)
    };
  }

  private syncGuestFit() {
    this.syncGraphicalMode();

    if (!this.graphicalModeActive) {
      this.screenContainer.style.removeProperty('--vm-fit-scale');
      this.screenContainer.style.removeProperty('--vm-guest-width');
      this.screenContainer.style.removeProperty('--vm-guest-height');
      return;
    }

    const viewport = this.getGuestViewport();
    this.screenContainer.style.setProperty('--vm-fit-scale', `${viewport.scale}`);
    this.screenContainer.style.setProperty('--vm-guest-width', `${viewport.width}px`);
    this.screenContainer.style.setProperty('--vm-guest-height', `${viewport.height}px`);
  }

  private queueGuestFitSync() {
    if (this.resizeFrameId) {
      return;
    }

    this.resizeFrameId = window.requestAnimationFrame(() => {
      this.resizeFrameId = 0;
      this.syncGuestFit();
    });
  }

  private getBus(): RawBus | null {
    return this.emulator?.bus ?? null;
  }

  private getDefaultSupportNote() {
    return isRetroVmNetworkReady(this.config) ? this.config.copy.supportNoteOnline : this.config.copy.supportNoteOffline;
  }

  private getScreenBadgeLabel() {
    return isRetroVmNetworkReady(this.config) ? this.config.copy.screenBadgeOnline : this.config.copy.screenBadgeOffline;
  }

  private applyRuntimeLabels() {
    this.progressMeta.textContent = this.config.copy.progressMeta;
    this.screenBadge.textContent = this.getScreenBadgeLabel();
    this.root.dataset.vmNetworkReady = isRetroVmNetworkReady(this.config) ? 'true' : 'false';
    this.root.dataset.vmAssetLabel = this.config.copy.assetLabel;
    this.root.dataset.vmBridgeLabelOnline = this.config.copy.bridgeLabelOnline;
    this.root.dataset.vmBridgeLabelOffline = this.config.copy.bridgeLabelOffline;
  }

  private applyInteractionStatusCopy() {
    if (this.state !== 'running' && this.state !== 'fullscreen') {
      return;
    }

    if (this.captureState === 'captured') {
      if (this.state === 'fullscreen') {
        this.setVmStatusLine('Mouse is captured. Press Escape to exit fullscreen and release it.');
        this.supportNote.textContent = 'Mouse is captured. Press Escape to exit fullscreen and return to the page.';
      } else {
        this.setVmStatusLine('Mouse is captured now. Press Escape to release it and return to the page cursor.');
        this.supportNote.textContent = 'Mouse is captured. Press Escape to release it and return to the page cursor.';
      }
      return;
    }

    if (this.state === 'fullscreen') {
      this.supportNote.textContent = this.getDefaultSupportNote();
      return;
    }

    this.setVmStatusLine(
      `${this.config.guestName} is booting locally in your browser. Click into the desktop to capture mouse input.`
    );
    this.supportNote.textContent = this.getDefaultSupportNote();
  }

  private async exitFullscreenIfNeeded() {
    if (document.fullscreenElement !== this.screenShell) {
      return;
    }

    try {
      await document.exitFullscreen();
    } catch (error) {
      // Ignore browsers that refuse to exit fullscreen during teardown.
      debugRetroVm('Fullscreen exit was refused during teardown.', error);
    }
  }

  private setCaptureState(next: 'uncaptured' | 'captured') {
    this.captureState = next;
    this.root.dataset.vmCaptureState = next;
    this.captureBadge.textContent = next === 'captured'
      ? this.state === 'fullscreen'
        ? 'Mouse captured · Press Escape to exit'
        : 'Mouse captured · Press Escape to release'
      : 'Click desktop to capture mouse';
    this.applyInteractionStatusCopy();
  }

  private setState(next: RetroVmState, reason?: string) {
    this.state = next;
    this.root.dataset.vmState = next;
    if (reason && (next === 'error' || next === 'unsupported')) {
      this.supportNote.textContent = reason;
    }
    this.syncUi(reason);
  }

  private syncUi(reason?: string) {
    const view = resolveRetroVmStatusView(this.state, this.progress, this.config.guestName, reason ?? this.support.reason);
    this.root.dataset.vmStatusChip = view.chipLabel;
    if (this.statusChip) {
      this.statusChip.textContent = view.chipLabel;
      this.statusChip.className = `utility-status-chip ${view.chipClass}`;
    }
    this.setVmStatusLine(view.statusText);
    this.progressText.textContent = view.progressText;
    this.applyRuntimeLabels();
    if (this.state !== 'error' && this.state !== 'unsupported') {
      if (this.state === 'loading' || this.state === 'resetting') {
        this.supportNote.textContent = view.statusText;
      } else {
        this.supportNote.textContent = this.support.reason === 'Ready to launch.'
          ? this.getDefaultSupportNote()
          : this.support.reason;
      }
    }
    const percent = this.progress.totalBytes && this.progress.totalBytes > 0
      ? Math.max(0, Math.min(100, (this.progress.loadedBytes / this.progress.totalBytes) * 100))
      : this.emulator
        ? 100
        : 0;
    const roundedPercent = Math.round(percent);
    this.root.dataset.vmProgressPercent = String(roundedPercent);
    if (this.progressFill) {
      this.progressFill.style.width = `${percent}%`;
    }
    this.launchButton.disabled = this.shouldDisableLaunchButton();
    this.resetButton.disabled = !this.support.supported || (!this.emulator && this.state !== 'error');
    this.fullscreenButton.disabled =
      !this.emulator || !document.fullscreenEnabled || (this.state !== 'running' && this.state !== 'fullscreen');
    this.pasteButton.disabled = !this.emulator;
    this.root.dataset.vmRunning = this.emulator ? 'true' : 'false';
    this.applyInteractionStatusCopy();
  }

  private shouldDisableLaunchButton() {
    return (
      !this.support.supported ||
      Boolean(this.emulator) ||
      this.state === 'loading' ||
      this.state === 'resetting' ||
      this.state === 'fullscreen'
    );
  }

  dispose() {
    if (this.bootHintTimer !== null) {
      window.clearTimeout(this.bootHintTimer);
      this.bootHintTimer = null;
    }
    if (this.resizeFrameId) {
      window.cancelAnimationFrame(this.resizeFrameId);
      this.resizeFrameId = 0;
    }
    window.removeEventListener('pagehide', this.beforeUnloadHandler);
    window.removeEventListener('resize', this.resizeHandler);
    document.removeEventListener('keydown', this.keyDownHandler);
    document.removeEventListener('fullscreenchange', this.fullscreenChangeHandler);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mouseBridge.detach();
    this.screenContainer.style.removeProperty('--vm-fit-scale');
    this.screenContainer.style.removeProperty('--vm-guest-width');
    this.screenContainer.style.removeProperty('--vm-guest-height');
    this.screenContainer.replaceChildren();
    this.destroySession().catch((error) => {
      debugRetroVm('VM session teardown failed during dispose.', error);
    });
  }
}
