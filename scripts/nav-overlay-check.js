#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', 'nav-overlay-check');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
let baseUrl = process.env.NAV_CHECK_URL || DEFAULT_BASE_URL;
const PAGES = [
  { label: 'home', route: '/' },
  { label: 'archive', route: '/pages/archive/index.html' },
  { label: 'resume', route: '/pages/resume/index.html' }
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForMenuState(page, expectedOpen) {
  await page.waitForFunction((nextOpen) => {
    const overlay = document.getElementById('navOverlay');
    const toggle = document.getElementById('navToggle');
    if (!overlay || !toggle) return false;

    const isOpen = overlay.classList.contains('active');
    const isHidden = overlay.getAttribute('aria-hidden') === String(!nextOpen);
    return isOpen === nextOpen
      && toggle.getAttribute('aria-expanded') === String(nextOpen)
      && isHidden;
  }, expectedOpen, { timeout: 5000 });
}

async function waitForOverlayStable(page) {
  await page.waitForFunction(() => {
    const overlay = document.getElementById('navOverlay');
    const bg = overlay?.querySelector('.nav-overlay-bg');
    if (!overlay || !bg) return false;

    const overlayRect = overlay.getBoundingClientRect();
    const bgRect = bg.getBoundingClientRect();
    return Math.abs(overlayRect.top) <= 1
      && Math.abs(overlayRect.left) <= 1
      && Math.abs(bgRect.top) <= 1
      && Math.abs(bgRect.left) <= 1
      && Math.abs(overlayRect.width - window.innerWidth) <= 1
      && Math.abs(overlayRect.height - window.innerHeight) <= 1
      && Math.abs(bgRect.width - window.innerWidth) <= 1
      && Math.abs(bgRect.height - window.innerHeight) <= 1;
  }, { timeout: 5000 });
}

async function openMenu(page) {
  const expanded = await page.getAttribute('#navToggle', 'aria-expanded');
  if (expanded === 'true') return;

  await page.click('#navToggle');
  await waitForMenuState(page, true);
  await waitForOverlayStable(page);
}

async function closeMenu(page) {
  const expanded = await page.getAttribute('#navToggle', 'aria-expanded');
  if (expanded === 'false') return;

  await page.click('#navToggle');
  await waitForMenuState(page, false);
  await page.waitForTimeout(120);
}

async function scrollPage(page) {
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page.waitForFunction(() => window.scrollY > 50, null, { timeout: 5000 });
  const hasNavBar = await page.evaluate(() => Boolean(document.getElementById('nav')));
  if (hasNavBar) {
    await page.waitForFunction(() => document.getElementById('nav')?.classList.contains('scrolled'), null, {
      timeout: 5000
    });
  }
  await page.waitForTimeout(200);
}

async function collectNavState(page) {
  return page.evaluate(() => {
    const overlay = document.getElementById('navOverlay');
    const bg = overlay?.querySelector('.nav-overlay-bg');
    const toggle = document.getElementById('navToggle');

    return {
      colorMode: document.documentElement.getAttribute('data-color-mode'),
      overlayActive: overlay?.classList.contains('active') ?? false,
      overlayHidden: overlay?.getAttribute('aria-hidden'),
      ariaExpanded: toggle?.getAttribute('aria-expanded'),
      bodyClass: document.body.className,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      overlayRect: overlay?.getBoundingClientRect().toJSON(),
      bgRect: bg?.getBoundingClientRect().toJSON(),
      links: Array.from(document.querySelectorAll('.nav-link')).map((link) => ({
        text: link.textContent.trim(),
        rect: link.getBoundingClientRect().toJSON()
      }))
    };
  });
}

function assertOverlayCoverage(state, label) {
  const { viewport, overlayRect, bgRect } = state;
  assert(overlayRect, `[${label}] missing overlay rect`);
  assert(bgRect, `[${label}] missing overlay background rect`);
  assert(Math.abs(overlayRect.top) <= 1 && Math.abs(overlayRect.left) <= 1, `[${label}] overlay is not pinned to viewport origin`);
  assert(Math.abs(bgRect.top) <= 1 && Math.abs(bgRect.left) <= 1, `[${label}] overlay background is not pinned to viewport origin`);
  assert(Math.abs(overlayRect.width - viewport.width) <= 1, `[${label}] overlay width ${overlayRect.width} does not match viewport ${viewport.width}`);
  assert(Math.abs(overlayRect.height - viewport.height) <= 1, `[${label}] overlay height ${overlayRect.height} does not match viewport ${viewport.height}`);
  assert(Math.abs(bgRect.width - viewport.width) <= 1, `[${label}] overlay background width ${bgRect.width} does not match viewport ${viewport.width}`);
  assert(Math.abs(bgRect.height - viewport.height) <= 1, `[${label}] overlay background height ${bgRect.height} does not match viewport ${viewport.height}`);
}

function assertDesktopLinkVisibility(state, label) {
  state.links.forEach((link) => {
    assert(link.rect.top >= 0, `[${label}] nav link "${link.text}" is clipped above the viewport`);
    assert(link.rect.bottom <= state.viewport.height, `[${label}] nav link "${link.text}" is clipped below the viewport`);
  });
}

function assertMobileLinkVisibility(state, label) {
  assert(state.links.length > 1, `[${label}] expected mobile nav links`);
  const first = state.links[0];
  const last = state.links[state.links.length - 1];

  assert(first.rect.top >= 0, `[${label}] first nav link is clipped above the viewport`);
  assert(first.rect.bottom <= state.viewport.height, `[${label}] first nav link is clipped below the viewport`);
  assert(last.rect.top >= 0, `[${label}] last nav link is clipped above the viewport`);
  assert(last.rect.bottom <= state.viewport.height, `[${label}] last nav link is clipped below the viewport`);
}

function assertClosed(state, label) {
  assert(!state.overlayActive, `[${label}] overlay should be closed`);
  assert(state.overlayHidden === 'true', `[${label}] overlay should be aria-hidden when closed`);
  assert(state.ariaExpanded === 'false', `[${label}] nav toggle should not be expanded`);
  assert(!state.bodyClass.includes('nav-open'), `[${label}] body should not retain nav-open`);
}

async function assertDesktopGeometry(page, pageInfo) {
  await page.goto(`${baseUrl}${pageInfo.route}`, { waitUntil: 'networkidle' });
  if (!await hasOverlayNav(page)) return;
  await closeMenu(page);
  await openMenu(page);
  let state = await collectNavState(page);
  assertOverlayCoverage(state, `${pageInfo.label}:desktop:top`);
  assertDesktopLinkVisibility(state, `${pageInfo.label}:desktop:top`);
  await closeMenu(page);

  await page.goto(`${baseUrl}${pageInfo.route}`, { waitUntil: 'networkidle' });
  if (!await hasOverlayNav(page)) return;
  await scrollPage(page);
  await openMenu(page);
  state = await collectNavState(page);
  assertOverlayCoverage(state, `${pageInfo.label}:desktop:scrolled`);
  assertDesktopLinkVisibility(state, `${pageInfo.label}:desktop:scrolled`);
  await closeMenu(page);
}

async function assertMobileGeometry(page, pageInfo) {
  await page.goto(`${baseUrl}${pageInfo.route}`, { waitUntil: 'networkidle' });
  if (!await hasOverlayNav(page)) return;
  await scrollPage(page);
  await openMenu(page);
  const state = await collectNavState(page);
  assertOverlayCoverage(state, `${pageInfo.label}:mobile:scrolled`);
  assertMobileLinkVisibility(state, `${pageInfo.label}:mobile:scrolled`);
  await closeMenu(page);
}

async function hasOverlayNav(page) {
  return page.evaluate(() => Boolean(
    document.getElementById('navToggle') &&
    document.getElementById('navOverlay')
  ));
}

async function assertInteractions(page) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });

  await openMenu(page);
  await closeMenu(page);
  let state = await collectNavState(page);
  assertClosed(state, 'home:interaction:toggle-close');

  await openMenu(page);
  await page.click('.nav-overlay-bg', { position: { x: 20, y: 20 } });
  await waitForMenuState(page, false);
  await page.waitForTimeout(120);
  state = await collectNavState(page);
  assertClosed(state, 'home:interaction:bg-close');

  await openMenu(page);
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.click('.nav-link[aria-current="page"], .nav-link.active')
  ]);
  await page.waitForLoadState('networkidle');
  state = await collectNavState(page);
  assertClosed(state, 'home:interaction:link-close');

  await openMenu(page);
  await page.keyboard.press('Escape');
  await waitForMenuState(page, false);
  await page.waitForTimeout(120);
  state = await collectNavState(page);
  assertClosed(state, 'home:interaction:escape-close');
}

