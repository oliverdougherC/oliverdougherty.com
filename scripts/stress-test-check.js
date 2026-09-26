#!/usr/bin/env node
// Focused browser coverage: real GPU backends plus a CPU workload pinned to two
// workers (through the exact-count hook, so these pages assert counts, geometry and
// per-worker progress against a pool size they can predict), and dedicated pool pages
// that run the shipped sizing against real cores. One page reports a reduced
// processor count in window scope, where the pool must follow the higher count its
// own worker reports; one runs the unmodified report; one pins 32 workers against a
// report of 12 and must stay at exactly 32.
// STRESS_BROWSER_TYPE selects the engine (chromium|firefox|webkit);
// STRESS_POOL_ONLY=1 runs only the pool pages, for per-engine matrix runs.
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const playwright = require('playwright');
const { startLocalStaticServer } = require('./lib/playwright-static');

const DESKTOP_VIEWPORTS = [
  { width: 800, height: 600 },
  { width: 1024, height: 520 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 }
];

function isPrime(value) {
  if (!Number.isSafeInteger(value) || value < 2) return false;
  if (value % 2 === 0) return value === 2;
  for (let divisor = 3; divisor * divisor <= value; divisor += 2) {
    if (value % divisor === 0) return false;
  }
  return true;
}

async function readPrime(page) {
  const state = await page.evaluate(() => ({
    value: Number(document.querySelector('#stressTestApp').dataset.stressLatestPrime),
    displayed: Number(document.querySelector('#stressLatestPrime').textContent.replaceAll(',', '').trim())
  }));
  assert(state.value > 1 && state.value < 1e12, `Prime search should grow from small numbers, got ${state.value}.`);
  assert(isPrime(state.value), `Reported result ${state.value} is not prime.`);
  assert.equal(state.displayed, state.value, 'Displayed prime should agree with the actual worker result.');
  return state.value;
}

/**
 * The static HTML already declares `data-stress-state="idle"`, so that selector proves
 * only that the markup arrived. A click sent before the controller has bound its
 * listeners is lost without trace, which on a browser that boots its modules slowly
 * looks like a workload that never starts. Every page that clicks therefore first waits
 * for a dataset only the controller publishes: its first metric frame.
 */
async function waitForStressController(page) {
  await page.waitForSelector('#stressTestApp[data-stress-state="idle"]');
  await page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressTotalRenderedFrames !== undefined,
    null, { timeout: 30000 });
}

async function readCpuPipeline(page) {
  return page.evaluate(() => {
    const root = document.getElementById('stressTestApp');
    const data = root.dataset;
    return {
      time: performance.now(),
      pageReport: Number(data.stressCpuReportPage),
      workerReport: Number(data.stressCpuReportWorker),
      report: Number(data.stressCpuReport),
      poolSize: Number(data.stressCpuPoolSize),
      poolSource: data.stressCpuPoolSource,
      limitation: data.stressCpuPoolLimitation ?? '',
      blocks: Number(data.stressCpuBlocks),
      workerCount: Number(data.stressWorkerCount),
      algorithm: data.stressCpuAlgorithm,
      candidates: Number(data.stressCandidates),
      workers: Array.from(document.querySelectorAll('#stressWorkerActivity > span')).map(worker => ({
        candidates: Number(worker.dataset.candidates),
        primes: Number(worker.dataset.primesFound),
        rangeLow: Number(worker.dataset.rangeLow),
        blocks: Number(worker.dataset.blocks)
      })),
      // Present only on the pool pages, which install the construction counter.
      trace: window.__POOL_TRACE__ ?? null
    };
  });
}

/**
 * A fixed pool must be visibly complete: one activity bar per worker, every worker
 * testing candidates (a worker that stopped reporting is a stalled or dead worker the
 * aggregate total would hide), each worker sitting in its own region of the number
 * line, and the main thread still able to paint.
 */
