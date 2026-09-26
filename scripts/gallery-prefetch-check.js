#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const requestedUrl = process.env.GALLERY_PREFETCH_URL || 'http://127.0.0.1:4173';

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
      && document.getElementById('lightboxImage').naturalWidth > 0);
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
        return image.currentSrc !== previous && image.complete && image.naturalWidth > 0;
      }, currentSrc);
    }
    for (let index = 0; index < 5; index++) await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => {
      const image = document.getElementById('lightboxImage');
      return image.complete && image.naturalWidth > 0;
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
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.GALLERY_PREFETCH_URL) });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browser;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true });
    await checkViewport(browser, baseUrl, { width: 1440, height: 900 }, 1);
    await checkViewport(browser, baseUrl, { width: 390, height: 844 }, 2);
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
