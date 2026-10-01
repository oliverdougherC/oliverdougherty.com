#!/usr/bin/env node
// Readiness and intermediate-frame regressions for issue #76. Routed fault
// fixtures deliberately disable HTTP cache; cache measurements live separately
// in gallery-prefetch-check.js. STATIC_ROOT supports the packaged release gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const { startLocalStaticServer, markAnimationsSeen } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = process.env.BROWSER || 'chromium';
const OUTPUT = path.join(ROOT, 'output/playwright/transitions', ENGINE);
const photos = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/photos/photos.json'), 'utf8')).photos.slice(0, 6);
const results = [];

async function displayed(page, id, mobile = false) {
  await page.waitForFunction(({ id, mobile }) => {
    const image = document.getElementById(mobile ? 'mobileLightboxImage' : 'lightboxImage');
    return image?.complete && image.naturalWidth > 0
      && new RegExp('/' + id + '\\.(avif|webp|jpg)$', 'i').test(image.currentSrc)
      && getComputedStyle(image).visibility !== 'hidden';
  }, { id, mobile });
}

async function sampleFrames(page, mobile = false) {
  await page.evaluate(mobile => {
    window.__transitionFrames = [];
    window.__sampleTransition = true;
    const media = document.getElementById(mobile ? 'mobileLightboxMedia' : 'lightboxMedia');
    const sample = () => {
      const layers = [...media.querySelectorAll('picture')].map(picture => {
        const image = picture.querySelector('img');
        const p = getComputedStyle(picture), i = getComputedStyle(image);
        return { src: image.currentSrc, ready: image.complete && image.naturalWidth > 0,
          visible: p.display !== 'none' && p.visibility !== 'hidden' && i.visibility !== 'hidden',
          opacity: Number(p.opacity) * Number(i.opacity) };
      });
      window.__transitionFrames.push({ time: performance.now(), layers,
        title: document.getElementById('lightboxTitle')?.textContent,
        alt: document.getElementById(mobile ? 'mobileLightboxImage' : 'lightboxImage')?.alt,
        hash: location.hash });
      if (window.__sampleTransition) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, mobile);
}

async function finishFrames(page, name) {
  const frames = await page.evaluate(() => { window.__sampleTransition = false; return window.__transitionFrames; });
  fs.writeFileSync(path.join(OUTPUT, `${name}-frames.json`), JSON.stringify(frames, null, 2) + '\n');
  assert(frames.length > 2, 'must inspect intermediate animation frames');
  assert(frames.every(frame => frame.layers.length <= 2), `${name}: unbounded image layers`);
  const blank = frames.filter(frame => !frame.layers.some(layer => layer.visible && layer.ready && layer.opacity >= 0.99));
  assert.equal(blank.length, 0, `${name}: ${blank.length}/${frames.length} frames lack an opaque decoded photo`);
  results.push({ name, frames: frames.length, blankFrames: blank.length });
}

async function fixture(context, { jpegOnly = false } = {}) {
  await markAnimationsSeen(context);
  await context.route('**/assets/photos/photos.json', route => route.fulfill({ json: { photos: photos.map(photo => {
    if (!jpegOnly) return photo;
    const jpeg = variant => ({ jpg: variant.jpg, width: variant.width, height: variant.height });
    return { ...photo, thumbs: jpeg(photo.thumbs), medium: jpeg(photo.medium), large: jpeg(photo.large) };
  }) } }));
  await context.route('**/assets/photos/gallery-sequence.json', route => route.fulfill({ json: { items: [] } }));
}

async function desktop(browser, base, { reduced = false, jpegOnly = false } = {}) {
  const name = `desktop-${reduced ? 'reduced' : 'motion'}-${jpegOnly ? 'jpeg' : 'modern'}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await fixture(context, { jpegOnly });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(/\/assets\/photos\/(medium|large)\/attitude\./i, async route => {
    await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(`${base}/pages/gallery/?full=1#photo=lighthouse`, { waitUntil: 'domcontentloaded' });
    await displayed(page, 'lighthouse');
    await page.screenshot({ path: path.join(OUTPUT, `${name}-before.png`) });
    const oldTitle = await page.locator('#lightboxTitle').textContent();
    await sampleFrames(page);
    await page.locator('#lightboxNext').click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#lightboxTitle').textContent(), oldTitle, 'pending image must not relabel outgoing pixels');
    assert.equal(await page.evaluate(() => location.hash), '#photo=lighthouse', 'URL commits with displayed photo');
    await page.screenshot({ path: path.join(OUTPUT, `${name}-pending.png`) });
    await displayed(page, 'attitude');
    await page.waitForTimeout(250);
    await finishFrames(page, name);
    assert.equal(await page.locator('#lightboxTitle').textContent(), await page.locator('#lightboxImage').getAttribute('alt'));
    await page.screenshot({ path: path.join(OUTPUT, `${name}-after.png`) });

    // Each intent advances the requested target even while images are pending.
    await page.evaluate(() => { document.getElementById('lightboxNext').click(); document.getElementById('lightboxNext').click(); });
    await displayed(page, 'chairs');
    await page.evaluate(() => { document.getElementById('lightboxNext').click(); document.getElementById('lightboxPrev').click(); });
    await displayed(page, 'chairs');
    await page.locator('[data-entry-id="lighthouse"].lightbox-thumb').click();
    await displayed(page, 'lighthouse');
    await page.locator('#lightboxPrev').click();
    await displayed(page, 'drive');
    await page.locator('#lightboxNext').click();
    await displayed(page, 'lighthouse');

    // Slow stale completion, thumbnail supersession, close and reopen.
    await page.locator('#lightboxNext').click();
    await page.locator('[data-entry-id="bridge"].lightbox-thumb').click();
    await displayed(page, 'bridge');
    await page.waitForTimeout(1000);
    await displayed(page, 'bridge');
    await page.locator('[data-entry-id="lighthouse"].lightbox-thumb').click();
    await displayed(page, 'lighthouse');
    await page.locator('#lightboxNext').click();
    await page.keyboard.press('Escape');
    await page.evaluate(() => { location.hash = '#photo=creek'; });
    await displayed(page, 'creek');
    await page.waitForTimeout(1000);
    await displayed(page, 'creek');
    assert.equal(await page.evaluate(() => location.hash), '#photo=creek');

    await page.keyboard.press('Escape');
    assert(await page.locator('#lightbox').evaluate(element => element.hidden));
    assert.equal(await page.locator('body > [inert]').count(), 0);
    assert.deepEqual(errors, []);
    results.push({ name: `${name}-intents-errors-lifecycle`, status: 'pass' });
  } finally { await context.close(); }
}

async function navigationFailure(browser, base, failure) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await fixture(context);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  let failing = true;
  await page.route(/\/assets\/photos\/(medium|large)\/attitude\./i, route => {
    if (!failing) return route.continue();
    return failure === '404' ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ contentType: 'image/jpeg', body: 'not an image' });
  });
  try {
    await page.goto(`${base}/pages/gallery/?full=1#photo=lighthouse`, { waitUntil: 'domcontentloaded' });
    await displayed(page, 'lighthouse');
    await page.locator('#lightboxNext').click();
    await page.locator('#lightboxRetry').waitFor({ state: 'visible' });
    await displayed(page, 'lighthouse');
    assert.equal(await page.evaluate(() => location.hash), '#photo=lighthouse');
    failing = false;
    await page.locator('#lightboxRetry').click();
    await displayed(page, 'attitude');
    results.push({ name: `navigation-${failure}-retry`, status: 'pass' });
  } finally { await context.close(); }
}

