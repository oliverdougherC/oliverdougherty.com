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
      const app = document.getElementById('utilitiesApp');
      const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
      const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
      const combined = fromData || fromLegacy;
      if (!combined) return false;
      return new RegExp(source, 'i').test(combined);
    }, pattern, { timeout });
  } catch (error) {
    const currentStatus = await page
      .evaluate(() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })
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

async function waitForAudioStatusMatch(page, pattern, timeout = 15000, label = pattern) {
  try {
    await page.waitForFunction((source) => {
      const node = document.getElementById('audioFourierStatusText');
      if (!node || !node.textContent) return false;
      return new RegExp(source, 'i').test(node.textContent);
    }, pattern, { timeout });
  } catch (error) {
    const currentStatus = await page
      .evaluate(() => document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '')
      .catch(() => '');
    throw new Error(`audio status wait failed (${label}) after ${timeout}ms; current status: ${currentStatus || 'n/a'}`);
  }
}

async function waitForAudioProgressFill(page, minimumPercent, timeout = 15000, label = `${minimumPercent}%`) {
  try {
    await page.waitForFunction((threshold) => {
      const fill = document.getElementById('audioFourierProgressFill');
      if (!fill) return false;
      const width = Number.parseFloat(fill.style.width || '0');
      return width >= threshold;
    }, minimumPercent, { timeout });
  } catch (error) {
    const currentWidth = await page
      .evaluate(() => document.getElementById('audioFourierProgressFill')?.style.width ?? '')
      .catch(() => '');
    throw new Error(`audio progress wait failed (${label}) after ${timeout}ms; current width: ${currentWidth || 'n/a'}`);
  }
}

async function readStatusText(page) {
  return page
    .evaluate(() => {
      const app = document.getElementById('utilitiesApp');
      const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
      const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
      return fromData || fromLegacy;
    })
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

async function createInvalidAudioFile() {
  const invalidPath = path.join(os.tmpdir(), `od-invalid-audio-${Date.now()}.txt`);
  fs.writeFileSync(invalidPath, 'not an audio file');
  return invalidPath;
}

async function createGeneratedWavFile() {
  const sampleRate = 16000;
  const durationSeconds = 5 * 60;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  const wavPath = path.join(os.tmpdir(), `od-fourier-upload-${Date.now()}.wav`);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / sampleRate;
    const envelope = Math.min(1, time / 0.2, (durationSeconds - time) / 0.35);
    const value =
      Math.sin(2 * Math.PI * 220 * time) * 0.42 +
      Math.sin(2 * Math.PI * 440 * time + 0.4) * 0.24 +
      Math.sin(2 * Math.PI * 880 * time) * 0.08;
    buffer.writeInt16LE(Math.max(-1, Math.min(1, value * envelope)) * 32767, 44 + index * 2);
  }

  await fs.promises.writeFile(wavPath, buffer);
  return wavPath;
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

function countActiveCanvasPixels(pixels) {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index];
    const green = pixels[index + 1];
    const blue = pixels[index + 2];
    if (red + green + blue > 120) {
      count += 1;
    }
  }
  return count;
}

function parseCssRgb(value) {
  const match = /^rgba?\(([^)]+)\)$/.exec(value.trim());
  if (!match) {
    return null;
  }

  const parts = match[1].split(',').map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
    return null;
  }

  return {
    red: parts[0],
    green: parts[1],
    blue: parts[2],
    alpha: parts[3] ?? 1
  };
}

function compositeOver(color, background) {
  const alpha = Math.max(0, Math.min(1, color.alpha));
  return {
    red: color.red * alpha + background.red * (1 - alpha),
    green: color.green * alpha + background.green * (1 - alpha),
    blue: color.blue * alpha + background.blue * (1 - alpha),
    alpha: 1
  };
}

