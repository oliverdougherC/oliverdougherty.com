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
      transition: getComputedStyle(pre).transitionProperty,
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

async function settled(page, label = 'completed reveal') {
  const state = await advanceUntil(page, (state) => state.phase === 'complete' && state.mode === 'text', 'settled text');
  assertGrid(state, true);
  assert.equal(state.filter, 'none', `${label}: completed reveal must release its filter`);
  assert.equal(state.transition, 'none', `${label}: global motion resets must not create a renderer transition`);
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
      if (allowedResourceErrors && /downloadable font: download failed.*nighthawks-mono-bold\.ttf/.test(message.text())) return;
      errors.push(message.text());
    });
    const time = new Date('2026-10-01T12:00:00Z');
    await page.clock.install({ time });
    // Clock installation advances real time on some engines; pausing at the
    // install instant can already be in the past. Advance the blank page first.
    await page.clock.pauseAt(new Date(time.getTime() + 10000));
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
    ['pagehide', (page) => page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')))]
  ];
  for (const [label, interrupt] of interruptions) {
    await withPage(browser, {}, async (page) => {
      await advanceUntil(page, (state) => state.phase === 'switching', `${label}: wave begins`);
      await page.clock.runFor(200);
      await interrupt(page);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await page.clock.runFor(48);
      assert.equal((await snapshot(page)).phase, 'complete', `${label} must complete immediately`);
      await settled(page, label);
      await page.clock.runFor(7000);
      await settled(page);
    });
  }
}

