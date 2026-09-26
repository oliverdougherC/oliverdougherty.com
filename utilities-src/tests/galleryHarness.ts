/**
 * Shared JSDOM harness for the real js/gallery.js and js/mobile-gallery.js
 * (issue F04/F05 + issue #40 load contract). The fetch fake is route-driven
 * and AbortSignal-aware so suites can deterministically model hanging
 * requests, hanging response bodies, slow-but-successful responses, HTTP
 * errors, and network failures — and observe whether production code passed
 * and honored a cancellation signal.
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

/* ---- Issue #40 fake network ---- */

export type FetchRoute =
  /** Resolves `fetch`, then resolves `response.json()` after `bodyDelayMs`. */
  | { kind: 'json'; body: unknown; delayMs?: number; bodyDelayMs?: number; ignoreSignal?: boolean }
  /** Resolves `fetch`; the JSON body never settles (stalled stream). */
  | { kind: 'hangBody'; delayMs?: number; ignoreSignal?: boolean }
  /** The request never settles. */
  | { kind: 'hang'; ignoreSignal?: boolean }
  | { kind: 'status'; status: number; delayMs?: number; ignoreSignal?: boolean }
  /** Rejects `fetch` with a TypeError, like offline. */
  | { kind: 'network'; delayMs?: number; ignoreSignal?: boolean }
  /** Resolves ok; `response.json()` rejects (malformed payload). */
  | { kind: 'malformed'; delayMs?: number; ignoreSignal?: boolean };

export type NetworkRoutes = Partial<Record<'manifest' | 'sequence', FetchRoute>>;

export interface FetchCall {
  key: 'manifest' | 'sequence';
  /** True once the code aborted this request (timeout or superseded retry). */
  aborted: boolean;
  /** True when the code handed fetch() an AbortSignal for this request. */
  hasSignal: boolean;
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

function routeKeyFor(path: string): 'manifest' | 'sequence' {
  return String(path).endsWith('gallery-sequence.json') ? 'sequence' : 'manifest';
}

function installFakeFetch(
  win: HarnessWindow,
  routes: NetworkRoutes,
  calls: FetchCall[]
): void {
  const targets = win as unknown as StubTargets;
  // Mutable mid-flight so retry tests can restore the network between
  // attempts; an in-flight promise keeps the route it started with.
  targets.fetch = (path: string, init?: { signal?: AbortSignal }) => {
    const key = routeKeyFor(String(path));
    const route: FetchRoute = routes[key] ?? { kind: 'status', status: 404 };
    const signal = init?.signal ?? null;
    const call: FetchCall = { key, aborted: false, hasSignal: Boolean(signal) };
    calls.push(call);
    signal?.addEventListener('abort', () => {
      call.aborted = true;
    }, { once: true });

    const abortError = () => {
      const error = new Error('The user aborted a request.');
      error.name = 'AbortError';
      return error;
    };
    // Honor the signal like a real browser does — unless the route opts out
    // to model a fetch implementation that ignores cancellation.
    const raced = <T>(settle: () => Promise<T>): Promise<T> => {
      if (!signal) return settle();
      if (signal.aborted) return Promise.reject(abortError());
      if (route.ignoreSignal) return settle();
      return new Promise<T>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
        settle().then(resolve, reject);
      });
    };

    const respond = (): Promise<FakeResponse> => {
      switch (route.kind) {
        case 'json':
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              raced(() =>
                new Promise<unknown>((resolve) => {
                  setTimeout(() => resolve(route.body), route.bodyDelayMs ?? 0);
                })
              )
          });
        case 'hangBody':
          return Promise.resolve({
            ok: true,
            status: 200,
            // A stalled body outlives the signal here on purpose: production
            // code must bound it via its own race, not the transport.
            json: () => new Promise<unknown>(() => {})
          });
        case 'status':
          return Promise.resolve({
            ok: false,
            status: route.status,
            json: async () => null
          });
        case 'malformed':
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON at position 0'))
          });
        case 'network':
          return Promise.reject(new TypeError('Failed to fetch'));
        case 'hang':
        default:
          return new Promise<FakeResponse>(() => {});
      }
    };

    const delay = 'delayMs' in route ? route.delayMs : undefined;
    const started = delay ? new Promise<FakeResponse>((resolve) => setTimeout(resolve, delay)).then(respond) : respond();
    return raced(() => started);
  };
}

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

function defaultRoutes(options: { photos: unknown[]; sequence: unknown | null }): NetworkRoutes {
  const routes: NetworkRoutes = { manifest: { kind: 'json', body: { photos: options.photos } } };
  if (options.sequence) {
    routes.sequence = { kind: 'json', body: options.sequence };
  } else {
    routes.sequence = { kind: 'status', status: 404 };
  }
  return routes;
}

function installStubs(
  win: HarnessWindow,
  options: { photos: unknown[]; sequence: unknown | null; reducedMotion: boolean },
  routes: NetworkRoutes,
  calls: FetchCall[]
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

  installFakeFetch(win, routes, calls);

  return { ioInstances, roInstances };
}

