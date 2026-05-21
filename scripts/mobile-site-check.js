#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output', 'playwright', 'mobile-site-check');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4173';
let baseUrl = process.env.MOBILE_CHECK_URL || DEFAULT_BASE_URL;

const MOBILE_VIEWPORTS = [
  { label: 'phone-tall', width: 390, height: 844 },
  { label: 'phone-small', width: 375, height: 667 },
  { label: 'phone-landscape', width: 667, height: 375 }
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function collectMobilePageState(page) {
  return page.evaluate(() => {
    const navLinks = Array.from(document.querySelectorAll('.mobile-nav-link')).map((link) => link.textContent.trim());
    const buttons = Array.from(document.querySelectorAll('.mobile-button, .mobile-nav-link, .mobile-contact-links a')).map((el) => {
      const styles = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        text: el.textContent.trim(),
        height: rect.height,
        radius: Number.parseFloat(styles.borderTopLeftRadius) || 0,
        color: styles.color,
        backgroundColor: styles.backgroundColor
      };
    });
    const repeatedItems = Array.from(document.querySelectorAll('.mobile-list-item, .mobile-stat, .mobile-detail-block')).map((el) => {
      const styles = getComputedStyle(el);
      return Number.parseFloat(styles.borderTopLeftRadius) || 0;
    });

    return {
      path: window.location.pathname,
      title: document.title,
      navLinks,
      text: document.body.innerText,
      width: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      bodyScrollWidth: document.body.scrollWidth,
      buttons,
      repeatedItems,
      fullSiteLinks: Array.from(document.querySelectorAll('a[href*="full=1"]')).length,
      imageCount: document.querySelectorAll('img').length
    };
  });
}

function assertMobileSurface(state, label, expectedPathPart) {
  assert(state.path.includes(expectedPathPart), `[${label}] expected path to include ${expectedPathPart}, got ${state.path}`);
  assert(state.navLinks.join('|') === 'Home|Resume', `[${label}] mobile nav should contain only Home and Resume`);
  assert(!/\bGallery\b/.test(state.text), `[${label}] mobile page should not expose Gallery`);
  assert(!/\bUtilities\b/.test(state.text), `[${label}] mobile page should not expose Utilities`);
  assert(!/\bArchive\b/.test(state.text), `[${label}] mobile page should not expose Archive`);
  assert(!/\bGame\b/.test(state.text), `[${label}] mobile page should not expose Game`);
  assert(state.fullSiteLinks >= 1, `[${label}] missing full-site escape link`);
  assert(state.scrollWidth <= state.width + 1, `[${label}] document overflows horizontally: ${state.scrollWidth} > ${state.width}`);
  assert(state.bodyScrollWidth <= state.width + 1, `[${label}] body overflows horizontally: ${state.bodyScrollWidth} > ${state.width}`);

  state.buttons.forEach((button) => {
    assert(button.height >= 44, `[${label}] tap target "${button.text}" is shorter than 44px`);
    assert(button.radius <= 8, `[${label}] tap target "${button.text}" has radius ${button.radius}px > 8px`);
    assert(button.color !== button.backgroundColor, `[${label}] tap target "${button.text}" has matching text/background colors`);
  });
  state.repeatedItems.forEach((radius) => {
    assert(radius <= 8, `[${label}] repeated item has radius ${radius}px > 8px`);
  });
}

async function assertMobilePages(browser) {
  for (const viewport of MOBILE_VIEWPORTS) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();

    await page.goto(`${baseUrl}/mobile/`, { waitUntil: 'networkidle' });
    let state = await collectMobilePageState(page);
    assertMobileSurface(state, `${viewport.label}:home`, '/mobile/');
    assert(state.imageCount === 1, `[${viewport.label}:home] mobile home should use exactly one image`);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `${viewport.label}-home.png`),
      fullPage: true
    });

    await page.goto(`${baseUrl}/mobile/resume/`, { waitUntil: 'networkidle' });
    state = await collectMobilePageState(page);
    assertMobileSurface(state, `${viewport.label}:resume`, '/mobile/resume');
    assert(/Oregon State University/.test(state.text), `[${viewport.label}:resume] education content missing`);
    assert(/Encoding DB/.test(state.text), `[${viewport.label}:resume] project content missing`);
    await page.screenshot({
      path: path.join(OUTPUT_DIR, `${viewport.label}-resume.png`),
      fullPage: true
    });

    await context.close();
  }
}

async function assertMobileGate(browser) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  const gatedRoutes = [
    '/pages/gallery/index.html',
    '/pages/utilities/index.html',
    '/pages/game/index.html',
    '/pages/archive/index.html',
    '/pages/archive/pi/pi.html'
  ];

  for (const route of gatedRoutes) {
    await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/mobile\/?$/, { timeout: 5000 });
    assert(page.url().endsWith('/mobile/'), `[mobile-gate] ${route} did not redirect to /mobile/`);
  }

  await page.goto(`${baseUrl}/pages/gallery/index.html?full=1`, { waitUntil: 'domcontentloaded' });
  assert(page.url().includes('/pages/gallery/index.html?full=1'), '[mobile-gate] ?full=1 should bypass redirect');

  await context.close();
}

async function assertDesktopBypass(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${baseUrl}/pages/gallery/index.html`, { waitUntil: 'domcontentloaded' });
  assert(page.url().includes('/pages/gallery/index.html'), '[mobile-gate] desktop viewport should not redirect Gallery');

  await context.close();
}

async function run() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const server = await startLocalStaticServer({
    url: baseUrl,
    cwd: ROOT,
    skip: Boolean(process.env.MOBILE_CHECK_URL),
    bindHost: null
  });
  baseUrl = server?.url || baseUrl;
  let browser;

  try {
    await waitForServer(baseUrl);
    browser = await chromium.launch({ headless: true });

    await assertMobilePages(browser);
    console.log('Verified dedicated mobile Home and Resume across phone viewports.');

    await assertMobileGate(browser);
    console.log('Verified mobile redirects and ?full=1 escape.');

    await assertDesktopBypass(browser);
    console.log('Verified desktop visitors stay on full-site pages.');
  } finally {
    if (browser) await browser.close();
    if (server) server.kill('SIGTERM');
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
