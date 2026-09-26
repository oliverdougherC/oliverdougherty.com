/**
 * Issue #40 load-contract coverage for js/gallery.js and js/mobile-gallery.js:
 * bounded fetches (request AND body), bounded fallback to manifest order for
 * the optional sequence, a visible/retryable error state for the required
 * manifest, fresh-attempt retries that cancel in-flight work, and attempt
 * tokens so a late response cannot overwrite a newer attempt. Runs the real
 * shipped scripts in JSDOM against production markup with a signal-aware,
 * route-driven fetch fake; deadlines are shortened via the documented test
 * hooks so every scenario settles deterministically.
 */
import {
  loadDesktopGallery,
  loadMobileGallery,
  makePhoto,
  sleep,
  waitUntil,
  type DesktopHarness,
  type MobileHarness
} from './galleryHarness';

// Short, generous deadlines: real timers, but bounded waits so the suite
// proves the *bound* exists without coupling assertions to wall-clock tuning.
const FAST_TIMEOUTS = { manifest: 120, sequence: 60 };

function photoSet(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) => makePhoto(`${prefix}${index}`, 1.5));
}

/* ---- Desktop ---- */

function desktopError(h: DesktopHarness) {
  return h.window.document.getElementById('galleryError') as HTMLElement;
}

function desktopLoading(h: DesktopHarness) {
  return h.window.document.getElementById('galleryLoading') as HTMLElement;
}

function desktopCardIds(h: DesktopHarness) {
  return [...h.grid.querySelectorAll<HTMLElement>('.photo-card')].map((card) => card.dataset.entryId);
}

function desktopRetryButton(h: DesktopHarness) {
  return h.window.document.getElementById('galleryRetryButton') as HTMLButtonElement | null;
}

function retryDesktop(h: DesktopHarness) {
  (h.window as unknown as { __galleryRetry: () => void }).__galleryRetry();
}

