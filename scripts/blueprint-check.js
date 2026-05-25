#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', 'blueprint-check');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
let baseUrl = process.env.BLUEPRINT_CHECK_URL || DEFAULT_BASE_URL;

const BROWSERS = [
  { name: 'chromium', launcher: chromium },
  { name: 'firefox', launcher: firefox },
  { name: 'webkit', launcher: webkit }
];

const FRAMES = [
  { label: 'mid-trace', delayMs: 3000 },
  { label: 'pre-complete', delayMs: 6800 }
];

const VIEWPORTS = [
  { label: '1x', width: 1600, height: 1100, deviceScaleFactor: 1 },
  { label: '2x', width: 1600, height: 1100, deviceScaleFactor: 2 }
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function prepareContext(browser, viewport) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor
  });

  await context.addInitScript(() => {
    try {
      window.sessionStorage.removeItem('od-page-animations-seen');
    } catch (_error) {
      // Ignore storage access issues in automation contexts.
    }
    try {
      window.localStorage.removeItem('od-color-mode');
    } catch (_error) {
      // Ignore storage access issues in automation contexts.
    }
  });

  return context;
}

async function waitForBlueprintReady(page) {
  await page.waitForFunction(() => {
    const title = document.querySelector('.blueprint-title');
    return title?.classList.contains('is-blueprint-ready');
  }, { timeout: 15000 });
}

async function pauseAnimations(page) {
  await page.evaluate(() => {
    const selectors = [
      '.blueprint-drafting-layer',
      '.blueprint-grid-line',
      '.blueprint-outline-text',
      '.blueprint-final-word'
    ];

    document.querySelectorAll(selectors.join(',')).forEach((element) => {
      element.getAnimations().forEach((animation) => {
        animation.pause();
      });
    });
  });
}

async function captureFrame(page, browserName, viewportLabel, frame) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  await waitForBlueprintReady(page);
  await page.waitForTimeout(frame.delayMs);
  await pauseAnimations(page);
  await page.waitForTimeout(120);

  const filename = `${browserName}-${viewportLabel}-${frame.label}.png`;
  await page.screenshot({
    path: path.join(OUTPUT_DIR, filename),
    fullPage: false
  });

  return filename;
}

async function assertBlueprintStructure(page, browserName) {
  const state = await page.evaluate(() => {
    const title = document.querySelector('.blueprint-title');
    const draftingLayer = document.querySelector('.blueprint-drafting-layer');
    return {
      ready: title?.classList.contains('is-blueprint-ready') === true,
      gridLines: document.querySelectorAll('.blueprint-grid-line').length,
      tspans: document.querySelectorAll('.blueprint-outline-text').length,
      hasSketchFilter: draftingLayer
        ? window.getComputedStyle(draftingLayer).filter.includes('url(')
        : false
    };
  });

  assert(state.ready, `[${browserName}] blueprint overlay should be ready`);
  assert(state.gridLines > 0, `[${browserName}] expected blueprint grid lines`);
  assert(state.tspans === 10, `[${browserName}] expected 10 letter outlines, got ${state.tspans}`);
  assert(!state.hasSketchFilter, `[${browserName}] sketch filter should be removed`);
}

async function runBrowser(browserEntry, viewport) {
  const browser = await browserEntry.launcher.launch({ headless: true });

  try {
    const context = await prepareContext(browser, viewport);
    const page = await context.newPage();

    for (const frame of FRAMES) {
      const filename = await captureFrame(page, browserEntry.name, viewport.label, frame);
      console.log(`Captured ${filename}`);
    }

    await assertBlueprintStructure(page, browserEntry.name);
    await context.close();
  } finally {
    await browser.close();
  }
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const server = await startLocalStaticServer({
    url: baseUrl,
    cwd: ROOT,
    skip: Boolean(process.env.BLUEPRINT_CHECK_URL),
    bindHost: null
  });
  baseUrl = server?.url || baseUrl;

  try {
    await waitForServer(baseUrl);

    for (const browserEntry of BROWSERS) {
      for (const viewport of VIEWPORTS) {
        await runBrowser(browserEntry, viewport);
      }
      console.log(`Verified blueprint animation in ${browserEntry.name}.`);
    }

    console.log('Blueprint animation checks passed.');
  } finally {
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

run().catch((error) => {
  console.error('Blueprint check failed:', error.message);
  process.exit(1);
});
