#!/usr/bin/env node

const { chromium } = require('playwright');
const path = require('node:path');
const {
  clearStoredTheme,
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const WEBGL_ARGS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'];
const REQUIRE_WEBGL = process.env.GALLERY_REQUIRE_WEBGL !== '0';

async function waitForRenderReady(page, timeoutMs = 12000) {
  const started = Date.now();
  await page.waitForFunction(
    () => {
      const mode = window.__galleryRenderMode;
      const app = window.__galleryApp;
      return mode && mode !== 'initializing' && app && typeof app.getMode === 'function';
    },
    null,
    { timeout: timeoutMs }
  );

  const mode = await page.evaluate(() => window.__galleryRenderMode || null);
  return { startupMs: Date.now() - started, mode };
}

async function waitForInputSettle(page, timeoutMs = 5000) {
  await page.waitForFunction(
    () => {
      const controller = window.__galleryApp?.inputController;
      return Boolean(
        controller
        && (performance.now() - (controller.lastImpulseAt || 0)) > 280
        && !controller.springActive
        && Math.abs(controller.velocityItems || 0) <= 0.001
        && Math.abs(controller.springVelocityItems || 0) <= 0.001
      );
    },
    null,
    { timeout: timeoutMs }
  );
}

async function run() {
  let target = process.argv[2] || process.env.GALLERY_PERF_URL || 'http://127.0.0.1:4173/pages/gallery/index.html';
  const serverProcess = await startLocalStaticServer({ url: target, cwd: ROOT, skip: Boolean(process.env.GALLERY_PERF_URL) });
  target = serverProcess?.url || target;
  await waitForServer(target);

  const browser = await chromium.launch({ headless: true, args: WEBGL_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: 1536, height: 960 } });
    await clearStoredTheme(context);
    const page = await context.newPage();

    await page.goto(target, { waitUntil: 'domcontentloaded' });
    const { startupMs, mode: startupMode } = await waitForRenderReady(page);
    await page.waitForTimeout(900);

    const renderMode = startupMode || await page.evaluate(() => window.__galleryRenderMode || null);
    if (!renderMode || renderMode === 'initializing') {
      throw new Error(`Gallery render mode did not become ready within probe window (startup ${startupMs}ms, mode=${renderMode})`);
    }
    if (REQUIRE_WEBGL && renderMode !== 'render') {
      throw new Error(`Expected WebGL render mode, got ${renderMode}`);
    }

    await page.evaluate(() => {
      const app = window.__galleryApp;
      app?.setMode?.('overview');
      app?.sceneController?.jumpToIndex?.(3);
      app?.inputController?.setCurrentIndex?.(3);
      app?.uiController?.setActive?.(3, app?.entries?.[3]);
    });
    await page.waitForTimeout(760);

    const wheelStart = await page.evaluate(() => ({
      progress: window.__galleryApp?.inputController?.progressItems ?? 0,
      activeIndex: window.__galleryApp?.sceneController?.activeIndex ?? 0
    }));

    await page.mouse.move(768, 520);
    await page.mouse.wheel(0, 320);
    await page.waitForFunction((startProgress) => {
      const controller = window.__galleryApp?.inputController;
      return Boolean(
        controller
        && (
          Math.abs((controller.targetItems ?? startProgress) - startProgress) > 0.05
          || Math.abs((controller.progressItems ?? startProgress) - startProgress) > 0.05
        )
      );
    }, wheelStart.progress, { timeout: 1200 });
    const wheelMid = await page.evaluate(() => ({
      progress: window.__galleryApp?.inputController?.progressItems ?? 0,
      target: window.__galleryApp?.inputController?.targetItems ?? 0
    }));
    await waitForInputSettle(page);

    const wheelEnd = await page.evaluate(() => ({
      progress: window.__galleryApp?.inputController?.progressItems ?? 0,
      activeIndex: window.__galleryApp?.sceneController?.activeIndex ?? 0,
      inertialVelocity: window.__galleryApp?.sceneController?.getLayoutDebugState?.()?.inertialVelocity ?? 0
    }));
    const wheelImpulseDelta = Math.max(wheelMid.progress, wheelMid.target) - wheelStart.progress;
    const wheelCommittedDelta = wheelEnd.progress - wheelStart.progress;

    const materialState = await page.evaluate(() => {
      const app = window.__galleryApp;
      const item = app?.sceneController?.items?.[app?.sceneController?.activeIndex ?? 0];
      return item ? {
        backPaneOpacity: item.backPaneMaterial?.opacity ?? 0,
        rimOpacity: item.rimMaterial?.opacity ?? 0,
        glazeOpacity: item.glazeMaterial?.opacity ?? 0,
        shadowOpacity: item.shadowMaterial?.opacity ?? 0
      } : null;
    });

    const inspectStart = Date.now();
    await page.evaluate(() => {
      const app = window.__galleryApp;
      const active = app?.sceneController?.activeIndex ?? 0;
      app?.handleInspectToggle?.(active);
    });
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
    const inspectEnterMs = Date.now() - inspectStart;

    const inspectState = await page.evaluate(() => {
      const debug = window.__galleryApp?.sceneController?.getLayoutDebugState?.();
      return {
        focusBlend: window.__galleryApp?.sceneController?.focusBlend ?? 0,
        maxNonActiveOpacity: debug?.maxNonActiveOpacity ?? 1,
        overlayBackgroundColor: getComputedStyle(document.getElementById('galleryFocusOverlay')).backgroundColor
      };
    });

    const inspectExitStart = Date.now();
    await page.evaluate(() => {
      window.__galleryApp?.handleCanvasClick?.(8, 8);
    });
    await page.waitForFunction(() => !window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 5000 });
    const inspectExitMs = Date.now() - inspectExitStart;
    await page.waitForTimeout(420);

    const stats = await page.evaluate(() => window.__galleryPerfStats || null);
    const state = await page.evaluate(() => ({
      mode: window.__galleryApp?.getMode?.() || null,
      hasApi: typeof window.__galleryApp?.setMode === 'function' && typeof window.__galleryApp?.getMode === 'function',
      rowCount: document.querySelectorAll('#galleryIndexList .gallery-index-btn').length,
      entries: window.__galleryApp?.entries?.length || 0,
      renderMode: window.__galleryRenderMode || null,
      focused: window.__galleryApp?.sceneController?.isFocused?.() || false,
      focusIndex: window.__galleryApp?.sceneController?.focusIndex ?? -1
    }));

    console.log('Perf stats:', {
      startupMs,
      wheelImpulseDelta: Number(wheelImpulseDelta.toFixed(3)),
      wheelCommittedDelta: Number(wheelCommittedDelta.toFixed(3)),
      inspectEnterMs,
      inspectExitMs,
      inspectFocusBlend: inspectState.focusBlend,
      inspectMaxNonActiveOpacity: inspectState.maxNonActiveOpacity,
      materialState,
      ...stats,
      ...state
    });

    await context.close();

    if (!stats) {
      throw new Error('No perf stats exposed on window.__galleryPerfStats');
    }
    if (!state.hasApi) {
      throw new Error('Gallery mode API is missing (setMode/getMode)');
    }
    if (state.renderMode !== 'render') {
      throw new Error(`Gallery render mode regressed after inspect cycle: ${state.renderMode}`);
    }
    if (state.rowCount !== state.entries) {
      throw new Error(`Index row count mismatch (${state.rowCount} vs ${state.entries})`);
    }
    if (state.focused) {
      throw new Error(`Inspect exit regressed; scene still reports focused at index ${state.focusIndex}`);
    }
    if (startupMs > 7500) {
      throw new Error(`Gallery startup exceeds threshold: ${startupMs}ms > 7500ms`);
    }
    if (stats.fps < 2) {
      throw new Error(`FPS below threshold: ${stats.fps} < 2`);
    }
    if (stats.avgFrameMs > 500) {
      throw new Error(`Average frame time above threshold: ${stats.avgFrameMs}ms > 500ms`);
    }
    if (stats.framesSampled < 18) {
      throw new Error(`Insufficient frame sample size: ${stats.framesSampled} < 18`);
    }
    if (wheelImpulseDelta < 0.35 || wheelImpulseDelta > 0.7) {
      throw new Error(`Medium wheel burst outside target impulse band: ${wheelImpulseDelta.toFixed(3)} panes`);
    }
    if (wheelCommittedDelta < 0.8 || wheelCommittedDelta > 1.15) {
      throw new Error(`Wheel burst failed to settle forward cleanly: ${wheelCommittedDelta.toFixed(3)} panes`);
    }
    if (inspectEnterMs > 900) {
      throw new Error(`Inspect settle exceeds threshold: ${inspectEnterMs}ms > 900ms`);
    }
    if (inspectExitMs > 800) {
      throw new Error(`Inspect exit exceeds threshold: ${inspectExitMs}ms > 800ms`);
    }
    if (inspectState.maxNonActiveOpacity > 0.08) {
      throw new Error(`Inspect non-active panes remain too visible: ${inspectState.maxNonActiveOpacity} > 0.08`);
    }
    if (inspectState.overlayBackgroundColor !== 'rgba(0, 0, 0, 0)') {
      throw new Error(`Inspect overlay became opaque: ${inspectState.overlayBackgroundColor}`);
    }
    if (!materialState) {
      throw new Error('Active pane material metrics unavailable');
    }
    if (materialState.backPaneOpacity < 0.03) {
      throw new Error(`Back pane opacity too low for glass read: ${materialState.backPaneOpacity}`);
    }
    if (materialState.rimOpacity < 0.05) {
      throw new Error(`Rim opacity too low for glass edge: ${materialState.rimOpacity}`);
    }
    if (materialState.glazeOpacity < 0.025) {
      throw new Error(`Glaze opacity too low for specular layer: ${materialState.glazeOpacity}`);
    }
    if (!['overview', 'index'].includes(stats.mode)) {
      throw new Error(`Unexpected gallery mode value in perf stats: ${stats.mode}`);
    }

    console.log(`Perf probe OK: startup ${startupMs}ms, wheel impulse ${wheelImpulseDelta.toFixed(3)} panes, ${stats.fps} fps, ${stats.avgFrameMs}ms avg`);
  } finally {
    await browser.close();
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
