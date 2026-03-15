#!/usr/bin/env node

const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
const BASE_URL = process.env.GALLERY_CHECK_URL || DEFAULT_BASE_URL;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isLocalBaseUrl(url) {
  return url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
}

function parsePortFromBaseUrl(url) {
  const match = url.match(/^http:\/\/[^:]+:(\d+)$/);
  return match ? Number(match[1]) : 4173;
}

async function waitForServer(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return;
    } catch (_error) {
      // Retry until timeout.
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  throw new Error(`Timed out waiting for local server at ${url}`);
}

function startLocalServerIfNeeded() {
  if (!isLocalBaseUrl(BASE_URL) || process.env.GALLERY_CHECK_URL) {
    return null;
  }

  const port = parsePortFromBaseUrl(BASE_URL);
  return spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore'
  });
}

async function clearStoredTheme(context) {
  await context.addInitScript(() => {
    try {
      window.localStorage.removeItem('od-color-mode');
    } catch (_error) {
      // Ignore storage access issues in automation contexts.
    }
  });
}

async function waitForGalleryReady(page, timeoutMs = 12000) {
  await page.waitForFunction(
    () => {
      const state = window.__galleryState;
      const archiveCards = document.querySelectorAll('#galleryArchiveGrid .photo-card').length;
      const featuredCards = document.querySelectorAll('#galleryFeaturedGrid .photo-card').length;
      const filters = document.querySelectorAll('#galleryFilterChips .gallery-filter-chip').length;
      const loadingHidden = document.getElementById('galleryLoading')?.hidden === true;
      return Boolean(
        state
        && typeof state.getEntries === 'function'
        && state.getEntries().length > 0
        && archiveCards > 0
        && featuredCards > 0
        && filters >= 3
        && loadingHidden
        && document.querySelector('[data-theme-toggle], .theme-toggle')
      );
    },
    null,
    { timeout: timeoutMs }
  );
}

async function assertSharedChrome(page, label) {
  const state = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute('data-theme'),
    colorMode: document.documentElement.getAttribute('data-color-mode'),
    hasSharedNav: Boolean(document.getElementById('nav')),
    hasNavToggle: Boolean(document.getElementById('navToggle')),
    hasNavOverlay: Boolean(document.getElementById('navOverlay')),
    hasThemeToggle: Boolean(document.querySelector('[data-theme-toggle], .theme-toggle')),
    hasNoise: Boolean(document.querySelector('.noise-overlay')),
    hasFooter: Boolean(document.querySelector('.gallery-footer.footer')),
    hasHeroFeature: Boolean(document.getElementById('galleryHeroFeature')),
    hasHeroCount: Boolean(document.getElementById('galleryHeroCount')),
    hasHeroRange: Boolean(document.getElementById('galleryHeroRange')),
    hasHeroThemes: Boolean(document.getElementById('galleryHeroThemes')),
    hasHeroQueue: Boolean(document.getElementById('galleryHeroQueue')),
    hasHeroStrip: Boolean(document.getElementById('galleryHeroStrip')),
    hasSearch: Boolean(document.getElementById('gallerySearch')),
    filterCount: document.querySelectorAll('#galleryFilterChips .gallery-filter-chip').length,
    heroTitle: document.getElementById('galleryHeroTitle')?.textContent?.trim() || '',
    heroTheme: document.getElementById('galleryHeroTheme')?.textContent?.trim() || ''
  }));

  assert(state.theme === 'gallery', `[${label}] gallery theme attr missing`);
  assert(state.colorMode === 'dark', `[${label}] expected default dark mode, got ${state.colorMode}`);
  assert(state.hasSharedNav, `[${label}] shared nav missing`);
  assert(state.hasNavToggle, `[${label}] nav toggle missing`);
  assert(state.hasNavOverlay, `[${label}] nav overlay missing`);
  assert(state.hasThemeToggle, `[${label}] theme toggle missing`);
  assert(state.hasNoise, `[${label}] noise overlay missing`);
  assert(state.hasFooter, `[${label}] gallery footer missing`);
  assert(state.hasHeroFeature, `[${label}] hero feature missing`);
  assert(state.hasHeroCount, `[${label}] hero count summary missing`);
  assert(state.hasHeroRange, `[${label}] hero range summary missing`);
  assert(state.hasHeroThemes, `[${label}] hero themes summary missing`);
  assert(state.hasHeroQueue, `[${label}] hero queue missing`);
  assert(!state.hasHeroStrip, `[${label}] legacy hero strip should not be present`);
  assert(state.hasSearch, `[${label}] gallery search missing`);
  assert(state.filterCount >= 3, `[${label}] expected at least 3 filter chips, got ${state.filterCount}`);
  assert(state.heroTitle && !state.heroTitle.includes('Loading'), `[${label}] hero title did not hydrate`);
  assert(!/^(A7RII|DSC0|IMG_)/.test(state.heroTitle), `[${label}] hero title still uses legacy filename metadata`);
  assert(Boolean(state.heroTheme), `[${label}] hero theme missing`);

  await page.click('[data-theme-toggle]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-mode') === 'light',
    null,
    { timeout: 3000 }
  );
  await page.click('[data-theme-toggle]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute('data-color-mode') === 'dark',
    null,
    { timeout: 3000 }
  );
}

