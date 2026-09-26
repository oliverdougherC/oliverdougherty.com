#!/usr/bin/env node

const { chromium, firefox, webkit } = require('playwright');
const path = require('node:path');
const http = require('node:http');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
let baseUrl = process.env.NAV_CHECK_URL || 'http://127.0.0.1:4173';
const DESKTOP_PAGES = [
  { label: 'HOME', route: '/index.html' },
  { label: 'RÉSUMÉ', route: '/pages/resume/index.html' },
  { label: 'GALLERY', route: '/pages/gallery/index.html' }
];
const MOBILE_PAGES = [
  { label: 'Home', route: '/mobile/' },
  { label: 'Résumé', route: '/mobile/resume/' },
  { label: 'Gallery', route: '/mobile/gallery/' }
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkNavigation(page, pages, selector, expectedLabels) {
  for (const entry of pages) {
    await page.goto(`${baseUrl}${entry.route}`, { waitUntil: 'networkidle' });
    const links = page.locator(selector);
    const labels = (await links.allTextContents()).map((label) => label.trim());
    assert(labels.join('|') === expectedLabels.join('|'), `[${entry.label}] unexpected navigation: ${labels}`);
    const current = page.locator(`${selector}[aria-current="page"]`);
    assert(await current.count() === 1, `[${entry.label}] expected one current-page link`);
    assert((await current.textContent()).trim() === entry.label, `[${entry.label}] wrong current-page link`);
    for (const link of await links.all()) {
      await link.waitFor({ state: 'visible' });
      const box = await link.boundingBox();
      assert(box && box.x >= 0 && box.x + box.width <= page.viewportSize().width + 1,
        `[${entry.label}] navigation link is clipped horizontally`);
      const destination = await link.evaluate((element) => element.href);
      const response = await page.request.get(destination);
      assert(response.ok(), `[${entry.label}] navigation destination failed: ${destination}`);
    }
  }
  // Exercise real links and the destination's current-page indication.
  await page.goto(`${baseUrl}${pages[0].route}`, { waitUntil: 'networkidle' });
  await page.locator(selector).filter({ hasText: pages[1].label }).click();
  await page.waitForURL((url) => url.pathname.includes('/resume'));
  assert((await page.locator(`${selector}[aria-current="page"]`).textContent()).trim() === pages[1].label,
    'Resume navigation did not activate the destination link');
}

async function checkStalledOptionalScripts(browser) {
  const pages = [
    { name: 'home', route: '/index.html', heading: '#home-intro-title' },
    { name: 'resume', route: '/pages/resume/index.html', heading: '#typeTargetName1' },
    { name: 'gallery', route: '/pages/gallery/index.html', heading: '.gallery-hero .calibrate-text' },
    { name: 'utilities', route: '/pages/utilities/index.html', heading: '#utilitiesHeading' }
  ];
  for (const script of ['mobile-gate.js', 'page-animations.js']) {
    for (const entry of pages) {
      if (script === 'page-animations.js' && !['resume', 'gallery'].includes(entry.name)) continue;
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      let release;
      let held = false;
      const wait = new Promise(resolve => { release = resolve; });
      await context.route(`**/js/${script}*`, async route => {
        held = true;
        await wait;
        await route.abort();
      });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${entry.route}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
        assert(held, `[${entry.name}] ${script} was not intercepted`);
        await page.waitForFunction(({ heading, name }) => {
          const perceptible = (element) => {
            if (!element || !element.textContent.trim()) return false;
            for (let node = element; node instanceof Element; node = node.parentElement) {
              const style = getComputedStyle(node);
              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
            }
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          };
          return perceptible(document.querySelector(heading))
            && perceptible(document.querySelector(`.nav-inline-link--${name}[aria-current="page"]`));
        }, { heading: entry.heading, name: entry.name }, { timeout: 10000 });
        const destination = entry.name === 'home' ? 'resume' : 'home';
        await Promise.all([
          page.waitForURL(url => url.pathname.includes(destination === 'home' ? '/index.html' : '/resume/'), { waitUntil: 'commit' }),
          page.locator(`.nav-inline-link--${destination}`).click({ noWaitAfter: true })
        ]);
        assert(page.url().includes(destination === 'home' ? '/index.html' : '/resume/'),
          `[${entry.name}] navigation stalled with ${script} pending`);
      } finally {
        release();
        await context.close();
      }
    }
  }
}

