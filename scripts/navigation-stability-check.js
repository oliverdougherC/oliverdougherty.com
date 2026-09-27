#!/usr/bin/env node

// Exercise real cross-page links without intercepting requests or waiting for
// networkidle. Intended for both local release checks and controlled remote
// investigations where a stalled optional request must remain observable.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { chromium, firefox, webkit } = require('playwright');
const path = require('node:path');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const PAGES = {
  home: { route: '/index.html', heading: '#home-intro-title' },
  resume: { route: '/pages/resume/index.html', heading: '#typeTargetName1' },
  gallery: { route: '/pages/gallery/index.html', heading: '.gallery-hero .calibrate-text' },
  utilities: { route: '/pages/utilities/index.html', heading: '#utilitiesHeading' }
};
const ORDER = ['resume', 'gallery', 'utilities', 'home'];
// A closed tour of the complete directed four-page graph. This visits each
// distinct cross-page link once before the repeated browsing loop.
const COVERING_TOUR = [
  'resume', 'home', 'gallery', 'home', 'utilities', 'resume',
  'gallery', 'resume', 'utilities', 'gallery', 'utilities', 'home'
];
const EXPECTED_EDGES = new Set(Object.keys(PAGES).flatMap(from =>
  Object.keys(PAGES).filter(to => to !== from).map(to => `${from}->${to}`)));
const CYCLES = Number(process.env.NAV_STABILITY_CYCLES || 6);
const TIMEOUT_MS = Number(process.env.NAV_STABILITY_TIMEOUT_MS || 20000);
// Per-transition wall-clock bound enforced in Node. page.setDefaultTimeout only
// supplies defaults to APIs that accept a timeout; a page.evaluate whose
// returned promise never settles (wedged animation frames or event loop) is
// otherwise unbounded and can keep the failure diagnosis from ever printing.
const DEADLINE_MS = Number(process.env.NAV_STABILITY_DEADLINE_MS || TIMEOUT_MS * 3);
const CLEANUP_MS = Number(process.env.NAV_STABILITY_CLEANUP_MS || 5000);
const TOTAL_MS = Number(process.env.NAV_STABILITY_TOTAL_MS || 240000);

// Rejects with a tagged error after `millis` of Node wall-clock time. The
// message reads `stage()` at fire time so it names the wait that was current.
function wallClockDeadline(millis, stage) {
  let rejectDeadline;
  const promise = new Promise((_resolve, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    const error = new Error(`wall-clock deadline of ${millis} ms exceeded during ${stage()}`);
    error.code = 'NAV_STABILITY_DEADLINE';
    rejectDeadline(error);
  }, millis);
  promise.cancel = () => clearTimeout(timer);
  return promise;
}

// Races a resource-closing promise against Node wall-clock time. Closing the
// page or browser is what rejects wedged page.evaluate promises, and a hung
// close must not keep the diagnostic process alive afterwards.
async function closeWithin(close, millis, label) {
  let timer;
  const promise = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), millis); });
  const outcome = await Promise.race([Promise.resolve().then(close).then(() => 'settled', error => ({ error })), promise]);
  clearTimeout(timer);
  if (outcome === 'timeout') console.error(`WARN: ${label} did not settle within ${millis} ms`);
  else if (outcome !== 'settled') console.error(`WARN: ${label} failed: ${outcome.error}`);
  return outcome === 'settled';
}

