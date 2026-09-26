#!/usr/bin/env node

/**
 * Resume intro lifecycle check (issue #47).
 *
 * Leaves /pages/resume/ mid-intro at several elapsed times, returns via real
 * history.back(), and requires a persisted pageshow (actual BFCache hit)
 * followed by a fully perceivable hero, navigation, contact info, and
 * scroll-revealed body content. Repeated back/forward trips must keep the
 * restored document stable. Supplements: reduced motion, blocked
 * resume-typing.js, and synthetic persisted pagehide/pageshow pairs (the
 * fixture from the issue's verification boundary — real-pagehide only, no
 * actual BFCache) to pin the cancellation/recovery control flow. If the
 * engine never serves a persisted restore, that is reported honestly instead
 * of silently treating a fresh reload as a pass.
 */

const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
let baseUrl = process.env.RESUME_CHECK_URL || 'http://127.0.0.1:4173';
const RESUME_ROUTE = '/pages/resume/index.html';
const DEPART_ROUTE = '/404.html';

// Intro schedule owned by js/resume-typing.js: +300 name1, +600 name2,
// +1000 subtitle, +1400 revealPage (contact/meta/nav + scroll observers).
const EXIT_TIMES_MS = [100, 450, 800, 1200];
const SETTLE_BUDGET_MS = 4500;

const bfcache = { scenarioLogs: {}, exercised: false, unverified: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function log(message) {
  console.log(`[resume-lifecycle] ${message}`);
}

async function blockExternalFonts(page) {
  // Webfonts are cosmetic here; aborting them keeps the load event (and the
  // 100 ms exit) deterministic without a CDN round trip.
  await page.route('**://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('**://fonts.gstatic.com/**', (route) => route.abort());
}

async function instrumentPage(page) {
  await page.addInitScript(() => {
    window.__resumeCheck = {
      docId: `${Date.now()}-${Math.random()}`,
      t0: performance.now(),
      pageshow: [],
      pagehide: [],
      errors: []
    };
    const record = (list) => (event) => {
      window.__resumeCheck[list].push({
        persisted: Boolean(event.persisted),
        at: Math.round(performance.now() - window.__resumeCheck.t0)
      });
    };
    window.addEventListener('pageshow', record('pageshow'), true);
    window.addEventListener('pagehide', record('pagehide'), true);
    window.addEventListener('error', (event) => {
      if (event.message) window.__resumeCheck.errors.push(String(event.message));
    }, true);
  });
}

async function newInstrumentedPage(browser, options) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await blockExternalFonts(page);
  await instrumentPage(page);
  return { context, page };
}

function readState(page) {
  return page.evaluate(() => {
    const opacity = (selector) => {
      const el = document.querySelector(selector);
      return el ? Number(getComputedStyle(el).opacity) : null;
    };
    const masked = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const transform = getComputedStyle(el, '::after').transform;
      if (!transform || transform === 'none') return false;
      return Math.abs(new DOMMatrixReadOnly(transform).m11) > 0.05;
    };
    const box = (selector) => {
      const el = document.querySelector(selector);
      const rect = el?.getBoundingClientRect();
      return rect ? { w: rect.width, h: rect.height } : null;
    };
    return {
      docId: window.__resumeCheck?.docId ?? null,
      name1: document.getElementById('typeTargetName1')?.classList.contains('is-revealing') ?? false,
      name2: document.getElementById('typeTargetName2')?.classList.contains('is-revealing') ?? false,
      subtitle: document.getElementById('typeTargetSubtitle')?.classList.contains('is-revealing') ?? false,
      nameMasked: masked('#typeTargetName1'),
      subtitleMasked: masked('#typeTargetSubtitle'),
      contact: opacity('.hero-contact'),
      nav: opacity('[data-nav-actions]'),
      meta: opacity('.meta-tiny'),
      navChildren: [...(document.querySelector('[data-nav-actions]')?.children ?? [])].map((child) => {
        const rect = child.getBoundingClientRect();
        return { opacity: Number(getComputedStyle(child).opacity), w: rect.width, h: rect.height };
      }),
      metaBox: box('.meta-tiny'),
      metaText: (document.querySelector('.meta-tiny')?.innerText || '').replace(/\s+/g, ' ').trim(),
      contactBox: box('.hero-contact'),
      contactText: (document.querySelector('.hero-contact')?.innerText || '').replace(/\s+/g, ' ').trim(),
      sectionsVisible: [...document.querySelectorAll('.resume-section')]
        .filter((section) => Number(getComputedStyle(section).opacity) >= 0.99).length,
      sectionsTotal: document.querySelectorAll('.resume-section').length,
      pageshow: window.__resumeCheck ? window.__resumeCheck.pageshow.slice() : null,
      pagehide: window.__resumeCheck ? window.__resumeCheck.pagehide.slice() : null,
      errors: window.__resumeCheck ? window.__resumeCheck.errors.slice() : null
    };
  });
}

