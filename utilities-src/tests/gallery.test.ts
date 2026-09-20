/**
 * Regression coverage for js/gallery.js desktop lifecycle (review F04/F05):
 * BFCache suspend/restore, focus preservation across mosaic relayout, and
 * lightbox delayed-navigation cancellation. Runs the real shipped script
 * inside JSDOM against production-shaped markup.
 */
import {
  flushFrames,
  loadDesktopGallery,
  makePhoto,
  sleep,
  waitUntil,
  type DesktopHarness
} from './galleryHarness';

function photoSet(count: number, aspect = 1.5) {
  return Array.from({ length: count }, (_, index) => makePhoto(`p${index}`, aspect));
}

function cards(h: DesktopHarness) {
  return [...h.grid.querySelectorAll<HTMLElement>('.photo-card')];
}

function cardButtons(h: DesktopHarness) {
  return [...h.grid.querySelectorAll<HTMLElement>('.photo-card-button')];
}

function lightbox(h: DesktopHarness) {
  return h.window.document.getElementById('lightbox') as HTMLElement;
}

function pressKey(h: DesktopHarness, key: string) {
  h.window.document.dispatchEvent(
    new h.window.KeyboardEvent('keydown', { key, bubbles: true })
  );
}

async function openFirstCard(h: DesktopHarness) {
  const button = cardButtons(h)[0];
  button.click();
  await waitUntil(() => !lightbox(h).hasAttribute('hidden'), 'lightbox to open');
  return button;
}

describe('gallery BFCache lifecycle (F04)', () => {
  let h: DesktopHarness;

  beforeEach(async () => {
    h = await loadDesktopGallery({ photos: photoSet(7), width: 900, reducedMotion: false });
  });

  afterEach(() => {
    h.dom.window.close();
  });

  it('suspends the runtime on pagehide and restores it on persisted pageshow', async () => {
    // Baseline: keyboard dismissal works before any trip.
    await openFirstCard(h);
    pressKey(h, 'Escape');
    await waitUntil(() => lightbox(h).hasAttribute('hidden'), 'Escape to close lightbox');

    h.firePageHide();
    expect(h.roInstances()[0]?.disconnected).toBe(true);
    expect(h.ioInstances()[0]?.disconnected).toBe(true);

    // Static card bindings survive the persisted DOM: clicking still opens.
    const button = cardButtons(h)[1];
    button.click();
    await waitUntil(() => !lightbox(h).hasAttribute('hidden'), 'static click open');

    // Global keyboard listener is detached while suspended.
    pressKey(h, 'Escape');
    await sleep(80);
    expect(lightbox(h).hasAttribute('hidden')).toBe(false);

    // Closing via the statically bound button works and clears the hash.
    (h.window.document.getElementById('lightboxClose') as HTMLElement).click();
    await waitUntil(() => lightbox(h).hasAttribute('hidden'), 'close button while suspended');

    // The hash listener is detached while suspended.
    h.window.location.hash = '#photo=p3';
    await sleep(220);
    expect(lightbox(h).hasAttribute('hidden')).toBe(true);

    h.firePageShow(true);

    // Restore syncs the pending hash and re-arms keyboard navigation.
    await waitUntil(
      () =>
        !lightbox(h).hasAttribute('hidden') &&
        h.window.document.getElementById('lightboxTitle')?.textContent === 'Photo p3',
      'persisted restore to sync hash'
    );
    pressKey(h, 'Escape');
    await waitUntil(() => lightbox(h).hasAttribute('hidden'), 'restored Escape close');

    // Re-armed hashchange: a fresh hash opens the lightbox without a reload.
    h.window.location.hash = '#photo=p4';
    await waitUntil(
      () =>
        !lightbox(h).hasAttribute('hidden') &&
        h.window.document.getElementById('lightboxTitle')?.textContent === 'Photo p4',
      'restored hashchange sync'
    );

    // Re-armed arrow navigation.
    pressKey(h, 'ArrowRight');
    await sleep(240);
    expect(h.window.location.hash).toBe('#photo=p5');

    // Re-armed resize fallback: layout re-solves at the new width.
    // Close first: while the lightbox is open a plain resize defers by design.
    pressKey(h, 'Escape');
    await waitUntil(() => lightbox(h).hasAttribute('hidden'), 'Escape before resize');

    const before = h.grid.style.height;
    h.setWidth(1200);
    await h.fireResize();
    expect(h.grid.style.height).not.toBe(before);
    const widths = cards(h).map((card) => parseFloat(card.style.width));
    expect(Math.max(...widths)).toBeLessThanOrEqual(1200 + 2);

    // Re-armed scroll reveal: intersecting previously unrevealed cards get
    // revealed on the restored page (the suspend path disconnected the old
    // observer; resume installs a fresh one).
    const revealObserver = h.ioInstances().at(-1);
    if (!revealObserver) throw new Error('scroll reveal observer was not re-armed on restore');
    expect(revealObserver.targets.size).toBeGreaterThan(0);
    revealObserver.trigger();
    expect(cards(h).every((card) => card.classList.contains('is-revealed'))).toBe(true);
  });

  it('restores a visible image when suspension interrupts a navigation fade', async () => {
    await openFirstCard(h);
    const image = h.window.document.getElementById('lightboxImage') as HTMLImageElement;
    const hash = h.window.location.hash;
    pressKey(h, 'ArrowRight');
    expect(image.style.opacity).toBe('0');
    h.firePageHide();
    h.firePageShow(true);
    await sleep(240);
    expect(image.style.opacity).not.toBe('0');
    expect(h.window.location.hash).toBe(hash);
    expect(lightbox(h).hidden).toBe(false);
  });

  it('re-creates exactly one archive observer per restore and ignores fresh pageshows', async () => {
    expect(h.roInstances().length).toBe(1);

    // A fresh (non-persisted) pageshow must not re-bind anything.
    h.firePageShow(false);
    expect(h.roInstances().length).toBe(1);

    h.firePageHide();
    h.firePageShow(true);
    await flushFrames(h.window);
    expect(h.roInstances().length).toBe(2);

    h.firePageHide();
    h.firePageShow(true);
    await flushFrames(h.window);
    expect(h.roInstances().length).toBe(3);

    // Runtime still functional after repeated trips: one Escape closes once.
    h.window.location.hash = '#photo=p2';
    await waitUntil(() => !lightbox(h).hasAttribute('hidden'), 'hash open after two trips');
    pressKey(h, 'Escape');
    await waitUntil(
      () => lightbox(h).hasAttribute('hidden') && h.window.location.hash === '',
      'single Escape close after repeated trips'
    );

    // And resize handling did not stack: layout runs from the restored grid.
    h.setWidth(600);
    await h.fireResize();
    expect(parseFloat(h.grid.style.height)).toBeGreaterThan(0);
  });
});