async function waitForNavigation(page, name) {
  const heading = PAGES[name].heading;
  await page.waitForFunction(({ heading, name }) => {
    const visible = (element) => {
      if (!element || !element.textContent.trim()) return false;
      for (let node = element; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.95) return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const current = document.querySelector(`.nav-inline-link--${name}[aria-current="page"]`);
    return visible(document.querySelector(heading)) && visible(current);
  }, { heading, name }, { timeout: TIMEOUT_MS });
  assert(await page.locator(`.nav-inline-link--${name}[aria-current="page"]`).count() === 1,
    `${name}: current navigation is missing`);
}

async function waitForPageContent(page, name, exerciseUtility) {
  if (name === 'home') {
    await page.waitForFunction(() => {
      const copy = document.querySelector('.home-intro-copy p');
      return copy && copy.textContent.trim().length > 40 && copy.getBoundingClientRect().height > 0;
    }, null, { timeout: TIMEOUT_MS });
    return;
  }
  if (name === 'resume') {
    await page.waitForFunction(() => {
      const education = document.querySelector('.education-card');
      return education && /Electrical and Computer Engineering/i.test(education.textContent) &&
        education.getBoundingClientRect().height > 0;
    }, null, { timeout: TIMEOUT_MS });
    return;
  }
  if (name === 'gallery') {
    const state = await page.waitForFunction(() => {
      const error = document.getElementById('galleryError');
      if (error && !error.hidden) return 'error';
      const loading = document.getElementById('galleryLoading');
      const archive = document.getElementById('galleryArchiveSection');
      const card = document.querySelector('#galleryArchiveGrid .photo-card');
      const button = card?.querySelector('.photo-card-button');
      const image = card?.querySelector('img');
      if (loading?.hidden && archive && !archive.hidden && button &&
          button.getBoundingClientRect().height > 0 && image?.complete && image.naturalWidth > 0) return 'ready';
      return null;
    }, null, { timeout: TIMEOUT_MS });
    assert.equal(await state.jsonValue(), 'ready', 'gallery: visible error state is not healthy content');
    return;
  }
  if (!exerciseUtility) {
    await page.waitForFunction(() => {
      const entry = document.querySelector('.utilities-buttons [data-utility="image-transform"]');
      return entry && entry.getBoundingClientRect().height > 0 &&
        document.getElementById('utilitiesTitleView')?.hidden === false;
    }, null, { timeout: TIMEOUT_MS });
    return;
  }
  // Open a lightweight controller and prove the workspace becomes usable.
  // Browser Back restores the index without adding a synthetic history entry.
  await page.locator('.utilities-buttons [data-utility="image-transform"]').click();
  await page.waitForFunction(() => location.hash === '#image-transform');
  const state = await page.waitForFunction(() => {
    const stage = document.querySelector('[data-utility-id="image-transform"]');
    const root = stage?.querySelector('[data-utility-root]');
    const recovery = document.getElementById('utilityEntryError');
    const globalRecovery = document.getElementById('utilityLoadRecovery');
    if (stage?.dataset.utilityReady === 'error' || (recovery && !recovery.hidden) ||
        (globalRecovery && !globalRecovery.hidden)) return 'error';
    if (stage?.dataset.utilityReady === 'ready' && stage.classList.contains('is-active') &&
        !stage.hidden && root && !root.hasAttribute('inert') &&
        document.getElementById('utilitiesUtilityView')?.hidden === false) return 'ready';
    return null;
  }, null, { timeout: TIMEOUT_MS });
  assert.equal(await state.jsonValue(), 'ready', 'utilities: recovery or stage error is not a ready controller');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => location.hash === '' && document.getElementById('utilitiesTitleView')?.hidden === false,
    null, { timeout: TIMEOUT_MS });
}

