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
  return spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
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

      return Boolean(
        app
        && mode
        && renderMode
        && renderMode !== 'initializing'
        && Array.isArray(app.entries)
        && app.entries.length > 0
        && rows === app.entries.length
        && document.getElementById('nav')
        && document.getElementById('navToggle')
        && document.querySelector('[data-theme-toggle], .theme-toggle')
      );
    },
    null,
    { timeout: timeoutMs }
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
  await page.evaluate((targetIndex) => {
    const app = window.__galleryApp;
    if (!app?.sceneController) return;

    app.setMode('overview');
    app.sceneController.exitFocus?.({ immediate: true });
    app.uiController?.setInspectMode?.(false);
    app.sceneController.jumpToIndex(targetIndex);
    app.inputController?.setCurrentIndex(targetIndex);
    app.uiController?.setActive(targetIndex, app.entries[targetIndex]);
  }, index);
  await page.waitForTimeout(820);
}

async function assertSharedChrome(page, label) {
  const state = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    colorMode: document.documentElement.getAttribute('data-color-mode'),
    hasSharedNav: Boolean(document.getElementById('nav')),
    hasNavToggle: Boolean(document.getElementById('navToggle')),
    hasNavOverlay: Boolean(document.getElementById('navOverlay')),
    hasThemeToggle: Boolean(document.querySelector('[data-theme-toggle], .theme-toggle')),
    hasNoise: Boolean(document.querySelector('.noise-overlay')),
    hasFooter: Boolean(document.querySelector('.gallery-footer.footer')),
    hasCustomRail: Boolean(document.getElementById('galleryTabRail')),
    hasModeSwitch: Boolean(document.getElementById('galleryModeSwitch'))
  }));

  assert(state.theme === 'gallery', `[${label}] gallery theme attr missing`);
  assert(state.colorMode === 'dark', `[${label}] expected default dark mode, got ${state.colorMode}`);
  assert(state.hasSharedNav, `[${label}] shared nav missing`);
  assert(state.hasNavToggle, `[${label}] nav toggle missing`);
  assert(state.hasNavOverlay, `[${label}] nav overlay missing`);
  assert(state.hasThemeToggle, `[${label}] theme toggle missing`);
  assert(state.hasNoise, `[${label}] noise overlay missing`);
  assert(state.hasFooter, `[${label}] shared footer missing`);
  assert(!state.hasCustomRail, `[${label}] legacy gallery rail should be removed`);
  assert(state.hasModeSwitch, `[${label}] gallery mode switch missing`);

  await page.click('[data-theme-toggle]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-mode') === 'light',
    null,
    { timeout: 3000 }
  );
  await page.click('[data-theme-toggle]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-mode') === 'dark',
    null,
    { timeout: 3000 }
  );
}

async function getOverviewMetrics(page) {
  return page.evaluate(() => {
    const app = window.__galleryApp;
    const debug = app?.sceneController?.getLayoutDebugState?.();
    if (!debug) return null;

    const getRect = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };
    };

    const overlaps = (a, b) => {
      if (!a || !b) return false;
      return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    };

    const navRect = getRect('#nav');
    const captionRect = getRect('#galleryCaption');
    const counterRect = getRect('#galleryCounter');
    const switchRect = getRect('#galleryModeSwitch');
    const footerRect = getRect('.gallery-footer .footer-text');
    const overlay = document.getElementById('galleryFocusOverlay');

    return {
      mode: app?.getMode?.(),
      renderMode: window.__galleryRenderMode,
      viewportWidth: window.innerWidth,
      isMobile: window.matchMedia('(max-width: 980px), (pointer: coarse)').matches,
      visibleCount: Array.isArray(debug.visibleRects) ? debug.visibleRects.length : 0,
      activeIndex: Number(debug.activeIndex),
      activeCenterPx: Number(debug.activeCenterPx),
      activeYawDeg: Number(debug.activeYawDeg),
      minGapPx: Number(debug.minGapPx),
      adjacentGapPx: Number(debug.adjacentGapPx),
      maxNonActiveOpacity: Number(debug.maxNonActiveOpacity),
      localOrder: Array.isArray(debug.visibleRects)
        ? debug.visibleRects
            .filter((rect) => Math.abs(Number(rect.index) - Number(debug.activeIndex)) <= 3)
            .sort((a, b) => Number(a.index) - Number(b.index))
            .map((rect) => ({
              index: Number(rect.index),
              centerPx: Number(rect.centerPx),
              centerYPx: Number(rect.centerYPx),
              opacity: Number(rect.opacity)
            }))
        : [],
      footerOverlap: overlaps(switchRect, footerRect),
      hudOverlap: overlaps(counterRect, captionRect) || overlaps(captionRect, switchRect),
      navHudOverlap: overlaps(navRect, captionRect),
      overlayBackgroundColor: overlay ? getComputedStyle(overlay).backgroundColor : ''
    };
  });
}