// The exact condition the issue demands after a restore: nothing essential
// remains concealed, measured on computed styles, not DOM presence.
function settledCondition() {
  const revealed = (id) => document.getElementById(id)?.classList.contains('is-revealing') === true;
  const opacity = (selector) => {
    const el = document.querySelector(selector);
    return el !== null && Number(getComputedStyle(el).opacity) >= 0.99;
  };
  const unmasked = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return false;
    const transform = getComputedStyle(el, '::after').transform;
    return !transform || transform === 'none' || Math.abs(new DOMMatrixReadOnly(transform).m11) <= 0.05;
  };
  return revealed('typeTargetName1') && revealed('typeTargetName2') && revealed('typeTargetSubtitle') &&
    unmasked('#typeTargetName1') && unmasked('#typeTargetSubtitle') &&
    opacity('.hero-contact') && opacity('[data-nav-actions]') && opacity('.meta-tiny');
}

async function waitForIntroSettled(page, label) {
  try {
    await page.waitForFunction(settledCondition, null, { timeout: SETTLE_BUDGET_MS });
  } catch {
    const state = await readState(page);
    throw new Error(
      `[${label}] intro never reached fully revealed state: ` +
      `name1=${state.name1} name2=${state.name2} subtitle=${state.subtitle} ` +
      `nameMasked=${state.nameMasked} contact=${state.contact} nav=${state.nav} meta=${state.meta} ` +
      `errors=${(state.errors ?? []).join('; ')}`
    );
  }
  return assertPerceptible(page, label);
}

async function assertPerceptible(page, label) {
  const state = await readState(page);
  // The reveal owned by resume-typing is opacity on [data-nav-actions]
  // itself plus its interactive children. Reduced-motion users get the
  // flashlight toggle removed by shared navigation (main.js), leaving the
  // fixed container empty; the real in-page nav (meta-tiny links) covers
  // perceivability there, so only measure children that exist.
  assert((state.errors ?? []).length === 0, `[${label}] page errors after restore: ${state.errors.join('; ')}`);
  assert(state.nav !== null && state.nav >= 0.99, `[${label}] nav-actions opacity ${state.nav}`);
  for (const child of state.navChildren) {
    assert(child.opacity > 0.9, `[${label}] nav action child opacity ${child.opacity}`);
    assert(child.w >= 16 && child.h >= 16, `[${label}] nav action child has no hit target: ${JSON.stringify(child)}`);
  }
  assert(state.contact !== null && state.contact >= 0.99, `[${label}] hero-contact opacity ${state.contact}`);
  assert(state.contactBox && state.contactBox.w > 0 && state.contactBox.h > 0, `[${label}] hero-contact has no layout box`);
  assert(state.contactText.includes('hi@oliverdougherty.com'),
    `[${label}] contact text not perceivable: "${state.contactText}"`);
  assert(state.meta !== null && state.meta >= 0.99, `[${label}] meta-tiny navigation opacity ${state.meta}`);
  assert(state.metaBox && state.metaBox.w > 0 && state.metaBox.h > 0, `[${label}] meta-tiny navigation has no layout box`);
  assert(/HOME/.test(state.metaText) && /R.SUM/i.test(state.metaText),
    `[${label}] in-page nav links not perceivable: "${state.metaText}"`);
  assert(state.name1 && state.name2 && state.subtitle,
    `[${label}] hero text not revealed: name1=${state.name1} name2=${state.name2} subtitle=${state.subtitle}`);
  assert(!state.nameMasked && !state.subtitleMasked,
    `[${label}] hero still covered by redaction mask: name=${state.nameMasked} subtitle=${state.subtitleMasked}`);
  return state;
}