async function run() {
  assert(Number.isInteger(CYCLES) && CYCLES >= 5 && CYCLES <= 7, 'Use 5–7 repeated browsing cycles');
  assert(Number.isFinite(TIMEOUT_MS) && TIMEOUT_MS > 0, 'Timeout must be positive');
  assert(Number.isFinite(DEADLINE_MS) && DEADLINE_MS > 0, 'Deadline must be positive');
  assert(Number.isFinite(CLEANUP_MS) && CLEANUP_MS > 0, 'Cleanup bound must be positive');
  const requestedUrl = process.env.NAV_STABILITY_URL || 'http://127.0.0.1:4173';
  const server = await startLocalStaticServer({ url: requestedUrl, cwd: ROOT, skip: Boolean(process.env.NAV_STABILITY_URL) });
  const baseUrl = server?.url || requestedUrl.replace(/\/$/, '');
  let browserServer;
  let browser;
  let context;
  try {
    await waitForServer(baseUrl);
    const browserType = { chromium, firefox, webkit }[process.env.BROWSER || 'chromium'];
    assert(browserType, `Unknown browser: ${process.env.BROWSER}`);
    browserServer = await browserType.launchServer({ headless: true, timeout: TIMEOUT_MS });
    browser = await browserType.connect(browserServer.wsEndpoint(), { timeout: TIMEOUT_MS });
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.setDefaultNavigationTimeout(TIMEOUT_MS);
    const pending = new Map();
    const failures = [];
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)));
    page.on('request', request => pending.set(request, { url: request.url(), type: request.resourceType(), since: Date.now() }));
    page.on('requestfinished', request => pending.delete(request));
    page.on('requestfailed', request => {
      pending.delete(request);
      failures.push({ url: request.url(), type: request.resourceType(), error: request.failure()?.errorText });
    });
    const results = [];
    const visitedEdges = new Set();
    let current = 'home';

    async function record(action, target, navigate) {
      const started = Date.now();
      const from = current;
      let stage = 'navigate';
      let navigationAvailableMs = null;
      const guard = wallClockDeadline(DEADLINE_MS, () => stage);
      try {
        const navigation = await Promise.race([
          (async () => {
            await navigate();
            stage = 'navigation-available';
            await waitForNavigation(page, target);
            navigationAvailableMs = Date.now() - started;
            stage = `${target}-content`;
            await waitForPageContent(page, target, action === 'click' || action === 'open');
            const contentReadyMs = Date.now() - started;
            stage = 'animation-frame';
            // Two animation frames prove the destination keeps compositing
            // after its content becomes visible.
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            stage = 'event-loop';
            // A browser event-loop round trip proves the destination can respond
            // after its content becomes visible; no CPU/GPU utility is started.
            const responded = await page.evaluate(() => new Promise(resolve => setTimeout(() => resolve(true), 0)));
            assert(responded, `${target}: page event loop did not respond`);
            stage = 'navigation-timing';
            const timing = await page.evaluate(() => {
              const entry = performance.getEntriesByType('navigation')[0];
              return { readyState: document.readyState, domContentLoadedMs: entry?.domContentLoadedEventEnd,
                loadMs: entry?.loadEventEnd || null, responseStartMs: entry?.responseStart };
            });
            return { navigationAvailableMs, contentReadyMs, ...timing };
          })(),
          guard
        ]);
        const result = { action, from, to: target, usableMs: Date.now() - started, ...navigation };
        results.push(result);
        if (action === 'click') visitedEdges.add(`${from}->${target}`);
        current = target;
        console.log(JSON.stringify(result));
      } catch (error) {
        const outstanding = [...pending.values()].map(request => ({ ...request, pendingMs: Date.now() - request.since }));
        console.error(JSON.stringify({ action, from, to: target, url: page.url(), stage,
          navigationAvailableMs, elapsedMs: Date.now() - started, deadlineMs: DEADLINE_MS,
          error: String(error?.message ?? error), outstanding, recentFailures: failures.slice(-10),
          pageErrors: pageErrors.slice(-10) }, null, 2));
        if (error?.code === 'NAV_STABILITY_DEADLINE') {
          // Nothing inside the wedged page can end this wait; closing the page
          // is the Node-side action that rejects the outstanding evaluations.
          await closeWithin(() => page.close(), CLEANUP_MS, 'page close after deadline');
        }
        throw error;
      } finally {
        guard.cancel();
      }
    }

    await record('open', 'home', () => page.goto(`${baseUrl}${PAGES.home.route}`, { waitUntil: 'domcontentloaded' }));
    for (const target of COVERING_TOUR) {
      await record('click', target, async () => {
        await Promise.all([
          page.waitForURL(url => url.pathname === PAGES[target].route, { waitUntil: 'commit' }),
          page.locator(`.nav-inline-link--${target}`).click({ noWaitAfter: true })
        ]);
      });
    }
    for (let cycle = 0; cycle < CYCLES; cycle++) {
      for (const target of ORDER) {
        await record('click', target, async () => {
          await Promise.all([
            page.waitForURL(url => url.pathname === PAGES[target].route, { waitUntil: 'commit' }),
            page.locator(`.nav-inline-link--${target}`).click({ noWaitAfter: true })
          ]);
        });
      }
    }
    for (const [action, target] of [
      ['back', 'utilities'], ['back', 'gallery'], ['forward', 'utilities'], ['forward', 'home']
    ]) {
      await record(action, target, () => action === 'back'
        ? page.goBack({ waitUntil: 'domcontentloaded' })
        : page.goForward({ waitUntil: 'domcontentloaded' }));
    }
    assert.deepEqual(visitedEdges, EXPECTED_EDGES, 'Directed navigation coverage is incomplete');
    assert.equal(results.length, 1 + COVERING_TOUR.length + 4 * CYCLES + 4);
    assert.deepEqual(pageErrors, [], 'Uncaught page errors occurred during navigation');
    const origin = new URL(baseUrl).origin;
    const failedCriticalRequests = failures.filter(failure =>
      new URL(failure.url).origin === origin &&
      ['document', 'script', 'fetch', 'xhr'].includes(failure.type));
    assert.deepEqual(failedCriticalRequests, [], 'First-party document, script, or data requests failed');
    console.log(`PASS: ${results.length - 1} real-link/history transitions; directed edges ${[...visitedEdges].sort().join(', ')}; source ${baseUrl}`);
  } finally {
    let cleanupError;
    try {
      if (context && !await closeWithin(() => context.close(), CLEANUP_MS, 'context close')) {
        cleanupError = new Error('Navigation diagnostic context close exceeded its cleanup bound');
      }
      if (browser && !await closeWithin(() => browser.close(), CLEANUP_MS, 'browser close')) {
        cleanupError ||= new Error('Navigation diagnostic browser close exceeded its cleanup bound');
      }
      if (browserServer && !await closeWithin(() => browserServer.close(), CLEANUP_MS, 'browser server close')) {
        cleanupError ||= new Error('Navigation diagnostic browser server close exceeded its cleanup bound');
        try {
          // BrowserServer is the owner of this child process. Browser from
          // connect() has no process() API and must never be used for a kill.
          browserServer.process().kill('SIGKILL');
        } catch (error) {
          console.error(`ERROR: forced cleanup failed: ${error}`);
          cleanupError = new Error(`Forced cleanup of owned browser failed: ${error.message}`);
        }
      }
    } finally {
      if (server) server.kill();
    }
    if (cleanupError) throw cleanupError;
  }
}

