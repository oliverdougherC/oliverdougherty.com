#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const sharp = require('sharp');
const { markAnimationsSeen, startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', 'home-check');
const BROWSERS = { chromium, firefox, webkit };
const requestedBrowsers = (process.env.HOME_CHECK_BROWSERS || 'chromium').split(',').map((name) => name.trim());
// The release gate runs the first-visit stage checks on every engine; the settled-page
// sweep stays Chromium-only there, so a stage-only pass skips the sweep, the fallback
// matrix and the interaction checks around the three stage checks.
const stageOnly = process.env.HOME_CHECK_STAGE_ONLY === '1';
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
  { width: 2560, height: 1440 },
  { width: 844, height: 390 }
];
let baseUrl = process.env.HOME_CHECK_URL || 'http://127.0.0.1:4173';

function validateBinaryText(text) {
  const rows = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  assert.equal(rows.length, 63, 'Nighthawks text should retain all 63 rows');
  const credits = new Map([[58, 'NIGHTHAWKS'], [60, 'EDWARD HOPPER, 1942']]);
  rows.forEach((row, index) => {
    assert.equal(row.length, 200, 'Artwork source must preserve its 200-column grid');
    const credit = credits.get(index);
    if (credit) {
      assert.equal(row.slice(3, 3 + credit.length), credit, 'Credit should replace cells at column 3');
      assert(/^[01]+$/.test(row.slice(0, 3) + row.slice(3 + credit.length)), 'Surrounding binary cells changed');
    } else {
      assert(/^[01]+$/.test(row), 'Uncredited rows should remain binary');
    }
  });
}

const PINNED_PROJECTS = [
  ['Encoding_Database', 'https://encodingdb.platinumlabs.dev/'],
  ['BetterVMAF', 'https://github.com/oliverdougherC/BetterVMAF'],
  ['Keiri', 'https://keiri.platinumlabs.dev/'],
  ['Lyra', 'https://github.com/oliverdougherC/Lyra']
];

