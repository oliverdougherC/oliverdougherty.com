#!/usr/bin/env node
'use strict';

// Network/lifecycle checks use the shipped app. The explicitly named UI fixture
// substitutes only Runtime, never production data or inference measurements.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');
const { chromium, firefox, webkit } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const APP = '#localAssistantApp';
const MODEL_REQUEST = /https:\/\/(?:huggingface\.co|[^/]*\.hf\.co)\/.*(?:\.gguf|xet-bridge)/i;
const CONTROLLER_REQUEST = /\/localAssistantController-[^/]+\.js(?:\?.*)?$/;
const OUTPUT = path.join(ROOT, 'output', 'local-assistant');
const element = (page, name) => page.locator(`${APP} [data-${name}]`);
const url = (baseUrl, hash = 'local-assistant') => `${baseUrl}/pages/utilities/index.html${hash ? `#${hash}` : ''}`;

async function phase(page, expected, timeout = 20000) {
  try {
    await page.waitForFunction(({ app, expected }) => document.querySelector(app)?.dataset.phase === expected,
      { app: APP, expected }, { timeout });
  } catch (error) {
    const actual = await page.evaluate(app => ({ phase: document.querySelector(app)?.getAttribute('data-phase') ?? 'missing', status: document.querySelector(`${app} [data-load-status]`)?.textContent ?? 'missing' }), APP);
    throw new Error(`Expected assistant phase ${expected}; got ${actual.phase}: ${actual.status} at ${page.url()}`, { cause: error });
  }
}
async function navigate(page, route) {
  await page.selectOption('#utilitySwitcher', route);
  await page.waitForURL(current => current.hash === `#${route}`);
  if (route === 'local-assistant') await page.locator(APP).waitFor({ state: 'visible' });
  else await page.locator(APP).waitFor({ state: 'hidden' });
}
async function createPage(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce', ...options });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.__assistantErrors = errors;
  await page.addInitScript(() => sessionStorage.setItem('od-page-animations-seen', JSON.stringify({ utilities: true })));
  return page;
}
function noErrors(page) { assert.deepEqual(page.__assistantErrors, [], 'No uncaught browser errors'); }

async function assertLazyAndUnsupported(browser, baseUrl) {
  const page = await createPage(browser);
  const heavy = [];
  page.on('request', request => {
    if (MODEL_REQUEST.test(request.url()) || /\/wllama[^/]*\.(?:wasm|js)/i.test(request.url())) heavy.push(request.url());
  });
  await page.route(MODEL_REQUEST, route => route.abort());
  await page.addInitScript(() => Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined }));
  try {
    await page.goto(url(baseUrl, ''), { waitUntil: 'networkidle' });
    assert.deepEqual(heavy, [], 'Utilities index must not fetch model weights/runtime');
    await page.goto(url(baseUrl, 'image-transform'), { waitUntil: 'networkidle' });
    assert.deepEqual(heavy, [], 'Another utility must not fetch model weights/runtime');
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'unsupported');
    assert.match(await element(page, 'load-status').innerText(), /WebGPU/i);
    assert.deepEqual(heavy, [], 'Unsupported WebGPU must fail before downloading weights');
    await page.screenshot({ path: path.join(OUTPUT, `unsupported-${browser.browserType().name()}.png`) });
    noErrors(page);
  } finally { await page.close(); }
}

async function assertDownloadFailure(browser, baseUrl) {
  const page = await createPage(browser);
  let requests = 0;
  // The adapter stub exists only to reach the *real* download failure path.
  // No model allocation or inference runs in this test.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: {
      requestAdapter: async () => ({ limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30 }, features: new Set() })
    } });
    if (!('Suspending' in WebAssembly)) Object.defineProperty(WebAssembly, 'Suspending', { value: function () {}, configurable: true });
  });
  await page.route(MODEL_REQUEST, route => { requests++; return route.fulfill({ status: 503, body: 'Deliberate test outage', headers: { 'access-control-allow-origin': '*' } }); });
  try {
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'error');
    assert.equal(requests, 1, 'Failed load fetches pinned model exactly once');
    assert.match(await element(page, 'load-status').innerText(), /503|download/i);
    await element(page, 'retry').click();
    await page.waitForFunction(() => document.querySelector('#localAssistantApp')?.dataset.phase === 'error');
    assert.equal(requests, 2, 'Retry must attempt the model download again');
    noErrors(page);
  } finally { await page.close(); }
}