// Playwright can hang before launchServer() returns an owned BrowserServer (for
// example during a damaged browser startup). Supervise the whole diagnostic in
// a child so even that pre-handle phase has a Node-side deadline. Capture only
// descendants of this child before terminating them; Playwright launches its
// browser in a separate process group on Unix.
function ownedProcesses(rootPid) {
  if (process.platform === 'win32') return [[rootPid, null, null]];
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000 })
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const owned = new Set([rootPid]);
  let previousSize = 0;
  while (owned.size !== previousSize) {
    previousSize = owned.size;
    for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid);
  }
  return rows.filter(([pid]) => owned.has(pid));
}

function stopOwnedProcesses(rows, signal) {
  if (process.platform === 'win32') {
    const pid = rows[0]?.[0];
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      console.error(`WARN: invalid owned process PID: ${pid}`);
      return;
    }
    try { execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', timeout: 2000 }); }
    catch (error) { if (error.status !== 128) console.error(`WARN: owned process cleanup failed: ${error}`); }
    return;
  }
  for (const [pid, , group] of [...rows].reverse()) {
    if (pid === group) {
      try { process.kill(-group, signal); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
    }
    try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') console.error(error); }
  }
}

async function supervise() {
  assert(Number.isFinite(TOTAL_MS) && TOTAL_MS > 0, 'Overall diagnostic bound must be positive');
  const child = spawn(process.execPath, [...process.execArgv, __filename], {
    cwd: ROOT, env: { ...process.env, NAV_STABILITY_WORKER: '1' }, stdio: 'inherit',
    detached: process.platform !== 'win32'
  });
  await new Promise((resolve, reject) => {
    let timedOut = false;
    let captured = [];
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`ERROR: navigation diagnostic exceeded its ${TOTAL_MS} ms overall deadline; terminating owned processes`);
      try { captured = ownedProcesses(child.pid); } catch (error) { console.error(`WARN: process inventory failed: ${error}`); captured = [[child.pid, null, null]]; }
      stopOwnedProcesses(captured, 'SIGTERM');
      forceTimer = setTimeout(() => stopOwnedProcesses(captured, 'SIGKILL'), 1000);
    }, TOTAL_MS);
    child.once('error', error => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      // Windows taskkill targets this PID alone; after close it may be reused.
      // Unix keeps the forced pass for captured descendants in other groups.
      if (!timedOut || process.platform === 'win32') clearTimeout(forceTimer);
      if (timedOut) {
        process.exitCode = 1;
      } else {
        process.exitCode = code === 0 ? 0 : (code || 1);
        if (signal) console.error(`ERROR: navigation diagnostic exited on ${signal}`);
      }
      resolve();
    });
  });
}

if (process.env.NAV_STABILITY_WORKER === '1') {
  run().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  supervise().catch(error => { console.error(error); process.exitCode = 1; });
}