const SOURCE_TEXT = fs.readFileSync(path.join(ROOT, 'assets/art/nighthawks-binary.txt'), 'utf8');
const normaliseGrid = (text) => text.replace(/\r\n/g, '\n').replace(/\n$/, '');
const isPaintingRequest = (url) => /\/nighthawks-(?:credited|binary)(?:-\d+)?\.(?:png|webp)(?:[?#]|$)/.test(url);

async function checkHome(page, route, label, { mode = 'text', noJavaScript = false, navigate = true } = {}) {
  if (navigate) await page.goto(`${baseUrl}${route}`, { waitUntil: 'load' });
  else await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // The introduction must be readable before the artwork renderer settles.
  assert(await page.locator('#home-intro-title').evaluate((title) => {
    for (let element = title; element; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.99) return false;
    }
    return title.getBoundingClientRect().height > 0;
  }), `${label}: introduction is hidden or delayed`);
  if (!noJavaScript) {
    await page.waitForFunction((expected) => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === expected, mode);
  }
  if (mode === 'fallback') {
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.nighthawks-fallback img, noscript img'))
      .some((image) => image.complete && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0));
  }
  const state = await page.evaluate(() => {
    const artwork = document.querySelector('#nighthawksArtwork');
    const pre = document.querySelector('#nighthawksCharacters');
    const hero = document.querySelector('.nighthawks-hero');
    const figure = document.querySelector('.nighthawks-figure');
    const title = document.querySelector('#home-intro-title');
    const rect = artwork?.getBoundingClientRect();
    const visible = (element) => {
      if (!element) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.99) return false;
      }
      return element.getBoundingClientRect().height > 0;
    };
    const nav = Array.from(document.querySelectorAll('.home-brand, .nav-inline-link, .mobile-nav-link'));
    const preStyle = pre && getComputedStyle(pre);
    const preRect = pre?.getBoundingClientRect();
    const toggle = document.querySelector('[data-flashlight-toggle]');
    const toggleRect = toggle?.getBoundingClientRect();
    const siblingLink = document.querySelector('.home-header .nav-inline-link');
    const siblingRect = siblingLink?.getBoundingClientRect();
    const copyButton = document.querySelector('[data-copy-email]');
    const copyButtonRect = copyButton?.getBoundingClientRect();
    const copyStatus = document.querySelector('[data-copy-status]');
    const copyStatusRect = copyStatus?.getBoundingClientRect();
    const textBounds = (start, end) => {
      if (!pre?.firstChild || pre.firstChild.nodeType !== Node.TEXT_NODE) return null;
      const range = document.createRange();
      range.setStart(pre.firstChild, start);
      range.setEnd(pre.firstChild, end);
      const box = range.getBoundingClientRect();
      return { left: box.left, top: box.top, width: box.width, height: box.height };
    };
    return {
      artworkWidth: rect?.width,
      artworkHeight: rect?.height,
      artworkLeft: rect?.left,
      artworkRight: rect?.right,
      label: artwork?.getAttribute('aria-label'),
      role: artwork?.getAttribute('role'),
      backdrop: hero && getComputedStyle(hero).backgroundColor,
      figureWidth: figure?.getBoundingClientRect().width,
      figureHeight: figure?.getBoundingClientRect().height,
      overlayCount: document.querySelectorAll('.nighthawks-credit, .credit-line').length,
      introTitle: title?.textContent.trim(),
      headings: Array.from(document.querySelectorAll('h1')).map((heading) => ({
        text: heading.textContent.trim(), hidden: heading.getAttribute('aria-hidden')
      })),
      obsolete: document.querySelectorAll('.particle-canvas, .diamond-divider, .blueprint-title').length,
      width: innerWidth,
      height: innerHeight,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1,
      preCount: document.querySelectorAll('#nighthawksArtwork pre').length,
      preChildren: pre?.childElementCount,
      grid: pre?.textContent,
      preHiddenFromAT: pre?.getAttribute('aria-hidden'),
      preVisible: visible(pre),
      preWidth: preRect?.width,
      preHeight: preRect?.height,
      firstRow: textBounds(0, 200),
      firstGlyph: textBounds(0, 1),
      creditBounds: [[58, 9], [60, 18]].map(([row, length]) => ({ row, length, box: textBounds(row * 201 + 3, row * 201 + 3 + length) })),
      clip: preStyle?.backgroundClip || preStyle?.webkitBackgroundClip,
      background: preStyle?.backgroundImage,
      loadedFonts: Array.from(document.fonts).filter((font) => font.status === 'loaded').map((font) => font.family.replace(/["']/g, '')),
      fontFamily: preStyle?.fontFamily.replace(/["']/g, '').split(',')[0].trim(),
      fallbacks: Array.from(document.querySelectorAll('.nighthawks-fallback img, noscript img')).filter(visible).map((image) => ({
        loaded: image.complete && image.naturalWidth > 0, source: image.currentSrc, fit: getComputedStyle(image).objectFit
      })),
      darkToggle: toggle && {
        visible: visible(toggle), inNav: Boolean(toggle.closest('.home-header')),
        label: toggle.getAttribute('aria-label'), themeIconCount: toggle.querySelectorAll('.theme-toggle-icon').length,
        text: toggle.innerText, iconCount: toggle.querySelectorAll('svg').length,
        left: toggleRect.left, right: toggleRect.right, centerY: toggleRect.top + toggleRect.height / 2,
        siblingCenterY: siblingRect && siblingRect.top + siblingRect.height / 2
      },
      headerBackground: getComputedStyle(document.querySelector('.home-header')).backgroundColor,
      desktop: document.body.classList.contains('page-home'),
      artTopPadding: figure.getBoundingClientRect().top - hero.getBoundingClientRect().top,
      artBottomPadding: hero.getBoundingClientRect().bottom - figure.getBoundingClientRect().bottom,
      headerPosition: getComputedStyle(document.querySelector('.home-header')).position,
      profileFacts: document.querySelectorAll('.about-stats, .mobile-stat-grid').length,
      projects: Array.from(document.querySelectorAll('article[data-project]')).map((project) => ({
        name: project.dataset.project,
        headingCount: project.querySelectorAll('h3').length,
        blurbCount: project.querySelectorAll('.project-copy > p.project-blurb').length,
        hookCount: project.querySelectorAll('.project-copy > p.project-hook').length,
        copyVisible: visible(project.querySelector('.project-copy')),
        heading: (() => { const element = project.querySelector('h3'); const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, fontSize: parseFloat(getComputedStyle(element).fontSize) }; })(),
        copy: (() => { const r = project.querySelector('.project-copy').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top }; })(),
        stacked: getComputedStyle(project).gridTemplateColumns.split(' ').length === 1,
        links: Array.from(project.querySelectorAll('a')).map((link) => ({ href: link.href, isProjectLink: link.classList.contains('project-link') })),
        retiredCount: project.querySelectorAll('details,img,svg,canvas,button,input,label,.project-art,.motion-stage').length
      })),
      contactHeading: document.querySelector('.home-contact h2')?.textContent.trim(),
      contactAddress: document.querySelector('.home-contact a[href^="mailto:"]')?.getAttribute('href'),
      copyButton: copyButtonRect && { left: copyButtonRect.left, bottom: copyButtonRect.bottom },
      copyStatus: copyStatusRect && { left: copyStatusRect.left, top: copyStatusRect.top },
      nav: nav.map((link) => {
        const box = link.getBoundingClientRect();
        return { text: link.textContent.trim(), visible: visible(link), left: box.left, right: box.right,
          top: box.top, bottom: box.bottom, fontSize: parseFloat(getComputedStyle(link).fontSize) };
      })
    };
  });
  assert(Math.abs(state.artworkWidth / state.artworkHeight - 6000 / 3274) < 0.01, `${label}: artwork is distorted`);
  assert.equal(state.backdrop, 'rgb(0, 0, 0)', `${label}: artwork needs a black backdrop`);
  assert(state.figureWidth <= 1881, `${label}: artwork exceeds its desktop size cap`);
  assert(state.artworkWidth >= Math.min(state.width * 0.7, state.height * 0.8, 600), `${label}: artwork is too small`);
  assert(state.artworkLeft >= -1 && state.artworkRight <= state.width + 1, `${label}: artwork leaves the viewport`);
  assert(state.label && /Nighthawks/i.test(state.label), `${label}: artwork needs descriptive alternative text`);
  assert.equal(state.role, 'img', `${label}: artwork needs a single accessible image role`);
  assert.equal(state.introTitle, 'hi.', `${label}: introduction heading missing`);
  assert.equal(state.headings.length, 1, `${label}: expected one accessible page heading`);
  assert.equal(state.headings[0].text, 'Oliver Dougherty', `${label}: accessible name missing`);
  assert.notEqual(state.headings[0].hidden, 'true', `${label}: name is hidden from assistive technology`);
  assert.equal(state.obsolete, 0, `${label}: retired hero markup remains`);
  assert(!state.overflow, `${label}: horizontal page overflow`);
  if (state.darkToggle?.visible) {
    assert(state.darkToggle.inNav, `${label}: dark-mode action escaped navigation`);
    assert(/blackout/i.test(state.darkToggle.label), `${label}: moon control needs an accessible label`);
    assert.equal(state.darkToggle.themeIconCount, 1, `${label}: original moon control missing`);
    assert(state.darkToggle.left >= 0 && state.darkToggle.right <= state.width + 1, `${label}: dark-mode action is clipped`);

  }
  assert.equal(state.headerPosition, 'sticky', `${label}: homepage navigation should remain available while scrolling`);
  if (state.desktop) {
    assert.equal(state.headerBackground, 'rgb(255, 255, 255)', `${label}: original navigation should be white`);
    assert(Math.abs(state.artTopPadding - state.artBottomPadding) < 1, `${label}: artwork needs balanced vertical padding`);
  }
  assert.equal(state.profileFacts, 0, `${label}: removed profile-stat boxes remain`);
  assert.deepEqual(state.projects.map((project) => project.name), PINNED_PROJECTS.map(([name]) => name), `${label}: project order differs from pinned repositories`);
  state.projects.forEach((project, index) => {
    assert.equal(project.headingCount, 1, `${label}: ${project.name} should have one title`);
    if (state.width > 700) assert.equal(project.heading.fontSize, 50, `${label}: ${project.name} title should be 50px`);
    else assert(project.heading.fontSize <= 40, `${label}: ${project.name} mobile title should remain compact`);
    assert(project.blurbCount >= 1, `${label}: ${project.name} should have project prose`);
    assert.deepEqual(project.links, [{ href: PINNED_PROJECTS[index][1], isProjectLink: true }], `${label}: ${project.name} should have one project link to its destination`);
    assert.equal(project.hookCount, 1, `${label}: ${project.name} should have one hook`);
    assert(project.copyVisible, `${label}: ${project.name} prose is hidden`);
    assert.equal(project.retiredCount, 0, `${label}: ${project.name} retains project artwork or controls`);
    if (project.stacked) {
      assert(project.copy.top >= project.heading.bottom, `${label}: ${project.name} text overlaps its title`);
    } else {
      assert(project.copy.left > project.heading.right, `${label}: ${project.name} columns overlap`);
    }
    assert(project.heading.left >= 0 && project.copy.right <= state.width + 1, `${label}: ${project.name} text is clipped`);
  });
  assert.equal(state.contactHeading, 'say hi back.', `${label}: contact heading missing`);
  assert.equal(state.contactAddress, 'mailto:hi@oliverdougherty.com', `${label}: contact email link missing`);
  assert(state.copyButton && state.copyStatus, `${label}: copy feedback geometry missing`);
  assert(Math.abs(state.copyStatus.left - state.copyButton.left) <= 1, `${label}: copy feedback should align with copy button`);
  assert(state.copyStatus.top >= state.copyButton.bottom, `${label}: copy feedback should sit below copy button`);
  assert(state.nav.length >= 3, `${label}: navigation missing`);
  for (const link of state.nav) {
    assert(link.visible && link.left >= -1 && link.right <= state.width + 1 && link.top >= -1 && link.bottom <= state.height,
      `${label}: navigation ${link.text} is clipped or hidden`);
    assert(link.fontSize >= 10, `${label}: navigation ${link.text} is too small`);
  }
  assert.equal(await page.locator('.nighthawks-figure a[download]').count(), 0, `${label}: detached download label remains`);
  assert(Math.abs(state.figureHeight - state.artworkHeight) < 1, `${label}: credit must not create a caption strip`);
  assert.equal(state.overlayCount, 0, `${label}: credits must be rendered glyph cells, not a text overlay`);
  assert.equal(state.preCount, 1, `${label}: artwork should use one pre element`);
  assert.equal(state.preChildren, 0, `${label}: artwork should not create per-character elements`);
  assert.equal(normaliseGrid(state.grid), normaliseGrid(SOURCE_TEXT), `${label}: rendered characters diverge from credited source grid`);
  assert.equal(state.preHiddenFromAT, 'true', `${label}: screen readers should receive the image description, not 12,600 characters`);
  if (mode === 'text') {
    assert(state.preVisible, `${label}: character artwork is hidden`);
    assert.equal(state.clip, 'text', `${label}: color map must fill the text glyphs`);
    assert(state.background.includes('nighthawks-colors.png'), `${label}: character color map missing`);
    assert(state.loadedFonts.includes(state.fontFamily), `${label}: text was shown before its font loaded`);
    assert(Math.abs(state.preWidth - state.artworkWidth) <= 2 && Math.abs(state.preHeight - state.artworkHeight) <= 2,
      `${label}: character grid does not fit the artwork after sizing`);
    assert(state.firstRow && Math.abs(state.firstRow.width - state.artworkWidth) <= 2,
      `${label}: actual 200-glyph row width ${state.firstRow?.width}px differs from artwork ${state.artworkWidth}px`);
    for (const { row, length, box } of state.creditBounds) {
      const cellWidth = state.artworkWidth / 200;
      assert(box && Math.abs(box.left - state.artworkLeft - 3 * cellWidth) <= 2,
        `${label}: credit row ${row} starts outside column 3`);
      assert(Math.abs(box.width - length * cellWidth) <= 2,
        `${label}: credit row ${row} glyph width ${box.width}px differs from color-cell width ${length * cellWidth}px`);
      assert(Math.abs(box.top - state.firstGlyph.top - row * state.artworkHeight / 63) <= 2,
        `${label}: credit row ${row} offset ${box.top - state.firstGlyph.top}px differs from color-map offset ${row * state.artworkHeight / 63}px`);
    }
    assert.equal(state.fallbacks.length, 0, `${label}: raster fallback is visible during text rendering`);
  } else {
    assert(state.fallbacks.some((image) => image.loaded && image.source.includes('nighthawks-credited') && image.fit === 'contain'),
      `${label}: credited, uncropped raster fallback missing`);
    assert(!state.preVisible, `${label}: unrendered characters appear over the fallback`);
  }
}

async function checkRetainedInteractions(page) {
  const toggle = page.locator('[data-flashlight-toggle]');
  const initialLabel = await toggle.getAttribute('aria-label');
  assert(initialLabel?.trim(), 'Dark-mode toggle needs an accessible name');
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'Dark-mode toggle should begin inactive');
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[data-flashlight-toggle]')?.getAttribute('aria-pressed') === 'true');
  assert.notEqual(await toggle.getAttribute('aria-label'), initialLabel, 'Dark-mode accessible action did not update');
  assert(await page.locator('body').evaluate((body) => body.classList.contains('flashlight-mode-active')),
    'Homepage blackout toggle did not activate');
  await toggle.click();
  await page.waitForFunction(() => !document.body.classList.contains('flashlight-mode-active'));
  assert.equal(await toggle.getAttribute('aria-label'), initialLabel, 'Dark-mode accessible action did not reset');
  const osu = page.locator('.stat-value').filter({ has: page.locator('.osu-text') });
  const canvasesBefore = await page.locator('canvas').count();
  await osu.hover();
  assert(await page.locator('canvas').count() > canvasesBefore, 'OSU hover did not produce its confetti');
}

