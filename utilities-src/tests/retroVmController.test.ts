/**
 * @vitest-environment jsdom
 */

import { RetroVmController } from '@utilities/retroVmController';

// RetroVmController imports `v86` and `v86/build/v86.wasm?url` at the module level.
// Those imports will fail in a jsdom test environment. We mock them so the module
// loads, then rely on `window.__OD_RETRO_VM_TEST_MODE__` to get FakeRetroVm at runtime.
vi.mock('v86', () => ({ V86: class {} }));
vi.mock('v86/build/v86.wasm?url', () => ({ default: '/mock/v86.wasm' }));
vi.mock('v86/build/v86-fallback.wasm?url', () => ({ default: '/mock/v86-fallback.wasm' }));

// jsdom does not provide window.matchMedia, and detectRetroVmSupport calls
// window.matchMedia.bind in its constructor path. Mock it to always return
// a supported desktop environment so the controller can be instantiated.
vi.mock('@utilities/retroVmSupport', async () => {
  const actual = await vi.importActual<typeof import('@utilities/retroVmSupport')>('@utilities/retroVmSupport');
  return {
    ...actual,
    detectRetroVmSupport: () => ({
      supported: true,
      reason: 'Ready to launch.',
      isMobileLike: false,
      hasFullscreen: true,
      hasPointerLock: true
    })
  };
});

function buildVmDom(rootId = 'retroVmApp') {
  // Clear any leftover elements from previous tests
  document.body.innerHTML = '';

  const root = document.createElement('div');
  root.id = rootId;

  // Status elements
  const statusChip = document.createElement('span');
  statusChip.id = 'retroVmStatusChip';
  statusChip.className = 'utility-status-chip';

  const statusText = document.createElement('p');
  statusText.id = 'retroVmStatusText';

  const progressText = document.createElement('span');
  progressText.id = 'retroVmProgressText';

  const progressMeta = document.createElement('span');
  progressMeta.id = 'retroVmProgressMeta';

  const progressFill = document.createElement('div');
  progressFill.id = 'retroVmProgressFill';

  const resetBtn = document.createElement('button');
  resetBtn.id = 'retroVmResetBtn';

  const fullscreenBtn = document.createElement('button');
  fullscreenBtn.id = 'retroVmFullscreenBtn';

  const pasteBtn = document.createElement('button');
  pasteBtn.id = 'retroVmPasteBtn';

  // Screen elements
  const screenShell = document.createElement('div');
  screenShell.id = 'retroVmScreenShell';

  const screenContainer = document.createElement('div');
  screenContainer.id = 'retroVmScreen';
  screenShell.appendChild(screenContainer);

  const placeholder = document.createElement('div');
  placeholder.id = 'retroVmPlaceholder';

  const supportNote = document.createElement('p');
  supportNote.id = 'retroVmSupportNote';

  const captureBadge = document.createElement('span');
  captureBadge.id = 'retroVmCaptureBadge';

  // Config script element
  const configScript = document.createElement('script');
  configScript.id = 'retroVmConfig';
  configScript.type = 'application/json';
  configScript.textContent = '{}';

  // Assemble the DOM tree
  root.appendChild(statusChip);
  root.appendChild(statusText);
  root.appendChild(progressText);
  root.appendChild(progressMeta);
  root.appendChild(progressFill);
  root.appendChild(resetBtn);
  root.appendChild(fullscreenBtn);
  root.appendChild(pasteBtn);
  root.appendChild(screenShell);
  root.appendChild(placeholder);
  root.appendChild(supportNote);
  root.appendChild(captureBadge);

  document.body.appendChild(configScript);
  document.body.appendChild(root);

  return {
    root,
    statusChip,
    statusText,
    progressText,
    progressMeta,
    progressFill,
    resetBtn,
    fullscreenBtn,
    pasteBtn,
    screenShell,
    screenContainer,
    placeholder,
    supportNote,
    captureBadge,
  };
}

describe('RetroVmController', () => {
  beforeEach(() => {
    // Enable test mode so FakeRetroVm is used instead of real V86
    window.__OD_RETRO_VM_TEST_MODE__ = true;
  });

  afterEach(() => {
    window.__OD_RETRO_VM_TEST_MODE__ = undefined;
    document.body.innerHTML = '';
  });

  describe('init()', () => {
    it('attaches event listeners and sets screen container tabIndex', () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      expect(dom.screenContainer.tabIndex).toBe(0);
      expect(dom.root.dataset.vmSupported).toBe('true');
    });

    it('auto-boots on init and transitions to loading state', () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // init() calls launch() which sets vmState to 'loading'
      expect(dom.root.dataset.vmState).toBe('loading');
    });
  });

  describe('launch()', () => {
    it('transitions from idle to loading to running via FakeRetroVm', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // Auto-boot starts on init(); wait for running state
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('running');
      }, { timeout: 2000 });
      expect(dom.root.dataset.vmBooted).toBe('true');
    });

    it('creates exactly one canvas after boot', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      await vi.waitFor(() => {
        expect(dom.screenContainer.querySelectorAll('canvas').length).toBe(1);
      }, { timeout: 2000 });
    });

    it('does not launch twice if already launching', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // init() already triggered launch; the guard prevents a second launch
      await vi.waitFor(() => {
        expect(dom.screenContainer.querySelectorAll('canvas').length).toBe(1);
      }, { timeout: 2000 });
    });
  });

  describe('reset()', () => {
    it('transitions from running to resetting to idle', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // Wait for auto-boot to reach running state
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('running');
      }, { timeout: 2000 });

      // Now reset
      dom.resetBtn.click();
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('idle');
      }, { timeout: 2000 });

      expect(dom.root.dataset.vmBooted).toBe('false');
      expect(dom.screenContainer.innerHTML).toBe('');
    });

    it('leaves reset button disabled before emulator is ready', () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // Reset button should be disabled when there is no emulator yet
      expect(dom.resetBtn.disabled).toBe(true);
    });
  });

  describe('dispose()', () => {
    it('cleans up event listeners and destroys the session', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // Wait for auto-boot to reach running state
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('running');
      }, { timeout: 2000 });

      // Dispose
      controller.dispose();

      // Screen container should be cleaned up
      expect(dom.screenContainer.innerHTML).toBe('');
    });

    it('can be called multiple times without errors', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      controller.dispose();
      // Second dispose should not throw
      expect(() => controller.dispose()).not.toThrow();
    });

    it('can be called before boot completes without errors', () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      expect(() => controller.dispose()).not.toThrow();
    });
  });

  describe('error state transitions', () => {
    it('transitions cleanly through boot and reset without entering error state', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // Wait for auto-boot to reach running state
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('running');
      }, { timeout: 2000 });

      // Reset and verify clean transition
      dom.resetBtn.click();
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('idle');
      }, { timeout: 2000 });
    });
  });

  describe('full lifecycle', () => {
    it('boots, runs, resets, and disposes in sequence', async () => {
      const dom = buildVmDom();
      const controller = new RetroVmController(dom.root);
      controller.init();

      // Auto-boot
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('running');
      }, { timeout: 2000 });
      expect(dom.root.dataset.vmBooted).toBe('true');

      // Reset
      dom.resetBtn.click();
      await vi.waitFor(() => {
        expect(dom.root.dataset.vmState).toBe('idle');
      }, { timeout: 2000 });
      expect(dom.root.dataset.vmBooted).toBe('false');

      // Dispose
      controller.dispose();
      expect(dom.screenContainer.innerHTML).toBe('');
    });
  });
});
