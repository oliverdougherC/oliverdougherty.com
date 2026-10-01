#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');
const { startGalleryNetworkFixture, holdResponseBody } = require('./lib/gallery-network-fixture');

const ROOT = path.resolve(__dirname, '..');
const requestedUrl = process.env.GALLERY_PREFETCH_URL || 'http://127.0.0.1:4173';
const fixturePhotos = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/photos/photos.json'), 'utf8')).photos.slice(0, 6);
// Chromium CDP profile: 100 ms RTT and 1.5 Mbit/s downstream. Fresh context
// gives a cold cache; reopening a viewed photo probes the same context warm.
const MOBILE_NETWORK = { offline: false, latency: 100, downloadThroughput: 187500, uploadThroughput: 75000 };

function imagePath(url) {
  return new URL(url).pathname;
}

async function installFixture(page, jpegOnly = false) {
  const photos = fixturePhotos.map(photo => {
    if (!jpegOnly) return photo;
    const jpegVariant = variant => ({ jpg: variant.jpg, width: variant.width, height: variant.height });
    return { ...photo, thumbs: jpegVariant(photo.thumbs), medium: jpegVariant(photo.medium), large: jpegVariant(photo.large) };
  });
  await page.route('**/assets/photos/photos.json', route => route.fulfill({ json: { photos } }));
  await page.route('**/assets/photos/gallery-sequence.json', route => route.fulfill({ json: { items: [] } }));
}

async function selectedMobileImage(page, photo, modern) {
  await page.waitForFunction(({ filename, modern }) => {
    const image = document.getElementById('mobileLightboxImage');
    const source = image?.currentSrc || '';
    const stem = filename.toLowerCase().replace(/\.jpe?g$/, '');
    return !document.getElementById('mobileLightbox').hidden && image.complete && image.naturalWidth > 0
      && (modern ? new RegExp('/' + stem + '\\.(avif|webp)$', 'i').test(source) : source.toLowerCase().endsWith('/' + filename.toLowerCase()));
  }, { filename: photo.medium.jpg, modern });
  return page.locator('#mobileLightboxImage').evaluate(image => ({
    currentSrc: image.currentSrc,
    srcset: image.getAttribute('srcset'),
    sizes: image.getAttribute('sizes'),
    focused: document.activeElement?.id
  }));
}

async function swipeMobile(page, direction = 1) {
  await page.evaluate(direction => {
    const target = document.getElementById('mobileLightboxMedia');
    const makeEvent = (type, x) => {
      const event = new Event(type, { bubbles: true });
      const point = { clientX: x, clientY: 400 };
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [point] });
      Object.defineProperty(event, 'changedTouches', { value: [point] });
      return event;
    };
    target.dispatchEvent(makeEvent('touchstart', 200));
    target.dispatchEvent(makeEvent('touchend', 200 - direction * 90));
  }, direction);
}