// ~60px/frame ≈ 3600 px/s: every point of the document stays in view for
// many frames, so IO thresholds/negative rootMargin cannot be skipped the
// way an instant jump-to-bottom skips them.
async function sweepPage(page) {
  await page.evaluate(async () => {
    const bottom = () => document.body.scrollHeight - window.innerHeight;
    for (let y = 0; y <= bottom(); y += 60) {
      window.scrollTo(0, y);
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
    window.scrollTo(0, bottom());
    await new Promise((resolve) => window.setTimeout(resolve, 150));
  });
}

async function assertBodyContentReveals(page, label) {
  await sweepPage(page);
  await page.waitForFunction(
    () => [...document.querySelectorAll('.resume-section')]
      .every((section) => Number(getComputedStyle(section).opacity) >= 0.99),
    null,
    { timeout: 8000 }
  );
  // Scroll-reveal ownership covers the content column only; hero targets
  // (name/subtitle) belong to the intro sequence, asserted separately.
  // The reveal observer staggers is-revealing by up to 200 ms after
  // intersection, so wait on the condition instead of snapshotting.
  await page.waitForFunction(
    () => [...document.querySelectorAll('.resume-content .redact-target')]
      .every((target) => target.classList.contains('is-revealing')),
    null,
    { timeout: 4000 }
  );
  await page.evaluate(() => window.scrollTo(0, 0));
}

function assertPartialExit(state, exitMs, label) {
  // Prove the document was interrupted inside the intro window (revealPage
  // runs at 1400 ms) and at the expected step boundary.
  const expected = {
    100: { name1: false, name2: false, subtitle: false },
    450: { name1: true, name2: false, subtitle: false },
    800: { name1: true, name2: true, subtitle: false },
    1200: { name1: true, name2: true, subtitle: true }
  }[exitMs];
  for (const [key, value] of Object.entries(expected)) {
    assert(state[key] === value,
      `[${label}] expected ${key}=${value} when leaving at ${exitMs}ms, got ${state[key]} ` +
      `(name1=${state.name1} name2=${state.name2} subtitle=${state.subtitle})`);
  }
  assert((state.contact ?? 0) < 0.01 && (state.nav ?? 0) < 0.01,
    `[${label}] intro already completed before leaving at ${exitMs}ms (contact=${state.contact} nav=${state.nav})`);
}

async function navigateAwayAndBack(page, expectedShows) {
  const docIdBefore = await page.evaluate(() => window.__resumeCheck.docId);
  await page.goto(`${baseUrl}${DEPART_ROUTE}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(150);
  await page.evaluate(() => history.back());
  // Same-docId + growing pageshow log proves the original frozen document
  // came back instead of a fresh document replacing it.
  await page.waitForFunction(
    ([expected, docId]) => location.pathname.endsWith('/pages/resume/index.html') &&
      document.readyState === 'complete' &&
      window.__resumeCheck &&
      (window.__resumeCheck.docId !== docId || window.__resumeCheck.pageshow.length >= expected),
    [expectedShows, docIdBefore],
    { timeout: 10000 }
  );
  return { docIdBefore };
}

// Minimal cacheable control page: separates an automation/engine limitation
// from a site cacheability regression. Neither outcome counts as a pass.
async function probeCacheability(browser) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=600' });
    res.end('<!doctype html><title>Cache control</title><main>Cache control</main>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await browser.newContext();
    await context.addInitScript(() => {
      window.__cacheShows = [];
      window.addEventListener('pageshow', (event) => window.__cacheShows.push(event.persisted));
    });
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(`${url}/a`, { waitUntil: 'load' });
    await page.goto(`${url}/b`, { waitUntil: 'load' });
    await page.evaluate(() => history.back());
    await page.waitForFunction(
      () => location.pathname === '/a' && document.readyState === 'complete' && window.__cacheShows?.length > 0,
      null,
      { timeout: 10000 }
    );
    return (await page.evaluate(() => window.__cacheShows)).some(Boolean);
  } finally {
    await context?.close();
    server.closeAllConnections();
    server.close();
  }
}

async function tripAndVerify(browser, exitMs) {
  const label = `exit-${exitMs}ms`;
  const { context, page } = await newInstrumentedPage(browser, { reducedMotion: 'no-preference' });
  try {
    await page.goto(`${baseUrl}${RESUME_ROUTE}`, { waitUntil: 'load' });
    const elapsed = await page.evaluate(() => performance.now() - window.__resumeCheck.t0);
    if (elapsed < exitMs) await page.waitForTimeout(exitMs - elapsed);
    const leaving = await readState(page);
    assert(leaving.pageshow.length === 1 && leaving.pageshow[0].persisted === false,
      `[${label}] first load must log one non-persisted pageshow: ${JSON.stringify(leaving.pageshow)}`);
    assertPartialExit(leaving, exitMs, label);

    await navigateAwayAndBack(page, 2);
    const restored = await readState(page);
    const persistedShows = restored.pageshow.filter((entry) => entry.persisted).length;
    const wasRestored = restored.docId === leaving.docId && persistedShows >= 1;
    if (wasRestored) {
      bfcache.exercised = true;
    } else {
      // Honest recording, not a pass: a reload is a fresh document, so the
      // assertions below are fresh-load evidence only. run() reports the
      // BFCache status after a control probe distinguishes engine limits.
      log(`[${label}] trip reloaded instead of restoring ` +
        `(docId ${restored.docId === leaving.docId ? 'same' : 'changed'}, ` +
        `pageshow=${JSON.stringify(restored.pageshow)}); fresh-load assertions only.`);
    }

    // Interrupted state must not linger: wait past the intro's normal
    // completion window and require the full reveal.
    await waitForIntroSettled(page, label);
    await assertPerceptible(page, `${label} ${wasRestored ? 'restored' : 'reloaded'}`);
    await assertBodyContentReveals(page, label);

    if (wasRestored) {
      // Repeated back/forward on the same settled document.
      const settledBefore = await readState(page);
      await navigateAwayAndBack(page, 3);
      const afterSecondTrip = await readState(page);
      assert(afterSecondTrip.docId === leaving.docId, `[${label}] second trip reloaded the document`);
      assert(afterSecondTrip.pageshow.filter((entry) => entry.persisted).length >= 2,
        `[${label}] second trip never used BFCache: ${JSON.stringify(afterSecondTrip.pageshow)}`);
      await assertPerceptible(page, `${label} after second trip`);
      assert(afterSecondTrip.nav === settledBefore.nav && afterSecondTrip.contact === settledBefore.contact,
        `[${label}] repeated trips changed reveal opacity state`);
    }

    // Synthetic persisted pair on the settled document must be a no-op.
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await assertPerceptible(page, `${label} after synthetic pair`);

    bfcache.scenarioLogs[label] = restored.pageshow;
    return wasRestored ? persistedShows : 0;
  } finally {
    await context.close();
  }
}

async function runReducedMotion(browser) {
  const { context, page } = await newInstrumentedPage(browser, { reducedMotion: 'reduce' });
  try {
    await page.goto(`${baseUrl}${RESUME_ROUTE}`, { waitUntil: 'load' });
    await page.waitForFunction(settledCondition, null, { timeout: SETTLE_BUDGET_MS });
    await assertPerceptible(page, 'reduced-motion');
    await assertBodyContentReveals(page, 'reduced-motion');
    // A reduced-motion document left mid-restore path must also stay usable.
    await navigateAwayAndBack(page, 2);
    const restored = await readState(page);
    if (restored.pageshow.some((entry) => entry.persisted)) {
      await assertPerceptible(page, 'reduced-motion restored');
    } else {
      log('reduced-motion trip did not hit BFCache; relying on settled-state checks.');
    }
    log('Verified reduced-motion fresh reveal and restored-document stability.');
  } finally {
    await context.close();
  }
}

async function runScriptBlocked(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  try {
    await page.route('**/js/resume-typing.js*', (route) => route.abort());
    await blockExternalFonts(page);
    await page.goto(`${baseUrl}${RESUME_ROUTE}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.classList.contains('skip-page-animation'));
    const fallback = await readState(page);
    assert(!fallback.nameMasked && !fallback.subtitleMasked, 'Missing script leaves hero text covered');
    assert(fallback.contact >= 0.99 && fallback.nav >= 0.99 && fallback.meta >= 0.99,
      `Missing script leaves navigation or contact hidden: ${JSON.stringify({ contact: fallback.contact, nav: fallback.nav, meta: fallback.meta })}`);
    assert(fallback.contactBox?.w > 0 && fallback.contactBox?.h > 0 && fallback.metaBox?.w > 0,
      'Missing script fallback has no perceivable contact/navigation layout');
    // Shared main.js still owns scroll reveals for body content.
    await sweepPage(page);
    await page.waitForFunction(
      () => [...document.querySelectorAll('.resume-section')]
        .every((section) => Number(getComputedStyle(section).opacity) >= 0.99),
      null,
      { timeout: 8000 }
    );
    const linkCount = await page.locator('.resume-section a, .hero-contact a').count();
    assert(linkCount > 0, 'script-blocked page lost all interactive links');
    log('Verified hero, navigation, contact and body content with resume-typing.js unavailable.');
  } finally {
    await context.close();
  }
}