async function assertCpuPipeline(page, expectedWorkers) {
  await page.waitForFunction(poolSize => {
    const root = document.getElementById('stressTestApp');
    const workers = Array.from(document.querySelectorAll('#stressWorkerActivity > span'));
    return root.dataset.stressCpuAlgorithm === 'segmented-sieve'
      && Number(root.dataset.stressCpuPoolSize) === poolSize
      && workers.length === poolSize
      && workers.every(worker => Number(worker.dataset.candidates) > 0 && Number(worker.dataset.primesFound) > 0
        && Number(worker.dataset.rangeLow) > 0);
  }, expectedWorkers, { timeout: 15000 });
  const before = await readCpuPipeline(page);
  assert.equal(before.poolSize, expectedWorkers, 'The pool must be exactly the requested count.');
  assert.equal(before.workerCount, expectedWorkers, 'A fixed pool must run exactly the requested number of workers.');
  assert.equal(before.workers.length, before.workerCount, 'Every worker record must own exactly one activity bar.');
  assert.equal(new Set(before.workers.map(worker => worker.rangeLow)).size, before.workers.length,
    'Each worker must own a distinct region of the number line, so no integer is sieved twice.');
  await page.waitForFunction(previous => {
    const workers = Array.from(document.querySelectorAll('#stressWorkerActivity > span'));
    return workers.length === previous.workers.length && workers.every((worker, index) =>
      Number(worker.dataset.candidates) > previous.workers[index].candidates);
  }, before, { timeout: 15000 });
  const after = await readCpuPipeline(page);
  assert.equal(after.poolSize, before.poolSize, 'A fixed pool must not change size while the run lasts.');
  assert(after.blocks > 0, 'The pool must report how far its lanes have advanced.');
  let responsivenessTimer;
  try {
    await Promise.race([
      page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
      new Promise((_, reject) => { responsivenessTimer = setTimeout(() => reject(new Error('CPU workload prevented animation-frame callbacks for 5 seconds.')), 5000); })
    ]);
  } finally {
    clearTimeout(responsivenessTimer);
  }
  await readPrime(page);
  const elapsedMs = after.time - before.time;
  const completedCandidates = after.candidates - before.candidates;
  assert(elapsedMs > 0 && completedCandidates > 0, 'CPU pipeline should complete additional actual candidates over elapsed time.');
  return {
    algorithm: after.algorithm,
    workers: after.workerCount,
    poolSize: after.poolSize,
    poolSource: after.poolSource,
    report: after.report,
    observedCandidates: completedCandidates,
    observedMilliseconds: Math.round(elapsedMs),
    candidatesPerSecond: Math.round(completedCandidates * 1000 / elapsedMs)
  };
}

async function assertPrimeTypography(page) {
  await page.evaluate(() => document.fonts.ready);
  const state = await page.evaluate(async () => {
    const number = document.getElementById('stressLatestPrime');
    const original = number.textContent;
    const originalDigits = number.style.getPropertyValue('--prime-digits');
    const styles = getComputedStyle(number);
    const measure = async text => {
      number.textContent = text;
      number.style.setProperty('--prime-digits', String(text.length));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const range = document.createRange();
      range.selectNodeContents(number);
      const rect = range.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
    };
    try {
      return { font: styles.fontFamily, weight: styles.fontWeight, one: await measure('1'), many: await measure('999,999,999'), viewportWidth: innerWidth };
    } finally {
      number.textContent = original;
      if (originalDigits) number.style.setProperty('--prime-digits', originalDigits);
      else number.style.removeProperty('--prime-digits');
    }
  });
  assert(/JetBrains Mono/i.test(state.font), 'Prime numerals should use JetBrains Mono.');
  assert(Number(state.weight) >= 800, 'Prime numerals should use weight 800.');
  assert(Math.abs(state.one.right - state.many.right) <= 1, `Additional digits must grow left from a fixed right edge: ${JSON.stringify(state)}.`);
  assert(state.many.left >= 0 && state.many.right <= state.viewportWidth, 'Long prime numerals must remain within the viewport.');
}

