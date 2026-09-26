#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const requestedUrl = process.env.GALLERY_HEADING_URL || 'http://127.0.0.1:4173';

async function assertHeadingVisible(page, label) {
  const visible = await page.locator('.gallery-hero .calibrate-text').evaluate(element => {
    if (!element.textContent.trim()) return false;
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  assert(visible, `${label}: Gallery heading is visually hidden`);
}

async function run() {
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.GALLERY_HEADING_URL) });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browser;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true });
    const route = `${baseUrl}/pages/gallery/index.html`;

    const reduced = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await reduced.newPage();
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await assertHeadingVisible(page, 'fresh reduced-motion visit');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    await assertHeadingVisible(page, 'fresh preference changed from reduce after load');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertHeadingVisible(page, 'seen reduced-motion visit');
    await reduced.close();

    const normal = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const normalPage = await normal.newPage();
    await normalPage.goto(route, { waitUntil: 'domcontentloaded' });
    await normalPage.emulateMedia({ reducedMotion: 'reduce' });
    await assertHeadingVisible(normalPage, 'preference changed to reduce after load');
    await normal.close();

    const noScript = await browser.newContext({
      viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', javaScriptEnabled: false
    });
    const noScriptPage = await noScript.newPage();
    await noScriptPage.goto(route, { waitUntil: 'load' });
    await assertHeadingVisible(noScriptPage, 'JavaScript-disabled reduced-motion visit');
    await noScript.close();
    console.log('Gallery heading remains visually readable across reduced motion, revisits, preference changes and no JavaScript.');
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