async function runNoJavaScript(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}${RESUME_ROUTE}`, { waitUntil: 'load' });
    const fallback = await readState(page);
    assert(!fallback.nameMasked && !fallback.subtitleMasked, 'No-JavaScript hero text remains covered');
    assert(fallback.contact >= 0.99 && fallback.nav >= 0.99 && fallback.meta >= 0.99,
      'No-JavaScript navigation or contact remains hidden');
    assert(fallback.sectionsVisible === fallback.sectionsTotal,
      'No-JavaScript résumé sections remain concealed');
    log('Verified the no-JavaScript résumé baseline.');
  } finally {
    await context.close();
  }
}

async function runSyntheticPair(browser) {
  // Deterministic supplement mirroring the issue's fixture: a persisted
  // pagehide/pageshow pair at 100 ms without any real navigation. This
  // verifies control flow only — it is NOT evidence of a BFCache hit.
  const { context, page } = await newInstrumentedPage(browser, { reducedMotion: 'no-preference' });
  try {
    await page.goto(`${baseUrl}${RESUME_ROUTE}`, { waitUntil: 'load' });
    const elapsed = await page.evaluate(() => performance.now() - window.__resumeCheck.t0);
    if (elapsed < 100) await page.waitForTimeout(100 - elapsed);
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    const frozen = await readState(page);
    await page.waitForTimeout(250);
    const stillFrozen = await readState(page);
    assert(stillFrozen.name1 === frozen.name1 && stillFrozen.name2 === frozen.name2,
      'intro advanced while suspended between synthetic persisted pagehide and pageshow');
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await waitForIntroSettled(page, 'synthetic-pair');
    await assertPerceptible(page, 'synthetic-pair');
    await assertBodyContentReveals(page, 'synthetic-pair');
    log('Verified synthetic persisted pagehide/pageshow recovery (control flow only).');
  } finally {
    await context.close();
  }
}

async function runLateStaggerSynthetic(browser) {
  const { context, page } = await newInstrumentedPage(browser, { reducedMotion: 'no-preference' });
  try {
    await page.goto(`${baseUrl}${RESUME_ROUTE}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.getElementById('typeTargetSubtitle')?.classList.contains('is-revealing'));
    await page.evaluate(() => new Promise((resolve) => {
      const contact = document.querySelector('.hero-contact');
      if (!contact.classList.contains('resume-hidden')) return resolve();
      const observer = new MutationObserver(() => {
        if (contact.classList.contains('resume-hidden')) return;
        observer.disconnect();
        resolve();
      });
      observer.observe(contact, { attributes: true, attributeFilter: ['class'] });
    }));
    const before = await readState(page);
    assert(before.nav < 0.99, 'Late-stagger fixture missed the pending navigation reveal');
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    const recovered = await readState(page);
    assert(recovered.contact >= 0.99 && recovered.nav >= 0.99,
      'Late-stagger lifecycle recovery did not reveal contact and navigation immediately');
    await waitForIntroSettled(page, 'late-stagger synthetic restoration');
    log('Verified a persisted suspension during the delayed contact/navigation reveal.');
  } finally {
    await context.close();
  }
}

