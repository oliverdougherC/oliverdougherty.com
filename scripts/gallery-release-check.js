#!/usr/bin/env node
/**
 * Gallery release browser check (review F04–F08) against a DEPLOYED artifact.
 *
 *   BASE_URL=http://127.0.0.1:8000 BROWSER=chromium node scripts/gallery-release-check.js
 *
 * - Tests the built dist served at BASE_URL (default http://127.0.0.1:8000).
 *   If nothing answers and ./dist exists, a static server rooted at dist is
 *   started (and always cleaned up). The served directory is probed: anything
 *   under utilities-src/ answering 200 means the repo root is being served
 *   instead of the deploy artifact.
 * - BROWSER selects the Playwright bundled engine: chromium | firefox | webkit.
 *   Bundled executables only — no system "chrome" channel assumption.
 * - Desktop scenario performs a REAL navigate-away/back round trip, records
 *   pageshow.persisted, and requires real restoration in Chromium. Other engines
 *   report unverified restoration only when a minimal cacheable control also reloads. It then re-verifies keyboard, hash, resize relayout,
 *   scroll reveal, and focus-through-relayout on the restored document.
 * - Mobile scenario verifies semantic photo buttons, dialog focus entry/
 *   containment/return, Escape/arrows, touch swipe, rapid-swipe coalescing, and
 *   close-during-delayed-navigation cancellation.
* - Screenshots, console/pageerror logs, and a result summary land in
*   output/release/. Uncaught page exceptions and failed local assets fail
*   the run. Same-origin image loads abandoned by a navigate-away are
*   re-verified intact by fetch and recorded as interruptions, not failures.
 */

const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const http = require('node:http');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output/release');
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8000';
const BROWSER = (process.env.BROWSER || 'chromium').toLowerCase();
const NAV_TIMEOUT_MS = 30000;
const SCENARIO_WATCHDOG_MS = 180000;

const results = {
  base: BASE_URL,
  browser: BROWSER,
  browserVersion: null,
  startedAt: new Date().toISOString(),
  bfcache: { pageshowLog: [], persisted: null },
  scenarios: [],
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  resourceErrors: [],
  abortedImageLoads: []
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  results.logLines = (results.logLines || []).concat(line);
}

// Firefox reports an image fetch abandoned at navigate-away as
// "Image corrupt or truncated." A genuinely broken artifact cannot pass the
// same verification fetch below, so only fully served same-origin images are
// reclassified as interruptions.
const pendingImageVerifications = [];

async function servedImageIsIntact(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return false;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.byteLength) return false;
    if (/\.jpe?g$/i.test(new URL(url).pathname)) {
      // A complete JPEG ends with the EOI marker; an interrupted one cannot.
      return bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
    }
    return true;
  } catch {
    return false;
  }
}

function attachErrorWatch(page, origin, label) {
  page.on('pageerror', error => results.pageErrors.push({ scenario: label, message: error.message }));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const message = msg.text();
    const { url } = msg.location();
    if (/image corrupt or truncated/i.test(message) && url && url.startsWith(origin)) {
      const entry = { scenario: label, message, url };
      pendingImageVerifications.push(servedImageIsIntact(url).then(intact => {
        (intact ? results.abortedImageLoads : results.consoleErrors).push(entry);
      }));
      return;
    }
    results.consoleErrors.push({ scenario: label, message, url });
  });
  page.on('response', response => {
    if (response.status() >= 400) results.resourceErrors.push({ scenario: label, status: response.status(), url: response.url() });
  });
  page.on('requestfailed', request => {
    const reason = request.failure()?.errorText || '';
    if (!/abort|cancel/i.test(reason)) results.resourceErrors.push({ scenario: label, url: request.url(), reason });
  });
}

async function waitForVisiblePhotos(page) {
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('img')].filter(img => {
      const container = img.closest('.photo-media, .mobile-photo-button, .mobile-lightbox-media, .hero-feature-media') || img;
      const rect = container.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
    });
    return images.length > 0 && images.every(img => {
      const rect = img.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && img.complete && img.naturalWidth > 0 && Number(getComputedStyle(img).opacity) >= 0.99;
    });
  });
}

