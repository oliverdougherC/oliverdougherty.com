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
const fixture = globalThis.__localAssistantFixture = { loads: 0, disposals: 0, resets: 0, pending: [], generations: [], slowCalls: [] };
export function createAssistantRuntime() {
  let slow = false;
  return {
    setSlowMode(value) { slow = value; fixture.slowCalls.push(value); },
    load(signal, progress) {
      fixture.loads++;
      return new Promise(resolve => {
        const finish = () => resolve({ name: 'UI lifecycle fixture', context: 65536, layers: Array.from({length: 24}, (_, i) => (i + 1) % 4 ? 'deltanet' : 'attention'), backend: 'TEST FIXTURE — no inference' });
        fixture.pending.push({ finish, progress });
        signal.addEventListener('abort', () => { progress(999, 1000, 'STALE LOAD'); finish(); }, { once: true });
        progress(250, 1000, 'UI lifecycle fixture download');
        if (!globalThis.__holdAssistantLoad) finish();
      });
    },
    generate(messages, thinking, signal, update) {
      return new Promise((resolve, reject) => {
        let content = '', reasoning = '';
        const emit = (answer, thoughts, observation) => { content = answer; reasoning = thoughts; update(answer, thoughts, observation); };
        fixture.generations.push({ update: emit, finish: resolve, fail: reject, thinking, slow,
          messages: messages.map(message => ({ ...message })),
          finishLength() {
            // Normalized adapter boundary: a streamed length finish preserves
            // accumulated output, then rejects with the actionable context error.
            emit(content, reasoning, { finishReason: 'length' });
            reject(new Error('The context is full. Start a new chat to continue.'));
          }
        });
        signal.addEventListener('abort', () => { update('STALE ANSWER', '', {}); resolve(); }, { once: true });
        emit('', thinking ? 'Fixture reasoning.' : '', { stage: 'prefill', promptProcessed: 0, promptTotal: 1024 });
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
      const panel = node.closest('[data-attention-panel], [data-delta-panel], [data-next-panel]');
      if (panel && panel !== node) {
        const bounds = panel.getBoundingClientRect();
        if (rect.left < bounds.left - 2 || rect.right > bounds.right + 2 || rect.top < bounds.top - 2 || rect.bottom > bounds.bottom + 2) failures.push(`${node.tagName}.${node.className}: clipped by observatory panel`);
      }
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
    assert.equal(await page.locator('#utilityTitle').innerText(), 'LLM Rumen Cannula');
    assert.equal(await element(page, 'progress').evaluate(node => node.value / node.max), 0.25);
    await element(page, 'play').click();
    assert.equal(await element(page, 'welcome').evaluate(node => node.classList.contains('is-playing')), true, 'Play expands the welcome into game mode');
    const keyConsumed = (locator, key) => locator.evaluate((node, value) => !node.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })), key);
    assert.equal(await keyConsumed(element(page, 'cancel'), 'ArrowUp'), true, 'Active Snake handles movement without requiring canvas focus');
    assert.equal(await keyConsumed(element(page, 'cancel'), 'Tab'), false, 'Snake preserves Tab navigation');
    assert.equal(await keyConsumed(page.locator('#utilitySwitcher'), 'ArrowDown'), false, 'Snake preserves native selector keys');
    assert.equal(await keyConsumed(element(page, 'input'), 'ArrowLeft'), false, 'Snake preserves editable keys');
    await element(page, 'play').click();
    assert.match(await element(page, 'play').innerText(), /Resume/i);
    assert.equal(await keyConsumed(element(page, 'cancel'), 'ArrowUp'), false, 'Pausing Snake releases global movement keys');
    await element(page, 'play').click();
    assert.match(await element(page, 'play').innerText(), /Pause/i);
    assert.equal(await keyConsumed(element(page, 'cancel'), 'ArrowUp'), true, 'Resuming Snake restores global movement keys');
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
    if (!/Pause/i.test(await element(page, 'play').innerText())) await element(page, 'play').click();
    await element(page, 'enter').click();
    assert.equal(await keyConsumed(page.locator('#utilityTitle'), 'ArrowDown'), false, 'Entering chat releases Snake movement keys');
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

async function assertAutoEntersChat(browser, baseUrl) {
  const page = await createPage(browser);
  await installUiFixture(page, true);
  try {
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'loading');
    assert.equal(await element(page, 'enter').isVisible(), false, 'The Enter chat button stays hidden while downloading');
    await page.evaluate(() => globalThis.__localAssistantFixture.pending.at(-1).finish());
    await phase(page, 'ready');
    assert.equal(await element(page, 'welcome').isVisible(), false, 'Ready without an open Snake game leaves the welcome screen');
    assert.equal(await element(page, 'chat').isVisible(), true, 'Ready without an open Snake game shows the chat automatically');
    assert.equal(await element(page, 'enter').isVisible(), false, 'Ready without an open Snake game never shows the Enter chat button');
    assert.equal(await element(page, 'input').evaluate(input => input === document.activeElement), true, 'Automatic entry focuses the composer');
    await element(page, 'input').fill('A message without pressing Enter chat');
    await element(page, 'send').click();
    await phase(page, 'generating');
    await page.evaluate(() => globalThis.__localAssistantFixture.generations.at(-1).finish());
    await phase(page, 'ready');
    assert.equal(await element(page, 'chat').isVisible(), true, 'Chat remains entered after a completed turn');
    noErrors(page);
  } finally { await page.close(); }
}

async function assertContextExhaustionRecovery(browser, baseUrl) {
  const page = await createPage(browser);
  await installUiFixture(page);
  try {
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'ready');
    await element(page, 'thinking').check();
    await element(page, 'input').fill('Use the remaining context.');
    await element(page, 'send').click();
    await phase(page, 'generating');
    await page.evaluate(() => globalThis.__localAssistantFixture.generations.at(-1).update(
      'Partial answer before the context limit.', 'Reasoning retained before the context limit.',
      { stage: 'decode', token: { id: 42, piece: 'limit' }, generated: 1, contextUsed: 65536, pass: 2 }
    ));
    await page.waitForFunction(() => document.querySelector('.la-message--assistant .la-message-body')?.textContent === 'Partial answer before the context limit.');
    await page.evaluate(() => globalThis.__localAssistantFixture.generations.at(-1).finishLength());
    await phase(page, 'error');
    assert.equal((await page.locator(`${APP} .la-message--assistant .la-message-body`).textContent()).trim(), 'Partial answer before the context limit.', 'A streamed length finish preserves the partial answer');
    assert.equal((await page.locator(`${APP} .la-message--assistant .la-reasoning`).textContent()).trim(), 'Reasoning retained before the context limit.', 'A streamed length finish preserves partial reasoning');
    assert.match(await element(page, 'chat-error-text').innerText(), /context is full/i);
    assert.equal(await element(page, 'chat-retry').innerText(), 'New chat', 'Context exhaustion offers conversation reset instead of model reload');
    assert.equal(await element(page, 'send').isDisabled(), true, 'The full context cannot accept another prompt');
    await page.locator(`${APP} .la-message--assistant summary`).click();
    assert.equal(await page.locator(`${APP} .la-message--assistant .la-reasoning`).isVisible(), true, 'Preserved reasoning remains inspectable after context exhaustion');
    await assertFits(page, 'Context exhaustion 1280x720');
    await page.screenshot({ path: path.join(OUTPUT, `fixture-context-full-${browser.browserType().name()}.png`) });
    await element(page, 'chat-retry').click();
    await phase(page, 'ready');
    await page.waitForFunction(() => globalThis.__localAssistantFixture.resets === 1);
    assert.deepEqual(await page.evaluate(() => ({ loads: globalThis.__localAssistantFixture.loads, disposals: globalThis.__localAssistantFixture.disposals })), { loads: 1, disposals: 0 }, 'New chat resets the loaded runtime without downloading or disposing it');
    assert.equal(await page.locator(`${APP} .la-message`).count(), 0, 'Context recovery clears the exhausted conversation');
    assert.equal(await element(page, 'chat-error').isVisible(), false);
    assert.equal(await element(page, 'input').evaluate(node => node === document.activeElement), true, 'Recovery returns focus to the composer');
    await assertObservatoryCleared(page, 'Context recovery clears observations and the terminal finish reason');
    await element(page, 'input').fill('A fresh, short question.');
    await element(page, 'send').click();
    await phase(page, 'generating');
    assert.deepEqual(await page.evaluate(() => globalThis.__localAssistantFixture.generations.at(-1).messages), [{ role: 'user', content: 'A fresh, short question.' }], 'The next prompt starts without exhausted conversation history');
    await page.evaluate(() => {
      const turn = globalThis.__localAssistantFixture.generations.at(-1);
      turn.update('The fresh chat works.', '', { stage: 'decode', token: { id: 43, piece: 'works' }, generated: 1, contextUsed: 2, pass: 3 });
      turn.finish();
    });
    await phase(page, 'ready');
    assert.equal((await page.locator(`${APP} .la-message--assistant .la-message-body`).textContent()).trim(), 'The fresh chat works.');
    assert.equal(await element(page, 'chat-error').isVisible(), false, 'A successful new turn does not retain the old length error');
    await page.screenshot({ path: path.join(OUTPUT, `fixture-context-recovered-${browser.browserType().name()}.png`) });
    noErrors(page);
  } finally { await page.close(); }
}

