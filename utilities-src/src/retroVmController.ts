import { RETRO_VM_CONFIG } from './retroVmConfig';
import { detectRetroVmSupport, resolveRetroVmStatusView, transitionRetroVmState } from './retroVmSupport';
import type { RetroVmProgress, RetroVmState } from './retroVmTypes';
import type { V86, V86DownloadProgress } from 'v86';
import v86WasmUrl from 'v86/build/v86.wasm?url';
import 'v86/build/v86-fallback.wasm?url';

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

  constructor() {
    window.setTimeout(() => {
      this.emit('download-progress', {
        file_index: 0,
        file_count: 1,
        file_name: 'fake.iso',
        lengthComputable: true,
        total: RETRO_VM_CONFIG.cdromSizeBytes,
        loaded: RETRO_VM_CONFIG.cdromSizeBytes
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
  private buttons = [false, false, false];
  private readonly onMouseMove = (event: MouseEvent) => {
    this.sendPosition(event);
  };
  private readonly onMouseDown = (event: MouseEvent) => {
    this.sendPosition(event);
    this.updateButtons(event, true);
  };
  private readonly onMouseUp = (event: MouseEvent) => {
    this.sendPosition(event);
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

  constructor(
    root: HTMLElement,
    getGuestViewport: () => { width: number; height: number; scale: number; offsetX: number; offsetY: number },
    getBus: () => RawBus | null
  ) {
    this.root = root;
    this.getGuestViewport = getGuestViewport;
    this.getBus = getBus;
  }

  attach() {
    this.root.addEventListener('mousemove', this.onMouseMove, { passive: false });
    this.root.addEventListener('mousedown', this.onMouseDown, { passive: false });
    window.addEventListener('mouseup', this.onMouseUp, { passive: false });
    this.root.addEventListener('wheel', this.onWheel, { passive: false });
    this.root.addEventListener('contextmenu', this.onContextMenu);
  }

  detach() {
    this.root.removeEventListener('mousemove', this.onMouseMove);
    this.root.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.root.removeEventListener('wheel', this.onWheel);
    this.root.removeEventListener('contextmenu', this.onContextMenu);
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

  private sendPosition(event: MouseEvent) {
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
    const deltaX = typeof event.movementX === 'number' ? event.movementX / safeScale : 0;
    const deltaY = typeof event.movementY === 'number' ? event.movementY / safeScale : 0;

    bus.send('mouse-absolute', [clampedX, clampedY, viewport.width, viewport.height]);
    bus.send('mouse-delta', [deltaX, -deltaY]);
  }
}

export class RetroVmController {
  private readonly root: HTMLElement;
  private readonly statusChip: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly progressText: HTMLElement;
  private readonly progressMeta: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly launchButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;
  private readonly fullscreenButton: HTMLButtonElement;
  private readonly pasteButton: HTMLButtonElement;
  private readonly screenShell: HTMLElement;
  private readonly screenContainer: HTMLElement;
  private readonly placeholder: HTMLElement;
  private readonly supportNote: HTMLElement;
  private readonly assetLabel: HTMLElement;
  private readonly sessionLabel: HTMLElement;
  private readonly bridgeLabel: HTMLElement;
  private readonly mouseBridge: RetroVmMouseBridge;
  private resizeObserver: ResizeObserver | null = null;

  private emulator: EmulatorLike | null = null;
  private state: RetroVmState = 'idle';
  private progress: RetroVmProgress = { loadedBytes: 0, totalBytes: RETRO_VM_CONFIG.cdromSizeBytes };
  private readonly support = detectRetroVmSupport();
  private bootHintTimer = 0;
  private guestSize = { width: 640, height: 480 };
  private graphicalModeActive = false;
  private readonly beforeUnloadHandler = () => {
    void this.destroySession();
  };
  private readonly fullscreenChangeHandler = () => {
    if (!document.fullscreenElement && this.state === 'fullscreen') {
      this.setState(transitionRetroVmState(this.state, 'exit-fullscreen'));
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
        this.statusText.textContent = 'The guest is running locally now. Tiny Core will finish painting its desktop after the initial boot chatter.';
      }
    }, RETRO_VM_CONFIG.bootHintDelayMs);
  };

  constructor(root: HTMLElement) {
    this.root = root;
    this.statusChip = this.requireElement('retroVmStatusChip');
    this.statusText = this.requireElement('retroVmStatusText');
    this.progressText = this.requireElement('retroVmProgressText');
    this.progressMeta = this.requireElement('retroVmProgressMeta');
    this.progressFill = this.requireElement('retroVmProgressFill');
    this.launchButton = this.requireElement('retroVmLaunchBtn');
    this.resetButton = this.requireElement('retroVmResetBtn');
    this.fullscreenButton = this.requireElement('retroVmFullscreenBtn');
    this.pasteButton = this.requireElement('retroVmPasteBtn');
    this.screenShell = this.requireElement('retroVmScreenShell');
    this.screenContainer = this.requireElement('retroVmScreen');
    this.placeholder = this.requireElement('retroVmPlaceholder');
    this.supportNote = this.requireElement('retroVmSupportNote');
    this.assetLabel = this.requireElement('retroVmAssetLabel');
    this.sessionLabel = this.requireElement('retroVmSessionLabel');
    this.bridgeLabel = this.requireElement('retroVmBridgeLabel');
    this.mouseBridge = new RetroVmMouseBridge(
      this.screenContainer,
      () => this.getGuestViewport(),
      () => this.getBus()
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
    document.addEventListener('fullscreenchange', this.fullscreenChangeHandler);
    window.addEventListener('resize', this.fullscreenChangeHandler);

    this.assetLabel.textContent = `${RETRO_VM_CONFIG.distro} · ${Math.round(RETRO_VM_CONFIG.cdromSizeBytes / (1024 * 1024))} MB ISO`;
    this.sessionLabel.textContent = 'Ephemeral per tab · clean boot every launch';
    this.bridgeLabel.textContent = 'Clipboard paste only · custom trackpad-safe pointer bridge';
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
    this.supportNote.textContent = 'Desktop browser recommended. Click into the VM screen once it starts to capture input.';
    this.syncUi();
  }

  private requireElement<T extends HTMLElement>(id: string) {
    const element = document.getElementById(id) as T | null;
    if (!element) {
      throw new Error(`Missing required element: ${id}`);
    }
    return element;
  }

  private async launch() {
    if (!this.support.supported || this.emulator) {
      return;
    }

    this.root.dataset.vmBooted = 'false';
    this.root.dataset.vmGraphical = 'false';
    this.progress = { loadedBytes: 0, totalBytes: RETRO_VM_CONFIG.cdromSizeBytes };
    this.setState(transitionRetroVmState(this.state, 'launch'));

    try {
      this.emulator = await this.createEmulator();
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
    return new V86({
      screen_container: this.screenContainer,
      wasm_path: v86WasmUrl,
      bios: { url: RETRO_VM_CONFIG.biosUrl },
      vga_bios: { url: RETRO_VM_CONFIG.vgaBiosUrl },
      cdrom: { url: RETRO_VM_CONFIG.cdromUrl, size: RETRO_VM_CONFIG.cdromSizeBytes },
      autostart: true,
      memory_size: RETRO_VM_CONFIG.memorySize,
      vga_memory_size: RETRO_VM_CONFIG.vgaMemorySize,
      boot_order: RETRO_VM_CONFIG.bootOrder,
      disable_mouse: true
    }) as unknown as V86;
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
      this.setState('error', message);
    }
  }

  private async pasteClipboard() {
    if (!this.emulator) {
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        this.statusText.textContent = 'Clipboard is empty. Copy some text first, then try again.';
        return;
      }

      await this.emulator.keyboard_send_text(text, 0);
      this.statusText.textContent = 'Clipboard text was sent into the guest keyboard buffer.';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Clipboard access was denied.';
      this.statusText.textContent = `Clipboard paste failed: ${message}`;
    }
  }

  private async reset() {
    if (this.state === 'unsupported') {
      return;
    }

    this.setState(transitionRetroVmState(this.state, 'reset'));
    await this.destroySession();
    this.placeholder.classList.remove('is-hidden');
    this.progress = { loadedBytes: 0, totalBytes: RETRO_VM_CONFIG.cdromSizeBytes };
    this.root.dataset.vmBooted = 'false';
    this.root.dataset.vmGraphical = 'false';
    this.graphicalModeActive = false;
    this.screenContainer.innerHTML = '';
    this.setState(transitionRetroVmState(this.state, 'reset-complete'));
  }

  private async destroySession() {
    window.clearTimeout(this.bootHintTimer);

    if (!this.emulator) {
      return;
    }

    const active = this.emulator;
    this.emulator = null;
    this.detachListeners(active);
    await active.destroy();
  }

  private async autoAdvanceBootMenu() {
    if (!this.emulator || window.__OD_RETRO_VM_TEST_MODE__) {
      return;
    }

    try {
      const menuVisible = await this.emulator.wait_until_vga_screen_contains(/Press ENTER to boot/i, {
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

  private setState(next: RetroVmState, reason?: string) {
    this.state = next;
    this.root.dataset.vmState = next;
    if (reason && (next === 'error' || next === 'unsupported')) {
      this.supportNote.textContent = reason;
    }
    this.syncUi(reason);
  }

  private syncUi(reason?: string) {
    const view = resolveRetroVmStatusView(this.state, this.progress, reason ?? this.support.reason);
    this.statusChip.textContent = view.chipLabel;
    this.statusChip.className = `utility-status-chip ${view.chipClass}`;
    this.statusText.textContent = view.statusText;
    this.progressText.textContent = view.progressText;
    this.progressMeta.textContent = `${RETRO_VM_CONFIG.distro} · keyboard + mouse desktop utility`;
    const percent = this.progress.totalBytes && this.progress.totalBytes > 0
      ? Math.max(0, Math.min(100, (this.progress.loadedBytes / this.progress.totalBytes) * 100))
      : this.emulator
        ? 100
        : 0;
    this.progressFill.style.width = `${percent}%`;
    this.launchButton.disabled = !this.support.supported || Boolean(this.emulator) || this.state === 'loading' || this.state === 'fullscreen';
    this.resetButton.disabled = !this.support.supported || (!this.emulator && this.state !== 'error');
    this.fullscreenButton.disabled = !this.emulator || !document.fullscreenEnabled;
    this.pasteButton.disabled = !this.emulator;
    this.root.dataset.vmRunning = this.emulator ? 'true' : 'false';
  }
}