function toLinearChannel(value) {
  const normalized = value / 255;
  return normalized <= 0.03928
    ? normalized / 12.92
    : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

function relativeLuminance(color) {
  return (
    0.2126 * toLinearChannel(color.red) +
    0.7152 * toLinearChannel(color.green) +
    0.0722 * toLinearChannel(color.blue)
  );
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return (light + 0.05) / (dark + 0.05);
}

function assertLightModeContrast(metrics, label, minimum = 4.5) {
  const foreground = parseCssRgb(metrics.color);
  const background = parseCssRgb(metrics.backgroundColor);
  const bodyBackground = parseCssRgb(metrics.bodyBackground);

  assert(foreground && background && bodyBackground, `[light:${label}] unable to parse computed colors.`);

  const compositedBackground = background.alpha < 1 ? compositeOver(background, bodyBackground) : background;
  const ratio = contrastRatio(foreground, compositedBackground);
  assert(ratio >= minimum, `[light:${label}] contrast too low (${ratio.toFixed(2)}).`);
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

async function assertUtilityHoverHitTargetsStable(page) {
  const selectors = [
    '#sourceDropzone',
    '#targetDropzone',
    '#transformPreset',
    '#transformGenerateBtn',
    '#transformSwapBtn',
    '#transformResetBtn',
    '[data-demo-key="pattern-face"]',
    '[data-demo-key="source-target"]',
    '[data-demo-key="face-pattern"]',
    '#audioFourierDropzone',
    '#audioFourierQuality',
    '#audioFourierGenerateBtn',
    '#audioFourierResetBtn',
    '[data-audio-preset="best-friends"]',
    '[data-audio-preset="i-cant-wait-to-get-there"]',
    '[data-audio-preset="party-after-party"]',
    '#deathBeginBtn',
    '#retroVmLaunchBtn'
  ];

  for (const selector of selectors) {
    const target = page.locator(selector).first();
    const visible = await target.isVisible().catch(() => false);
    if (!visible) {
      continue;
    }

    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);

    const box = await target.boundingBox();
    if (!box) {
      continue;
    }

    const x = box.x + box.width / 2;
    const y = box.y + Math.max(1, box.height - 2);
    await page.mouse.move(x, y);
    await page.waitForTimeout(260);

    const state = await target.evaluate(
      (element, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        const transform = getComputedStyle(element).transform;
        return {
          selector: element.id ? `#${element.id}` : element.getAttribute('data-demo-key') || element.getAttribute('data-audio-preset') || element.tagName,
          hovered: element.matches(':hover'),
          transform,
          requiresStableHit: element.matches('.utility-dropzone'),
          hitInside: Boolean(hit && (hit === element || element.contains(hit))),
          hitLabel: hit?.id || hit?.closest?.('[id]')?.id || hit?.textContent?.trim()?.slice(0, 60) || hit?.tagName || ''
        };
      },
      { x, y }
    );

    assert(
      state.transform === 'none',
      `Hovering ${selector} should not move the hit target; computed transform was ${state.transform}.`
    );
    if (state.requiresStableHit) {
      assert(
        state.hitInside,
        `Hovering ${selector} at its lower edge should keep the pointer inside the same target; hit ${state.hitLabel || 'nothing'}.`
      );
    }

    await page.mouse.move(8, 8);
    await page.waitForTimeout(40);
  }
}

async function readLightModeVisualMetrics(page) {
  return page.evaluate(() => {
    const bodyBackground = getComputedStyle(document.body).backgroundColor;
    const describe = (label, selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return { label, selector, missing: true };
      }

      const styles = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        label,
        selector,
        missing: false,
        color: styles.color,
        backgroundColor: styles.backgroundColor,
        backgroundImage: styles.backgroundImage,
        borderColor: styles.borderColor,
        opacity: Number.parseFloat(styles.opacity || '1'),
        bodyBackground,
        width: rect.width,
        height: rect.height,
        visible: rect.width > 0 && rect.height > 0 && styles.visibility !== 'hidden' && styles.display !== 'none'
      };
    };

    return {
      colorMode: document.documentElement.getAttribute('data-color-mode') ?? '',
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      metrics: [
        describe('image shell', '#utilitiesApp'),
        describe('audio shell', '#audioFourierApp'),
        describe('longevity intro', '#deathCalculatorApp .death-card--intro'),
        describe('retro vm shell', '#retroVmApp'),
        describe('image status copy', '#transformProgressText'),
        describe('audio status copy', '#audioFourierProgressText'),
        describe('longevity intro copy', '#deathBeginBtn'),
        describe('retro vm status copy', '#retroVmProgressText'),
        describe('primary action', '#transformGenerateBtn'),
        describe('secondary action', '#transformResetBtn'),
        describe('demo chip', '[data-demo-key="pattern-face"]'),
        describe('select control', '#transformPreset'),
        describe('dropzone', '#sourceDropzone'),
        describe('canvas panel', '.canvas-panel--result'),
        describe('audio panel', '.canvas-panel--audio-wave'),
      ]
    };
  });
}

