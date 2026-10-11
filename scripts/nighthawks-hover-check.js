#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output/playwright/nighthawks-hover');
const SOURCE = fs.readFileSync(path.join(ROOT, 'assets/art/nighthawks-binary.txt'), 'utf8').trimEnd();
const grid = page => page.locator('#nighthawksCharacters').textContent().then(text => text.trimEnd());

async function check(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/?full=1`);
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork').dataset.renderMode === 'text');
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const bounds = await page.locator('#nighthawksArtwork').boundingBox();
    const move = (x, y) => page.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
    const settled = async () => {
      assert.equal(await grid(page), SOURCE, 'All characters must return to the exact original painting');
      assert.equal(await page.locator('.nighthawks-hover').isVisible(), false, 'Idle glow is hidden');
    };
    await move(0.4, 0.4);
    await page.clock.runFor(500);
    await settled();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(100);
    await page.clock.runFor(100);
    await move(0.45, 0.4);
    await page.clock.runFor(100);
    const first = await grid(page);
    const changed = [...first].filter((glyph, index) => glyph !== SOURCE[index]).length;
    assert(changed > 60 && changed < 800, `Hover affects a broad local brush, not the entire grid (${changed})`);
    for (let i = 0; i < SOURCE.length; i++) {
      if (SOURCE[i] !== '0' && SOURCE[i] !== '1') assert.equal(first[i], SOURCE[i], 'Letters, whitespace and row boundaries stay intact');
    }
    await page.clock.runFor(250);
    assert.notEqual(await grid(page), first, 'A stationary pointer keeps its digits flipping');
    await move(0.75, 0.55);
    await page.clock.runFor(100);
    await page.screenshot({ path: path.join(OUTPUT, `${browser.browserType().name()}-hover.png`) });
    await page.mouse.move(0, 0);
    const onLeave = await grid(page);
    await page.clock.runFor(600);
    assert.notEqual(await grid(page), onLeave, 'Trail continues flipping after the cursor leaves');
    assert.notEqual(await grid(page), SOURCE, 'Trail persists briefly after leaving');
    await page.clock.runFor(2400);
    await settled();
    const mutations = await page.evaluate(() => {
      window.__hoverMutations = 0;
      new MutationObserver(records => { window.__hoverMutations += records.length; }).observe(document.querySelector('#nighthawksCharacters'), { childList: true, characterData: true, subtree: true });
      return window.__hoverMutations;
    });
    await page.clock.runFor(1000);
    assert.equal(await page.evaluate(() => window.__hoverMutations), mutations, 'Idle artwork stops updating');
    await page.screenshot({ path: path.join(OUTPUT, `${browser.browserType().name()}-settled.png`) });

    // Every interruption restores the original and allows a new interaction.
    for (const interrupt of ['resize', 'scroll', 'blur', 'pagehide', 'pointercancel', 'visibilitychange']) {
      await move(0.35, 0.5);
      await page.clock.runFor(100);
      assert.notEqual(await grid(page), SOURCE, `Hover restarts before ${interrupt}`);
      await page.evaluate(type => {
        if (type === 'visibilitychange') {
          Object.defineProperty(document, 'hidden', { configurable: true, value: true });
          document.dispatchEvent(new Event(type));
          delete document.hidden;
        } else if (type === 'pointercancel') document.querySelector('#nighthawksArtwork').dispatchEvent(new PointerEvent(type));
        else window.dispatchEvent(new Event(type));
      }, interrupt);
      await settled();
      await page.mouse.move(0, 0);
    }
    await move(0.5, 0.5);
    await page.clock.runFor(100);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(100);
    await settled();
    await page.clock.runFor(3000);
    await settled();
    assert.deepEqual(errors, []);
  } finally { await page.close(); }

  const touch = await browser.newPage({ viewport: { width: 800, height: 900 }, hasTouch: true, reducedMotion: 'reduce' });
  try {
    await touch.goto(`${baseUrl}/?full=1`);
    await touch.waitForFunction(() => document.querySelector('#nighthawksArtwork').dataset.renderMode === 'text');
    await touch.emulateMedia({ reducedMotion: 'no-preference' });
    await touch.locator('#nighthawksArtwork').dispatchEvent('pointermove', { pointerType: 'touch', clientX: 300, clientY: 300 });
    await touch.waitForTimeout(200);
    assert.equal(await grid(touch), SOURCE, 'Touch does not start hover motion');
  } finally { await touch.close(); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const server = await startLocalStaticServer({ url: 'http://127.0.0.1:0', cwd: ROOT });
  try {
    for (const name of (process.env.NIGHTHAWKS_CHECK_BROWSERS || 'chromium').split(',')) {
      const browser = await { chromium, firefox, webkit }[name].launch({ timeout: 30000 });
      try { await check(browser, server.url); console.log(`Nighthawks hover checks passed (${name}).`); }
      finally { await browser.close(); }
    }
  } finally { server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
