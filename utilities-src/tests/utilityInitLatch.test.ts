import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Issue #42 review blocker: a constructor/init exception is announced as
// reload-only because partial listeners may exist, but Index → reopen and
// switch away/back re-entered ensureUtility and constructed again. These tests
// run the real shell against the real entry with an injected failing
// controller and pin the single-construction latch.

const shell = readFileSync(new URL('../../js/utilities-shell.js', import.meta.url), 'utf8');

interface Harness {
  window: JSDOM['window'];
  query: <T extends HTMLElement = HTMLElement>(selector: string) => T;
  stressConstructs: () => number;
  audioConstructs: () => number;
  stageState: (id: string) => {
    ready: string;
    statusText: string;
    statusRole: string;
    retryMode: string;
    buttonText: string;
    inert: boolean;
  };
  navigate: (id: string | null) => void;
  close: () => Promise<void>;
}

async function setup(options: {
  hash?: string;
  stressGate?: Promise<unknown>;
  stressThrows?: boolean;
  initTimeoutMs?: number;
}): Promise<Harness> {
  vi.resetModules();
  const dom = new JSDOM(`<!doctype html><title>Utilities — Oliver Dougherty</title>
    <main id="utilitiesTitleView" class="utilities-view--active">
      <h1 class="utilities-title">Utilities</h1>
      <div class="utilities-buttons">
        <button data-utility="image-transform">Image Transform</button>
        <button data-utility="audio-fourier">Fourier Reconstruction</button>
        <button data-utility="stress-test">Stress Test</button>
      </div>
    </main>
    <main id="utilitiesUtilityView" hidden>
      <button class="nav-back-btn">Index</button>
      <span id="utilityNumber"></span><h1 id="utilityTitle" tabindex="-1"></h1>
      <select id="utilitySwitcher">
        <option value="image-transform">Image Transform</option>
        <option value="audio-fourier">Fourier Reconstruction</option>
        <option value="stress-test">Stress Test</option>
      </select>
      <section class="utility-stage" data-utility-id="image-transform" data-utility-title="Image Transform"
        data-utility-number="01" hidden><section id="utilitiesApp" data-utility-root="image-transform"></section></section>
      <section class="utility-stage" data-utility-id="audio-fourier" data-utility-title="Fourier Reconstruction"
        data-utility-number="02" hidden><section id="audioFourierApp" data-utility-root="audio-fourier"></section></section>
      <section class="utility-stage" data-utility-id="stress-test" data-utility-title="Stress Test"
        data-utility-number="03" hidden><section id="stressTestApp" data-utility-root="stress-test"></section></section>
    </main>`, {
    url: `https://example.com/utilities/${options.hash ?? '#stress-test'}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const scope = window as unknown as Record<string, unknown>;
  scope.__stressConstructs = 0;
  scope.__audioConstructs = 0;
  scope.__OD_UTILITIES_INIT_TIMEOUT_MS = options.initTimeoutMs ?? 0;
  window.scrollTo = vi.fn();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  vi.stubGlobal('Event', window.Event);
  // main.ts guards listeners with `event.target instanceof Element`; the
  // node-realm global must be the jsdom class or cross-realm checks throw.
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('HTMLElement', window.HTMLElement);

  vi.doMock('../src/stressTestController', async () => {
    await (options.stressGate ?? Promise.resolve());
    class FakeStressTestController {
      constructor() {
        scope.__stressConstructs = (scope.__stressConstructs as number) + 1;
        // Partial resources registered before the throw: exactly the state a
        // second construction would double.
        window.addEventListener('resize', () => {});
        if (options.stressThrows) throw new Error('simulated partial init failure');
      }
      init() {}
    }
    return { StressTestController: FakeStressTestController };
  });
  vi.doMock('../src/audioFourierController', () => ({
    AudioFourierController: class {
      constructor() {
        scope.__audioConstructs = (scope.__audioConstructs as number) + 1;
      }
      init() {}
    },
  }));

  // Dynamic import is the test seam: resetModules + doMock must take effect
  // before the entry registers its DOMContentLoaded listener.
  await import('../src/main');
  // Real page order: the deferred shell renders (activation arrives before the
  // entry listener exists), then DOMContentLoaded triggers the entry sweep.
  window.eval(shell);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  const query = <T extends HTMLElement = HTMLElement>(selector: string) =>
    window.document.querySelector<T>(selector)!;
  return {
    window,
    query,
    stressConstructs: () => scope.__stressConstructs as number,
    audioConstructs: () => scope.__audioConstructs as number,
    stageState: id => {
      const stage = query(`[data-utility-id="${id}"]`);
      const status = stage.querySelector('.utility-stage-status');
      const button = status?.querySelector('button');
      return {
        ready: stage.dataset.utilityReady ?? '',
        statusText: status?.textContent?.trim() ?? '',
        statusRole: status?.getAttribute('role') ?? '',
        retryMode: button?.dataset.utilityRetryMode ?? '',
        buttonText: button?.textContent?.trim() ?? '',
        inert: stage.querySelector('[data-utility-root]')?.hasAttribute('inert') === true,
      };
    },
    navigate: id => {
      if (id === null) {
        query('.nav-back-btn').click();
        return;
      }
      const switcher = query<HTMLSelectElement>('#utilitySwitcher');
      switcher.value = id;
      switcher.dispatchEvent(new window.Event('change'));
    },
    close: async () => {
      vi.unstubAllGlobals();
      vi.doUnmock('../src/stressTestController');
      vi.doUnmock('../src/audioFourierController');
      vi.resetModules();
      window.close();
      await Promise.resolve();
    },
  };
}

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

describe('utility init failure latch (issue #42 review blocker)', () => {
  it('constructs once and keeps the reload-only error across reopen and switch-back', async () => {
    const h = await setup({ stressThrows: true });
    harnesses.push(h);

    await vi.waitFor(() => expect(h.stageState('stress-test').ready).toBe('error'));
    expect(h.stressConstructs()).toBe(1);
    const first = h.stageState('stress-test');
    expect(first.retryMode).toBe('reload');
    expect(first.buttonText).toBe('Reload tools');
    expect(first.statusRole).toBe('alert');
    expect(first.inert).toBe(true);

    // Index → reopen: the activation sweep must not construct again.
    h.navigate(null);
    h.query<HTMLButtonElement>('.utilities-buttons [data-utility="stress-test"]').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.stressConstructs()).toBe(1);
    const reopened = h.stageState('stress-test');
    expect(reopened.ready).toBe('error');
    expect(reopened.retryMode).toBe('reload');
    expect(reopened.statusText).toContain('failed to initialize');
    expect(reopened.inert).toBe(true);

    // Switch away to a healthy utility, then back.
    h.navigate('audio-fourier');
    await vi.waitFor(() => expect(h.stageState('audio-fourier').ready).toBe('ready'));
    h.navigate('stress-test');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.stressConstructs()).toBe(1);
    expect(h.audioConstructs()).toBe(1);
    const returned = h.stageState('stress-test');
    expect(returned.ready).toBe('error');
    expect(returned.retryMode).toBe('reload');
    expect(returned.inert).toBe(true);
  });

  it('keeps deadline failures retryable and initializes exactly once after re-entry', async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    const h = await setup({ stressGate: gate, initTimeoutMs: 30 });
    harnesses.push(h);

    // The stalled import blows the entry deadline: retryable, not latched.
    await vi.waitFor(() => expect(h.stageState('stress-test').ready).toBe('error'));
    const stalled = h.stageState('stress-test');
    expect(stalled.retryMode).toBe('retry');
    expect(stalled.buttonText).toBe('Retry');
    expect(h.stressConstructs()).toBe(0);

    // Release the chunk, then Retry: one successful initialization follows.
    releaseGate();
    h.query<HTMLButtonElement>('[data-utility-id="stress-test"] .utility-stage-status button').click();
    await vi.waitFor(() => expect(h.stageState('stress-test').ready).toBe('ready'));
    expect(h.stressConstructs()).toBe(1);

    // Settled utilities never re-construct across navigation either.
    h.navigate('audio-fourier');
    await vi.waitFor(() => expect(h.stageState('audio-fourier').ready).toBe('ready'));
    h.navigate('stress-test');
    await Promise.resolve();
    await Promise.resolve();
    expect(h.stressConstructs()).toBe(1);
    expect(h.stageState('stress-test').ready).toBe('ready');
    expect(h.stageState('stress-test').inert).toBe(false);
  });
});