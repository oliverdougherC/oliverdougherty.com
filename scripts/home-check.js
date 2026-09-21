#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');
const sharp = require('sharp');
const { startLocalStaticServer, waitForServer } = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', 'home-check');
const BROWSERS = { chromium, firefox, webkit };
const requestedBrowsers = (process.env.HOME_CHECK_BROWSERS || 'chromium').split(',').map((name) => name.trim());
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
        for (const viewport of VIEWPORTS) {
          const context = await browser.newContext({ viewport });
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
          assert.deepEqual(paintingRequests, [], `${name}: successful text rendering downloaded a painting raster`);
          await context.close();
        }
        const conditions = [
          { label: 'no-javascript', settings: { javaScriptEnabled: false }, mode: 'fallback', noJavaScript: true },
          { label: 'reduced-motion', settings: { reducedMotion: 'reduce' }, mode: 'text' },
          { label: 'font-failure', block: (request) => request.url().includes('/assets/fonts/nighthawks-mono-bold.ttf'), mode: 'fallback' },
          { label: 'colormap-failure', block: (request) => request.url().includes('/nighthawks-colors.png'), mode: 'fallback' }
        ];
        for (const condition of conditions) {
          const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...condition.settings });
          if (condition.block) {
            await context.route('**/*', (route) => condition.block(route.request()) ? route.abort() : route.continue());
          }
          const page = await context.newPage();
          const paintingRequests = [];
          page.on('request', (request) => { if (isPaintingRequest(request.url())) paintingRequests.push(request.url()); });
          for (const route of ['/index.html?full=1', '/mobile/']) {
            await checkHome(page, route, `${name}-${condition.label}-${route}`, condition);
          }
          if (condition.mode === 'text') assert.deepEqual(paintingRequests, [], `${name}: reduced motion fetched painting raster`);
          else assert(paintingRequests.length > 0, `${name}: fallback never fetched its painting`);
          await context.close();
        }
        await checkCohesionInteractions(browser, name, false);
        await checkCohesionInteractions(browser, name, true);
        console.log(`Verified ${name}: exact text grid, font/color map, no normal painting fetch, desktop/mobile sizing and resize, 200% viewport-equivalent and CSS zoom, credits, immediate introduction, no-JS and failure fallbacks, reduced motion, four readable project stories, responsive text columns, sticky navigation, keyboard/touch contact interactions, and clipboard outcomes.`);
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
