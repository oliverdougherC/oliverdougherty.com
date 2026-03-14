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

async function setDeterministicOverviewIndex(page, index = 3) {
  await page.evaluate((targetIndex) => {
    const app = window.__galleryApp;
    if (!app?.sceneController) return;

    app.setMode('overview');
    app.sceneController.jumpToIndex(targetIndex);
    app.inputController?.setCurrentIndex(targetIndex);
    app.uiController?.setActive(targetIndex, app.entries[targetIndex]);
  }, index);
  await page.waitForTimeout(720);
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

async function assertOverviewGeometry(page, label, { minVisible, maxVisible }) {
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
      activeWidthPx: Number(debug.activeWidthPx),
      maxVisibleWidthPx: Number(debug.maxVisibleWidthPx),
      frontToActiveWidthRatio: Number(debug.frontToActiveWidthRatio),
      adjacentGapPx: Number(debug.adjacentGapPx),
      activeIndex: Number(debug.activeIndex),
      localOrder: Array.isArray(debug.visibleRects)
        ? debug.visibleRects
            .filter((rect) => Math.abs(Number(rect.index) - Number(debug.activeIndex)) <= 3)
            .sort((a, b) => Number(a.index) - Number(b.index))
            .map((rect) => ({
              index: Number(rect.index),
              centerPx: Number(rect.centerPx),
              centerYPx: Number(rect.centerYPx)
            }))
        : [],
      viewportWidth: window.innerWidth,
      isMobile: window.matchMedia('(max-width: 980px), (pointer: coarse)').matches
    };
  });

  assert(metrics, `[${label}] missing scene layout debug metrics`);
  if (REQUIRE_WEBGL) {
    assert(metrics.renderMode === 'render', `[${label}] expected WebGL render mode, got ${metrics.renderMode}`);
  }

  assert(metrics.mode === 'overview', `[${label}] geometry check must run in overview mode`);
  assert(
    metrics.visibleCount >= minVisible && metrics.visibleCount <= maxVisible,
    `[${label}] visible count out of range (${metrics.visibleCount}, expected ${minVisible}-${maxVisible})`
  );
  assert(metrics.minGapPx <= 0, `[${label}] overview should overlap cards (min gap ${metrics.minGapPx.toFixed(2)}px)`);
  assert(
    metrics.activeYawDeg <= -8 && metrics.activeYawDeg >= -20,
    `[${label}] active yaw outside target band (${metrics.activeYawDeg.toFixed(2)}deg)`
  );
  assert(metrics.activeYawDeg <= -9 && metrics.activeYawDeg >= -18, `[${label}] active yaw outside polish band (${metrics.activeYawDeg.toFixed(2)}deg)`);
  assert(metrics.activeWidthPx > 0, `[${label}] active width metric missing`);
  const ratioLimit = metrics.isMobile ? 1.45 : 1.55;
  assert(
    metrics.frontToActiveWidthRatio <= ratioLimit,
    `[${label}] foreground dominance ratio too high (${metrics.frontToActiveWidthRatio.toFixed(2)} > ${ratioLimit})`
  );
  assert(
    Number.isFinite(metrics.adjacentGapPx)
      && metrics.adjacentGapPx >= -260
      && metrics.adjacentGapPx <= -40,
    `[${label}] adjacent overlap median out of band (${metrics.adjacentGapPx.toFixed(2)}px)`
  );

  const centerDeltaPx = Math.abs(metrics.activeCenterPx - metrics.viewportWidth * 0.5);
  const centerTolerance = metrics.isMobile ? 0.42 : 0.28;
  assert(centerDeltaPx <= metrics.viewportWidth * centerTolerance, `[${label}] active card drifted too far from center lane (${centerDeltaPx.toFixed(2)}px)`);

  assert(metrics.localOrder.length >= 4, `[${label}] not enough local cards for ordering checks`);
  const xTolerance = metrics.isMobile ? 44 : 30;
  const yTolerance = metrics.isMobile ? 52 : 40;
  for (let i = 1; i < metrics.localOrder.length; i += 1) {
    const prev = metrics.localOrder[i - 1];
    const curr = metrics.localOrder[i];
    assert(
      curr.centerPx > prev.centerPx - xTolerance,
      `[${label}] lane x-order regression around active card (${prev.index} -> ${curr.index})`
    );
    assert(
      curr.centerYPx <= prev.centerYPx + yTolerance,
      `[${label}] lane y-order regression around active card (${prev.index} -> ${curr.index})`
    );
  }
}