async function assertSampledTailCandidate(browser, baseUrl) {
  const page = await createPage(browser);
  await installUiFixture(page);
  try {
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'ready');
    await element(page, 'thinking').uncheck();
    await element(page, 'input').fill('Exercise a sampled token outside the native top eight.');
    await element(page, 'send').click();
    await phase(page, 'generating');
    await page.evaluate(() => {
      const turn = globalThis.__localAssistantFixture.generations.at(-1);
      turn.update('', '', { stage: 'prefill', promptProcessed: 1, promptTotal: 1, promptTokens: [{ id: 1, piece: 'Prompt' }], contextUsed: 1, pass: 1 });
      // The normalized packet contains native top eight plus the actual rank-ten
      // sample. Rank nine and other tail entries are intentionally omitted.
      const top = [0.25, 0.18, 0.14, 0.1, 0.08, 0.06, 0.045, 0.035].map((probability, index) => ({ id: 100 + index, piece: `top${index + 1}`, probability }));
      const selected = { id: 110, piece: 'tail-sampled', probability: 0.02 };
      turn.update('The tail token was sampled.', '', {
        stage: 'decode', token: { id: selected.id, piece: selected.piece }, generated: 1, contextUsed: 2, pass: 2,
        candidates: [...top, selected],
        lens: [{ layer: 11, candidates: [{ ...selected, probability: 0.4 }, top[0], top[1]] }, { layer: 19, candidates: top.slice(0, 3) }]
      });
      turn.finish();
    });
    await phase(page, 'ready');
    for (const [width, height, budget] of [[800, 600, 3], [1920, 1080, 5], [3840, 2160, 8]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 2);
      await page.waitForFunction(expected => document.querySelector('[data-candidates]')?.dataset.candidateBudget === String(expected), budget);
      const candidateState = await page.locator(`${APP} [data-observatory-view]`).evaluate(host => ({
        rows: [...host.querySelectorAll('[data-candidate-id]')].map(row => ({ id: Number(row.dataset.candidateId), sampled: row.dataset.sampled === 'true', probability: row.lastElementChild.textContent, fill: row.style.getPropertyValue('--probability') })),
        final: [...host.querySelectorAll('[data-lens-layer="-1"]')].map(row => ({ id: Number(row.dataset.lensToken), rank: Number(row.dataset.rank) }))
      }));
      assert.deepEqual(candidateState.rows.map(row => row.id), [...Array.from({ length: budget - 1 }, (_, index) => 100 + index), 110], `The ${budget}-row view retains the highest candidates plus the actual sample`);
      assert.deepEqual(candidateState.rows.filter(row => row.sampled), [{ id: 110, sampled: true, probability: '2%', fill: '2%' }], 'The tail sample is highlighted exactly once with its original, unrenormalized probability');
      assert.equal(candidateState.rows[0].probability, '25%', 'Leading candidate probability also remains unchanged');
      assert(candidateState.final.length >= 2 && candidateState.final.length <= 3);
      assert.deepEqual(candidateState.final, Array.from({ length: candidateState.final.length }, (_, index) => ({ id: 100 + index, rank: index + 1 })), 'The sampled tail token is not promoted into the Final top-three ranks');
      await assertFits(page, `Tail sampled candidate ${width}x${height}`);
      await page.screenshot({ path: path.join(OUTPUT, `fixture-tail-sample-${browser.browserType().name()}-${width}x${height}.png`) });
    }
    noErrors(page);
  } finally { await page.close(); }
}

