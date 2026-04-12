import {
  RETRO_VM_CONFIG,
  buildRetroVmV86Options,
  isRetroVmNetworkReady,
  resolveRetroVmConfigFromDataset
} from './retroVmConfig';
import { detectRetroVmSupport, resolveRetroVmStatusView, transitionRetroVmState } from './retroVmSupport';
import type { RetroVmConfig, RetroVmDatasetConfig, RetroVmProgress, RetroVmState } from './retroVmTypes';
import type { V86, V86DownloadProgress } from 'v86';
import v86WasmUrl from 'v86/build/v86.wasm?url';
import 'v86/build/v86-fallback.wasm?url';

const FALLBACK_ISO_SIZE_BYTES = 128 * 1024 * 1024;

declare global {
  interface Window {
    __OD_RETRO_VM_TEST_MODE__?: boolean;
  }
}

interface EmulatorLike {
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
  private readonly listeners = new Map<string, Set<(value?: unknown) => void>>();
  private static readonly fakeImageSizeBytes = RETRO_VM_CONFIG.cdromSizeBytes ?? FALLBACK_ISO_SIZE_BYTES;

  constructor() {
    window.setTimeout(() => {
      this.emit('download-progress', {
        file_index: 0,
        file_count: 1,
        file_name: 'fake.iso',
        lengthComputable: true,
        total: FakeRetroVm.fakeImageSizeBytes,
        loaded: FakeRetroVm.fakeImageSizeBytes
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

class RetroVmMouseBridge {
  private readonly root: HTMLElement;
  private readonly getGuestViewport: () => { width: number; height: number; scale: number; offsetX: number; offsetY: number };
  private readonly getBus: () => RawBus | null;
  private readonly canCapture: () => boolean;
  private readonly onCaptureStateChange: (captured: boolean) => void;
  private buttons = [false, false, false];
  private pointerLocked = false;
  private readonly onMouseMove = (event: MouseEvent) => {
    this.sendAbsolutePosition(event);
  };
  private readonly onMouseDown = (event: MouseEvent) => {
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
  private readonly onPointerLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.root;
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
    this.root.addEventListener('mousemove', this.onMouseMove, { passive: false });
    this.root.addEventListener('mousedown', this.onMouseDown, { passive: false });
    window.addEventListener('mouseup', this.onMouseUp, { passive: false });
    this.root.addEventListener('wheel', this.onWheel, { passive: false });
    this.root.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('mousemove', this.onLockedMouseMove, { passive: false });
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  detach() {
    this.root.removeEventListener('mousemove', this.onMouseMove);
    this.root.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.root.removeEventListener('wheel', this.onWheel);
    this.root.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('mousemove', this.onLockedMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
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
      this.onCaptureStateChange(true);
      return;
    }

    try {
      // Pointer lock keeps relative mouse input flowing even when the host cursor
      // would have left the VM viewport.
      await this.root.requestPointerLock();
    } catch {
      // Ignore browsers that deny pointer lock; the unlocked fallback still works.
    }
  }

  async releasePointerLock() {
    if (window.__OD_RETRO_VM_TEST_MODE__) {
      this.pointerLocked = false;
      this.onCaptureStateChange(false);
      return;
    }

    if (!this.pointerLocked || document.pointerLockElement !== this.root) {
      this.pointerLocked = false;
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
  private progress: RetroVmProgress = { loadedBytes: 0, totalBytes: RETRO_VM_CONFIG.cdromSizeBytes };
  private readonly support = detectRetroVmSupport();
  private bootHintTimer = 0;
  private guestSize = { width: 640, height: 480 };
  private graphicalModeActive = false;
  private captureState: 'uncaptured' | 'captured' = 'uncaptured';
  private readonly beforeUnloadHandler = () => {
    void this.destroySession();
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
    this.syncGuestFit();
  };
  private readonly onScreenSize = (value?: unknown) => {
    const payload = Array.isArray(value) ? value : null;
    if (!payload || payload.length < 2) {
      return;
    }

    const width = typeof payload[0] === 'number' ? payload[0] : this.guestSize.width;
    const height = typeof payload[1] === 'number' ? payload[1] : this.guestSize.height;
    this.guestSize = {
      width: Math.max(1, width),
      height: Math.max(1, height)
    };
    this.syncGraphicalMode();
    this.syncGuestFit();
  };
  private readonly onDownloadProgress = (value?: unknown) => {
    const next = value as V86DownloadProgress | undefined;
    if (!next) {
      return;
    }

    this.progress = {
      loadedBytes: next.loaded,
      totalBytes: next.lengthComputable ? next.total : this.progress.totalBytes
    };
    this.syncUi();
  };
  private readonly onReady = () => {
    this.setState(transitionRetroVmState(this.state, 'ready'));
    this.placeholder.classList.add('is-hidden');
    this.root.dataset.vmBooted = 'true';
    window.clearTimeout(this.bootHintTimer);
    void this.autoAdvanceBootMenu();
    this.bootHintTimer = window.setTimeout(() => {
      if (this.state === 'running') {
        this.setVmStatusLine(
          `The guest is running locally now. ${this.config.guestName} will finish loading its desktop after the initial boot chatter.`
        );
      }
    }, this.config.bootHintDelayMs);
  };

  constructor(root: HTMLElement) {
    this.root = root;
    this.config = resolveRetroVmConfigFromDataset(root.dataset as unknown as RetroVmDatasetConfig);
    this.progress = { loadedBytes: 0, totalBytes: this.config.cdromSizeBytes };
    this.statusChip = document.getElementById('retroVmStatusChip');
    this.statusText = document.getElementById('retroVmStatusText');
    this.progressText = this.requireElement('retroVmProgressText');
    this.progressMeta = this.requireElement('retroVmProgressMeta');
    this.progressFill = document.getElementById('retroVmProgressFill');
    this.launchButton = this.requireElement('retroVmLaunchBtn');
    this.resetButton = this.requireElement('retroVmResetBtn');
    this.fullscreenButton = this.requireElement('retroVmFullscreenBtn');
    this.pasteButton = this.requireElement('retroVmPasteBtn');
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
      () => this.graphicalModeActive,
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
    window.addEventListener('resize', this.fullscreenChangeHandler);

    this.applyRuntimeLabels();
    this.screenContainer.tabIndex = 0;
    this.mouseBridge.attach();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.syncGuestFit();
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
    this.applyRuntimeLabels();
    this.supportNote.textContent = this.getDefaultSupportNote();
    this.syncUi();
  }

  private requireElement<T extends HTMLElement>(id: string) {
    const element = document.getElementById(id) as T | null;
    if (!element) {
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
    if (!this.support.supported || this.emulator) {
      return;
    }

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
    }
  }

  private async createEmulator(): Promise<EmulatorLike> {
    if (window.__OD_RETRO_VM_TEST_MODE__) {
      return new FakeRetroVm();
    }

    const { V86 } = await import('v86');
    return new V86(buildRetroVmV86Options(this.config, this.screenContainer, v86WasmUrl)) as unknown as V86;
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
    if (!this.emulator || !document.fullscreenEnabled) {
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

      await this.emulator.keyboard_send_text(text, 0);
      this.setVmStatusLine('Clipboard text was sent into the guest keyboard buffer.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Clipboard access was denied.';
      this.setVmStatusLine(`Clipboard paste failed: ${message}`);
    }
  }

  private async reset() {
    if (this.state === 'unsupported') {
      return;
    }

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
    this.screenContainer.innerHTML = '';
    this.setState(transitionRetroVmState(this.state, 'reset-complete'));
  }

  private async destroySession() {
    window.clearTimeout(this.bootHintTimer);
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
        this.dispatchEnterKey();
        window.setTimeout(() => {
          this.dispatchEnterKey();
        }, 900);
      }
    } catch {
      // Boot menu might already be gone or the guest may already be in graphics mode.
    }
  }

  private dispatchEnterKey() {
    const target = this.screenContainer;
    target.focus();
    const eventInit: KeyboardEventInit = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
  }

  private syncGraphicalMode() {
    const canvas = this.screenContainer.querySelector('canvas');
    const canvasVisible = canvas instanceof HTMLCanvasElement && getComputedStyle(canvas).display !== 'none';
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

  private getBus(): RawBus | null {
    const raw = this.emulator as unknown as { bus?: RawBus } | null;
    return raw?.bus ?? null;
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
    } catch {
      // Ignore browsers that refuse to exit fullscreen during teardown.
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
      this.supportNote.textContent = this.getDefaultSupportNote();
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
    this.launchButton.disabled = !this.support.supported || Boolean(this.emulator) || this.state === 'loading' || this.state === 'fullscreen';
    this.resetButton.disabled = !this.support.supported || (!this.emulator && this.state !== 'error');
    this.fullscreenButton.disabled = !this.emulator || !document.fullscreenEnabled;
    this.pasteButton.disabled = !this.emulator;
    this.root.dataset.vmRunning = this.emulator ? 'true' : 'false';
    this.applyInteractionStatusCopy();
  }
}
