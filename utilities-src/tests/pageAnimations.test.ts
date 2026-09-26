import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const scriptSource = readFileSync('js/page-animations.js', 'utf8');

describe('page animation reload behavior', () => {
  it('leaves browser hard-reload shortcuts and the URL untouched', () => {
    const dom = new JSDOM('<script data-page-id="gallery"></script>', {
      url: 'https://example.test/pages/gallery/index.html',
      runScripts: 'outside-only'
    });
    const { document } = dom.window;
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      get: () => document.querySelector('script')
    });
    dom.window.eval(scriptSource);

    for (const options of [
      { code: 'KeyR', ctrlKey: true, shiftKey: true },
      { code: 'KeyR', metaKey: true, shiftKey: true },
      { code: 'F5', shiftKey: true }
    ]) {
      const event = new dom.window.KeyboardEvent('keydown', { ...options, cancelable: true, bubbles: true });
      expect(document.dispatchEvent(event)).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(dom.window.location.href).toBe('https://example.test/pages/gallery/index.html');
      expect(dom.window.sessionStorage.getItem('od-hard-reload')).toBeNull();
    }
    dom.window.close();
  });

  it('continues to skip the intro on a same-session revisit', () => {
    const dom = new JSDOM('<script data-page-id="gallery"></script>', {
      url: 'https://example.test/pages/gallery/index.html',
      runScripts: 'outside-only'
    });
    Object.defineProperty(dom.window.document, 'currentScript', {
      configurable: true,
      get: () => dom.window.document.querySelector('script')
    });
    dom.window.eval(scriptSource);
    expect(dom.window.pageAnimations.shouldSkip()).toBe(false);
    dom.window.eval(scriptSource);
    expect(dom.window.pageAnimations.shouldSkip()).toBe(true);
    expect(dom.window.document.documentElement.classList.contains('skip-page-animation')).toBe(true);
    dom.window.close();
  });
});