async function assertThemeToggleGeometry(page) {
  await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
  const hasThemeToggle = await page.locator('.theme-toggle').count();
  if (!hasThemeToggle) return;

  await scrollPage(page);
  await openMenu(page);

  const before = await collectNavState(page);
  await page.click('.theme-toggle');
  await page.waitForTimeout(180);
  const after = await collectNavState(page);

  assert(before.colorMode !== after.colorMode, '[home:theme-toggle] expected color mode to change');
  assert(after.overlayActive, '[home:theme-toggle] overlay should remain open after toggling color mode');
  assert(after.overlayHidden === 'false', '[home:theme-toggle] overlay should remain aria-visible after color mode toggle');
  assertOverlayCoverage(after, 'home:theme-toggle');
  assertDesktopLinkVisibility(after, 'home:theme-toggle');
  await closeMenu(page);
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const server = await startLocalStaticServer({
    url: baseUrl,
    cwd: ROOT,
    skip: Boolean(process.env.NAV_CHECK_URL),
    bindHost: null
  });
  baseUrl = server?.url || baseUrl;
  let browser;

  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch({ headless: true });

    const desktopContext = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const desktopPage = await desktopContext.newPage();

    for (const pageInfo of PAGES) {
      await assertDesktopGeometry(desktopPage, pageInfo);
      console.log(`Verified desktop nav overlay geometry for ${pageInfo.label}.`);
    }

    await assertInteractions(desktopPage);
    console.log('Verified nav close interactions on home page.');

    await assertThemeToggleGeometry(desktopPage);
    console.log('Verified theme toggle preserves overlay geometry on home page.');

    const mobileContext = await browser.newContext({
      ...devices['iPhone 13']
    });
    const mobilePage = await mobileContext.newPage();

    for (const pageInfo of PAGES) {
      await assertMobileGeometry(mobilePage, pageInfo);
      console.log(`Verified mobile nav overlay geometry for ${pageInfo.label}.`);
    }

    await mobileContext.close();
    await desktopContext.close();
    console.log('Nav overlay checks passed.');
  } finally {
    if (browser) {
      await browser.close();
    }
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

run().catch(async (error) => {
  console.error('Nav overlay check failed:', error.message);
  process.exit(1);
});