describe('desktop gallery load contract (issue #40)', () => {
  let h: DesktopHarness;

  afterEach(() => {
    h?.dom.window.close();
  });

  it('renders in manifest order when the optional sequence request hangs', async () => {
    const photos = photoSet('p', 4);
    h = await loadDesktopGallery({
      photos,
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { sequence: { kind: 'hang' } },
      autoSettle: false
    });

    await waitUntil(
      () => desktopLoading(h).hidden === true && desktopCardIds(h).length === photos.length - 1,
      'gallery to render despite hung sequence'
    );
    // Bounded fallback: manifest order (first entry becomes the hero, not an
    // archive card), error state NOT shown, request aborted.
    expect(desktopCardIds(h)).toEqual(photos.slice(1).map((photo) => photo.id));
    expect(desktopError(h).hidden).toBe(true);
    const sequenceCall = h.fetchCalls.find((call) => call.key === 'sequence');
    expect(sequenceCall?.hasSignal).toBe(true);
    expect(sequenceCall?.aborted).toBe(true);
  });

  it('renders in manifest order when the sequence response body never completes', async () => {
    const photos = photoSet('p', 3);
    h = await loadDesktopGallery({
      photos,
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { sequence: { kind: 'hangBody' } },
      autoSettle: false
    });

    await waitUntil(
      () => desktopLoading(h).hidden === true && desktopCardIds(h).length === photos.length - 1,
      'gallery to render despite stalled sequence body'
    );
    expect(desktopCardIds(h)).toEqual(photos.slice(1).map((photo) => photo.id));
    expect(desktopError(h).hidden).toBe(true);
  });

  it('shows a visible, focused retry state when the required manifest request hangs', async () => {
    h = await loadDesktopGallery({
      photos: photoSet('p', 3),
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'hang' } },
      autoSettle: false
    });

    await waitUntil(() => desktopError(h).hidden === false, 'error state after manifest hang');
    expect(desktopLoading(h).hidden).toBe(true);
    expect(desktopError(h).getAttribute('role')).toBe('alert');
    const retry = desktopRetryButton(h);
    expect(retry).not.toBeNull();
    expect(h.window.document.activeElement).toBe(retry);
    const manifestCall = h.fetchCalls.find((call) => call.key === 'manifest');
    expect(manifestCall?.hasSignal).toBe(true);
    expect(manifestCall?.aborted).toBe(true);
  });

  it('shows the retry state when the manifest response body never completes', async () => {
    h = await loadDesktopGallery({
      photos: photoSet('p', 3),
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'hangBody' } },
      autoSettle: false
    });

    await waitUntil(() => desktopError(h).hidden === false, 'error state after manifest body stall');
    expect(desktopLoading(h).hidden).toBe(true);
    expect(desktopRetryButton(h)).not.toBeNull();
  });

  it('recovers via retry after the network returns, without a page reload', async () => {
    const photos = photoSet('p', 5);
    h = await loadDesktopGallery({
      photos,
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'network' } },
      autoSettle: false
    });

    await waitUntil(() => desktopError(h).hidden === false, 'error state while offline');
    expect(desktopCardIds(h)).toHaveLength(0);

    // Restore the network, then hit the error-state button — no reload.
    h.setRoute('manifest', { kind: 'json', body: { photos } });
    h.clickRetry();

    await waitUntil(() => desktopCardIds(h).length === photos.length - 1, 'retry to render the gallery');
    expect(desktopError(h).hidden).toBe(true);
    expect(desktopLoading(h).hidden).toBe(true);
  });

  it('treats a 404 manifest as a retryable error but a 404 sequence as manifest order', async () => {
    h = await loadDesktopGallery({
      photos: photoSet('p', 2),
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'status', status: 404 } },
      autoSettle: false
    });
    await waitUntil(() => desktopError(h).hidden === false, 'error state after manifest 404');
    expect(desktopRetryButton(h)).not.toBeNull();
    h.dom.window.close();

    // Sequence 404 is the harness default; autoSettle proves it renders.
    h = await loadDesktopGallery({ photos: photoSet('p', 2), width: 900, timeouts: FAST_TIMEOUTS });
    expect(desktopCardIds(h)).toEqual(['p1']);
    expect(desktopError(h).hidden).toBe(true);
  });

  it('rejects malformed manifest JSON into the error state and falls back on malformed sequence JSON', async () => {
    h = await loadDesktopGallery({
      photos: photoSet('p', 2),
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'malformed' } },
      autoSettle: false
    });
    await waitUntil(() => desktopError(h).hidden === false, 'error state after malformed manifest');
    h.dom.window.close();

    h = await loadDesktopGallery({
      photos: photoSet('p', 2),
      width: 900,
      timeouts: FAST_TIMEOUTS,
      network: { sequence: { kind: 'malformed' } }
    });
    expect(desktopCardIds(h)).toEqual(['p1']);
    expect(desktopError(h).hidden).toBe(true);
  });

  it('renders normally for slow-but-successful responses inside the deadline', async () => {
    const photos = photoSet('p', 3);
    h = await loadDesktopGallery({
      photos,
      width: 900,
      timeouts: { manifest: 2000, sequence: 2000 },
      network: {
        manifest: { kind: 'json', body: { photos }, delayMs: 40, bodyDelayMs: 40 },
        sequence: { kind: 'json', body: { items: [] }, delayMs: 40 }
      },
      autoSettle: false
    });

    await waitUntil(() => desktopCardIds(h).length === photos.length - 1, 'slow-but-successful render');
    expect(desktopError(h).hidden).toBe(true);
  });

  it('retry cancels the in-flight attempt and a late response cannot overwrite the newer attempt', async () => {
    const stale = photoSet('slow', 4);
    const fresh = photoSet('fast', 3);
    h = await loadDesktopGallery({
      photos: stale,
      width: 900,
      timeouts: { manifest: 2000, sequence: 2000 },
      // ignoreSignal: the transport keeps resolving even after abort, so the
      // only thing that can stop the stale attempt is the code's own token.
      network: { manifest: { kind: 'json', body: { photos: stale }, delayMs: 140, ignoreSignal: true } },
      autoSettle: false
    });

    await sleep(20);
    h.setRoute('manifest', { kind: 'json', body: { photos: fresh } });
    retryDesktop(h);

    // The first attempt's manifest request was aborted by the retry.
    expect(h.fetchCalls[0]?.key).toBe('manifest');
    expect(h.fetchCalls[0]?.aborted).toBe(true);

    await waitUntil(() => desktopCardIds(h).length === fresh.length - 1, 'newer attempt to render');
    // Let the stale attempt land past its delay, then re-assert: only the
    // newer attempt's data may be on screen.
    await sleep(200);
    expect(desktopCardIds(h)).toEqual(fresh.slice(1).map((photo) => photo.id));
    expect(desktopError(h).hidden).toBe(true);
  });
});