async function decodeAndInitialFailure(browser, base) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  await fixture(context);
  await context.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (this.currentSrc.includes('/attitude.')) {
        window.__decodeReached = true;
        await new Promise(resolve => { window.__releaseDecode = resolve; });
      }
    };
    window.__GALLERY_IMAGE_TIMEOUT_MS__ = 2500;
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  let fail = true;
  await page.route(/\/assets\/photos\/(medium|large)\/lighthouse\./i, route =>
    fail ? route.fulfill({ status: 404, body: '' }) : route.continue());
  try {
    await page.goto(`${base}/pages/gallery/?full=1#photo=lighthouse`, { waitUntil: 'domcontentloaded' });
    await page.locator('#lightboxRetry').waitFor({ state: 'visible' });
    assert.match(await page.locator('#lightboxStatus').textContent(), /could not be loaded/i);
    assert.equal(await page.locator('#lightboxMedia img').count(), 0, 'first failure removes broken image');
    fail = false;
    await page.locator('#lightboxRetry').click();
    await displayed(page, 'lighthouse');
    await page.locator('#lightboxNext').click();
    await page.waitForFunction(() => window.__decodeReached === true);
    await displayed(page, 'lighthouse');
    assert.equal(await page.locator('#lightboxTitle').textContent(), 'Lighthouse');
    await page.evaluate(() => { window.__releaseDecode(); });
    await displayed(page, 'attitude');
    await page.locator('[data-entry-id="lighthouse"].lightbox-thumb').click();
    await displayed(page, 'lighthouse');
    await page.evaluate(() => { window.__decodeReached = false; });
    await page.locator('#lightboxNext').click();
    await page.waitForFunction(() => window.__decodeReached === true);
    // The deadline covers stalled decode as well as network load.
    await page.locator('#lightboxRetry').waitFor({ state: 'visible' });
    await displayed(page, 'lighthouse');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { window.__releaseDecode(); location.hash = '#photo=bridge'; });
    await displayed(page, 'bridge');
    results.push({ name: 'first-failure-delayed-decode-timeout', status: 'pass' });
  } finally { await context.close(); }
}

