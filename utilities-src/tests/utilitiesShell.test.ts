import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const shell = readFileSync(new URL('../../js/utilities-shell.js', import.meta.url), 'utf8');
const tools = [
  ['image-transform', 'Image Transform'],
  ['audio-fourier', 'Fourier Reconstruction'],
  ['stress-test', 'Stress Test']
];
const instances: JSDOM[] = [];

function setup(hash = '', beforeEval?: (window: JSDOM['window']) => void) {
  const dom = new JSDOM(`<!doctype html><title>Utilities — Oliver Dougherty</title>
    <main id="utilitiesTitleView" class="utilities-view--active">
      <h1 class="utilities-title">Utilities</h1>
      <div class="utilities-buttons">${tools.map(([id, title]) =>
        `<button data-utility="${id}">${title}</button>`).join('')}</div>
    </main>
    <main id="utilitiesUtilityView" hidden>
      <button class="nav-back-btn">Index</button>
      <span id="utilityNumber"></span><h1 id="utilityTitle" tabindex="-1"></h1>
      <select id="utilitySwitcher">${tools.map(([id, title]) =>
        `<option value="${id}">${title}</option>`).join('')}</select>
      ${tools.map(([id, title], index) => `<section class="utility-stage" data-utility-id="${id}"
        data-utility-title="${title}" data-utility-number="0${index + 1}" hidden>
        <div data-utility-root></div></section>`).join('')}
      <section class="utility-stage" data-utility-id="virtual-machine" hidden></section>
    </main>`, { url: `https://example.com/utilities/${hash}`, runScripts: 'outside-only' });
  instances.push(dom);
  const { window } = dom;
  window.scrollTo = vi.fn();
  const events: string[] = [];
  ['utility-activate', 'utility-deactivate'].forEach(type => {
    window.document.addEventListener(type, event => {
      events.push(`${type}:${(event.target as HTMLElement).closest<HTMLElement>('[data-utility-id]')?.dataset.utilityId}`);
    });
  });
  beforeEval?.(window);
  window.eval(shell);
  const query = <T extends HTMLElement = HTMLElement>(selector: string) =>
    window.document.querySelector<T>(selector)!;
  return { window, query, events };
}

afterEach(() => instances.splice(0).forEach(dom => dom.window.close()));