// The fixture intentionally delivers callbacks after abort to check stale work.
// Layout observations below are explicitly synthetic test data, never GPU measurements.
const RUNTIME_FIXTURE = `
const fixture = globalThis.__localAssistantFixture = { loads: 0, disposals: 0, resets: 0, pending: [], generations: [] };
export function createAssistantRuntime() {
  return {
    load(signal, progress) {
      fixture.loads++;
      return new Promise(resolve => {
        const finish = () => resolve({ name: 'UI lifecycle fixture', context: 2048, layers: Array.from({length: 24}, (_, i) => (i + 1) % 4 ? 'deltanet' : 'attention'), backend: 'TEST FIXTURE — no inference' });
        fixture.pending.push({ finish, progress });
        signal.addEventListener('abort', () => { progress(999, 1000, 'STALE LOAD'); finish(); }, { once: true });
        progress(250, 1000, 'UI lifecycle fixture download');
        if (!globalThis.__holdAssistantLoad) finish();
      });
    },
    generate(messages, thinking, signal, update) {
      return new Promise((resolve, reject) => {
        fixture.generations.push({ update, finish: resolve, fail: reject });
        signal.addEventListener('abort', () => { update('STALE ANSWER', '', {}); resolve(); }, { once: true });
        update('Fixture response pending.', thinking ? 'Fixture reasoning.' : '', {});
      });
    },
    async reset() { fixture.resets++; },
    async dispose() { fixture.disposals++; }
  };
}`;
let fixtureBundle;
async function installUiFixture(page, hold = false) {
  if (!fixtureBundle) {
    const { build } = require('esbuild');
    const result = await build({
      entryPoints: [path.join(ROOT, 'utilities-src/src/localAssistantController.ts')],
      bundle: true, format: 'esm', target: 'es2022', write: false,
      plugins: [{ name: 'isolated-assistant-runtime-fixture', setup(builder) {
        builder.onLoad({ filter: /\/local-assistant\/runtime\.ts$/ }, () => ({ contents: RUNTIME_FIXTURE, loader: 'ts' }));
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' }));
      } }]
    });
    fixtureBundle = result.outputFiles[0].text;
  }
  await page.addInitScript(value => { globalThis.__holdAssistantLoad = value; }, hold);
  await page.route(CONTROLLER_REQUEST, route => route.fulfill({ contentType: 'text/javascript', body: fixtureBundle }));
  await page.route(MODEL_REQUEST, route => route.abort('blockedbyclient'));
}

async function assertFits(page, label) {
  const failures = await page.evaluate(app => {
    const root = document.querySelector(app);
    const failures = [];
    if (document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1) failures.push('document scrolls');
    for (const node of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || node.closest('[hidden]') || style.visibility === 'hidden' || style.clip !== 'auto' || style.clipPath === 'inset(50%)') continue;
      if (node.closest('[data-transcript]') && !node.hasAttribute('data-transcript')) continue;
      if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) failures.push(`${node.tagName}.${node.className}: outside viewport`);
      if (!node.hasAttribute('data-transcript') && ['auto', 'scroll'].includes(style.overflowY) && node.scrollHeight > node.clientHeight + 1) failures.push(`${node.tagName}.${node.className}: unintended vertical scroll`);
      if (['auto', 'scroll'].includes(style.overflowX) && node.scrollWidth > node.clientWidth + 1) failures.push(`${node.tagName}.${node.className}: unintended horizontal scroll`);
    }
    return failures;
  }, APP);
  assert.deepEqual(failures, [], label);
}

