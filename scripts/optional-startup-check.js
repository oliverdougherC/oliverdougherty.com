#!/usr/bin/env node
// Packaged-browser regression: optional classic scripts may never finish, but
// page navigation and the utility controller must still become usable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const PAGES = {
  home: '/index.html',
  resume: '/pages/resume/index.html',
  gallery: '/pages/gallery/index.html',
  utilities: '/pages/utilities/index.html'
};
const MOBILE_PAGES = {
  'mobile-home': '/mobile/',
  'mobile-resume': '/mobile/resume/',
  'mobile-gallery': '/mobile/gallery/'
};

async function stalledScriptProxy(upstreamUrl, script, phase) {
  let intercepted = 0;
  const openResponses = new Set();
  const upstream = new URL(upstreamUrl);
  assert(upstream.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)
    && !upstream.username && !upstream.password && upstream.pathname === '/' && !upstream.search && !upstream.hash,
  'Optional startup proxy requires a local HTTP upstream origin');
  const upstreamHostname = upstream.hostname === '[::1]' ? '::1' : upstream.hostname;
  const server = http.createServer((request, response) => {
    const target = request.url;
    if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')
      || /[\\#\x00-\x20\x7f]/.test(target) || /%(?![0-9a-f]{2})/i.test(target)) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Invalid request target');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    if (target.split('?', 1)[0] === `/js/${script}`) {
      intercepted += 1;
      openResponses.add(response);
      response.on('close', () => openResponses.delete(response));
      if (phase === 'body') {
        response.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
        response.write('/* response body never finishes');
      }
      return;
    }
    const forwarded = http.request({
      protocol: upstream.protocol,
      hostname: upstreamHostname,
      port: upstream.port,
      path: target,
      method: request.method,
      headers: { host: upstream.host }
    }, result => {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    });
    forwarded.on('error', error => response.destroy(error));
    response.on('close', () => forwarded.destroy());
    forwarded.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get intercepted() { return intercepted; },
    release() {
      const source = fs.readFileSync(path.join(ROOT, 'dist', 'js', script), 'utf8');
      for (const response of openResponses) {
        if (phase === 'headers') response.writeHead(200, { 'Content-Type': 'text/javascript' });
        response.end(`${phase === 'body' ? '\n*/\n' : ''}${source}`);
      }
    },
    async close() {
      for (const response of openResponses) response.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function checkPage(browser, upstreamUrl, pageName, script, phase) {
  const proxy = await stalledScriptProxy(upstreamUrl, script, phase);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const label = `${pageName}: ${script} ${phase} stalled`;
  try {
    // A stalled deferred script prevents DOMContentLoaded in the broken build.
    await page.goto(`${proxy.url}${PAGES[pageName]}`, { waitUntil: 'commit', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.nav-inline-link--utilities')?.getBoundingClientRect().width > 0,
      null, { timeout: 5000 });
    if (pageName === 'utilities') {
      await page.locator('[data-utility="image-transform"]').click({ timeout: 5000 });
      await page.waitForFunction(() => {
        const stage = document.querySelector('[data-utility-id="image-transform"]');
        return stage && !stage.hidden && stage.dataset.utilityReady === 'ready'
          && !stage.querySelector('[data-utility-root]')?.hasAttribute('inert')
          && document.getElementById('transformGenerateBtn')?.disabled === false;
      }, null, { timeout: 5000 });
      assert.equal(await page.locator('#utilitiesUtilityView').isVisible(), true, `${label}: workspace hidden`);
      assert.equal(await page.locator('#utilityEntryError').isVisible(), false, `${label}: unexpected recovery`);
    } else if (pageName === 'gallery') {
      await page.waitForFunction(() => document.querySelector('#galleryArchiveGrid')?.children.length > 0,
        null, { timeout: 7000 });
      assert.equal(await page.locator('#galleryError').isVisible(), false, `${label}: gallery error`);
    } else if (pageName === 'resume') {
      assert.match(await page.locator('#typeTargetName1').textContent(), /Oliver/, label);
    } else {
      assert.equal(await page.locator('#home-intro-title').isVisible(), true, label);
    }
    assert(proxy.intercepted > 0, `${label}: script was not intercepted`);
    if (script === 'year.js') {
      await page.evaluate(() => {
        const marker = document.createElement('span');
        marker.dataset.currentYear = '';
        marker.textContent = '1900';
        document.body.append(marker);
      });
      proxy.release();
      await page.waitForFunction(() => document.querySelector('body > [data-current-year]')?.textContent === String(new Date().getFullYear()),
        null, { timeout: 5000 });
    }
    console.log(`PASS ${label}`);
  } catch (error) {
    const state = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      nav: document.querySelector('.nav-inline-link--utilities')?.outerHTML,
      body: document.body?.textContent?.slice(0, 160)
    })).catch(() => ({}));
    throw new Error(`${label}: ${error.message}; state=${JSON.stringify(state)}`, { cause: error });
  } finally {
    try {
      await context.close();
    } finally {
      await proxy.close();
    }
  }
}

async function checkMobileYear(browser, upstreamUrl, pageName, phase) {
  const proxy = await stalledScriptProxy(upstreamUrl, 'year.js', phase);
  const label = `${pageName}: year.js ${phase} stalled`;
  let context;
  let page;
  try {
    context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(() => {
      window.__startupDOMContentLoaded = false;
      document.addEventListener('DOMContentLoaded', () => { window.__startupDOMContentLoaded = true; }, { once: true });
    });
    page = await context.newPage();
    await page.goto(`${proxy.url}${MOBILE_PAGES[pageName]}`, { waitUntil: 'commit', timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.mobile-nav-link')?.getBoundingClientRect().width > 0,
      null, { timeout: 5000 });
    if (pageName === 'mobile-gallery') {
      await page.locator('#mobileGalleryGrid button.mobile-photo-button').first().waitFor({ timeout: 7000 });
      await page.locator('#mobileGalleryGrid button.mobile-photo-button').first().click();
      await page.locator('#mobileLightbox').waitFor({ state: 'visible', timeout: 5000 });
      assert.equal(await page.locator('#mobileGalleryError').isVisible(), false, `${label}: gallery error`);
      await page.locator('#mobileLightboxClose').click();
    } else if (pageName === 'mobile-home') {
      await page.locator('button[data-copy-email]').click({ timeout: 5000 });
      await page.waitForFunction(() => Boolean(document.querySelector('[data-copy-status]')?.textContent),
        null, { timeout: 5000 });
      assert.equal(await page.locator('#home-intro-title').isVisible(), true, label);
    } else {
      assert.match(await page.locator('main h1').textContent(), /Oliver Dougherty/, label);
      assert.equal(await page.locator('#resume-education-title').isVisible(), true, label);
      assert.equal(await page.locator('html').getAttribute('data-disable-color-mode'), '', `${label}: theme opt-out lost`);
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)',
        `${label}: résumé theme changed while year.js was stalled`);
      await page.locator('.osu-trigger').click({ timeout: 5000 });
      assert.equal(await page.locator('.osu-trigger').getAttribute('aria-pressed'), 'true',
        `${label}: main.js interaction did not initialize`);
    }
    assert(proxy.intercepted > 0, `${label}: script was not intercepted`);
    assert.equal(await page.evaluate(() => window.__startupDOMContentLoaded), true,
      `${label}: DOMContentLoaded waited for optional year.js`);
    await page.locator('[data-current-year]').evaluate(el => { el.textContent = '1900'; });
    proxy.release();
    await page.waitForFunction(() => document.querySelector('[data-current-year]')?.textContent === String(new Date().getFullYear()),
      null, { timeout: 5000 });
    if (pageName === 'mobile-resume') {
      assert.equal(await page.locator('html').getAttribute('data-color-mode'), null,
        `${label}: optional footer script overrode the résumé theme`);
      assert.equal(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)',
        `${label}: résumé theme changed after year.js released`);
    }
    console.log(`PASS ${label}`);
  } catch (error) {
    const state = page ? await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      domContentLoaded: window.__startupDOMContentLoaded,
      grid: document.querySelectorAll('#mobileGalleryGrid button.mobile-photo-button').length,
      copyStatus: document.querySelector('[data-copy-status]')?.textContent
    })).catch(() => ({})) : {};
    throw new Error(`${label}: ${error.message}; state=${JSON.stringify(state)}`, { cause: error });
  } finally {
    try {
      if (context) await context.close();
    } finally {
      await proxy.close();
    }
  }
}

