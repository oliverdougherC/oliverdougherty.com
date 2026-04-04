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

function countMatchingPixels(left, right) {
  let matches = 0;
  for (let offset = 0; offset < left.length; offset += 4) {
    if (
      left[offset] === right[offset] &&
      left[offset + 1] === right[offset + 1] &&
      left[offset + 2] === right[offset + 2] &&
      left[offset + 3] === right[offset + 3]
    ) {
      matches += 1;
    }
  }
  return matches;
}

function totalAbsoluteDifference(left, right) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference;
}

function countNearWhitePixels(pixels, threshold = 245) {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] >= threshold && pixels[index + 1] >= threshold && pixels[index + 2] >= threshold) {
      count += 1;
    }
  }
  return count;
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

async function readCanvasPixels(page, id) {
  return page.evaluate((canvasId) => {
    const canvas = document.getElementById(canvasId);
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error(`Canvas not found: ${canvasId}`);
    }
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error(`Unable to read canvas: ${canvasId}`);
    }
    return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
  }, id);
}

async function readOverlayAlphaPixels(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('transformOverlayCanvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('Overlay canvas not found.');
    }
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Unable to read overlay canvas.');
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let alphaPixels = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] > 0) {
        alphaPixels += 1;
      }
    }
    return alphaPixels;
  });
}

