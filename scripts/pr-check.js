#!/usr/bin/env node
// Fast Chromium coverage of the packaged candidate. Deep workloads and the
// cross-browser matrix belong to release:check, not this pull-request gate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { markAnimationsSeen, startLocalStaticServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUTPUT = path.join(ROOT, 'output/pr');
const TIMEOUT = 10000;

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const started = Date.now();
  const report = { status: 'fail', browser: 'chromium', results: [], errors: [] };
  const contexts = [];
  let browser;
  let server;
  let activePage;
  let watchdog;
  let timedOut = false;

  async function step(name, check) {
    const start = Date.now();
    const result = { name, status: 'fail' };
    report.results.push(result);
    try {
      await check();
      assert.deepEqual(report.errors, [], 'Unexpected packaged-site browser errors');
      result.status = 'pass';
    } catch (error) {
      result.error = error.stack || String(error);
      throw error;
    } finally {
      result.seconds = (Date.now() - start) / 1000;
      console.log(`${result.status.toUpperCase()}: ${name} (${result.seconds.toFixed(2)}s)`);
    }
  }

  async function createPage(name, options) {
    const context = await browser.newContext({ ...options, reducedMotion: 'reduce' });
    contexts.push({ name, context });
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    await markAnimationsSeen(context);
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push({ context: name, type: 'pageerror', message: error.message }));
    page.on('console', message => {
      if (message.type() === 'error') report.errors.push({ context: name, type: 'console', message: message.text() });
    });
    page.on('response', response => {
      if (response.status() >= 400) report.errors.push({ context: name, type: 'response', status: response.status(), url: response.url() });
    });
    page.on('requestfailed', request => {
      const failure = request.failure()?.errorText || 'Unknown request failure';
      // Navigating away legitimately aborts gallery prefetches and lazy images.
      if (!failure.includes('ERR_ABORTED')) report.errors.push({ context: name, type: 'requestfailed', message: failure, url: request.url() });
    });
    return page;
  }

  async function route(page, pathname, title) {
    activePage = page;
    const response = await page.goto(server.url + pathname, { waitUntil: 'load' });
    assert.equal(response.status(), 200, `${pathname}: route must load successfully`);
    assert.equal(await page.title(), title, `${pathname}: wrong title`);
    assert.equal(await page.locator('main').count(), 1, `${pathname}: expected one main landmark`);
    await page.locator('main').waitFor({ state: 'visible' });
  }

  async function navigateToResume(page, selector, pathname) {
    await page.locator(selector).filter({ hasText: 'Résumé' }).click();
    await page.waitForURL(url => url.pathname === pathname || url.pathname === `${pathname}index.html`, { waitUntil: 'load' });
    assert.equal(await page.title(), 'Resume');
    assert.equal((await page.locator(`${selector}[aria-current="page"]`).textContent()).trim().toLowerCase(), 'résumé');
    await page.locator('main').waitFor({ state: 'visible' });
  }

  try {
    await step('packaged artifact identity and isolation', async () => {
      assert(!process.env.STATIC_ROOT || path.resolve(process.env.STATIC_ROOT) === DIST, 'PR checks must serve this checkout\'s dist');
      report.artifact = JSON.parse(fs.readFileSync(path.join(DIST, 'release-artifact.json'), 'utf8'));
      assert.equal(report.artifact.kind, 'oliverdougherty-deploy');
      assert.equal(report.artifact.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(), 'Deploy artifact belongs to a different candidate; rebuild dist');
      server = await startLocalStaticServer({ url: 'http://127.0.0.1:0', cwd: DIST });
      const markerResponse = await fetch(`${server.url}/release-artifact.json`, { signal: AbortSignal.timeout(TIMEOUT) });
      assert.equal(markerResponse.status, 200);
      assert.deepEqual(await markerResponse.json(), report.artifact, 'Server must serve the tested dist artifact');
      for (const excluded of ['/package.json', '/assets/art/nighthawks-binary.txt']) {
        const response = await fetch(server.url + excluded, { signal: AbortSignal.timeout(TIMEOUT) });
        assert.equal(response.status, 404, `${excluded}: source/authoring files must not be deployed`);
        await response.arrayBuffer();
      }
    });
    browser = await require('playwright').chromium.launch({ headless: true, timeout: TIMEOUT });
    report.browserVersion = browser.version();
    // Normal runs target seconds; a stalled browser may not turn this into a
    // release-sized job. Individual assertions fail sooner with useful evidence.
    watchdog = setTimeout(() => {
      timedOut = true;
      browser.close().catch(() => {});
      server.kill();
    }, 60000);
    const desktop = await createPage('desktop', { viewport: { width: 1440, height: 900 } });
    await step('desktop Home', () => route(desktop, '/', 'Home'));
    await step('desktop navigation to Résumé', () => navigateToResume(desktop, '.nav-inline-link', '/pages/resume/'));
    await step('desktop Gallery image', async () => {
      await route(desktop, '/pages/gallery/', 'Gallery');
      await desktop.waitForFunction(() => {
        const image = document.getElementById('galleryHeroImage');
        return image?.complete && image.naturalWidth > 0;
      });
    });
    await step('Utilities index', () => route(desktop, '/pages/utilities/', 'Utilities'));
    for (const [utility, button] of [['image-transform', 'transformGenerateBtn'], ['audio-fourier', 'audioFourierGenerateBtn'], ['stress-test', 'stressStartBtn']]) {
      await step(`${utility} lazy initialization`, async () => {
        await desktop.locator(`.utilities-buttons [data-utility="${utility}"]`).click();
        await desktop.waitForFunction(id => {
          const stage = document.querySelector(`[data-utility-id="${id}"]`);
          const root = stage?.querySelector('[data-utility-root]');
          return document.documentElement.dataset.activeUtility === id
            && stage?.dataset.utilityReady === 'ready'
            && root?.dataset.controllerReady === 'true' && !root.inert;
        }, utility);
        await desktop.locator(`#${button}:enabled`).waitFor({ state: 'visible' });
        // Entering a tool must not start its expensive work automatically.
        if (utility === 'image-transform') assert.notEqual(await desktop.locator('#utilitiesApp').getAttribute('data-transform-has-result'), 'true');
        if (utility === 'audio-fourier') assert.equal(await desktop.locator('#audioFourierApp').getAttribute('data-audio-state'), 'idle');
        if (utility === 'stress-test') assert.equal(await desktop.locator('#stressTestApp').getAttribute('data-stress-state'), 'idle');
        await desktop.locator('.nav-back-btn').click();
        await desktop.locator('.utilities-buttons').waitFor({ state: 'visible' });
      });
    }
    const mobile = await createPage('mobile', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await step('mobile Home', () => route(mobile, '/mobile/', 'Home'));
    await step('mobile navigation to Résumé', () => navigateToResume(mobile, '.mobile-nav-link', '/mobile/resume/'));
    await step('mobile Gallery image', async () => {
      await route(mobile, '/mobile/gallery/', 'Gallery');
      await mobile.waitForFunction(() => [...document.querySelectorAll('#mobileGalleryGrid img')].some(image => image.complete && image.naturalWidth > 0));
    });
    assert.deepEqual(report.errors, [], 'Unexpected packaged-site browser errors');
    report.status = 'pass';
  } catch (error) {
    report.error = error.stack || String(error);
    if (activePage && !activePage.isClosed()) {
      report.failureUrl = activePage.url();
      await activePage.screenshot({ path: path.join(OUTPUT, 'failure.png'), timeout: 3000 }).catch(() => {});
    }
    throw error;
  } finally {
    clearTimeout(watchdog);
    report.timedOut = timedOut;
    if (timedOut) report.status = 'fail';
    for (const { name, context } of contexts) {
      await context.tracing.stop(report.status === 'fail' ? { path: path.join(OUTPUT, `${name}-trace.zip`) } : {}).catch(() => {});
    }
    try {
      await browser?.close();
    } catch (error) {
      report.status = 'fail';
      report.cleanupError = error.stack || String(error);
      throw error;
    } finally {
      server?.kill();
      report.seconds = (Date.now() - started) / 1000;
      fs.writeFileSync(path.join(OUTPUT, 'results.json'), JSON.stringify(report, null, 2) + '\n');
      if (process.env.GITHUB_STEP_SUMMARY) {
        const lines = ['### Packaged-site smoke', '',
          `**${report.status}** in ${report.seconds.toFixed(1)}s (Chromium; no long-running workloads).`, '',
          '| Check | Result | Seconds |', '| --- | --- | ---: |',
          ...report.results.map(result => `| ${result.name} | ${result.status} | ${result.seconds.toFixed(2)} |`)];
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
      }
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