async function assertOverviewGeometry(page, label, { minVisible, maxVisible, minCenterRatio, maxCenterRatio }) {
  const metrics = await getOverviewMetrics(page);

  assert(metrics, `[${label}] missing layout debug metrics`);
  if (REQUIRE_WEBGL) {
    assert(metrics.renderMode === 'render', `[${label}] expected WebGL render mode, got ${metrics.renderMode}`);
  }

  assert(metrics.mode === 'overview', `[${label}] overview geometry check must run in overview mode`);
  assert(
    metrics.visibleCount >= minVisible && metrics.visibleCount <= maxVisible,
    `[${label}] visible count out of range (${metrics.visibleCount}, expected ${minVisible}-${maxVisible})`
  );
  assert(metrics.minGapPx <= 10, `[${label}] panes drifted too far apart (${metrics.minGapPx.toFixed(2)}px)`);
  assert(
    Number.isFinite(metrics.adjacentGapPx)
      && metrics.adjacentGapPx >= (metrics.isMobile ? -180 : -260)
      && metrics.adjacentGapPx <= 18,
    `[${label}] adjacent pane spacing outside target band (${metrics.adjacentGapPx.toFixed(2)}px)`
  );

  const centerRatio = metrics.activeCenterPx / Math.max(metrics.viewportWidth, 1);
  assert(
    centerRatio >= minCenterRatio && centerRatio <= maxCenterRatio,
    `[${label}] active pane drifted outside staged lane (${centerRatio.toFixed(3)})`
  );

  assert(
    metrics.activeYawDeg <= -4.5 && metrics.activeYawDeg >= -12,
    `[${label}] active yaw outside target band (${metrics.activeYawDeg.toFixed(2)}deg)`
  );
  assert(!metrics.footerOverlap, `[${label}] footer overlaps the mode switch`);
  assert(!metrics.hudOverlap, `[${label}] HUD elements overlap`);
  assert(!metrics.navHudOverlap, `[${label}] nav overlaps gallery HUD`);

  assert(metrics.localOrder.length >= 4, `[${label}] not enough panes for lane ordering checks`);
  const xTolerance = metrics.isMobile ? 38 : 28;
  const yTolerance = metrics.isMobile ? 56 : 42;
  for (let i = 1; i < metrics.localOrder.length; i += 1) {
    const prev = metrics.localOrder[i - 1];
    const curr = metrics.localOrder[i];
    assert(
      curr.centerPx > prev.centerPx - xTolerance,
      `[${label}] lane x-order regression around active pane (${prev.index} -> ${curr.index})`
    );
    assert(
      curr.centerYPx <= prev.centerYPx + yTolerance,
      `[${label}] lane y-order regression around active pane (${prev.index} -> ${curr.index})`
    );
  }
}

async function assertInspectFlow(page, label, { requireSelectionClick = true }) {
  await page.evaluate(() => {
    const app = window.__galleryApp;
    app?.setMode?.('overview');
    app?.sceneController?.exitFocus?.({ immediate: true });
    app?.uiController?.setInspectMode?.(false);
  });
  await page.waitForTimeout(320);

  if (requireSelectionClick) {
    const candidate = await page.evaluate(() => {
      const debug = window.__galleryApp?.sceneController?.getLayoutDebugState?.();
      if (!debug?.visibleRects?.length) return null;

      const activeIndex = Number(debug.activeIndex);
      const target = [...debug.visibleRects]
        .filter((rect) => Number(rect.index) !== activeIndex)
        .sort((a, b) => Math.abs(Number(a.index) - activeIndex) - Math.abs(Number(b.index) - activeIndex))[0];

      if (!target) return null;
      return {
        index: Number(target.index),
        x: Number(target.centerPx),
        y: Number(target.centerYPx)
      };
    });

    assert(candidate, `[${label}] unable to find non-active pane for click-selection test`);
    await page.evaluate((target) => {
      window.__galleryApp?.handleCanvasClick?.(target.x, target.y);
    }, candidate);

    await page.waitForFunction((target) => {
      const app = window.__galleryApp;
      return Boolean(
        app?.sceneController
        && !app.sceneController.isFocused()
        && app.sceneController.activeIndex === target.index
      );
    }, candidate, { timeout: 5000 });
  }

  const activeTarget = await page.evaluate(() => {
    const debug = window.__galleryApp?.sceneController?.getLayoutDebugState?.();
    const activeIndex = Number(debug?.activeIndex ?? 0);
    const activeRect = debug?.visibleRects?.find((rect) => Number(rect.index) === activeIndex);
    if (!activeRect) return { index: activeIndex, x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 };
    return {
      index: activeIndex,
      x: Number(activeRect.centerPx),
      y: Number(activeRect.centerYPx)
    };
  });

  await page.evaluate((target) => {
    window.__galleryApp?.handleCanvasClick?.(target.x, target.y);
  }, activeTarget);

  await page.waitForFunction(() => {
    const app = window.__galleryApp;
    const overlay = document.getElementById('galleryFocusOverlay');
    const debug = app?.sceneController?.getLayoutDebugState?.();
    return Boolean(
      app?.sceneController?.isFocused?.()
      && app?.sceneController?.focusBlend >= 0.98
      && document.body?.dataset.galleryInspect === 'true'
      && overlay?.classList.contains('is-active')
      && (debug?.maxNonActiveOpacity ?? 1) <= 0.08
    );
  }, null, { timeout: 5000 });

  const inspectState = await getOverviewMetrics(page);
  assert(inspectState.maxNonActiveOpacity <= 0.08, `[${label}] non-active panes remain too visible in inspect (${inspectState.maxNonActiveOpacity})`);
  assert(
    inspectState.overlayBackgroundColor === 'rgba(0, 0, 0, 0)' || inspectState.overlayBackgroundColor === 'transparent',
    `[${label}] inspect overlay became an opaque fullscreen wash (${inspectState.overlayBackgroundColor})`
  );

  await page.evaluate(() => {
    window.__galleryApp?.handleCanvasClick?.(8, 8);
  });
  await page.waitForFunction(() => !window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 5000 });
}