export interface TimeoutOverrides {
  manifest?: number;
  sequence?: number;
}

function applyTimeoutHooks(win: HarnessWindow, key: string, timeouts?: TimeoutOverrides): void {
  if (!timeouts) return;
  (win as unknown as Record<string, unknown>)[key] = {
    manifest: timeouts.manifest ?? 8000,
    sequence: timeouts.sequence ?? 3000
  };
}

export interface DesktopHarness {
  dom: JSDOM;
  window: HarnessWindow;
  grid: HTMLElement;
  fetchCalls: FetchCall[];
  setRoute(key: 'manifest' | 'sequence', route: FetchRoute): void;
  clickRetry(): void;
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
  /** Issue #40: override the shipped fetch deadlines. */
  timeouts?: TimeoutOverrides;
  /** Issue #40: replace the default json/404 routes. */
  network?: NetworkRoutes;
  /** False returns before the first load settles (stall scenarios). */
  autoSettle?: boolean;
}): Promise<DesktopHarness> {
  let instances: {
    ioInstances: FakeIntersectionObserver[];
    roInstances: FakeResizeObserver[];
  } = { ioInstances: [], roInstances: [] };
  const fetchCalls: FetchCall[] = [];
  const routes: NetworkRoutes = { ...defaultRoutes({ photos: options.photos, sequence: options.sequence ?? null }), ...options.network };

  const dom = new JSDOM(DESKTOP_FIXTURE, {
    url: 'http://127.0.0.1:8000/pages/gallery/index.html',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    beforeParse(win) {
      const harnessWin = asHarnessWindow(win);
      applyTimeoutHooks(harnessWin, '__GALLERY_FETCH_TIMEOUTS__', options.timeouts);
      instances = installStubs(harnessWin, {
        photos: options.photos,
        sequence: options.sequence ?? null,
        reducedMotion: options.reducedMotion ?? true
      }, routes, fetchCalls);
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

  if (options.autoSettle !== false) {
    await waitUntil(() => {
      const loading = win.document.getElementById('galleryLoading');
      return loading?.hidden === true;
    }, 'gallery initialization to settle');
    await flushFrames(win);
  }

  return {
    dom,
    window: win,
    grid,
    fetchCalls,
    setRoute(key, route) {
      routes[key] = route;
    },
    clickRetry() {
      const control = win.document.querySelector<HTMLButtonElement | HTMLAnchorElement>(
        '#galleryRetryButton, .gallery-error-retry'
      );
      if (!control) throw new Error('Desktop retry control is not present');
      control.click();
    },
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
  fetchCalls: FetchCall[];
  setRoute(key: 'manifest' | 'sequence', route: FetchRoute): void;
  clickRetry(): void;
  swipe(deltaX: number, deltaY?: number): void;
  key(key: string, opts?: { shiftKey?: boolean }): void;
}

export async function loadMobileGallery(options: {
  photos: unknown[];
  sequence?: unknown;
  reducedMotion?: boolean;
  /** Issue #40: override the shipped fetch deadlines. */
  timeouts?: TimeoutOverrides;
  /** Issue #40: replace the default json/404 routes. */
  network?: NetworkRoutes;
  /** False returns before the first load settles (stall scenarios). */
  autoSettle?: boolean;
}): Promise<MobileHarness> {
  const fetchCalls: FetchCall[] = [];
  const routes: NetworkRoutes = { ...defaultRoutes({ photos: options.photos, sequence: options.sequence ?? null }), ...options.network };

  const dom = new JSDOM(MOBILE_FIXTURE, {
    url: 'http://127.0.0.1:8000/mobile/gallery/',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
    beforeParse(win) {
      const harnessWin = asHarnessWindow(win);
      applyTimeoutHooks(harnessWin, '__MOBILE_GALLERY_FETCH_TIMEOUTS__', options.timeouts);
      installStubs(harnessWin, {
        photos: options.photos,
        sequence: options.sequence ?? null,
        reducedMotion: options.reducedMotion ?? false
      }, routes, fetchCalls);
    }
  });
  const win = asHarnessWindow(dom.window);
  if (win.document.readyState === 'loading') {
    await new Promise<void>(resolve => win.document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  }

  win.eval(MOBILE_GALLERY_SOURCE);

  const grid = win.document.getElementById('mobileGalleryGrid') as HTMLElement;
  if (options.autoSettle !== false && options.photos.length > 0) {
    await waitUntil(
      () => grid.querySelectorAll('button.mobile-photo-button').length === options.photos.length,
      'mobile grid render'
    );
  }

  const overlay = win.document.getElementById('mobileLightbox') as HTMLElement;

  return {
    dom,
    window: win,
    grid,
    overlay,
    close: win.document.getElementById('mobileLightboxClose') as HTMLElement,
    image: win.document.getElementById('mobileLightboxImage') as HTMLImageElement,
    fetchCalls,
    setRoute(key, route) {
      routes[key] = route;
    },
    clickRetry() {
      const button = win.document.getElementById('mobileGalleryRetryButton') as HTMLButtonElement | null;
      if (!button) throw new Error('Mobile retry button is not present');
      button.click();
    },
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
