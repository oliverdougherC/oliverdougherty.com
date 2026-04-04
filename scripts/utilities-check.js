#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4175';
const BASE_URL = process.env.UTILITIES_CHECK_URL || DEFAULT_BASE_URL;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForStatusMatch(page, pattern, timeout = 15000) {
  await page.waitForFunction((source) => {
    const node = document.getElementById('transformStatusText');
    if (!node || !node.textContent) return false;
    return new RegExp(source, 'i').test(node.textContent);
  }, pattern, { timeout });
}

async function waitForProgressFill(page, minimumPercent, timeout = 15000) {
  await page.waitForFunction((threshold) => {
    const fill = document.getElementById('transformProgressFill');
    if (!fill) return false;
    const width = Number.parseFloat(fill.style.width || '0');
    return width >= threshold;
  }, minimumPercent, { timeout });
}

async function createInvalidImageFile() {
  const invalidPath = path.join(os.tmpdir(), `od-invalid-image-${Date.now()}.txt`);
  fs.writeFileSync(invalidPath, 'not an image');
  return invalidPath;
}

async function main() {
  const server = startLocalStaticServer({
    url: BASE_URL,
    cwd: ROOT
  });

  const browser = await chromium.launch({ headless: true });

  try {
    await waitForServer(`${BASE_URL}/pages/dashboard/index.html`);

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });

    const pageUrl = `${BASE_URL}/pages/dashboard/index.html`;
    await page.goto(pageUrl, { waitUntil: 'networkidle' });

    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 20000);
    await waitForProgressFill(page, 90, 20000);

    const afterDemo = await page.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      pixels: document.getElementById('transformPixelCount')?.textContent?.trim(),
      replayDisabled: document.getElementById('transformReplayBtn')?.hasAttribute('disabled')
    }));

    assert(afterDemo.status && /Transform ready|Animation complete|Reduced motion/i.test(afterDemo.status), 'Default demo did not initialize.');
    assert(afterDemo.outputSize && afterDemo.outputSize !== '—', 'Default demo output size missing.');
    assert(afterDemo.pixels && afterDemo.pixels !== '—', 'Default demo pixel count missing.');
    assert(afterDemo.replayDisabled === false, 'Replay should be enabled after the default demo loads.');

    await page.click('#transformReplayBtn');
    await waitForStatusMatch(page, 'Animating', 5000);
    await waitForProgressFill(page, 35, 10000);

    await page.click('#transformSwapBtn');
    await waitForStatusMatch(page, 'Preparing|Matching|Animating', 5000);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 20000);

    const sourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'source.png');
    const targetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'target.png');

    await page.setInputFiles('#transformSourceInput', sourcePath);
    await page.setInputFiles('#transformTargetInput', targetPath);
    await page.click('#transformGenerateBtn');
    await waitForStatusMatch(page, 'Preparing|Matching|Animating', 5000);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 20000);

    const uploadedState = await page.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      sourceMeta: document.getElementById('transformSourceMeta')?.textContent?.trim(),
      targetMeta: document.getElementById('transformTargetMeta')?.textContent?.trim()
    }));

    assert(uploadedState.status && /Transform ready|Animation complete|Reduced motion/i.test(uploadedState.status), 'Uploaded image transform did not complete.');
    assert(uploadedState.sourceMeta && /normalized|working size/i.test(uploadedState.sourceMeta), 'Source meta did not update.');
    assert(uploadedState.targetMeta && /normalized|working size/i.test(uploadedState.targetMeta), 'Target meta did not update.');

    const invalidPath = await createInvalidImageFile();
    await page.setInputFiles('#transformSourceInput', invalidPath);
    await page.click('#transformGenerateBtn');
    await waitForStatusMatch(page, 'could not|unable|failed', 15000);

    const errorState = await page.evaluate(() => ({
      chip: document.getElementById('transformStatusChip')?.textContent?.trim(),
      text: document.getElementById('transformStatusText')?.textContent?.trim()
    }));

    assert(errorState.chip === 'Error', 'Invalid upload should set the error state.');
    assert(errorState.text && /unable|failed|could not/i.test(errorState.text), 'Invalid upload should surface a readable error.');

    const mobilePage = await browser.newPage({
      viewport: { width: 390, height: 844 }
    });
    await mobilePage.emulateMedia({ reducedMotion: 'reduce' });
    await mobilePage.goto(pageUrl, { waitUntil: 'networkidle' });
    await waitForStatusMatch(mobilePage, 'Reduced motion', 20000);

    const mobileState = await mobilePage.evaluate(() => ({
      width: window.innerWidth,
      shellWidth: document.querySelector('.utility-shell')?.getBoundingClientRect().width ?? 0,
      resultStatus: document.getElementById('transformStatusText')?.textContent?.trim()
    }));

    assert(mobileState.shellWidth <= mobileState.width, 'Utilities shell overflows the mobile viewport.');
    assert(mobileState.resultStatus && /Reduced motion/i.test(mobileState.resultStatus), 'Reduced-motion path did not complete.');

    await mobilePage.close();
    await page.close();

    console.log('Utilities Playwright check passed.');
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('Utilities Playwright check failed:', error.message);
  process.exit(1);
});