async function checkDedicatedMobile(browser, baseUrl, jpegOnly) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const requests = [];
  const transfers = [];
  if (browser.browserType().name() === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', MOBILE_NETWORK);
    const pending = new Map();
    cdp.on('Network.requestWillBeSent', event => {
      if (/\/assets\/photos\/(medium|large)\//.test(event.request.url)) {
        pending.set(event.requestId, { path: imagePath(event.request.url), encodedBytes: 0 });
      }
    });
    cdp.on('Network.loadingFinished', event => {
      const transfer = pending.get(event.requestId);
      if (!transfer) return;
      transfer.encodedBytes = event.encodedDataLength;
      transfers.push(transfer);
      pending.delete(event.requestId);
    });
  }
  page.on('request', request => {
    if (/\/assets\/photos\/(medium|large)\//.test(request.url())) requests.push(imagePath(request.url()));
  });
  try {
    await installFixture(page, jpegOnly);
    await page.goto(`${baseUrl}/mobile/gallery/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#mobileGalleryGrid button').nth(5).waitFor();
    requests.length = 0;
    await page.locator('#mobileGalleryGrid button').nth(2).click();
    const opened = await selectedMobileImage(page, fixturePhotos[2], !jpegOnly);
    assert.equal(opened.focused, 'mobileLightboxClose');
    if (jpegOnly) {
      assert.match(opened.srcset || '', /medium\/bridge\.jpg 1600w, .*large\/bridge\.jpg 2400w/);
      assert.match(opened.sizes, /100vw/, 'portrait-aware sizes must retain viewport selection for landscape images');
      assert.match(opened.currentSrc, /\/medium\/bridge\.jpg$/);
    }
    await swipeMobile(page);
    const next = await selectedMobileImage(page, fixturePhotos[3], !jpegOnly);
    assert.notEqual(next.currentSrc, opened.currentSrc);
    await swipeMobile(page);
    await swipeMobile(page);
    await swipeMobile(page);
    const rapid = await selectedMobileImage(page, fixturePhotos[0], !jpegOnly);
    assert.notEqual(rapid.currentSrc, next.currentSrc);
    await page.locator('#mobileLightboxClose').click();
    await page.locator('#mobileLightbox').waitFor({ state: 'hidden' });
    await page.locator('#mobileGalleryGrid button').nth(4).click();
    const reopened = await selectedMobileImage(page, fixturePhotos[4], !jpegOnly);
    assert.equal(reopened.focused, 'mobileLightboxClose');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // The selected image is ready and request starts have crossed two frames.
    // Rapid navigation intentionally cancels superseded loads; waiting for all
    // unrelated page channels to become idle is not this request-format check.
    const jpegs = requests.filter(url => /\.jpe?g$/.test(url));
    if (!jpegOnly) assert.deepEqual(jpegs, [], `Unused mobile JPEG requests: ${jpegs.join(', ')}`);
    else assert(jpegs.every(url => [2, 3, 4, 5, 0].some(index => url.endsWith('/' + fixturePhotos[index].medium.jpg) || url.endsWith('/' + fixturePhotos[index].large.jpg))),
      `JPEG-only navigation fetched a photo never requested by any gesture: ${jpegs.join(', ')}`);
    const byteCount = transfers.reduce((sum, transfer) => sum + transfer.encodedBytes, 0);
    const profile = browser.browserType().name() === 'chromium'
      ? `100ms RTT, 1.5Mbit/s; ${byteCount} completed encoded bytes`
      : 'transfer bytes unavailable outside Chromium';
    console.log(`Dedicated mobile ${jpegOnly ? 'JPEG-only' : 'modern'} (routed fixture disables HTTP cache; ${profile}): ${requests.length} medium/large requests, JPEG ${jpegs.length}; close/reopen selected ${imagePath(reopened.currentSrc)}.`);
    for (const transfer of transfers) console.log(`  ${transfer.path}: ${transfer.encodedBytes} encoded bytes`);
  } finally {
    await context.close();
  }
}

async function checkDesktopFilmstrip(browser, baseUrl, jpegOnly) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const thumbRequests = [];
  const transfers = [];
  page.on('request', request => {
    if (/\/assets\/photos\/thumbs\//.test(request.url())) thumbRequests.push(imagePath(request.url()));
  });
  if (browser.browserType().name() === 'chromium') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', MOBILE_NETWORK);
    const pending = new Map();
    cdp.on('Network.requestWillBeSent', event => {
      if (/\/assets\/photos\/thumbs\//.test(event.request.url)) pending.set(event.requestId, imagePath(event.request.url));
    });
    cdp.on('Network.loadingFinished', event => {
      const image = pending.get(event.requestId);
      if (!image) return;
      transfers.push({ path: image, encodedBytes: event.encodedDataLength });
      pending.delete(event.requestId);
    });
  }
  try {
    await installFixture(page, jpegOnly);
    await page.goto(`${baseUrl}/pages/gallery/index.html?full=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('galleryHeroImage')?.naturalWidth > 0);
    await page.locator('#galleryHeroOpen').click();
    await page.locator('#lightboxThumbStrip .lightbox-thumb').nth(5).waitFor();
    const thumb = page.locator('#lightboxThumbStrip .lightbox-thumb').nth(2);
    await thumb.scrollIntoViewIfNeeded();
    await thumb.click();
    await page.waitForFunction(() => document.querySelector('#lightboxThumbStrip .lightbox-thumb.is-active')?.dataset.entryId === 'bridge');
    await page.waitForFunction(jpegOnly => {
      const src = document.getElementById('lightboxImage').currentSrc;
      return jpegOnly ? /\/bridge\.jpg$/.test(src) : /\/bridge\.(avif|webp)$/.test(src);
    }, jpegOnly);
    await page.waitForFunction(() => document.querySelector('#lightboxThumbStrip .lightbox-thumb[data-entry-id="bridge"] img')?.naturalWidth > 0);
    const state = await thumb.evaluate(button => ({
      selected: button.classList.contains('is-active'),
      currentSrc: button.querySelector('img').currentSrc,
      avif: button.querySelector('source[type="image/avif"]')?.srcset,
      webp: button.querySelector('source[type="image/webp"]')?.srcset,
      focused: document.activeElement?.id,
      focusedInDialog: document.getElementById('lightbox').contains(document.activeElement),
      lightboxSrc: document.getElementById('lightboxImage').currentSrc
    }));
    assert(state.selected);
    assert.match(state.currentSrc, jpegOnly ? /\/thumbs\/bridge\.jpg$/ : /\/thumbs\/bridge\.(avif|webp)$/);
    if (jpegOnly) {
      assert.equal(state.avif, undefined);
      assert.equal(state.webp, undefined);
    } else {
      assert.match(state.avif || '', /\/thumbs\/bridge\.avif$/);
      assert.match(state.webp || '', /\/thumbs\/bridge\.webp$/);
    }
    assert(state.focusedInDialog, 'thumbnail selection must retain focus inside the dialog');
    assert.match(state.lightboxSrc, jpegOnly ? /\/bridge\.jpg$/ : /\/bridge\.(avif|webp)$/);
    await page.locator('#lightboxThumbStrip img').evaluateAll(images => Promise.all(images.map(image => image.decode().catch(() => {}))));
    await page.waitForLoadState('networkidle');
    const wrongFormat = thumbRequests.filter(url => jpegOnly ? !/\.jpe?g$/.test(url) : /\.jpe?g$/.test(url));
    assert.deepEqual(wrongFormat, [], `Desktop filmstrip fetched unused thumbnail formats: ${wrongFormat.join(', ')}`);
    const profile = browser.browserType().name() === 'chromium'
      ? `100ms RTT, 1.5Mbit/s; ${transfers.reduce((sum, transfer) => sum + transfer.encodedBytes, 0)} completed encoded bytes`
      : 'transfer bytes unavailable outside Chromium';
    console.log(`Desktop filmstrip ${jpegOnly ? 'JPEG-only' : 'modern'} (routed fixture disables HTTP cache; ${profile}): selected ${imagePath(state.currentSrc)}, focus ${state.focused}; ${thumbRequests.length} thumb requests, ${wrongFormat.length} unused fallback requests.`);
    for (const transfer of transfers) console.log(`  ${transfer.path}: ${transfer.encodedBytes} encoded bytes`);
  } finally {
    await context.close();
  }
}