async function checkCohesionInteractions(browser, name, touch) {
  for (const route of ['/index.html?full=1', '/mobile/']) {
    const context = await browser.newContext({ viewport: touch ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: touch, isMobile: touch });
    await markAnimationsSeen(context);
    const page = await context.newPage();
    const label = `${name}-${touch ? 'touch' : 'keyboard'}-${route}`;
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'load' });
    const activate = async (locator) => {
      if (touch) await locator.tap();
      else { await locator.focus(); await locator.press('Enter'); }
    };
    assert.equal(await page.locator('[data-binary-hello]').count(), 0, `${label}: retired binary greeting remains`);
    const copy = page.locator('[data-copy-email]');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.__copiedAddress = text; }
    } }));
    await activate(copy);
    await page.waitForFunction(() => document.querySelector('[data-copy-status]').textContent.includes('copied! your move, stranger...'));
    assert.equal(await page.evaluate(() => window.__copiedAddress), 'hi@oliverdougherty.com', `${label}: wrong address copied`);
    assert.equal(await page.locator('[data-copy-status]').getAttribute('role'), 'status', `${label}: clipboard outcome is not announced`);
    assert.equal(await page.locator('.copy-status-emphasis').evaluate((element) => getComputedStyle(element).color), 'rgb(255, 103, 0)', `${label}: stranger emphasis color missing`);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard denied for test'); }; });
    await activate(copy);
    await page.waitForFunction(() => document.querySelector('[data-copy-status]').textContent.includes('Select the address'));
    assert(await page.locator('.contact-address').isVisible(), `${label}: manual-copy address unavailable after clipboard failure`);
    const sticky = await page.locator('.home-header').boundingBox();
    assert(sticky && Math.abs(sticky.y) < 1, `${label}: header did not stay at top while contact is in view`);
    const osu = page.locator('button.osu-trigger');
    await activate(osu);
    assert.equal(await osu.getAttribute('aria-pressed'), 'true', `${label}: OSU cheer state is not announced`);
    assert(await osu.evaluate((button) => button.classList.contains('is-cheered')), `${label}: OSU button does not reveal its cheer`);
    await activate(osu);
    assert.equal(await osu.getAttribute('aria-pressed'), 'false', `${label}: OSU cheer did not reset`);
    assert(await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) <= innerWidth + 1),
      `${label}: expanded/interacted homepage overflows horizontally`);
    await context.close();
  }
}

