/**
 * Regression coverage for js/mobile-gallery.js (review F07/F08): delayed
 * navigation cancellation via transition tokens, deterministic rapid-swipe
 * policy, reduced-motion behavior, and modal dialog accessibility (semantic
 * photo buttons, focus entry/containment/return, Escape/arrow keys). Runs the
 * real shipped script inside JSDOM.
 */
import {
  flushFrames,
  loadMobileGallery,
  makePhoto,
  sleep,
  type MobileHarness
} from './galleryHarness';

function photoSet(count: number) {
  return Array.from({ length: count }, (_, index) => makePhoto(`p${index}`, 1.5));
}

function buttons(h: MobileHarness) {
  return [...h.grid.querySelectorAll<HTMLElement>('button.mobile-photo-button')];
}

function isOpen(h: MobileHarness) {
  return !h.overlay.hasAttribute('hidden');
}

function openPhoto(h: MobileHarness, index: number) {
  buttons(h)[index].click();
  return buttons(h)[index];
}

async function settleNavigation(h: MobileHarness) {
  await sleep(240);
  await flushFrames(h.window);
}

describe('mobile photo buttons (F08)', () => {
  let h: MobileHarness;

  beforeEach(async () => {
    h = await loadMobileGallery({ photos: photoSet(5) });
  });

  afterEach(() => {
    h.dom.window.close();
  });

  it('renders keyboard-operable, labeled buttons that keep image selectors', () => {
    const items = buttons(h);
    expect(items.length).toBe(5);
    for (const [index, button] of items.entries()) {
      expect(button.getAttribute('type')).toBe('button');
      expect(button.getAttribute('aria-label')).toBe(`Open Photo p${index} in photo viewer`);
      const image = button.querySelector('img');
      expect(image?.getAttribute('data-entry-index')).toBe(String(index));
      expect(image?.getAttribute('alt')).toBe(`Photo p${index}`);
    }
  });

  it('enters the dialog on open, inertizes the background, and returns focus on close', () => {
    const trigger = openPhoto(h, 2);
    expect(isOpen(h)).toBe(true);
    expect(h.window.document.body.classList.contains('mobile-lightbox-open')).toBe(true);
    expect(h.window.document.activeElement).toBe(h.close);

    for (const region of ['header', 'main', 'footer']) {
      const node = h.window.document.querySelector(region) as HTMLElement;
      expect(node.hasAttribute('inert'), `${region} should be inert`).toBe(true);
    }

    h.key('Escape');
    expect(isOpen(h)).toBe(false);
    for (const region of ['header', 'main', 'footer']) {
      const node = h.window.document.querySelector(region) as HTMLElement;
      expect(node.hasAttribute('inert'), `${region} inert should clear`).toBe(false);
    }
    expect(h.window.document.activeElement).toBe(trigger);
  });

  it('preserves background regions that were already inert before opening', () => {
    const footer = h.window.document.querySelector('footer')!;
    footer.setAttribute('inert', '');
    openPhoto(h, 0);
    h.close.click();
    expect(footer.hasAttribute('inert')).toBe(true);
    expect(h.window.document.querySelector('main')!.hasAttribute('inert')).toBe(false);
  });

  it('keeps Tab focus inside the dialog and pulls escaped focus back', () => {
    openPhoto(h, 0);
    expect(h.window.document.activeElement).toBe(h.close);

    h.key('Tab');
    expect(h.window.document.activeElement).toBe(h.close);
    h.key('Tab', { shiftKey: true });
    expect(h.window.document.activeElement).toBe(h.close);

    const brandLink = h.window.document.querySelector('.mobile-brand') as HTMLElement;
    brandLink.focus();
    h.key('Tab');
    expect(h.window.document.activeElement).toBe(h.close);
  });

  it('navigates with arrow keys and wraps in both directions', async () => {
    openPhoto(h, 0);
    h.key('ArrowRight');
    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p1.jpg');

    h.key('ArrowLeft');
    h.key('ArrowLeft');
    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p4.jpg');

    h.key('ArrowRight');
    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p0.jpg');
  });
});

describe('mobile delayed navigation (F07)', () => {
  let h: MobileHarness;

  beforeEach(async () => {
    h = await loadMobileGallery({ photos: photoSet(5) });
  });

  afterEach(() => {
    h.dom.window.close();
  });

  it('does not reopen the lightbox when closed during the navigation delay', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    expect(h.image.style.opacity).toBe('0');

    h.close.click();
    await sleep(320);
    await flushFrames(h.window);

    expect(isOpen(h)).toBe(false);
    expect(h.window.document.body.classList.contains('mobile-lightbox-open')).toBe(false);
    expect(h.image.getAttribute('src')).toContain('p0.jpg');
  });

  it('advances once per rapid swipe with a coalesced commit', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    h.swipe(80);
    h.swipe(80);
    expect(h.image.getAttribute('src')).toContain('p0.jpg');

    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p3.jpg');
    expect(isOpen(h)).toBe(true);
  });

  it('resolves alternating rapid directions from the pending target', async () => {
    openPhoto(h, 1);
    h.swipe(80);
    h.swipe(80);
    h.swipe(-80);
    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p2.jpg');
  });

  it('stays closed when swipe-down arrives during a pending navigation', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    h.swipe(0, -90); // finger moves down: close
    await sleep(320);
    await flushFrames(h.window);
    expect(isOpen(h)).toBe(false);
  });

  it('does not clobber a photo reopened during a stale pending navigation', async () => {
    openPhoto(h, 0);
    h.swipe(80); // pending → p1
    h.close.click();
    openPhoto(h, 3);
    await sleep(320);
    await flushFrames(h.window);
    expect(isOpen(h)).toBe(true);
    expect(h.image.getAttribute('src')).toContain('p3.jpg');
  });

  it('wraps a single swipe at either end', async () => {
    openPhoto(h, 4);
    h.swipe(80);
    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p0.jpg');

    h.swipe(-80);
    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p4.jpg');
  });

  it('cancels pending navigation on pagehide without closing the dialog', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    h.window.dispatchEvent(new h.window.Event('pagehide'));
    await sleep(320);
    await flushFrames(h.window);
    expect(isOpen(h)).toBe(true);
    expect(h.image.getAttribute('src')).toContain('p0.jpg');

    expect(h.image.style.opacity).toBe('1');

    // A fresh gesture after resume still works.
    h.swipe(80);
    await settleNavigation(h);
    expect(h.image.getAttribute('src')).toContain('p1.jpg');
  });

  it('commits immediately under reduced motion', async () => {
    h.dom.window.close();
    h = await loadMobileGallery({ photos: photoSet(5), reducedMotion: true });

    openPhoto(h, 0);
    h.swipe(80);
    await flushFrames(h.window);
    expect(h.image.getAttribute('src')).toContain('p1.jpg');
    expect(h.image.style.opacity).toBe('1');
  });
});