// Abandoned image loads poison the Firefox console as truncation errors and
// keep the departing document out of BFCache. Lazy images that never entered
// the viewport never start, and their `complete` stays false forever, so they
// are the only exempted ones.
function waitForStartedImageLoads(page) {
  return page.waitForFunction(() => [...document.querySelectorAll('img')].every(img => {
    if (img.complete) return true;
    if (img.loading !== 'lazy') return false;
    const rect = img.getBoundingClientRect();
    return !(rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth);
  }));
}

async function screenshot(page, name) {
  const target = path.join(OUTPUT_DIR, name);
  await page.screenshot({ path: target });
  results.screenshots.push(target);
}

async function newPageFor(context, origin, label) {
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  attachErrorWatch(page, origin, label);
  return page;
}

async function ensureServingDist() {
  let reachable = false;
  try {
    const probe = await fetch(`${BASE_URL}/pages/gallery/index.html`, { signal: AbortSignal.timeout(2500) });
    reachable = probe.ok;
  } catch (_error) {
    reachable = false;
  }

  if (!reachable) {
    const distDir = path.join(ROOT, 'dist');
    if (!fs.existsSync(distDir)) {
      throw new Error(
        `Nothing is serving ${BASE_URL} and ${distDir} does not exist. ` +
          'Run `npm run build:deploy` and serve dist (e.g. `npm run serve` with ' +
          'STATIC_ROOT=dist PORT=8000), or point BASE_URL at the deployment.'
      );
    }
    log(`BASE_URL ${BASE_URL} unreachable; starting local server rooted at dist/`);
    const server = await startLocalStaticServer({ url: BASE_URL, cwd: distDir, cacheControl: 'public, max-age=600' });
    try { await waitForServer(server.url, 10000); } catch (error) { server.kill(); throw error; }
    return { baseUrl: server.url.replace(/\/$/, ''), server };
  }

  return { baseUrl: BASE_URL, server: null };
}

async function verifyServedDirectoryIsDist(baseUrl) {
  const marker = await (await fetch(`${baseUrl}/release-artifact.json`)).json();
  assert(marker.kind === 'oliverdougherty-deploy', 'Missing deploy artifact marker');
  results.artifact = marker;
  // dist copies only shipped site roots; utilities-src/ exists solely in the
  // repository. A 200 there means the repo root is being served.
  const leaked = await fetch(`${baseUrl}/utilities-src/tests/galleryHarness.ts`, {
    signal: AbortSignal.timeout(5000)
  });
  if (leaked.status === 200) {
    throw new Error(
      `${baseUrl} serves the repository root (utilities-src/ is reachable). ` +
        'Serve the built dist directory for this check.'
    );
  }
  const required = [
    '/pages/gallery/index.html',
    '/mobile/gallery/index.html',
    '/assets/photos/photos.json',
    '/CNAME'
  ];
  for (const asset of required) {
    const response = await fetch(`${baseUrl}${asset}`, { signal: AbortSignal.timeout(5000) });
    assert(response.ok, `deploy artifact is missing ${asset} (status ${response.status})`);
  }
}

async function waitForGalleryReady(page) {
  await page.waitForFunction(
    () => {
      const cards = document.querySelectorAll('#galleryArchiveGrid .photo-card').length;
      const thumbs = document.querySelectorAll('#lightboxThumbStrip .lightbox-thumb').length;
      return cards > 0 && thumbs > cards && document.getElementById('galleryLoading')?.hidden === true;
    },
    null,
    { timeout: NAV_TIMEOUT_MS }
  );
}

// A minimal cacheable control distinguishes an engine/automation limitation
// from a cacheability regression in the site. Neither outcome is a BFCache pass.
async function probeCacheability(browser) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=600' });
    res.end('<!doctype html><title>Cache control</title><main>Cache control</main>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await browser.newContext();
    await context.addInitScript(() => { window.__cacheShows = []; addEventListener('pageshow', event => window.__cacheShows.push(event.persisted)); });
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url + '/a', { waitUntil: 'load' });
    await page.goto(url + '/b', { waitUntil: 'load' });
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.pathname === '/a' && document.readyState === 'complete' && window.__cacheShows?.length > 0);
    const shows = await page.evaluate(() => window.__cacheShows);
    results.bfcache.controlLog = shows;
    return shows.some(Boolean);
  } finally {
    await context?.close();
    server.closeAllConnections();
    server.close();
  }
}