async function assertStressGeometry(page, label) {
  const failures = await page.evaluate(() => {
    const root = document.getElementById('stressTestApp');
    const problems = [];
    const bounds = element => element.getBoundingClientRect();
    const describe = element => element.id || `${element.tagName}.${element.className}`;
    const visible = element => element.getClientRects().length > 0 && !element.closest('[hidden], .sr-only') && getComputedStyle(element).visibility !== 'hidden';
    const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const required = ['#stressStartBtn', '#stressStopBtn', '#stressCanvas', '[data-stress-mode-option]', '.stress-metrics > div'];
    if (root.querySelector('#stressIntensity, .stress-intensity')) problems.push('retired GPU intensity control is present');
    if (root.dataset.stressMode !== 'gpu') required.push('#stressPrimeDisplay', '#stressLatestPrime', '#stressWorkerSummary');
    if (Number(root.dataset.stressWorkerCount) > 0) required.push('#stressWorkerActivity', '#stressWorkerActivity > span');
    if (root.dataset.stressMode !== 'cpu' && root.dataset.stressGpuCanvasActive === 'true') required.push('#stressGpuDetail');
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.documentElement.scrollHeight > document.documentElement.clientHeight + 1) problems.push('document overflows');
    for (const selector of required) {
      const elements = document.querySelectorAll(selector);
      if (!elements.length) problems.push(`${selector} missing`);
      for (const element of elements) {
        const rect = bounds(element);
        if (!visible(element) || rect.width <= 0 || rect.height <= 0) problems.push(`${describe(element)} hidden/empty`);
        if (!inside(rect, viewport)) problems.push(`${describe(element)} escapes viewport: ${JSON.stringify(rect.toJSON())}`);
        for (let ancestor = element.parentElement; ancestor && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (style.display !== 'inline' && style.display !== 'contents' && !inside(rect, bounds(ancestor))) problems.push(`${describe(element)} escapes ${describe(ancestor)}`);
        }
      }
    }
    for (const element of [root, ...root.querySelectorAll('*')].filter(visible)) {
      const styles = getComputedStyle(element);
      if (/^(auto|scroll)$/.test(styles.overflowX) || /^(auto|scroll)$/.test(styles.overflowY)) problems.push(`${describe(element)} creates internal scrolling`);
      if (element.hasAttribute('title')) problems.push(`${describe(element)} has a tooltip`);
    }
    const scene = document.querySelector('.stress-visual-panel');
    let background = 'rgba(0, 0, 0, 0)';
    for (let element = scene; element; element = element.parentElement) {
      background = getComputedStyle(element).backgroundColor;
      if (background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') break;
    }
    if (!['rgb(255, 255, 255)', 'rgb(247, 247, 245)'].includes(background)) problems.push(`scene background is not white: ${background}`);
    return problems;
  });
  assert.deepEqual(failures, [], `${label} geometry at ${JSON.stringify(page.viewportSize())}`);
}

async function assertDesktopSizes(page, label) {
  const original = page.viewportSize();
  try {
    for (const viewport of DESKTOP_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await assertStressGeometry(page, label);
      if (await page.locator('#stressTestApp').getAttribute('data-stress-state') === 'idle') await assertPrimeTypography(page);
    }
  } finally {
    await page.setViewportSize(original);
  }
}

// Fixed-pool coverage. `pageCores` replaces window-scope `hardwareConcurrency`
// before the app runs; `exactWorkers` is the diagnostic hook. Both pages count every
// stress-worker construction and every change to the published pool size from before
// the app exists, so a pool that resizes during a run — or constructs a worker nobody
// asked for — fails the check even if its final count happens to look right.
function poolInit({ pageCores, exactWorkers }) {
  if (pageCores) Object.defineProperty(navigator, 'hardwareConcurrency', { value: pageCores, configurable: true });
  if (exactWorkers) window.__OD_STRESS_TEST_WORKERS__ = exactWorkers;
  window.__POOL_TRACE__ = { workers: 0, sizes: [] };
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
    constructor(workerUrl, options) {
      super(workerUrl, options);
      if (/stressTest\.worker/.test(String(workerUrl))) window.__POOL_TRACE__.workers += 1;
    }
  };
  document.addEventListener('DOMContentLoaded', () => {
    const app = document.getElementById('stressTestApp');
    const trace = window.__POOL_TRACE__;
    const record = () => {
      const value = app.dataset.stressCpuPoolSize ?? 'none';
      if (trace.sizes.at(-1) !== value) trace.sizes.push(value);
    };
    new MutationObserver(record).observe(app, { attributes: true, attributeFilter: ['data-stress-cpu-pool-size'] });
    record();
  });
}

