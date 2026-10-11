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
    await page.addInitScript(() => {
      let seed = 42;
      Math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
    });
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
    assert(changed > 15 && changed < 70, `Hover randomizes a tight brush rather than inverting every bit (${changed})`);
    for (let i = 0; i < SOURCE.length; i++) {
      if (SOURCE[i] !== '0' && SOURCE[i] !== '1') assert.equal(first[i], SOURCE[i], 'Letters, whitespace and row boundaries stay intact');
    }
    const changes = [];
    let previous = first;
    for (let sample = 0; sample < 15; sample++) {
      await page.clock.runFor(100);
      const current = await grid(page);
      changes.push([...current].filter((glyph, index) => glyph !== previous[index]).length);
      previous = current;
    }
    assert(changes.filter(count => count > 0).length >= 13, 'Independent flips remain active between collective beats');
    assert(new Set(changes).size >= 5, 'The number of switching cells varies irregularly');
    assert(Math.max(...changes) < 45, 'The brush does not flash most of its cells in unison');
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

    const credits = ['NIGHTHAWKS', 'EDWARD HOPPER, 1942'];
    for (const credit of credits) {
      const start = SOURCE.indexOf(credit);
      const row = Math.floor(start / 201);
      const column = start % 201;
      await move((column + credit.length / 2) / 200, (row + 0.5) / 63);
      await page.clock.runFor(400);
      const scrambled = await grid(page);
      assert.notEqual(scrambled.slice(start, start + credit.length), credit, 'Hovered credit text scrambles');
      const letters = [...credit].map((glyph, index) => /[A-Z]/.test(glyph) ? start + index : -1).filter(index => index >= 0);
      assert(letters.filter(index => scrambled[index] !== SOURCE[index]).length >= 3, 'Credit letters participate, not just the surrounding bits');
      for (let index = 0; index < SOURCE.length; index++) {
        if (/\s/.test(SOURCE[index])) assert.equal(scrambled[index], SOURCE[index], 'Credit spacing and row boundaries stay intact');
      }
      await page.screenshot({ path: path.join(OUTPUT, `${browser.browserType().name()}-credit-${row}.png`) });
      await page.mouse.move(0, 0);
      await page.clock.runFor(2800);
      await settled();
    }

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

async function checkDuringReveal(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      // Compare the visible highlight glyphs with the live grid after every
      // text update, catching either animation overwriting the other for a frame.
      const clear = CanvasRenderingContext2D.prototype.clearRect;
      const fill = CanvasRenderingContext2D.prototype.fillText;
      let glyphs = [];
      window.__hoverDisagreements = 0;
      CanvasRenderingContext2D.prototype.clearRect = function (...args) {
        if (this.canvas.className === 'nighthawks-hover') glyphs = [];
        return clear.apply(this, args);
      };
      CanvasRenderingContext2D.prototype.fillText = function (glyph, x, y, ...args) {
        if (this.canvas.className === 'nighthawks-hover') {
          const width = parseFloat(document.querySelector('#nighthawksCharacters').style.width);
          glyphs.push({ index: Math.floor(y / 26) * 201 + Math.round(x / (width / 200)), glyph });
        }
        return fill.call(this, glyph, x, y, ...args);
      };
      document.addEventListener('DOMContentLoaded', () => {
        const pre = document.querySelector('#nighthawksCharacters');
        new MutationObserver(() => {
          if (glyphs.some(({ index, glyph }) => pre.textContent[index] !== glyph)) window.__hoverDisagreements++;
        }).observe(pre, { childList: true, characterData: true, subtree: true });
      });
    });
    const time = new Date('2026-10-01T12:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 10000));
    await page.goto(`${baseUrl}/?full=1&art-preview=1`);
    for (let elapsed = 0; elapsed < 1500; elapsed += 16) {
      if (await page.locator('#nighthawksArtwork').getAttribute('data-render-mode') === 'text') break;
      await page.clock.runFor(16);
    }
    assert.equal(await page.locator('#nighthawksArtwork').getAttribute('data-reveal'), 'switching');
    const box = await page.locator('#nighthawksArtwork').boundingBox();
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.4);
    await page.clock.runFor(100);
    assert(await page.locator('.nighthawks-hover').isVisible(), 'Pointer reacts during the initial white-digit phase');
    await page.mouse.move(0, 0);
    await page.clock.runFor(2800);
    assert.equal(await page.locator('.nighthawks-hover').isVisible(), false, 'Early trail expires before the reveal finishes');
    assert.notEqual(await grid(page), SOURCE, 'An expired trail rejoins the ongoing reveal without prematurely settling it');
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await page.clock.runFor(1000);
    await page.screenshot({ path: path.join(OUTPUT, `${browser.browserType().name()}-hover-during-reveal.png`) });
    await page.clock.runFor(2900);
    assert.equal(await page.locator('#nighthawksArtwork').getAttribute('data-reveal'), 'color');
    assert(await page.locator('.nighthawks-hover').isVisible(), 'Hover continues through the color phase');
    const creditStart = SOURCE.indexOf('NIGHTHAWKS');
    await page.mouse.move(box.x + box.width * 8 / 200, box.y + box.height * 58.5 / 63);
    await page.clock.runFor(1000);
    assert.equal(await page.locator('#nighthawksArtwork').getAttribute('data-reveal'), 'complete');
    assert(await page.locator('.nighthawks-hover').isVisible(), 'Finishing the reveal preserves the active brush');
    assert.notEqual(await grid(page), SOURCE, 'Pointer keeps flipping after the reveal completes');
    assert.notEqual((await grid(page)).slice(creditStart, creditStart + 9), 'NIGHTHAWKS', 'Credit scrambling survives reveal completion');
    await page.mouse.move(0, 0);
    await page.clock.runFor(2800);
    assert.equal(await grid(page), SOURCE, 'Combined animation settles to the exact source');
    assert.equal(await page.evaluate(() => window.__hoverDisagreements), 0, 'Reveal and hover always display matching glyphs');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const server = await startLocalStaticServer({ url: 'http://127.0.0.1:0', cwd: ROOT });
  try {
    for (const name of (process.env.NIGHTHAWKS_CHECK_BROWSERS || 'chromium').split(',')) {
      const browser = await { chromium, firefox, webkit }[name].launch({ timeout: 30000 });
      try {
        await check(browser, server.url);
        await checkDuringReveal(browser, server.url);
        console.log(`Nighthawks hover checks passed (${name}).`);
      }
      finally { await browser.close(); }
    }
  } finally { server.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