async function checkEssentialRecovery(browser, upstreamUrl) {
  const proxy = await stalledScriptProxy(upstreamUrl, 'utilities-shell.js', 'body');
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { window.__OD_UTILITIES_INIT_TIMEOUT_MS = 250; });
  const page = await context.newPage();
  try {
    await page.goto(`${proxy.url}${PAGES.utilities}`, { waitUntil: 'commit', timeout: 10000 });
    await page.locator('#utilityEntryError').waitFor({ state: 'visible', timeout: 4000 });
    assert(proxy.intercepted > 0, 'Essential shell was not stalled');
    assert.equal(await page.locator('#utilityEntryError').getAttribute('role'), 'alert');
    assert.equal(await page.locator('#utilityEntryError button').isVisible(), true);
    assert.equal(await page.locator('.nav-inline-link--home').isVisible(), true);
    console.log('PASS utilities: stalled essential shell shows bounded accessible recovery');
  } finally {
    try {
      await context.close();
    } finally {
      await proxy.close();
    }
  }
}

async function checkMissingEssentialShell(browser, upstreamUrl) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.route('**/js/utilities-shell.js*', route => route.abort());
  const page = await context.newPage();
  try {
    await page.goto(`${upstreamUrl}${PAGES.utilities}`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.locator('#utilityEntryError').waitFor({ state: 'visible', timeout: 2000 });
    assert.equal(await page.locator('#utilityEntryError').getAttribute('role'), 'alert');
    console.log('PASS utilities: missing essential shell shows accessible recovery');
  } finally {
    await context.close();
  }
}

async function run() {
  const requestedUrl = process.env.BASE_URL || 'http://127.0.0.1:4173';
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: path.join(ROOT, 'dist'), skip: Boolean(process.env.BASE_URL) });
  const upstreamUrl = server?.url || requestedUrl;
  let browser;
  try {
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser ${process.env.BROWSER}`);
    browser = await browserType.launch({ headless: true, timeout: 15000 });
    for (const pageName of Object.keys(PAGES)) {
      if (process.env.STARTUP_PAGE && process.env.STARTUP_PAGE !== pageName) continue;
      for (const script of ['favicon-swap.js', 'year.js']) {
        for (const phase of ['headers', 'body']) {
          await checkPage(browser, upstreamUrl, pageName, script, phase);
        }
      }
    }
    for (const pageName of Object.keys(MOBILE_PAGES)) {
      if (process.env.STARTUP_PAGE && process.env.STARTUP_PAGE !== pageName) continue;
      for (const phase of ['headers', 'body']) {
        await checkMobileYear(browser, upstreamUrl, pageName, phase);
      }
    }
    if (!process.env.STARTUP_PAGE || process.env.STARTUP_PAGE === 'utilities') {
      await checkEssentialRecovery(browser, upstreamUrl);
      await checkMissingEssentialShell(browser, upstreamUrl);
    }
  } finally {
    if (browser) await browser.close();
    server?.kill();
  }
}

module.exports = { stalledScriptProxy };
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
