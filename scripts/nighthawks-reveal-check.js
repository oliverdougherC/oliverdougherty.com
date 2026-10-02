#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { markAnimationsSeen, startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output/playwright/nighthawks-reveal');
const SOURCE = fs.readFileSync(path.join(ROOT, 'assets/art/nighthawks-binary.txt'), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');
const BROWSERS = { chromium, firefox, webkit };
const names = (process.env.NIGHTHAWKS_CHECK_BROWSERS || 'chromium').split(',').map((name) => name.trim());
let baseUrl = process.env.NIGHTHAWKS_CHECK_URL || 'http://127.0.0.1:4173';

async function snapshot(page) {
  return page.evaluate(() => {
    const art = document.querySelector('#nighthawksArtwork');
    const pre = document.querySelector('#nighthawksCharacters');
    const fallback = art.querySelector('.nighthawks-fallback');
    const signal = art.querySelector('.nighthawks-signal');
    const visible = (element) => {
      if (!element || !element.getBoundingClientRect().height) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    return {
      phase: art.dataset.reveal,
      pending: Boolean(document.documentElement.dataset.homeArtDeadline),
      signal: Boolean(signal),
      mode: art.dataset.renderMode,
      grid: pre.textContent.replace(/\r\n/g, '\n').replace(/\n$/, ''),
      preCount: art.querySelectorAll('pre').length,
      elements: pre.childElementCount,
      nodes: pre.childNodes.length,
      filter: getComputedStyle(pre).filter,
      mask: getComputedStyle(pre).maskImage || getComputedStyle(pre).webkitMaskImage,
      fill: getComputedStyle(pre).webkitTextFillColor,
      background: getComputedStyle(pre).backgroundImage,
      animations: pre.getAnimations().map((animation) => animation.effect.getKeyframes()),
      fallbackVisible: visible(fallback),
      textVisible: visible(pre),
      stage: document.documentElement.classList.contains('home-stage')
    };
  });
}

function assertGrid(state, settled = false) {
  assert.equal(state.preCount, 1, 'The entire reveal must use one live text grid');
  assert.equal(state.elements, 0, 'Reveal must not create per-cell elements');
  assert.equal(state.nodes, 1, 'Reveal must preserve one text node');
  const rows = state.grid.split('\n');
  assert.equal(rows.length, 63, 'Reveal must preserve 63 rows');
  rows.forEach((row) => assert.equal(row.length, 200, 'Reveal must preserve 200 columns'));
  if (settled) assert.equal(state.grid, SOURCE, 'Settled artwork must restore the exact source and credits');
}

async function advanceUntil(page, predicate, label, maxMs = 4000) {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += 16) {
    const state = await snapshot(page);
    if (predicate(state)) return state;
    await page.clock.runFor(16);
  }
  throw new Error(`${label}: timed out; state=${JSON.stringify(await snapshot(page), (key, value) => key === 'grid' ? undefined : value)}`);
}

// Playwright's clock controls JS timers/rAF, but CSS and WAAPI use the compositor clock.
async function compositorUntil(page, predicate, label, maxMs = 2500) {
  const start = Date.now();
  do {
    const state = await snapshot(page);
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 40));
  } while (Date.now() - start < maxMs);
  throw new Error(`${label}: compositor did not settle`);
}

async function settled(page) {
  const state = await advanceUntil(page, (state) => state.phase === 'complete' && state.mode === 'text', 'settled text');
  assertGrid(state, true);
  assert.equal(state.filter, 'none', 'Completed reveal must release its filter');
  assert.equal(state.fill, 'rgba(0, 0, 0, 0)', 'Completed reveal must release its uniform fill');
  assert.equal(state.animations.length, 0, 'Completed reveal must release its animation');
  assert.equal(state.signal, false, 'No duplicate character layer should remain');
  assert(state.textVisible && !state.fallbackVisible, 'Completed text must replace the fallback');
  return state;
}

async function withPage(browser, options, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options.context });
  const errors = [];
  const allowedResourceErrors = options.resourceFailure;
  try {
    if (options.returning) await markAnimationsSeen(context);
    if (options.setup) await options.setup(context);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (allowedResourceErrors && /Failed to load resource|Loading failed|NetworkError|ERR_FAILED/.test(message.text())) return;
      errors.push(message.text());
    });
    const time = new Date('2026-10-01T12:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(time);
    await page.goto(`${baseUrl}${options.route || '/index.html?full=1'}`, { waitUntil: options.stalled ? 'domcontentloaded' : 'load' });
    await run(page);
    assert.deepEqual(errors, [], 'Unexpected browser errors');
  } finally {
    await context.close();
  }
}