async function checkArtworkBeforeWindowLoad(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  let releaseScript;
  const heldScript = new Promise((resolve) => { releaseScript = resolve; });
  await context.route('**/js/main.js*', async (route) => {
    await heldScript;
    await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === 'text');
    const state = await page.evaluate(() => ({
      readyState: document.readyState,
      firstVisibleArtworkMs: performance.now(),
      loadMs: performance.getEntriesByType('navigation')[0]?.loadEventEnd || null
    }));
    assert.notEqual(state.readyState, 'complete', `${name}: artwork waited for unrelated deferred script`);
    assert.equal(state.loadMs, null, `${name}: artwork appeared only after window load`);
    console.log(`${name}: artwork visible at ${state.firstVisibleArtworkMs.toFixed(0)} ms while document load was pending.`);
  } finally {
    releaseScript();
    await context.close();
  }
}

async function checkVisibleBaselineWhileFontWaits(browser, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let releaseFont;
  const heldFont = new Promise((resolve) => { releaseFont = resolve; });
  await context.route('**/assets/fonts/nighthawks-mono-bold.ttf', async (route) => {
    await heldFont;
    await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'commit' });
    await page.waitForFunction(() => {
      const artwork = document.querySelector('#nighthawksArtwork');
      const image = artwork?.querySelector('.nighthawks-fallback img');
      return artwork?.dataset.renderMode === 'fallback' && image?.complete && image.naturalWidth > 0
        && image.getBoundingClientRect().width > 0;
    });
    const baselineMs = await page.evaluate(() => performance.now());
    releaseFont();
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === 'text');
    console.log(`${name}: fallback visible at ${baselineMs.toFixed(0)} ms while artwork font was pending.`);
  } finally {
    releaseFont();
    await context.close();
  }
}

/**
 * Cold visit: the painting owns a viewport of black on its own, the navigation
 * stays parked until the first deliberate scroll, and a second visit in the same
 * session renders the settled page with no entrance at all.
 */
