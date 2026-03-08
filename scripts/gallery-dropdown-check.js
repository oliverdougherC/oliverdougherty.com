#!/usr/bin/env node

const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
const BASE_URL = process.env.GALLERY_CHECK_URL || DEFAULT_BASE_URL;
const REQUIRE_WEBGL = process.env.GALLERY_REQUIRE_WEBGL !== '0';
const WEBGL_ARGS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isLocalBaseUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function parsePortFromBaseUrl(url) {
  const match = url.match(/^http:\/\/[^:]+:(\d+)$/);
  return match ? Number(match[1]) : 4173;
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
  throw new Error(`Timed out waiting for local server at ${url}`);
}

function startLocalServerIfNeeded() {
  if (!isLocalBaseUrl(BASE_URL) || process.env.GALLERY_CHECK_URL) {
    return null;
  }

  const port = parsePortFromBaseUrl(BASE_URL);
  return spawn('python3', ['-m', 'http.server', String(port)], {
    cwd: ROOT,
    stdio: 'ignore'
  });
}

async function waitForGalleryReady(page, timeoutMs = 12000) {
  await page.waitForFunction(
    () => {
      const app = window.__galleryApp;
      const mode = app?.getMode?.();
      const renderMode = window.__galleryRenderMode;
      const rows = document.querySelectorAll('#galleryIndexList .gallery-index-btn').length;
      const tabs = document.querySelectorAll('#galleryTabRail .gallery-tab').length;

      return Boolean(
        app
        && mode
        && renderMode
        && renderMode !== 'initializing'
        && Array.isArray(app.entries)
        && app.entries.length > 0
        && rows === app.entries.length
        && tabs === 4
      );
    },
    null,
    { timeout: timeoutMs }
  );
}

async function assertNewShell(page, label) {
  const state = await page.evaluate(() => ({
    hasShellMarker: document.getElementById('galleryShell')?.dataset.galleryShell === 'unveil',
    hasTabRail: Boolean(document.getElementById('galleryTabRail')),
    tabCount: document.querySelectorAll('#galleryTabRail .gallery-tab').length,
    hasModeSwitch: Boolean(document.getElementById('galleryModeSwitch')),
    hasOverviewButton: Boolean(document.getElementById('galleryModeOverview')),
    hasIndexButton: Boolean(document.getElementById('galleryModeIndex')),
    hasNavToggle: Boolean(document.getElementById('navToggle')),
    hasThemeToggle: Boolean(document.querySelector('[data-theme-toggle], .theme-toggle')),
    hasInfoToggle: Boolean(document.getElementById('galleryInfoToggle'))
  }));

  assert(state.hasShellMarker, `[${label}] missing unveil shell marker`);
  assert(state.hasTabRail && state.tabCount === 4, `[${label}] expected 4 tab-rail buttons`);
  assert(state.hasModeSwitch && state.hasOverviewButton && state.hasIndexButton, `[${label}] mode switch controls missing`);
  assert(!state.hasNavToggle, `[${label}] legacy nav toggle should be removed from gallery page`);
  assert(!state.hasThemeToggle, `[${label}] theme toggle should not render on gallery page`);
  assert(!state.hasInfoToggle, `[${label}] legacy Info toggle should be removed`);
}

async function assertModeSwitchFlow(page, label, rowTarget = 5) {
  await page.click('#galleryModeIndex');
  await page.waitForFunction(() => {
    const shell = document.getElementById('galleryShell');
    const panel = document.getElementById('galleryIndexPanel');
    return shell?.dataset.mode === 'index' && panel && !panel.hidden;
  }, null, { timeout: 3000 });

  let state = await page.evaluate(() => ({
    mode: window.__galleryApp?.getMode?.(),
    rowCount: document.querySelectorAll('#galleryIndexList .gallery-index-btn').length,
    entries: window.__galleryApp?.entries?.length ?? 0,
    panelHidden: document.getElementById('galleryIndexPanel')?.hidden
  }));

  assert(state.mode === 'index', `[${label}] app mode did not switch to index`);
  assert(!state.panelHidden, `[${label}] index panel is hidden while mode is index`);
  assert(state.rowCount === state.entries, `[${label}] index row count (${state.rowCount}) does not match entries (${state.entries})`);

  const boundedTarget = await page.evaluate((requested) => {
    const count = document.querySelectorAll('#galleryIndexList .gallery-index-btn').length;
    if (!count) return 0;
    return Math.max(0, Math.min(count - 1, requested));
  }, rowTarget);

  await page.click(`#galleryIndexList .gallery-index-btn[data-index="${boundedTarget}"]`);

  await page.waitForFunction((targetIndex) => {
    const app = window.__galleryApp;
    const shell = document.getElementById('galleryShell');
    return shell?.dataset.mode === 'overview'
      && app?.getMode?.() === 'overview'
      && app?.uiController?.activeIndex === targetIndex;
  }, boundedTarget, { timeout: 5000 });

  state = await page.evaluate((targetIndex) => ({
    mode: window.__galleryApp?.getMode?.(),
    activeIndex: window.__galleryApp?.uiController?.activeIndex ?? -1,
    targetIndex
  }), boundedTarget);

  assert(state.mode === 'overview', `[${label}] clicking index row should return to overview mode`);
  assert(state.activeIndex === state.targetIndex, `[${label}] clicking index row should activate selected photo`);
}

