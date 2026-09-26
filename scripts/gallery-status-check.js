#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const requestedUrl = process.env.GALLERY_STATUS_URL || 'http://127.0.0.1:4173';

async function perceptible(page, selector) {
  return page.locator(selector).evaluate(element => {
    if (!element || element.hidden) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  });
}

async function checkFailure(browser, baseUrl, { delay = 0, reducedMotion = 'no-preference', seen = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const page = await context.newPage();
  try {
    if (seen) await page.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'load' });
    await context.route('**/assets/photos/photos.json*', async route => {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      await route.abort();
    });
    await page.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('galleryError').hidden);
    assert(await perceptible(page, '#galleryError'), `Gallery error concealed after ${delay}ms manifest failure`);
    assert(await perceptible(page, '.nav-inline-link--home'), 'Navigation concealed by gallery failure');
    assert(await perceptible(page, '.gallery-error-retry'), 'Gallery retry link is concealed');
    await context.unroute('**/assets/photos/photos.json*');
    await page.locator('.gallery-error-retry').click();
    await page.waitForFunction(() => document.querySelector('#galleryArchiveGrid')?.children.length > 0);
  } finally {
    await context.close();
  }
}

async function run() {
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.GALLERY_STATUS_URL) });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browser;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true });
    for (const options of [{}, { delay: 1000 }, { delay: 4500 }, { reducedMotion: 'reduce' }, { seen: true }]) {
      await checkFailure(browser, baseUrl, options);
    }

    const empty = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await empty.route('**/assets/photos/photos.json*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"photos":[]}' }));
    const emptyPage = await empty.newPage();
    await emptyPage.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
    await emptyPage.waitForFunction(() => !document.getElementById('galleryEmpty').hidden);
    assert(await perceptible(emptyPage, '#galleryEmpty'), 'Empty-gallery message is concealed');
    await empty.close();

    const noScript = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
    const noScriptPage = await noScript.newPage();
    await noScriptPage.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'load' });
    assert(await perceptible(noScriptPage, '.gallery-empty--noscript'), 'No-JavaScript message is concealed');
    assert(!await perceptible(noScriptPage, '#galleryLoading'), 'No-JavaScript view still shows a perpetual spinner');
    await noScript.close();

    const missingScript = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await missingScript.route('**/js/gallery.js*', route => route.abort());
    const missingPage = await missingScript.newPage();
    await missingPage.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
    await missingPage.waitForFunction(() => !document.getElementById('galleryError').hidden);
    assert(await perceptible(missingPage, '#galleryError'), 'Missing gallery script did not reveal an error');
    await missingScript.close();
    console.log('Gallery loading, empty, error and no-JavaScript states are visually readable across intro timing.');
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