async function assertObservatorySnapshot(page, index, layer = 0) {
  const step = index + 2;
  await page.waitForFunction(value => document.querySelector('[data-observatory-view]')?.dataset.selectedStep === String(value), step);
  const reading = await page.locator(`${APP} [data-observatory-view]`).evaluate(host => ({
    edges: [...host.querySelectorAll('[data-key-position]')].map(node => ({ position: Number(node.dataset.keyPosition), weight: Number(node.dataset.attentionWeight) })),
    query: host.querySelector('[data-attention-plot] svg')?.getAttribute('aria-label'),
    queryLabel: host.querySelector('.la-attention-query')?.textContent,
    delta: host.querySelector('[data-delta-inspection]')?.textContent,
    canvasDescription: host.querySelector('[data-delta-waterfall]')?.getAttribute('aria-description'),
    checkpoints: [...host.querySelectorAll('[data-lens-checkpoint]')].map(node => Number(node.dataset.lensCheckpoint)),
    points: [...host.querySelectorAll('[data-lens-token]')].map(node => ({ layer: Number(node.dataset.lensLayer), id: Number(node.dataset.lensToken), rank: Number(node.dataset.rank) })).sort((a, b) => a.layer - b.layer || a.id - b.id),
    lensWordCount: host.querySelector('[data-lens-plot]').clientHeight < 72 ? 2 : 3,
    lensLinks: [...host.querySelectorAll('[data-lens-path-token]')].map(node => Number(node.dataset.lensPathToken)).sort((a, b) => a - b),
    sampled: [...host.querySelectorAll('[data-sampled="true"]')].map(node => Number(node.dataset.candidateId)),
    range: host.querySelector('[data-history-step]')?.getAttribute('aria-valuetext')
  }));
  assert.deepEqual(reading.edges, [{ position: 3, weight: 0.41 + index % 5 * 0.01 }, { position: 47, weight: 0.19 }, { position: 1023 + index, weight: 0.07 }], 'Attention keeps absolute key positions and original sparse head-mean weights');
  assert(reading.edges.reduce((sum, edge) => sum + edge.weight, 0) < 1, 'Sparse weights are not renormalized to the retained keys');
  assert.match(reading.query, new RegExp(`context position ${1023 + index},`));
  assert.equal(reading.queryLabel, `${index === 0 ? 'prompt1023' : `token${index - 1}`} · query ${1023 + index}`, 'Attention identifies the preceding query token, not the newly sampled token');
  assert.match(reading.delta, new RegExp(`^L${layer + 1} · `));
  assert(Math.abs(Number(reading.delta.split('·')[1].trim()) - (0.05 + layer / 100 + (index % 7) / 50)) < 0.00006, 'Selected layer shows its measured relative delta');
  assert.match(reading.canvasDescription, new RegExp(`Step ${step}\\.`));
  assert.deepEqual(reading.checkpoints.slice().sort((a, b) => a - b), [-1, 11, 19], 'Lens uses two measured checkpoints and a separately labelled Final column');
  const expectedPoints = [
    { layer: -1, id: 5000 + index, rank: 1 }, { layer: -1, id: 5001 + index, rank: 2 }, { layer: -1, id: 5002 + index, rank: 3 },
    { layer: 11, id: 5000 + index, rank: 2 }, { layer: 11, id: 5001 + index, rank: 3 }, { layer: 11, id: 5002 + index, rank: 1 },
    { layer: 19, id: 5000 + index, rank: 1 }, { layer: 19, id: 5001 + index, rank: 3 }, { layer: 19, id: 5002 + index, rank: 2 }
  ].filter(point => point.rank <= reading.lensWordCount);
  assert.deepEqual(reading.points, expectedPoints, 'Each checkpoint preserves its measured token ranks independently of final probabilities');
  const expectedLinks = [[11, 19], [19, -1]].flatMap(([left, right]) => expectedPoints.filter(point => point.layer === left && expectedPoints.some(next => next.layer === right && next.id === point.id)).map(point => point.id)).sort((a, b) => a - b);
  assert.deepEqual(reading.lensLinks, expectedLinks, 'Connections follow matching token IDs between adjacent measured checkpoints and Final');
  assert.deepEqual(reading.sampled, [5000 + index], 'The selected sampled token is identified among final candidates');
  assert.match(reading.range, new RegExp(`Step ${step}(?:,|$)`));
}