async function checkFirstVisitStage(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const label = `${name}-first-visit-stage`;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const perceptibleInPage = (element) => {
    for (let node = element; node instanceof Element; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.99) return false;
    }
    return element.getBoundingClientRect().height > 0;
  };
  try {
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === 'text');
    assert(await page.evaluate(() => {
      const root = document.documentElement;
      return root.classList.contains('home-stage')
        && !root.classList.contains('skip-page-animation')
        && JSON.parse(window.sessionStorage.getItem('od-page-animations-seen') || '{}').home === true;
    }), `${label}: the cold visit did not arm the stage`);

    const stage = await page.evaluate(() => {
      const perceptible = (element) => {
        for (let node = element; node instanceof Element; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.99) return false;
        }
        return element.getBoundingClientRect().height > 0;
      };
      const header = document.querySelector('.home-header');
      const hero = document.querySelector('.nighthawks-hero').getBoundingClientRect();
      const artwork = document.querySelector('#nighthawksArtwork').getBoundingClientRect();
      return {
        canvas: getComputedStyle(document.body).backgroundColor,
        viewportHeight: innerHeight,
        heroTop: hero.top,
        heroHeight: hero.height,
        artworkHeight: artwork.height,
        centreOffset: Math.abs(artwork.top + artwork.height / 2 - innerHeight / 2),
        headerPosition: getComputedStyle(header).position,
        headerShown: perceptible(header),
        navShown: Array.from(document.querySelectorAll('.nav-inline-link')).some(perceptible),
        entrance: getComputedStyle(document.querySelector('.nighthawks-figure')).animationName,
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1
      };
    });
    assert(stage.canvas === 'rgb(0, 0, 0)', `${label}: the stage canvas is not black`);
    assert(stage.heroTop <= 0.5 && stage.heroHeight >= stage.viewportHeight - 1, `${label}: the stage does not fill the viewport`);
    assert(stage.centreOffset <= 1, `${label}: the painting is not vertically centred`);
    assert(stage.artworkHeight <= stage.viewportHeight * 0.85, `${label}: the painting crowds the surrounding black`);
    assert(stage.headerPosition === 'fixed', `${label}: the parked navigation should leave the flow`);
    assert(!stage.headerShown && !stage.navShown, `${label}: navigation is visible on the stage`);
    assert(stage.entrance === 'paintingEmerge', `${label}: the painting has no first-visit entrance`);
    assert(!stage.overflow, `${label}: the stage overflows horizontally`);

    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState === 'finished'),
      null, { timeout: 8000 });
    assert(await page.locator('#nighthawksCharacters').evaluate(perceptibleInPage),
      `${label}: the entrance leaves the painting faded`);

    await page.evaluate(() => window.scrollTo(0, Math.round(window.innerHeight * 0.45)));
    await page.waitForFunction(() => {
      const header = document.querySelector('.home-header');
      if (!document.documentElement.classList.contains('home-nav-revealed')) return false;
      for (let node = header; node instanceof Element; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || Number(style.opacity) < 0.99) return false;
      }
      return Math.abs(header.getBoundingClientRect().top) < 0.5;
    }, null, { timeout: 5000 });
    assert(await page.locator('.nav-inline-link--resume').evaluate(perceptibleInPage),
      `${label}: navigation stays hidden after the first scroll`);
    await page.locator('.nav-inline-link--resume').click({ trial: true });
    // The action cluster exists only while the flashlight mode is available
    // (hover + fine pointer, no forced colours or reduced motion); main.js
    // removes the toggle by design in environments without it, so its absence is
    // legitimate here. Where it is present, assert it is operable: visible,
    // receiving pointer events, and topmost at its own centre.
    const toggleOperable = await page.evaluate(() => {
      const button = document.querySelector('[data-flashlight-toggle]');
      if (!button) return null;
      const style = getComputedStyle(button);
      if (style.visibility === 'hidden' || Number(style.opacity) < 0.99 || style.pointerEvents === 'none') return false;
      const box = button.getBoundingClientRect();
      if (box.width < 8 || box.height < 8) return false;
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      if (cx < 0 || cx > innerWidth || cy < 0 || cy > innerHeight) return false;
      const hit = document.elementFromPoint(cx, cy);
      return hit === button || button.contains(hit);
    });
    assert(toggleOperable !== false, `${label}: the revealed action cluster is not operable`);

    // Let the jump land on a rendered frame before handing the page back: two
    // same-frame teleports coalesce into one scroll event, and the bootstrap would never
    // see the stage leave sight. A real device renders the jumped-to position first.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }));
    await page.waitForFunction(() => document.documentElement.classList.contains('home-stage-collapsed'),
      null, { timeout: 5000 });
    await page.waitForFunction(() => Math.abs(document.querySelector('.home-header').getBoundingClientRect().top) < 0.5,
      null, { timeout: 5000 });
    // The bottom overscroll is the contact section's black in every session state.
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)',
      null, { timeout: 5000 });

    await page.evaluate(() => window.scrollTo(0, 0));
    // The reveal is a one-way latch: returning to the top must leave the bar in place,
    // opaque and flush with the top edge, riding the settled layout.
    await page.waitForFunction(() => {
      const header = document.querySelector('.home-header');
      const style = getComputedStyle(header);
      return document.documentElement.classList.contains('home-nav-revealed')
        && style.visibility === 'visible' && Number(style.opacity) > 0.999
        && Math.abs(header.getBoundingClientRect().top) < 0.5;
    }, null, { timeout: 5000 });
    assert(await page.locator('.nav-inline-link--resume').evaluate(perceptibleInPage),
      `${label}: navigation did not persist after scrolling back to the top`);
    // The collapsed stage must hand the bar back to the settled sticky flow: a bar left
    // fixed would float over the top of the painting for the rest of the session. The
    // canvas colour rides the bootstrap's rAF sync, so wait on both together.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.home-header')).position === 'sticky'
      && getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)', null, { timeout: 5000 });
    const persisted = await page.evaluate(() => ({
      headerPosition: getComputedStyle(document.querySelector('.home-header')).position,
      canvas: getComputedStyle(document.body).backgroundColor
    }));
    assert(persisted.headerPosition === 'sticky',
      `${label}: the collapsed stage left the navigation fixed over the painting`);
    assert(persisted.canvas === 'rgb(255, 255, 255)',
      `${label}: the top canvas is not white once the navigation has arrived`);
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${label}-stage.png`) });

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === 'text');
    // Safari hands the reload its scroll offset back after the bootstrap has read it,
    // so return to the top and let the canvas follow before reading the revisit state.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)',
      null, { timeout: 5000 });
    const revisit = await page.evaluate(() => {
      const header = document.querySelector('.home-header');
      const headerStyle = getComputedStyle(header);
      return {
        intro: document.documentElement.classList.contains('home-stage'),
        skip: document.documentElement.classList.contains('skip-page-animation'),
        headerPosition: headerStyle.position,
        headerTop: header.getBoundingClientRect().top,
        headerShown: headerStyle.visibility !== 'hidden' && Number(headerStyle.opacity) > 0.99,
        heroHeight: document.querySelector('.nighthawks-hero').getBoundingClientRect().height,
        entrance: getComputedStyle(document.querySelector('.nighthawks-figure')).animationName,
        canvas: getComputedStyle(document.body).backgroundColor
      };
    });
    assert(!revisit.intro && revisit.skip, `${label}: the returning visit replayed the stage`);
    assert(revisit.headerPosition === 'sticky' && Math.abs(revisit.headerTop) < 0.5 && revisit.headerShown,
      `${label}: the returning visit lost its navigation`);
    assert(revisit.entrance === 'none', `${label}: the returning visit replayed the entrance`);
    assert(revisit.heroHeight < 900, `${label}: the returning visit kept the full-viewport stage`);
    assert(revisit.canvas === 'rgb(255, 255, 255)', `${label}: the returning visit does not open on the white canvas`);
    assert.deepEqual(errors, [], `${label}: uncaught errors on the stage`);
    console.log(`${name}: first-visit stage holds the painting alone and hands the page to the navigation on scroll.`);
  } finally {
    await context.close();
  }
}

/**
 * The black stage keeps its full-viewport size only while any of it is in sight. The
 * moment the last of it is behind the navigation bar or above the top of the viewport,
 * the settled layout returns at exactly the size a refresh renders — and it returns
 * without moving anything the reader is looking at.
 */
async function checkStageCollapse(browser, name, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options.settings });
  const page = await context.newPage();
  const label = `${name}-stage-collapse${options.suffix || ''}`;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const stageReading = () => {
    const root = document.documentElement;
    const header = document.querySelector('.home-header');
    const hero = document.querySelector('.nighthawks-hero');
    const figure = document.querySelector('.nighthawks-figure');
    const bar = getComputedStyle(header);
    const heroBox = hero.getBoundingClientRect();
    return {
      collapsed: root.classList.contains('home-stage-collapsed'),
      revealed: root.classList.contains('home-nav-revealed'),
      scrollY: window.scrollY,
      heroBottom: heroBox.bottom,
      heroHeight: heroBox.height,
      figureWidth: figure.getBoundingClientRect().width,
      introTop: document.querySelector('.home-intro').getBoundingClientRect().top,
      headerBottom: header.getBoundingClientRect().bottom,
      opacity: Number(bar.opacity),
      visibility: bar.visibility,
      headerPosition: bar.position,
      canvas: getComputedStyle(document.body).backgroundColor,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > innerWidth + 1
    };
  };
  try {
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === 'text');
    // Walk down to the handover in small steps so the exact row that gives the size back
    // is captured, and so a resize that jumped the page would show up as a mismatch.
    const rows = await page.evaluate(async () => {
      const root = document.documentElement;
      const header = document.querySelector('.home-header');
      const hero = document.querySelector('.nighthawks-hero');
      const figure = document.querySelector('.nighthawks-figure');
      const intro = document.querySelector('.home-intro');
      const settle = () => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const read = (requested) => {
        const bar = getComputedStyle(header);
        const heroBox = hero.getBoundingClientRect();
        return {
          requested,
          collapsed: root.classList.contains('home-stage-collapsed'),
          revealed: root.classList.contains('home-nav-revealed'),
          heroBottom: heroBox.bottom,
          heroHeight: heroBox.height,
          figureWidth: figure.getBoundingClientRect().width,
          introTop: intro.getBoundingClientRect().top,
          scrollY: window.scrollY,
          headerBottom: header.getBoundingClientRect().bottom,
          opacity: Number(bar.opacity),
          visibility: bar.visibility,
          headerPosition: bar.position,
          canvas: getComputedStyle(document.body).backgroundColor
        };
      };
      // Where the last row of black meets whatever is hiding it, at this instant, with
      // the same margin the bootstrap waits for.
      const boundary = () => {
        const bar = getComputedStyle(header);
        const cover = bar.visibility === 'visible' && Number(bar.opacity) > 0.999
          ? Math.max(0, header.getBoundingClientRect().bottom)
          : 0;
        return Math.round(window.scrollY + hero.getBoundingClientRect().bottom - cover - 4);
      };
      const revealAt = Math.round(innerHeight * 0.45);
      window.scrollTo(0, revealAt);
      // The bar slides and fades in, and only an opaque one counts as covering the black.
      const arrived = () => {
        const bar = getComputedStyle(header);
        return root.classList.contains('home-nav-revealed')
          && bar.visibility === 'visible' && Number(bar.opacity) > 0.999;
      };
      for (let attempt = 0; attempt < 60 && !arrived(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await settle();
      const rows = [read(revealAt)];
      for (let y = boundary() - 12; y < boundary() + 24; y += 4) {
        window.scrollTo(0, y);
        await settle();
        const row = read(y);
        rows.push(row);
        if (row.collapsed) break;
      }
      return rows;
    });

    const trigger = rows[rows.length - 1];
    const before = rows[rows.length - 2];
    assert(rows[0].revealed && rows[0].opacity > 0.999 && !rows[0].collapsed,
      `${label}: the navigation did not arrive before the handover`);
    assert(before && !before.collapsed && before.heroHeight >= 899,
      `${label}: the stage gave up its size before the black left the screen`);
    assert(trigger.collapsed, `${label}: the stage never returned its settled size`);
    assert(trigger.heroHeight < before.heroHeight - 40, `${label}: the stage did not shrink back`);
    const behindTheBar = trigger.visibility === 'visible' && trigger.opacity > 0.999
      && trigger.heroBottom <= trigger.headerBottom + 0.01;
    assert(behindTheBar || trigger.heroBottom <= 0.01, `${label}: the stage resized with black still in view`);
    assert(trigger.headerPosition === 'sticky', `${label}: the handover left the navigation fixed over the painting`);
    assert(trigger.canvas === 'rgb(0, 0, 0)', `${label}: the canvas is not black past the stage`);
    const blackTop = before.introTop + before.scrollY;
    // Two pixels of slack: a corrected scroll offset is rounded to a whole pixel, and
    // Safari rounds down, which alone can leave a line of the page unaccounted for.
    assert(Math.abs(trigger.introTop - (blackTop - trigger.requested)) <= 2,
      `${label}: the handover moved the page under the reader`);
    await page.screenshot({ path: path.join(OUTPUT_DIR, `${label}-handover.png`) });

    await page.evaluate(() => window.scrollTo(0, 0));
    // The latched navigation rides the settled layout back to the top: still opaque and
    // flush, while the stage keeps its returned size instead of growing back.
    await page.waitForFunction(() => {
      const header = document.querySelector('.home-header');
      const style = getComputedStyle(header);
      return document.documentElement.classList.contains('home-nav-revealed')
        && style.visibility === 'visible' && Number(style.opacity) > 0.999
        && Math.abs(header.getBoundingClientRect().top) < 0.5;
    }, null, { timeout: 5000 });
    // The canvas colour rides the bootstrap's rAF sync; let it land before reading.
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)',
      null, { timeout: 5000 });
    const returned = await page.evaluate(stageReading);
    assert(returned.revealed, `${label}: the navigation did not persist at the top`);
    assert(returned.collapsed && Math.abs(returned.heroHeight - trigger.heroHeight) <= 0.5
      && Math.abs(returned.figureWidth - trigger.figureWidth) <= 0.5,
      `${label}: the stage grew back once the black was in view again`);
    assert(returned.headerPosition === 'sticky' && returned.canvas === 'rgb(255, 255, 255)',
      `${label}: the collapsed stage kept the fixed bar or lost the white top canvas`);
    assert(!returned.overflow, `${label}: the resized stage overflows horizontally`);

    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#nighthawksArtwork')?.dataset.renderMode === 'text');
    // Safari hands the reload its scroll offset back after the bootstrap has read it,
    // so return to the top and let the canvas follow before comparing the settled page.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)',
      null, { timeout: 5000 });
    const settled = await page.evaluate(stageReading);
    assert(!settled.collapsed && !settled.revealed, `${label}: the returning visit kept the stage armed`);
    assert(Math.abs(settled.heroHeight - trigger.heroHeight) <= 1 && Math.abs(settled.figureWidth - trigger.figureWidth) <= 1,
      `${label}: the resized stage is not the size a refresh renders`);
    assert(settled.headerPosition === 'sticky' && settled.canvas === 'rgb(255, 255, 255)',
      `${label}: the returning visit lost the sticky navigation or the white top canvas`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(0, 0, 0)',
      null, { timeout: 5000 });
    assert.deepEqual(errors, [], `${label}: uncaught errors during the handover`);
    console.log(`${label}: the stage hands back its size the moment its black is out of sight.`);
  } finally {
    await context.close();
  }
}

/**
 * With JavaScript disabled the bootstrap never runs, so the overscroll canvas must come
 * from CSS alone: the page closes on the contact section's black, and the body's black
 * baseline holds the canvas black on both edges in every engine. A viewport taller than
 * the whole document exposes that canvas below the contact section without any scrolling,
 * and the white navigation bar proves the page degraded to the settled layout — the
 * enhancement it loses is the scripted white top edge, not the page itself.
 */
async function checkNoScriptCanvas(browser, name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 7000 }, javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto(`${baseUrl}/index.html?full=1`, { waitUntil: 'load' });
    const shot = path.join(OUTPUT_DIR, `${name}-no-javascript-canvas.png`);
    await page.screenshot({ path: shot });
    const { data, info } = await sharp(shot).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]].join(', ');
    };
    // The viewport is taller than the entire document, so the bottom rows are the
    // canvas below the contact section: the bottom edge is black on every engine.
    assert(pixel(20, info.height - 40) === '0, 0, 0', `${name}: the no-script bottom canvas is not black`);
    assert(pixel(800, 34) === '255, 255, 255', `${name}: the no-script navigation is not the settled white bar`);
    assert(pixel(20, 300) === '0, 0, 0', `${name}: the no-script hero does not open on black`);
  } finally {
    await context.close();
  }
}

async function run() {
  validateBinaryText(SOURCE_TEXT);
  const { data: colors, info } = await sharp(path.join(ROOT, 'assets/art/nighthawks-colors.png'))
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 200, 'Color map should retain one pixel per character column');
  assert.equal(info.height, 63, 'Color map should retain one pixel per character row');
  for (const [row, credit] of [[58, 'NIGHTHAWKS'], [60, 'EDWARD HOPPER, 1942']]) {
    for (let column = 0; column < credit.length; column += 1) {
      if (credit[column] === ' ') continue;
      const offset = (row * info.width + 3 + column) * info.channels;
      assert(colors[offset] === 255 && colors[offset + 1] === 255 && colors[offset + 2] === 255,
        'Credit characters must use white cells in the color map');
    }
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const server = await startLocalStaticServer({ url: baseUrl, cwd: ROOT, skip: Boolean(process.env.HOME_CHECK_URL) });
  baseUrl = server?.url || baseUrl;
  try {
    await waitForServer(baseUrl);
    for (const name of requestedBrowsers) {
      assert(BROWSERS[name], `Unknown HOME_CHECK_BROWSERS entry: ${name}`);
      const browser = await BROWSERS[name].launch({ headless: true });
      try {
        if (!stageOnly) {
          for (const viewport of VIEWPORTS) {
            const context = await browser.newContext({ viewport });
            await markAnimationsSeen(context);
            const page = await context.newPage();
            const errors = [];
            const paintingRequests = [];
            page.on('pageerror', (error) => errors.push(error.message));
            page.on('request', (request) => { if (isPaintingRequest(request.url())) paintingRequests.push(request.url()); });
            for (const [surface, route] of [['desktop', '/index.html?full=1'], ['mobile', '/mobile/']]) {
              const label = `${name}-${surface}-${viewport.width}x${viewport.height}`;
              await checkHome(page, route, label);
              await page.screenshot({ path: path.join(OUTPUT_DIR, `${label}.png`), fullPage: true });
              if (viewport.width === 1440) {
                // Halving CSS viewport dimensions represents the layout space at 200% browser zoom.
                await page.setViewportSize({ width: 720, height: 450 });
                await checkHome(page, route, `${label}-200percent-zoom-equivalent`, { navigate: false });
                await page.setViewportSize(viewport);
                await checkHome(page, route, `${label}-resized-back`, { navigate: false });
                await page.evaluate(() => { document.body.style.zoom = '2'; });
                await checkHome(page, route, `${label}-css-zoom-200percent`, { navigate: false });
                await page.screenshot({ path: path.join(OUTPUT_DIR, `${label}-css-zoom-200percent.png`), fullPage: true });
                await page.evaluate(() => { document.body.style.zoom = ''; });
                await checkHome(page, route, `${label}-zoom-restored`, { navigate: false });
                if (surface === 'desktop') await checkRetainedInteractions(page);
              }
            }
            assert.deepEqual(errors, [], `${name}: uncaught homepage errors`);
            assert(paintingRequests.length <= 2, `${name}: successful text rendering fetched multiple fallback resolutions per page`);
            await context.close();
          }
          await checkArtworkBeforeWindowLoad(browser, name);
          await checkVisibleBaselineWhileFontWaits(browser, name);
        }
        await checkFirstVisitStage(browser, name);
        await checkStageCollapse(browser, name);
        await checkStageCollapse(browser, name, { suffix: '-reduced-motion', settings: { reducedMotion: 'reduce' } });
        await checkNoScriptCanvas(browser, name);
        if (!stageOnly) {
          const conditions = [
            { label: 'no-javascript', settings: { javaScriptEnabled: false }, mode: 'fallback', noJavaScript: true },
            { label: 'reduced-motion', settings: { reducedMotion: 'reduce' }, mode: 'text' },
            { label: 'no-fontface', initScript: () => { Object.defineProperty(window, 'FontFace', { value: undefined }); }, mode: 'fallback' },
            { label: 'font-failure', block: (request) => request.url().includes('/assets/fonts/nighthawks-mono-bold.ttf'), mode: 'fallback' },
            { label: 'colormap-failure', block: (request) => request.url().includes('/nighthawks-colors.png'), mode: 'fallback' }
          ];
          for (const condition of conditions) {
            const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...condition.settings });
            await markAnimationsSeen(context);
            if (condition.initScript) await context.addInitScript(condition.initScript);
            if (condition.block) {
              await context.route('**/*', (route) => condition.block(route.request()) ? route.abort() : route.continue());
            }
            const page = await context.newPage();
            const paintingRequests = [];
            page.on('request', (request) => { if (isPaintingRequest(request.url())) paintingRequests.push(request.url()); });
            for (const route of ['/index.html?full=1', '/mobile/']) {
              console.log(`Checking ${name}-${condition.label}-${route}`);
              await checkHome(page, route, `${name}-${condition.label}-${route}`, condition);
            }
            assert(paintingRequests.length > 0 && paintingRequests.length <= 2,
              `${name}: baseline fallback should fetch one responsive painting per page`);
            await context.close();
          }
          await checkCohesionInteractions(browser, name, false);
          await checkCohesionInteractions(browser, name, true);
        }
        console.log(stageOnly
          ? `Verified ${name}: first-visit stage, one-way navigation reveal, and the settled-size handover, in normal and reduced motion.`
          : `Verified ${name}: exact text grid, font/color map, single responsive painting per page, first-visit black stage that hands back its settled size once its black is out of sight, scroll-gated latched navigation, desktop/mobile sizing and resize, 200% viewport-equivalent and CSS zoom, credits, immediate introduction, no-JS and failure fallbacks, reduced motion, four readable project stories, responsive text columns, sticky navigation, keyboard/touch contact interactions, and clipboard outcomes.`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    if (server) server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error('Home check failed:', error);
  process.exit(1);
});