/* ---- Mobile ---- */

function mobileError(h: MobileHarness) {
  return h.window.document.getElementById('mobileGalleryError') as HTMLElement;
}

function mobileLoading(h: MobileHarness) {
  return h.window.document.getElementById('mobileGalleryLoading') as HTMLElement;
}

function mobileButtonCount(h: MobileHarness) {
  return h.grid.querySelectorAll('button.mobile-photo-button').length;
}

function mobileRetryButton(h: MobileHarness) {
  return h.window.document.getElementById('mobileGalleryRetryButton') as HTMLButtonElement | null;
}

function retryMobile(h: MobileHarness) {
  (h.window as unknown as { __mobileGalleryRetry: () => void }).__mobileGalleryRetry();
}

describe('mobile gallery load contract (issue #40)', () => {
  let h: MobileHarness;

  afterEach(() => {
    h?.dom.window.close();
  });

  it('renders in manifest order when the optional sequence request hangs', async () => {
    const photos = photoSet('p', 4);
    h = await loadMobileGallery({
      photos,
      timeouts: FAST_TIMEOUTS,
      network: { sequence: { kind: 'hang' } },
      autoSettle: false
    });

    await waitUntil(() => mobileButtonCount(h) === photos.length, 'mobile grid despite hung sequence');
    expect(mobileError(h).hasAttribute('hidden')).toBe(true);
    expect(mobileLoading(h).hasAttribute('hidden')).toBe(true);
    const sequenceCall = h.fetchCalls.find((call) => call.key === 'sequence');
    expect(sequenceCall?.hasSignal).toBe(true);
    expect(sequenceCall?.aborted).toBe(true);
  });

  it('renders in manifest order when the sequence response body never completes', async () => {
    const photos = photoSet('p', 3);
    h = await loadMobileGallery({
      photos,
      timeouts: FAST_TIMEOUTS,
      network: { sequence: { kind: 'hangBody' } },
      autoSettle: false
    });

    await waitUntil(() => mobileButtonCount(h) === photos.length, 'mobile grid despite stalled body');
    expect(mobileError(h).hasAttribute('hidden')).toBe(true);
  });

  it('shows a visible, focused retry state when the required manifest hangs', async () => {
    h = await loadMobileGallery({
      photos: photoSet('p', 3),
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'hang' } },
      autoSettle: false
    });

    await waitUntil(() => !mobileError(h).hasAttribute('hidden'), 'mobile error after manifest hang');
    expect(mobileLoading(h).hasAttribute('hidden')).toBe(true);
    expect(mobileError(h).getAttribute('role')).toBe('alert');
    const retry = mobileRetryButton(h);
    expect(retry).not.toBeNull();
    expect(h.window.document.activeElement).toBe(retry);
    const manifestCall = h.fetchCalls.find((call) => call.key === 'manifest');
    expect(manifestCall?.hasSignal).toBe(true);
    expect(manifestCall?.aborted).toBe(true);
  });

  it('recovers via retry after the network returns, without a page reload', async () => {
    const photos = photoSet('p', 4);
    h = await loadMobileGallery({
      photos,
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'network' } },
      autoSettle: false
    });

    await waitUntil(() => !mobileError(h).hasAttribute('hidden'), 'mobile error while offline');
    expect(mobileButtonCount(h)).toBe(0);

    h.setRoute('manifest', { kind: 'json', body: { photos } });
    h.clickRetry();

    await waitUntil(() => mobileButtonCount(h) === photos.length, 'mobile retry to render');
    expect(mobileError(h).hasAttribute('hidden')).toBe(true);
    // Delegated grid clicks survive the re-render: opening still works.
    h.grid.querySelector<HTMLButtonElement>('button.mobile-photo-button')?.click();
    await waitUntil(() => !h.overlay.hasAttribute('hidden'), 'lightbox after retry re-render');
  });

  it('surfaces 404 and malformed manifests as retryable errors, and malformed sequences as manifest order', async () => {
    h = await loadMobileGallery({
      photos: photoSet('p', 2),
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'status', status: 404 } },
      autoSettle: false
    });
    await waitUntil(() => !mobileError(h).hasAttribute('hidden'), 'mobile error after manifest 404');
    expect(mobileRetryButton(h)).not.toBeNull();
    h.dom.window.close();

    h = await loadMobileGallery({
      photos: photoSet('p', 2),
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'malformed' } },
      autoSettle: false
    });
    await waitUntil(() => !mobileError(h).hasAttribute('hidden'), 'mobile error after malformed manifest');
    h.dom.window.close();

    h = await loadMobileGallery({
      photos: photoSet('p', 2),
      timeouts: FAST_TIMEOUTS,
      network: { manifest: { kind: 'json', body: { photos: { invalid: true } } } },
      autoSettle: false
    });
    await waitUntil(() => !mobileError(h).hasAttribute('hidden'), 'mobile error after invalid manifest schema');
    h.dom.window.close();

    h = await loadMobileGallery({
      photos: photoSet('p', 2),
      timeouts: FAST_TIMEOUTS,
      network: { sequence: { kind: 'malformed' } }
    });
    expect(mobileButtonCount(h)).toBe(2);
    expect(mobileError(h).hasAttribute('hidden')).toBe(true);
  });

  it('retry cancels the in-flight attempt and a late response cannot overwrite the newer attempt', async () => {
    const stale = photoSet('slow', 5);
    const fresh = photoSet('fast', 2);
    h = await loadMobileGallery({
      photos: stale,
      timeouts: { manifest: 2000, sequence: 2000 },
      network: { manifest: { kind: 'json', body: { photos: stale }, delayMs: 140, ignoreSignal: true } },
      autoSettle: false
    });

    await sleep(20);
    h.setRoute('manifest', { kind: 'json', body: { photos: fresh } });
    retryMobile(h);

    expect(h.fetchCalls[0]?.key).toBe('manifest');
    expect(h.fetchCalls[0]?.aborted).toBe(true);

    await waitUntil(() => mobileButtonCount(h) === fresh.length, 'newer mobile attempt to render');
    await sleep(200);
    expect(mobileButtonCount(h)).toBe(fresh.length);
    const titles = [...h.grid.querySelectorAll<HTMLButtonElement>('button.mobile-photo-button')].map(
      (button) => button.getAttribute('aria-label')
    );
    expect(titles.every((title) => title?.includes('Photo fast'))).toBe(true);
  });

  it('shows a non-retryable empty state when the manifest has no photos', async () => {
    h = await loadMobileGallery({ photos: [], timeouts: FAST_TIMEOUTS, autoSettle: false });
    await waitUntil(() => !mobileError(h).hasAttribute('hidden'), 'mobile empty state');
    expect(mobileError(h).textContent).toContain('No photographs found');
    expect(mobileRetryButton(h)).toBeNull();
  });
});
