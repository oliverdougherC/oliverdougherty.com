#!/usr/bin/env node

const path = require('node:path');
const { chromium } = require('playwright');
const {
  clearStoredTheme,
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
let baseUrl = process.env.GALLERY_CHECK_URL || DEFAULT_BASE_URL;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForGalleryReady(page, timeoutMs = 12000) {
  await page.waitForFunction(
    () => {
      const archiveCards = document.querySelectorAll('#galleryArchiveGrid .photo-card').length;
      const thumbs = document.querySelectorAll('#lightboxThumbStrip .lightbox-thumb').length;
      const loadingHidden = document.getElementById('galleryLoading')?.hidden === true;
      const heroImage = document.getElementById('galleryHeroImage');
      return Boolean(
        archiveCards > 0
        && thumbs > archiveCards
        && loadingHidden
        && heroImage?.getAttribute('src')
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
    hasNoise: Boolean(document.querySelector('.noise-overlay')),
    hasHeroFeature: Boolean(document.getElementById('galleryHeroFeature')),
    hasHeroStrip: Boolean(document.getElementById('galleryHeroStrip')),
    hasToolbar: Boolean(document.querySelector('.gallery-toolbar-section')),
    hasSearch: Boolean(document.getElementById('gallerySearch')),
    hasHeroTheme: Boolean(document.getElementById('galleryHeroTheme'))
  }));

  assert(state.theme === 'gallery', `[${label}] gallery theme attr missing`);
  assert(state.hasNavToggle, `[${label}] nav toggle missing`);
  assert(state.hasNavOverlay, `[${label}] nav overlay missing`);
  assert(state.hasNoise, `[${label}] noise overlay missing`);
  assert(state.hasFooter, `[${label}] gallery footer missing`);
  assert(state.hasHeroFeature, `[${label}] hero feature missing`);
  assert(!state.hasHeroStrip, `[${label}] legacy hero strip should not be present`);
  assert(!state.hasToolbar, `[${label}] category toolbar should not be present`);
  assert(!state.hasSearch, `[${label}] gallery search should not be present`);
  assert(!state.hasHeroTheme, `[${label}] hero category label should not be present`);

  assert(!state.hasSharedNav, `[${label}] legacy shared nav should not be present`);
  assert(state.colorMode === null, `[${label}] gallery disables shared color-mode state`);
}

async function assertDesktopFlow(page) {
  const initial = await page.evaluate(() => ({
    entryCount: document.querySelectorAll('#lightboxThumbStrip .lightbox-thumb').length,
    archiveCount: document.querySelectorAll('#galleryArchiveGrid .photo-card').length,
    heroImageSrc: document.getElementById('galleryHeroImage')?.getAttribute('src') || '',
    heroButtonEntryId: document.getElementById('galleryHeroOpen')?.dataset.entryId || '',
    prominentCount: document.querySelectorAll('#galleryArchiveGrid .photo-card--prominent').length,
    firstArchiveCard: {
      hasPlacard: Boolean(document.querySelector('#galleryArchiveGrid .photo-card .photo-placard')),
      hasNumber: Boolean(document.querySelector('#galleryArchiveGrid .photo-card .photo-placard-number')?.textContent?.trim()),
      hasTitle: Boolean(document.querySelector('#galleryArchiveGrid .photo-card .photo-placard-title')?.textContent?.trim()),
      hasLegacyCaption: Boolean(document.querySelector('#galleryArchiveGrid .photo-card .photo-caption')),
      hasLegacyTags: Boolean(document.querySelector('#galleryArchiveGrid .photo-card .photo-tags')),
      hasLegacyEyebrow: Boolean(document.querySelector('#galleryArchiveGrid .photo-card .photo-eyebrow')),
      hasLegacyMeta: Boolean(document.querySelector('#galleryArchiveGrid .photo-card .photo-meta'))
    },
    emptyCopy: document.getElementById('galleryEmptyCopy')?.textContent?.trim() || ''
  }));

  assert(initial.entryCount >= 20, `[desktop] expected full archive, got ${initial.entryCount}`);
  assert(initial.archiveCount === initial.entryCount - 1, `[desktop] archive grid should exclude the hero feature entry`);
  assert(Boolean(initial.heroImageSrc), '[desktop] hero feature image missing');
  assert(Boolean(initial.heroButtonEntryId), '[desktop] hero feature entry id missing');
  assert(initial.prominentCount > 0, '[desktop] archive grid should surface prominent cards');
  assert(initial.firstArchiveCard.hasPlacard, '[desktop] card placard missing');
  assert(initial.firstArchiveCard.hasNumber, '[desktop] card sequence number missing');
  assert(initial.firstArchiveCard.hasTitle, '[desktop] card title missing');
  assert(!initial.firstArchiveCard.hasLegacyCaption, '[desktop] legacy card description should not render');
  assert(!initial.firstArchiveCard.hasLegacyTags, '[desktop] legacy card tags should not render');
  assert(!initial.firstArchiveCard.hasLegacyEyebrow, '[desktop] category eyebrow should not render on cards');
  assert(!initial.firstArchiveCard.hasLegacyMeta, '[desktop] legacy compact meta should not render');
  assert(initial.emptyCopy.toLowerCase().includes('archive'), '[desktop] empty-state copy should refer to the archive');
  assert(!initial.emptyCopy.toLowerCase().includes('category'), '[desktop] empty-state copy should not refer to category filtering');

  await page.locator('#galleryHeroOpen').click({ position: { x: 10, y: 10 } });
  await page.waitForFunction(
    () => !document.getElementById('lightbox').hidden,
    null,
    { timeout: 3000 }
  );
  const lightboxState = await page.evaluate(() => ({
    active: !document.getElementById('lightbox').hidden,
    hash: window.location.hash,
    metaRows: document.querySelectorAll('#lightboxMeta .lightbox-meta-row').length,
    thumbCount: document.querySelectorAll('#lightboxThumbStrip .lightbox-thumb').length,
    title: document.getElementById('lightboxTitle')?.textContent?.trim() || '',
    metaTerms: [...document.querySelectorAll('#lightboxMeta .lightbox-meta-term')].map((node) => node.textContent?.trim() || '')
  }));
  assert(lightboxState.active, '[desktop] lightbox did not open');
  assert(lightboxState.hash.startsWith('#photo='), '[desktop] lightbox hash deep link missing');
  assert(lightboxState.metaRows >= 4, '[desktop] lightbox metadata panel incomplete');
  assert(lightboxState.thumbCount === initial.entryCount, '[desktop] lightbox thumbnail strip count mismatch');
  assert(Boolean(lightboxState.title), '[desktop] lightbox title missing');
  assert(!lightboxState.metaTerms.includes('Theme'), '[desktop] redundant theme metadata row should be omitted when it matches the category');
  assert(!lightboxState.metaTerms.includes('Category'), '[desktop] category metadata row should not be present');

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
    const placard = document.querySelector('#galleryArchiveGrid .photo-card .photo-placard');
    if (!placard) return null;
    const styles = getComputedStyle(placard);
    return {
      opacity: styles.opacity,
      hasTitle: Boolean(placard.querySelector('.photo-placard-title')?.textContent?.trim()),
      hasNumber: Boolean(placard.querySelector('.photo-placard-number')?.textContent?.trim()),
      hasLegacyCaption: Boolean(placard.querySelector('.photo-caption')),
      hasEyebrow: Boolean(placard.querySelector('.photo-eyebrow')),
      hasMeta: Boolean(placard.querySelector('.photo-meta')),
      hasToolbar: Boolean(document.querySelector('.gallery-toolbar-section'))
    };
  });
  assert(labelState && labelState.opacity !== '0', '[mobile] card labels should remain visible');
  assert(labelState.hasTitle, '[mobile] card title missing');
  assert(labelState.hasNumber, '[mobile] card sequence number missing');
  assert(!labelState.hasLegacyCaption, '[mobile] legacy card description should not render');
  assert(!labelState.hasEyebrow, '[mobile] category eyebrow should not render');
  assert(!labelState.hasMeta, '[mobile] legacy card meta should not render');
  assert(!labelState.hasToolbar, '[mobile] category toolbar should not be present');

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
    await page.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'networkidle' });
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
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(process.env.GALLERY_CHECK_URL) });
  baseUrl = server?.url || baseUrl;

  try {
    await waitForServer(baseUrl);
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
