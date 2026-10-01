#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  clearStoredTheme,
  markAnimationsSeen,
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const TARGET = process.argv[2] || 'http://127.0.0.1:4173/pages/gallery/index.html';
const OUTPUT_DIR = path.join(ROOT, 'output/playwright');
let targetUrl = TARGET;

async function waitForGalleryReady(page) {
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#galleryArchiveGrid .photo-card').length > 0
      && document.querySelectorAll('#lightboxThumbStrip .lightbox-thumb').length > 0
      && document.getElementById('galleryLoading')?.hidden === true,
    null,
    { timeout: 18000 }
  );
}

// Full-page evidence should show loaded photos even though production only
// hydrates nearby thumbnails. Walk the viewport before taking the full capture.
async function prepareFullPageCapture(page) {
  for (let top = 0; top < await page.evaluate(() => document.documentElement.scrollHeight); top += 650) {
    await page.evaluate(top => scrollTo({ top, behavior: 'instant' }), top);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => [...document.images].filter(image => {
      const rect = image.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
    }).every(image => image.complete && image.naturalWidth > 0));
  }
  await page.waitForFunction(() => [...document.querySelectorAll('#mobileGalleryGrid img, #galleryArchiveGrid img')]
    .every(image => image.complete && image.naturalWidth > 0 && Number(getComputedStyle(image).opacity) >= 0.99));
  await page.locator('#mobileGalleryGrid img, #galleryArchiveGrid img').evaluateAll(images =>
    Promise.all(images.map(image => image.decode())));
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
}

async function captureDesktop(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
  await clearStoredTheme(context);
  await markAnimationsSeen(context);
  const page = await context.newPage();

  await page.goto(targetUrl, { waitUntil: 'networkidle' });
  await waitForGalleryReady(page);

  await prepareFullPageCapture(page);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-desktop-full.png'), fullPage: true });

  await page.locator('#galleryArchiveSection').scrollIntoViewIfNeeded();
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-desktop-archive.png') });

  await page.locator('#galleryArchiveGrid .photo-card .photo-card-button').first().click();
  await page.waitForFunction(() => document.getElementById('lightboxImage')?.naturalWidth > 0
    && document.getElementById('lightboxMedia').getAttribute('aria-busy') === 'false');
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
  await markAnimationsSeen(context);
  const page = await context.newPage();

  const mobileUrl = new URL('../../mobile/gallery/', targetUrl);
  await page.goto(mobileUrl.href, { waitUntil: 'networkidle' });
  await page.waitForSelector('#mobileGalleryGrid img[data-entry-index]');
  await prepareFullPageCapture(page);
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-mobile-full.png'), fullPage: true });

  await page.locator('#mobileGalleryGrid img[data-entry-index]').first().click();
  await page.locator('#mobileLightbox').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('mobileLightboxImage')?.naturalWidth > 0
    && document.getElementById('mobileLightboxMedia').getAttribute('aria-busy') === 'false');
  await page.screenshot({ path: path.join(OUTPUT_DIR, 'gallery-mobile-lightbox.png') });

  await context.close();
}

async function run() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const server = await startLocalStaticServer({ url: TARGET, cwd: ROOT, skip: Boolean(process.argv[2]) });
  targetUrl = server?.url || TARGET;
  await waitForServer(targetUrl);

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