async function checkUninterruptedPlayback(browser) {
  const surroundings = [
    ['small scroll', 1000, (page) => page.evaluate(() => window.scrollTo({ top: 100, behavior: 'instant' }))],
    ['scroll during tonal development', 3100, (page) => page.evaluate(() => window.scrollTo({ top: 100, behavior: 'instant' }))],
    ['scroll during final color', 6700, (page) => page.evaluate(() => window.scrollTo({ top: 100, behavior: 'instant' }))],
    ['collapsed stage', 1000, (page) => page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }))],
    ['hidden tab', 1000, (page) => page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    })],
    ['motion preference change', 1000, (page) => page.emulateMedia({ reducedMotion: 'reduce' })]
  ];
  for (const [label, elapsed, change] of surroundings) {
    await withPage(browser, {}, async (page) => {
      await advanceUntil(page, (state) => state.phase === 'switching', `${label}: reveal begins`);
      await page.clock.runFor(elapsed);
      const before = await snapshot(page);
      await change(page);
      // Native scroll/media notifications are delivered outside the mocked JS clock.
      await new Promise((resolve) => setTimeout(resolve, 80));
      await page.clock.runFor(96);
      const after = await snapshot(page);
      assert.equal(after.phase, before.phase, `${label}: playback must not finish early`);
      assertGrid(after, elapsed >= 6400);
      if (elapsed >= 2400) assert.notEqual(after.filter, before.filter, `${label}: tones must keep developing`);
      if (elapsed < 6400) assert.notEqual(after.grid, before.grid, `${label}: cells must keep switching`);
      if (label === 'collapsed stage') {
        assert(await page.evaluate(() => document.documentElement.classList.contains('home-stage-collapsed')
          && !document.documentElement.classList.contains('home-stage')
          && document.querySelector('.nighthawks-hero').getBoundingClientRect().bottom <= 0),
        'The stage must shrink normally while the artwork is fully off-screen');
        // Leave it off-screen for part of the reveal, then return before it finishes.
        await page.clock.runFor(600);
        const offscreen = await snapshot(page);
        assert.equal(offscreen.phase, 'switching');
        assert.notEqual(offscreen.grid, after.grid, 'Off-screen cells must keep switching');
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await new Promise((resolve) => setTimeout(resolve, 80));
        await page.clock.runFor(96);
        assert.equal((await snapshot(page)).phase, 'switching', 'Returning to the painting must not restart or finish it');
        await page.clock.runFor(6900 - elapsed - 96 - 600 - 96);
      } else {
        await page.clock.runFor(6900 - elapsed - 96);
      }
      assert.equal((await snapshot(page)).phase, 'color', `${label}: preserve the final color phase`);
      await page.clock.runFor(700);
      assert.equal((await snapshot(page)).phase, 'complete', `${label}: preserve the original completion time`);
      await settled(page, label);
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

// CSS loading and native scroll events do not run on Playwright's paused JS
// clock. Await their real completion before advancing the bootstrap's rAF.
async function nativeEventWithin(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: native browser event was not delivered`)), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

async function checkScrollBeforeRenderer(browser, delayedStyles = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let releaseStyles;
  const stylesPending = new Promise(resolve => { releaseStyles = resolve; });
  let rendererRequests = 0;
  try {
    await context.route('**/js/nighthawks.js*', async (route) => {
      rendererRequests++;
      await pending;
      await route.continue().catch(() => {});
    });
    if (delayedStyles) await context.route('**/css/home.css*', async route => {
      await stylesPending;
      await route.continue().catch(() => {});
    });
    const page = await context.newPage();
    const time = new Date('2026-10-01T12:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 10000));
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'commit' });
    await page.locator('#contact').waitFor({ state: 'attached' });
    let stylesReady = false;
    const readiness = nativeEventWithin(page.evaluate(() => Promise.all(
      [...document.querySelectorAll('link[rel="stylesheet"]')]
        .filter(link => new URL(link.href).origin === location.origin)
        .map(link => link.sheet ? Promise.resolve() : new Promise((resolve, reject) => {
          link.addEventListener('load', resolve, { once: true });
          link.addEventListener('error', () => reject(new Error(`Stylesheet failed: ${link.href}`)), { once: true });
        }))
    )), 'Home stylesheets').then(() => { stylesReady = true; });
    if (delayedStyles) {
      // Reproduce the CI race: parsed contact markup does not mean the staged
      // layout exists yet. The readiness barrier must stay pending here.
      assert.equal(await page.evaluate(() => Boolean(document.querySelector('link[href*="css/home.css"]').sheet)), false);
      assert.equal(stylesReady, false, 'Attached markup must not bypass pending layout styles');
      releaseStyles();
    }
    await readiness;
    const layout = await page.evaluate(() => {
      const hero = document.querySelector('.nighthawks-hero');
      return { display: getComputedStyle(hero).display, height: hero.getBoundingClientRect().height,
        bottom: window.scrollY + hero.getBoundingClientRect().bottom, viewport: innerHeight,
        maxScroll: document.scrollingElement.scrollHeight - innerHeight };
    });
    assert(layout.display === 'flex' && layout.height >= layout.viewport - 1,
      `The actual first-visit stage must be styled before scrolling: ${JSON.stringify(layout)}`);
    assert(layout.maxScroll >= layout.bottom + 4, 'The document must have enough scroll range to move the entire stage off-screen');
    const scroll = await nativeEventWithin(page.evaluate(() => new Promise(resolve => {
      const delivered = event => {
        const heroBottom = document.querySelector('.nighthawks-hero').getBoundingClientRect().bottom;
        if (window.scrollY <= 0 || heroBottom > -4) return;
        window.removeEventListener('scroll', delivered);
        resolve({ y: window.scrollY, heroBottom, trusted: event.isTrusted });
      };
      window.addEventListener('scroll', delivered, { passive: true });
      window.scrollTo({ top: document.scrollingElement.scrollHeight, behavior: 'instant' });
    })), 'Early off-screen scroll');
    assert(scroll.trusted && scroll.y > 0 && scroll.heroBottom <= -4, 'A native off-screen scroll must reach the bootstrap listener before its rAF is advanced');
    assert.equal(rendererRequests, 1, 'The renderer request is still held while the inline bootstrap handles scrolling');
    await page.clock.runFor(96);
    assert(await page.evaluate(() => document.documentElement.classList.contains('home-stage-collapsed')),
      'Early scrolling must collapse the stage before the renderer downloads');
    release();
    await page.waitForLoadState('load');
    await advanceUntil(page, (state) => state.phase === 'switching', 'Scrolled first visit must still start the reveal');
    await page.clock.runFor(6900);
    assert.equal((await snapshot(page)).phase, 'color', 'Off-screen startup must preserve the reveal duration');
    await page.clock.runFor(700);
    await settled(page);
  } finally {
    release();
    releaseStyles();
    await context.close();
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
        await checkUninterruptedPlayback(browser);
        await checkInterruptions(browser);
        await checkResourceFailures(browser);
        await checkScrollBeforeRenderer(browser);
        await checkScrollBeforeRenderer(browser, true);
        await checkDelayedRenderer(browser);
        console.log(`Verified ${name}: reveal sequence, exact grid restoration, static visits, uninterrupted scrolling/off-screen playback, page-exit cleanup, resource failures and watchdog.`);
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