async function assertObservatoryCleared(page, label) {
  await page.waitForFunction(() => document.querySelector('[data-observatory-view]')?.dataset.historyCount === '0');
  const reading = await page.locator(`${APP} [data-observatory-view]`).evaluate(host => ({
    selected: host.dataset.selectedStep, pinned: host.dataset.pinned,
    states: ['attention', 'delta', 'next'].map(name => host.querySelector(`[data-${name}-panel]`).dataset.state),
    edges: host.querySelectorAll('[data-key-position]').length,
    lens: host.querySelectorAll('[data-lens-checkpoint]').length,
    candidates: host.querySelectorAll('[data-candidate-id]').length,
    steps: host.querySelector('[data-delta-waterfall]').dataset.steps,
    disabled: host.querySelector('[data-history-step]').disabled,
    live: host.querySelector('[data-observatory-live]').getAttribute('aria-pressed')
  }));
  assert.deepEqual(reading, { selected: '', pinned: 'false', states: ['waiting', 'waiting', 'waiting'], edges: 0, lens: 0, candidates: 0, steps: '', disabled: true, live: 'true' }, label);
}

async function assertFixtureViewports(browser, baseUrl) {
  const page = await createPage(browser);
  await installUiFixture(page, true);
  try {
    await page.goto(url(baseUrl), { waitUntil: 'domcontentloaded' });
    await phase(page, 'loading');
    for (const [width, height] of [[3840, 2160], [2560, 1440], [1920, 1200], [1600, 1200], [1920, 1080], [1440, 900], [1280, 720], [1024, 600], [800, 600]]) {
      await page.setViewportSize({ width, height });
      // WebKit applies dynamic viewport units on the next rendering update.
      await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 2);
      await page.screenshot({ path: path.join(OUTPUT, `fixture-welcome-${browser.browserType().name()}-${width}x${height}.png`) });
      await assertFits(page, `Welcome ${width}x${height}`);
    }
    await element(page, 'play').click();
    for (const [width, height] of [[800, 600], [1440, 900], [3840, 2160]]) {
      await page.setViewportSize({ width, height });
      await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 2);
      await page.screenshot({ path: path.join(OUTPUT, `fixture-snake-${browser.browserType().name()}-${width}x${height}.png`) });
      await assertFits(page, `Expanded Snake ${width}x${height}`);
      const game = await page.locator(APP).evaluate(root => ({
        board: root.querySelector('[data-canvas]').getBoundingClientRect().height,
        workspace: root.querySelector('.la-workspace').getBoundingClientRect().height,
        expanded: root.querySelector('[data-welcome]').classList.contains('is-playing')
      }));
      assert(game.expanded && game.board > game.workspace * 0.6, `Snake uses more than 60% of the workspace height at ${width}x${height}`);
    }
    await page.evaluate(() => globalThis.__localAssistantFixture.pending.at(-1).finish());
    await phase(page, 'ready');
    assert.equal(await element(page, 'welcome').isVisible(), true, 'Model readiness during an active Snake game keeps the welcome screen');
    assert.equal(await element(page, 'enter').isVisible(), true, 'The Enter chat button is offered while Snake is running');
    await element(page, 'enter').click();
    await element(page, 'thinking').uncheck();
    await element(page, 'slow').check();
    await element(page, 'input').fill('Render long Markdown and math fixture');
    await element(page, 'send').click();
    await phase(page, 'generating');
    const captured = await page.evaluate(() => { const { thinking, slow } = globalThis.__localAssistantFixture.generations.at(-1); return { thinking, slow }; });
    assert.deepEqual(captured, { thinking: false, slow: true }, 'Thinking and Slow choices reach the runtime independently');
    assert.equal(await element(page, 'thinking').isDisabled(), true, 'Thinking is fixed for an active generation');
    assert.equal(await element(page, 'slow').isDisabled(), false, 'Slow remains adjustable while inference is active');
    await element(page, 'slow').uncheck();
    assert.equal(await page.evaluate(() => globalThis.__localAssistantFixture.slowCalls.at(-1)), false, 'Live Slow change reaches the active runtime');
    assert.equal(await page.evaluate(() => globalThis.__localAssistantFixture.generations.length), 1, 'Pacing change does not restart inference');
    await page.evaluate(() => {
      globalThis.__localAssistantFixture.generations.at(-1).update('', '', {
        stage: 'prefill', promptProcessed: 256, promptTotal: 1024,
        promptTokens: Array.from({ length: 1024 }, (_, id) => ({ id, piece: `prompt${id}` })),
        pass: 1, contextUsed: 1024, layerBackend: 'TEST FIXTURE'
      });
    });
    await page.waitForFunction(() => /256/.test(document.querySelector('[data-observation-step]')?.textContent || ''));
    await assertObservatoryCleared(page, 'Prompt processing does not invent observatory measurements');
    assert.match(await element(page, 'observation-step').innerText(), /256.*1[, ]?024/);
    assert.equal(await page.locator(`${APP} [data-tokens], ${APP} [data-layer-bar]`).count(), 0, 'Obsolete token grid and RMS bars are absent');
    await page.screenshot({ path: path.join(OUTPUT, `fixture-prefill-${browser.browserType().name()}-3840x2160.png`) });
    await page.evaluate(() => {
      const content = '## Fixture answer\n\n**Bold** and $x^2$ with safe output.\n\n```js\nconst sample = "<script>alert(1)</script>";\n```\n\n' + 'Long transcript content. '.repeat(2400);
      // These values are synthetic browser-test fixtures, not model telemetry.
      // Sparse weights deliberately sum to less than one: omitted keys retain mass.
      globalThis.__localAssistantFixture.emitDecode = (index, measured = true) => {
        const queryPosition = 1023 + index;
        const candidates = [0.4, 0.2, 0.15, 0.1, 0.06, 0.04, 0.03, 0.02].map((probability, rank) => ({ id: index + 5000 + rank, piece: `token${index + rank}`, probability }));
        globalThis.__localAssistantFixture.generations.at(-1).update(content, '', {
          stage: 'decode', token: { id: index + 5000, piece: `token${index}` }, generated: index + 1, contextUsed: 1025 + index,
          tokensPerSecond: 999.9, promptMs: 1234.5, candidates, pass: index + 2, layerBackend: 'TEST FIXTURE',
          ...(measured ? {
            attention: [3, 7, 11, 15, 19, 23].map(layer => {
              const entries = [{ position: 3, weight: 0.41 + index % 5 * 0.01 }, { position: 47, weight: 0.19 }, { position: queryPosition, weight: 0.07 }];
              return { layer, queryPosition, keyCount: queryPosition + 1, headCount: 16, entries, coverage: entries.reduce((sum, entry) => sum + entry.weight, 0) };
            }),
            layerChanges: Array.from({ length: 24 }, (_, layer) => ({ layer, relativeDelta: 0.05 + layer / 100 + (index % 7) / 50, inputRms: 1, deltaRms: 0.05 + layer / 100 + (index % 7) / 50 })),
            lens: [11, 19].map(layer => ({ layer, candidates: (layer === 11 ? [2, 0, 1] : [0, 2, 1]).map((offset, rank) => ({ id: 5000 + index + offset, piece: `token${index + offset}`, probability: [0.5, 0.25, 0.1][rank] })) }))
          } : {})
        });
      };
      for (let index = 0; index < 1021; index++) globalThis.__localAssistantFixture.emitDecode(index);
    });
    await assertObservatorySnapshot(page, 1020);
    assert.equal(await element(page, 'observatory-view').getAttribute('data-history-count'), '256', 'Retained history is bounded to measured passes');
    const attentionKey = page.locator(`${APP} [data-key-position]`).first();
    await attentionKey.focus();
    await attentionKey.press('Enter');
    assert.equal(await element(page, 'observatory-view').getAttribute('data-pinned'), 'true', 'Attention links are keyboard accessible and pin the shared pass');
    assert.equal(await attentionKey.evaluate(node => node === document.activeElement), true, 'Attention inspection retains keyboard focus');
    await element(page, 'observatory-live').click();
    const waterfall = element(page, 'delta-waterfall');
    await waterfall.focus();
    await waterfall.press('ArrowLeft');
    await assertObservatorySnapshot(page, 1019);
    assert.equal(await element(page, 'observatory-view').getAttribute('data-pinned'), 'true', 'Keyboard step selection pins all three views');
    assert.equal(await waterfall.evaluate(node => node.matches(':focus-visible')), true, 'Waterfall keyboard inspection has visible focus');
    await waterfall.press('ArrowDown');
    await assertObservatorySnapshot(page, 1019, 1);
    const pinnedWindow = await waterfall.getAttribute('data-steps');
    await page.evaluate(() => globalThis.__localAssistantFixture.emitDecode(1021));
    await page.waitForFunction(() => document.querySelector('[data-generated]')?.textContent.replace(/,/g, '') === '1022');
    await assertObservatorySnapshot(page, 1019, 1);
    assert.equal(await waterfall.getAttribute('data-steps'), pinnedWindow, 'A pinned historical window stays still while newer passes arrive');
    await element(page, 'observatory-live').focus();
    await element(page, 'observatory-live').press('Enter');
    await assertObservatorySnapshot(page, 1021, 1);
    assert.equal(await element(page, 'observatory-view').getAttribute('data-pinned'), 'false');
    await waterfall.focus();
    await waterfall.press('ArrowLeft');
    await assertObservatorySnapshot(page, 1020, 1);
    await waterfall.press('Escape');
    await assertObservatorySnapshot(page, 1021, 1);
    // Optional data is absent for one real-shaped pass, never borrowed from its predecessor.
    await page.evaluate(() => globalThis.__localAssistantFixture.emitDecode(1022, false));
    await page.waitForFunction(() => document.querySelector('[data-observatory-view]')?.dataset.selectedStep === '1024');
    assert.equal(await element(page, 'attention-panel').getAttribute('data-state'), 'waiting');
    assert.equal(await page.locator(`${APP} [data-key-position], ${APP} [data-lens-checkpoint]`).count(), 0, 'Missing attention/lens measurements do not reuse the prior pass');
    assert.match(await element(page, 'delta-inspection').innerText(), /—/);
    assert.match(await waterfall.getAttribute('aria-description'), /not measured/);
    assert.equal(await page.locator(`${APP} [data-sampled="true"]`).getAttribute('data-candidate-id'), '6022', 'Final probabilities remain independent of unavailable intermediate readings');
    await page.evaluate(() => { globalThis.__localAssistantFixture.emitDecode(1023); globalThis.__localAssistantFixture.generations.at(-1).finish(); });
    await phase(page, 'ready');
    await assertObservatorySnapshot(page, 1023, 1);
    await page.locator(`${APP} [data-attention-layer="3"]`).focus();
    await page.locator(`${APP} [data-attention-layer="3"]`).press('Enter');
    assert.equal(await page.locator(`${APP} [data-attention-layer="3"]`).getAttribute('aria-pressed'), 'true', 'Attention layer selection is keyboard accessible');
    await assertObservatorySnapshot(page, 1023, 1);
    await element(page, 'history-step').focus();
    await element(page, 'history-step').press('Home');
    await assertObservatorySnapshot(page, 768, 1);
    await element(page, 'history-step').press('End');
    await assertObservatorySnapshot(page, 1023, 1);
    await element(page, 'observatory-live').click();
    const historyCapacity = {};
    assert.equal(await page.locator(`${APP} [data-transcript] math`).count(), 1, 'Math renders');
    assert.equal(await page.locator(`${APP} [data-transcript] script`).count(), 0, 'Model source cannot create scripts');
    for (const [width, height] of [[3840, 2160], [2560, 1440], [1920, 1200], [1600, 1200], [1920, 1080], [1440, 900], [1280, 720], [1024, 600], [800, 600]]) {
      await page.setViewportSize({ width, height });
      // WebKit applies dynamic viewport units on the next rendering update.
      await page.waitForFunction(() => Math.abs(document.body.getBoundingClientRect().height - innerHeight) < 2);
      await page.screenshot({ path: path.join(OUTPUT, `fixture-chat-${browser.browserType().name()}-${width}x${height}.png`) });
      await assertFits(page, `Chat ${width}x${height}`);
      const diagramText = await page.locator(`${APP} [data-observatory-view] svg text`).evaluateAll(nodes => nodes.filter(node => node.textContent.trim()).map(node => {
        const transform = node.getScreenCTM();
        return { text: node.textContent, height: node.getBBox().height * Math.hypot(transform.c, transform.d) };
      }));
      assert(diagramText.length > 0 && diagramText.every(node => node.height >= 8.8), `Diagram glyphs remain readable at ${width}x${height}: ${JSON.stringify(diagramText.filter(node => node.height < 8.8))}`);
      await element(page, 'input').focus();
      const composer = await page.locator(APP).evaluate(root => {
        const input = root.querySelector('[data-input]');
        const inputBox = input.getBoundingClientRect();
        const send = root.querySelector('[data-send]').getBoundingClientRect();
        const style = getComputedStyle(input);
        const ring = style.outlineStyle === 'none' ? 0 : Math.max(0, Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset));
        const waterfall = root.querySelector('[data-delta-waterfall]');
        const lens = root.querySelector('[data-lens-plot]').getBoundingClientRect();
        const candidates = root.querySelector('[data-candidates]').getBoundingClientRect();
        return { innerOutline: style.outlineStyle, separate: inputBox.bottom + ring <= send.top || inputBox.right + ring <= send.left || inputBox.top - ring >= send.bottom || inputBox.left - ring >= send.right,
          columns: waterfall.dataset.steps.split(',').filter(Boolean).length, lensAboveCandidates: lens.bottom <= candidates.top + 1 };
      });
      assert.equal(composer.innerOutline, 'none', 'The dock has one focus boundary, not a second textarea outline');
      assert(composer.separate, `Focused composer ring does not overlap Send at ${width}x${height}`);
      assert(composer.lensAboveCandidates, `Logit lens remains above final probabilities at ${width}x${height}`);
      historyCapacity[width] = composer.columns;
      assert(composer.columns > 0 && composer.columns <= 256, 'Waterfall width exposes a bounded window of measured passes');
      assert.equal(await element(page, 'transcript').evaluate(node => node.scrollHeight > node.clientHeight), true, 'Long conversation scrolls inside transcript');
    }
    assert(historyCapacity[3840] > historyCapacity[1440] && historyCapacity[2560] >= historyCapacity[1440], `Large observatory exposes more measured history: ${JSON.stringify(historyCapacity)}`);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    const moving = await page.locator(APP).evaluate(root => root.getAnimations({ subtree: true }).filter(animation => animation.playState === 'running' && Number(animation.effect?.getTiming().duration) > 1).length);
    assert.equal(moving, 0, 'Reduced motion leaves no running decorative animation');
    await element(page, 'transcript').evaluate(node => { node.scrollTop = 0; });
    await element(page, 'latest').waitFor({ state: 'visible' });
    await element(page, 'latest').click();
    await page.waitForFunction(() => { const node = document.querySelector('[data-transcript]'); return node.scrollHeight - node.scrollTop - node.clientHeight < 48; });
    await element(page, 'thinking').check();
    await element(page, 'input').fill('Exercise visible error recovery');
    await element(page, 'send').click();
    await phase(page, 'generating');
    assert.equal(await page.evaluate(() => globalThis.__localAssistantFixture.generations.at(-1).thinking), true, 'Thinking can be enabled independently for the next turn');
    await assertObservatoryCleared(page, 'A new turn clears pinned history, attention, deltas, lens, and candidates');
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
    await element(page, 'new').click();
    await phase(page, 'ready');
    await element(page, 'input').fill('Reset during an observed generation');
    await element(page, 'send').click();
    await phase(page, 'generating');
    await page.evaluate(() => {
      globalThis.__localAssistantFixture.generations.at(-1).update('', '', { stage: 'prefill', promptProcessed: 1024, promptTotal: 1024, pass: 1, contextUsed: 1024, promptTokens: Array.from({ length: 1024 }, (_, id) => ({ id, piece: `prompt${id}` })) });
      globalThis.__localAssistantFixture.emitDecode(0);
    });
    await assertObservatorySnapshot(page, 0);
    await element(page, 'new').click();
    await phase(page, 'ready');
    await assertObservatoryCleared(page, 'Reset during inference clears all linked views and ignores stale callbacks');
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
  await assertAutoEntersChat(browser, baseUrl);
  await assertContextExhaustionRecovery(browser, baseUrl);
  await assertSampledTailCandidate(browser, baseUrl);
  console.log('Local Assistant: isolated fixture lifecycle and review regressions passed.');
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