async function assertFixtureLifecycle(browser, baseUrl) {
  const page = await createPage(browser);
  await installUiFixture(page, true);
  try {
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'loading');
    assert.equal(await element(page, 'progress').evaluate(node => node.value / node.max), 0.25);
    await element(page, 'play').click();
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-canvas')), true);
    assert.equal(await element(page, 'canvas').evaluate(canvas => !canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))), true, 'Focused Snake consumes game key');
    await element(page, 'cancel').focus();
    assert.equal(await element(page, 'cancel').evaluate(button => !button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))), false, 'Snake does not capture keys outside canvas');
    await element(page, 'cancel').click();
    await phase(page, 'idle');
    assert.doesNotMatch(await element(page, 'load-status').innerText(), /STALE/);
    await element(page, 'retry').click();
    await phase(page, 'loading');
    await navigate(page, 'image-transform');
    await phase(page, 'idle');
    await page.goBack();
    await phase(page, 'loading');
    await page.goForward();
    await phase(page, 'idle');
    await navigate(page, 'local-assistant');
    await phase(page, 'loading');
    await page.evaluate(() => globalThis.__localAssistantFixture.pending.at(-1).finish());
    await phase(page, 'ready');
    assert.equal(await element(page, 'welcome').isVisible(), true, 'Ready model does not force user out of Snake');
    await element(page, 'enter').click();
    assert.equal(await element(page, 'input').evaluate(input => input === document.activeElement), true, 'Enter chat focuses composer');
    await element(page, 'input').fill('A keyboard-only message');
    await element(page, 'input').press('Shift+Enter');
    assert.equal(await element(page, 'input').inputValue(), 'A keyboard-only message\n');
    await element(page, 'input').press('Enter');
    await phase(page, 'generating');
    await element(page, 'stop').click();
    await phase(page, 'ready');
    assert.doesNotMatch(await element(page, 'transcript').innerText(), /STALE ANSWER/);
    await element(page, 'input').fill('Second turn');
    await element(page, 'send').click();
    await phase(page, 'generating');
    await navigate(page, 'image-transform');
    await phase(page, 'ready');
    await navigate(page, 'local-assistant');
    await phase(page, 'ready');
    assert.doesNotMatch(await element(page, 'transcript').innerText(), /STALE ANSWER/);
    await element(page, 'new').click();
    await page.waitForFunction(() => globalThis.__localAssistantFixture.resets === 1);
    assert.equal(await page.locator(`${APP} .la-message`).count(), 0, 'New chat clears transcript');
    assert.equal(await page.evaluate(() => globalThis.__localAssistantFixture.loads), 4, 'Ready reactivation reuses model; aborted loads restart');
    noErrors(page);
  } finally { await page.close(); }
}

async function assertFixtureViewports(browser, baseUrl) {
  const page = await createPage(browser);
  await installUiFixture(page);
  try {
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'ready');
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 600], [800, 600]]) {
      await page.setViewportSize({ width, height });
      // WebKit applies dynamic viewport units on the next rendering update.
      await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 2);
      await page.screenshot({ path: path.join(OUTPUT, `fixture-welcome-${browser.browserType().name()}-${width}x${height}.png`) });
      await assertFits(page, `Welcome ${width}x${height}`);
    }
    await element(page, 'enter').click();
    await element(page, 'input').fill('Render long Markdown and math fixture');
    await element(page, 'send').click();
    await phase(page, 'generating');
    await page.evaluate(() => {
      const generation = globalThis.__localAssistantFixture.generations.at(-1);
      generation.update('## Fixture answer\n\n**Bold** and $x^2$ with safe output.\n\n```js\nconst sample = "<script>alert(1)</script>";\n```\n\n' + 'Long transcript content. '.repeat(300), 'Fixture reasoning.', {
        promptTokens: Array.from({ length: 8 }, (_, id) => ({ id, piece: `input${id}` })),
        token: { id: 42, piece: 'fixture' }, generated: 1024, contextUsed: 65536, tokensPerSecond: 999.9, promptMs: 1234.5,
        candidates: [{ id: 42, piece: 'fixture', probability: 0.6 }, { id: 43, piece: 'layout', probability: 0.3 }, { id: 44, piece: 'test', probability: 0.1 }],
        layers: Array.from({ length: 24 }, (_, layer) => ({ layer, rms: 0.75 }))
      });
      generation.finish();
    });
    await phase(page, 'ready');
    await page.locator(`${APP} [data-tokens] button`).click();
    await page.locator(`${APP} [data-inspect-layer="23"]`).click();
    assert.equal(await page.locator(`${APP} [data-transcript] math`).count(), 1, 'Math renders');
    assert.equal(await page.locator(`${APP} [data-transcript] script`).count(), 0, 'Model source cannot create scripts');
    for (const [width, height] of [[1440, 900], [1280, 720], [1024, 600], [800, 600]]) {
      await page.setViewportSize({ width, height });
      // WebKit applies dynamic viewport units on the next rendering update.
      await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 2);
      await page.screenshot({ path: path.join(OUTPUT, `fixture-chat-${browser.browserType().name()}-${width}x${height}.png`) });
      await assertFits(page, `Chat ${width}x${height}`);
      assert.equal(await element(page, 'transcript').evaluate(node => node.scrollHeight > node.clientHeight), true, 'Long conversation scrolls inside transcript');
    }
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    const moving = await page.locator(APP).evaluate(root => root.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 1).length);
    assert.equal(moving, 0, 'Reduced motion leaves no running decorative animation');
    await element(page, 'transcript').evaluate(node => { node.scrollTop = 0; });
    await element(page, 'latest').waitFor({ state: 'visible' });
    await element(page, 'latest').click();
    await page.waitForFunction(() => { const node = document.querySelector('[data-transcript]'); return node.scrollHeight - node.scrollTop - node.clientHeight < 48; });
    await element(page, 'input').fill('Exercise visible error recovery');
    await element(page, 'send').click();
    await phase(page, 'generating');
    await page.evaluate(() => globalThis.__localAssistantFixture.generations.at(-1).fail(new Error('This is a deliberately long test error. Start a new chat or reload the model to continue.')));
    await phase(page, 'error');
    await page.waitForFunction(() => { const node = document.querySelector('[data-transcript]'); return node.scrollHeight - node.scrollTop - node.clientHeight < 48; });
    await element(page, 'transcript').evaluate(node => { node.scrollTop = 0; });
    await element(page, 'latest').waitFor({ state: 'visible' });
    assert.equal(await page.locator(APP).evaluate(root => {
      const transcript = root.querySelector('[data-transcript]').getBoundingClientRect();
      const latest = root.querySelector('[data-latest]').getBoundingClientRect();
      const error = root.querySelector('[data-chat-error]').getBoundingClientRect();
      return latest.bottom <= transcript.bottom && latest.bottom <= error.top;
    }), true, 'Latest stays inside the transcript and cannot cover error recovery');
    await assertFits(page, 'Error recovery 800x600');
    noErrors(page);
  } finally { await page.close(); }
}

