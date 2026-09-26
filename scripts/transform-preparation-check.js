#!/usr/bin/env node

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const requestedUrl = process.env.TRANSFORM_PREPARATION_URL || 'http://127.0.0.1:4173';
const PRECOMPUTED = '**/pattern-face-balanced*.json*';

async function openTransform(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(`${baseUrl}/pages/utilities/index.html#image-transform`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('transformGenerateBtn')?.disabled === false);
  return { context, page };
}

async function waitForResult(page, label, timeout = 20000) {
  await page.waitForFunction(() => /Transform ready|Animation complete|Reduced motion/i.test(
    document.getElementById('utilitiesApp')?.dataset.transformStatusMessage || ''), null, { timeout });
  assert(await page.locator('#transformOutputSize').textContent() !== '—', `${label}: output was not rendered`);
}

async function checkResetAndRetry(browser, baseUrl) {
  const { context, page } = await openTransform(browser, baseUrl);
  let releaseFirst;
  const held = new Promise(resolve => { releaseFirst = resolve; });
  let fetches = 0;
  await context.route(PRECOMPUTED, async route => {
    fetches += 1;
    if (fetches === 1) {
      await held;
      await route.abort().catch(() => {});
    } else {
      await route.continue();
    }
  });
  try {
    await page.click('#transformGenerateBtn');
    await page.waitForFunction(() => /Loading precomputed demo asset/i.test(
      document.getElementById('transformProgressText')?.textContent || ''));
    assert(await page.locator('#transformResetBtn').isEnabled(), 'Reset is unavailable during pending preparation');
    await page.click('#transformResetBtn');
    await page.waitForFunction(() => /Load two images|built-in pair|Ready|Transform cancelled/i.test(
      document.getElementById('utilitiesApp')?.dataset.transformStatusMessage || ''));
    await page.click('[data-demo-key="pattern-face"]');
    await page.click('#transformGenerateBtn');
    await waitForResult(page, 'retry same pair');
    assert(fetches >= 2, 'Retry joined an old pending precomputed promise');
    const requestId = await page.locator('#utilitiesApp').getAttribute('data-last-request-id');
    releaseFirst();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await page.locator('#utilitiesApp').getAttribute('data-last-request-id') === requestId,
      'A late cancelled response replaced the new result');
  } finally {
    releaseFirst();
    await context.close();
  }
}

async function checkPrecomputedTimeout(browser, baseUrl) {
  const { context, page } = await openTransform(browser, baseUrl);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  await context.route(PRECOMPUTED, async route => {
    intercepted = true;
    await held;
    await route.abort().catch(() => {});
  });
  try {
    const started = Date.now();
    await page.click('#transformGenerateBtn');
    await waitForResult(page, 'precomputed timeout fallback');
    assert(intercepted, 'Precomputed request was not held');
    assert(Date.now() - started < 20000, 'Optional asset timeout did not reach live generation promptly');
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
    if (/\/pattern-face-balanced[^/]*\.json$/.test(new URL(requestPath, upstreamUrl).pathname)) {
      held = true;
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.write('{"metadata":');
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

async function checkBodyTimeout(browser, baseUrl) {
  const stalled = await startBodyStallProxy(baseUrl);
  let context;
  try {
    ({ context } = await openTransform(browser, stalled.url));
    const page = context.pages()[0];
    const started = Date.now();
    await page.click('#transformGenerateBtn');
    await waitForResult(page, 'precomputed response-body timeout');
    assert(stalled.wasHeld(), 'Precomputed response body was not held');
    assert(Date.now() - started < 20000, 'Stalled JSON body blocked live generation');
  } finally {
    await context?.close();
    stalled.proxy.closeAllConnections();
    await new Promise(resolve => stalled.proxy.close(resolve));
  }
}

async function checkOptionalFailures(browser, baseUrl) {
  for (const [label, action] of [
    ['404', route => route.fulfill({ status: 404, body: 'missing' })],
    ['malformed JSON', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{bad' })],
    ['offline', route => route.abort()]
  ]) {
    const { context, page } = await openTransform(browser, baseUrl);
    try {
      await context.route(PRECOMPUTED, action);
      await page.click('#transformGenerateBtn');
      await waitForResult(page, `${label} fallback`);
    } finally {
      await context.close();
    }
  }
}

async function checkDemoImageCancellation(browser, baseUrl) {
  const { context, page } = await openTransform(browser, baseUrl);
  await page.locator('#transformPreset').selectOption('fast');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await context.route('**/assets/utilities/image-transform/pattern.png*', async route => {
    requests += 1;
    if (requests === 1) {
      await held;
      await route.abort().catch(() => {});
    } else {
      await route.continue();
    }
  });
  try {
    await page.click('#transformGenerateBtn');
    await page.waitForFunction(() => /Loading image data/i.test(
      document.getElementById('transformProgressText')?.textContent || ''));
    await page.click('.nav-back-btn');
    await page.waitForFunction(() => document.getElementById('utilitiesTitleView')?.hidden === false);
    await page.click('[data-utility="image-transform"]');
    await page.click('[data-demo-key="source-target"]');
    await page.click('#transformGenerateBtn');
    await waitForResult(page, 'new pair after tool switch');
    const resultId = await page.locator('#utilitiesApp').getAttribute('data-last-request-id');
    release();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert(await page.locator('#utilitiesApp').getAttribute('data-last-request-id') === resultId,
      'Cancelled demo image request overwrote a newer pair');
  } finally {
    release();
    await context.close();
  }
}

async function checkDemoImageTimeout(browser, baseUrl) {
  const { context, page } = await openTransform(browser, baseUrl);
  await page.locator('#transformPreset').selectOption('fast');
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let intercepted = false;
  const imagePattern = '**/assets/utilities/image-transform/pattern.png*';
  await context.route(imagePattern, async route => {
    intercepted = true;
    await held;
    await route.abort().catch(() => {});
  });
  try {
    const started = Date.now();
    await page.click('#transformGenerateBtn');
    await page.waitForFunction(() => /timed out/i.test(
      document.getElementById('utilitiesApp')?.dataset.transformStatusMessage || ''), null, { timeout: 16000 });
    assert(intercepted, 'Demo image request was not held');
    assert(Date.now() - started < 16000, 'Demo image timeout did not reach a visible error promptly');
    assert(await page.locator('#transformGenerateBtn').isEnabled(), 'Image timeout did not allow retry');
    release();
    await context.unroute(imagePattern);
    await page.click('#transformGenerateBtn');
    await waitForResult(page, 'retry after demo image timeout');
  } finally {
    release();
    await context.close();
  }
}

async function run() {
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.TRANSFORM_PREPARATION_URL) });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browser;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true });
    await checkResetAndRetry(browser, baseUrl);
    await checkPrecomputedTimeout(browser, baseUrl);
    await checkBodyTimeout(browser, baseUrl);
    await checkOptionalFailures(browser, baseUrl);
    await checkDemoImageCancellation(browser, baseUrl);
    await checkDemoImageTimeout(browser, baseUrl);
    console.log('Image preparation cancellation, deadlines, fallback and retry passed.');
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
