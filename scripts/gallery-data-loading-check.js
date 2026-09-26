#!/usr/bin/env node

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const requestedUrl = process.env.GALLERY_DATA_URL || 'http://127.0.0.1:4173';
const PLATFORMS = [
  { name: 'desktop', route: '/pages/gallery/index.html?full=1', loaded: '#galleryArchiveGrid .photo-card',
    error: '#galleryError', loading: '#galleryLoading', retry: '#galleryRetryButton, .gallery-error-retry' },
  { name: 'mobile', route: '/mobile/gallery/', loaded: '#mobileGalleryGrid .mobile-photo-button',
    error: '#mobileGalleryError', loading: '#mobileGalleryLoading', retry: '#mobileGalleryRetryButton' }
];

async function newPage(browser, baseUrl, platform) {
  const context = await browser.newContext({ viewport: { width: platform.name === 'mobile' ? 390 : 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__GALLERY_FETCH_TIMEOUTS__ = { manifest: 700, sequence: 300 };
    window.__MOBILE_GALLERY_FETCH_TIMEOUTS__ = { manifest: 700, sequence: 300 };
    window.__galleryDocumentId = Math.random();
  });
  await context.route('**://fonts.googleapis.com/**', route => route.abort());
  await context.route('**://fonts.gstatic.com/**', route => route.abort());
  const page = await context.newPage();
  return { context, page, url: `${baseUrl}${platform.route}` };
}

async function waitForGallery(page, platform, label) {
  await page.locator(platform.loaded).first().waitFor({ state: 'attached', timeout: 5000 });
  assert(await page.locator(platform.error).getAttribute('hidden') !== null,
    `${label}: error remained visible after a usable gallery rendered`);
}

async function checkPendingSequence(browser, baseUrl, platform) {
  const { context, page, url } = await newPage(browser, baseUrl, platform);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  await context.route('**/assets/photos/gallery-sequence.json*', async route => {
    intercepted = true;
    await held;
    await route.abort().catch(() => {});
  });
  try {
    const started = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await waitForGallery(page, platform, `${platform.name} pending sequence`);
    assert(intercepted, `${platform.name}: optional sequence request was not held`);
    assert(Date.now() - started < 4000, `${platform.name}: optional sequence delayed first usable gallery`);
  } finally {
    release();
    await context.close();
  }
}

async function checkManifestRetry(browser, baseUrl, platform) {
  const { context, page, url } = await newPage(browser, baseUrl, platform);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  const pattern = '**/assets/photos/photos.json*';
  await context.route(pattern, async route => {
    intercepted = true;
    await held;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const docId = await page.evaluate(() => window.__galleryDocumentId);
    await page.locator(platform.retry).waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForFunction(selector => {
      const element = document.querySelector(selector);
      if (!element || element.hidden) return false;
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
      }
      return element.getBoundingClientRect().height > 0;
    }, platform.error);
    assert(intercepted, `${platform.name}: required manifest request was not held`);
    assert(await page.locator(platform.error).getAttribute('role') === 'alert',
      `${platform.name}: manifest timeout did not expose an accessible error`);
    assert(await page.locator(platform.loading).getAttribute('hidden') !== null,
      `${platform.name}: spinner remained visible behind the error`);
    assert(await page.evaluate(selector => document.activeElement?.matches(selector), platform.retry),
      `${platform.name}: retry action was not focused`);
    release();
    await context.unroute(pattern);
    await page.locator(platform.retry).click();
    await waitForGallery(page, platform, `${platform.name} retry`);
    assert(await page.evaluate(() => window.__galleryDocumentId) === docId,
      `${platform.name}: retry reloaded the document`);
  } finally {
    release();
    await context.close();
  }
}

async function startBodyStallProxy(baseUrl) {
  const upstreamUrl = new URL(baseUrl);
  assert(upstreamUrl.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(upstreamUrl.hostname),
    'Body-stall proxy requires a local HTTP server');
  let held = false;
  const proxy = http.createServer((request, response) => {
    const requestPath = request.url || '';
    if (!requestPath.startsWith('/') || requestPath.startsWith('//') || requestPath.includes('\\')) {
      response.writeHead(400);
      response.end('Invalid proxy path');
      return;
    }
    if (new URL(requestPath, upstreamUrl).pathname.endsWith('/assets/photos/gallery-sequence.json')) {
      held = true;
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.write('{"items":');
      return;
    }
    const upstream = http.get({ hostname: '127.0.0.1', port: upstreamUrl.port, path: requestPath }, received => {
      response.writeHead(received.statusCode, received.headers);
      received.pipe(response);
    });
    upstream.on('error', error => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
    response.on('close', () => upstream.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  return { proxy, url: `http://127.0.0.1:${proxy.address().port}`, wasHeld: () => held };
}

async function checkSequenceBody(browser, baseUrl, platform) {
  const stalled = await startBodyStallProxy(baseUrl);
  let context;
  try {
    const opened = await newPage(browser, stalled.url, platform);
    context = opened.context;
    const started = Date.now();
    await opened.page.goto(opened.url, { waitUntil: 'domcontentloaded' });
    await waitForGallery(opened.page, platform, `${platform.name} stalled sequence body`);
    assert(stalled.wasHeld(), `${platform.name}: sequence response body was not held`);
    assert(Date.now() - started < 4000, `${platform.name}: stalled JSON body delayed first usable gallery`);
  } finally {
    await context?.close();
    stalled.proxy.closeAllConnections();
    await new Promise(resolve => stalled.proxy.close(resolve));
  }
}

async function run() {
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.GALLERY_DATA_URL) });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browser;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true });
    for (const platform of PLATFORMS) {
      await checkPendingSequence(browser, baseUrl, platform);
      await checkManifestRetry(browser, baseUrl, platform);
      await checkSequenceBody(browser, baseUrl, platform);
    }
    console.log('Desktop/mobile gallery data deadlines and in-page retry passed.');
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