async function runSuspendWithoutResume(browser) {
  // A persisted pagehide that never gets a pageshow (evicted from BFCache
  // later, or a script that swallows the event) must still converge to the
  // revealed state via the owned watchdog, not hide content forever.
  const { context, page } = await newInstrumentedPage(browser, { reducedMotion: 'no-preference' });
  try {
    await page.goto(`${baseUrl}${RESUME_ROUTE}`, { waitUntil: 'load' });
    const elapsed = await page.evaluate(() => performance.now() - window.__resumeCheck.t0);
    if (elapsed < 100) await page.waitForTimeout(100 - elapsed);
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    await waitForIntroSettled(page, 'suspend-without-resume');
    await assertPerceptible(page, 'suspend-without-resume');
    log('Verified watchdog reveals content after a resume never arrives.');
  } finally {
    await context.close();
  }
}

async function run() {
  const server = await startLocalStaticServer({
    url: baseUrl,
    cwd: ROOT,
    skip: Boolean(process.env.RESUME_CHECK_URL)
  });
  baseUrl = server?.url || baseUrl;
  let browser;
  try {
    await waitForServer(baseUrl);
    // Headless Chromium ships with --disable-back-forward-cache; drop it so
    // these trips exercise the real BFCache path (same as gallery-release-check).
    browser = await chromium.launch({
      channel: 'chromium',
      ignoreDefaultArgs: ['--disable-back-forward-cache']
    });

    for (const exitMs of EXIT_TIMES_MS) {
      let restored = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        restored = (await tripAndVerify(browser, exitMs)) > 0;
        if (restored) break;
        log(`BFCache not exercised at ${exitMs}ms on attempt ${attempt}; retrying the same exit point.`);
      }
      if (restored) {
        log(`Verified mid-intro exit at ${exitMs}ms: persisted restore, perceivable chrome, scroll reveals.`);
      } else {
        bfcache.unverified.push(exitMs);
        log(`UNVERIFIED BFCache at ${exitMs}ms: fresh-load content recovered, but no persisted restore occurred.`);
      }
    }

    await runReducedMotion(browser);
    await runSyntheticPair(browser);
    await runLateStaggerSynthetic(browser);
    await runSuspendWithoutResume(browser);
    await runScriptBlocked(browser);
    await runNoJavaScript(browser);

    if (!bfcache.exercised) {
      // Distinguish an engine/automation limitation from a site cacheability
      // regression. Neither outcome is a BFCache pass; say so honestly.
      const controlPersisted = await probeCacheability(browser);
      if (controlPersisted) {
        throw new Error('Resume page never restored from BFCache although a minimal control page did; treat this as a cacheability regression.');
      }
      throw new Error('BFCache restoration was not exercised (the minimal control page also reloaded); the content assertions above are only fresh-load evidence.');
    }
    log(`RESULT BFCache=exercised unverifiedExitMs=${JSON.stringify(bfcache.unverified)} scenarios=${JSON.stringify(bfcache.scenarioLogs)}`);
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(`Resume lifecycle check failed: ${error.message}`);
  process.exitCode = 1;
});
