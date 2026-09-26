#!/usr/bin/env node

// Exercise real cross-page links without intercepting requests or waiting for
// networkidle. Intended for both local release checks and controlled remote
// investigations where a stalled optional request must remain observable.
const assert = require('node:assert/strict');
const { chromium, firefox, webkit } = require('playwright');
const path = require('node:path');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const PAGES = {
  home: { route: '/index.html', heading: '#home-intro-title' },
  resume: { route: '/pages/resume/index.html', heading: '#typeTargetName1' },
  gallery: { route: '/pages/gallery/index.html', heading: '.gallery-hero .calibrate-text' },
  utilities: { route: '/pages/utilities/index.html', heading: '#utilitiesHeading' }
};
const ORDER = ['resume', 'gallery', 'utilities', 'home'];
const CYCLES = Number(process.env.NAV_STABILITY_CYCLES || 6);
const TIMEOUT_MS = Number(process.env.NAV_STABILITY_TIMEOUT_MS || 20000);

async function waitForUsablePage(page, name) {
  const heading = PAGES[name].heading;
  await page.waitForFunction(({ heading, name }) => {
    const visible = (element) => {
      if (!element || !element.textContent.trim()) return false;
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const current = document.querySelector(`.nav-inline-link--${name}[aria-current="page"]`);
    return visible(document.querySelector(heading)) && visible(current);
  }, { heading, name }, { timeout: TIMEOUT_MS });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(await page.locator(`.nav-inline-link--${name}[aria-current="page"]`).count() === 1,
    `${name}: current navigation is missing`);
}

async function run() {
  assert(Number.isInteger(CYCLES) && CYCLES >= 5 && CYCLES <= 7, 'Use 5–7 cycles for 20–28 real transitions');
  assert(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0, 'Timeout must be positive');
  const requestedUrl = process.env.NAV_STABILITY_URL || 'http://127.0.0.1:4173';
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.NAV_STABILITY_URL) });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browser;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser: ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);
    const pending = new Map();
    const failures = [];
    page.on('request', request => pending.set(request, { url: request.url(), type: request.resourceType(), since: Date.now() }));
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => {
      pending.delete(request);
      failures.push({ url: request.url(), error: request.failure()?.errorText });
    });
    const results = [];
    let current = 'home';

    async function record(action, target, navigate) {
      const started = Date.now();
      try {
        await navigate();
        await waitForUsablePage(page, target);
        // A browser event-loop round trip proves the destination can respond
        // after its content becomes visible; no CPU/GPU utility is started.
        const responded = await page.evaluate(() => new Promise(resolve => setTimeout(() => resolve(true), 0)));
        assert(responded, `${target}: page event loop did not respond`);
        const navigation = await page.evaluate(() => {
          const entry = performance.getEntriesByType('navigation')[0];
          return { readyState: document.readyState, domContentLoadedMs: entry?.domContentLoadedEventEnd,
            loadMs: entry?.loadEventEnd || null, responseStartMs: entry?.responseStart };
        });
        const result = { action, from: current, to: target, usableMs: Date.now() - started, ...navigation };
        results.push(result);
        current = target;
        console.log(JSON.stringify(result));
      } catch (error) {
        const outstanding = [...pending.values()].map(request => ({ ...request, pendingMs: Date.now() - request.since }));
        console.error(JSON.stringify({ action, from: current, to: target, url: page.url(),
          elapsedMs: Date.now() - started, outstanding, recentFailures: failures.slice(-10) }, null, 2));
        throw error;
      }
    }

    await record('open', 'home', () => page.goto(`${baseUrl}${PAGES.home.route}`, { waitUntil: 'domcontentloaded' }));
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      for (const target of ORDER) {
        await record('click', target, async () => {
          await Promise.all([
            page.waitForURL(url => url.pathname === PAGES[target].route, { waitUntil: 'commit' }),
            page.locator(`.nav-inline-link--${target}`).click({ noWaitAfter: true })
          ]);
        });
      }
    }
    for (const [action, target] of [
      ['back', 'utilities'], ['back', 'gallery'], ['forward', 'utilities'], ['forward', 'home']
    ]) {
      await record(action, target, () => action === 'back'
        ? page.goBack({ waitUntil: 'domcontentloaded' })
        : page.goForward({ waitUntil: 'domcontentloaded' }));
    }
    assert.equal(results.length, 1 + 4 * CYCLES + 4);
    console.log(`PASS: ${results.length - 1} real-link/history transitions; source ${baseUrl}`);
    await context.close();
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