async function checkSequence(browser, name) {
  await withPage(browser, {}, async (page) => {
    await advanceUntil(page, (state) => state.phase === 'switching', 'switchboard begins');
    const initial = await snapshot(page);
    assertGrid(initial);
    assert(initial.stage && initial.textVisible);
    assert.equal(initial.fill, 'rgb(255, 255, 255)');
    assert.equal(initial.filter, 'grayscale(1)');
    assert.equal(initial.mask, 'none', 'The reveal must not have an expanding mask');
    assert(/^[01\n]+$/.test(initial.grid), 'Every cell must begin as a white binary digit');
    const flips = new Uint8Array(SOURCE.length);
    const lastChanges = new Uint16Array(SOURCE.length);
    let previous = initial.grid;
    let previousAlpha = 1;
    for (let time = 40; time <= 6440; time += 40) {
      await page.clock.runFor(40);
      const grid = await page.locator('#nighthawksCharacters').textContent();
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] !== previous[i]) { flips[i]++; lastChanges[i] = time; }
      }
      previous = grid;
      if ([1600, 3200, 4800].includes(time)) {
        const middle = await snapshot(page);
        assert.equal(middle.phase, 'switching', 'Tones must develop while characters still switch');
        assert.notEqual(middle.grid, SOURCE, 'The painting must remain unsettled through the middle');
        const alpha = Number(middle.fill.match(/, ([0-9.]+)\)$/)?.[1]);
        assert(alpha > 0 && alpha < previousAlpha, 'The white fill must gradually release image shading');
        previousAlpha = alpha;
        const grayscale = Number(middle.filter.match(/grayscale\(([0-9.]+)\)/)?.[1]);
        assert(time < 2400 ? grayscale === 1 : grayscale > 0 && grayscale < 1,
          'Saturation must follow the early monochrome shading');
        assert.equal(middle.mask, 'none');
        await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}-emerging-${time}.png`) });
      }
    }
    const binaryFlips = Array.from(flips).filter((_, i) => SOURCE[i] === '0' || SOURCE[i] === '1');
    assert(binaryFlips.every((count) => count >= 2 && count <= 10), 'Each binary cell must perform 2–10 actual flips');
    assert(new Set(binaryFlips).size >= 8, 'Cells must have varied flip counts');
    assert(Array.from(lastChanges).some((time) => time > 0 && time < 2000), 'Some cells must settle early');
    assert(Array.from(lastChanges).some((time) => time > 5600), 'Some cells must continue late in the tonal reveal');
    const color = await snapshot(page);
    assert.equal(color.phase, 'color');
    assertGrid(color, true);
    await page.setViewportSize({ width: 1100, height: 800 });
    // ResizeObserver delivery uses native rendering, outside Playwright's JS clock.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await page.clock.runFor(48);
    assert(await page.locator('#nighthawksCharacters').evaluate((pre) =>
      Math.abs(pre.getBoundingClientRect().width - pre.parentElement.getBoundingClientRect().width) < 2),
    'The developing grid must still fit after a resize');
    await settled(page);
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${name}-complete.png`) });
    await page.reload({ waitUntil: 'load' });
    const returning = await settled(page);
    assert(!returning.stage, 'Same-session reload must skip the first-visit stage');
  });
}

async function checkSkipped(browser) {
  for (const options of [{ returning: true }, { context: { reducedMotion: 'reduce' } }, { route: '/mobile/' }]) {
    await withPage(browser, options, async (page) => {
      const state = await advanceUntil(page, (state) => state.mode === 'text', 'static text readiness');
      assert.equal(state.phase, 'complete', 'Returning, reduced-motion and mobile visits must skip the reveal');
      assert(!state.pending, 'Skipped intros must release the fallback immediately');
      assertGrid(state, true);
      assert.equal(state.filter, 'none');
      assert.equal(state.animations.length, 0);
    });
  }
}