// No Playwright routing in this probe: routing disables the HTTP cache and
// would make a false-positive no-store test. The cacheable control proves it.
async function runModelCacheCheck(browser) {
  const { build } = require('esbuild');
  const compiled = await build({ entryPoints: [path.join(ROOT, 'utilities-src/src/local-assistant/download.ts')], bundle: true, format: 'esm', target: 'es2022', write: false });
  const payload = Buffer.from([71, 71, 85, 70, 3, 0, 0, 0]);
  const requests = { model: 0, control: 0 };
  const server = http.createServer((request, response) => {
    if (request.url === '/download.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(compiled.outputFiles[0].text);
    } else if (request.url === '/model.gguf' || request.url === '/cacheable.gguf') {
      requests[request.url === '/model.gguf' ? 'model' : 'control']++;
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length, 'Cache-Control': 'public, max-age=86400, immutable' });
      response.end(payload);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Production model transport cache probe</title>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // WebKit's private contexts disable the cache even for force-cache. A fresh
  // disposable persistent profile is required for a meaningful positive control.
  let persistent;
  let profile;
  let page;
  try {
    if (browser.browserType().name() === 'webkit') {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-cache-webkit-'));
      persistent = await browser.browserType().launchPersistentContext(profile, { headless: true, timeout: 30000 });
    }
    page = await createPage(persistent ? { newPage: () => persistent.newPage() } : browser);
  } catch (error) {
    await persistent?.close();
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
    server.closeAllConnections(); server.close();
    throw error;
  }
  const snapshot = () => page.evaluate(async () => {
    const read = async fn => { try { return { available: true, value: await fn() }; } catch (error) { return { available: false, error: error.name }; } };
    return {
      local: await read(() => Object.keys(localStorage).sort()), session: await read(() => Object.keys(sessionStorage).sort()),
      caches: await read(() => caches.keys()),
      databases: await read(async () => (await indexedDB.databases()).map(db => db.name).sort()),
      files: await read(async () => { const files = []; for await (const name of (await navigator.storage.getDirectory()).keys()) files.push(name); return files.sort(); })
    };
  });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const before = await snapshot();
    const unavailable = Object.entries(before).filter(([, value]) => !value.available).map(([key, value]) => `${key}: ${value.error}`);
    if (unavailable.length) console.log(`Local Assistant storage inspection unavailable (${browser.browserType().name()}): ${unavailable.join(', ')}`);
    await page.evaluate(async () => {
      await (await fetch('/cacheable.gguf', { cache: 'force-cache' })).arrayBuffer();
      await (await fetch('/cacheable.gguf', { cache: 'force-cache' })).arrayBuffer();
    });
    assert.equal(requests.control, 1, 'Positive control: browser really reuses HTTP cache in this probe');
    const download = () => page.evaluate(async () => {
      const { downloadModel } = await import('/download.js');
      const blob = await downloadModel('/model.gguf', 8, new AbortController().signal, () => {});
      return [...new Uint8Array(await blob.arrayBuffer())];
    });
    assert.deepEqual(await download(), [...payload]);
    assert.deepEqual(await download(), [...payload]);
    assert.equal(requests.model, 2, 'Production no-store model transport reaches server on both calls');
    await page.reload();
    await download();
    assert.equal(requests.model, 3, 'Production model transport fetches again after navigation');
    assert.deepEqual(await snapshot(), before, 'Model transport adds no local/session storage, Cache API, IndexedDB, or OPFS artifacts');
    noErrors(page);
    console.log(`Local Assistant: no-store network/cache probe passed (${browser.browserType().name()}, 8-byte transport fixture; no inference).`);
  } finally {
    await page.close(); await persistent?.close();
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
    server.closeAllConnections(); server.close();
  }
}

