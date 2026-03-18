#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || 'http://127.0.0.1:4173/pages/gallery/index.html';
const OUTPUT_DIR = path.join(ROOT, 'output/playwright');

function isLocalBaseUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function parsePortFromBaseUrl(url) {
  const match = url.match(/^http:\/\/[^:]+:(\d+)/);
  return match ? Number(match[1]) : 4173;
}

function startLocalServerIfNeeded(url) {
  if (!isLocalBaseUrl(url) || process.argv[2]) return null;
  return spawn('python3', ['-m', 'http.server', String(parsePortFromBaseUrl(url)), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore'
  });
}

async function waitForServer(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return;
    } catch (_error) {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

async function waitForGalleryReady(page) {
  await page.waitForFunction(
    () =>
      typeof window.__galleryState?.getEntries === 'function'
      && window.__galleryState.getEntries().length > 0
      && document.querySelectorAll('#galleryArchiveGrid .photo-card').length > 0
      && document.getElementById('galleryLoading')?.hidden === true,
    null,
    { timeout: 18000 }
  );
}

async function clearStoredTheme(context) {
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('od-color-mode');
    } catch (_error) {
      // Ignore storage issues in automation contexts.
    }
  });
}

async function captureDesktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await clearStoredTheme(context);
  const page = await context.newPage();

  await page.goto(TARGET, { waitUntil: 'networkidle' });
  await waitForGalleryReady(page);

  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-desktop-full.png'), fullPage: true });

  await page.locator('#galleryFeaturedSection').scrollIntoViewIfNeeded();
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-desktop-featured.png') });

  await page.locator('#galleryFeaturedGrid .photo-card .photo-card-button').first().click();
  await page.waitForTimeout(240);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-desktop-lightbox.png') });

  await context.close();
}

async function captureMobile(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await clearStoredTheme(context);
  const page = await context.newPage();

  await page.goto(TARGET, { waitUntil: 'networkidle' });
  await waitForGalleryReady(page);

  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-mobile-full.png'), fullPage: true });

  await page.locator('#galleryArchiveGrid .photo-card .photo-card-button').first().click();
  await page.waitForTimeout(220);
  await page.click('#lightboxInfoToggle');
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-mobile-lightbox.png') });

  await context.close();
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const server = startLocalServerIfNeeded(TARGET);
  await waitForServer(TARGET);

  const browser = await chromium.launch();
  try {
    await captureDesktop(browser);
    await captureMobile(browser);
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }

  console.log('Gallery screenshots saved to:', OUTPUT_DIR);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