describe('gallery relayout focus (F05)', () => {
  let h: DesktopHarness;

  beforeEach(async () => {
    h = await loadDesktopGallery({ photos: photoSet(7), width: 900, reducedMotion: true });
  });

  afterEach(() => {
    h.dom.window.close();
  });

  it('models focus loss on detach (jsdom stands in for the Chromium probe)', () => {
    const button = cardButtons(h)[2];
    button.focus();
    expect(h.window.document.activeElement).toBe(button);
    const card = button.closest('.photo-card') as HTMLElement;
    const holder = card.parentNode as Node;
    holder.removeChild(card);
    expect(h.window.document.activeElement).toBe(h.window.document.body);
    holder.appendChild(card);
  });

  it('keeps the same photo button focused across resize relayout', async () => {
    const button = cardButtons(h)[2];
    button.focus();

    h.setWidth(620);
    await h.fireResize();

    expect(h.window.document.activeElement).toBe(button);
    expect(button.getAttribute('aria-label')).toBe('Inspect Photo p3');
    const firstCard = h.grid.querySelector('.photo-card') as HTMLElement;
    expect(parseFloat(firstCard.style.width)).toBeLessThanOrEqual(620 + 2);
  });

  it('does not steal modal focus when an image-load relayout runs', async () => {
    await openFirstCard(h);
    const close = h.window.document.getElementById('lightboxClose') as HTMLElement;
    expect(h.window.document.activeElement).toBe(close);

    // A card image finishing load forces an aspect-reconciled relayout.
    const cardImage = cards(h)[3].querySelector('img') as HTMLImageElement;
    Object.defineProperty(cardImage, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(cardImage, 'naturalHeight', { value: 1000, configurable: true });
    cardImage.dispatchEvent(new h.window.Event('load'));
    await flushFrames(h.window);

    expect(h.window.document.activeElement).toBe(close);
  });

  it('keeps focus on the returned trigger through the deferred post-close relayout', async () => {
    const button = await openFirstCard(h);

    // Resize while open only marks the relayout pending.
    h.setWidth(700);
    h.window.dispatchEvent(new h.window.Event('resize'));
    await flushFrames(h.window);

    (h.window.document.getElementById('lightboxClose') as HTMLElement).click();
    await waitUntil(() => lightbox(h).hasAttribute('hidden'), 'close before deferred relayout');
    expect(h.window.document.activeElement).toBe(button);

    await flushFrames(h.window);
    expect(h.window.document.activeElement).toBe(button);
    expect(parseFloat(cards(h)[0].style.width)).toBeLessThanOrEqual(700 + 2);
  });

  it('cancels a pending desktop navigation when the lightbox closes', async () => {
    await openFirstCard(h);
    const hashBefore = h.window.location.hash;

    (h.window.document.getElementById('lightboxNext') as HTMLElement).click();
    (h.window.document.getElementById('lightboxClose') as HTMLElement).click();
    await sleep(300);

    expect(lightbox(h).hasAttribute('hidden')).toBe(true);
    expect(h.window.location.hash).toBe('');
    expect(hashBefore).toBe('#photo=p1');
  });
});