async function assertInspectFlow(page, label, { expectNonActiveSelection = true } = {}) {
  await page.evaluate(() => {
    const app = window.__galleryApp;
    app?.setMode?.('overview');
    app?.sceneController?.exitFocus?.({ immediate: true });
    app?.uiController?.setInspectMode?.(false);
  });
  await page.waitForTimeout(450);

  await page.evaluate(() => {
    const app = window.__galleryApp;
    app?.handleCanvasClick?.(window.innerWidth * 0.5, window.innerHeight * 0.5);
  });

  await page.waitForFunction(() => window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 4000 });
  let inspectState = await page.evaluate(() => ({
    focused: window.__galleryApp?.sceneController?.isFocused?.() || false,
    overlayActive: document.getElementById('galleryFocusOverlay')?.classList.contains('is-active') || false
  }));
  assert(inspectState.focused, `[${label}] center click did not enter inspect mode`);
  assert(inspectState.overlayActive, `[${label}] inspect overlay did not activate`);

  await page.mouse.wheel(0, 1200);
  await page.waitForFunction(() => !window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 5000 });
  await page.evaluate(() => {
    const app = window.__galleryApp;
    const anchor = app?.sceneController?.activeIndex ?? 0;
    app?.sceneController?.jumpToIndex?.(anchor);
    app?.inputController?.setCurrentIndex?.(anchor);
  });
  await page.waitForTimeout(360);

  if (!expectNonActiveSelection) {
    return;
  }

  const candidate = await page.evaluate(() => {
    const app = window.__galleryApp;
    const debug = app?.sceneController?.getLayoutDebugState?.();
    if (!debug?.visibleRects?.length) return null;

    const active = Number(debug.activeIndex);
    const centerX = window.innerWidth * 0.5;
    const centerY = window.innerHeight * 0.5;

    const target = [...debug.visibleRects]
      .filter((rect) => Number(rect.index) !== active && Math.abs(Number(rect.index) - active) <= 2)
      .sort((a, b) => {
        const da = Math.abs(Number(a.centerPx) - centerX) + Math.abs(Number(a.centerYPx) - centerY) * 0.35;
        const db = Math.abs(Number(b.centerPx) - centerX) + Math.abs(Number(b.centerYPx) - centerY) * 0.35;
        return da - db;
      })[0];

    if (!target) return null;
    return {
      index: Number(target.index)
    };
  });

  assert(candidate, `[${label}] unable to find non-active visible pane for inspect selection`);
  await page.evaluate((payload) => {
    window.__galleryApp?.handleInspectToggle?.(payload.index);
  }, candidate);

  await page.waitForFunction((payload) => {
    const app = window.__galleryApp;
    const depth = app?.sceneController?.getDepthState?.();
    return Boolean(depth?.focused) && Number(depth?.focusIndex) === Number(payload.index);
  }, candidate, { timeout: 9000 });

  inspectState = await page.evaluate(() => ({
    focused: window.__galleryApp?.sceneController?.isFocused?.() || false,
    overlayActive: document.getElementById('galleryFocusOverlay')?.classList.contains('is-active') || false
  }));
  assert(inspectState.focused, `[${label}] non-active pane click did not transition into inspect mode`);
  assert(inspectState.overlayActive, `[${label}] overlay not active after non-active pane transition`);

  await page.evaluate(() => {
    document.getElementById('galleryFocusOverlay')?.click();
  });
  await page.waitForFunction(() => !window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 5000 });
}

async function runDesktopScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 960 } });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
  await waitForGalleryReady(page);
  await page.waitForTimeout(1200);
  await setDeterministicOverviewIndex(page, 3);

  await assertNewShell(page, 'desktop');
  await assertOverviewGeometry(page, 'desktop', { minVisible: 7, maxVisible: 10 });
  await assertInspectFlow(page, 'desktop', { expectNonActiveSelection: true });
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
  await setDeterministicOverviewIndex(page, 3);

  await assertNewShell(page, 'mobile');
  await assertOverviewGeometry(page, 'mobile', { minVisible: 4, maxVisible: 7 });
  await assertInspectFlow(page, 'mobile', { expectNonActiveSelection: false });
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