async function assertRealObservatory(page, runName) {
  await page.waitForFunction(() => Number(document.querySelector('[data-observatory-view]')?.dataset.historyCount) > 0);
  const host = element(page, 'observatory-view');
  const latestStep = Number(await host.getAttribute('data-selected-step'));
  const historyCount = Number(await host.getAttribute('data-history-count'));
  const layers = await page.locator(`${APP} [data-attention-layer]`).evaluateAll(nodes => nodes.map(node => Number(node.dataset.attentionLayer)));
  assert.deepEqual(layers, [3, 7, 11, 15, 19, 23], 'Actual model exposes all six measured attention blocks');
  const attention = [];
  for (const layer of layers) {
    await page.locator(`${APP} [data-attention-layer="${layer}"]`).click();
    assert.equal(await element(page, 'attention-panel').getAttribute('data-state'), 'available', `Layer ${layer + 1} has actual attention measurements`);
    const entries = await page.locator(`${APP} [data-key-position]`).evaluateAll(nodes => nodes.map(node => ({ position: Number(node.dataset.keyPosition), weight: Number(node.dataset.attentionWeight) })));
    assert(entries.length > 0 && entries.every(entry => Number.isInteger(entry.position) && entry.position >= 0 && Number.isFinite(entry.weight) && entry.weight >= 0 && entry.weight <= 1.00001), `Layer ${layer + 1} renders finite measured attention weights`);
    attention.push({ layer, entries });
  }
  assert.equal(await element(page, 'delta-panel').getAttribute('data-state'), 'available', 'Native layer-change measurements are available');
  const waterfall = element(page, 'delta-waterfall');
  assert.equal(await waterfall.getAttribute('data-layers'), '24', 'Native waterfall includes all 24 model layers');
  await waterfall.focus();
  for (let index = 0; index < 24; index++) await waterfall.press('ArrowUp');
  const deltaRows = [];
  for (let layer = 0; layer < 24; layer++) {
    const label = await element(page, 'delta-inspection').innerText();
    assert.match(label, new RegExp(`^L${layer + 1} · `));
    const value = Number(label.split('·')[1].trim().replace(/,/g, ''));
    assert(Number.isFinite(value) && value >= 0, `Layer ${layer + 1} exposes an actual relative-delta value`);
    deltaRows.push({ layer, value });
    if (layer < 23) await waterfall.press('ArrowDown');
  }
  const checkpoints = await page.locator(`${APP} [data-lens-checkpoint]`).evaluateAll(nodes => nodes.map(node => Number(node.dataset.lensCheckpoint)).filter(layer => layer >= 0).sort((a, b) => a - b));
  assert.deepEqual(checkpoints, [11, 19], 'Both actual intermediate logit-lens checkpoints are present');
  const lens = await page.locator(`${APP} [data-lens-token]`).evaluateAll(nodes => nodes.map(node => ({ layer: Number(node.dataset.lensLayer), id: Number(node.dataset.lensToken), rank: Number(node.dataset.rank) })));
  for (const layer of checkpoints) assert(lens.some(point => point.layer === layer && Number.isInteger(point.id) && point.id >= 0 && Number.isInteger(point.rank) && point.rank > 0), `Checkpoint ${layer + 1} exposes real vocabulary ranks`);
  assert.equal(await element(page, 'next-panel').getAttribute('data-state'), 'available', 'Native final probabilities are available');
  assert(await page.locator(`${APP} [data-candidate-id]`).count() > 0, 'Native final candidate bars are populated');
  assert(historyCount > 1, 'Actual response supplies multiple measured passes for history inspection');
  await waterfall.press('ArrowLeft');
  const pinnedStep = Number(await host.getAttribute('data-selected-step'));
  assert(pinnedStep < latestStep && await host.getAttribute('data-pinned') === 'true', 'Keyboard history selection pins an earlier actual pass');
  assert.match(await waterfall.getAttribute('aria-description'), new RegExp(`Step ${pinnedStep}\\.`));
  assert.match(await element(page, 'history-step').getAttribute('aria-valuetext'), new RegExp(`Step ${pinnedStep}, pinned`));
  assert.equal(await element(page, 'attention-panel').getAttribute('data-state'), 'available');
  assert.equal(await element(page, 'next-panel').getAttribute('data-state'), 'available');
  await page.screenshot({ path: path.join(OUTPUT, `${runName}-pinned.png`) });
  await element(page, 'observatory-live').click();
  assert.equal(await host.getAttribute('data-selected-step'), String(latestStep), 'Live restores the newest actual measured pass');
  assert.equal(await host.getAttribute('data-pinned'), 'false');
  await assertFits(page, 'Real model response and observatory 1440x900');
  return { latestStep, pinnedStep, historyCount, attention, deltaRows, checkpoints, lens };
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
    const generationWallMs = Date.now() - started;
    const answer = await page.locator(`${APP} .la-message--assistant .la-message-body`).last().innerText();
    assert(answer.trim().length > 10 && !answer.includes('No response generated'), 'Actual runtime generates an answer');
    const measuredObservatory = await assertRealObservatory(page, runName);
    const report = { mode: 'real-runtime', modelFixture: Boolean(fixture), browser: browser.browserType().name(), loadWallMs,
      progressMonotonic: monotonic, finalBytes: progress.at(-1)?.loaded, loadMetrics, answer, generationWallMs, measuredObservatory,
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
      await assertAutoEntersChat(browser, baseUrl);
      await assertContextExhaustionRecovery(browser, baseUrl);
      await assertSampledTailCandidate(browser, baseUrl);
      await assertFixtureViewports(browser, baseUrl);
      console.log('Local Assistant UI fixture checks passed (no inference).');
    } else await runLocalAssistantChecks(browser, baseUrl);
  } finally { await browser?.close(); server?.kill(); }
}
module.exports = { runLocalAssistantChecks, runRealModelCheck, runModelCacheCheck };
if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