async function runDesktopBfcacheScenario(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  const page = await newPageFor(context, new URL(baseUrl).origin, 'desktop-bfcache');
  try {
    // Record every pageshow before any page script runs; the listener itself
    // rides along inside the cached document across the trip.
    await page.addInitScript(() => {
      window.__pageshowLog = [];
      window.addEventListener('pageshow', (event) => {
        window.__pageshowLog.push({ persisted: Boolean(event.persisted) });
      });
    });

    await page.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
    await waitForGalleryReady(page);
    const unrevealed = await page.evaluate(() => [...document.querySelectorAll('.photo-card:not(.is-revealed)')].at(-1)?.dataset.entryId);
    assert(unrevealed, 'capture a not-yet-revealed card before leaving the hero');
    await page.waitForFunction(() => window.__pageshowLog.length > 0);
    await screenshot(page, `${BROWSER}-desktop-gallery-initial.png`);

    const initialLog = await page.evaluate(() => window.__pageshowLog);
    assert(initialLog.length >= 1, 'no pageshow recorded on the first load');
    assert(initialLog[0].persisted === false, 'first pageshow must not report persisted');

    // Real navigate-away and back, only once every started image load has
    // finished: abandoning one poisons the Firefox console and would keep the
    // departing document out of BFCache.
    await waitForStartedImageLoads(page);
    await page.goto(`${baseUrl}/pages/resume/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.pathname.endsWith('/pages/gallery/index.html') && document.readyState === 'complete' && window.__pageshowLog?.length > 0);
    await waitForGalleryReady(page);

    const pageshowLog = await page.evaluate(() => window.__pageshowLog);
    results.bfcache.pageshowLog = pageshowLog;
    const persisted = pageshowLog.some((entry) => entry.persisted);
    results.bfcache.persisted = persisted;
    log(`BFCache round trip recorded pageshow log ${JSON.stringify(pageshowLog)}`);
    if (!persisted) {
      const controlPersisted = await probeCacheability(browser);
      if (BROWSER === 'chromium' || controlPersisted) throw new Error('BFCache restoration was not exercised despite a required/capable engine');
      results.bfcache.status = 'not-exercised';
      results.bfcache.reason = 'The engine also reloaded a minimal cacheable control page; cached restoration is unverified here.';
      log(`UNVERIFIED BFCache: ${results.bfcache.reason}`);
    } else {
      results.bfcache.status = 'passed';
    }

    // Restored document: keyboard opens/closes/navigates the lightbox again.
    await page.locator('#galleryArchiveGrid .photo-card-button').first().click();
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden);
    const hashOpen = await page.evaluate(() => window.location.hash);
    assert(hashOpen.startsWith('#photo='), 'hash deep link missing after BFCache restore');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('lightbox').hidden);
    assert(
      (await page.evaluate(() => window.location.hash)) === '',
      'hash not cleared after restored Escape'
    );

    await page.locator('#galleryArchiveGrid .photo-card-button').first().click();
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden);
    const hashBeforeArrow = await page.evaluate(() => window.location.hash);
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      (previous) => window.location.hash !== previous,
      hashBeforeArrow,
      { timeout: 5000 }
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('lightbox').hidden);

    // Restored layout engine: focus a photo button, resize the real viewport,
    // and require both the mosaic re-solve and the same photo keeping focus.
    const focusedEntry = await page.evaluate(() => {
      const button = document.querySelectorAll('#galleryArchiveGrid .photo-card-button')[3];
      button.focus();
      return button.closest('.photo-card').dataset.entryId;
    });
    const geometryBefore = await page.evaluate(() => {
      const grid = document.getElementById('galleryArchiveGrid');
      return { height: grid.style.height, width: grid.clientWidth };
    });
    await page.setViewportSize({ width: 880, height: 900 });
    await page.waitForFunction(
      (before) => {
        const grid = document.getElementById('galleryArchiveGrid');
        return grid.style.height !== before.height && grid.clientWidth !== before.width;
      },
      geometryBefore,
      { timeout: 8000 }
    );
    const activeEntry = await page.evaluate(() => {
      const card = document.activeElement?.closest?.('.photo-card');
      return card ? card.dataset.entryId : String(document.activeElement?.tagName);
    });
    assert(
      activeEntry === focusedEntry,
      `focus not preserved through restored relayout: expected ${focusedEntry}, got ${activeEntry}`
    );

    await page.evaluate(id => [...document.querySelectorAll('.photo-card')].find(card => card.dataset.entryId === id).scrollIntoView(), unrevealed);
    await page.waitForFunction(id => [...document.querySelectorAll('.photo-card')].find(card => card.dataset.entryId === id)?.classList.contains('is-revealed'), unrevealed);
    await waitForVisiblePhotos(page);
    await page.waitForFunction(() => [...document.querySelectorAll('.photo-card')].filter(card => {
      const rect = card.getBoundingClientRect(); return rect.bottom > 0 && rect.top < innerHeight;
    }).every(card => card.classList.contains('is-loaded') && Number(getComputedStyle(card).opacity) >= 0.99));
    await screenshot(page, `${BROWSER}-desktop-gallery-restored.png`);

    // A second actual trip suspends a lightbox while its navigation fade is
    // pending. Cancellation must retain the selected photo and restore opacity.
    await page.locator('#galleryArchiveGrid .photo-card-button').first().click();
    await page.waitForFunction(() => document.getElementById('lightboxImage').naturalWidth > 0);
    const suspendedHash = await page.evaluate(() => location.hash);
    await page.evaluate(url => {
      document.getElementById('lightboxNext').click();
      location.href = url;
    }, `${baseUrl}/pages/resume/index.html`);
    await page.waitForURL('**/pages/resume/index.html', { waitUntil: 'networkidle' });
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => location.pathname.endsWith('/pages/gallery/index.html') && document.readyState === 'complete' && window.__pageshowLog?.length > 0);
    await waitForGalleryReady(page);
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden && getComputedStyle(document.getElementById('lightboxImage')).opacity === '1');
    assert(await page.evaluate(() => location.hash) === suspendedHash, 'pending navigation changed the selected photo during suspension');
    results.bfcache.pendingNavigationLog = await page.evaluate(() => window.__pageshowLog);
    if (BROWSER === 'chromium') assert(results.bfcache.pendingNavigationLog.filter(event => event.persisted).length >= 2, 'second trip must actually use BFCache');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('lightbox').hidden);

    // Deterministic supplement: a synthetic persisted pageshow must stay
    // idempotent — the runtime survives repeated restores without stacking.
    await page.evaluate(() => {
      window.dispatchEvent(
        new PageTransitionEvent('pageshow', { persisted: true })
      );
    });
    const stillSized = await page.evaluate(() =>
      parseFloat(document.getElementById('galleryArchiveGrid').style.height) > 0
    );
    assert(stillSized, 'synthetic re-restore damaged the layout');
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.waitForFunction(
      (previousWidth) => document.getElementById('galleryArchiveGrid').clientWidth !== previousWidth,
      880,
      { timeout: 8000 }
    );
  } finally {
    await context.close();
  }
}

async function runAspectFocusScenario(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  let releaseImages;
  const imagesReady = new Promise(resolve => { releaseImages = resolve; });
  try {
    // Real image responses with deliberately disagreeing metadata. Hold the
    // initial image loads until a real card button has focus.
    await context.route('**/assets/photos/photos.json', async route => {
      const response = await route.fetch();
      const manifest = await response.json();
      manifest.photos.forEach(photo => { photo.width = 1; photo.height = 3; });
      await route.fulfill({ response, json: manifest });
    });
    await context.route(/\/assets\/photos\/(?:medium|large|thumbs)\//, async route => { await imagesReady; await route.continue(); });
    const page = await newPageFor(context, new URL(baseUrl).origin, 'aspect-focus');
    await page.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
    await waitForGalleryReady(page);
    const button = await page.locator('#galleryArchiveGrid .photo-card-button').first().elementHandle();
    await button.focus();
    const before = await button.evaluate(node => { const card = node.closest('.photo-card'); return [card.style.width, card.querySelector('.photo-media').style.height]; });
    releaseImages();
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await button.evaluate(node => document.activeElement === node), 'image-load reconciliation lost photo focus');
    const after = await button.evaluate(node => { const card = node.closest('.photo-card'); return [card.style.width, card.querySelector('.photo-media').style.height]; });
    assert(JSON.stringify(before) !== JSON.stringify(after), 'image aspect reconciliation did not change the fixture geometry');

    await button.click();
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden);
    await page.setViewportSize({ width: 1200, height: 800 });
    assert(await page.evaluate(() => document.activeElement.id === 'lightboxClose'), 'relayout stole modal focus');
    await page.locator('#lightboxClose').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await button.evaluate(node => document.activeElement === node), 'deferred post-close relayout lost trigger focus');
    await screenshot(page, `${BROWSER}-gallery-aspect-reconciliation.png`);
  } finally {
    releaseImages();
    await context.close();
  }
}

async function dispatchTouch(page, selector, type, x, y) {
  await page.evaluate(
    ({ selector, type, x, y }) => {
      const target = document.querySelector(selector);
      let event;
      try {
        if (typeof window.Touch !== 'function' || typeof window.TouchEvent !== 'function') throw new Error('Touch constructor unavailable');
        const touch = new window.Touch({ identifier: 1, target, clientX: x, clientY: y });
        event = new window.TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === 'touchend' ? [] : [touch],
          targetTouches: [],
          changedTouches: [touch]
        });
      } catch {
        // Engine fallback: untrusted event carrying only what the
        // swipe handler reads.
        event = new Event(type, { bubbles: true, cancelable: true });
        const point = { identifier: 1, clientX: x, clientY: y };
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
        Object.defineProperty(event, 'changedTouches', { value: [point] });
      }
      target.dispatchEvent(event);
    },
    { selector, type, x, y }
  );
}

async function swipe(page, deltaX, deltaY = 0) {
  const media = '#mobileLightboxMedia';
  await dispatchTouch(page, media, 'touchstart', 200, 400);
  await dispatchTouch(page, media, 'touchmove', 200 - deltaX, 400 - deltaY);
  await dispatchTouch(page, media, 'touchend', 200 - deltaX, 400 - deltaY);
}

async function mobileState(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('mobileLightbox');
    const image = document.getElementById('mobileLightboxImage');
    const active = document.activeElement;
    return {
      open: !overlay.hasAttribute('hidden'),
      src: image.src || '',
      inertBackground: [...document.body.children]
        .filter((node) => node.id !== 'mobileLightbox')
        .every((node) => node.hasAttribute('inert')),
      activeId: active ? active.id || active.tagName : ''
    };
  });
}

async function runMobileScenario(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: BROWSER !== 'firefox',
    hasTouch: true,
    reducedMotion: 'no-preference'
  });
  const page = await newPageFor(context, new URL(baseUrl).origin, 'mobile');
  try {
    await page.goto(`${baseUrl}/mobile/gallery/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#mobileGalleryGrid button.mobile-photo-button', {
      timeout: NAV_TIMEOUT_MS
    });

    // Semantic, labeled controls with image selectors preserved.
    const semantics = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('#mobileGalleryGrid button.mobile-photo-button')];
      return {
        count: buttons.length,
        allLabels: buttons.every((button) => (button.getAttribute('aria-label') || '').startsWith('Open ')),
        imgIndexPreserved: Boolean(document.querySelector('#mobileGalleryGrid img[data-entry-index]')),
        dialogRole: document.getElementById('mobileLightbox').getAttribute('role')
      };
    });
    assert(semantics.count >= 20, `mobile grid incomplete (${semantics.count})`);
    assert(semantics.allLabels, 'every mobile photo button needs an accessible name');
    assert(semantics.imgIndexPreserved, 'img[data-entry-index] selectors must survive');
    assert(semantics.dialogRole === 'dialog', 'lightbox must stay a dialog');
    await waitForVisiblePhotos(page);
    await screenshot(page, `${BROWSER}-mobile-gallery-grid.png`);

    // Keyboard entry: focus a real button, Enter activates, focus moves into
    // the dialog, background is inert, Tab stays contained, Escape returns.
    await page.locator('#mobileGalleryGrid button.mobile-photo-button').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !document.getElementById('mobileLightbox').hidden);
    let state = await mobileState(page);
    assert(state.activeId === 'mobileLightboxClose', `focus did not enter dialog (${state.activeId})`);
    assert(state.inertBackground, 'background is interactive while the dialog is open');
    await page.keyboard.press('Tab');
    state = await mobileState(page);
    assert(state.activeId === 'mobileLightboxClose', 'Tab escaped the modal dialog');
    const srcBeforeArrow = await page.evaluate(
      () => document.getElementById('mobileLightboxImage').src
    );
    await page.keyboard.press('ArrowRight');
    const arrowAdvanced = await page
      .waitForFunction(
        (previous) => (document.getElementById('mobileLightboxImage').src || '') !== previous,
        srcBeforeArrow,
        { timeout: 5000 }
      )
      .then(() => true)
      .catch(() => false);
    assert(arrowAdvanced, 'ArrowRight did not change the dialog image');
    await screenshot(page, `${BROWSER}-mobile-gallery-lightbox.png`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mobileLightbox').hidden);
    state = await mobileState(page);
    assert(await page.evaluate(() => document.activeElement.dataset.entryIndex === '0'), 'focus not returned to the initiating photo');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !document.getElementById('mobileLightbox').hidden);
    await page.keyboard.press('Shift+Tab');
    assert((await mobileState(page)).activeId === 'mobileLightboxClose', 'Shift+Tab escaped the modal');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mobileLightbox').hidden);

    // Touch swipe opens → navigates; close mid-delay must stick (F07).
    await page.locator('#mobileGalleryGrid button.mobile-photo-button').first().click();
    await page.waitForFunction(() => !document.getElementById('mobileLightbox').hidden);
    const srcBeforeSwipe = await page.evaluate(() => document.getElementById('mobileLightboxImage').src);
    await swipe(page, 90);
    assert(
      (await page.evaluate(() => document.getElementById('mobileLightboxImage').style.opacity)) === '0',
      'swipe did not start a transition'
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(450);
    state = await mobileState(page);
    assert(!state.open, 'pending navigation reopened the dialog after close (F07 regression)');
    assert(state.src === srcBeforeSwipe, 'stale navigation mutated the image after close');

    // Rapid swipes: one destination per gesture, coalesced render.
    await page.locator('#mobileGalleryGrid button.mobile-photo-button').nth(1).click();
    await page.waitForFunction(() => !document.getElementById('mobileLightbox').hidden);
    const srcStart = await page.evaluate(() => document.getElementById('mobileLightboxImage').src);
    await swipe(page, 90);
    await swipe(page, 90);
    await swipe(page, 90);
    await page.waitForTimeout(450);
    const srcAfterRapid = await page.evaluate(() => document.getElementById('mobileLightboxImage').src);
    assert(srcAfterRapid !== srcStart, 'rapid swipes never committed');
    state = await mobileState(page);
    assert(state.open, 'rapid swipes must keep the dialog open');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('mobileLightbox').hidden);

    // Reopen a different photo after a cancelled pending navigation.
    await page.locator('#mobileGalleryGrid button.mobile-photo-button').first().click();
    await page.waitForFunction(() => !document.getElementById('mobileLightbox').hidden);
    await swipe(page, 90);
    await page.keyboard.press('Escape');
    await page.locator('#mobileGalleryGrid button.mobile-photo-button').nth(2).click();
    await page.waitForFunction(() => !document.getElementById('mobileLightbox').hidden);
    await page.waitForTimeout(400);
    const reopenState = await mobileState(page);
    assert(reopenState.open, 'reopen after cancelled navigation failed');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('#mobileGalleryGrid button.mobile-photo-button').first().click();
    const reducedSrc = await page.evaluate(() => document.getElementById('mobileLightboxImage').src);
    await page.keyboard.press('ArrowRight');
    const reduced = await page.evaluate(() => {
      const img = document.getElementById('mobileLightboxImage');
      return { src: img.src, opacity: img.style.opacity, duration: getComputedStyle(img).transitionDuration };
    });
    assert(reduced.src !== reducedSrc && reduced.opacity === '1' && reduced.duration.split(',').every(value => parseFloat(value) <= 0.001), `reduced-motion navigation must commit without an opacity delay: ${JSON.stringify({ before: reducedSrc, after: reduced })}`);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
}