async function runLightModeVisualCheck(browser, pageUrl) {
  for (const viewport of [
    { label: 'desktop', width: 1440, height: 1100 },
    { label: 'mobile', width: 390, height: 844 }
  ]) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height }
    });
    await page.addInitScript(() => {
      window.localStorage.setItem('od-color-mode', 'light');
      window.__OD_RETRO_VM_TEST_MODE__ = true;
    });

    try {
      await loadUtilitiesPage(page, pageUrl, 'Built-in pair selected|Ready for input', 15000, `light ${viewport.label}`);
      const state = await readLightModeVisualMetrics(page);

      assert(state.colorMode === 'light', `[light:${viewport.label}] expected light color mode.`);
      assert(state.scrollWidth === state.clientWidth, `[light:${viewport.label}] page should not overflow horizontally.`);

      for (const metric of state.metrics) {
        assert(!metric.missing, `[light:${viewport.label}] missing ${metric.label}.`);
        assert(metric.visible, `[light:${viewport.label}] ${metric.label} should be visible.`);
        if (metric.label === 'image shell') {
          assert(metric.opacity >= 0.99, `[light:${viewport.label}] first utility shell should not render transparent.`);
        }
        assert(metric.width <= viewport.width, `[light:${viewport.label}] ${metric.label} overflows viewport width.`);
        assert(
          !/rgba?\(13,\s*11,\s*8|rgb\(21,\s*17,\s*12|rgb\(15,\s*13,\s*9\)/i.test(metric.backgroundColor),
          `[light:${viewport.label}] ${metric.label} is still using a dark-mode background color.`
        );

        if (metric.label === 'primary action') {
          assert(metric.backgroundImage !== 'none', `[light:${viewport.label}] primary action should keep a distinct filled treatment.`);
        } else if (/copy|action|chip|control/.test(metric.label)) {
          assertLightModeContrast(metric, `${viewport.label}:${metric.label}`);
        }
      }

      const lightDarkSurfaceLeakCount = state.metrics.filter((metric) =>
        /rgba?\(13,\s*11,\s*8|#15110c|#1b1610|#0f0d09/i.test(
          `${metric.backgroundColor} ${metric.backgroundImage}`
        )
      ).length;
      assert(lightDarkSurfaceLeakCount === 0, `[light:${viewport.label}] utility chrome still leaks dark-mode surfaces.`);
    } finally {
      await page.close();
    }
  }
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
    const progressFromDataset = root?.dataset?.vmProgressPercent;

    const networkReady = root?.dataset.vmNetworkReady === 'true';
    const bridgeLabel = networkReady
      ? root?.dataset.vmBridgeLabelOnline?.trim() ?? ''
      : root?.dataset.vmBridgeLabelOffline?.trim() ?? '';

    return {
      state: root?.dataset.vmState ?? '',
      captureState: root?.dataset.vmCaptureState ?? '',
      networkReady: root?.dataset.vmNetworkReady ?? '',
      running: root?.dataset.vmRunning ?? '',
      supported: root?.dataset.vmSupported ?? '',
      booted: root?.dataset.vmBooted ?? '',
      status: root?.dataset?.vmStatusMessage?.trim() ?? document.getElementById('retroVmStatusText')?.textContent?.trim() ?? '',
      chip: root?.dataset?.vmStatusChip?.trim() ?? document.getElementById('retroVmStatusChip')?.textContent?.trim() ?? '',
      captureBadge: document.getElementById('retroVmCaptureBadge')?.textContent?.trim() ?? '',
      screenBadge: document.getElementById('retroVmScreenBadge')?.textContent?.trim() ?? '',
      assetLabel: root?.dataset.vmAssetLabel?.trim() ?? '',
      bridgeLabel,
      progress: document.getElementById('retroVmProgressText')?.textContent?.trim() ?? '',
      progressWidth:
        progressFromDataset !== undefined && progressFromDataset !== ''
          ? `${progressFromDataset}%`
          : progressFill instanceof HTMLElement
            ? progressFill.style.width
            : '',
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
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
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
    assert(initialTransformState.uploadIconCount === 3, 'Utilities upload dropzones should expose visible upload icons.');
    assert(initialTransformState.activeDemo === 'Pattern → Face', 'Pattern → Face should be selected by default.');
    assert(initialTransformState.generateDisabled === false, 'Generate should be available when the built-in pair is preselected.');
    assert(precomputedTransformRequests.length === 0, 'Initial load should not fetch precomputed demo transforms.');
    await assertUtilityHoverHitTargetsStable(page);

    await page.click('[data-demo-key="source-target"]');
    await page.waitForTimeout(300);

    const afterDemoSelection = await page.evaluate(() => ({
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
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
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
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

    await runLightModeVisualCheck(browser, pageUrl);

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
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
      sourceMeta: document.getElementById('transformSourceMeta')?.textContent?.trim(),
      targetMeta: document.getElementById('transformTargetMeta')?.textContent?.trim()
    }));

    assert(uploadedState.status && /Transform ready|Animation complete|Reduced motion/i.test(uploadedState.status), 'Uploaded image transform did not complete.');
    assert(uploadedState.sourceMeta && /normalized|working size/i.test(uploadedState.sourceMeta), 'Source meta did not update.');
    assert(uploadedState.targetMeta && /normalized|working size/i.test(uploadedState.targetMeta), 'Target meta did not update.');

    await page.setInputFiles('#transformSourceInput', whiteHeavySourcePath);
    const staleState = await page.evaluate(() => ({
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
      progress: document.getElementById('transformProgressText')?.textContent?.trim(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      playDisabled: document.getElementById('transformPlayBtn')?.hasAttribute('disabled'),
      sourceMeta: document.getElementById('transformSourceMeta')?.textContent?.trim(),
      resultMeta: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.resultMetaMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformResultMeta')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })()
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
      chip: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusChip?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusChip')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
      text: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })()
    }));

    assert(errorState.chip === 'Error', 'Invalid upload should set the error state.');
    assert(errorState.text && /unable|failed|could not/i.test(errorState.text), 'Invalid upload should surface a readable error.');

    const initialAudioState = await page.evaluate(() => ({
      status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
      selected: document.getElementById('audioFourierSelection')?.textContent?.trim() ?? '',
      sampleRate: document.getElementById('audioFourierSampleRate')?.textContent?.trim() ?? '',
      componentCount: document.getElementById('audioFourierComponentCount')?.textContent?.trim() ?? '',
      sliderDisabled: document.getElementById('audioFourierComponentSlider')?.hasAttribute('disabled') ?? false,
      generateDisabled: document.getElementById('audioFourierGenerateBtn')?.hasAttribute('disabled') ?? true,
      playDisabled: document.getElementById('audioFourierPlayBtn')?.hasAttribute('disabled') ?? false,
      telemetryPresent: Boolean(document.getElementById('audioFourierApp')?.dataset.audioLastRequestId)
    }));

    assert(/choose|track|audio/i.test(initialAudioState.status), 'Audio Fourier should start idle.');
    assert(initialAudioState.selected === 'Best Friends', 'Audio Fourier should default to the Best Friends song preset.');
    assert(initialAudioState.sampleRate === '—', 'Audio Fourier sample-rate metric should stay blank before generation.');
    assert(initialAudioState.componentCount === '—', 'Audio Fourier component count should stay blank before generation.');
    assert(initialAudioState.sliderDisabled === true, 'Audio Fourier component slider should stay disabled before generation.');
    assert(initialAudioState.generateDisabled === false, 'Audio Fourier generate should be available for the default preset.');
    assert(initialAudioState.playDisabled === true, 'Audio Fourier playback should be disabled before generation.');
    assert(initialAudioState.telemetryPresent === false, 'Audio Fourier should not analyze audio on first paint.');

    await page.selectOption('#audioFourierQuality', 'fast');
    await page.click('[data-audio-preset="best-friends"]');
    await page.click('#audioFourierGenerateBtn');
    await waitForAudioStatusMatch(page, 'Fourier proxy ready|auditory midpoint|Playing selected|Press Play', 60000, 'built-in song preset ready');

    const generatedReadyState = await page.evaluate(() => ({
      status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
      sampleRate: document.getElementById('audioFourierSampleRate')?.textContent?.trim() ?? '',
      componentCount: document.getElementById('audioFourierComponentCount')?.textContent?.trim() ?? '',
      sourceDuration: document.getElementById('audioFourierSourceDuration')?.textContent?.trim() ?? '',
      sliderDisabled: document.getElementById('audioFourierComponentSlider')?.hasAttribute('disabled') ?? true,
      sliderMin: document.getElementById('audioFourierComponentSlider')?.getAttribute('min') ?? '',
      sliderMax: document.getElementById('audioFourierComponentSlider')?.getAttribute('max') ?? '',
      sliderValue: document.getElementById('audioFourierComponentSlider')?.value ?? '',
      componentReadout: document.getElementById('audioFourierComponentReadout')?.textContent?.trim() ?? '',
      telemetry: {
        requestId: document.getElementById('audioFourierApp')?.dataset.audioLastRequestId ?? '',
        totalMs: Number(document.getElementById('audioFourierApp')?.dataset.audioTotalMs ?? '0'),
        proxyMs: Number(document.getElementById('audioFourierApp')?.dataset.audioProxyMs ?? '0'),
        analysisMs: Number(document.getElementById('audioFourierApp')?.dataset.audioAnalysisMs ?? '0'),
        bandMs: Number(document.getElementById('audioFourierApp')?.dataset.audioBandMs ?? '0'),
        components: Number(document.getElementById('audioFourierApp')?.dataset.audioComponentCount ?? '0'),
        proxyDuration: Number(document.getElementById('audioFourierApp')?.dataset.audioProxyDuration ?? '0'),
        bandCount: Number(document.getElementById('audioFourierApp')?.dataset.audioBandCount ?? '0')
      },
      playDisabled: document.getElementById('audioFourierPlayBtn')?.hasAttribute('disabled') ?? true
    }));

    assert(/ready|playing|press play/i.test(generatedReadyState.status), 'Built-in Audio Fourier song preset did not finish analysis.');
    assert(/\d+ Hz proxy/.test(generatedReadyState.sampleRate), 'Audio Fourier proxy sample-rate metric missing after preset generation.');
    assert(generatedReadyState.componentCount !== '—', 'Audio Fourier component count missing after preset generation.');
    assert(/source/.test(generatedReadyState.sourceDuration), 'Audio Fourier source duration missing after preset generation.');
    assert(generatedReadyState.sliderDisabled === false, 'Audio Fourier component slider should be enabled after generation.');
    assert(generatedReadyState.sliderMin === '0', 'Audio Fourier slider minimum should represent sparse signal energy.');
    assert(generatedReadyState.sliderMax === '100', 'Audio Fourier slider max should represent 100% signal energy.');
    assert(generatedReadyState.sliderValue === '50', 'Audio Fourier slider should start at the physical midpoint.');
    assert(/80% signal energy/.test(generatedReadyState.componentReadout), 'Audio Fourier midpoint should land near the auditory midpoint.');
    assert(generatedReadyState.telemetry.requestId, 'Audio Fourier telemetry should include the completed request id.');
    assert(generatedReadyState.telemetry.totalMs > 0, 'Audio Fourier telemetry should include total processing time.');
    assert(generatedReadyState.telemetry.proxyMs > 0, 'Audio Fourier telemetry should include proxy processing time.');
    assert(generatedReadyState.telemetry.analysisMs > 0, 'Audio Fourier telemetry should include windowed analysis time.');
    assert(generatedReadyState.telemetry.bandMs > 0, 'Audio Fourier telemetry should include band rendering time.');
    assert(generatedReadyState.telemetry.components > 1000, 'Audio Fourier should expose a substantial component count.');
    assert(generatedReadyState.telemetry.proxyDuration > 0, 'Audio Fourier should expose proxy duration.');
    assert(generatedReadyState.telemetry.bandCount > 0, 'Audio Fourier should expose live energy band count.');

    const generatedWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    await page.fill('#audioFourierComponentSlider', '100');
    await waitForAudioProgressFill(page, 99, 15000, 'built-in song preset slider max');
    const fullSignalWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    const generatedSpectrumPixels = await readCanvasPixels(page, 'audioFourierSpectrumCanvas');
    const generatedComponentPixels = await readCanvasPixels(page, 'audioFourierComponentCanvas');
    assert(countActiveCanvasPixels(generatedWavePixels) > 100, 'Audio Fourier waveform canvas should be visibly nonblank.');
    assert(totalAbsoluteDifference(generatedWavePixels, fullSignalWavePixels) > 0, 'Dragging the Audio Fourier slider should visibly change the waveform.');
    assert(countActiveCanvasPixels(generatedSpectrumPixels) > 100, 'Audio Fourier spectrum canvas should be visibly nonblank.');
    assert(countActiveCanvasPixels(generatedComponentPixels) > 100, 'Audio Fourier component canvas should be visibly nonblank.');
    if (generatedReadyState.playDisabled === false) {
      await page.click('#audioFourierPlayBtn');
      await waitForAudioStatusMatch(page, 'Playing selected Fourier energy mix', 5000, 'built-in song preset playback starts');
      await page.waitForTimeout(350);
      const playbackWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
      assert(totalAbsoluteDifference(fullSignalWavePixels, playbackWavePixels) > 0, 'Audio Fourier viewport should advance during playback.');
      await page.fill('#audioFourierComponentSlider', '20');
      await page.waitForTimeout(120);
      const sliderDuringPlaybackState = await page.evaluate(() => ({
        status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
        readout: document.getElementById('audioFourierComponentReadout')?.textContent?.trim() ?? ''
      }));
      assert(/Playing selected Fourier energy mix/.test(sliderDuringPlaybackState.status), 'Audio Fourier slider should not stop playback.');
      assert(/60% signal energy/.test(sliderDuringPlaybackState.readout), 'Audio Fourier readout should update with perceptual slider mapping during playback.');
      await page.click('#audioFourierPauseBtn');
      await waitForAudioStatusMatch(page, 'Playback paused', 5000, 'built-in song preset playback pauses');
    }

    const wavPath = await createGeneratedWavFile();
    await page.setInputFiles('#audioFourierInput', wavPath);
    await page.click('#audioFourierGenerateBtn');
    await waitForAudioStatusMatch(page, 'Fourier proxy ready|auditory midpoint|Playing selected|Press Play', 45000, 'uploaded 5-minute wav ready');

    const uploadedAudioState = await page.evaluate(() => ({
      status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
      selected: document.getElementById('audioFourierSelection')?.textContent?.trim() ?? '',
      sourceDuration: document.getElementById('audioFourierSourceDuration')?.textContent?.trim() ?? '',
      proxyDuration: Number(document.getElementById('audioFourierApp')?.dataset.audioProxyDuration ?? '0'),
      sourceKind: document.getElementById('audioFourierApp')?.dataset.audioState ?? ''
    }));

    assert(/ready|playing|press play/i.test(uploadedAudioState.status), 'Uploaded WAV did not complete Audio Fourier analysis.');
    assert(/od-fourier-upload/.test(uploadedAudioState.selected), 'Audio Fourier upload selection label did not update.');
    assert(/5:00 source/.test(uploadedAudioState.sourceDuration), 'Uploaded WAV should report full 5-minute source duration.');
    assert(uploadedAudioState.proxyDuration >= 299, 'Uploaded WAV should preserve full-song proxy duration.');
    assert(/ready|animating|complete/.test(uploadedAudioState.sourceKind), 'Uploaded WAV should leave Audio Fourier in a usable state.');

    const invalidAudioPath = await createInvalidAudioFile();
    await page.setInputFiles('#audioFourierInput', invalidAudioPath);
    await page.click('#audioFourierGenerateBtn');
    await waitForAudioStatusMatch(page, 'not a browser-supported audio file|decode|unable', 15000, 'invalid audio error');

    const audioErrorState = await page.evaluate(() => ({
      chip: document.getElementById('audioFourierStatusChip')?.textContent?.trim() ?? '',
      text: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? ''
    }));

    assert(audioErrorState.chip === 'Error', 'Invalid audio upload should set the Audio Fourier error chip.');
    assert(/audio|decode|unable|supported/i.test(audioErrorState.text), 'Invalid audio upload should surface a readable error.');

    const deathIntroState = await page.evaluate(() => ({
      introHidden: document.getElementById('deathIntroScreen')?.hasAttribute('hidden') ?? true,
      surveyHidden: document.getElementById('deathSurveyScreen')?.hasAttribute('hidden') ?? false,
      resultHidden: document.getElementById('deathResultScreen')?.hasAttribute('hidden') ?? false,
      surveyDisplay: window.getComputedStyle(document.getElementById('deathSurveyScreen')).display,
      resultDisplay: window.getComputedStyle(document.getElementById('deathResultScreen')).display,
      title: document.getElementById('deathCalculatorApp')?.getAttribute('aria-label')?.trim() ?? '',
      beginLabel: document.getElementById('deathBeginBtn')?.textContent?.trim() ?? ''
    }));

    assert(deathIntroState.introHidden === false, 'Death Calculator should start on the intro card.');
    assert(deathIntroState.surveyHidden === true, 'Death Calculator survey should stay hidden until Begin is clicked.');
    assert(deathIntroState.resultHidden === true, 'Death Calculator result should stay hidden on first paint.');
    assert(deathIntroState.surveyDisplay === 'none', 'Hidden Death Calculator survey should not occupy layout space.');
    assert(deathIntroState.resultDisplay === 'none', 'Hidden Death Calculator result should not occupy layout space.');
    assert(deathIntroState.title === 'Death Calculator', 'Death Calculator shell should expose an accessible name.');
    assert(deathIntroState.beginLabel === 'Begin?', 'Death Calculator intro CTA should read Begin?.');

    await page.click('#deathBeginBtn');

    const deathSurveyStart = await page.evaluate(() => ({
      surveyHidden: document.getElementById('deathSurveyScreen')?.hasAttribute('hidden') ?? true,
      activeCard: document.querySelector('[data-question-card]:not([hidden])')?.getAttribute('data-question-card') ?? '',
      visibleCardCount: document.querySelectorAll('[data-question-card]:not([hidden])').length,
      hiddenCardDisplayCount: Array.from(document.querySelectorAll('[data-question-card][hidden]'))
        .filter((card) => window.getComputedStyle(card).display !== 'none')
        .length,
      progressText: document.getElementById('deathProgressText')?.textContent?.trim() ?? ''
    }));

    assert(deathSurveyStart.surveyHidden === false, 'Death Calculator should reveal the survey after Begin is clicked.');
    assert(deathSurveyStart.activeCard === 'birthDate', 'Death Calculator should begin on the birth-date card.');
    assert(deathSurveyStart.visibleCardCount === 1, 'Death Calculator should show exactly one question card at a time.');
    assert(deathSurveyStart.hiddenCardDisplayCount === 0, 'Hidden Death Calculator question cards should not occupy layout space.');
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

    await page.fill('#deathModerateDays', '4');
    await page.fill('#deathModerateMinutesSession', '45');
    await page.click('#deathNextBtn');

    await page.fill('#deathVigorousDays', '1');
    await page.fill('#deathVigorousMinutesSession', '40');
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

    const deathResultState = await page.evaluate(() => {
      const dateRect = document.getElementById('deathMedianDate')?.getBoundingClientRect();
      return {
        resultHidden: document.getElementById('deathResultScreen')?.hasAttribute('hidden') ?? true,
        medianDate: document.getElementById('deathMedianDate')?.textContent?.trim() ?? '',
        countdownDisplay: document.getElementById('deathCountdownDisplay')?.textContent?.trim() ?? '',
        disclaimer: document.getElementById('deathDisclaimer')?.textContent?.trim() ?? '',
        resultMeta: document.getElementById('deathResultMeta')?.textContent?.trim() ?? '',
        missingMoreInfoControls:
          document.getElementById('deathMoreInfoPanel') === null &&
          document.getElementById('deathMoreInfoBtn') === null &&
          document.getElementById('deathDetailsPanel') === null &&
          document.getElementById('deathDetailsBtn') === null,
        resultLabels: Array.from(document.querySelectorAll('.death-result-label')).map((node) => node.textContent?.trim() ?? ''),
        dateRect: dateRect ? { top: dateRect.top, bottom: dateRect.bottom } : null,
        viewportHeight: window.innerHeight,
        missingLegacyStats: document.getElementById('deathHazardMultiplier') === null
      };
    });

    assert(deathResultState.resultHidden === false, 'Death Calculator should reveal the result card after submission.');
    assert(deathResultState.medianDate && !/complete the survey/i.test(deathResultState.medianDate), 'Death Calculator should render a concrete median date.');
    assert(
      /^\d{2,}:\d{3}:\d{2}:\d{2}:\d{2}$/.test(deathResultState.countdownDisplay),
      'Death Calculator should render a unified labeled countdown in the expected format.'
    );
    assert(/not a medical diagnosis/i.test(deathResultState.disclaimer), 'Death Calculator should expose a clear disclaimer.');
    assert(/median projected date|survival curve/i.test(deathResultState.resultMeta), 'Death Calculator should explain the estimate briefly.');
    assert(deathResultState.missingMoreInfoControls === true, 'Death Calculator should not render stale More Info controls.');
    assert(deathResultState.resultLabels.includes('Estimated death date'), 'Death Calculator should present the estimated date label.');
    assert(deathResultState.resultLabels.includes('Death timer'), 'Death Calculator should present the countdown label.');
    assert(
      deathResultState.dateRect &&
        deathResultState.dateRect.top >= 0 &&
        deathResultState.dateRect.bottom <= deathResultState.viewportHeight,
      'Death Calculator should keep the result date visible after calculation.'
    );
    assert(deathResultState.missingLegacyStats === true, 'Death Calculator should remove the old analytics dashboard from the primary result.');

    const countdownBefore = deathResultState.countdownDisplay;
    await page.waitForTimeout(1200);
    const countdownAfter = await page.evaluate(() => document.getElementById('deathCountdownDisplay')?.textContent?.trim() ?? '');
    assert(countdownAfter !== countdownBefore, 'Death Calculator countdown should tick in real time.');

    await page.click('#deathResetBtn');
    const deathResetState = await page.evaluate(() => ({
      introHidden: document.getElementById('deathIntroScreen')?.hasAttribute('hidden') ?? true,
      statusText: (() => {
        const app = document.getElementById('deathCalculatorApp');
        const fromData = app?.dataset?.deathStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('deathStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
      birthDate: document.getElementById('deathBirthDate')?.value ?? '',
      medianDate: document.getElementById('deathMedianDate')?.textContent?.trim() ?? ''
    }));

    assert(deathResetState.introHidden === false, 'Death Calculator reset should return the user to the intro card.');
    assert(/local-only actuarial estimate|public-health evidence/i.test(deathResetState.statusText), 'Death Calculator reset should restore the intro copy.');
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
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
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
      resultStatus: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
      vmState: document.getElementById('retroVmApp')?.dataset.vmState ?? '',
      vmStatus: (() => {
        const app = document.getElementById('retroVmApp');
        return app?.dataset?.vmStatusMessage?.trim() ?? document.getElementById('retroVmStatusText')?.textContent?.trim() ?? '';
      })(),
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
