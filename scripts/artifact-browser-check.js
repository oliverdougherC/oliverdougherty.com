#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const browsers = require('playwright');
const base = process.env.BASE_URL;
const name = process.env.BROWSER || 'chromium';
const output = path.resolve(__dirname, '../output/release');
const requiredRoutes = ['/', '/mobile/', '/pages/resume/', '/mobile/resume/', '/pages/gallery/', '/mobile/gallery/', '/pages/utilities/'];

async function waitForAudioAnalysis(page) {
  try {
    await page.waitForFunction(() => document.getElementById('audioFourierApp').dataset.audioState === 'error'
      || !document.getElementById('audioFourierPlayBtn').disabled, null, { timeout: 60000 });
    const state = await page.locator('#audioFourierApp').getAttribute('data-audio-state');
    assert.notEqual(state, 'error', await page.locator('#audioFourierStatusText').textContent());
  } catch (error) {
    const state = await page.evaluate(() => ({
      state: document.getElementById('audioFourierApp')?.dataset.audioState,
      status: document.getElementById('audioFourierStatusText')?.textContent,
      progress: document.getElementById('audioFourierProgressText')?.textContent,
      details: document.getElementById('audioFourierProgressMeta')?.textContent
    }));
    fs.writeFileSync(path.join(output, `${name}-audio-failure.json`), JSON.stringify(state, null, 2));
    throw new Error(`${error.message}; audio state: ${JSON.stringify(state)}`, { cause: error });
  }
}

