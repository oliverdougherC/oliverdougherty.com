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

function setup(hash = '') {
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
    expect(window.document.title).toBe('Fourier Reconstruction — Utilities — Oliver Dougherty');
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
