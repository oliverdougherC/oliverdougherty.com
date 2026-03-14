#!/usr/bin/env node

const { chromium } = require('playwright');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WEBGL_ARGS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'];
const REQUIRE_WEBGL = process.env.GALLERY_REQUIRE_WEBGL !== '0';

function isLocalBaseUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function parsePortFromBaseUrl(url) {
  const match = url.match(/^http:\/\/[^:]+:(\d+)/);
  return match ? Number(match[1]) : 4173;
}

function startLocalServerIfNeeded(targetUrl) {
  if (!isLocalBaseUrl(targetUrl)) return null;
  if (process.env.GALLERY_PERF_URL) return null;

  const port = parsePortFromBaseUrl(targetUrl);
  return spawn('python3', ['-m', 'http.server', String(port)], {
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

async function run() {
  const target = process.argv[2] || process.env.GALLERY_PERF_URL || 'http://127.0.0.1:4173/pages/gallery/index.html';
  const serverProcess = startLocalServerIfNeeded(target);
  await waitForServer(target);

  const browser = await chromium.launch({ headless: true, args: WEBGL_ARGS });
  try {
    const context = await browser.newContext({ viewport: { width: 1536, height: 960 } });
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

    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, 1600);
      await page.waitForTimeout(260);
    }

    await page.click('#galleryModeIndex');
    await page.waitForTimeout(300);
    await page.click('#galleryModeOverview');
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      window.__galleryApp?.handleCanvasClick?.(window.innerWidth * 0.5, window.innerHeight * 0.5);
    });
    await page.waitForFunction(() => window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 5000 });
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      document.getElementById('galleryFocusOverlay')?.click();
    });
    await page.waitForFunction(() => !window.__galleryApp?.sceneController?.isFocused?.(), null, { timeout: 5000 });
    await page.waitForTimeout(450);

    const stats = await page.evaluate(() => window.__galleryPerfStats || null);
    const state = await page.evaluate(() => ({
      mode: window.__galleryApp?.getMode?.() || null,
      hasApi: typeof window.__galleryApp?.setMode === 'function' && typeof window.__galleryApp?.getMode === 'function',
      rowCount: document.querySelectorAll('#galleryIndexList .gallery-index-btn').length,
      entries: window.__galleryApp?.entries?.length || 0,
      renderMode: window.__galleryRenderMode || null
    }));

    console.log('Perf stats:', { startupMs, ...stats, ...state });

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

    if (!['overview', 'index'].includes(stats.mode)) {
      throw new Error(`Unexpected gallery mode value in perf stats: ${stats.mode}`);
    }

    console.log(`Perf probe OK: startup ${startupMs}ms, ${stats.fps} fps, ${stats.avgFrameMs}ms avg`);
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
