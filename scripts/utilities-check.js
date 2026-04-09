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

async function waitForStatusMatch(page, pattern, timeout = 15000, label = pattern) {
  try {
    await page.waitForFunction((source) => {
      const node = document.getElementById('transformStatusText');
      if (!node || !node.textContent) return false;
      return new RegExp(source, 'i').test(node.textContent);
    }, pattern, { timeout });
  } catch (error) {
    const currentStatus = await page
      .evaluate(() => document.getElementById('transformStatusText')?.textContent?.trim() ?? '')
      .catch(() => '');
    throw new Error(`status wait failed (${label}) after ${timeout}ms; current status: ${currentStatus || 'n/a'}`);
  }
}

async function waitForProgressFill(page, minimumPercent, timeout = 15000, label = `${minimumPercent}%`) {
  try {
    await page.waitForFunction((threshold) => {
      const fill = document.getElementById('transformProgressFill');
      if (!fill) return false;
      const width = Number.parseFloat(fill.style.width || '0');
      return width >= threshold;
    }, minimumPercent, { timeout });
  } catch (error) {
    const currentWidth = await page
      .evaluate(() => document.getElementById('transformProgressFill')?.style.width ?? '')
      .catch(() => '');
    throw new Error(`progress wait failed (${label}) after ${timeout}ms; current width: ${currentWidth || 'n/a'}`);
  }
}

async function readStatusText(page) {
  return page
    .evaluate(() => document.getElementById('transformStatusText')?.textContent?.trim() ?? '')
    .catch(() => '');
}

async function loadUtilitiesPage(page, pageUrl, readyPattern, timeout, label) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt === 1) {
      await page.goto(pageUrl, { waitUntil: 'networkidle' });
    } else {
      await page.reload({ waitUntil: 'networkidle' });
    }

    try {
      await waitForStatusMatch(page, readyPattern, timeout, label);
      return;
    } catch (error) {
      const currentStatus = await readStatusText(page);
      const shouldRetry = attempt === 1 && /failed to fetch/i.test(currentStatus);

      if (!shouldRetry) {
        throw error;
      }
    }
  }
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
    const nav = document.getElementById('nav');
    const hero = document.querySelector('.utilities-hero');
    const heroTitle = document.querySelector('.utilities-hero .hero-title');
    const heroSubtitle = document.querySelector('.utilities-hero .hero-subtitle');
    const sectionHeading = document.querySelector('.section-heading');
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
      nav: rect(nav),
      hero: rect(hero),
      heroTitle: rect(heroTitle),
      heroSubtitle: rect(heroSubtitle),
      sectionHeading: rect(sectionHeading),
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

function isRetroVmAssetRequest(url) {
  return (
    url.includes('/assets/utilities/vm/') ||
    url.includes('copy.sh/v86/bios/')
  );
}

async function readRetroVmState(page) {
  return page.evaluate(() => {
    const root = document.getElementById('retroVmApp');
    const placeholder = document.getElementById('retroVmPlaceholder');
    const progressFill = document.getElementById('retroVmProgressFill');

    return {
      state: root?.dataset.vmState ?? '',
      captureState: root?.dataset.vmCaptureState ?? '',
      networkReady: root?.dataset.vmNetworkReady ?? '',
      running: root?.dataset.vmRunning ?? '',
      supported: root?.dataset.vmSupported ?? '',
      booted: root?.dataset.vmBooted ?? '',
      status: document.getElementById('retroVmStatusText')?.textContent?.trim() ?? '',
      chip: document.getElementById('retroVmStatusChip')?.textContent?.trim() ?? '',
      captureBadge: document.getElementById('retroVmCaptureBadge')?.textContent?.trim() ?? '',
      screenBadge: document.getElementById('retroVmScreenBadge')?.textContent?.trim() ?? '',
      assetLabel: document.getElementById('retroVmAssetLabel')?.textContent?.trim() ?? '',
      bridgeLabel: document.getElementById('retroVmBridgeLabel')?.textContent?.trim() ?? '',
      progress: document.getElementById('retroVmProgressText')?.textContent?.trim() ?? '',
      progressWidth: progressFill instanceof HTMLElement ? progressFill.style.width : '',
      launchDisabled: document.getElementById('retroVmLaunchBtn')?.hasAttribute('disabled') ?? false,
      resetDisabled: document.getElementById('retroVmResetBtn')?.hasAttribute('disabled') ?? false,
      fullscreenDisabled: document.getElementById('retroVmFullscreenBtn')?.hasAttribute('disabled') ?? false,
      placeholderHidden: placeholder?.classList.contains('is-hidden') ?? false
    };
  });
}