async function runLocalAssistantChecks(browser, baseUrl) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  await runModelCacheCheck(browser);
  await assertLazyAndUnsupported(browser, baseUrl);
  console.log('Local Assistant: lazy loading and unsupported-browser checks passed.');
  await assertDownloadFailure(browser, baseUrl);
  console.log('Local Assistant: production download failure/retry passed.');
  await assertFixtureLifecycle(browser, baseUrl);
  console.log('Local Assistant: isolated fixture lifecycle checks passed.');
  await assertFixtureViewports(browser, baseUrl);
  console.log(`Local Assistant browser checks passed (${browser.browserType().name()}); lifecycle/layout fixture is not inference evidence.`);
}

async function serveModelFixture(file) {
  const info = fs.statSync(file);
  assert.equal(info.size, 1280835840, 'Fixture must be the pinned Qwen3.5-2B Q4_K_M file');
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  assert.equal(hash.digest('hex'), 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223', 'Fixture SHA-256 matches pinned model');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    const stream = fs.createReadStream(file);
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/model.gguf`, close() { server.closeAllConnections(); server.close(); } };
}

async function runRealModelCheck(browser, baseUrl) {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const file = process.env.LOCAL_ASSISTANT_MODEL;
  const fixture = file ? await serveModelFixture(path.resolve(file)) : null;
  const runName = fixture ? 'real-fixture' : 'real-cold';
  const page = await createPage(browser, { viewport: { width: 1440, height: 900 } });
  const timeout = Number(process.env.LOCAL_ASSISTANT_REAL_TIMEOUT_MS || 900000);
  await page.addInitScript(() => {
    const metrics = globalThis.__assistantLoadMetrics = { changes: [], loadingStarted: null, readyAt: null, maxFrameGapMs: 0, frameSamples: 0 };
    let previousFrame = performance.now();
    let lastState = '';
    let loading = false;
    const frame = now => {
      if (loading) { metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs, now - previousFrame); metrics.frameSamples++; }
      previousFrame = now;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    new MutationObserver(() => {
      const app = document.querySelector('#localAssistantApp');
      if (!app) return;
      const phase = app.dataset.phase;
      const progress = app.querySelector('[data-progress]');
      const loaded = progress?.hasAttribute('value') ? Number(progress.getAttribute('value')) : null;
      const total = progress?.hasAttribute('max') ? Number(progress.getAttribute('max')) : null;
      const status = app.querySelector('[data-load-status]')?.textContent || '';
      const state = JSON.stringify({ phase, loaded, total, status });
      if (state === lastState) return;
      lastState = state;
      const at = performance.now();
      if (phase === 'loading' && metrics.loadingStarted === null) metrics.loadingStarted = at;
      // Include a main-thread stall that ends just before the ready mutation.
      if (loading) metrics.maxFrameGapMs = Math.max(metrics.maxFrameGapMs, at - previousFrame);
      if (phase === 'ready' && metrics.readyAt === null) metrics.readyAt = at;
      loading = phase === 'loading';
      metrics.changes.push({ at, phase, loaded, total, status });
    }).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  });
  const loadStarted = Date.now();
  try {
    if (fixture) await page.route(MODEL_REQUEST, route => route.fulfill({ status: 307, headers: { location: fixture.url, 'access-control-allow-origin': '*' }, body: '' }));
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await page.locator(APP).waitFor({ state: 'visible' });
    await element(page, 'play').click();
    await page.screenshot({ path: path.join(OUTPUT, `${runName}-loading-snake.png`) });
    await page.waitForFunction(() => ['ready', 'error', 'unsupported'].includes(document.querySelector('#localAssistantApp')?.dataset.phase), null, { timeout });
    assert.equal(await page.locator(APP).getAttribute('data-phase'), 'ready', await element(page, 'load-status').innerText());
    const loadWallMs = Date.now() - loadStarted;
    const loadMetrics = await page.evaluate(() => globalThis.__assistantLoadMetrics);
    const progress = loadMetrics.changes.filter(change => change.loaded !== null);
    const monotonic = progress.every((change, index) => index === 0 || change.loaded >= progress[index - 1].loaded);
    assert(monotonic, 'Real model byte progress is monotonic');
    assert.equal(progress.at(-1)?.loaded, 1280835840, 'Progress reaches the exact pinned model byte count');
    assert.equal(await element(page, 'welcome').isVisible(), true, 'Model readiness keeps the Snake welcome screen');
    assert.equal(await element(page, 'snake').evaluate(node => node.classList.contains('is-playing')), true, 'Snake remains selected after model load');
    await page.screenshot({ path: path.join(OUTPUT, `${runName}-ready-snake.png`) });
    await element(page, 'enter').click();
    await element(page, 'thinking').uncheck();
    await element(page, 'input').fill('In one short sentence, explain why the sky looks blue.');
    const started = Date.now();
    await element(page, 'send').click();
    await phase(page, 'generating');
    await page.waitForFunction(() => ['ready', 'error', 'unsupported'].includes(document.querySelector('#localAssistantApp')?.dataset.phase), null, { timeout });
    assert.equal(await page.locator(APP).getAttribute('data-phase'), 'ready', await element(page, 'load-status').innerText());
    const answer = await page.locator(`${APP} .la-message--assistant .la-message-body`).last().innerText();
    assert(answer.trim().length > 10 && !answer.includes('No response generated'), 'Actual runtime generates an answer');
    const report = { mode: 'real-runtime', modelFixture: Boolean(fixture), browser: browser.browserType().name(), loadWallMs,
      progressMonotonic: monotonic, finalBytes: progress.at(-1)?.loaded, loadMetrics, answer, generationWallMs: Date.now() - started,
      observatory: await page.locator(`${APP} .la-observatory`).innerText() };
    fs.writeFileSync(path.join(OUTPUT, `${runName}.json`), `${JSON.stringify(report, null, 2)}\n`);
    await page.screenshot({ path: path.join(OUTPUT, `${runName}-response.png`) });
    noErrors(page);
    console.log(`Real Local Assistant generation passed; measurements in output/local-assistant/${runName}.json`);
  } finally { await page.close(); fixture?.close(); }
}

async function main() {
  const requestedUrl = process.env.UTILITIES_CHECK_URL || 'http://127.0.0.1:4191';
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.UTILITIES_CHECK_URL) });
  const baseUrl = server?.url || requestedUrl;
  const browserName = process.env.UTILITIES_BROWSER || 'chromium';
  const browserType = { chromium, firefox, webkit }[browserName];
  assert(browserType, `Unknown browser: ${browserName}`);
  let browser;
  try {
    await waitForServer(url(baseUrl, ''));
    browser = await browserType.launch({ timeout: 30000, headless: process.env.LOCAL_ASSISTANT_HEADED !== '1', ...(process.env.LOCAL_ASSISTANT_CHANNEL ? { channel: process.env.LOCAL_ASSISTANT_CHANNEL } : {}),
      ...(browserName === 'chromium' && process.argv.includes('--real') ? { args: ['--enable-unsafe-webgpu'] } : {}) });
    if (process.argv.includes('--cache-only')) await runModelCacheCheck(browser);
    else if (process.argv.includes('--transport')) {
      fs.mkdirSync(OUTPUT, { recursive: true });
      await runModelCacheCheck(browser);
      await assertLazyAndUnsupported(browser, baseUrl);
      await assertDownloadFailure(browser, baseUrl);
      console.log(`Local Assistant production transport/unsupported checks passed (${browserName}).`);
    } else if (process.argv.includes('--real')) await runRealModelCheck(browser, baseUrl);
    else if (process.argv.includes('--ui-fixture')) {
      fs.mkdirSync(OUTPUT, { recursive: true });
      await assertFixtureLifecycle(browser, baseUrl);
      await assertFixtureViewports(browser, baseUrl);
      console.log('Local Assistant UI fixture checks passed (no inference).');
    } else await runLocalAssistantChecks(browser, baseUrl);
  } finally { await browser?.close(); server?.kill(); }
}
module.exports = { runLocalAssistantChecks, runRealModelCheck, runModelCacheCheck };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