async function assertDesktopFlow(page) {
  const initial = await page.evaluate(() => ({
    entryCount: window.__galleryState.getEntries().length,
    archiveCount: document.querySelectorAll('#galleryArchiveGrid .photo-card').length,
    featuredCount: document.querySelectorAll('#galleryFeaturedGrid .photo-card').length,
    heroTitle: document.getElementById('galleryHeroTitle')?.textContent?.trim() || '',
    heroQueueTitles: [...document.querySelectorAll('#galleryHeroQueue .hero-queue-title')].map((node) => node.textContent?.trim() || '')
  }));

  assert(initial.entryCount >= 20, `[desktop] expected full archive, got ${initial.entryCount}`);
  assert(initial.archiveCount === initial.entryCount, `[desktop] archive grid count mismatch`);
  assert(initial.featuredCount > 0, `[desktop] featured grid is empty`);
  assert(initial.heroTitle === 'Lighthouse', `[desktop] expected lighthouse lead hero, got ${initial.heroTitle || '(empty)'}`);
  assert(
    JSON.stringify(initial.heroQueueTitles) === JSON.stringify(['Caught', 'Ember M4', 'Yield']),
    `[desktop] hero queue order mismatch: ${initial.heroQueueTitles.join(', ')}`
  );

  await page.fill('#gallerySearch', '2025 wildlife');
  await page.waitForTimeout(220);
  const multiTerm = await page.evaluate(() => ({
    visibleCount: window.__galleryState.getVisibleEntries().length,
    categories: [...new Set(window.__galleryState.getVisibleEntries().map((entry) => entry.category))]
  }));
  assert(multiTerm.visibleCount > 0, '[desktop] multi-term search returned no results');
  assert(multiTerm.categories.length === 1 && multiTerm.categories[0] === 'WILDLIFE', '[desktop] multi-term search did not narrow to wildlife entries');

  await page.fill('#gallerySearch', '');
  await page.waitForTimeout(220);

  const landscapeChip = page.locator('#galleryFilterChips .gallery-filter-chip[data-filter="landscape"]');
  await landscapeChip.click();
  await page.waitForTimeout(180);
  const landscapeState = await page.evaluate(() => ({
    visibleCount: window.__galleryState.getVisibleEntries().length,
    categories: [...new Set(window.__galleryState.getVisibleEntries().map((entry) => entry.category))]
  }));
  assert(landscapeState.visibleCount > 0, '[desktop] landscape filter returned no results');
  assert(landscapeState.categories.length === 1 && landscapeState.categories[0] === 'LANDSCAPE', '[desktop] landscape filter returned mixed categories');

  await page.click('#galleryFilterChips .gallery-filter-chip[data-filter="featured"]');
  await page.waitForTimeout(180);
  const featuredOnly = await page.evaluate(() => ({
    visibleCount: window.__galleryState.getVisibleEntries().length,
    allFeatured: window.__galleryState.getVisibleEntries().every((entry) => entry.featured),
    archiveHidden: document.getElementById('galleryArchiveSection').hidden,
    featuredHidden: document.getElementById('galleryFeaturedSection').hidden
  }));
  assert(featuredOnly.visibleCount > 0, '[desktop] featured filter returned no results');
  assert(featuredOnly.allFeatured, '[desktop] featured filter returned non-featured entries');
  assert(featuredOnly.archiveHidden, '[desktop] archive section should hide during featured-only view');
  assert(!featuredOnly.featuredHidden, '[desktop] featured section should remain visible during featured-only view');

  await page.click('#galleryClearFilters');
  await page.waitForFunction(
    () => window.__galleryState.getFilter() === 'all' && window.__galleryState.getVisibleEntries().length === window.__galleryState.getEntries().length,
    null,
    { timeout: 3000 }
  );

  await page.fill('#gallerySearch', 'zzzz-no-match');
  await page.waitForTimeout(220);
  const noMatch = await page.evaluate(() => ({
    emptyVisible: !document.getElementById('galleryEmpty').hidden,
    archiveHidden: document.getElementById('galleryArchiveSection').hidden,
    featuredHidden: document.getElementById('galleryFeaturedSection').hidden
  }));
  assert(noMatch.emptyVisible, '[desktop] no-match state should be visible');
  assert(noMatch.archiveHidden && noMatch.featuredHidden, '[desktop] content sections should hide in no-match state');

  await page.click('#galleryEmptyReset');
  await page.waitForFunction(
    () => document.getElementById('galleryEmpty').hidden && window.__galleryState.getVisibleEntries().length === window.__galleryState.getEntries().length,
    null,
    { timeout: 3000 }
  );

  const firstCard = page.locator('#galleryFeaturedGrid .photo-card .photo-card-button').first();
  await firstCard.click();
  await page.waitForTimeout(180);
  const lightboxState = await page.evaluate(() => ({
    active: !document.getElementById('lightbox').hidden,
    hash: window.location.hash,
    metaRows: document.querySelectorAll('#lightboxMeta .lightbox-meta-row').length,
    thumbCount: document.querySelectorAll('#lightboxThumbStrip .lightbox-thumb').length,
    title: document.getElementById('lightboxTitle')?.textContent?.trim() || ''
  }));
  assert(lightboxState.active, '[desktop] lightbox did not open');
  assert(lightboxState.hash.startsWith('#photo='), '[desktop] lightbox hash deep link missing');
  assert(lightboxState.metaRows >= 5, '[desktop] lightbox metadata panel incomplete');
  assert(lightboxState.thumbCount === initial.entryCount, '[desktop] lightbox thumbnail strip count mismatch');
  assert(Boolean(lightboxState.title), '[desktop] lightbox title missing');

  const hashBeforeNext = lightboxState.hash;
  await page.click('#lightboxNext');
  await page.waitForTimeout(160);
  const nextHash = await page.evaluate(() => window.location.hash);
  assert(nextHash && nextHash !== hashBeforeNext, '[desktop] next navigation did not advance the lightbox hash');

  await page.click('#lightboxClose');
  await page.waitForFunction(
    () => document.getElementById('lightbox').hidden && window.location.hash === '',
    null,
    { timeout: 3000 }
  );
}

