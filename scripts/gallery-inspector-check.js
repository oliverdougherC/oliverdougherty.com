#!/usr/bin/env node
// Inspector geometry, keyboard access, and coupled photo/border readiness.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const { startLocalStaticServer, markAnimationsSeen } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const engine = process.env.BROWSER || 'chromium';
const output = path.join(ROOT, 'output/playwright/inspector', engine);

async function ready(page) {
  await page.waitForFunction(() => {
    const image = document.getElementById('lightboxImage');
    return image?.complete && image.naturalWidth > 0 && document.getElementById('lightboxMedia').getAttribute('aria-busy') === 'false';
  });
  await page.waitForFunction(() => [...document.querySelectorAll('.lightbox-thumb img')].filter(image => {
    const r = image.getBoundingClientRect();
    return r.left < innerWidth && r.right > 0;
  }).every(image => image.complete && image.naturalWidth > 0));
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const server = await startLocalStaticServer({ url: 'http://127.0.0.1:0', cwd: ROOT });
  let browser;
  const results = [];
  try {
    browser = await playwright[engine].launch({ timeout: 30000 });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await markAnimationsSeen(context);
    // Optional font service must not stall geometry/readiness regressions.
    await context.route('https://fonts.googleapis.com/**', route => route.fulfill({ contentType: 'text/css', body: '' }));
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/assets/photos/*/lighthouse.*', async route => { await gate; await route.continue(); });
    await page.goto(`${server.url}/pages/gallery/?full=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#galleryHeroOpen[data-entry-id]');
    const pending = await page.locator('#galleryHeroOpen').evaluate(button => ({
      border: getComputedStyle(button).borderTopWidth,
      shadow: getComputedStyle(button).boxShadow,
      pictureOpacity: getComputedStyle(button.querySelector('picture')).opacity,
      loaded: button.classList.contains('is-loaded')
    }));
    assert.deepEqual(pending, { border: '0px', shadow: 'none', pictureOpacity: '0', loaded: false }, 'No photo frame may appear while its image is pending');
    await page.screenshot({ path: path.join(output, 'hero-pending.png') });
    release();
    await page.waitForFunction(() => document.getElementById('galleryHeroOpen').classList.contains('is-loaded')
      && getComputedStyle(document.getElementById('galleryHeroPicture')).opacity === '1');
    await page.screenshot({ path: path.join(output, 'hero-ready.png') });
    results.push('Hero image and border share one decoded visibility layer');
    const tileWidths = await page.locator('.photo-card').evaluateAll(cards => cards.map(card => ({
      title: card.querySelector('img').alt,
      assigned: card.getBoundingClientRect().width,
      rendered: card.querySelector('.photo-media').getBoundingClientRect().width
    })));
    assert(tileWidths.length > 0, 'Mosaic must be rendered');
    assert.deepEqual(tileWidths.filter(tile => Math.abs(tile.assigned - tile.rendered) > 0.1), [], 'Every photo frame must fill its assigned mosaic tile');
    results.push('Rendered mosaic frames exactly fill their assigned tile widths');
    await page.locator('#galleryHeroOpen').click();
    await ready(page);
    for (const [width, height] of [[1440, 900], [1024, 768], [900, 700], [768, 900], [390, 844], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await ready(page);
      if (width <= 900 && await page.locator('#lightboxInfoToggle').getAttribute('aria-expanded') === 'true') {
        await page.locator('#lightboxInfoToggle').click();
      }
      const geometry = await page.evaluate(() => {
        const box = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        return { image: box('#lightboxImage'), stage: box('.lightbox-stage'), toolbar: box('.lightbox-topbar'), strip: box('.lightbox-strip'), shell: box('.lightbox-shell'),
          controls: ['#lightboxPrev', '#lightboxNext', '#lightboxClose'].map(box) };
      });
      const { image, stage, toolbar, strip, controls, shell } = geometry;
      assert(image.width > 0 && image.height > 0, 'Selected photograph is visible');
      assert(image.top >= toolbar.bottom - 1 && image.bottom <= strip.top + 1, 'Photograph must fit between toolbar and filmstrip');
      assert(image.left >= stage.left - 1 && image.right <= stage.right + 1, 'Photograph must fit the stage');
      assert(shell.right <= width && shell.bottom <= height, 'Viewer must fit viewport');
      assert(controls.every(control => control.width >= 40 && control.height >= 40 && control.left >= 0 && control.right <= width), 'Navigation remains reachable at every size');
      await page.screenshot({ path: path.join(output, `viewer-${width}x${height}.png`) });
      if (width <= 900) {
        await page.locator('#lightboxInfoToggle').click();
        assert.equal(await page.locator('#lightboxPanel').getAttribute('aria-hidden'), null);
        await page.locator('.lightbox-meta-summary').focus();
        assert.equal(await page.evaluate(() => document.activeElement.className), 'lightbox-meta-summary');
        await page.screenshot({ path: path.join(output, `details-${width}x${height}.png`) });
        await page.locator('#lightboxInfoToggle').click();
        assert.equal(await page.locator('#lightboxPanel').getAttribute('aria-hidden'), 'true');
        assert.equal(await page.locator('#lightboxThumbStrip').evaluate(strip => Boolean(strip.closest('[inert]'))), false, 'Filmstrip stays accessible when details close');
      }
      results.push(`Photo and controls fit ${width}×${height}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/photos/photos.json'), 'utf8'));
    const tallest = [...manifest.photos].sort((a, b) => a.width / a.height - b.width / b.height)[0];
    await page.locator(`.lightbox-thumb[data-entry-id="${tallest.id}"]`).click();
    await ready(page);
    await page.screenshot({ path: path.join(output, 'viewer-tallest.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#lightbox').getAttribute('hidden'), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'galleryHeroOpen', 'Close restores trigger focus');
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`${engine}: ${results.join('; ')}; alternate aspect ratio and focus restoration pass.`);
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ engine, status: 'pass', results }, null, 2) + '\n');
  } finally {
    await browser?.close();
    server?.kill();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