async function assertPoolMode(browser, url, { pageCores = null, exactWorkers = null, label }) {
  const startedAt = Date.now();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(poolInit, { pageCores, exactWorkers });
  await page.goto(`${url}/pages/utilities/index.html#stress-test`);
  await waitForStressController(page);
  await page.click('[data-stress-mode-option="cpu"]');
  await page.click('#stressStartBtn');
  await page.waitForFunction(() => document.querySelector('#stressTestApp').dataset.stressCpuPoolSize !== undefined,
    null, { timeout: 30000 });
  // The size dataset is written at plan time; the throttled metric loop refreshes the
  // running worker count and the bars, so sample once those agree.
  await page.waitForFunction(() => {
    const data = document.querySelector('#stressTestApp').dataset;
    return Number(data.stressWorkerCount) === Number(data.stressCpuPoolSize)
      && document.querySelectorAll('#stressWorkerActivity > span').length === Number(data.stressCpuPoolSize);
  }, null, { timeout: 30000 });
  const planned = await page.evaluate(() => {
    const data = document.querySelector('#stressTestApp').dataset;
    return {
      state: data.stressState,
      limitation: data.stressCpuPoolLimitation ?? '',
      pageReport: Number(data.stressCpuReportPage),
      workerReport: Number(data.stressCpuReportWorker),
      report: Number(data.stressCpuReport),
      poolSize: Number(data.stressCpuPoolSize),
      poolSource: data.stressCpuPoolSource,
      workers: Number(data.stressWorkerCount),
      bars: document.querySelectorAll('#stressWorkerActivity > span').length,
      candidates: Number(data.stressCandidates),
      perWorker: Array.from(document.querySelectorAll('#stressWorkerActivity > span')).map(bar => ({
        candidates: Number(bar.dataset.candidates), rangeLow: Number(bar.dataset.rangeLow)
      })),
      trace: window.__POOL_TRACE__
    };
  });
  const expected = exactWorkers ?? Math.max(planned.pageReport, planned.workerReport);
  assert.equal(planned.state, 'running', `(${label}) the pool must be running: ${JSON.stringify(planned)}`);
  assert.equal(planned.limitation, '', `(${label}) a complete pool must not report a worker-creation shortfall`);
  assert.equal(planned.poolSize, expected, `(${label}) the pool must be exactly the count it was given: ${JSON.stringify(planned)}`);
  assert.equal(planned.poolSource, exactWorkers ? 'exact' : (expected > 0 ? 'report' : 'fallback'),
    `(${label}) the plan must say where its count came from: ${JSON.stringify(planned)}`);
  assert.equal(planned.report, expected, `(${label}) the count the pool was sized from must be published`);
  if (pageCores) {
    // Whatever the page was told must be visible, even when the pool used a higher
    // reading: a reduced report is shown, not hidden behind the pool's final number.
    assert.equal(planned.pageReport, pageCores, `(${label}) the page must publish the hint it was given`);
  }
  assert.equal(planned.workers, expected, `(${label}) the running worker count must equal the pool size`);
  assert.equal(planned.bars, expected, `(${label}) every worker record must own exactly one activity bar`);
  // The pool is built once: not one extra worker is constructed, and the published
  // size is written once and never revised. This is the assertion that a pool which
  // resizes — for any reason, on any measurement — cannot pass. (`none` is the state
  // before Start, recorded by the observer as soon as the app exists.)
  assert.equal(planned.trace.workers, expected,
    `(${label}) the page must construct exactly the pool it asked for: ${JSON.stringify(planned.trace)}`);
  assert.deepEqual(planned.trace.sizes.filter(size => size !== 'none'), [String(expected)],
    `(${label}) the pool size must be published once and never changed: ${JSON.stringify(planned.trace)}`);
  // A fixed pool must also be a working pool: every worker keeps testing candidates,
  // in its own region of the number line.
  assert.equal(new Set(planned.perWorker.map(worker => worker.rangeLow)).size, planned.workers,
    `(${label}) each worker must own a distinct region of the number line`);
  await page.waitForFunction(previous => {
    const workers = Array.from(document.querySelectorAll('#stressWorkerActivity > span'));
    return workers.length === previous.length && workers.every((bar, index) =>
      Number(bar.dataset.candidates) > previous[index].candidates);
  }, planned.perWorker, { timeout: 20000 });
  await page.waitForFunction(previous => Number(document.querySelector('#stressTestApp').dataset.stressCandidates) > previous.candidates,
    planned, { timeout: 20000 });
  // And it must still be that size after the run has had every reason to change: a
  // throughput collapse, a long elapsed time, and messages arriving out of order are
  // what the removed adaptive rules reacted to.
  await page.waitForTimeout(4000);
  const held = await readCpuPipeline(page);
  assert.equal(held.poolSize, expected, `(${label}) the pool size must not move during a run`);
  assert.equal(held.workerCount, expected, `(${label}) the running pool must not lose or gain workers during a run`);
  assert.equal(held.trace.workers, expected, `(${label}) no worker may be constructed after the pool is built`);
  await page.click('#stressStopBtn');
  await page.waitForSelector('#stressTestApp[data-stress-state="idle"]');
  assert.equal(await page.locator('#stressWorkerActivity > span').count(), 0);
  assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-worker-count'), '0');
  assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-cpu-pool-size'), null);
  assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-cpu-report'), null);
  assert.deepEqual(errors, [], `(${label}) browser errors`);
  await page.close();
  console.log(`CPU pool page passed (${label}: ${planned.pageReport} page / ${planned.workerReport} worker report → `
    + `${expected} workers, source ${planned.poolSource}, ${planned.trace.workers} spawns, held after 4 s) `
    + `in ${Date.now() - startedAt}ms`);
  return { label, ...planned, heldPoolSize: held.poolSize };
}

