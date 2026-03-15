#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WEBGL_ARGS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'];
const NAV_WAIT_UNTIL = 'domcontentloaded';

function isLocalBaseUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function parsePortFromBaseUrl(url) {
  const match = url.match(/^http:\/\/[^:]+:(\d+)/);
  return match ? Number(match[1]) : 4173;
}

function startLocalServerIfNeeded(url) {
  if (!isLocalBaseUrl(url)) return null;
  if (process.argv[2]) return null;
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
    () => {
      const app = window.__galleryApp;
      const mode = app?.getMode?.();
      const renderMode = window.__galleryRenderMode;
      const rowCount = document.querySelectorAll('#galleryIndexList .gallery-index-btn').length;
      return Boolean(app && mode && renderMode && renderMode !== 'initializing' && rowCount === app.entries.length);
    },
    null,
    { timeout: 18000 }
  );
}

async function clearStoredTheme(context) {
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('od-color-mode');
    } catch (_error) {
      // Ignore storage issues in test contexts.
    }
  });
}

async function setDeterministicOverviewIndex(page, index = 3) {
  await page.evaluate((target) => {
    const app = window.__galleryApp;
    if (!app?.sceneController) return;

    app.setMode('overview');
    app.sceneController.exitFocus?.({ immediate: true });
    app.uiController?.setInspectMode?.(false);
    app.sceneController.jumpToIndex(target);
    app.inputController?.setCurrentIndex(target);
    app.uiController?.setActive(target, app.entries[target]);
  }, index);
  await page.waitForTimeout(1100);
}

async function captureInspectShot(page, screenshotPath) {
  await page.evaluate(() => {
    const app = window.__galleryApp;
    const active = app?.sceneController?.activeIndex ?? 0;
    app?.handleInspectToggle?.(active);
  });
  await page.waitForFunction(() => {
    const app = window.__galleryApp;
    return Boolean(
      app?.sceneController?.isFocused?.()
      && app?.sceneController?.focusBlend >= 0.98
      && document.body?.dataset.galleryInspect === 'true'
    );
  }, null, { timeout: 5000 });
  await page.waitForTimeout(180);
  await page.screenshot({ path: screenshotPath });
  await page.evaluate(() => {
    window.__galleryApp?.handleCanvasClick?.(8, 8);
  });
  await page.waitForFunction(() => !window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 5000 });
  await page.waitForTimeout(320);
}

async function run() {
  const target = process.argv[2] || 'http://127.0.0.1:4173/pages/gallery/index.html';
  const outDir = path.resolve(process.cwd(), 'output/gallery-overhaul');
  await fs.mkdir(outDir, { recursive: true });

  const serverProcess = startLocalServerIfNeeded(target);
  await waitForServer(target);

  const browser = await chromium.launch({ args: WEBGL_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: 1536, height: 960 } });
    await clearStoredTheme(context);
    const page = await context.newPage();

    await page.goto(target, { waitUntil: NAV_WAIT_UNTIL });
    await waitForGalleryReady(page);
    await page.waitForTimeout(900);

    await page.screenshot({ path: path.join(outDir, 'landing-desktop.png') });

    await setDeterministicOverviewIndex(page, 4);
    await page.screenshot({ path: path.join(outDir, 'desktop-overview.png') });
    await captureInspectShot(page, path.join(outDir, 'desktop-inspect.png'));

    await page.click('#galleryModeIndex');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(outDir, 'desktop-index.png') });

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    await clearStoredTheme(mobile);

    const mobilePage = await mobile.newPage();
    await mobilePage.goto(target, { waitUntil: NAV_WAIT_UNTIL });
    await waitForGalleryReady(mobilePage);
    await mobilePage.waitForTimeout(900);

    await setDeterministicOverviewIndex(mobilePage, 3);
    await mobilePage.screenshot({ path: path.join(outDir, 'mobile-overview.png') });
    await captureInspectShot(mobilePage, path.join(outDir, 'mobile-inspect.png'));

    await mobilePage.click('#galleryModeIndex');
    await mobilePage.waitForTimeout(600);
    await mobilePage.screenshot({ path: path.join(outDir, 'mobile-index.png') });

    await mobile.close();
    await context.close();
  } finally {
    await browser.close();
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }

  console.log('Gallery snapshots saved to:', outDir);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
