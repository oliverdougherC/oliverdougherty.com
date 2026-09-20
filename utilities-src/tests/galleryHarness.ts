/**
 * Shared JSDOM harness for the real js/gallery.js and js/mobile-gallery.js
 * sources. Loads the shipped scripts unmodified, stubs only browser APIs that
 * jsdom genuinely lacks (fetch, IntersectionObserver, ResizeObserver,
 * matchMedia control, element layout metrics), and drives the actual page
 * lifecycle events.
 */
import { readFileSync } from 'node:fs';
import { JSDOM, type DOMWindow } from 'jsdom';

const GALLERY_SOURCE = readFileSync(new URL('../../js/gallery.js', import.meta.url), 'utf8');
const MOBILE_GALLERY_SOURCE = readFileSync(new URL('../../js/mobile-gallery.js', import.meta.url), 'utf8');

// jsdom implements the full browser surface; @types/jsdom types the handle as
// DOMWindow, so adopt the standard global-constructor intersection (the
// documented jsdom pattern) once per loader instead of casting per use.
export type HarnessWindow = Window & typeof globalThis;

function asHarnessWindow(win: DOMWindow): HarnessWindow {
  return win as unknown as HarnessWindow;
}

export const DESKTOP_FIXTURE = readFileSync(new URL('../../pages/gallery/index.html', import.meta.url), 'utf8');
export const MOBILE_FIXTURE = readFileSync(new URL('../../mobile/gallery/index.html', import.meta.url), 'utf8');

export function makePhoto(id: string, aspect: number) {
  const largeWidth = 2400;
  const mediumWidth = 1600;
  const thumbWidth = 800;
  const variant = (width: number) => ({
    jpg: `${id}.jpg`,
    webp: `${id}.webp`,
    avif: `${id}.avif`,
    width,
    height: Math.round(width / aspect)
  });
  return {
    id,
    filename: `${id}.jpg`,
    title: `Photo ${id}`,
    displayTitle: `Photo ${id}`,
    width: largeWidth * 2,
    height: Math.round((largeWidth * 2) / aspect),
    thumbs: variant(thumbWidth),
    medium: variant(mediumWidth),
    large: variant(largeWidth),
    exif: { date: '2025-01-01' }
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Let jsdom's requestAnimationFrame chain (real timer, ~16ms/frame) drain. */
export function flushFrames(win: HarnessWindow, frames = 4): Promise<void> {
  return new Promise(resolve => {
    let remaining = frames;
    const tick = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else win.requestAnimationFrame(tick);
    };
    win.requestAnimationFrame(tick);
  });
}

export async function waitUntil(
  condition: () => boolean,
  label: string,
  timeoutMs = 2000
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await sleep(10);
  }
}

interface TouchPoint {
  clientX: number;
  clientY: number;
}

type IntersectionCallback = (
  entries: Array<{ target: Element; isIntersecting: boolean }>
) => void;

interface StubTargets {
  matchMedia: unknown;
  fetch: unknown;
  IntersectionObserver: unknown;
  ResizeObserver: unknown;
  Element: { prototype: { scrollIntoView?: () => void } };
}

class FakeIntersectionObserver {
  targets = new Set<Element>();
  disconnected = false;
  constructor(private callback: IntersectionCallback) {}
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }
  trigger() {
    this.callback([...this.targets].map((target) => ({ target, isIntersecting: true })));
  }
}

class FakeResizeObserver {
  targets: Element[] = [];
  disconnected = false;
  constructor(private callback: () => void) {}
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
    this.disconnected = true;
  }
  trigger() {
    this.callback();
  }
}

function installStubs(
  win: HarnessWindow,
  options: { photos: unknown[]; sequence: unknown | null; reducedMotion: boolean }
): { ioInstances: FakeIntersectionObserver[]; roInstances: FakeResizeObserver[] } {
  // jsdom's lib.dom types do not admit the simplified fakes installed here;
  // assign through a slot view instead of pretending they are API-compatible.
  const targets = win as unknown as StubTargets;
  const ioInstances: FakeIntersectionObserver[] = [];
  const roInstances: FakeResizeObserver[] = [];

  // jsdom ships no scrollIntoView; the gallery only uses it for thumb centering.
  targets.Element.prototype.scrollIntoView = function scrollIntoView() {};

  targets.matchMedia = (query: string) => ({
    media: query,
    matches: options.reducedMotion && query.includes('prefers-reduced-motion'),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false
  });

  targets.IntersectionObserver = class extends FakeIntersectionObserver {
    constructor(cb: IntersectionCallback) {
      super(cb);
      ioInstances.push(this);
    }
  };
  targets.ResizeObserver = class extends FakeResizeObserver {
    constructor(cb: () => void) {
      super(cb);
      roInstances.push(this);
    }
  };

  targets.fetch = async (path: string) => {
    if (path.endsWith('photos.json')) {
      return { ok: true, status: 200, json: async () => ({ photos: options.photos }) };
    }
    if (path.endsWith('gallery-sequence.json') && options.sequence) {
      return { ok: true, status: 200, json: async () => options.sequence };
    }
    return { ok: false, status: 404, json: async () => null };
  };

  return { ioInstances, roInstances };
}