async function readRetroVmFullscreenMetrics(page) {
  return page.evaluate(() => {
    const shell = document.getElementById('retroVmScreenShell');
    const screen = document.getElementById('retroVmScreen');
    const chrome = document.querySelector('.vm-screen-chrome');
    const bezel = document.querySelector('.vm-screen-bezel');
    const canvas = document.querySelector('#retroVmScreen canvas');
    const rect = (element) =>
      element instanceof HTMLElement || element instanceof HTMLCanvasElement
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
      viewport: { width: window.innerWidth, height: window.innerHeight },
      fullscreenElementId: document.fullscreenElement instanceof HTMLElement ? document.fullscreenElement.id : '',
      shell: rect(shell),
      screen: rect(screen),
      canvas: rect(canvas),
      chromeDisplay: chrome instanceof HTMLElement ? getComputedStyle(chrome).display : '',
      bezelPadding: bezel instanceof HTMLElement ? getComputedStyle(bezel).padding : ''
    };
  });
}

async function main() {
  const server = await startLocalStaticServer({
    url: BASE_URL,
    cwd: ROOT
  });
  const baseUrl = server?.url || BASE_URL;

  const browser = await chromium.launch({ headless: true });

  try {
    await waitForServer(`${baseUrl}/pages/dashboard/index.html`);

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    await page.addInitScript(() => {
      window.__OD_RETRO_VM_TEST_MODE__ = true;
    });

    const retroVmRequests = [];
    const precomputedTransformRequests = [];
    page.on('request', (request) => {
      if (isRetroVmAssetRequest(request.url())) {
        retroVmRequests.push(request.url());
      }
      if (
        request.url().includes('pattern-face-balanced.json') ||
        request.url().includes('source-target-balanced.json') ||
        request.url().includes('face-pattern-balanced.json')
      ) {
        precomputedTransformRequests.push(request.url());
      }
    });

    const pageUrl = `${baseUrl}/pages/dashboard/index.html`;
    await loadUtilitiesPage(page, pageUrl, 'Built-in pair selected|Ready for input', 15000, 'initial transform state');

    const initialTransformState = await page.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      pixels: document.getElementById('transformPixelCount')?.textContent?.trim(),
      playLabel: document.getElementById('transformPlayBtn')?.textContent?.trim(),
      replayButtonExists: Boolean(document.getElementById('transformReplayBtn')),
      uploadIconCount: document.querySelectorAll('.utility-dropzone-icon').length,
      activeDemo: document.querySelector('.demo-chip.active')?.textContent?.trim() ?? '',
      generateDisabled: document.getElementById('transformGenerateBtn')?.hasAttribute('disabled') ?? true
    }));

    assert(
      initialTransformState.status && /built-in pair selected|ready for input/i.test(initialTransformState.status),
      'Image Transform should start idle with a selected built-in pair.'
    );
    assert(initialTransformState.outputSize === '—', 'Initial transform metrics should stay blank until generate is clicked.');
    assert(initialTransformState.pixels === '—', 'Initial transform pixel count should stay blank until generate is clicked.');
    assert(initialTransformState.playLabel === 'Play', 'Primary playback control should remain Play before generation.');
    assert(initialTransformState.replayButtonExists === false, 'Dedicated replay button should not be rendered.');
    assert(initialTransformState.uploadIconCount === 2, 'Both upload dropzones should expose a visible upload icon.');
    assert(initialTransformState.activeDemo === 'Pattern → Face', 'Pattern → Face should be selected by default.');
    assert(initialTransformState.generateDisabled === false, 'Generate should be available when the built-in pair is preselected.');
    assert(precomputedTransformRequests.length === 0, 'Initial load should not fetch precomputed demo transforms.');

    await page.click('[data-demo-key="source-target"]');
    await page.waitForTimeout(300);

    const afterDemoSelection = await page.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      activeDemo: document.querySelector('.demo-chip.active')?.textContent?.trim() ?? ''
    }));

    assert(
      afterDemoSelection.status && /built-in pair selected/i.test(afterDemoSelection.status),
      'Selecting a built-in demo chip should update the ready state without auto-generating.'
    );
    assert(afterDemoSelection.outputSize === '—', 'Selecting a built-in demo chip should not auto-fill transform metrics.');
    assert(afterDemoSelection.activeDemo === 'Pattern → Lucki', 'Demo chip selection should update the active built-in pair.');
    assert(precomputedTransformRequests.length === 0, 'Selecting a built-in demo chip should not fetch precomputed data.');

    await page.click('[data-demo-key="pattern-face"]');
    await page.click('#transformGenerateBtn');
    await waitForStatusMatch(page, 'Loading precomputed|Preparing|Analyzing|Assigning|Animating', 7000);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 30000);
    await waitForProgressFill(page, 90, 20000);

    const afterDemo = await page.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      pixels: document.getElementById('transformPixelCount')?.textContent?.trim(),
      playLabel: document.getElementById('transformPlayBtn')?.textContent?.trim()
    }));

    assert(afterDemo.status && /Transform ready|Animation complete|Reduced motion/i.test(afterDemo.status), 'Built-in demo did not initialize after generate.');
    assert(afterDemo.outputSize && afterDemo.outputSize !== '—', 'Built-in demo output size missing after generate.');
    assert(afterDemo.pixels && afterDemo.pixels !== '—', 'Built-in demo pixel count missing after generate.');
    assert(afterDemo.playLabel === 'Replay', 'Primary playback control should switch to Replay after the built-in animation runs.');
    assert(precomputedTransformRequests.length > 0, 'Built-in demo generation should fetch a shipped precomputed transform asset.');

    await page.evaluate(() => window.scrollTo(0, 0));
    const desktopLayout = await readLayoutMetrics(page);
    assert(desktopLayout.scrollWidth === desktopLayout.clientWidth, 'Utilities page should not overflow horizontally.');
    assert(
      desktopLayout.nav &&
        desktopLayout.heroTitle &&
        desktopLayout.heroTitle.top >= desktopLayout.nav.bottom + 12,
      'Utilities hero title sits too close to the fixed navigation.'
    );
    assert(
      desktopLayout.hero &&
        desktopLayout.hero.height >= 220 &&
        desktopLayout.hero.height <= 350,
      'Utilities hero height is outside the intended compact desktop range.'
    );
    assert(
      desktopLayout.hero &&
        desktopLayout.sectionHeading &&
        desktopLayout.sectionHeading.top - desktopLayout.hero.bottom >= 0 &&
        desktopLayout.sectionHeading.top - desktopLayout.hero.bottom <= 24,
      'Gap between the hero and the featured utility heading is outside the intended compact range.'
    );
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

    const initialVmState = await readRetroVmState(page);
    assert(initialVmState.state === 'idle', 'Retro VM should be idle on first paint.');
    assert(initialVmState.running === 'false', 'Retro VM should not report a running session before launch.');
    assert(initialVmState.supported === 'true', 'Retro VM should be available on desktop.');
    assert(initialVmState.launchDisabled === false, 'Retro VM launch should be available on desktop.');
    assert(initialVmState.networkReady === 'false', 'Retro VM should default to offline until a relay URL is configured.');
    assert(/local only/i.test(initialVmState.screenBadge), 'Retro VM should surface Tiny Core local-only status when no relay is configured.');
    assert(/tiny core linux 11/i.test(initialVmState.assetLabel), 'Retro VM should advertise the Tiny Core rollback image.');
    assert(/offline-first rollback/i.test(initialVmState.bridgeLabel), 'Retro VM should surface offline-first bridge copy by default.');
    assert(retroVmRequests.length === 0, 'Retro VM should not fetch guest assets before launch.');

    const finalResultPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const sourceStagePixels = await readCanvasPixels(page, 'transformSourceCanvas');
    await page.click('#transformPlayBtn');
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
    await waitForStatusMatch(page, 'Preparing|Analyzing|Assigning|Animating', 7000);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 30000);

    const sourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'source.png');
    const targetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'target.png');
    const whiteHeavySourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-source.png');
    const whiteHeavyTargetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-target.png');

    await page.setInputFiles('#transformSourceInput', sourcePath);
    await page.setInputFiles('#transformTargetInput', targetPath);
    await page.click('#transformGenerateBtn');
    await waitForStatusMatch(page, 'Preparing|Analyzing|Assigning|Animating', 7000);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 30000);

    const uploadedState = await page.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      sourceMeta: document.getElementById('transformSourceMeta')?.textContent?.trim(),
      targetMeta: document.getElementById('transformTargetMeta')?.textContent?.trim()
    }));

    assert(uploadedState.status && /Transform ready|Animation complete|Reduced motion/i.test(uploadedState.status), 'Uploaded image transform did not complete.');
    assert(uploadedState.sourceMeta && /normalized|working size/i.test(uploadedState.sourceMeta), 'Source meta did not update.');
    assert(uploadedState.targetMeta && /normalized|working size/i.test(uploadedState.targetMeta), 'Target meta did not update.');

    await page.setInputFiles('#transformSourceInput', whiteHeavySourcePath);
    const staleState = await page.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      progress: document.getElementById('transformProgressText')?.textContent?.trim(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      playDisabled: document.getElementById('transformPlayBtn')?.hasAttribute('disabled'),
      sourceMeta: document.getElementById('transformSourceMeta')?.textContent?.trim(),
      resultMeta: document.getElementById('transformResultMeta')?.textContent?.trim()
    }));

    assert(/Selection updated/i.test(staleState.status || ''), 'Selecting a new source should invalidate the old transform status.');
    assert(/Generate a new transform|Ready for input/i.test(staleState.progress || ''), 'Selecting a new source should clear the old result progress copy.');
    assert(staleState.outputSize === '—', 'Selecting a new source should clear the stale output metrics.');
    assert(staleState.playDisabled === true, 'Selecting a new source should disable playback for the stale result.');
    assert(/preview the selected source image/i.test(staleState.sourceMeta || ''), 'Selecting a new source should replace the stale source metadata.');
    assert(/rebuild the current image pair/i.test(staleState.resultMeta || ''), 'Selecting a new source should prompt the user to regenerate.');

    await page.selectOption('#transformPreset', 'fast');
    await page.setInputFiles('#transformSourceInput', whiteHeavySourcePath);
    await page.setInputFiles('#transformTargetInput', whiteHeavyTargetPath);
    await page.click('#transformGenerateBtn');
    await waitForStatusMatch(page, 'Preparing|Analyzing|Assigning|Animating', 7000);
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

    const deathIntroState = await page.evaluate(() => ({
      introHidden: document.getElementById('deathIntroScreen')?.hasAttribute('hidden') ?? true,
      surveyHidden: document.getElementById('deathSurveyScreen')?.hasAttribute('hidden') ?? false,
      resultHidden: document.getElementById('deathResultScreen')?.hasAttribute('hidden') ?? false,
      title: document.getElementById('deathCalculatorTitle')?.textContent?.trim() ?? '',
      beginLabel: document.getElementById('deathBeginBtn')?.textContent?.trim() ?? ''
    }));

    assert(deathIntroState.introHidden === false, 'Death Calculator should start on the intro card.');
    assert(deathIntroState.surveyHidden === true, 'Death Calculator survey should stay hidden until Begin is clicked.');
    assert(deathIntroState.resultHidden === true, 'Death Calculator result should stay hidden on first paint.');
    assert(deathIntroState.title === 'Death Calculator', 'Death Calculator intro title is missing.');
    assert(deathIntroState.beginLabel === 'Begin?', 'Death Calculator intro CTA should read Begin?.');

    await page.click('#deathBeginBtn');

    const deathSurveyStart = await page.evaluate(() => ({
      surveyHidden: document.getElementById('deathSurveyScreen')?.hasAttribute('hidden') ?? true,
      activeCard: document.querySelector('[data-question-card]:not([hidden])')?.getAttribute('data-question-card') ?? '',
      visibleCardCount: document.querySelectorAll('[data-question-card]:not([hidden])').length,
      progressText: document.getElementById('deathProgressText')?.textContent?.trim() ?? ''
    }));

    assert(deathSurveyStart.surveyHidden === false, 'Death Calculator should reveal the survey after Begin is clicked.');
    assert(deathSurveyStart.activeCard === 'birthDate', 'Death Calculator should begin on the birth-date card.');
    assert(deathSurveyStart.visibleCardCount === 1, 'Death Calculator should show exactly one question card at a time.');
    assert(/Question 1 of/i.test(deathSurveyStart.progressText), 'Death Calculator progress copy should start on question 1.');

    await page.fill('#deathBirthDate', '1989-05-14');
    await page.click('#deathNextBtn');

    await page.selectOption('#deathSex', 'male');
    await page.click('#deathNextBtn');

    await page.fill('#deathWeightPounds', '192');
    await page.click('#deathNextBtn');

    await page.fill('#deathHeightFeet', '5');
    await page.fill('#deathHeightInchesPart', '11');
    await page.click('#deathNextBtn');

    await page.fill('#deathModerateMinutes', '180');
    await page.click('#deathNextBtn');

    await page.fill('#deathVigorousMinutes', '40');
    await page.click('#deathNextBtn');

    await page.fill('#deathStrengthDays', '3');
    await page.click('#deathNextBtn');

    await page.fill('#deathSedentaryHours', '7');
    await page.click('#deathNextBtn');

    await page.selectOption('#deathSmokingStatus', 'former');
    await page.click('#deathNextBtn');
    await page.waitForSelector('#deathYearsSinceQuitField:not([hidden])');

    const formerSmokerState = await page.evaluate(() => ({
      activeCard: document.querySelector('[data-question-card]:not([hidden])')?.getAttribute('data-question-card') ?? '',
      visibleCardCount: document.querySelectorAll('[data-question-card]:not([hidden])').length
    }));

    assert(formerSmokerState.activeCard === 'yearsSinceQuit', 'Former-smoker follow-up should become the active next card.');
    assert(formerSmokerState.visibleCardCount === 1, 'Former-smoker follow-up should still keep the flow to one visible card.');

    await page.fill('#deathYearsSinceQuit', '12');
    await page.click('#deathNextBtn');

    await page.fill('#deathDrinksPerWeek', '4');
    await page.click('#deathNextBtn');

    await page.selectOption('#deathBingeFrequency', 'never');
    await page.click('#deathNextBtn');

    await page.fill('#deathSleepHours', '7.5');
    await page.click('#deathNextBtn');

    await page.selectOption('#deathUpfShare', 'moderate');
    await page.click('#deathNextBtn');

    await page.fill('#deathProduceServings', '5');
    await page.click('#deathNextBtn');

    await page.check('#deathHasHypertension');
    await page.click('#deathNextBtn');

    await page.selectOption('#deathDiabetesStatus', 'prediabetes');
    await page.click('#deathNextBtn');

    await page.check('#deathHasCardioDisease');
    await page.click('#deathNextBtn');

    await page.check('#deathHasCancerHistory');
    await page.click('#deathNextBtn');

    await page.check('#deathHasCopdOrAsthma');
    await page.click('#deathNextBtn');

    await page.check('#deathHasKidneyDisease');
    await page.click('#deathNextBtn');

    await page.check('#deathHasSleepApnea');
    await page.click('#deathNextBtn');

    await page.check('#deathEarlyFamilyCardio');
    await page.click('#deathNextBtn');

    await page.selectOption('#deathParentLongevityBand', 'one-85-plus');
    await page.click('#deathCalculateBtn');
    await page.waitForFunction(() => document.getElementById('deathResultScreen')?.hasAttribute('hidden') === false);

    const deathResultState = await page.evaluate(() => ({
      resultHidden: document.getElementById('deathResultScreen')?.hasAttribute('hidden') ?? true,
      medianDate: document.getElementById('deathMedianDate')?.textContent?.trim() ?? '',
      countdownDisplay: document.getElementById('deathCountdownDisplay')?.textContent?.trim() ?? '',
      disclaimer: document.getElementById('deathDisclaimer')?.textContent?.trim() ?? '',
      resultMeta: document.getElementById('deathResultMeta')?.textContent?.trim() ?? '',
      missingLegacyStats: document.getElementById('deathHazardMultiplier') === null
    }));

    assert(deathResultState.resultHidden === false, 'Death Calculator should reveal the result card after submission.');
    assert(deathResultState.medianDate && !/complete the survey/i.test(deathResultState.medianDate), 'Death Calculator should render a concrete median date.');
    assert(
      /^\d{2,}:\d{3}:\d{2}:\d{2}:\d{2}$/.test(deathResultState.countdownDisplay),
      'Death Calculator should render a unified labeled countdown in the expected format.'
    );
    assert(/not a medical diagnosis/i.test(deathResultState.disclaimer), 'Death Calculator should expose a clear disclaimer.');
    assert(/50th percentile|survival curve/i.test(deathResultState.resultMeta), 'Death Calculator should explain the estimate briefly.');
    assert(deathResultState.missingLegacyStats === true, 'Death Calculator should remove the old analytics dashboard from the primary result.');

    const countdownBefore = deathResultState.countdownDisplay;
    await page.waitForTimeout(1200);
    const countdownAfter = await page.evaluate(() => document.getElementById('deathCountdownDisplay')?.textContent?.trim() ?? '');
    assert(countdownAfter !== countdownBefore, 'Death Calculator countdown should tick in real time.');

    await page.click('#deathResetBtn');
    const deathResetState = await page.evaluate(() => ({
      introHidden: document.getElementById('deathIntroScreen')?.hasAttribute('hidden') ?? true,
      statusText: document.getElementById('deathStatusText')?.textContent?.trim() ?? '',
      birthDate: document.getElementById('deathBirthDate')?.value ?? '',
      medianDate: document.getElementById('deathMedianDate')?.textContent?.trim() ?? ''
    }));

    assert(deathResetState.introHidden === false, 'Death Calculator reset should return the user to the intro card.');
    assert(/local-only estimate|public-health evidence/i.test(deathResetState.statusText), 'Death Calculator reset should restore the intro copy.');
    assert(deathResetState.birthDate === '', 'Death Calculator reset should clear submitted answers.');
    assert(/estimated date will appear here/i.test(deathResetState.medianDate), 'Death Calculator reset should restore the result placeholder copy.');

    await page.click('#retroVmLaunchBtn');
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmState === 'running');

    const launchedVmState = await readRetroVmState(page);
    assert(launchedVmState.chip === 'Running', 'Retro VM should enter the running state after launch.');
    assert(/booting locally|running locally/i.test(launchedVmState.status), 'Retro VM should surface a boot/running status after launch.');
    assert(launchedVmState.progressWidth !== '0%', 'Retro VM progress should advance after launch.');
    assert(launchedVmState.placeholderHidden === true, 'Retro VM placeholder should hide after launch.');
    assert(launchedVmState.launchDisabled === true, 'Retro VM launch should disable while a session is active.');
    assert(launchedVmState.resetDisabled === false, 'Retro VM reset should enable while a session is active.');
    assert(launchedVmState.fullscreenDisabled === false, 'Retro VM fullscreen should enable after launch.');
    assert(launchedVmState.captureState === 'uncaptured', 'Retro VM should start in the uncaptured mouse state.');
    assert(/click desktop to capture/i.test(launchedVmState.captureBadge), 'Retro VM should advertise click-to-capture before pointer lock.');

    await page.click('#retroVmScreen');
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmCaptureState === 'captured');
    const capturedVmState = await readRetroVmState(page);
    assert(/captured/i.test(capturedVmState.captureBadge), 'Retro VM should show captured state after clicking the desktop.');
    assert(/mouse is captured/i.test(capturedVmState.status), 'Retro VM should explain how to release captured mouse input.');

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmCaptureState === 'uncaptured');

    await page.click('#retroVmFullscreenBtn');
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmState === 'fullscreen');
    const fullscreenMetrics = await readRetroVmFullscreenMetrics(page);
    assert(fullscreenMetrics.fullscreenElementId === 'retroVmScreenShell', 'Retro VM should enter fullscreen on the VM shell.');
    assert(fullscreenMetrics.chromeDisplay === 'none', 'Retro VM fullscreen should hide the decorative chrome.');
    assert(fullscreenMetrics.bezelPadding === '0px', 'Retro VM fullscreen bezel should not add padding.');
    assert(
      fullscreenMetrics.shell &&
        Math.abs(fullscreenMetrics.shell.width - fullscreenMetrics.viewport.width) <= 2 &&
        Math.abs(fullscreenMetrics.shell.height - fullscreenMetrics.viewport.height) <= 2,
      'Retro VM fullscreen shell should fill the viewport.'
    );
    assert(
      fullscreenMetrics.screen &&
        Math.abs(fullscreenMetrics.screen.width - fullscreenMetrics.viewport.width) <= 2 &&
        Math.abs(fullscreenMetrics.screen.height - fullscreenMetrics.viewport.height) <= 2,
      'Retro VM fullscreen guest viewport should fill the screen.'
    );
    assert(
      fullscreenMetrics.canvas &&
        Math.abs(fullscreenMetrics.canvas.width / fullscreenMetrics.canvas.height - 1024 / 768) < 0.02,
      'Retro VM fullscreen should preserve the guest aspect ratio.'
    );
    await page.click('#retroVmScreen');
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmCaptureState === 'captured');
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmState === 'running');
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmCaptureState === 'uncaptured');

    await page.evaluate(() => document.getElementById('retroVmResetBtn')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmState === 'idle');
    const exitedFullscreenMetrics = await readRetroVmFullscreenMetrics(page);
    assert(exitedFullscreenMetrics.fullscreenElementId === '', 'Retro VM reset should leave fullscreen cleanly.');
    const resetVmState = await readRetroVmState(page);
    assert(resetVmState.captureState === 'uncaptured', 'Retro VM should clear capture state after reset.');
    assert(resetVmState.running === 'false', 'Retro VM should clear its running flag after reset.');
    assert(resetVmState.booted === 'false', 'Retro VM should clear its booted flag after reset.');
    assert(resetVmState.placeholderHidden === false, 'Retro VM placeholder should return after reset.');
    assert(/nothing persists|fresh local session/i.test(resetVmState.status), 'Retro VM should explain wipe semantics after reset.');

    const noWorkerPage = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    await noWorkerPage.addInitScript(() => {
      Object.defineProperty(window, 'Worker', {
        configurable: true,
        writable: true,
        value: undefined
      });
    });
    await loadUtilitiesPage(
      noWorkerPage,
      pageUrl,
      'Built-in pair selected|Ready for input',
      15000,
      'main-thread fallback initial state'
    );
    await noWorkerPage.setInputFiles('#transformSourceInput', sourcePath);
    await noWorkerPage.setInputFiles('#transformTargetInput', targetPath);
    await noWorkerPage.click('#transformGenerateBtn');
    await waitForStatusMatch(noWorkerPage, 'Preparing|Analyzing|Assigning|Animating', 7000, 'main-thread fallback start');
    await waitForStatusMatch(
      noWorkerPage,
      'Transform ready|Animation complete|Reduced motion',
      30000,
      'main-thread fallback complete'
    );

    const noWorkerState = await noWorkerPage.evaluate(() => ({
      status: document.getElementById('transformStatusText')?.textContent?.trim(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      matcherStrategy: document.getElementById('utilitiesApp')?.dataset.matcherStrategy ?? ''
    }));

    assert(
      noWorkerState.status && /Transform ready|Animation complete|Reduced motion/i.test(noWorkerState.status),
      'Utilities page should still complete when workers are unavailable.'
    );
    assert(noWorkerState.outputSize && noWorkerState.outputSize !== '—', 'Main-thread fallback should still render output metrics.');
    assert(noWorkerState.matcherStrategy === 'single-optimized', 'Main-thread fallback should preserve the optimized matcher.');

    const mobilePage = await browser.newPage({
      viewport: { width: 390, height: 844 }
    });
    await mobilePage.addInitScript(() => {
      window.__OD_RETRO_VM_TEST_MODE__ = true;
    });
    await mobilePage.emulateMedia({ reducedMotion: 'reduce' });
    await loadUtilitiesPage(mobilePage, pageUrl, 'Built-in pair selected|Ready for input', 15000, 'reduced-motion startup');
    await mobilePage.click('#transformGenerateBtn');
    await waitForStatusMatch(mobilePage, 'Reduced motion', 30000, 'reduced-motion result');
    await mobilePage.evaluate(() => window.scrollTo(0, 0));

    const mobileState = await mobilePage.evaluate(() => ({
      width: window.innerWidth,
      shellWidth: document.querySelector('.utility-shell')?.getBoundingClientRect().width ?? 0,
      resultStatus: document.getElementById('transformStatusText')?.textContent?.trim(),
      vmState: document.getElementById('retroVmApp')?.dataset.vmState ?? '',
      vmStatus: document.getElementById('retroVmStatusText')?.textContent?.trim() ?? '',
      navBottom: document.getElementById('nav')?.getBoundingClientRect().bottom ?? 0,
      heroTitleTop: document.querySelector('.utilities-hero .hero-title')?.getBoundingClientRect().top ?? 0
    }));

    assert(mobileState.shellWidth <= mobileState.width, 'Utilities shell overflows the mobile viewport.');
    assert(mobileState.resultStatus && /Reduced motion/i.test(mobileState.resultStatus), 'Reduced-motion path did not complete.');
    assert(mobileState.vmState === 'unsupported', 'Retro VM should fall back on mobile-sized viewports.');
    assert(/desktop-first|desktop browser/i.test(mobileState.vmStatus), 'Retro VM mobile fallback copy is missing.');
    assert(mobileState.heroTitleTop >= mobileState.navBottom + 8, 'Mobile utilities hero title sits too close to the navigation.');

    await noWorkerPage.close();
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