async function runScenario(name, fn, browser, baseUrl) {
  const started = Date.now();
  const { promise, resolve, reject } = Promise.withResolvers();
  const watchdog = setTimeout(
    () => reject(new Error(`${name} exceeded ${SCENARIO_WATCHDOG_MS}ms`)),
    SCENARIO_WATCHDOG_MS
  );
  fn(browser, baseUrl).then(resolve, reject);
  try {
    await promise;
    results.scenarios.push({ name, status: 'pass', ms: Date.now() - started });
    log(`PASS ${name} (${Date.now() - started}ms)`);
  } catch (error) {
    results.scenarios.push({ name, status: 'fail', ms: Date.now() - started, error: String(error.message) });
    log(`FAIL ${name}: ${error.message}`);
  } finally {
    clearTimeout(watchdog);
  }
}

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!(BROWSER in playwright)) {
    throw new Error(`BROWSER must be one of chromium/firefox/webkit, got "${BROWSER}"`);
  }

  const serving = await ensureServingDist();
  const baseUrl = serving.baseUrl;
  results.base = baseUrl;
  let browser;
  try {
    log(`Testing deployed artifact at ${baseUrl}`);
    await verifyServedDirectoryIsDist(baseUrl);
    browser = await playwright[BROWSER].launch(BROWSER === 'chromium'
      ? { channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] }
      : {});
    results.browserVersion = browser.version();
    log(`Bundled ${BROWSER} ${results.browserVersion}`);
    await runScenario('desktop-gallery', runDesktopBfcacheScenario, browser, baseUrl);
    await runScenario('aspect-focus', runAspectFocusScenario, browser, baseUrl);
    await runScenario('mobile-accessibility', runMobileScenario, browser, baseUrl);
  } catch (error) {
    results.fatalError = error.message;
    throw error;
  } finally {
    await browser?.close();
    serving.server?.kill();
    results.finishedAt = new Date().toISOString();
    await Promise.all(pendingImageVerifications);
    results.failed = Boolean(results.fatalError) || results.scenarios.some(scenario => scenario.status === 'fail')
      || results.pageErrors.length > 0 || results.consoleErrors.length > 0 || results.resourceErrors.length > 0;
    fs.writeFileSync(path.join(OUTPUT_DIR, `gallery-release-check-${BROWSER}.json`), `${JSON.stringify(results, null, 2)}\n`);
  }

  if (results.pageErrors.length) {
    console.error('Uncaught page exceptions:', JSON.stringify(results.pageErrors, null, 2));
  }
  if (results.consoleErrors.length) {
    console.error('Local asset/script console errors:', JSON.stringify(results.consoleErrors, null, 2));
  }
  if (results.resourceErrors.length) console.error('Failed resources:', JSON.stringify(results.resourceErrors, null, 2));
  if (results.failed) {
    console.error(`Gallery release check FAILED (${BROWSER}). See output/release/.`);
    process.exit(1);
  }
  console.log(`Gallery release check passed (${BROWSER}). Results: output/release/gallery-release-check-${BROWSER}.json`);
}

main().catch((error) => {
  console.error('Gallery release check crashed:', error.message);
  process.exit(1);
});