async function compactKeyboard(browser, base) {
  const context = await browser.newContext({ viewport: { width: 880, height: 900 }, reducedMotion: 'reduce' });
  await fixture(context);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/pages/gallery/?full=1#photo=lighthouse`, { waitUntil: 'domcontentloaded' });
    await displayed(page, 'lighthouse');
    assert(await page.locator('#lightboxPanel').evaluate(panel => panel.inert));
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => {
        const focused = document.activeElement;
        const rect = focused.getBoundingClientRect();
        return focused.closest('#lightbox') && rect.top >= 0 && rect.bottom <= innerHeight;
      }), 'compact modal focus must stay visible');
    }
    await page.locator('#lightboxInfoToggle').click();
    assert.equal(await page.locator('#lightboxPanel').evaluate(panel => panel.inert), false);
    await page.locator('#lightboxInfoToggle').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => !document.getElementById('lightboxPanel').inert);
    await page.setViewportSize({ width: 880, height: 900 });
    await page.waitForFunction(() => document.getElementById('lightboxPanel').inert);
    results.push({ name: 'compact-keyboard-resize', status: 'pass' });
  } finally { await context.close(); }
}

async function aspectChange(browser, base, mobile) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
  await fixture(context);
  // The current archive has only landscape images. A synthetic portrait guards
  // future uploads without changing production assets or measuring fixture bytes.
  await context.route('**/assets/photos/photos.json', route => route.fulfill({ json: { photos: photos.map((photo, index) => index === 1
    ? { ...photo, width: 600, height: 1000, medium: { ...photo.medium, width: 600, height: 1000 }, large: { ...photo.large, width: 1200, height: 2000 } }
    : photo) } }));
  await context.route(/\/assets\/photos\/(medium|large)\/attitude\./i, route => route.fulfill({ contentType: 'image/svg+xml', body:
    '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="1000"><rect width="600" height="1000" fill="#123f65"/><circle cx="300" cy="500" r="180" fill="#f8b84e"/></svg>' }));
  const page = await context.newPage();
  try {
    await page.goto(`${base}/${mobile ? 'mobile/gallery/' : 'pages/gallery/?full=1#photo=lighthouse'}`, { waitUntil: 'domcontentloaded' });
    if (mobile) await page.locator('#mobileGalleryGrid button').first().click();
    await displayed(page, 'lighthouse', mobile);
    await sampleFrames(page, mobile);
    await page.keyboard.press('ArrowRight');
    await displayed(page, 'attitude', mobile);
    const prefix = mobile ? 'mobileLightbox' : 'lightbox';
    const geometry = await page.locator(`#${prefix}Image`).evaluate(image => {
      const rect = image.getBoundingClientRect();
      const picture = image.closest('picture');
      return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom,
        background: getComputedStyle(picture).backgroundColor,
        viewportHeight: innerHeight, viewportWidth: innerWidth };
    });
    assert(geometry.height > geometry.width, 'portrait must retain intrinsic shape');
    assert(geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight, 'contain image fits viewport height');
    assert(!/rgba\(.*[, ]0\)$|transparent/.test(geometry.background), 'opaque picture masks old image overhang');
    await page.screenshot({ path: path.join(OUTPUT, `${mobile ? 'mobile' : 'desktop'}-portrait-transition.png`) });
    await page.waitForTimeout(240);
    await page.screenshot({ path: path.join(OUTPUT, `${mobile ? 'mobile' : 'desktop'}-portrait-settled.png`) });
    await finishFrames(page, `${mobile ? 'mobile' : 'desktop'}-aspect-change`);
    assert.equal(await page.locator(`#${prefix}Media picture`).count(), 1, 'outgoing frame released');
  } finally { await context.close(); }
}