describe('utilities shell', () => {
  it('opens initial deep links and notifies the active controller', () => {
    const { window, query, events } = setup('#audio-fourier');
    expect(query('[data-utility-id="audio-fourier"]').classList.contains('is-active')).toBe(true);
    expect(query('[data-utility-id="audio-fourier"]').hidden).toBe(false);
    expect(query('#utilitiesTitleView').hidden).toBe(true);
    expect(query('#utilitiesUtilityView').hidden).toBe(false);
    expect(query('#utilityTitle').textContent).toBe('Fourier Reconstruction');
    expect(query('#utilityNumber').textContent).toBe('02');
    expect(query<HTMLSelectElement>('#utilitySwitcher').value).toBe('audio-fourier');
    expect(window.document.title).toBe('Fourier Reconstruction');
    expect(window.document.activeElement).toBe(query('#utilityTitle'));
    expect(events).toEqual(['utility-activate:audio-fourier']);
  });

  it.each(['#virtual-machine', '#local-assistant', '#unknown', '#%E0%A4%A'])
    ('keeps unavailable or malformed route %s at the index', hash => {
      const { query, events } = setup(hash);
      expect(query('#utilitiesTitleView').classList.contains('utilities-view--active')).toBe(true);
      expect(query('#utilitiesUtilityView').hidden).toBe(true);
      expect(query('[data-utility-id="virtual-machine"]').hidden).toBe(true);
      expect(events).toEqual([]);
    });

  it('leaves focus and scroll alone when arriving at the index', () => {
    const { window } = setup();
    expect(window.document.activeElement).toBe(window.document.body);
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('returns focus to the launching entry and restores index scroll', () => {
    const { window, query, events } = setup();
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 420 });
    const launcher = query('[data-utility="stress-test"]');
    launcher.click();
    expect(window.location.hash).toBe('#stress-test');
    expect(window.document.activeElement).toBe(query('#utilityTitle'));
    query('.nav-back-btn').click();
    expect(window.location.hash).toBe('');
    expect(window.document.activeElement).toBe(launcher);
    expect(window.scrollTo).toHaveBeenLastCalledWith({ left: 0, top: 420, behavior: 'instant' });
    expect(window.document.title).toBe('Utilities — Oliver Dougherty');
    expect(window.document.documentElement.dataset.activeUtility).toBeUndefined();
    expect(events).toEqual(['utility-activate:stress-test', 'utility-deactivate:stress-test']);
  });

  it('switches immediately through rapid navigation without losing lifecycle events', () => {
    const { window, query, events } = setup();
    query('[data-utility="image-transform"]').click();
    const select = query<HTMLSelectElement>('#utilitySwitcher');
    select.value = 'audio-fourier';
    select.dispatchEvent(new window.Event('change'));
    select.value = 'stress-test';
    select.dispatchEvent(new window.Event('change'));
    // An extra hash event must not activate the already-active controller twice.
    window.dispatchEvent(new window.HashChangeEvent('hashchange'));
    expect(window.location.hash).toBe('#stress-test');
    expect(query('.is-active').dataset.utilityId).toBe('stress-test');
    expect(window.document.querySelectorAll('.utility-stage:not([hidden])')).toHaveLength(1);
    expect(events).toEqual([
      'utility-activate:image-transform', 'utility-deactivate:image-transform',
      'utility-activate:audio-fourier', 'utility-deactivate:audio-fourier',
      'utility-activate:stress-test'
    ]);
  });

  it('follows browser back and forward between index and tools', async () => {
    const { window, query, events } = setup();
    query('[data-utility="image-transform"]').click();
    const select = query<HTMLSelectElement>('#utilitySwitcher');
    select.value = 'audio-fourier';
    select.dispatchEvent(new window.Event('change'));

    async function traverse(direction: 'back' | 'forward') {
      const changed = new Promise<void>(resolve =>
        window.addEventListener('popstate', () => resolve(), { once: true }));
      window.history[direction]();
      await changed;
    }
    await traverse('back');
    expect(query('#utilityTitle').textContent).toBe('Image Transform');
    await traverse('back');
    expect(query('#utilitiesTitleView').hidden).toBe(false);
    expect(window.document.activeElement).toBe(query('[data-utility="image-transform"]'));
    await traverse('forward');
    expect(query('[data-utility-id="image-transform"]').hidden).toBe(false);
    expect(events.filter(event => event === 'utility-activate:image-transform')).toHaveLength(3);
  });

  it('handles externally changed hashes and deactivates a tool for invalid routes', async () => {
    const { window, query, events } = setup('#image-transform');
    const changed = new Promise<void>(resolve =>
      window.addEventListener('hashchange', () => resolve(), { once: true }));
    window.location.hash = '#virtual-machine';
    await changed;
    expect(query('#utilitiesTitleView').hidden).toBe(false);
    expect(events).toEqual(['utility-activate:image-transform', 'utility-deactivate:image-transform']);
    expect(query('[data-utility-id="virtual-machine"]').hidden).toBe(true);
  });

  it('accepts encoded valid deep links', () => {
    const { query } = setup('#image%2Dtransform');
    expect(query('[data-utility-id="image-transform"]').hidden).toBe(false);
  });

  it('dispatches deactivation to the controller root when returning to the index', () => {
    const { query } = setup('#stress-test');
    const stop = vi.fn();
    query('[data-utility-id="stress-test"] [data-utility-root]').addEventListener('utility-deactivate', stop);
    query('.nav-back-btn').click();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('utilities shell readiness (issue #42)', () => {
  interface ManualTimers {
    fireAll: () => void;
    restore: () => void;
  }
  // Captures the shell's watchdog callbacks so deadline tests fire
  // deterministically instead of waiting on wall-clock time.
  function manualTimers(window: JSDOM['window']): ManualTimers {
    const pending = new Map<number, () => void>();
    let next = 1;
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    window.setTimeout = ((handler: () => void) => {
      const id = next++;
      pending.set(id, handler);
      return id;
    }) as typeof window.setTimeout;
    window.clearTimeout = ((id: number) => {
      pending.delete(id);
    }) as typeof window.clearTimeout;
    return {
      fireAll: () => {
        const callbacks = [...pending.values()];
        pending.clear();
        callbacks.forEach(cb => cb());
      },
      restore: () => {
        window.setTimeout = realSetTimeout;
        window.clearTimeout = realClearTimeout;
      },
    };
  }

  function fireReadiness(
    window: JSDOM['window'],
    root: HTMLElement,
    type: 'utility-ready' | 'utility-failed',
    detail?: Record<string, unknown>,
  ) {
    root.dispatchEvent(new window.CustomEvent(type, { detail }));
  }

  it('marks the stage loading and inert until the controller reports ready', () => {
    const { window, query } = setup('#stress-test');
    const stage = query('[data-utility-id="stress-test"]');
    const root = query('[data-utility-id="stress-test"] [data-utility-root]');
    expect(stage.dataset.utilityReady).toBe('loading');
    expect(stage.getAttribute('aria-busy')).toBe('true');
    expect(root.hasAttribute('inert')).toBe(true);
    const status = query('.utility-stage-status');
    expect(status.hidden).toBe(false);
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent).toContain('Stress Test');
    // Index chrome stays interactive: inert only wraps the controller root.
    expect(query('#utilitiesTitleView').hasAttribute('inert')).toBe(false);
    expect(query('.nav-back-btn').hasAttribute('inert')).toBe(false);

    fireReadiness(window, root, 'utility-ready');
    expect(stage.dataset.utilityReady).toBe('ready');
    expect(stage.getAttribute('aria-busy')).toBe('false');
    expect(root.hasAttribute('inert')).toBe(false);
    expect(status.hidden).toBe(true);
  });

  it('surfaces a reload-only outcome when the chunk import failed', () => {
    const { window, query } = setup('#stress-test');
    const stage = query('[data-utility-id="stress-test"]');
    const root = query('[data-utility-id="stress-test"] [data-utility-root]');
    fireReadiness(window, root, 'utility-failed', {
      utilityId: 'stress-test',
      reason: 'import-failed',
      retryable: false,
      retryMode: 'reload',
      message: 'Stress Test could not be loaded.',
    });
    expect(stage.dataset.utilityReady).toBe('error');
    expect(root.hasAttribute('inert')).toBe(true);
    const status = query('.utility-stage-status');
    expect(status.getAttribute('role')).toBe('alert');
    expect(status.textContent).toContain('could not be loaded');
    const button = status.querySelector('button')!;
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe('Reload tools');
    expect(button.dataset.utilityRetryMode).toBe('reload');
  });

  it('re-activates on retry when the failure is retryable', () => {
    const { window, query, events } = setup('#stress-test');
    const root = query('[data-utility-id="stress-test"] [data-utility-root]');
    fireReadiness(window, root, 'utility-failed', {
      utilityId: 'stress-test',
      reason: 'init-failed',
      retryable: true,
      retryMode: 'retry',
      message: 'Stress Test failed to initialize.',
    });
    const button = query('.utility-stage-status button');
    expect(button.textContent).toBe('Retry');
    button.click();
    expect(query('[data-utility-id="stress-test"]').dataset.utilityReady).toBe('loading');
    expect(events.filter(event => event === 'utility-activate:stress-test').length).toBe(2);
  });

  it('bounds a stalled load: the watchdog marks it errored and reload-only', () => {
    let timers!: ManualTimers;
    const { window, query } = setup('#stress-test', w => {
      timers = manualTimers(w);
    });
    const stage = query('[data-utility-id="stress-test"]');
    expect(stage.dataset.utilityReady).toBe('loading');
    timers.fireAll();
    expect(stage.dataset.utilityReady).toBe('error');
    expect(query('.utility-stage-status').textContent).toContain('took too long');
    const button = query('.utility-stage-status button');
    // Entry never executed → an in-page retry cannot reach any listener.
    expect(button.dataset.utilityRetryMode).toBe('reload');
    expect(query('[data-utility-id="stress-test"] [data-utility-root]').hasAttribute('inert')).toBe(true);
    // A late success from the still-pending load recovers the stage.
    fireReadiness(window, query('[data-utility-id="stress-test"] [data-utility-root]'), 'utility-ready');
    expect(stage.dataset.utilityReady).toBe('ready');
    timers.restore();
  });

  it('offers an in-page retry once the entry module has executed', () => {
    let timers!: ManualTimers;
    const { window, query, events } = setup('#stress-test', w => {
      timers = manualTimers(w);
      (w as unknown as Record<string, unknown>).__utilitiesEntryExecuted__ = true;
    });
    timers.fireAll();
    expect(query('[data-utility-id="stress-test"]').dataset.utilityReady).toBe('loading');
    fireReadiness(window, query('[data-utility-id="stress-test"] [data-utility-root]'), 'utility-failed', {
      utilityId: 'stress-test', reason: 'deadline', retryable: true, retryMode: 'retry',
      message: 'Stress Test took too long to load.'
    });
    const button = query('.utility-stage-status button');
    expect(button.dataset.utilityRetryMode).toBe('retry');
    button.click();
    expect(query('[data-utility-id="stress-test"]').dataset.utilityReady).toBe('loading');
    expect(events.filter(event => event === 'utility-activate:stress-test').length).toBe(2);
    timers.restore();
  });

  it('falls back to reload if the entry executed but no controller deadline event arrives', () => {
    let timers!: ManualTimers;
    const { query } = setup('#stress-test', w => {
      timers = manualTimers(w);
      (w as unknown as Record<string, unknown>).__utilitiesEntryExecuted__ = true;
    });
    timers.fireAll();
    expect(query('[data-utility-id="stress-test"]').dataset.utilityReady).toBe('loading');
    timers.fireAll();
    expect(query('[data-utility-id="stress-test"]').dataset.utilityReady).toBe('error');
    expect(query('.utility-stage-status button').dataset.utilityRetryMode).toBe('reload');
    timers.restore();
  });

  it('disables the shell watchdog when its configured deadline is zero', () => {
    let timers!: ManualTimers;
    const { query } = setup('#stress-test', w => {
      timers = manualTimers(w);
      (w as unknown as Record<string, unknown>).__OD_UTILITIES_INIT_TIMEOUT_MS = 0;
    });
    timers.fireAll();
    expect(query('[data-utility-id="stress-test"]').dataset.utilityReady).toBe('loading');
    timers.restore();
  });

  it('rebinds the retry control once when the shell script is re-evaluated', () => {
    const { window, query, events } = setup('#stress-test');
    const root = query('[data-utility-id="stress-test"] [data-utility-root]');
    fireReadiness(window, root, 'utility-failed', { retryable: true, message: 'Retry needed.' });
    const button = query('.utility-stage-status button');
    window.eval(shell);
    fireReadiness(window, root, 'utility-failed', { retryable: true, message: 'Retry still needed.' });
    const before = events.filter(event => event === 'utility-activate:stress-test').length;
    button.click();
    expect(events.filter(event => event === 'utility-activate:stress-test')).toHaveLength(before + 1);
  });

  it('keeps per-stage readiness independent across rapid switching', () => {
    const { window, query } = setup('#image-transform');
    const image = query('[data-utility-id="image-transform"]');
    const audio = query('[data-utility-id="audio-fourier"]');
    window.location.hash = '#audio-fourier';
    window.dispatchEvent(new window.Event('hashchange'));
    expect(audio.dataset.utilityReady).toBe('loading');
    expect(image.dataset.utilityReady).toBe('loading');
    fireReadiness(window, audio.querySelector('[data-utility-root]')!, 'utility-ready');
    expect(audio.dataset.utilityReady).toBe('ready');
    expect(image.dataset.utilityReady).toBe('loading');
    // Re-entering a settled stage must not drop it back to loading.
    window.location.hash = '#audio-fourier';
    window.dispatchEvent(new window.Event('hashchange'));
    window.location.hash = '#image-transform';
    window.dispatchEvent(new window.Event('hashchange'));
    expect(image.dataset.utilityReady).toBe('loading');
    fireReadiness(window, image.querySelector('[data-utility-root]')!, 'utility-ready');
    window.location.hash = '#audio-fourier';
    window.dispatchEvent(new window.Event('hashchange'));
    expect(audio.dataset.utilityReady).toBe('ready');
  });

  it('errors pending stages on entry load failure without touching ready stages', () => {
    const { window, query } = setup('#audio-fourier');
    const audio = query('[data-utility-id="audio-fourier"]');
    const image = query('[data-utility-id="image-transform"]');
    fireReadiness(window, image.querySelector('[data-utility-root]')!, 'utility-ready');
    window.dispatchEvent(new window.Event('utility-load-error'));
    expect(audio.dataset.utilityReady).toBe('error');
    expect(query('[data-utility-id="audio-fourier"] .utility-stage-status button').dataset.utilityRetryMode).toBe('reload');
    expect(image.dataset.utilityReady).toBe('ready');
  });
});