async function assertOverviewGeometry(page, label, { minVisible }) {
  const metrics = await page.evaluate(() => {
    const app = window.__galleryApp;
    const debug = app?.sceneController?.getLayoutDebugState?.();
    if (!debug) return null;

    return {
      mode: app?.getMode?.(),
      renderMode: window.__galleryRenderMode,
      visibleCount: Array.isArray(debug.visibleRects) ? debug.visibleRects.length : 0,
      minGapPx: Number(debug.minGapPx),
      maxGapPx: Number(debug.maxGapPx),
      activeNeighborGapPx: Number(debug.activeNeighborGapPx),
      activeYawDeg: Number(debug.activeYawDeg),
      activeCenterPx: Number(debug.activeCenterPx),
      viewportWidth: window.innerWidth,
      isMobile: window.matchMedia('(max-width: 980px), (pointer: coarse)').matches
    };
  });

  assert(metrics, `[${label}] missing scene layout debug metrics`);
  if (REQUIRE_WEBGL) {
    assert(metrics.renderMode === 'render', `[${label}] expected WebGL render mode, got ${metrics.renderMode}`);
  }

  assert(metrics.mode === 'overview', `[${label}] geometry check must run in overview mode`);
  assert(metrics.visibleCount >= minVisible, `[${label}] too few visible cards (${metrics.visibleCount} < ${minVisible})`);
  assert(metrics.minGapPx <= 0, `[${label}] overview should overlap cards (min gap ${metrics.minGapPx.toFixed(2)}px)`);

  const centerDeltaPx = Math.abs(metrics.activeCenterPx - metrics.viewportWidth * 0.5);
  const centerTolerance = metrics.isMobile ? 0.42 : 0.28;
  assert(centerDeltaPx <= metrics.viewportWidth * centerTolerance, `[${label}] active card drifted too far from center lane (${centerDeltaPx.toFixed(2)}px)`);
}

async function runDesktopScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 960 } });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
  await waitForGalleryReady(page);
  await page.waitForTimeout(1200);

  await assertNewShell(page, 'desktop');
  await assertOverviewGeometry(page, 'desktop', { minVisible: 8 });
  await assertModeSwitchFlow(page, 'desktop', 6);

  await context.close();
}

async function runMobileScenario(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });

  const page = await context.newPage();
  await page.goto(`${BASE_URL}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
  await waitForGalleryReady(page);
  await page.waitForTimeout(1200);

  await assertNewShell(page, 'mobile');
  await assertOverviewGeometry(page, 'mobile', { minVisible: 5 });
  await assertModeSwitchFlow(page, 'mobile', 4);

  await context.close();
}

async function runForcedFallbackScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await context.addInitScript(() => {
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function getContextPatched(type, ...args) {
      const contextType = String(type || '').toLowerCase();
      if (contextType === 'webgl' || contextType === 'webgl2' || contextType === 'experimental-webgl') {
        return null;
      }
      return originalGetContext.call(this, type, ...args);
    };
  });

  const page = await context.newPage();
  await page.goto(`${BASE_URL}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => {
    const mode = window.__galleryRenderMode;
    return mode && mode !== 'initializing';
  }, null, { timeout: 5000 });

  const state = await page.evaluate(() => ({
    renderMode: window.__galleryRenderMode,
    caption: document.getElementById('galleryCaption')?.textContent || '',
    hasModeSwitch: Boolean(document.getElementById('galleryModeSwitch'))
  }));

  assert(state.renderMode === 'fallback', `[fallback] expected renderMode fallback, got ${state.renderMode}`);
  assert(state.hasModeSwitch, '[fallback] mode switch should still exist in fallback mode');
  assert(state.caption.toLowerCase().includes('compatibility'), '[fallback] compatibility caption missing');

  await context.close();
}

async function main() {
  const serverProcess = startLocalServerIfNeeded();
  try {
    await waitForServer(`${BASE_URL}/pages/gallery/index.html`);

    const browser = await chromium.launch({ headless: true, args: WEBGL_ARGS });
    try {
      await runDesktopScenario(browser);
      await runMobileScenario(browser);
      await runForcedFallbackScenario(browser);
    } finally {
      await browser.close();
    }

    console.log('Gallery dropdown checks passed.');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('Gallery dropdown checks failed:', error.stack || error.message);
  process.exit(1);
});