// The reduced-report path (the reported bug: a browser whose window scope reports
// fewer processors than its own workers do) and the unmodified path, plus the exact
// diagnostic count against a reduced report.
async function assertPoolPages(browser, url) {
  const logicalCores = os.cpus().length;
  // The reduced-report page only covers what it is here for if this browser answers
  // truthfully in worker scope; say so out loud instead of passing silently.
  const reduced = await assertPoolMode(browser, url, {
    pageCores: Math.max(1, Math.min(4, logicalCores - 1)),
    label: 'reduced page report'
  });
  if (reduced.workerReport <= reduced.pageReport) {
    console.log(`NOTE: this engine reports ${reduced.workerReport} in worker scope and ${reduced.pageReport} in `
      + 'window scope, so the reduced-report case could not be exercised here.');
  }
  const unmodified = await assertPoolMode(browser, url, { label: 'unmodified report' });
  const exact = await assertPoolMode(browser, url, { pageCores: 12, exactWorkers: 32, label: 'exact 32 over report 12' });
  return { reduced, unmodified, exact };
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const baseUrl = process.env.STRESS_CHECK_URL || 'http://127.0.0.1:4186';
  const server = await startLocalStaticServer({ url: baseUrl, cwd: root, skip: Boolean(process.env.STRESS_CHECK_URL) });
  const browserType = process.env.STRESS_BROWSER_TYPE || 'chromium';
  assert(['chromium', 'firefox', 'webkit'].includes(browserType), `Unknown STRESS_BROWSER_TYPE: ${browserType}`);
  const launch = { headless: true };
  if (browserType === 'chromium') {
    launch.channel = process.env.STRESS_BROWSER_CHANNEL || undefined;
    if (!process.env.STRESS_BROWSER_CHANNEL) launch.args = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'];
  }
  let browser;
  try {
    browser = await playwright[browserType].launch(launch);
  } catch (error) {
    server?.kill();
    throw error;
  }
  const output = path.join(root, 'output/playwright');
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  const cpuRuns = [];
  try {
    if (process.env.STRESS_POOL_ONLY === '1') {
      const pool = await assertPoolPages(browser, server?.url || baseUrl);
      console.log(JSON.stringify({ passed: true, browserType, poolOnly: true, pool }, null, 2));
      return;
    }
    for (const backend of ['auto', 'webgl2', 'webgl1', 'none']) {
      const backendStarted = Date.now();
      console.log(`Stress backend: ${backend}`);
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.addInitScript((force) => {
        Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
        // Exact-count hook: these pages assert geometry, backends and per-worker
        // progress, so the pool is pinned to a count they can predict rather than
        // following whatever this machine reports.
        window.__OD_STRESS_TEST_WORKERS__ = 2;
        if (force !== 'auto') Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if ((force === 'webgl1' && type === 'webgl2') || (force === 'none' && /webgl/.test(type))) return null;
          return original.call(this, type, ...args);
        };
      }, backend);
      await page.goto(`${server?.url || baseUrl}/pages/utilities/index.html#stress-test`);
      await page.waitForSelector('#stressStartBtn');
      await page.waitForSelector('#stressTestApp[data-stress-state="idle"]');
      assert.equal((await page.locator('#stressLatestPrime').textContent()).trim(), '1', 'Idle display should start at 1.');
      assert.equal(Number(await page.locator('#stressTestApp').getAttribute('data-stress-latest-prime')), 0, 'The initial 1 is a starting marker, not a discovered prime.');
      assert(!/largest prime found|prime found this run/i.test(await page.locator('#stressPrimeCaption').textContent()), 'Initial 1 must not be described as a discovered prime.');
      await assertPrimeTypography(page);
      await assertDesktopSizes(page, `${backend}:idle`);

      if (backend === 'auto') {
        await page.click('[data-stress-mode-option="cpu"]');
        await page.click('#stressStartBtn');
        await page.waitForFunction(() => Number(document.querySelector('#stressTestApp').dataset.stressLatestPrime) > 1);
        const first = await readPrime(page);
        await page.waitForFunction(value => Number(document.querySelector('#stressTestApp').dataset.stressLatestPrime) > Number(value), first);
        await readPrime(page);
        assert.equal(await page.locator('#stressWorkerActivity > span').count(), 2);
        cpuRuns.push({ mode: 'cpu', ...await assertCpuPipeline(page, 2) });
        await assertDesktopSizes(page, 'cpu:running');
        await page.screenshot({ path: path.join(output, 'stress-prime-desktop.png') });
        await page.click('#stressStopBtn');
        await page.waitForSelector('#stressTestApp[data-stress-state="idle"]');
        assert.equal(await page.locator('#stressWorkerActivity > span').count(), 0);
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      await page.click('[data-stress-mode-option="gpu"]');
      await page.click('#stressStartBtn');
      if (backend === 'none') {
        await page.waitForSelector('#stressTestApp[data-stress-state="unsupported"]');
        await page.click('[data-stress-mode-option="both"]');
        await page.click('#stressStartBtn');
        await page.waitForFunction(() => Number(document.querySelector('#stressTestApp').dataset.stressLatestPrime) > 1);
        await readPrime(page);
        await assertDesktopSizes(page, 'no-gpu:cpu-fallback');
        assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-gpu-backend'), 'none');
      } else {
        await page.waitForFunction(() => { const data = document.querySelector('#stressTestApp').dataset; return Number(data.stressTotalRenderedFrames) >= 3 || data.stressState === 'error' || data.stressState === 'unsupported'; }, null, { timeout: 45000 });
        assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-state'), 'running', await page.locator('#stressTestApp').getAttribute('data-stress-gpu-last-error'));
        const selected = await page.locator('#stressTestApp').getAttribute('data-stress-gpu-backend');
        assert.notEqual(selected, 'none');
        if (backend !== 'auto') assert.equal(selected, `${backend}-fragment`);
        await page.screenshot({ path: path.join(output, `stress-${backend}.png`) });
        assert.equal(await page.locator('#stressTestApp select').count(), 0, 'GPU mode should run without an intensity selector.');
        await page.waitForFunction(() => Number(document.querySelector('#stressTestApp').dataset.stressTotalRenderedFrames) >= 5);
        results.push({ requested: backend, selected, detail: await page.locator('#stressGpuDetail').textContent() });
        const framesBeforeResize = Number(await page.locator('#stressTestApp').getAttribute('data-stress-total-rendered-frames'));
        await page.setViewportSize({ width: 800, height: 600 });
        await page.waitForFunction(before => Number(document.querySelector('#stressTestApp').dataset.stressTotalRenderedFrames) > before + 2, framesBeforeResize);
        await page.waitForTimeout(500); // Allow the newly sized swapchain to be presented.
        await page.screenshot({ path: path.join(output, `stress-${backend}-compact.png`) });
        await assertDesktopSizes(page, `${backend}:gpu-running`);
      }
      await page.click('#stressStopBtn');
      await page.waitForSelector('#stressTestApp[data-stress-state="idle"]');
      assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-gpu-canvas-active'), 'false');
      if (backend === 'auto') {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.click('[data-stress-mode-option="both"]');
        await page.click('#stressStartBtn');
        await page.waitForFunction(() => { const data = document.querySelector('#stressTestApp').dataset; return Number(data.stressTotalRenderedFrames) > 3 && Number(data.stressLatestPrime) > 1; });
        await readPrime(page);
        cpuRuns.push({ mode: 'both', ...await assertCpuPipeline(page, 2) });
        await assertDesktopSizes(page, 'both:running');
        await page.screenshot({ path: path.join(output, 'stress-both-desktop.png') });
        const beforeResize = Number(await page.locator('#stressTestApp').getAttribute('data-stress-total-rendered-frames'));
        await page.setViewportSize({ width: 800, height: 600 });
        await page.waitForFunction(before => Number(document.querySelector('#stressTestApp').dataset.stressTotalRenderedFrames) > before + 2, beforeResize);
        await page.screenshot({ path: path.join(output, 'stress-both-compact.png') });
        await page.setViewportSize({ width: 1024, height: 520 });
        await page.screenshot({ path: path.join(output, 'stress-both-short.png') });
        await page.click('#stressStopBtn');
        await page.click('[data-stress-mode-option="gpu"]');
      }
      // Recreate resources on restart, then exercise navigation teardown.
      await page.click('#stressStartBtn');
      if (backend !== 'none') await page.waitForFunction(() => Number(document.querySelector('#stressTestApp').dataset.stressTotalRenderedFrames) >= 2);
      await page.evaluate(() => { location.hash = ''; });
      await page.waitForFunction(() => document.querySelector('#stressTestApp').dataset.stressState === 'idle');
      assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-worker-count'), '0');
      assert.deepEqual(errors, [], `${backend} browser errors`);
      await page.close();
      console.log(`Stress backend passed: ${backend} (${Date.now() - backendStarted}ms)`);
    }
    const pool = await assertPoolPages(browser, server?.url || baseUrl);
    console.log(JSON.stringify({ passed: true, cpuPipeline: cpuRuns, backends: results, pool,
      renderer: process.env.STRESS_BROWSER_CHANNEL ? 'installed-browser' : 'SwiftShader software rendering',
      webgpu: results.some(result => result.selected.startsWith('webgpu')) ? 'executed' : 'unavailable in this run',
      physicalGpuValidation: 'not performed'
    }, null, 2));
  } finally {
    await browser.close();
    server?.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
