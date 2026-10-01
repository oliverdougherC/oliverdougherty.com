/**
 * Regression coverage for js/mobile-gallery.js: decoded frame ownership,
 * deterministic rapid-swipe policy, reduced-motion behavior,
 * and modal dialog accessibility (semantic
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

function currentImage(h: MobileHarness) {
  return h.window.document.getElementById('mobileLightboxImage') as HTMLImageElement;
}

function incomingImage(h: MobileHarness) {
  return h.overlay.querySelector('.mobile-lightbox-incoming img') as HTMLImageElement | null;
}

function finishImage(h: MobileHarness, image = incomingImage(h)!) {
  expect(image).not.toBeNull();
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1600 });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: 1067 });
  image.dispatchEvent(new h.window.Event('load'));
}

function openPhoto(h: MobileHarness, index: number, ready = true) {
  buttons(h)[index].click();
  if (ready) finishImage(h);
  return buttons(h)[index];
}

async function settleNavigation(h: MobileHarness) {
  if (incomingImage(h)) finishImage(h);
  await flushFrames(h.window);
}

async function observeThumbnails(h: MobileHarness) {
  let callback!: IntersectionObserverCallback;
  const targets = new Set<Element>();
  h.window.IntersectionObserver = class {
    constructor(onIntersect: IntersectionObserverCallback) { callback = onIntersect; }
    observe(target: Element) { targets.add(target); }
    unobserve(target: Element) { targets.delete(target); }
    disconnect() { targets.clear(); }
  } as unknown as typeof IntersectionObserver;
  await (h.window as unknown as { __mobileGalleryRetry(): Promise<void> }).__mobileGalleryRetry();
  return {
    targets,
    show(images: Element[]) {
      callback(images.map(target => ({ target, isIntersecting: true })) as IntersectionObserverEntry[], {} as IntersectionObserver);
    }
  };
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

  it('falls back from a failed modern thumbnail and preserves access when its JPEG also fails', async () => {
    const observer = await observeThumbnails(h);
    const button = buttons(h)[0];
    const thumbnail = button.querySelector('img')!;
    observer.show([thumbnail]);
    expect(button.querySelectorAll('source')).toHaveLength(2);
    thumbnail.dispatchEvent(new h.window.Event('error'));
    expect(button.querySelectorAll('source')).toHaveLength(0);
    expect(button.classList.contains('mobile-photo-unavailable')).toBe(false);
    thumbnail.dispatchEvent(new h.window.Event('error'));
    expect(button.classList.contains('mobile-photo-unavailable')).toBe(true);
    openPhoto(h, 0);
    expect(currentImage(h).alt).toBe('Photo p0');
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
    expect(currentImage(h).getAttribute('src')).toContain('p1.jpg');

    h.key('ArrowLeft');
    h.key('ArrowLeft');
    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p4.jpg');

    h.key('ArrowRight');
    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p0.jpg');
  });
});

describe('mobile readiness navigation (F07 / #76)', () => {
  let h: MobileHarness;

  beforeEach(async () => {
    h = await loadMobileGallery({ photos: photoSet(5) });
  });

  afterEach(() => {
    h.dom.window.close();
  });

  it('does not reopen the lightbox when closed during preparation', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    expect(currentImage(h).style.opacity).toBe('1');

    h.close.click();
    await sleep(320);
    await flushFrames(h.window);

    expect(isOpen(h)).toBe(false);
    expect(h.window.document.body.classList.contains('mobile-lightbox-open')).toBe(false);
    expect(currentImage(h).getAttribute('src')).toContain('p0.jpg');
  });

  it('advances once per rapid swipe with a coalesced commit', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    h.swipe(80);
    h.swipe(80);
    expect(currentImage(h).getAttribute('src')).toContain('p0.jpg');

    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p3.jpg');
    expect(isOpen(h)).toBe(true);
  });

  it('resolves alternating rapid directions from the pending target', async () => {
    openPhoto(h, 1);
    h.swipe(80);
    h.swipe(80);
    h.swipe(-80);
    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p2.jpg');
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
    expect(currentImage(h).getAttribute('src')).toContain('p3.jpg');
  });

  it('wraps a single swipe at either end', async () => {
    openPhoto(h, 4);
    h.swipe(80);
    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p0.jpg');

    h.swipe(-80);
    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p4.jpg');
  });

  it('cancels pending navigation on pagehide without closing the dialog', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    h.window.dispatchEvent(new h.window.Event('pagehide'));
    await sleep(320);
    await flushFrames(h.window);
    expect(isOpen(h)).toBe(true);
    expect(currentImage(h).getAttribute('src')).toContain('p0.jpg');

    expect(currentImage(h).style.opacity).toBe('1');

    // A fresh gesture after resume still works.
    h.swipe(80);
    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p1.jpg');
  });

  it('swaps after readiness without animation under reduced motion', async () => {
    h.dom.window.close();
    h = await loadMobileGallery({ photos: photoSet(5), reducedMotion: true });

    openPhoto(h, 0);
    h.swipe(80);
    expect(currentImage(h).getAttribute('src')).toContain('p0.jpg');
    await settleNavigation(h);
    expect(currentImage(h).getAttribute('src')).toContain('p1.jpg');
    expect(currentImage(h).style.opacity).toBe('1');
    expect(currentImage(h).closest('picture')!.classList.contains('mobile-lightbox-reveal')).toBe(false);
  });
});


describe('mobile image readiness and recovery', () => {
  let h: MobileHarness;

  beforeEach(async () => {
    h = await loadMobileGallery({ photos: photoSet(5) });
  });

  afterEach(() => {
    h.dom.window.close();
  });

  it('opens with an announced loading state and no broken/previous frame', () => {
    openPhoto(h, 1, false);
    expect(isOpen(h)).toBe(true);
    expect(currentImage(h).closest('picture')!.hidden).toBe(true);
    expect(h.window.document.getElementById('mobileLightboxMedia')!.getAttribute('aria-busy')).toBe('true');
    expect(h.window.document.getElementById('mobileLightboxStatus')!.textContent).toBe('Loading photo…');
    finishImage(h);
    expect(currentImage(h).alt).toBe('Photo p1');
    expect(h.window.document.getElementById('mobileLightboxMedia')!.getAttribute('aria-busy')).toBe('false');
  });

  it('retains the outgoing pixels and alt text until the requested decode completes', async () => {
    openPhoto(h, 0);
    const outgoing = currentImage(h);
    h.swipe(80);
    const incoming = incomingImage(h)!;
    let decoded!: () => void;
    incoming.decode = () => new Promise<void>(resolve => { decoded = resolve; });
    finishImage(h, incoming);
    expect(currentImage(h)).toBe(outgoing);
    expect(outgoing.alt).toBe('Photo p0');
    expect(outgoing.style.opacity).toBe('1');
    decoded();
    await Promise.resolve();
    expect(currentImage(h)).toBe(incoming);
    expect(currentImage(h).alt).toBe('Photo p1');
  });

  it('ignores superseded decode completions and bounds retained layers', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    const stale = incomingImage(h)!;
    let decoded!: () => void;
    stale.decode = () => new Promise<void>(resolve => { decoded = resolve; });
    finishImage(h, stale);
    h.swipe(80);
    finishImage(h);
    decoded();
    await Promise.resolve();
    expect(currentImage(h).alt).toBe('Photo p2');
    for (let index = 0; index < 10; index += 1) {
      h.swipe(80);
      expect(currentImage(h).closest('picture')!.classList.contains('mobile-lightbox-reveal')).toBe(false);
      expect(h.overlay.querySelectorAll('picture').length).toBeLessThanOrEqual(2);
      finishImage(h);
      expect(h.overlay.querySelectorAll('picture').length).toBeLessThanOrEqual(2);
    }
    await sleep(200);
    expect(h.overlay.querySelectorAll('picture')).toHaveLength(1);
  });

  it('preserves the last valid frame on failure and retries the requested target', () => {
    openPhoto(h, 0);
    h.swipe(80);
    incomingImage(h)!.dispatchEvent(new h.window.Event('error'));
    expect(currentImage(h).alt).toBe('Photo p0');
    expect(incomingImage(h)).toBeNull();
    const retry = h.window.document.getElementById('mobileLightboxRetry') as HTMLButtonElement;
    expect(retry.hidden).toBe(false);
    h.key('Tab');
    expect(h.window.document.activeElement).toBe(retry);
    h.key('Tab');
    expect(h.window.document.activeElement).toBe(h.close);
    h.key('Tab', { shiftKey: true });
    expect(h.window.document.activeElement).toBe(retry);
    h.key('Tab', { shiftKey: true });
    expect(h.window.document.activeElement).toBe(h.close);
    retry.focus();
    retry.click();
    expect(h.window.document.activeElement).toBe(h.close);
    finishImage(h);
    expect(currentImage(h).alt).toBe('Photo p1');
    expect(retry.hidden).toBe(true);
  });

  it('treats decode rejection as failure without exposing corrupt pixels', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    incomingImage(h)!.decode = () => Promise.reject(new Error('corrupt image'));
    finishImage(h);
    await Promise.resolve();
    expect(currentImage(h).alt).toBe('Photo p0');
    expect(incomingImage(h)).toBeNull();
    expect(h.window.document.getElementById('mobileLightboxRetry')!.hidden).toBe(false);
  });

  it('bounds a stalled image or decode with a retryable deadline', () => {
    const originalSetTimeout = h.window.setTimeout.bind(h.window);
    let timeout: (() => void) | undefined;
    h.window.setTimeout = ((handler: TimerHandler, delay?: number) => {
      if (delay === 15000) {
        timeout = handler as () => void;
        return 999;
      }
      return originalSetTimeout(handler, delay);
    }) as typeof h.window.setTimeout;
    openPhoto(h, 0, false);
    expect(timeout).toBeDefined();
    timeout!();
    expect(currentImage(h).closest('picture')!.hidden).toBe(true);
    expect(incomingImage(h)).toBeNull();
    (h.window.document.getElementById('mobileLightboxRetry') as HTMLButtonElement).click();
    finishImage(h);
    h.swipe(80);
    incomingImage(h)!.decode = () => new Promise<void>(() => {});
    finishImage(h);
    expect(timeout).toBeDefined();
    timeout!();
    expect(currentImage(h).alt).toBe('Photo p0');
    expect(incomingImage(h)).toBeNull();
    expect(h.window.document.getElementById('mobileLightboxRetry')!.hidden).toBe(false);
  });

  it('offers recovery after first-image failure while close and navigation remain usable', () => {
    const trigger = openPhoto(h, 0, false);
    incomingImage(h)!.dispatchEvent(new h.window.Event('error'));
    expect(currentImage(h).closest('picture')!.hidden).toBe(true);
    expect(h.window.document.getElementById('mobileLightboxRetry')!.hidden).toBe(false);
    h.key('ArrowRight');
    finishImage(h);
    expect(currentImage(h).alt).toBe('Photo p1');
    h.key('Escape');
    expect(isOpen(h)).toBe(false);
    expect(h.window.document.activeElement).toBe(trigger);
  });

  it('ignores a decode that finishes after close and reopening another photo', async () => {
    openPhoto(h, 0);
    h.swipe(80);
    let decoded!: () => void;
    incomingImage(h)!.decode = () => new Promise<void>(resolve => { decoded = resolve; });
    finishImage(h);
    h.close.click();
    openPhoto(h, 4);
    decoded();
    await Promise.resolve();
    expect(currentImage(h).alt).toBe('Photo p4');
    expect(isOpen(h)).toBe(true);
  });

  it('ignores cancelled touch gestures and multi-touch zoom gestures', () => {
    openPhoto(h, 0);
    function touch(type: string, touches: { identifier: number; clientX: number; clientY: number }[]) {
      const event = new h.window.Event(type);
      Object.assign(event, type === 'touchend' ? { changedTouches: touches } : { touches });
      h.overlay.dispatchEvent(event);
    }
    touch('touchstart', [{ identifier: 1, clientX: 150, clientY: 150 }]);
    touch('touchcancel', []);
    touch('touchend', [{ identifier: 1, clientX: 0, clientY: 150 }]);
    expect(incomingImage(h)).toBeNull();
    touch('touchstart', [{ identifier: 1, clientX: 150, clientY: 150 }]);
    touch('touchstart', [{ identifier: 1, clientX: 150, clientY: 150 }, { identifier: 2, clientX: 200, clientY: 150 }]);
    touch('touchend', [{ identifier: 1, clientX: 0, clientY: 150 }]);
    expect(incomingImage(h)).toBeNull();
  });
});


describe('mobile thumbnail scheduling', () => {
  let h: MobileHarness;

  beforeEach(async () => {
    h = await loadMobileGallery({ photos: photoSet(8) });
  });

  afterEach(() => { h.dom.window.close(); });

  it('hydrates only near-viewport pictures with at most two thumbnail requests in flight', async () => {
    const observer = await observeThumbnails(h);
    const images = [...h.grid.querySelectorAll('img')];
    expect(images.every(image => !image.hasAttribute('src'))).toBe(true);
    expect(images.every(image => image.style.opacity === '0')).toBe(true);
    expect(h.grid.querySelectorAll('source[srcset]')).toHaveLength(0);
    observer.show(images.slice(0, 5));
    expect(images.filter(image => image.hasAttribute('src'))).toHaveLength(2);
    expect(images[0].getAttribute('fetchpriority')).toBe('low');
    expect(images[0].closest('picture')!.querySelector('source[type="image/avif"]')!.getAttribute('srcset')).toContain('p0.avif');
    images[0].dispatchEvent(new h.window.Event('load'));
    expect(images[0].style.opacity).toBe('1');
    expect(images.filter(image => image.hasAttribute('src'))).toHaveLength(3);
    images[1].dispatchEvent(new h.window.Event('load'));
    images[2].dispatchEvent(new h.window.Event('load'));
    images[3].dispatchEvent(new h.window.Event('load'));
    images[4].dispatchEvent(new h.window.Event('load'));
    expect(images.filter(image => image.hasAttribute('src'))).toHaveLength(5);
  });

  it('pauses background hydration while viewing a photo and resumes after close', async () => {
    const observer = await observeThumbnails(h);
    const images = [...h.grid.querySelectorAll('img')];
    observer.show(images);
    openPhoto(h, 0);
    expect(observer.targets.size).toBe(0);
    images[0].dispatchEvent(new h.window.Event('load'));
    images[1].dispatchEvent(new h.window.Event('load'));
    observer.show(images.slice(2)); // queued observation from before disconnect
    expect(images.filter(image => image.hasAttribute('src'))).toHaveLength(2);
    h.close.click();
    expect(observer.targets.size).toBe(6);
    observer.show(images.slice(2));
    expect(images.filter(image => image.hasAttribute('src'))).toHaveLength(4);
  });

  it('suspends thumbnail scheduling across pagehide and resumes on pageshow', async () => {
    const observer = await observeThumbnails(h);
    const images = [...h.grid.querySelectorAll('img')];
    h.window.dispatchEvent(new h.window.Event('pagehide'));
    observer.show(images);
    expect(images.every(image => !image.hasAttribute('src'))).toBe(true);
    h.window.dispatchEvent(new h.window.Event('pageshow'));
    expect(observer.targets.size).toBe(8);
    observer.show(images);
    expect(images.filter(image => image.hasAttribute('src'))).toHaveLength(2);
  });

  it('retains native lazy loading when IntersectionObserver is unavailable', async () => {
    Object.defineProperty(h.window, 'IntersectionObserver', { configurable: true, value: undefined });
    await (h.window as unknown as { __mobileGalleryRetry(): Promise<void> }).__mobileGalleryRetry();
    const images = [...h.grid.querySelectorAll('img')];
    expect(images.every(image => image.hasAttribute('src'))).toBe(true);
    expect(images[4].loading).toBe('lazy');
    expect(h.grid.querySelectorAll('source[srcset]')).toHaveLength(16);
  });
});