// Observe the browser's actual request lifetime, including failed requests. A
// cumulative URL count cannot detect a scheduler that starts too much at once.
function trackThumbnailRequests(page) {
  const active = new Set();
  const requests = [];
  let maximum = 0;
  page.on('request', request => {
    if (!/\/assets\/photos\/thumbs\//.test(request.url())) return;
    active.add(request);
    requests.push(request);
    maximum = Math.max(maximum, active.size);
  });
  const finish = request => active.delete(request);
  page.on('requestfinished', finish);
  page.on('requestfailed', finish);
  return {
    active, requests,
    assertBound() {
      assert(maximum <= 2, `Background thumbnails reached ${maximum} concurrent requests (limit 2)`);
    },
    get maximum() { return maximum; }
  };
}

async function checkMobileThumbnailScheduling(browser, baseUrl) {
  const heldThumbnails = [];
  const heldViewer = [];
  let holdThumbnails = true;
  const fixture = await startGalleryNetworkFixture(baseUrl, ({ request, response, upstream }) => {
    const pathname = new URL(request.url, baseUrl).pathname;
    if (/\/assets\/photos\/thumbs\//.test(pathname) && holdThumbnails) {
      heldThumbnails.push(holdResponseBody({ response, upstream }));
      return true;
    }
    if (/\/assets\/photos\/(medium|large)\//.test(pathname)) {
      heldViewer.push(holdResponseBody({ response, upstream }));
      return true;
    }
    return false;
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const thumbnails = trackThumbnailRequests(page);
  const settleFrames = () => page.evaluate(() => new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 10000;
    while (!predicate() && Date.now() < deadline) await page.waitForTimeout(20);
    assert(predicate(), message);
  };
  try {
    // Server-side body holds preserve native browser requests, priorities and
    // cancellation. This fault-injection context never measures warm cache.
    await page.goto(`${fixture.url}/mobile/gallery/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#mobileGalleryGrid button').first().waitFor();
    await waitFor(() => heldThumbnails.length >= 2, 'two background thumbnails must begin');
    await Promise.all(heldThumbnails.map(held => held.started));
    await settleFrames();
    thumbnails.assertBound();
    const startedBeforeOpen = thumbnails.requests.length;
    assert.equal(thumbnails.active.size, 2, 'the probe must open during two in-flight thumbnails');

    await page.locator('#mobileGalleryGrid button').first().evaluate(button => button.click());
    await waitFor(() => heldViewer.length > 0, 'opening must start a high-priority viewer request');
    await Promise.all(heldViewer.map(held => held.started));
    assert.equal(await page.locator('#mobileLightboxMedia').getAttribute('aria-busy'), 'true');

    // Let the old requests complete in either order while the viewer body is
    // still held. Every completed slot must stay idle until the viewer closes.
    holdThumbnails = false;
    heldThumbnails.forEach(held => held.release());
    await waitFor(() => thumbnails.active.size === 0, 'already-started thumbnails may finish while the viewer loads');
    await settleFrames();
    assert.equal(thumbnails.requests.length, startedBeforeOpen,
      'opening the viewer must immediately stop new thumbnails before viewer readiness');
    heldViewer.forEach(held => held.release());
    await page.waitForFunction(() => document.getElementById('mobileLightboxImage').naturalWidth > 0
      && document.getElementById('mobileLightboxMedia').getAttribute('aria-busy') === 'false');
    await settleFrames();
    assert.equal(thumbnails.requests.length, startedBeforeOpen,
      'thumbnail scheduling must stay paused after the viewer becomes ready');

    // Hold the resumed requests too, making concurrent starts observable even
    // on a fast loopback server. Existing unstarted visible cells remain queued.
    holdThumbnails = true;
    await page.locator('#mobileLightboxClose').click();
    await waitFor(() => thumbnails.requests.length > startedBeforeOpen,
      'closing the viewer must resume pending thumbnail requests');
    await settleFrames();
    thumbnails.assertBound();
    heldThumbnails.forEach(held => held.release());
    console.log(`Mobile thumbnail scheduler (${browser.browserType().name()}, server-held bodies, no browser routing): maximum ${thumbnails.maximum} concurrent; zero new starts while viewer pending/open; resumed after close.`);
  } finally {
    await context.close();
    await fixture.close();
  }
}

async function traceUnroutedMobileCache(browser, baseUrl) {
  if (browser.browserType().name() !== 'chromium') return;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const pending = new Map();
  const transfers = [];
  const thumbnails = trackThumbnailRequests(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', MOBILE_NETWORK);
  cdp.on('Network.requestWillBeSent', event => {
    if (/\/assets\/photos\/(medium|large)\//.test(event.request.url)) {
      pending.set(event.requestId, { path: imagePath(event.request.url), encodedBytes: 0, cached: false });
    }
  });
  cdp.on('Network.requestServedFromCache', event => {
    if (pending.has(event.requestId)) pending.get(event.requestId).cached = true;
  });
  cdp.on('Network.loadingFinished', event => {
    const transfer = pending.get(event.requestId);
    if (!transfer) return;
    transfer.encodedBytes = event.encodedDataLength;
    transfers.push(transfer);
    pending.delete(event.requestId);
  });
  try {
    await page.goto(`${baseUrl}/mobile/gallery/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#mobileGalleryGrid button').first().waitFor();
    const openStarted = Date.now();
    const openedAt = await page.locator('#mobileGalleryGrid button').first().evaluate(button => {
      button.click();
      return performance.timeOrigin + performance.now();
    });
    await page.waitForFunction(() => document.getElementById('mobileLightboxImage').naturalWidth > 0
      && document.getElementById('mobileLightboxMedia').getAttribute('aria-busy') === 'false');
    const coldReadyMs = Date.now() - openStarted;
    thumbnails.assertBound();
    const coldThumbnailCount = thumbnails.requests.length;
    const firstSrc = await page.locator('#mobileLightboxImage').evaluate(image => image.currentSrc);
    await page.waitForLoadState('networkidle');
    const cold = transfers.slice();
    const whileOpen = thumbnails.requests.filter(request => request.timing().startTime >= openedAt);
    assert.deepEqual(whileOpen.map(request => imagePath(request.url())), [],
      'No background thumbnail may start while the cold viewer is open, including before image readiness');
    await page.locator('#mobileLightboxClose').click();
    await page.locator('#mobileGalleryGrid button').first().click();
    await page.waitForFunction(() => document.getElementById('mobileLightboxImage').naturalWidth > 0
      && document.getElementById('mobileLightboxMedia').getAttribute('aria-busy') === 'false');
    const secondSrc = await page.locator('#mobileLightboxImage').evaluate(image => image.currentSrc);
    assert.equal(secondSrc, firstSrc, 'Warm reopen selected another image');
    await page.waitForLoadState('networkidle');
    const warm = transfers.slice(cold.length);
    thumbnails.assertBound();
    console.log(`Unrouted mobile cache probe (100ms RTT, 1.5Mbit/s): ${imagePath(firstSrc)}; ready ${coldReadyMs}ms, ${coldThumbnailCount} thumbnail requests, maximum ${thumbnails.maximum} concurrent; cold ${cold.length} requests/${cold.reduce((sum, item) => sum + item.encodedBytes, 0)} encoded bytes; warm ${warm.length} requests/${warm.reduce((sum, item) => sum + item.encodedBytes, 0)} encoded bytes.`);
    for (const transfer of [...cold, ...warm]) console.log(`  ${transfer.path}: ${transfer.encodedBytes} encoded bytes${transfer.cached ? ' (cache)' : ''}`);
  } finally {
    await context.close();
  }
}

async function checkViewport(browser, baseUrl, viewport, deviceScaleFactor) {
  const context = await browser.newContext({ viewport, deviceScaleFactor });
  const page = await context.newPage();
  const imageRequests = [];
  page.on('request', request => {
    if (/\/assets\/photos\/(large|medium)\//.test(request.url())) imageRequests.push(request.url());
  });
  try {
    await page.goto(`${baseUrl}/pages/gallery/index.html?full=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('galleryHeroImage')?.naturalWidth > 0);
    imageRequests.length = 0;
    await page.locator('#galleryHeroOpen').click();
    await page.waitForFunction(() => !document.getElementById('lightbox').hidden
      && document.getElementById('lightboxImage')?.naturalWidth > 0);
    const displayed = [];
    for (let index = 0; index < 4; index++) {
      const currentSrc = await page.locator('#lightboxImage').evaluate(image => image.currentSrc);
      displayed.push(currentSrc);
      assert(/\.(avif|webp)(?:[?#]|$)/.test(currentSrc),
        `Expected a selected modern source, got ${currentSrc}`);
      if (index === 3) break;
      if (viewport.width < 900) await page.keyboard.press('ArrowRight');
      else await page.locator('#lightboxNext').click();
      await page.waitForFunction(previous => {
        const image = document.getElementById('lightboxImage');
        return image && image.currentSrc !== previous && image.complete && image.naturalWidth > 0;
      }, currentSrc);
    }
    for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => {
      const image = document.getElementById('lightboxImage');
      return image?.complete && image.naturalWidth > 0;
    });
    // Allow any speculative requests queued by the last navigation to start.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const unusedJpegs = imageRequests.filter(url => /\/assets\/photos\/large\/[^/]+\.jpe?g(?:[?#]|$)/.test(url));
    assert.deepEqual(unusedJpegs, [],
      `Lightbox transferred JPEGs that its responsive picture did not display: ${unusedJpegs.join(', ')}`);
    assert.equal(new Set(displayed).size, 4, 'Lightbox next navigation did not display four distinct photos');
    console.log(`${viewport.width}px @${deviceScaleFactor}x: ${displayed.length} displayed modern images, ${imageRequests.length} medium/large image requests, no unused large JPEG.`);
  } finally {
    await context.close();
  }
}

async function run() {
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.GALLERY_PREFETCH_URL), cacheControl: 'public, max-age=3600' });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browser;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true });
    await checkViewport(browser, baseUrl, { width: 1440, height: 900 }, 1);
    await checkViewport(browser, baseUrl, { width: 390, height: 844 }, 2);
    const failures = [];
    for (const check of [
      () => checkDedicatedMobile(browser, baseUrl, false),
      () => checkDedicatedMobile(browser, baseUrl, true),
      () => checkDesktopFilmstrip(browser, baseUrl, false),
      () => checkDesktopFilmstrip(browser, baseUrl, true),
      () => checkMobileThumbnailScheduling(browser, baseUrl),
      () => traceUnroutedMobileCache(browser, baseUrl)
    ]) {
      try { await check(); } catch (error) { failures.push(error); console.error(error); }
    }
    assert.equal(failures.length, 0, `${failures.length} gallery request regression check(s) failed`);
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