async function main() {
  assert(base, 'BASE_URL must point to the packaged site');
  fs.mkdirSync(output, { recursive: true });
  const browser = await browsers[name].launch({ headless: true });
  const results = [{ browser: name, version: browser.version() }];
  try {
    for (const gone of ['/blogs/', '/pages/archive/', '/pages/does-not-exist/']) {
      const response = await fetch(base + gone);
      assert.equal(response.status, 404, `${gone}: must remain deliberately unavailable`);
      assert((await response.text()).includes('not-found-number'), `${gone}: must serve the custom 404 page`);
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true }));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    page.on('requestfailed', request => { if (!request.failure()?.errorText.includes('ABORT')) errors.push(`${request.url()}: ${request.failure()?.errorText}`); });
    for (const route of requiredRoutes) {
      await page.goto(base + route, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator('main').count(), 1, `${route}: main landmark missing`);
      assert((await page.title()).length > 0, `${route}: page title missing`);
      const failedImages = await page.locator('img').evaluateAll(images => images.filter(image => image.getBoundingClientRect().width > 0 && image.complete && !image.naturalWidth && image.getAttribute('src')).map(image => image.src));
      assert.deepEqual(failedImages, [], `${route}: broken visible images`);
      await page.screenshot({ path: path.join(output, `${name}-${route.replaceAll('/', '-') || 'home'}.png`), fullPage: false });
      results.push({ route, status: 'pass' });
    }
    // Direct hashes, real lazy imports and worker-backed output, reload/history.
    for (const utility of ['image-transform', 'audio-fourier', 'stress-test']) {
      await page.goto(`${base}/pages/utilities/#${utility}`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('html').getAttribute('data-active-utility'), utility);
      if (utility === 'image-transform') {
        await page.click('#transformGenerateBtn');
        await page.waitForFunction(() => document.getElementById('utilitiesApp').dataset.transformHasResult === 'true', null, { timeout: 45000 });
      } else if (utility === 'audio-fourier') {
        await page.click('#audioFourierGenerateBtn');
        await waitForAudioAnalysis(page);
      } else {
        await page.click('[data-stress-mode-option="cpu"]');
        await page.click('#stressStartBtn');
        await page.waitForFunction(() => Number(document.getElementById('stressTestApp').dataset.stressLatestPrime) > 1);
        await page.click('#stressStopBtn');
        await page.waitForSelector('#stressTestApp[data-stress-state="idle"]');
      }
      for (const viewport of [{ width: 1024, height: 520 }, { width: 960, height: 540 }]) {
        await page.setViewportSize(viewport);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const ids = utility === 'image-transform' ? ['transformGenerateBtn', 'transformResetBtn']
          : utility === 'audio-fourier' ? ['audioFourierGenerateBtn', 'audioFourierResetBtn', 'audioFourierPlayBtn'] : ['stressStartBtn', 'stressStopBtn'];
        for (const id of ids) {
          const reachable = await page.locator(`#${id}`).evaluate(element => {
            const rect = element.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && (hit === element || element.contains(hit));
          });
          assert(reachable, `${utility}: ${id} unreachable at ${viewport.width}x${viewport.height}`);
        }
        await page.screenshot({ path: path.join(output, `${name}-${utility}-${viewport.width}x${viewport.height}.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload({ waitUntil: 'networkidle' });
      assert.equal(await page.locator('html').getAttribute('data-active-utility'), utility);
      await page.click('.nav-back-btn');
      await page.goBack({ waitUntil: 'load' });
      assert.equal(await page.locator('html').getAttribute('data-active-utility'), utility);
      results.push({ utility, status: 'pass' });
    }
    assert.deepEqual(errors, [], 'Unexpected packaged-site browser errors');
    await context.close();

    // Expected failures are isolated from the clean-route error collector.
    const failedEntry = await browser.newPage();
    await failedEntry.route('**/utilities-app-*.js', request => request.fulfill({ status: 404, body: 'Removed entry' }));
    await failedEntry.goto(base + '/pages/utilities/', { waitUntil: 'networkidle' });
    assert(await failedEntry.locator('#utilityEntryError').isVisible(), 'Missing entry must offer recovery without the module executing');
    await failedEntry.unroute('**/utilities-app-*.js');
    await failedEntry.locator('#utilityEntryError button').click();
    await failedEntry.waitForLoadState('networkidle');
    assert.equal(await failedEntry.locator('#utilityEntryError').isVisible(), false);
    await failedEntry.close();
    for (const [route, selector] of [['/pages/gallery/', '#galleryError'], ['/mobile/gallery/', '#mobileGalleryError']]) {
      const failed = await browser.newPage();
      await failed.route('**/assets/photos/photos.json', request => request.fulfill({ status: 503, body: 'Unavailable' }));
      await failed.goto(base + route, { waitUntil: 'networkidle' });
      assert(await failed.locator(selector).isVisible(), `${route}: missing manifest must have a visible error`);
      await failed.close();
    }
    const brokenImage = await browser.newPage();
    await brokenImage.route(/\/assets\/photos\/(?:medium|large|thumbs)\//, request => request.fulfill({ status: 404, body: 'Missing photo' }));
    await brokenImage.goto(base + '/pages/gallery/', { waitUntil: 'networkidle' });
    await brokenImage.waitForSelector('.photo-card--broken');
    assert(await brokenImage.locator('.photo-card--broken .photo-image').first().getAttribute('alt'));
    await brokenImage.close();
    const failedAudio = await browser.newPage();
    await failedAudio.route('**/assets/utilities/fourier-decompose/**', request => request.fulfill({ status: 503, body: 'Unavailable' }));
    await failedAudio.goto(`${base}/pages/utilities/#audio-fourier`, { waitUntil: 'networkidle' });
    await failedAudio.click('#audioFourierGenerateBtn');
    await failedAudio.waitForSelector('#audioFourierApp[data-audio-state="error"]');
    assert(await failedAudio.locator('#audioFourierProgressText').isVisible());
    await failedAudio.unroute('**/assets/utilities/fourier-decompose/**');
    await failedAudio.click('#audioFourierGenerateBtn');
    await failedAudio.waitForSelector('#audioFourierPlayBtn:enabled', { timeout: 60000 });
    await failedAudio.close();
    const failedCpu = await browser.newPage();
    await failedCpu.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true }));
    await failedCpu.route('**/stressTest.worker-*.js', request => request.fulfill({ status: 404, body: 'Removed worker' }));
    await failedCpu.goto(`${base}/pages/utilities/#stress-test`, { waitUntil: 'networkidle' });
    await failedCpu.click('[data-stress-mode-option="cpu"]');
    await failedCpu.click('#stressStartBtn');
    await failedCpu.waitForSelector('#utilityLoadRecovery');
    await failedCpu.unroute('**/stressTest.worker-*.js');
    await failedCpu.getByRole('button', { name: 'Reload tools' }).click();
    await failedCpu.waitForSelector('#stressStartBtn:enabled');
    await failedCpu.click('[data-stress-mode-option="cpu"]');
    await failedCpu.click('#stressStartBtn');
    await failedCpu.waitForFunction(() => Number(document.getElementById('stressTestApp').dataset.stressLatestPrime) > 1);
    await failedCpu.click('#stressStopBtn');
    await failedCpu.close();
    results.push({ missingManifest: 'visible error', missingPhoto: 'labeled broken card', unavailableAudio: 'error and successful retry' });

    for (const dpr of [1, 2, 3]) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: dpr });
      const p = await ctx.newPage();
      await p.goto(`${base}/pages/utilities/#audio-fourier`, { waitUntil: 'networkidle' });
      const hiddenSize = await p.locator('#audioFourierSpectrumCanvas').evaluate(canvas => [canvas.width, canvas.height]);
      for (let i = 0; i < 8; i++) {
        await p.setViewportSize({ width: 1050 + i * 20, height: 650 + i * 10 });
        await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      }
      await p.click('.nav-back-btn');
      await p.click('[data-utility="audio-fourier"]');
      const current = await p.locator('#audioFourierSpectrumCanvas').evaluate(canvas => [canvas.width, canvas.height]);
      assert.deepEqual(current, hiddenSize, `DPR ${dpr}: hidden support canvas grew`);
      const wave = await p.locator('#audioFourierWaveCanvas').evaluate(canvas => ({ width: canvas.width, height: canvas.height, rect: canvas.getBoundingClientRect().toJSON() }));
      assert(wave.width <= 8192 && wave.width * wave.height <= 4000000);
      assert(wave.width > 0 && wave.rect.width > 0);
      await p.screenshot({ path: path.join(output, `${name}-audio-dpr${dpr}.png`) });
      await ctx.close();
    }
    // Exercise the first migration using the actual reviewed beta HTML and
    // entry bundle, retained verbatim as non-deployed test fixtures.
    const fixtureRoot = path.resolve(__dirname, '../utilities-src/tests/fixtures');
    for (const cachedEntry of [false, true]) {
      const legacy = await browser.newContext();
      const p = await legacy.newPage();
      const oldHtml = fs.readFileSync(path.join(fixtureRoot, 'pre-hash-utilities.html.txt'), 'utf8');
      await p.route('**/pages/utilities/', route => route.fulfill({ contentType: 'text/html', body: oldHtml }));
      if (cachedEntry) {
        const oldEntry = fs.readFileSync(path.join(fixtureRoot, 'pre-hash-utilities-app.js.txt'), 'utf8');
        await p.route('**/utilities-app.js?*', route => route.fulfill({ contentType: 'text/javascript', body: oldEntry }));
      }
      await p.goto(base + '/pages/utilities/', { waitUntil: 'networkidle' });
      if (cachedEntry) await p.click('[data-utility="audio-fourier"]');
      await p.waitForSelector('#utilityLoadRecovery');
      await p.unrouteAll({ behavior: 'wait' });
      await p.getByRole('button', { name: 'Reload tools' }).click();
      await p.waitForLoadState('networkidle');
      assert.equal(await p.locator('#utilityLoadRecovery').count(), 0);
      if (!cachedEntry) await p.click('[data-utility="audio-fourier"]');
      await p.waitForFunction(() => ['webgl', 'canvas2d'].includes(document.getElementById('audioFourierApp').dataset.audioWaveRenderer));
      assert(await p.locator('#audioFourierGenerateBtn').isEnabled());
      await legacy.close();
    }
    results.push({ preHashHtmlMigration: 'pass', preHashCachedEntryMigration: 'pass' });

    // A returning visitor reuses exact cached immutable URLs. A stale lazy URL
    // deleted by deployment must produce a visible, explicit recovery action.
    const cache = new Map();
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.route('**/pages/utilities/assets/**', async route => {
      const url = route.request().url();
      if (cache.has(url)) return route.fulfill(cache.get(url));
      const response = await route.fetch();
      const saved = { status: response.status(), headers: response.headers(), body: await response.body() };
      cache.set(url, saved); await route.fulfill(saved);
    });
    await p.goto(`${base}/pages/utilities/#audio-fourier`, { waitUntil: 'networkidle' });
    await p.reload({ waitUntil: 'networkidle' });
    assert.equal(await p.locator('#audioFourierGenerateBtn').isEnabled(), true);
    assert([...cache.keys()].some(url => /audioFourierController-[\w-]+\.js/.test(url)));
    assert([...cache.keys()].some(url => /utilities-app-[\w-]+\.js/.test(url)));
    await ctx.close();
    const stale = await browser.newPage();
    await stale.goto(`${base}/pages/utilities/`, { waitUntil: 'networkidle' });
    await stale.route('**/audioFourierController-*.js', route => route.fulfill({ status: 404, body: 'Old release chunk removed' }));
    await stale.click('[data-utility="audio-fourier"]');
    await stale.waitForSelector('#utilityLoadRecovery');
    assert(await stale.getByRole('button', { name: 'Reload tools' }).isVisible());
    await stale.unroute('**/audioFourierController-*.js');
    await stale.getByRole('button', { name: 'Reload tools' }).click();
    await stale.waitForSelector('#audioFourierGenerateBtn:enabled');
    assert.equal(await stale.locator('#utilityLoadRecovery').count(), 0);
    await stale.close();
    results.push({ cachedReturn: 'pass', missingLazyChunkRecovery: 'pass', dpr: [1, 2, 3] });
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, `${name}-artifact.json`), JSON.stringify(results, null, 2) + '\n');
  }
  console.log(`${name}: packaged route graph, utilities, canvas lifecycle, cached return and lazy recovery passed`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