async function assertModeSwitchFlow(page, label, rowTarget = 5) {
  await page.click('#galleryModeIndex');
  await page.waitForFunction(() => {
    const shell = document.getElementById('galleryShell');
    const panel = document.getElementById('galleryIndexPanel');
    return shell?.dataset.mode === 'index' && panel && !panel.hidden;
  }, null, { timeout: 3000 });

  const state = await page.evaluate((requested) => {
    const app = window.__galleryApp;
    const count = document.querySelectorAll('#galleryIndexList .gallery-index-btn').length;
    return {
      mode: app?.getMode?.(),
      rowCount: count,
      entries: app?.entries?.length ?? 0,
      boundedTarget: count ? Math.max(0, Math.min(count - 1, requested)) : 0,
      panelHidden: document.getElementById('galleryIndexPanel')?.hidden
    };
  }, rowTarget);

  assert(state.mode === 'index', `[${label}] app mode did not switch to index`);
  assert(!state.panelHidden, `[${label}] index panel stayed hidden in index mode`);
  assert(state.rowCount === state.entries, `[${label}] index row count mismatch (${state.rowCount} vs ${state.entries})`);

  await page.click(`#galleryIndexList .gallery-index-btn[data-index="${state.boundedTarget}"]`);
  await page.waitForFunction((targetIndex) => {
    const app = window.__galleryApp;
    const shell = document.getElementById('galleryShell');
    return shell?.dataset.mode === 'overview'
      && app?.getMode?.() === 'overview'
      && app?.uiController?.activeIndex === targetIndex;
  }, state.boundedTarget, { timeout: 5000 });
}

async function runDesktopScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1536, height: 960 } });
  await clearStoredTheme(context);
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
  await waitForGalleryReady(page);
  await page.waitForTimeout(1100);
  await setDeterministicOverviewIndex(page, 3);

  await assertSharedChrome(page, 'desktop');
  await assertOverviewGeometry(page, 'desktop', {
    minVisible: 5,
    maxVisible: 6,
    minCenterRatio: 0.22,
    maxCenterRatio: 0.48
  });
  await assertInspectFlow(page, 'desktop', { requireSelectionClick: true });
  await assertModeSwitchFlow(page, 'desktop', 6);

  await context.close();
}

async function runMobileScenario(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  await clearStoredTheme(context);

  const page = await context.newPage();
  await page.goto(`${BASE_URL}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
  await waitForGalleryReady(page);
  await page.waitForTimeout(1100);
  await setDeterministicOverviewIndex(page, 3);

  await assertSharedChrome(page, 'mobile');
  await assertOverviewGeometry(page, 'mobile', {
    minVisible: 4,
    maxVisible: 5,
    minCenterRatio: 0.24,
    maxCenterRatio: 0.62
  });
  await assertInspectFlow(page, 'mobile', { requireSelectionClick: false });
  await assertModeSwitchFlow(page, 'mobile', 4);

  await context.close();
}

async function runForcedFallbackScenario(browser) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await clearStoredTheme(context);
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
    hasModeSwitch: Boolean(document.getElementById('galleryModeSwitch')),
    hasNav: Boolean(document.getElementById('nav'))
  }));

  assert(state.renderMode === 'fallback', `[fallback] expected renderMode fallback, got ${state.renderMode}`);
  assert(state.hasModeSwitch, '[fallback] mode switch should still exist in fallback mode');
  assert(state.hasNav, '[fallback] shared nav should remain available in fallback mode');
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