async function assertMobileFlow(page) {
  const labelState = await page.evaluate(() => {
    const info = document.querySelector('#galleryArchiveGrid .photo-card .photo-info');
    if (!info) return null;
    const styles = getComputedStyle(info);
    return {
      opacity: styles.opacity,
      hasTitle: Boolean(info.querySelector('.photo-title')?.textContent?.trim())
    };
  });
  assert(labelState && labelState.opacity !== '0', '[mobile] card labels should remain visible');
  assert(labelState.hasTitle, '[mobile] card title missing');

  await page.locator('#galleryArchiveGrid .photo-card .photo-card-button').first().click();
  await page.waitForTimeout(200);
  const panelState = await page.evaluate(() => ({
    infoToggleVisible: getComputedStyle(document.getElementById('lightboxInfoToggle')).display !== 'none',
    panelOpen: document.getElementById('lightboxPanel').classList.contains('is-open')
  }));
  assert(panelState.infoToggleVisible, '[mobile] lightbox details toggle should be visible');
  assert(!panelState.panelOpen, '[mobile] details panel should start collapsed');

  await page.click('#lightboxInfoToggle');
  await page.waitForTimeout(160);
  const expandedState = await page.evaluate(() => ({
    panelOpen: document.getElementById('lightboxPanel').classList.contains('is-open'),
    expanded: document.getElementById('lightboxInfoToggle').getAttribute('aria-expanded')
  }));
  assert(expandedState.panelOpen, '[mobile] details panel did not expand');
  assert(expandedState.expanded === 'true', '[mobile] details toggle aria-expanded not updated');

  await page.click('#lightboxClose');
  await page.waitForFunction(
    () => document.getElementById('lightbox').hidden,
    null,
    { timeout: 3000 }
  );
}

async function runScenario({ viewport, isMobile = false, hasTouch = false, label }) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport, isMobile, hasTouch });
    await clearStoredTheme(context);
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/pages/gallery/index.html`, { waitUntil: 'networkidle' });
    await waitForGalleryReady(page);
    await assertSharedChrome(page, label);

    if (label === 'desktop') {
      await assertDesktopFlow(page);
    } else {
      await assertMobileFlow(page);
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  const server = startLocalServerIfNeeded();

  try {
    await waitForServer(BASE_URL);
    await runScenario({
      label: 'desktop',
      viewport: { width: 1440, height: 1080 }
    });
    await runScenario({
      label: 'mobile',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    console.log('Gallery editorial checks passed.');
  } finally {
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('Gallery dropdown checks failed:', error.message);
  process.exit(1);
});