export interface DesktopHarness {
  dom: JSDOM;
  window: HarnessWindow;
  grid: HTMLElement;
  setWidth(width: number): void;
  fireResize(): Promise<void>;
  firePageHide(): void;
  firePageShow(persisted: boolean): void;
  ioInstances(): FakeIntersectionObserver[];
  roInstances(): FakeResizeObserver[];
}

export async function loadDesktopGallery(options: {
  photos: unknown[];
  sequence?: unknown;
  width: number;
  reducedMotion?: boolean;
}): Promise<DesktopHarness> {
  let instances: {
    ioInstances: FakeIntersectionObserver[];
    roInstances: FakeResizeObserver[];
  } = { ioInstances: [], roInstances: [] };

  const dom = new JSDOM(DESKTOP_FIXTURE, {
    url: 'http://127.0.0.1:8000/pages/gallery/index.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    beforeParse(win) {
      instances = installStubs(asHarnessWindow(win), {
        photos: options.photos,
        sequence: options.sequence ?? null,
        reducedMotion: options.reducedMotion ?? true
      });
    }
  });
  const win = asHarnessWindow(dom.window);
  if (win.document.readyState === 'loading') {
    await new Promise<void>(resolve => win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  }

  const grid = win.document.getElementById('galleryArchiveGrid') as HTMLElement;
  let currentWidth = options.width;
  Object.defineProperty(grid, 'clientWidth', {
    configurable: true,
    get: () => currentWidth
  });

  win.eval(GALLERY_SOURCE);
  win.document.dispatchEvent(new win.Event('DOMContentLoaded'));

  await waitUntil(() => {
    const loading = win.document.getElementById('galleryLoading');
    return loading?.hidden === true;
  }, 'gallery initialization to settle');
  await flushFrames(win);

  return {
    dom,
    window: win,
    grid,
    setWidth(width: number) {
      currentWidth = width;
    },
    async fireResize() {
      win.dispatchEvent(new win.Event('resize'));
      await flushFrames(win);
    },
    firePageHide() {
      win.dispatchEvent(new win.Event('pagehide'));
    },
    firePageShow(persisted: boolean) {
      const event = new win.Event('pageshow');
      // jsdom ships no PageTransitionEvent constructor; the restore flag is a
      // plain property read by the gallery.
      const restoreEvent = event as Event & { persisted: boolean };
      restoreEvent.persisted = persisted;
      win.dispatchEvent(restoreEvent);
    },
    ioInstances: () => instances.ioInstances,
    roInstances: () => instances.roInstances
  };
}

export interface MobileHarness {
  dom: JSDOM;
  window: HarnessWindow;
  grid: HTMLElement;
  overlay: HTMLElement;
  close: HTMLElement;
  image: HTMLImageElement;
  swipe(deltaX: number, deltaY?: number): void;
  key(key: string, opts?: { shiftKey?: boolean }): void;
}

export async function loadMobileGallery(options: {
  photos: unknown[];
  sequence?: unknown;
  reducedMotion?: boolean;
}): Promise<MobileHarness> {
  const dom = new JSDOM(MOBILE_FIXTURE, {
    url: 'http://127.0.0.1:8000/mobile/gallery/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    beforeParse(win) {
      installStubs(asHarnessWindow(win), {
        photos: options.photos,
        sequence: options.sequence ?? null,
        reducedMotion: options.reducedMotion ?? false
      });
    }
  });
  const win = asHarnessWindow(dom.window);
  if (win.document.readyState === 'loading') {
    await new Promise<void>(resolve => win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  }

  win.eval(MOBILE_GALLERY_SOURCE);

  const grid = win.document.getElementById('mobileGalleryGrid') as HTMLElement;
  await waitUntil(
    () => grid.querySelectorAll('button.mobile-photo-button').length === options.photos.length,
    'mobile grid render'
  );

  const overlay = win.document.getElementById('mobileLightbox') as HTMLElement;

  return {
    dom,
    window: win,
    grid,
    overlay,
    close: win.document.getElementById('mobileLightboxClose') as HTMLElement,
    image: win.document.getElementById('mobileLightboxImage') as HTMLImageElement,
    swipe(deltaX: number, deltaY = 0) {
      // jsdom ships no TouchEvent constructor; the handler reads only
      // clientX/clientY from the touch lists.
      const start = new win.Event('touchstart');
      const startTouch = start as Event & { touches: TouchPoint[] };
      startTouch.touches = [{ clientX: 150, clientY: 150 }];
      overlay.dispatchEvent(startTouch);

      const end = new win.Event('touchend');
      const endTouch = end as Event & { changedTouches: TouchPoint[] };
      endTouch.changedTouches = [{ clientX: 150 - deltaX, clientY: 150 - deltaY }];
      overlay.dispatchEvent(endTouch);
    },
    key(key: string, opts: { shiftKey?: boolean } = {}) {
      const event = new win.KeyboardEvent('keydown', {
        key,
        bubbles: true,
        shiftKey: opts.shiftKey
      });
      win.document.dispatchEvent(event);
    }
  };
}

export function readRealManifest(): { photos: unknown[]; sequence: unknown } {
  const manifest = JSON.parse(
    readFileSync(new URL('../../assets/photos/photos.json', import.meta.url), 'utf8')
  ) as { photos: unknown[] };
  const sequence = JSON.parse(
    readFileSync(new URL('../../assets/photos/gallery-sequence.json', import.meta.url), 'utf8')
  );
  return { photos: manifest.photos, sequence };
}