async function checkInterruptions(browser) {
  await withPage(browser, {}, async (page) => {
    await advanceUntil(page, (state) => state.phase === 'switching', 'stalled frame: wave begins');
    await page.clock.fastForward(8000);
    const completed = await snapshot(page);
    assert.equal(completed.phase, 'complete', 'A stalled frame should complete without an extra reveal phase');
    assertGrid(completed, true);
    await settled(page);
    await page.clock.runFor(7000);
    await settled(page);
  });
  const interruptions = [
    ['scroll', (page) => page.evaluate(() => window.scrollTo({ top: 100, behavior: 'instant' }))],
    ['scroll during tonal development', async (page) => {
      await page.clock.runFor(3100);
      await page.evaluate(() => window.scrollTo({ top: 100, behavior: 'instant' }));
    }],
    ['scroll during final color', async (page) => {
      await page.clock.runFor(6700);
      await page.evaluate(() => window.scrollTo({ top: 100, behavior: 'instant' }));
    }],
    ['reduced-motion change', (page) => page.emulateMedia({ reducedMotion: 'reduce' })],
    ['pagehide', (page) => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))],
    ['hidden tab', (page) => page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    })]
  ];
  for (const [label, interrupt] of interruptions) {
    await withPage(browser, {}, async (page) => {
      await advanceUntil(page, (state) => state.phase === 'switching', `${label}: wave begins`);
      await page.clock.runFor(200);
      await interrupt(page);
      // Native scroll/media notifications are delivered outside the mocked JS clock.
      await new Promise((resolve) => setTimeout(resolve, 80));
      await page.clock.runFor(48);
      assert.equal((await snapshot(page)).phase, 'complete', `${label} must complete immediately`);
      await settled(page);
      await page.clock.runFor(7000);
      await settled(page);
    });
  }
}

async function checkResourceFailures(browser) {
  for (const resource of ['**/assets/fonts/nighthawks-mono-bold.ttf', '**/assets/art/nighthawks-colors.png']) {
    await withPage(browser, {
      resourceFailure: true,
      setup: (context) => context.route(resource, (route) => route.abort())
    }, async (page) => {
      const state = await advanceUntil(page, (state) => state.phase === 'complete' && state.fallbackVisible, 'failed resource fallback');
      assert.equal(state.mode, 'fallback');
      assert(!state.textVisible);
      assertGrid(state, true);
    });
  }
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  try {
    await withPage(browser, {
      stalled: true,
      setup: (context) => context.route('**/assets/fonts/nighthawks-mono-bold.ttf', async (route) => {
        await pending;
        await route.continue().catch(() => {});
      })
    }, async (page) => {
      const waiting = await snapshot(page);
      assert.equal(waiting.phase, 'waiting');
      assert(!waiting.fallbackVisible && !waiting.textVisible, 'Pending first visit must begin black');
      await page.clock.runFor(1900);
      const fallback = await snapshot(page);
      assert.equal(fallback.phase, 'complete', 'Watchdog must end the reveal');
      await compositorUntil(page, (state) => state.fallbackVisible, 'Watchdog must restore visible fallback');
      release();
      await page.waitForLoadState('load');
      await settled(page);
    });
  } finally {
    release();
  }
}

async function checkDelayedRenderer(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  try {
    await context.route('**/js/nighthawks.js*', async (route) => {
      await pending;
      await route.continue().catch(() => {});
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const fallback = document.querySelector('.nighthawks-fallback');
      const image = fallback?.querySelector('img');
      return image?.complete && image.naturalWidth > 0
        && Number(getComputedStyle(fallback).opacity) > 0.99;
    });
    release();
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === 'text');
    const state = await snapshot(page);
    assert.equal(state.phase, 'complete', 'A late renderer must not restart the intro after exposing the painting');
    assertGrid(state, true);
  } finally {
    release();
    await context.close();
  }
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(process.env.NIGHTHAWKS_CHECK_URL) });
  if (server) baseUrl = server.url;
  try {
    await waitForServer(baseUrl);
    for (const name of names) {
      assert(BROWSERS[name], `Unknown browser: ${name}`);
      const browser = await BROWSERS[name].launch();
      try {
        await checkSequence(browser, name);
        await checkSkipped(browser);
        await checkInterruptions(browser);
        await checkResourceFailures(browser);
        await checkDelayedRenderer(browser);
        console.log(`Verified ${name}: reveal sequence, exact grid restoration, static visits, interruption cleanup, resource failures and watchdog.`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    server?.kill();
  }
}

run().catch((error) => {
  console.error('Nighthawks reveal check failed:', error);
  process.exitCode = 1;
});