async function readLayoutMetrics(page) {
  return page.evaluate(() => {
    const shell = document.querySelector('.utility-shell');
    const resultPanel = document.querySelector('.canvas-panel--result');
    const resultStage = document.querySelector('.canvas-stage--result');
    const resultCanvas = document.getElementById('transformResultCanvas');
    const overlayCanvas = document.getElementById('transformOverlayCanvas');
    const rect = (element) =>
      element
        ? {
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
            top: element.getBoundingClientRect().top,
            bottom: element.getBoundingClientRect().bottom,
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height
          }
        : null;

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      shell: rect(shell),
      panel: rect(resultPanel),
      stage: rect(resultStage),
      canvas: rect(resultCanvas),
      overlay: rect(overlayCanvas),
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    };
  });
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

    const desktopLayout = await readLayoutMetrics(page);
    assert(desktopLayout.scrollWidth === desktopLayout.clientWidth, 'Utilities page should not overflow horizontally.');
    assert(desktopLayout.shell && desktopLayout.shell.height < 1700, 'Utilities shell is still too tall for comfortable desktop viewing.');
    assert(desktopLayout.stage && desktopLayout.stage.height <= 640, 'Reconstruction stage is still larger than intended on desktop.');
    assert(
      desktopLayout.panel &&
        desktopLayout.stage &&
        desktopLayout.canvas &&
        desktopLayout.stage.right <= desktopLayout.panel.right + 1 &&
        desktopLayout.canvas.right <= desktopLayout.panel.right + 1,
      'Reconstruction stage or canvas exceeds the right edge of its panel.'
    );

    const finalResultPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const sourceStagePixels = await readCanvasPixels(page, 'transformSourceCanvas');
    await page.click('#transformReplayBtn');
    await waitForStatusMatch(page, 'Animating', 5000);
    await waitForProgressFill(page, 65, 15000);

    const midAnimationPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const matchingFinalPixels = countMatchingPixels(midAnimationPixels, finalResultPixels);
    const differenceToFinal = totalAbsoluteDifference(midAnimationPixels, finalResultPixels);
    const differenceToSource = totalAbsoluteDifference(midAnimationPixels, sourceStagePixels);

    assert(
      differenceToSource > 0 && differenceToFinal > 0,
      'Mid-animation result should visibly differ from both the source and the final frame.'
    );
    assert(
      matchingFinalPixels < midAnimationPixels.length / 4,
      'Mid-animation result should not already be identical to the final image.'
    );

    await waitForProgressFill(page, 85, 15000);
    const lateMotionPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const lateDifferenceToFinal = totalAbsoluteDifference(lateMotionPixels, finalResultPixels);
    const lateDifferenceToSource = totalAbsoluteDifference(lateMotionPixels, sourceStagePixels);
    assert(
      lateDifferenceToFinal < lateDifferenceToSource,
      'Late animation should be clearly converging toward the final arrangement.'
    );

    await waitForProgressFill(page, 88, 15000);
    const lateAnimationPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const lateOverlayAlphaPixels = await readOverlayAlphaPixels(page);

    if (lateOverlayAlphaPixels > 0) {
      assert(
        totalAbsoluteDifference(lateAnimationPixels, finalResultPixels) > 0,
        'Late animation should stay just shy of the final frame while visible motion remains.'
      );
    }

    await waitForStatusMatch(page, 'Animation complete', 15000);
    const completedResultPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const completedOverlayAlphaPixels = await readOverlayAlphaPixels(page);

    assert(
      totalAbsoluteDifference(completedResultPixels, finalResultPixels) === 0,
      'Completed animation should end on the exact final frame.'
    );
    assert(completedOverlayAlphaPixels === 0, 'Completed animation should leave no overlay pixels behind.');

    await page.click('#transformSwapBtn');
    await waitForStatusMatch(page, 'Preparing|Matching|Animating', 5000);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 20000);

    const sourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'source.png');
    const targetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'target.png');
    const whiteHeavySourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-source.png');
    const whiteHeavyTargetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-target.png');

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

    await page.selectOption('#transformPreset', 'fast');
    await page.setInputFiles('#transformSourceInput', whiteHeavySourcePath);
    await page.setInputFiles('#transformTargetInput', whiteHeavyTargetPath);
    await page.click('#transformGenerateBtn');
    await waitForStatusMatch(page, 'Preparing|Matching|Animating', 5000);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 30000);

    const whiteHeavySourcePixels = await readCanvasPixels(page, 'transformSourceCanvas');
    const whiteHeavyTargetPixels = await readCanvasPixels(page, 'transformTargetCanvas');
    const whiteHeavyResultPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const whiteHeavyLayout = await readLayoutMetrics(page);
    const sourceNearWhiteRatio = countNearWhitePixels(whiteHeavySourcePixels) / (whiteHeavySourcePixels.length / 4);
    const targetNearWhiteRatio = countNearWhitePixels(whiteHeavyTargetPixels) / (whiteHeavyTargetPixels.length / 4);
    const resultNearWhiteRatio = countNearWhitePixels(whiteHeavyResultPixels) / (whiteHeavyResultPixels.length / 4);

    assert(resultNearWhiteRatio < sourceNearWhiteRatio - 0.2, 'White-heavy source still dominates the cheated reconstruction.');
    assert(resultNearWhiteRatio < 0.45, 'White-heavy reconstruction is still too blank to read as an impressive result.');
    assert(
      totalAbsoluteDifference(whiteHeavyResultPixels, whiteHeavyTargetPixels) <
        totalAbsoluteDifference(whiteHeavySourcePixels, whiteHeavyTargetPixels),
      'Cheat-aware reconstruction should land closer to the target than the white-heavy source preview.'
    );
    assert(
      whiteHeavyLayout.panel &&
        whiteHeavyLayout.stage &&
        whiteHeavyLayout.canvas &&
        whiteHeavyLayout.stage.right <= whiteHeavyLayout.panel.right + 1 &&
        whiteHeavyLayout.canvas.right <= whiteHeavyLayout.panel.right + 1,
      'White-heavy reconstruction spills outside the Reconstruction panel.'
    );
    assert(whiteHeavyLayout.scrollWidth === whiteHeavyLayout.clientWidth, 'White-heavy case should not introduce horizontal overflow.');
    assert(targetNearWhiteRatio < resultNearWhiteRatio + 0.3, 'Cheated reconstruction should broadly follow the target rather than staying washed out.');

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