async function mobile(browser, base) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  await fixture(context);
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  let fail = false;
  await page.route(/\/assets\/photos\/(medium|large)\/attitude\./i, async route => {
    if (fail) return route.fulfill({ status: 404, body: '' });
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(`${base}/mobile/gallery/`, { waitUntil: 'domcontentloaded' });
    await page.locator('#mobileGalleryGrid button').first().click();
    await displayed(page, 'lighthouse', true);
    await sampleFrames(page, true);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUTPUT, 'mobile-pending.png') });
    await displayed(page, 'attitude', true);
    await finishFrames(page, 'mobile');
    await page.keyboard.press('Escape');
    await page.locator('#mobileGalleryGrid button').first().click();
    await displayed(page, 'lighthouse', true);
    fail = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('#mobileGalleryGrid button').first().click();
    await displayed(page, 'lighthouse', true);
    await page.keyboard.press('ArrowRight');
    await page.locator('#mobileLightboxRetry').waitFor({ state: 'visible' });
    await page.locator('#mobileLightboxClose').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'mobileLightboxRetry');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'mobileLightboxClose');
    await displayed(page, 'lighthouse', true);
    fail = false;
    await page.locator('#mobileLightboxRetry').click();
    await displayed(page, 'attitude', true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('body > [inert]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    results.push({ name: 'mobile-error-retry', status: 'pass' });
  } finally { await context.close(); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const url = process.env.GALLERY_TRANSITION_URL || 'http://127.0.0.1:0';
  const server = await startLocalStaticServer({ url, cwd: ROOT, skip: Boolean(process.env.GALLERY_TRANSITION_URL) });
  const browser = await playwright[ENGINE].launch();
  try {
    const base = server?.url || url;
    await desktop(browser, base);
    await desktop(browser, base, { reduced: true, jpegOnly: true });
    await navigationFailure(browser, base, '404');
    await navigationFailure(browser, base, 'corrupt');
    await decodeAndInitialFailure(browser, base);
    await mobile(browser, base);
    await compactKeyboard(browser, base);
    await aspectChange(browser, base, false);
    await aspectChange(browser, base, true);
    console.log(JSON.stringify({ browser: ENGINE, results }, null, 2));
  } finally {
    fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify({ browser: ENGINE, results }, null, 2) + '\n');
    await browser.close();
    server?.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