async function checkAnimationBootstrap(browser) {
  for (const route of ['/pages/resume/index.html', '/pages/gallery/index.html']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto(`${baseUrl}${route}`, { waitUntil: 'load' });
      assert(!await page.locator('html').evaluate(root => root.classList.contains('skip-page-animation')),
        `${route}: first visit skipped its intro after asynchronous enhancement loaded`);
      const seenMap = await page.evaluate(() => sessionStorage.getItem('od-page-animations-seen'));
      let release;
      const wait = new Promise(resolve => { release = resolve; });
      await context.route('**/js/page-animations.js*', async route => { await wait; await route.abort(); });
      try {
        await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
        const state = await page.evaluate(() => ({ skip: document.documentElement.classList.contains('skip-page-animation'), seen: sessionStorage.getItem('od-page-animations-seen') }));
        assert(state.skip, `${route}: revisit did not apply the pre-paint skip state while enhancement was pending; before=${seenMap}, after=${state.seen}`);
      } finally {
        release();
      }
    } finally {
      await context.close();
    }
  }
}

async function checkInlineMobileRedirect(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await context.route('**/js/mobile-gate.js*', route => route.abort());
  try {
    await page.goto(`${baseUrl}/pages/resume/index.html`, { waitUntil: 'commit' });
    await page.waitForURL(url => url.pathname === '/mobile/resume/');
    assert(page.url().endsWith('/mobile/resume/'), 'Mobile redirect depended on the optional gate script');
  } finally {
    await context.close();
  }
}

async function checkStalledScriptBodies(browser) {
  if (!baseUrl.startsWith('http://127.0.0.1:')) return;
  for (const { route, script, heading } of [
    { route: '/index.html', script: 'mobile-gate.js', heading: '#home-intro-title' },
    { route: '/pages/gallery/index.html', script: 'page-animations.js', heading: '.gallery-hero .calibrate-text' }
  ]) {
    const proxy = http.createServer((request, response) => {
      if (new URL(request.url, baseUrl).pathname.endsWith(`/js/${script}`)) {
        response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        response.write('/* unfinished optional script body');
        return;
      }
      const upstream = http.get(`${baseUrl}${request.url}`, received => {
        response.writeHead(received.statusCode, received.headers);
        received.pipe(response);
      });
      upstream.on('error', error => { response.writeHead(502); response.end(error.message); });
      response.on('close', () => upstream.destroy());
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      const address = proxy.address();
      await page.goto(`http://127.0.0.1:${address.port}${route}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await page.waitForFunction(selector => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const style = getComputedStyle(element);
        return style.visibility !== 'hidden' && Number(style.opacity) >= 0.95 && element.getBoundingClientRect().height > 0;
      }, heading, { timeout: 10000 });
      assert(await page.locator('.nav-inline-link').first().isVisible(), `${script}: navigation is unavailable with a stalled script body`);
      assert(await page.evaluate(() => document.readyState !== 'complete'), `${script}: script body did not remain pending during readiness check`);
    } finally {
      await context.close();
      proxy.closeAllConnections();
      await new Promise(resolve => proxy.close(resolve));
    }
  }
}

async function run() {
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(process.env.NAV_CHECK_URL) });
  baseUrl = server?.url || baseUrl;
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await ({ chromium, firefox, webkit }[process.env.BROWSER || 'chromium']).launch({ headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const page = await desktop.newPage();
    page.setDefaultTimeout(15000);
    await checkNavigation(page, DESKTOP_PAGES, '.nav-inline-link', ['HOME', 'RÉSUMÉ', 'GALLERY', 'UTILITIES']);
    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'networkidle' });
    assert((await page.locator('.home-header .text-flare').textContent()).trim() === '#FF6700', 'Homepage navigation should retain the original orange label');
    await page.locator('.home-header .nav-inline-link--home').click();
    await page.waitForURL((url) => url.pathname === '/index.html' || url.pathname === '/');
    await page.goto(`${baseUrl}/pages/utilities/index.html`, { waitUntil: 'networkidle' });
    await page.locator('.nav-inline-link--home').click();
    await page.waitForURL((url) => url.pathname === '/index.html');
    console.log('Verified desktop inline navigation and Utilities Home link.');
    await desktop.close();

    await checkStalledOptionalScripts(browser);
    await checkAnimationBootstrap(browser);
    await checkInlineMobileRedirect(browser);
    await checkStalledScriptBodies(browser);
    console.log('Verified navigation and visible content while optional startup scripts are pending.');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: process.env.BROWSER !== 'firefox', hasTouch: true });
    await checkNavigation(await mobile.newPage(), MOBILE_PAGES, '.mobile-nav-link', ['Home', 'Résumé', 'Gallery']);
    console.log('Verified mobile Home, Resume, and Gallery navigation.');
    await mobile.close();
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error('Navigation check failed:', error.message);
  process.exit(1);
});
