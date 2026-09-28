#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const BROWSERS = { chromium, firefox, webkit };
const browserName = process.env.BROWSER || 'chromium';
let baseUrl = process.env.BASE_URL || 'http://127.0.0.1:4173';
const fixturePath = '/__blackout-storage-check__.html';

async function openFixture(browser, blocked = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ blockedStorage }) => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query === '(hover: hover) and (pointer: fine)') return { matches: true };
      return originalMatchMedia(query);
    };
    const originalSetItem = Storage.prototype.setItem;
    window.__storageWrites = { battery: [], pointer: [] };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'od-flashlight-battery') window.__storageWrites.battery.push(value);
      if (key === 'od-flashlight-pointer') window.__storageWrites.pointer.push(value);
      if (blockedStorage) throw new Error('Storage blocked by test');
      return originalSetItem.call(this, key, value);
    };

    const originalSetTimeout = window.setTimeout.bind(window);
    const originalClearTimeout = window.clearTimeout.bind(window);
    const timers = new Set();
    window.setTimeout = (callback, delay, ...args) => {
      const id = originalSetTimeout(() => {
        timers.delete(id);
        callback(...args);
      }, delay);
      timers.add(id);
      return id;
    };
    window.clearTimeout = (id) => {
      timers.delete(id);
      originalClearTimeout(id);
    };
    window.__timerHarness = { pending: () => timers.size };

    let nextFrameId = 1;
    let timestamp = 0;
    const frames = new Map();
    window.requestAnimationFrame = (callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => frames.delete(id);
    window.__frameHarness = {
      pending: () => frames.size,
      step: (count) => {
        for (let index = 0; index < count; index += 1) {
          timestamp += 16;
          const callbacks = [...frames.values()];
          frames.clear();
          for (const callback of callbacks) callback(timestamp);
        }
      }
    };
  }, { blockedStorage: blocked });
  await context.route(`**${fixturePath}`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: `<!doctype html><html><head><title>Blackout storage check</title></head>
      <body class="page-home"><button data-flashlight-toggle type="button">
      <span class="lights-on-label">Lights on</span><span class="lights-off-label">Lights off</span>
      </button><script src="/js/main.js"></script></body></html>`
  }));
  const page = await context.newPage();
  await page.goto(`${baseUrl}${fixturePath}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('[data-flashlight-toggle]')?.getAttribute('aria-pressed') === 'false',
    null, { polling: 50, timeout: 3000 });
  return { context, page };
}

async function checkWriteCadence(browser) {
  const { context, page } = await openFixture(browser);
  try {
    const result = await page.evaluate(() => {
      const button = document.querySelector('[data-flashlight-toggle]');
      const move = (target, x, y) => target.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: x, clientY: y, pointerType: 'mouse'
      }));
      const assertNoFramesBeforeEnable = window.__frameHarness.pending() === 0;
      const assertNoTimersBeforeEnable = window.__timerHarness.pending() === 0;
      move(button, 100, 120);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 100, clientY: 120, detail: 1 }));
      for (let index = 0; index < 120; index += 1) {
        move(window, 200 + index, 300 + index);
        window.__frameHarness.step(1);
      }
      const beforeBoundary = {
        battery: window.__storageWrites.battery.length,
        pointer: window.__storageWrites.pointer.length,
        beamX: document.documentElement.style.getPropertyValue('--flashlight-x'),
        frames: window.__frameHarness.pending()
      };
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      const afterPagehide = {
        battery: sessionStorage.getItem('od-flashlight-battery'),
        pointer: sessionStorage.getItem('od-flashlight-pointer')
      };
      move(window, 350, 370);
      window.__frameHarness.step(2);
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
      const afterHidden = {
        frames: window.__frameHarness.pending(),
        battery: sessionStorage.getItem('od-flashlight-battery'),
        pointer: sessionStorage.getItem('od-flashlight-pointer')
      };
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      move(window, 400, 420);
      window.__frameHarness.step(4);
      window.dispatchEvent(new Event('blur'));
      const afterBlur = window.__frameHarness.pending();
      move(window, 400, 420);
      window.__frameHarness.step(4);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 420, detail: 1 }));
      return {
        assertNoFramesBeforeEnable,
        assertNoTimersBeforeEnable,
        beforeBoundary,
        afterPagehide,
        afterHidden,
        afterBlur,
        afterDisable: {
          battery: sessionStorage.getItem('od-flashlight-battery'),
          pointer: sessionStorage.getItem('od-flashlight-pointer'),
          frames: window.__frameHarness.pending(),
          timers: window.__timerHarness.pending(),
          mode: localStorage.getItem('od-flashlight-mode'),
          writes: {
            battery: window.__storageWrites.battery.length,
            pointer: window.__storageWrites.pointer.length
          }
        }
      };
    });
    console.log(`${browserName}: 120 frames + 120 pointer moves: battery writes=${result.beforeBoundary.battery}, pointer writes=${result.beforeBoundary.pointer}`);
    assert(result.assertNoFramesBeforeEnable, 'Blackout disabled should not queue animation frames');
    assert(result.assertNoTimersBeforeEnable, 'Blackout disabled should not queue timers');
    assert.equal(result.beforeBoundary.beamX, '319px', 'Visible pointer beam did not follow the last move');
    assert.equal(result.beforeBoundary.frames, 1, 'Enabled blackout should have one queued animation frame');
    assert(result.beforeBoundary.battery <= 12, 'Battery writes were not substantially reduced');
    assert(result.beforeBoundary.pointer <= 12, 'Pointer writes were not substantially reduced');
    assert.equal(result.afterPagehide.battery, String(60000 - 119 * 16), 'Pagehide did not flush final battery state');
    assert.equal(result.afterPagehide.pointer, '319,419', 'Pagehide did not flush final pointer position');
    assert.equal(result.afterHidden.frames, 1, 'Visibility flush changed the battery-loop policy');
    assert.equal(result.afterHidden.pointer, '350,370', 'Visibility change did not flush pending pointer position');
    assert(Number(result.afterHidden.battery) < Number(result.afterPagehide.battery),
      'Visibility change did not flush pending battery drain');
    assert.equal(result.afterBlur, 0, 'Blur should suspend the battery loop');
    assert.equal(result.afterDisable.mode, 'off', 'Toggle off did not persist mode');
    assert.equal(result.afterDisable.pointer, '400,420', 'Toggle off did not flush final pointer position');
    assert.equal(result.afterDisable.frames, 0, 'Disabled blackout left animation frames queued');
    assert.equal(result.afterDisable.timers, 0, 'Disabled blackout left persistence timers queued');
    assert(result.afterDisable.writes.battery <= 15 && result.afterDisable.writes.pointer <= 15,
      'Transition boundaries caused excessive storage writes');
    return result;
  } finally {
    await context.close();
  }
}

async function checkTimedCheckpoint(browser) {
  const { context, page } = await openFixture(browser);
  try {
    await page.evaluate(() => {
      const button = document.querySelector('[data-flashlight-toggle]');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 30, clientY: 40, detail: 1 }));
      window.__frameHarness.step(4);
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: 88, clientY: 99, pointerType: 'mouse'
      }));
      window.__frameHarness.step(5);
    });
    await page.waitForFunction(() => sessionStorage.getItem('od-flashlight-pointer') === '88,99'
      && Number(sessionStorage.getItem('od-flashlight-battery')) < 60000,
    null, { polling: 50, timeout: 3000 });
    const writes = await page.evaluate(() => ({
      battery: window.__storageWrites.battery.length,
      pointer: window.__storageWrites.pointer.length,
      timers: window.__timerHarness.pending()
    }));
    assert(writes.battery <= 3 && writes.pointer <= 3,
      `Timed checkpoint wrote too often: ${JSON.stringify(writes)}`);
    assert.equal(writes.timers, 0, 'Checkpoint timer did not settle');
  } finally {
    await context.close();
  }
}

async function checkBlockedStorage(browser) {
  const { context, page } = await openFixture(browser, true);
  try {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.evaluate(() => {
      const button = document.querySelector('[data-flashlight-toggle]');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 60, detail: 1 }));
      window.__frameHarness.step(60);
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 50, clientY: 60, detail: 1 }));
    });
    assert.deepEqual(errors, [], 'Blocked storage threw during blackout transitions');
    assert.equal(await page.locator('[data-flashlight-toggle]').getAttribute('aria-pressed'), 'false');
  } finally {
    await context.close();
  }
}

async function checkNavigation(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'domcontentloaded' });
    const toggle = page.locator('[data-flashlight-toggle]');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pointerBeforeNavigation = await page.evaluate(() => sessionStorage.getItem('od-flashlight-pointer'));
    assert(pointerBeforeNavigation, 'Toggle did not retain its activation position');
    await page.goto(`${baseUrl}/pages/resume/index.html?full=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-flashlight-toggle]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await page.evaluate(() => localStorage.getItem('od-flashlight-mode')), 'on',
      'Cross-page navigation lost blackout mode');
    const continuation = await page.evaluate(() => ({
      battery: Number(sessionStorage.getItem('od-flashlight-battery')),
      pointer: sessionStorage.getItem('od-flashlight-pointer')
    }));
    assert(continuation.battery > 0 && continuation.battery < 60000,
      'Cross-page navigation reset battery drain');
    assert.equal(continuation.pointer, pointerBeforeNavigation, 'Cross-page navigation lost pointer position');
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-flashlight-toggle]')?.getAttribute('aria-pressed') === 'true');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('[data-flashlight-toggle]')?.getAttribute('aria-pressed') === 'false');
    assert.equal(await page.evaluate(() => localStorage.getItem('od-flashlight-mode')), 'off',
      'Reload should reset blackout mode');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('od-flashlight-battery')), null,
      'Reload should clear the carried battery state');
  } finally {
    await context.close();
  }
}

async function run() {
  assert(BROWSERS[browserName], `Unknown browser: ${browserName}`);
  const server = await startLocalStaticServer({ url: baseUrl, cwd: process.env.STATIC_ROOT || ROOT, skip: Boolean(process.env.BASE_URL) });
  baseUrl = server?.url || baseUrl;
  try {
    await waitForServer(baseUrl);
    const browser = await BROWSERS[browserName].launch({ headless: true });
    try {
      await checkWriteCadence(browser);
      await checkTimedCheckpoint(browser);
      await checkBlockedStorage(browser);
      await checkNavigation(browser);
      console.log(`${browserName}: blackout storage, suspension, blocked storage, navigation, history, and reload verified.`);
    } finally {
      await browser.close();
    }
  } finally {
    if (server) server.kill('SIGTERM');
  }
}

run().catch((error) => { console.error('Blackout storage check failed:', error); process.exitCode = 1; });
