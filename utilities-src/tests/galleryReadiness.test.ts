import { loadDesktopGallery, makePhoto, sleep, waitUntil, type DesktopHarness } from './galleryHarness';

// These tests control network completion separately from decoding. The browser
// suite additionally checks painted intermediate frames against packaged dist.
describe('desktop gallery image readiness (#76)', () => {
  let h: DesktopHarness;
  const node = <T extends HTMLElement>(id: string) => h.window.document.getElementById(id) as T;
  const pending = () => h.window.document.querySelector<HTMLImageElement>('.lightbox-picture.is-preparing img')!;
  const displayed = () => node<HTMLImageElement>('lightboxImage');
  const key = (key: string) => h.window.document.dispatchEvent(new h.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const choose = (id: string) => h.window.document.querySelector<HTMLButtonElement>(`.lightbox-thumb[data-entry-id="${id}"]`)!.click();
  const flush = () => sleep(0);
  function loaded(image: HTMLImageElement, decode: Promise<void> = Promise.resolve()) {
    Object.defineProperty(image, 'naturalWidth', { configurable: true, value: 1600 });
    image.decode = () => decode;
    image.dispatchEvent(new h.window.Event('load'));
  }
  async function open(id = 'p0') {
    choose(id);
    loaded(pending());
    await flush();
  }

  beforeEach(async () => {
    h = await loadDesktopGallery({ photos: Array.from({ length: 5 }, (_, i) => makePhoto(`p${i}`, 1.5)), width: 1200, manualImages: true });
  });
  afterEach(() => h.dom.window.close());

  it('makes failed hero and archive previews recoverable without showing a broken image', () => {
    const hero = node<HTMLImageElement>('galleryHeroImage');
    hero.dispatchEvent(new h.window.Event('error'));
    expect(hero.classList.contains('is-loaded')).toBe(false);
    expect(node('galleryHeroError').hidden).toBe(false);
    expect(node('galleryHeroOpen').getAttribute('aria-label')).toContain('preview unavailable');
    const card = h.grid.querySelector<HTMLElement>('.photo-card')!;
    card.querySelector('img')!.dispatchEvent(new h.window.Event('load'));
    card.querySelector('img')!.dispatchEvent(new h.window.Event('error'));
    expect(card.classList.contains('is-loaded')).toBe(false);
    expect(card.querySelector<HTMLElement>('.photo-error-copy')?.hidden).toBe(false);
    (card.querySelector('.photo-card-button') as HTMLButtonElement).click();
    expect(node('lightbox').hidden).toBe(false);
    expect(pending()).not.toBeNull();
    hero.dispatchEvent(new h.window.Event('load'));
    card.querySelector('img')!.dispatchEvent(new h.window.Event('load'));
    expect(hero.hidden).toBe(false);
    expect(node('galleryHeroError').hidden).toBe(true);
    expect(card.querySelector<HTMLElement>('.photo-error-copy')?.hidden).toBe(true);
    expect(card.classList.contains('is-loaded')).toBe(true);
  });

  it('reveals the hero frame only after decode and clears readiness on failure', async () => {
    const hero = node<HTMLImageElement>('galleryHeroImage');
    let finish!: () => void;
    loaded(hero, new Promise<void>(resolve => { finish = resolve; }));
    expect(node('galleryHeroOpen').classList.contains('is-loaded')).toBe(false);
    finish();
    await flush();
    expect(node('galleryHeroOpen').classList.contains('is-loaded')).toBe(true);
    hero.dispatchEvent(new h.window.Event('error'));
    expect(node('galleryHeroOpen').classList.contains('is-loaded')).toBe(false);
  });

  it('keeps archive frame hidden through decode and ignores late readiness after an error', async () => {
    const card = h.grid.querySelector<HTMLElement>('.photo-card')!;
    const image = card.querySelector('img')!;
    let finish!: () => void;
    loaded(image, new Promise<void>(resolve => { finish = resolve; }));
    expect(card.classList.contains('is-loaded')).toBe(false);
    image.dispatchEvent(new h.window.Event('error'));
    finish();
    await flush();
    expect(card.classList.contains('is-loaded')).toBe(false);
    expect(card.querySelector<HTMLElement>('.photo-error-copy')!.hidden).toBe(false);
    loaded(image);
    await flush();
    expect(card.classList.contains('is-loaded')).toBe(true);
  });

  it('replaces decoded frames immediately even when motion is enabled', async () => {
    h.window.matchMedia = (query: string) => ({ matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
    const animate = vi.fn(() => ({ cancel() {}, finished: new Promise(() => {}) }));
    Object.defineProperty(h.window.Element.prototype, 'animate', { configurable: true, value: animate });
    await open();
    for (const direction of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft']) {
      const previous = displayed();
      key(direction);
      loaded(pending());
      await flush();
      expect(previous.isConnected).toBe(false);
      expect(node('lightboxMedia').querySelectorAll('picture')).toHaveLength(1);
      expect(animate).not.toHaveBeenCalled();
    }
  });

  it('keeps translated compact Details controls inert until expanded or the viewport widens', async () => {
    let compact = true;
    h.window.matchMedia = (query: string) => ({
      matches: query.includes('max-width: 900px') ? compact : query.includes('prefers-reduced-motion'),
      media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false
    });
    await open();
    const panel = node('lightboxPanel');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    node('lightboxInfoToggle').click();
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(node('lightboxInfoToggle').getAttribute('aria-expanded')).toBe('true');
    node('lightboxInfoToggle').click();
    expect(panel.hasAttribute('inert')).toBe(true);
    compact = false;
    h.window.dispatchEvent(new h.window.Event('resize'));
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.hasAttribute('aria-hidden')).toBe(false);
    compact = true;
    h.window.dispatchEvent(new h.window.Event('resize'));
    expect(panel.hasAttribute('inert')).toBe(true);
  });

  it('owns every Tab step and recovers focus when the browser skips buttons', async () => {
    h.window.matchMedia = (query: string) => ({
      matches: query.includes('max-width: 900px') || query.includes('prefers-reduced-motion'),
      media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false
    });
    // Model the compact layout; JSDOM does not calculate rendered visibility.
    Object.defineProperty(h.window.HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() { return this.id === 'lightboxPrev' || this.id === 'lightboxNext' ? null : this.parentElement; }
    });
    await open();
    const tab = (shiftKey = false) => {
      const event = new h.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true });
      h.window.document.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    };
    const details = node('lightboxInfoToggle');
    const close = node('lightboxClose');
    const thumbs = [...h.window.document.querySelectorAll<HTMLElement>('.lightbox-thumb')];
    close.focus();
    for (const thumb of thumbs) {
      tab();
      expect(h.window.document.activeElement).toBe(thumb);
    }
    tab();
    expect(h.window.document.activeElement).toBe(details);
    tab();
    expect(h.window.document.activeElement).toBe(close);
    tab(true);
    expect(h.window.document.activeElement).toBe(details);

    h.window.document.body.tabIndex = -1;
    h.window.document.body.focus();
    tab();
    expect(h.window.document.activeElement).toBe(details);
    h.window.document.body.focus();
    tab(true);
    expect(h.window.document.activeElement).toBe(thumbs.at(-1));

    const summary = h.window.document.createElement('summary');
    summary.textContent = 'Additional Info';
    const disclosure = h.window.document.createElement('details');
    disclosure.append(summary);
    node('lightboxMeta').append(disclosure);
    details.click();
    close.focus();
    tab();
    expect(h.window.document.activeElement).toBe(summary);
    for (const thumb of thumbs) {
      tab();
      expect(h.window.document.activeElement).toBe(thumb);
    }
    tab();
    expect(h.window.document.activeElement).toBe(details);
    tab(true);
    expect(h.window.document.activeElement).toBe(thumbs.at(-1));
  });

  it('navigates only completed single-touch horizontal swipes', async () => {
    await open();
    const point = (identifier: number, clientX: number, clientY: number) => ({ identifier, clientX, clientY, screenX: clientX, screenY: clientY });
    type Point = ReturnType<typeof point>;
    const touch = (type: string, touches: Point[], changedTouches: Point[] = touches) => {
      const event = new h.window.Event(type);
      Object.assign(event, { touches, changedTouches });
      node('lightboxMedia').dispatchEvent(event);
    };
    const start = point(7, 150, 150);
    const end = point(7, 50, 155);
    const errors: string[] = [];
    h.window.addEventListener('error', event => { errors.push(event.message); event.preventDefault(); });

    touch('touchstart', [start]);
    touch('touchend', [], [point(7, 50, 400)]); // Vertical dominance.
    expect(pending()).toBeNull();
    touch('touchstart', [start]);
    touch('touchstart', [start, point(8, 180, 150)]); // Second finger cancels.
    touch('touchend', [], [end]);
    expect(pending()).toBeNull();
    touch('touchstart', [start]);
    touch('touchcancel', [], [start]);
    touch('touchend', [], [end]);
    expect(pending()).toBeNull();
    touch('touchstart', [start]);
    touch('touchend', [], [point(9, 50, 155)]); // Wrong touch identity.
    expect(pending()).toBeNull();
    touch('touchstart', []);
    touch('touchend', [], []);
    expect(errors).toEqual([]);
    expect(pending()).toBeNull();

    touch('touchstart', [start]);
    h.firePageHide();
    h.firePageShow(true);
    touch('touchend', [], [end]);
    expect(pending()).toBeNull();
    touch('touchstart', [start]);
    key('Escape');
    await open('p0');
    touch('touchend', [], [end]);
    expect(pending()).toBeNull();

    touch('touchstart', [start]);
    touch('touchend', [], [end]);
    expect(pending().alt).toBe('Photo p1');
    loaded(pending());
    await flush();
    touch('touchstart', [end]);
    touch('touchend', [], [start]);
    expect(pending().alt).toBe('Photo p0');
  });

  it('shows an intentional first load, then keeps pixels and metadata until decode resolves', async () => {
    choose('p0');
    expect(node('lightboxStatus').textContent).toContain('Loading');
    expect(node('lightboxMedia').getAttribute('aria-busy')).toBe('true');
    loaded(pending());
    await flush();
    const outgoing = displayed();
    key('ArrowRight');
    const incoming = pending();
    let finishDecode!: () => void;
    loaded(incoming, new Promise<void>(resolve => { finishDecode = resolve; }));
    await flush();
    expect(displayed()).toBe(outgoing);
    expect(outgoing.isConnected).toBe(true);
    expect(outgoing.style.opacity).not.toBe('0');
    expect(node('lightboxTitle').textContent).toBe('Photo p0');
    expect(node('lightboxCounter').textContent).toBe('01 / 05');
    expect(h.window.location.hash).toBe('#photo=p0');
    finishDecode();
    await flush();
    expect(displayed()).toBe(incoming);
    expect(displayed().alt).toBe('Photo p1');
    expect(node('lightboxTitle').textContent).toBe('Photo p1');
    expect(node('lightboxCounter').textContent).toBe('02 / 05');
    expect(h.window.location.hash).toBe('#photo=p1');
    expect(node('lightboxMedia').getAttribute('aria-busy')).toBe('false');
    expect(h.window.document.querySelector('[aria-current="true"]')?.getAttribute('data-entry-id')).toBe('p1');
    expect(outgoing.isConnected).toBe(false);
  });

  it('accumulates rapid arrows, wraps, and lets only the latest decoded request commit', async () => {
    await open();
    key('ArrowRight');
    const abandoned = pending();
    let staleDecode!: () => void;
    loaded(abandoned, new Promise<void>(resolve => { staleDecode = resolve; }));
    key('ArrowRight');
    expect(pending().alt).toBe('Photo p2');
    key('ArrowLeft');
    expect(pending().alt).toBe('Photo p1');
    choose('p4');
    key('ArrowRight');
    expect(node('lightboxTitle').textContent).toBe('Photo p0');
    expect(pending()).toBeNull();
    staleDecode();
    await flush();
    expect(displayed().alt).toBe('Photo p0');
    key('ArrowLeft');
    loaded(pending());
    await flush();
    expect(displayed().alt).toBe('Photo p4');
    expect(h.window.document.querySelectorAll('.lightbox-picture')).toHaveLength(1);
  });

  it('preserves the valid frame on error and retries the requested target', async () => {
    await open();
    key('ArrowRight');
    pending().dispatchEvent(new h.window.Event('error'));
    expect(displayed().alt).toBe('Photo p0');
    expect(node('lightboxStatus').textContent).toContain('could not');
    expect(node('lightboxRetry').hidden).toBe(false);
    node('lightboxRetry').click();
    expect(pending().alt).toBe('Photo p1');
    loaded(pending());
    await flush();
    expect(displayed().alt).toBe('Photo p1');
    expect(node('lightboxRetry').hidden).toBe(true);
  });

  it('bounds stalled load/decode and keeps Escape working during recovery', async () => {
    (h.window as unknown as Record<string, unknown>).__GALLERY_IMAGE_TIMEOUT_MS__ = 25;
    choose('p0');
    loaded(pending(), new Promise<void>(() => {}));
    await waitUntil(() => !node('lightboxRetry').hidden, 'image deadline recovery');
    expect(node('lightboxStatus').textContent).toContain('could not');
    key('Escape');
    expect(node('lightbox').hidden).toBe(true);
    expect(h.window.document.querySelectorAll('.is-preparing')).toHaveLength(0);
  });

  it('invalidates pending decode on close/reopen and restores the original outside trigger', async () => {
    const trigger = h.grid.querySelector<HTMLButtonElement>('.photo-card-button')!;
    trigger.click();
    loaded(pending());
    await flush();
    choose('p2');
    let staleDecode!: () => void;
    loaded(pending(), new Promise<void>(resolve => { staleDecode = resolve; }));
    key('Escape');
    expect(h.window.document.activeElement).toBe(trigger);
    choose('p4');
    loaded(pending());
    await flush();
    staleDecode();
    await flush();
    expect(displayed().alt).toBe('Photo p4');
    expect(h.window.location.hash).toBe('#photo=p4');
  });

  it('routes history changes through readiness and ignores completions after pagehide', async () => {
    await open();
    key('ArrowRight');
    let staleDecode!: () => void;
    loaded(pending(), new Promise<void>(resolve => { staleDecode = resolve; }));
    h.window.location.hash = '#photo=p3';
    await waitUntil(() => pending()?.alt === 'Photo p3', 'history target');
    expect(displayed().alt).toBe('Photo p0');
    loaded(pending());
    await flush();
    expect(displayed().alt).toBe('Photo p3');
    key('ArrowRight');
    const suspended = pending();
    h.firePageHide();
    loaded(suspended);
    staleDecode();
    await flush();
    expect(displayed().alt).toBe('Photo p3');
    h.firePageShow(true);
    expect(displayed().alt).toBe('Photo p3');
  });
});
