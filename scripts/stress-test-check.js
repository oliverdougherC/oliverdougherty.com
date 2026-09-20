#!/usr/bin/env node
// Focused browser coverage: real GPU backends and two reported CPU cores for the test runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
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

async function readCpuPipeline(page) {
  return page.evaluate(() => {
    const root = document.getElementById('stressTestApp');
    const data = root.dataset;
    return {
      time: performance.now(),
      reportedCores: navigator.hardwareConcurrency,
      workerCount: Number(data.stressWorkerCount),
      algorithm: data.stressCpuAlgorithm,
      iterations: Number(data.stressIterations),
      assigned: Number(data.stressCpuBlocksAssigned),
      refills: Number(data.stressCpuRefills),
      workers: Array.from(document.querySelectorAll('#stressWorkerActivity > span')).map(worker => ({
        assigned: Number(worker.dataset.blocksAssigned),
        refills: Number(worker.dataset.refills),
        iterations: Number(worker.dataset.iterations),
        primes: Number(worker.dataset.primesFound)
      }))
    };
  });
}

async function assertCpuPipeline(page) {
  await page.waitForFunction(() => {
    const root = document.getElementById('stressTestApp');
    const workers = Array.from(document.querySelectorAll('#stressWorkerActivity > span'));
    return root.dataset.stressCpuAlgorithm === 'segmented-sieve' &&
      workers.length === navigator.hardwareConcurrency &&
      workers.every(worker => Number(worker.dataset.blocksAssigned) >= 4 && Number(worker.dataset.refills) > 0 && Number(worker.dataset.iterations) > 0 && Number(worker.dataset.primesFound) > 0);
  }, null, { timeout: 15000 });
  const before = await readCpuPipeline(page);
  assert.equal(before.workerCount, before.reportedCores, 'Default CPU workload should use every reported core.');
  assert(before.assigned >= before.workerCount * 4 && before.refills > 0, 'Sieve workers should have an initially filled queue and receive more work.');
  await page.waitForFunction(previous => {
    const root = document.getElementById('stressTestApp');
    const workers = Array.from(document.querySelectorAll('#stressWorkerActivity > span'));
    return Number(root.dataset.stressIterations) > previous.iterations && Number(root.dataset.stressCpuRefills) > previous.refills &&
      workers.length === previous.workers.length && workers.every((worker, index) =>
        Number(worker.dataset.iterations) > previous.workers[index].iterations && Number(worker.dataset.refills) > previous.workers[index].refills);
  }, before, { timeout: 15000 });
  const after = await readCpuPipeline(page);
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
  const completedCandidates = after.iterations - before.iterations;
  assert(elapsedMs > 0 && completedCandidates > 0, 'CPU pipeline should complete additional actual candidates over elapsed time.');
  return {
    algorithm: after.algorithm,
    workers: after.workerCount,
    blocksAssigned: after.assigned,
    refills: after.refills,
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
    const required = ['#stressStartBtn', '#stressStopBtn', '#stressStatusText', '#stressCanvas', '[data-stress-mode-option]', '.stress-metrics > div'];
    if (root.querySelector('#stressIntensity, .stress-intensity')) problems.push('retired GPU intensity control is present');
    if (root.dataset.stressMode !== 'gpu') required.push('#stressPrimeDisplay', '#stressLatestPrime', '#stressWorkerSummary');
    if (Number(root.dataset.stressWorkerCount) > 0) required.push('#stressWorkerActivity', '#stressWorkerActivity > span');
    if (root.dataset.stressMode !== 'cpu' && root.dataset.stressGpuCanvasActive === 'true') required.push('#stressOrbit', '#stressGpuDetail');
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

async function main() {
  const root = path.resolve(__dirname, '..');
  const baseUrl = process.env.STRESS_CHECK_URL || 'http://127.0.0.1:4186';
  const server = await startLocalStaticServer({ url: baseUrl, cwd: root, skip: Boolean(process.env.STRESS_CHECK_URL) });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.STRESS_BROWSER_CHANNEL || undefined,
      args: process.env.STRESS_BROWSER_CHANNEL ? undefined : ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'] });
  } catch (error) {
    server?.kill();
    throw error;
  }
  const output = path.join(root, 'output/playwright');
  fs.mkdirSync(output, { recursive: true });
  const results = [];
  const cpuRuns = [];
  try {
    for (const backend of ['auto', 'webgl2', 'webgl1', 'none']) {
      const backendStarted = Date.now();
      console.log(`Stress backend: ${backend}`);
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.addInitScript((force) => {
        Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
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
        cpuRuns.push({ mode: 'cpu', ...await assertCpuPipeline(page) });
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
        assert.equal(await page.locator('#stressTestApp').getAttribute('data-stress-state'), 'running', await page.locator('#stressStatusText').textContent());
        const selected = await page.locator('#stressTestApp').getAttribute('data-stress-gpu-backend');
        assert.notEqual(selected, 'none');
        if (backend !== 'auto') assert.equal(selected, `${backend}-fragment`);
        await page.screenshot({ path: path.join(output, `stress-${backend}.png`) });
        await page.locator('#stressOrbit').focus();
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowUp');
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
        cpuRuns.push({ mode: 'both', ...await assertCpuPipeline(page) });
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
    console.log(JSON.stringify({ passed: true, cpuPipeline: cpuRuns, backends: results,
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
