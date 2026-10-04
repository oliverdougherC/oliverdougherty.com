#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output', 'lynx-reader');
const prose = 'Dr. Rivera opened the window. Across the quiet street, a bicycle leaned against the wall; someone had left a small bunch of flowers in its basket. “Perhaps they will come back,” she thought.\n\nBy 3.14 on the laboratory clock, the rain had stopped. The extraordinarily patient visitor put away her well-worn notebook and walked outside. Nothing hurried her now.';
const q = name => `[data-lynx-${name}]`;
async function seek(page, index) {
  await page.locator(q('seek')).evaluate((node, value) => { node.value = String(value); node.dispatchEvent(new Event('input')); }, index);
}
async function speed(page, wpm) {
  await page.locator(q('wpm')).evaluate((node, value) => { node.value = String(value); node.dispatchEvent(new Event('input')); }, wpm);
}
async function fits(page) {
  const problems = await page.evaluate(() => {
    const problems = [];
    if (document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1) problems.push('page scrolls');
    for (const node of document.querySelectorAll('#lynxReaderApp, #lynxReaderApp *')) {
      if (node.closest('[hidden]')) continue;
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.left < -1 || box.right > innerWidth + 1 || box.top < -1 || box.bottom > innerHeight + 1) problems.push(`${node.className || node.tagName} outside viewport`);
      if (node.tagName !== 'TEXTAREA' && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) problems.push('internal scrolling');
    }
    return problems;
  });
  assert.deepEqual(problems, []);
}

async function runLynxChecks(browser, baseUrl) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const measurements = [];
  try {
    await page.goto(`${baseUrl}/pages/utilities/index.html`, { waitUntil: 'networkidle' });
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').some(r => /lynxReaderController/.test(r.name))), false, 'Reader should load lazily');
    await page.locator('[data-utility="lynx-reader"]').click();
    await page.locator(q('source')).waitFor();
    assert.equal(await page.locator(q('read')).isDisabled(), true);
    await page.locator(q('source')).fill(prose);
    await page.locator(q('source')).press('Space');
    assert.equal(await page.locator(q('entry')).isVisible(), true);
    await page.locator(q('read')).click();
    assert.equal(await page.locator(q('word')).getAttribute('aria-label'), 'Dr.');
    assert.equal(await page.locator(q('play')).getAttribute('aria-pressed'), 'false');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => Number(document.querySelector('[data-lynx-seek]').value) > 0);
    await page.keyboard.press('Space');
    const paused = await page.locator(q('position')).textContent();
    await page.waitForTimeout(350);
    assert.equal(await page.locator(q('position')).textContent(), paused);
    await page.locator(q('play')).click();
    await page.locator(q('forward')).click();
    assert.equal(await page.locator(q('play')).getAttribute('aria-pressed'), 'false');
    await seek(page, 12);
    await speed(page, 450);
    assert.match(await page.locator(q('position')).textContent(), /^13 /);
    await page.locator(q('play')).click();
    await speed(page, 600);
    assert.equal(await page.locator(q('play')).getAttribute('aria-pressed'), 'true');
    await page.locator(q('reset')).click();
    assert.match(await page.locator(q('position')).textContent(), /^1 /);
    await seek(page, 20);
    await page.locator(q('play')).click();
    await page.selectOption('#utilitySwitcher', 'stress-test');
    const hiddenPosition = await page.locator(q('position')).textContent();
    await page.waitForTimeout(350);
    await page.goBack();
    await page.locator(q('reader')).waitFor();
    assert.equal(await page.locator(q('position')).textContent(), hiddenPosition);
    assert.equal(await page.locator(q('speed')).textContent(), '600');
    assert.equal(await page.locator(q('play')).getAttribute('aria-pressed'), 'false');
    await page.goForward();
    await page.locator('#stressTestApp').waitFor();
    await page.selectOption('#utilitySwitcher', 'lynx-reader');
    await page.locator(q('edit')).click();
    assert.match(await page.locator(q('source')).inputValue(), /Dr\. Rivera/);

    // Geometry, grapheme anchor and long-token fit in both views, including live resize.
    const sample = 'a “understanding,” 123456789 café cafe\u0301 👩🏽‍💻 日本語 ' + 'extraordinarily'.repeat(20);
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 600], [800, 600]]) {
      await page.setViewportSize({ width, height });
      await page.locator(q('source')).fill(prose.repeat(1000));
      await fits(page);
      await page.screenshot({ path: path.join(OUTPUT, `entry-${width}x${height}.png`) });
      await page.locator(q('source')).fill(sample);
      await page.locator(q('read')).click();
      await page.evaluate(() => document.fonts.ready);
      for (let index = 0; index < 8; index++) {
        await seek(page, index);
        await fits(page);
        const delta = await page.evaluate(() => {
          const letter = document.querySelector('[data-lynx-letter]').getBoundingClientRect();
          const display = document.querySelector('[data-lynx-display]').getBoundingClientRect();
          return Math.abs((letter.left + letter.right) / 2 - (display.left + display.right) / 2);
        });
        assert.ok(delta < 0.6, `ORP moved by ${delta}px at ${width}x${height}`);
      }
      await seek(page, 1);
      await page.locator(q('display')).focus();
      await page.keyboard.press('ArrowRight');
      assert.match(await page.locator(q('position')).textContent(), /^8 /);
      await page.keyboard.press('ArrowLeft');
      assert.match(await page.locator(q('position')).textContent(), /^1 /);
      await page.screenshot({ path: path.join(OUTPUT, `reader-${width}x${height}.png`) });
      await page.locator(q('edit')).click();
    }

    // Real timers: include every dwell, including the final word, in measured throughput.
    await page.locator(q('source')).fill(prose);
    await page.locator(q('read')).click();
    for (const wpm of [150, 300, 450, 600]) {
      await page.locator(q('reset')).click();
      await speed(page, wpm);
      const result = await page.evaluate(async () => {
        const total = Number(document.querySelector('[data-lynx-seek]').max) + 1;
        const status = document.querySelector('[data-lynx-status]');
        const started = performance.now();
        await new Promise(resolve => {
          const observer = new MutationObserver(() => { if (status.textContent === 'Finished') { observer.disconnect(); resolve(); } });
          observer.observe(status, { childList: true });
          document.querySelector('[data-lynx-play]').click();
        });
        const elapsed = performance.now() - started;
        return { total, elapsed, effectiveWpm: total * 60000 / elapsed };
      });
      assert.ok(Math.abs(result.effectiveWpm / wpm - 1) < 0.08, `Effective WPM: ${JSON.stringify(result)}`);
      measurements.push({ targetWpm: wpm, ...result });
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator(q('source')).waitFor();
    await page.locator(q('source')).fill('one two three');
    await page.locator(q('read')).click();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.querySelector('[data-lynx-status]').textContent === 'Finished');
    await fits(page);
    await page.locator('.nav-back-btn').click();
    assert.equal(await page.locator('#utilitiesTitleView').isVisible(), true);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(OUTPUT, 'measurements.json'), JSON.stringify(measurements, null, 2) + '\n');
    console.log('Lynx Reader browser checks passed:', JSON.stringify(measurements));
  } finally { await page.close(); }
}

module.exports = { runLynxChecks };
if (require.main === module) {
  (async () => {
    const server = await startLocalStaticServer({ cwd: ROOT, url: 'http://127.0.0.1:4189' });
    const baseUrl = server.url;
    let browser;
    try {
      await waitForServer(baseUrl);
      browser = await chromium.launch({ headless: true });
      await runLynxChecks(browser, baseUrl);
    } finally { await browser?.close(); server.kill('SIGTERM'); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
