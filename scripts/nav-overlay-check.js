#!/usr/bin/env node

const { chromium } = require('playwright');
const path = require('node:path');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
let baseUrl = process.env.NAV_CHECK_URL || 'http://127.0.0.1:4173';
const DESKTOP_PAGES = [
  { label: 'HOME', route: '/index.html' },
  { label: 'RESUME', route: '/pages/resume/index.html' },
  { label: 'GALLERY', route: '/pages/gallery/index.html' }
];
const MOBILE_PAGES = [
  { label: 'Home', route: '/mobile/' },
  { label: 'Resume', route: '/mobile/resume/' },
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

async function run() {
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(process.env.NAV_CHECK_URL) });
  baseUrl = server?.url || baseUrl;
  let browser;
  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch({ headless: true });
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const page = await desktop.newPage();
    await checkNavigation(page, DESKTOP_PAGES, '.nav-inline-link', ['HOME', 'RESUME', 'GALLERY', 'UTILITIES']);
    await page.goto(`${baseUrl}/index.html`, { waitUntil: 'networkidle' });
    assert((await page.locator('.home-header .text-flare').textContent()).trim() === '#FF6700', 'Homepage navigation should retain the original orange label');
    await page.locator('.home-header .nav-inline-link--home').click();
    await page.waitForURL((url) => url.pathname === '/index.html' || url.pathname === '/');
    await page.goto(`${baseUrl}/pages/utilities/index.html`, { waitUntil: 'networkidle' });
    await page.locator('.nav-home-btn').click();
    await page.waitForURL((url) => url.pathname === '/index.html');
    console.log('Verified desktop inline navigation and Utilities Home link.');
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await checkNavigation(await mobile.newPage(), MOBILE_PAGES, '.mobile-nav-link', ['Home', 'Resume', 'Gallery']);
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
