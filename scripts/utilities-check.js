#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium, firefox } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4175';
const BASE_URL = process.env.UTILITIES_CHECK_URL || DEFAULT_BASE_URL;
const BROWSER_NAME = process.env.UTILITIES_BROWSER === 'firefox' ? 'firefox' : 'chromium';
const CHROMIUM_WEBGL_ARGS = ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runUtilitySection(failures, name, callback) {
  try {
    await callback();
    console.log(`Utilities section passed: ${name}`);
  } catch (error) {
    failures.push({
      name,
      message: error?.message || String(error),
      stack: error?.stack || ''
    });
    console.error(`Utilities section failed: ${name}: ${error?.message || error}`);
  }
}

function throwIfUtilitySectionFailures(failures) {
  if (failures.length === 0) return;

  const summary = failures
    .map((failure) => `- ${failure.name}: ${failure.message}`)
    .join('\n');
  const firstStack = failures[0].stack ? `\n\nFirst failure stack:\n${failures[0].stack}` : '';
  throw new Error(`Utilities Playwright sections failed:\n${summary}${firstStack}`);
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

async function navigateUtility(page, utilityId) {
  await page.evaluate((id) => {
    if (window.location.hash !== `#${id}`) {
      window.location.hash = id;
    }
  }, utilityId);
  await page.waitForFunction(
    (id) => document.querySelector(`.utility-stage[data-utility-id="${id}"]`)?.classList.contains('is-active'),
    utilityId,
    { timeout: 10000 }
  );
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

async function readStarfieldState(page) {
  await page.waitForFunction(() => {
    const canvas = document.getElementById('starfield');
    return canvas instanceof HTMLCanvasElement && Number(canvas.dataset.starCount || '0') > 0;
  }, { timeout: 10000 });

  return page.evaluate(() => {
    const canvas = document.getElementById('starfield');
    return {
      count: Number(canvas?.dataset.starCount || '0'),
      mode: canvas?.dataset.starfieldMode || '',
      frames: Number(canvas?.dataset.starfieldFrameCount || '0')
    };
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

async function readUtilityIsolationMetrics(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!(element instanceof HTMLElement || element instanceof HTMLCanvasElement)) {
        return null;
      }
      const box = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        display: styles.display,
        visibility: styles.visibility,
        overflow: styles.overflow,
        visible: box.width > 0 && box.height > 0 && styles.display !== 'none' && styles.visibility !== 'hidden'
      };
    };

    const countActiveCanvasPixels = (canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) {
        return 0;
      }
      const context = canvas.getContext('2d');
      if (!context) {
        return 0;
      }
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let active = 0;
      for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset + 3] > 0 && (data[offset] > 4 || data[offset + 1] > 4 || data[offset + 2] > 4)) {
          active += 1;
        }
      }
      return active;
    };

    const describeAudioStage = (label, stageSelector, canvasSelector) => {
      const stage = document.querySelector(stageSelector);
      const canvas = document.querySelector(canvasSelector);
      const panel = stage?.closest('.canvas-panel') ?? null;
      return {
        label,
        stage: rect(stage),
        canvas: rect(canvas),
        panel: rect(panel),
        activePixels: countActiveCanvasPixels(canvas)
      };
    };

    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      roots: Array.from(document.querySelectorAll('[data-utility-root]')).map((element) => ({
        id: element.id,
        utility: element.getAttribute('data-utility-root') ?? '',
        active: Boolean(element.closest('.utility-stage')?.classList.contains('is-active')),
        rect: rect(element)
      })),
      audioStages: [
        describeAudioStage('waveform', '.audio-wave-stage', '#audioFourierWaveCanvas'),
        describeAudioStage('spectrum', '.canvas-panel--audio-spectrum .audio-spectrum-stage', '#audioFourierSpectrumCanvas'),
        describeAudioStage('component', '.canvas-panel--audio-component .audio-spectrum-stage', '#audioFourierComponentCanvas')
      ]
    };
  });
}

async function assertUtilityIsolationLayout(page, label) {
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('[data-utility-root]')).some((element) => {
      const rect = element.getBoundingClientRect();
      const styles = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && styles.visibility !== 'hidden' && styles.display !== 'none';
    });
  }, { timeout: 5000 });
  const state = await readUtilityIsolationMetrics(page);
  assert(state.scrollWidth === state.clientWidth, `[${label}] utilities page should not overflow horizontally.`);
  assert(state.roots.length >= 4, `[${label}] expected each utility to expose a data-utility-root marker.`);

  const visibleRoots = state.roots.filter((root) => root.active && root.rect?.visible);
  assert(visibleRoots.length >= 1, `[${label}] expected the active utility root to be visible.`);

  for (const root of visibleRoots) {
    assert(root.rect.left >= -1, `[${label}] ${root.utility || root.id} utility root overflows left.`);
    assert(
      root.rect.right <= state.viewport.width + 1,
      `[${label}] ${root.utility || root.id} utility root overflows right (${root.rect.right.toFixed(1)} > ${state.viewport.width}).`
    );
  }

  for (const item of state.audioStages) {
    if (!item.stage?.visible) {
      continue;
    }
    if (item.panel) {
      assert(item.panel.visible, `[${label}] Audio Fourier ${item.label} panel should be visible when the stage is visible.`);
      assert(item.stage.left >= item.panel.left - 1, `[${label}] Audio Fourier ${item.label} stage escapes its panel on the left.`);
      assert(item.stage.right <= item.panel.right + 1, `[${label}] Audio Fourier ${item.label} stage escapes its panel on the right.`);
    }
    assert(item.canvas?.visible, `[${label}] Audio Fourier ${item.label} canvas should be visible when the stage is visible.`);
    assert(item.canvas.left >= item.stage.left - 1, `[${label}] Audio Fourier ${item.label} canvas escapes its stage on the left.`);
    assert(item.canvas.right <= item.stage.right + 1, `[${label}] Audio Fourier ${item.label} canvas escapes its stage on the right.`);
    assert(item.canvas.width <= item.stage.width + 1, `[${label}] Audio Fourier ${item.label} canvas is wider than its stage.`);
    assert(item.canvas.height <= item.stage.height + 1, `[${label}] Audio Fourier ${item.label} canvas is taller than its stage.`);
    assert(item.activePixels > 100, `[${label}] Audio Fourier ${item.label} canvas should render a nonblank placeholder or signal.`);
  }
}

async function readStressCanvasStats(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('stressCanvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
      return { missing: true };
    }

    const sampler = document.createElement('canvas');
    sampler.width = 96;
    sampler.height = 54;
    const context = sampler.getContext('2d', { willReadFrequently: true });
    if (!context) {
      return { missing: false, readable: false };
    }

    context.clearRect(0, 0, sampler.width, sampler.height);
    context.drawImage(canvas, 0, 0, sampler.width, sampler.height);
    const pixels = context.getImageData(0, 0, sampler.width, sampler.height).data;
    let litPixels = 0;
    let opaquePixels = 0;
    let totalRgb = 0;
    let maxChannel = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      const brightness = red + green + blue;
      totalRgb += brightness;
      maxChannel = Math.max(maxChannel, red, green, blue);
      if (alpha > 0) {
        opaquePixels += 1;
      }
      if (alpha > 0 && brightness > 24) {
        litPixels += 1;
      }
    }

    return {
      missing: false,
      readable: true,
      idle: canvas.dataset.stressIdle ?? '',
      width: canvas.width,
      height: canvas.height,
      sampledPixels: sampler.width * sampler.height,
      litPixels,
      opaquePixels,
      totalRgb,
      maxChannel
    };
  });
}

async function assertStressCanvasActive(page, label) {
  const stats = await readStressCanvasStats(page);
  assert(!stats.missing, `[${label}] stress canvas is missing.`);
  assert(stats.readable !== false, `[${label}] stress canvas pixels should be readable in the browser check.`);
  assert(stats.width > 0 && stats.height > 0, `[${label}] stress canvas should have a positive drawing buffer.`);
  assert(stats.litPixels > 48, `[${label}] stress canvas should render nonblack output; stats=${JSON.stringify(stats)}.`);
  assert(stats.maxChannel > 24, `[${label}] stress canvas should contain visible color; stats=${JSON.stringify(stats)}.`);
}

async function assertStressCanvasIdle(page, label) {
  const stats = await readStressCanvasStats(page);
  assert(!stats.missing, `[${label}] stress canvas is missing.`);
  assert(stats.idle === 'true', `[${label}] stress canvas should mark its idle placeholder state.`);
  assert(stats.litPixels === 0, `[${label}] stopped stress canvas should be cleared; stats=${JSON.stringify(stats)}.`);
}

async function readStressLayoutMetrics(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement || element instanceof HTMLCanvasElement)) return null;
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        visible: box.width > 0 && box.height > 0
      };
    };
    const shell = document.getElementById('stressTestApp');
    const layout = document.querySelector('.stress-layout');
    const control = document.querySelector('.stress-control-panel');
    const visual = document.querySelector('.stress-visual-panel');
    const metrics = document.querySelector('.stress-metrics');
    const metricCards = Array.from(document.querySelectorAll('.stress-metrics > [data-stress-metric]'));
    const controlStyle = control instanceof HTMLElement ? getComputedStyle(control) : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      shell: rect('#stressTestApp'),
      layout: rect('.stress-layout'),
      control: rect('.stress-control-panel'),
      visual: rect('.stress-visual-panel'),
      metrics: rect('.stress-metrics'),
      shellScrollHeight: shell?.scrollHeight ?? 0,
      shellClientHeight: shell?.clientHeight ?? 0,
      layoutScrollWidth: layout?.scrollWidth ?? 0,
      layoutClientWidth: layout?.clientWidth ?? 0,
      controlScrollHeight: control?.scrollHeight ?? 0,
      controlClientHeight: control?.clientHeight ?? 0,
      controlOverflowY: controlStyle?.overflowY ?? '',
      hiddenMetricCount: metricCards.filter((card) => card.hasAttribute('hidden')).length,
      visibleMetricCount: metricCards.filter((card) => !card.hasAttribute('hidden')).length,
      metricsHidden: metrics?.hasAttribute('hidden') ?? false
    };
  });
}

async function assertStressLayout(page, label, options = {}) {
  const state = await readStressLayoutMetrics(page);
  assert(state.scrollWidth === state.clientWidth, `[${label}] stress utility should not create horizontal page overflow.`);
  assert(state.shell?.visible, `[${label}] stress shell should be visible.`);
  assert(state.layout?.visible, `[${label}] stress layout should be visible.`);
  assert(state.control?.visible, `[${label}] stress control panel should be visible.`);
  assert(state.visual?.visible, `[${label}] stress visual panel should be visible.`);
  assert(state.controlOverflowY !== 'auto' && state.controlOverflowY !== 'scroll', `[${label}] stress control panel should not be scrollable.`);
  if (options.expectMetricsHidden) {
    assert(state.metrics?.visible, `[${label}] stress metrics container should stay visible while individual cards are hidden.`);
    assert(state.hiddenMetricCount > 0, `[${label}] stress should hide only as many metric cards as needed when the control panel is too short.`);
    assert(state.visibleMetricCount > 0, `[${label}] stress should keep rendering metric cards that still fit.`);
  } else {
    assert(state.metrics?.visible, `[${label}] stress metrics should be visible.`);
    assert(state.visibleMetricCount > 0, `[${label}] stress should render metric cards that fit.`);
  }
  assert(state.shell.left >= -1, `[${label}] stress shell overflows left.`);
  assert(state.shell.right <= state.viewport.width + 1, `[${label}] stress shell overflows right.`);
  assert(state.shell.bottom <= state.viewport.height + 1, `[${label}] stress shell overflows below the viewport.`);
  assert(state.layoutScrollWidth <= state.layoutClientWidth + 1, `[${label}] stress layout should not overflow horizontally.`);
  if (options.requirePanelFit) {
    if (!options.expectMetricsHidden) {
      assert(state.metrics.bottom <= state.control.bottom + 1, `[${label}] stress metrics should not clip below the control panel.`);
    }
    assert(state.controlScrollHeight <= state.controlClientHeight + 1, `[${label}] stress control panel should fit without internal clipping.`);
  }
}

async function readLocalAssistantMetrics(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) return null;
      const box = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        display: styles.display,
        visibility: styles.visibility,
        overflowY: styles.overflowY,
        visible: box.width > 0 && box.height > 0 && styles.display !== 'none' && styles.visibility !== 'hidden'
      };
    };
    const overlaps = (a, b) => Boolean(
      a &&
      b &&
      a.visible &&
      b.visible &&
      a.left < b.right &&
      a.right > b.left &&
      a.top < b.bottom &&
      a.bottom > b.top
    );
    const shell = rect('#localLlmUtilityApp');
    const transcript = rect('#localLlmTranscript');
    const center = rect('#localLlmCenter');
    const thread = rect('#localLlmMessages');
    const form = rect('#localLlmForm');
    const input = rect('#localLlmInput');
    const progressWrap = rect('#localLlmProgressWrap');
    const shellElement = document.getElementById('localLlmUtilityApp');
    const shellStyles = shellElement ? getComputedStyle(shellElement) : null;
    const parseAlpha = (color) => {
      const match = String(color || '').match(/rgba?\(([^)]+)\)/);
      if (!match) return 1;
      const parts = match[1].split(',').map((part) => part.trim());
      if (parts.length === 4) return Number.parseFloat(parts[3]) || 0;
      return 1;
    };
    const status = shellElement?.dataset.localLlmStatus ?? '';
    const diagnostics = document.getElementById('localLlmDiagnostics');
    const centerDeltaFromTranscriptMiddle = center && transcript
      ? Math.abs(((center.top + center.bottom) / 2) - ((transcript.top + transcript.bottom) / 2))
      : null;

    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      status,
      shell,
      shellBackgroundColor: shellStyles?.backgroundColor ?? '',
      shellBackgroundAlpha: shellStyles ? parseAlpha(shellStyles.backgroundColor) : 0,
      shellOpacity: shellStyles ? Number.parseFloat(shellStyles.opacity || '1') : 1,
      transcript,
      center,
      thread,
      form,
      input,
      progressWrap,
      typingInBubble: Boolean(document.querySelector('#localLlmMessages .local-llm-typing')),
      typingInComposer: Boolean(document.querySelector('.local-llm-input-shell .local-llm-typing')),
      centerOverlapsForm: overlaps(center, form),
      centerDeltaFromTranscriptMiddle,
      threadOverlapsForm: overlaps(thread, form),
      formOutsideShell: Boolean(
        form &&
        shell &&
        (form.left < shell.left - 1 || form.right > shell.right + 1 || form.bottom > shell.bottom + 1)
      ),
      transcriptZeroHeight: !transcript || transcript.height <= 0,
      inputText: document.getElementById('localLlmInput')?.value ?? '',
      sendDisabled: document.querySelector('.local-llm-send')?.hasAttribute('disabled') ?? true,
      startText: document.querySelector('.local-llm-load-control-text')?.textContent?.trim() ?? '',
      resetText: document.getElementById('localLlmResetBtn')?.textContent?.trim() ?? '',
      messageText: document.getElementById('localLlmMessages')?.textContent?.trim() ?? '',
      loadCopyText: document.getElementById('localLlmLoadCopy')?.textContent?.trim() ?? '',
      modelNoteText: document.getElementById('localLlmModelNote')?.textContent?.trim() ?? '',
      inputPlaceholder: document.getElementById('localLlmInput')?.getAttribute('placeholder') ?? '',
      readyPromptHidden: document.getElementById('localLlmReadyPrompt')?.hasAttribute('hidden') ?? true,
      headerText: document.querySelector('.local-llm-header')?.textContent?.trim() ?? '',
      tpsText: document.getElementById('localLlmTps')?.textContent?.trim() ?? '',
      diagnosticsHidden: diagnostics?.hasAttribute('hidden') ?? true,
      diagnosticsText: diagnostics?.textContent?.trim() ?? ''
    };
  });
}

function assertLocalAssistantLayout(metrics, label) {
  assert(metrics.scrollWidth === metrics.clientWidth, `[${label}] Local Assistant should not create horizontal overflow.`);
  assert(metrics.shell?.visible, `[${label}] Local Assistant shell should be visible.`);
  assert(metrics.transcript?.visible, `[${label}] Local Assistant transcript should be visible.`);
  if (metrics.messageText) {
    assert(metrics.thread?.visible, `[${label}] Local Assistant thread should be visible when messages are present.`);
  }
  assert(metrics.form?.visible, `[${label}] Local Assistant composer should be visible.`);
  assert(metrics.input?.visible, `[${label}] Local Assistant input should be visible.`);
  assert(!metrics.transcriptZeroHeight, `[${label}] Local Assistant transcript should have usable height.`);
  assert(!metrics.centerOverlapsForm, `[${label}] Local Assistant loading/diagnostics panel overlaps the composer.`);
  assert(!metrics.threadOverlapsForm, `[${label}] Local Assistant thread overlaps the composer.`);
  assert(!metrics.formOutsideShell, `[${label}] Local Assistant composer escapes its shell.`);
  assert(metrics.shell.right <= metrics.viewport.width + 1, `[${label}] Local Assistant shell overflows viewport width.`);
  assert(!/auto|scroll/i.test(metrics.input.overflowY), `[${label}] Local Assistant textarea should not expose a vertical scrollbar.`);
  if (metrics.center?.visible && metrics.centerDeltaFromTranscriptMiddle !== null) {
    const tolerance = Math.max(32, metrics.transcript.height * 0.12);
    assert(
      metrics.centerDeltaFromTranscriptMiddle <= tolerance,
      `[${label}] Local Assistant center panel should be vertically centered.`
    );
  }
}

async function observeLocalAssistantLoadingSequence(page) {
  const expected = [
    'Loading Bonsai 1.7B',
    "Don't worry, I won't cache in your browser ;)"
  ];
  const spinnerFrames = new Set(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
  const observations = [];
  const progressTops = [];
  const busyControlTexts = [];
  let readyAt = null;
  let lastText = '';
  const startedAt = Date.now();

  while (Date.now() - startedAt < 8000) {
    const sample = await page.evaluate(() => {
      const root = document.getElementById('localLlmUtilityApp');
      const progressWrap = document.getElementById('localLlmProgressWrap');
      const progressRect = progressWrap?.getBoundingClientRect();
      const shellStyles = root ? getComputedStyle(root) : null;
      const parseAlpha = (color) => {
        const match = String(color || '').match(/rgba?\(([^)]+)\)/);
        if (!match) return 1;
        const parts = match[1].split(',').map((part) => part.trim());
        if (parts.length === 4) return Number.parseFloat(parts[3]) || 0;
        return 1;
      };
      return {
        status: root?.dataset.localLlmStatus ?? '',
        floorMs: Number(root?.dataset.localLlmLoadingFloorMs || '0'),
        text: document.getElementById('localLlmLoadCopy')?.textContent?.trim() ?? '',
        startText: document.querySelector('.local-llm-load-control-text')?.textContent?.trim() ?? '',
        progressTop: progressRect && progressRect.height > 0 ? progressRect.top : null,
        shellBackgroundAlpha: shellStyles ? parseAlpha(shellStyles.backgroundColor) : 0
      };
    });

    if (/^(checking|loading|optimizing)$/.test(sample.status) && sample.startText) {
      busyControlTexts.push(sample.startText);
    }

    if (sample.text && sample.text !== lastText) {
      observations.push({ text: sample.text, at: Date.now(), floorMs: sample.floorMs });
      lastText = sample.text;
    }

    if (sample.progressTop !== null && expected.includes(sample.text)) {
      progressTops.push(sample.progressTop);
    }

    if (sample.status === 'ready') {
      readyAt = Date.now();
      break;
    }

    await page.waitForTimeout(35);
  }

  const floorMs = observations.find((entry) => entry.floorMs > 0)?.floorMs ?? 0;
  const seen = observations
    .map((entry) => entry.text)
    .filter((text) => expected.includes(text));

  assert(
    expected.every((text, index) => seen[index] === text),
    `Local Assistant loading sequence should appear in order. Saw: ${seen.join(' -> ') || 'none'}`
  );
  assert(
    busyControlTexts.some((text) => spinnerFrames.has(text)),
    `Local Assistant load control should use a braille spinner while busy. Saw: ${busyControlTexts.join(', ') || 'none'}`
  );

  for (let index = 0; index < expected.length; index += 1) {
    const current = observations.find((entry) => entry.text === expected[index]);
    const next = observations.find((entry) => entry.text === expected[index + 1]);
    const endedAt = next?.at ?? readyAt;
    assert(current && endedAt, `Local Assistant loading copy timing missing for "${expected[index]}".`);
    assert(
      endedAt - current.at >= Math.max(0, floorMs - 100),
      `Local Assistant loading copy "${expected[index]}" changed too quickly.`
    );
  }

  if (progressTops.length >= 2) {
    const minTop = Math.min(...progressTops);
    const maxTop = Math.max(...progressTops);
    assert(
      maxTop - minTop <= 2,
      `Local Assistant progress bar should stay stable while loading copy changes. Saw ${minTop}px to ${maxTop}px.`
    );
  }

  return { observations, progressTops };
}

async function runLocalAssistantCheck(browser, pageUrl) {
  const readySuggestions = [
    'Perhaps a joke?',
    'Maybe a riddle?',
    'Summarize a topic perchance?',
    'How about a short story?',
    'Maybe something else entirely?'
  ];

  for (const viewport of [
    { label: 'desktop', width: 1440, height: 1100 },
    { label: 'tablet', width: 820, height: 1180 },
    { label: 'mobile', width: 390, height: 844 }
  ]) {
    const page = await browser.newPage({
      viewport: { width: viewport.width, height: viewport.height }
    });
    await page.addInitScript(() => {
      window.__OD_RETRO_VM_TEST_MODE__ = true;
      window.__OD_LOCAL_LLM_TEST_MODE__ = 'ready';
    });

    try {
      await page.goto(pageUrl.replace(/#.*$/, '#local-assistant'), { waitUntil: 'networkidle' });
      await page.waitForSelector('#localLlmStartBtn', { timeout: 10000 });
      const idleMetrics = await readLocalAssistantMetrics(page);
      assertLocalAssistantLayout(idleMetrics, `local-assistant:${viewport.label}:idle`);
      assert(idleMetrics.loadCopyText === 'Press "Load" to begin', `[local-assistant:${viewport.label}] idle copy should be simplified.`);
      assert(idleMetrics.shellBackgroundAlpha >= 0.5, `[local-assistant:${viewport.label}] idle shell should use a frosted background.`);

      await page.click('#localLlmStartBtn');
      await observeLocalAssistantLoadingSequence(page);

      await page.waitForFunction(
        () => document.getElementById('localLlmUtilityApp')?.dataset.localLlmStatus === 'ready',
        null,
        { timeout: 10000 }
      );
      const readyMetrics = await readLocalAssistantMetrics(page);
      assertLocalAssistantLayout(readyMetrics, `local-assistant:${viewport.label}:ready`);
      assert(readyMetrics.shellBackgroundAlpha >= 0.5, `[local-assistant:${viewport.label}] ready shell should keep the frosted background.`);
      assert(readyMetrics.center?.visible, `[local-assistant:${viewport.label}] ready empty-state panel should remain visible before the first message.`);
      assert(readyMetrics.sendDisabled === false, `[local-assistant:${viewport.label}] send should enable after mocked load.`);
      assert(readyMetrics.startText === 'Loaded', `[local-assistant:${viewport.label}] load control should report Loaded.`);
      assert(readySuggestions.includes(readyMetrics.loadCopyText), `[local-assistant:${viewport.label}] ready panel should show a suggestion from the bank.`);
      assert(readyMetrics.modelNoteText === '', `[local-assistant:${viewport.label}] ready panel should not show model/runtime details.`);
      assert(readyMetrics.inputPlaceholder === 'Oh, what to say...', `[local-assistant:${viewport.label}] composer placeholder should be static.`);
      assert(readyMetrics.readyPromptHidden === true, `[local-assistant:${viewport.label}] custom ready prompt overlay should stay hidden.`);
      assert(!readyMetrics.headerText.includes('•'), `[local-assistant:${viewport.label}] header metadata should not duplicate separators.`);

      if (viewport.label === 'desktop') {
        await page.fill('#localLlmInput', 'Explain this local assistant in one sentence.');
        await page.click('.local-llm-send');
        await page.waitForFunction(
          () => {
            const bubbleTyping = document.querySelector('#localLlmMessages .local-llm-typing');
            const composerTyping = document.querySelector('.local-llm-input-shell .local-llm-typing');
            return Boolean(bubbleTyping) && !composerTyping;
          },
          null,
          { timeout: 3000 }
        );
        await page.waitForFunction(
          () => /mocked Bonsai response/i.test(document.getElementById('localLlmMessages')?.textContent ?? ''),
          null,
          { timeout: 10000 }
        );
        const generatedMetrics = await readLocalAssistantMetrics(page);
        assertLocalAssistantLayout(generatedMetrics, 'local-assistant:desktop:generated');
        assert(!generatedMetrics.typingInComposer, 'Local Assistant thinking dots should not render in the composer.');
        assert(Math.abs(generatedMetrics.form.height - readyMetrics.form.height) <= 2, 'Local Assistant composer height should remain stable after generation.');
        assert(Math.abs(generatedMetrics.form.bottom - readyMetrics.form.bottom) <= 2, 'Local Assistant composer position should remain stable after generation.');
        assert(!generatedMetrics.center?.visible, 'Local Assistant center panel should stay hidden after generation.');
        assert(/Local Assistant/i.test(generatedMetrics.messageText), 'Local Assistant should render an assistant response.');
        assert(/\d|--/.test(generatedMetrics.tpsText), 'Local Assistant should expose token/sec telemetry.');

        await page.click('#localLlmResetBtn');
        await page.waitForFunction(() => document.getElementById('localLlmMessages')?.textContent?.trim() === '', null, {
          timeout: 10000
        });
        const resetMetrics = await readLocalAssistantMetrics(page);
        assert(resetMetrics.messageText === '', 'Local Assistant reset should clear the transcript.');
        assert(resetMetrics.inputText === '', 'Local Assistant reset should clear the composer.');
        assert(resetMetrics.status === 'ready', 'Local Assistant reset should keep the loaded model ready.');
      }
    } finally {
      await page.close();
    }
  }

  const unsupportedPage = await browser.newPage({ viewport: { width: 820, height: 900 } });
  await unsupportedPage.addInitScript(() => {
    window.__OD_LOCAL_LLM_TEST_MODE__ = 'unsupported';
  });

  try {
    await unsupportedPage.goto(pageUrl.replace(/#.*$/, '#local-assistant'), { waitUntil: 'networkidle' });
    await unsupportedPage.waitForSelector('#localLlmStartBtn', { timeout: 10000 });
    await unsupportedPage.click('#localLlmStartBtn');
    await unsupportedPage.waitForFunction(
      () => document.getElementById('localLlmUtilityApp')?.dataset.localLlmStatus === 'unsupported',
      null,
      { timeout: 10000 }
    );
    const unsupportedMetrics = await readLocalAssistantMetrics(unsupportedPage);
    assertLocalAssistantLayout(unsupportedMetrics, 'local-assistant:unsupported');
    assert(unsupportedMetrics.diagnosticsHidden === false, 'Unsupported Local Assistant should render diagnostics.');
    assert(/browser|webgpu|chrome|edge/i.test(unsupportedMetrics.diagnosticsText), 'Unsupported Local Assistant diagnostics should be actionable.');
    await unsupportedPage.click('[data-local-llm-retry]');
    await unsupportedPage.waitForFunction(() => /retry|unsupported|browser/i.test(document.getElementById('localLlmDiagnostics')?.textContent ?? ''), {
      timeout: 10000
    });
  } finally {
    await unsupportedPage.close();
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
        describe('audio progress copy', '#audioFourierProgressText'),
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
    { label: 'tablet', width: 820, height: 1180 },
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
      await assertUtilityIsolationLayout(page, `light:${viewport.label}`);

      for (const metric of state.metrics) {
        if (metric.missing && /audio|longevity|retro vm/.test(metric.label)) {
          continue;
        }
        assert(!metric.missing, `[light:${viewport.label}] missing ${metric.label}.`);
        if (!metric.visible && /audio|longevity|retro vm/.test(metric.label)) {
          continue;
        }
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
        }
      }

      const lightDarkSurfaceLeakCount = state.metrics.filter((metric) =>
        metric.visible &&
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
    const screen = document.getElementById('retroVmScreen');
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
      placeholderHidden: placeholder?.classList.contains('is-hidden') ?? false,
      placeholderPointerEvents: placeholder instanceof HTMLElement ? getComputedStyle(placeholder).pointerEvents : '',
      screenFocused: document.activeElement === screen
    };
  });
}

async function readRetroVmFullscreenMetrics(page) {
  return page.evaluate(() => {
    const shell = document.getElementById('retroVmScreenShell');
    const screen = document.getElementById('retroVmScreen');
    const toolbar = document.querySelector('.vm-toolbar');
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
      chromeDisplay: toolbar instanceof HTMLElement ? getComputedStyle(toolbar).display : '',
      bezelPadding: '0px'
    };
  });
}

async function main() {
  const server = await startLocalStaticServer({
    url: BASE_URL,
    cwd: ROOT
  });
  const baseUrl = server?.url || BASE_URL;

  const browserType = BROWSER_NAME === 'firefox' ? firefox : chromium;
  const browser = await browserType.launch({
    headless: true,
    args: BROWSER_NAME === 'chromium' ? CHROMIUM_WEBGL_ARGS : undefined
  });
  const utilitySectionFailures = [];

  try {
    await waitForServer(`${baseUrl}/pages/utilities/index.html`);

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    const starfieldInitializationErrors = [];
    page.on('console', (message) => {
      const text = message.text();
      if (/STARFIELD_CONFIG|starfield worker renderer unavailable/i.test(text)) {
        starfieldInitializationErrors.push(text);
      }
    });
    page.on('pageerror', (error) => {
      if (/STARFIELD_CONFIG|starfield/i.test(error.message)) {
        starfieldInitializationErrors.push(error.message);
      }
    });
    await page.addInitScript(() => {
      window.__OD_RETRO_VM_TEST_MODE__ = true;
      window.__OD_STRESS_TEST_MAX_WORKERS__ = 2;
      window.__OD_LOCAL_LLM_TEST_MODE__ = 'ready';
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

    const pageUrl = `${baseUrl}/pages/utilities/index.html#image-transform`;
    await loadUtilitiesPage(page, pageUrl, 'Built-in pair selected|Ready for input', 15000, 'initial transform state');
    assert(
      starfieldInitializationErrors.length === 0,
      `Starfield should initialize without worker setup errors. Saw: ${starfieldInitializationErrors.join(' | ')}`
    );
    await assertUtilityIsolationLayout(page, 'initial:desktop');
    const sourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'source.png');
    const targetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'target.png');
    const whiteHeavySourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-source.png');
    const whiteHeavyTargetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-target.png');

    await runUtilitySection(utilitySectionFailures, 'Image Transform', async () => {
      const initialStarfield = await readStarfieldState(page);

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
      playAria: document.getElementById('transformPlayBtn')?.getAttribute('aria-label') ?? '',
      replayButtonExists: Boolean(document.getElementById('transformReplayBtn')),
      uploadIconCount: document.querySelectorAll('.utility-dropzone-icon').length,
      activeDemo: document.querySelector('.demo-chip.active')?.textContent?.trim() ?? '',
      generateDisabled: document.getElementById('transformGenerateBtn')?.hasAttribute('disabled') ?? true,
      supportPanelsDisplay: getComputedStyle(document.querySelector('#utilitiesApp .support-panels')).display,
      hasResult: document.getElementById('utilitiesApp')?.dataset.transformHasResult ?? ''
    }));

    assert(
      initialTransformState.status && /built-in pair selected|ready for input/i.test(initialTransformState.status),
      'Image Transform should start idle with a selected built-in pair.'
    );
    assert(initialTransformState.outputSize === '—', 'Initial transform metrics should stay blank until generate is clicked.');
    assert(initialTransformState.pixels === '—', 'Initial transform pixel count should stay blank until generate is clicked.');
    assert(initialTransformState.playLabel === '▶', 'Primary playback control should remain icon-only before generation.');
    assert(initialTransformState.playAria === 'Play animation', 'Primary playback control should expose Play before generation.');
    assert(initialTransformState.replayButtonExists === false, 'Dedicated replay button should not be rendered.');
    assert(initialTransformState.uploadIconCount === 3, 'Utilities upload dropzones should expose visible upload icons.');
    assert(initialTransformState.activeDemo === 'Pattern → Face', 'Pattern → Face should be selected by default.');
    assert(initialTransformState.generateDisabled === false, 'Generate should be available when the built-in pair is preselected.');
    assert(initialTransformState.hasResult !== 'true', 'Image Transform should not report a result before generation.');
    assert(initialTransformState.supportPanelsDisplay === 'none', 'Image Transform source/reference panels should stay hidden before generation.');
    assert(precomputedTransformRequests.length === 0, 'Initial load should not fetch precomputed demo transforms.');

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
    const activeTransformStarfield = await readStarfieldState(page);
    await waitForStatusMatch(page, 'Transform ready|Animation complete|Reduced motion', 30000);
    await waitForProgressFill(page, 90, 20000);
    const completedTransformStarfield = await readStarfieldState(page);

    assert(
      activeTransformStarfield.count === initialStarfield.count &&
        completedTransformStarfield.count === initialStarfield.count,
      'Starfield density should remain stable before, during, and after image transform animation.'
    );

    const afterDemo = await page.evaluate(() => ({
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      pixels: document.getElementById('transformPixelCount')?.textContent?.trim(),
      playLabel: document.getElementById('transformPlayBtn')?.textContent?.trim(),
      playAria: document.getElementById('transformPlayBtn')?.getAttribute('aria-label') ?? '',
      supportPanelsDisplay: getComputedStyle(document.querySelector('#utilitiesApp .support-panels')).display,
      hasResult: document.getElementById('utilitiesApp')?.dataset.transformHasResult ?? ''
    }));

    assert(afterDemo.status && /Transform ready|Animation complete|Reduced motion/i.test(afterDemo.status), 'Built-in demo did not initialize after generate.');
    assert(afterDemo.outputSize && afterDemo.outputSize !== '—', 'Built-in demo output size missing after generate.');
    assert(afterDemo.pixels && afterDemo.pixels !== '—', 'Built-in demo pixel count missing after generate.');
    assert(afterDemo.playLabel === '↻', 'Primary playback control should switch to replay icon after the built-in animation runs.');
    assert(afterDemo.playAria === 'Replay animation', 'Primary playback control should expose Replay after the built-in animation runs.');
    assert(afterDemo.hasResult === 'true', 'Image Transform should report a result after generation.');
    assert(afterDemo.supportPanelsDisplay === 'none', 'Image Transform compatibility support panels should stay hidden in the compact redesign.');
    assert(precomputedTransformRequests.length > 0, 'Built-in demo generation should fetch a shipped precomputed transform asset.');

    await page.evaluate(() => window.scrollTo(0, 0));
    const desktopLayout = await readLayoutMetrics(page);
    assert(desktopLayout.scrollWidth === desktopLayout.clientWidth, 'Utilities page should not overflow horizontally.');
    if (desktopLayout.hero || desktopLayout.heroTitle) {
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
    }
    assert(desktopLayout.shell && desktopLayout.shell.height < 1700, 'Utilities shell is still too tall for comfortable desktop viewing.');
    assert(
      desktopLayout.stage && desktopLayout.stage.height <= desktopLayout.viewport.height,
      'Reconstruction stage should fit within the active desktop viewport.'
    );
    assert(
      desktopLayout.panel &&
        desktopLayout.stage &&
        desktopLayout.canvas &&
        desktopLayout.stage.right <= desktopLayout.panel.right + 1 &&
        desktopLayout.canvas.right <= desktopLayout.panel.right + 1,
      'Reconstruction stage or canvas exceeds the right edge of its panel.'
    );

    const colorModeDisabled = await page.evaluate(() => {
      const attr = document.documentElement.getAttribute('data-disable-color-mode');
      return attr != null && attr !== 'false';
    });

    if (!colorModeDisabled) {
      await runLightModeVisualCheck(browser, pageUrl);
    }

    const finalResultPixels = await readCanvasPixels(page, 'transformResultCanvas');
    const sourceStagePixels = await readCanvasPixels(page, 'transformSourceCanvas');
    await page.click('#transformPlayBtn');
    await waitForStatusMatch(page, 'Animating', 5000);
    await waitForProgressFill(page, 65, 15000);

    let midAnimationPixels = await readCanvasPixels(page, 'transformResultCanvas');
    let matchingFinalPixels = countMatchingPixels(midAnimationPixels, finalResultPixels);
    let differenceToFinal = totalAbsoluteDifference(midAnimationPixels, finalResultPixels);
    let differenceToSource = totalAbsoluteDifference(midAnimationPixels, sourceStagePixels);
    if (differenceToSource === 0 || differenceToFinal === 0) {
      await page.waitForTimeout(250);
      midAnimationPixels = await readCanvasPixels(page, 'transformResultCanvas');
      matchingFinalPixels = countMatchingPixels(midAnimationPixels, finalResultPixels);
      differenceToFinal = totalAbsoluteDifference(midAnimationPixels, finalResultPixels);
      differenceToSource = totalAbsoluteDifference(midAnimationPixels, sourceStagePixels);
    }

    assert(countActiveCanvasPixels(midAnimationPixels) > 100, 'Mid-animation result should render an active frame.');
    if (differenceToFinal > 0) {
      assert(
        matchingFinalPixels < midAnimationPixels.length / 4,
        'Mid-animation result should not already be identical to the final image.'
      );
    }

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
    assert(staleState.resultMeta === '', 'Selecting a new source should keep result helper copy hidden in the minimal layout.');

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
    });

    await runUtilitySection(utilitySectionFailures, 'Local Assistant', async () => {
      await runLocalAssistantCheck(browser, pageUrl);
    });

    await runUtilitySection(utilitySectionFailures, 'Audio Fourier', async () => {
      await navigateUtility(page, 'audio-fourier');
      await page.waitForFunction(() => document.getElementById('audioFourierSelection')?.textContent?.trim().length);

    const initialAudioState = await page.evaluate(() => ({
      status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
      selected: document.getElementById('audioFourierSelection')?.textContent?.trim() ?? '',
      sampleRate: document.getElementById('audioFourierSampleRate')?.textContent?.trim() ?? '',
      componentCount: document.getElementById('audioFourierComponentCount')?.textContent?.trim() ?? '',
      resultMeta: document.getElementById('audioFourierResultMeta')?.textContent?.trim() ?? '',
      sliderDisabled: document.getElementById('audioFourierComponentSlider')?.hasAttribute('disabled') ?? false,
      generateDisabled: document.getElementById('audioFourierGenerateBtn')?.hasAttribute('disabled') ?? true,
      playDisabled: document.getElementById('audioFourierPlayBtn')?.hasAttribute('disabled') ?? false,
      telemetryPresent: Boolean(document.getElementById('audioFourierApp')?.dataset.audioLastRequestId)
    }));

    assert(/choose|track|audio/i.test(initialAudioState.status), 'Audio Fourier should start idle.');
    assert(initialAudioState.selected === 'Best Friends', 'Audio Fourier should default to the Best Friends song preset.');
    assert(initialAudioState.sampleRate === '—', 'Audio Fourier sample-rate metric should stay blank before generation.');
    assert(initialAudioState.componentCount === '—', 'Audio Fourier component count should stay blank before generation.');
    assert(initialAudioState.resultMeta === '', 'Audio Fourier waveform viewport should not show instructional copy before generation.');
    assert(initialAudioState.sliderDisabled === true, 'Audio Fourier component slider should stay disabled before generation.');
    assert(initialAudioState.generateDisabled === false, 'Audio Fourier generate should be available for the default preset.');
    assert(initialAudioState.playDisabled === true, 'Audio Fourier playback should be disabled before generation.');
    assert(initialAudioState.telemetryPresent === false, 'Audio Fourier should not analyze audio on first paint.');

    await page.selectOption('#audioFourierQuality', 'fast');
    await page.click('[data-audio-preset="best-friends"]');
    await page.click('#audioFourierGenerateBtn');
    await waitForAudioStatusMatch(page, 'Fourier proxy ready|auditory midpoint|Playing selected|Press Play', 60000, 'built-in song preset ready');
    await waitForAudioStatusMatch(page, 'Playing selected Fourier energy mix', 5000, 'built-in song preset autoplay starts');

    const generatedReadyState = await page.evaluate(() => ({
      status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
      audioState: document.getElementById('audioFourierApp')?.dataset.audioState ?? '',
      sampleRate: document.getElementById('audioFourierSampleRate')?.textContent?.trim() ?? '',
      componentCount: document.getElementById('audioFourierComponentCount')?.textContent?.trim() ?? '',
      sourceDuration: document.getElementById('audioFourierSourceDuration')?.textContent?.trim() ?? '',
      resultMeta: document.getElementById('audioFourierResultMeta')?.textContent?.trim() ?? '',
      sliderDisabled: document.getElementById('audioFourierComponentSlider')?.hasAttribute('disabled') ?? true,
      sliderMin: document.getElementById('audioFourierComponentSlider')?.getAttribute('min') ?? '',
      sliderMax: document.getElementById('audioFourierComponentSlider')?.getAttribute('max') ?? '',
      sliderValue: document.getElementById('audioFourierComponentSlider')?.value ?? '',
      sliderProgress: document.getElementById('audioFourierComponentSlider')?.style.getPropertyValue('--audio-slider-progress') ?? '',
      componentReadout: document.getElementById('audioFourierComponentReadout')?.textContent?.trim() ?? '',
      signalStrength: document.getElementById('audioFourierSignalStrengthMetric')?.textContent?.trim() ?? '',
      signalCount: document.getElementById('audioFourierSignalCountMetric')?.textContent?.trim() ?? '',
      playText: document.getElementById('audioFourierPlayBtn')?.textContent?.trim() ?? '',
      playLabel: document.getElementById('audioFourierPlayBtn')?.getAttribute('aria-label') ?? '',
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

    assert(/playing/i.test(generatedReadyState.status), 'Built-in Audio Fourier song preset should autoplay after analysis.');
    assert(generatedReadyState.audioState === 'animating', 'Built-in Audio Fourier song preset should enter animating state after autoplay.');
    assert(/\d+ Hz proxy/.test(generatedReadyState.sampleRate), 'Audio Fourier proxy sample-rate metric missing after preset generation.');
    assert(generatedReadyState.componentCount !== '—', 'Audio Fourier component count missing after preset generation.');
    assert(/source/.test(generatedReadyState.sourceDuration), 'Audio Fourier source duration missing after preset generation.');
    assert(generatedReadyState.resultMeta === '', 'Audio Fourier viewport explanatory copy should be removed after generation.');
    assert(generatedReadyState.sliderDisabled === false, 'Audio Fourier component slider should be enabled after generation.');
    assert(generatedReadyState.sliderMin === '0', 'Audio Fourier slider minimum should represent sparse signal energy.');
    assert(generatedReadyState.sliderMax === '100', 'Audio Fourier slider max should represent 100% signal energy.');
    assert(generatedReadyState.sliderValue === '50', 'Audio Fourier slider should start at the physical midpoint.');
    assert(generatedReadyState.sliderProgress.trim() === '50%', 'Audio Fourier slider should publish visual track progress.');
    assert(/80% signal energy/.test(generatedReadyState.componentReadout), 'Audio Fourier midpoint should land near the auditory midpoint.');
    assert(generatedReadyState.signalStrength === '80%', 'Audio Fourier signal strength card should show the midpoint energy.');
    assert(/\d[\d,]* \/ \d[\d,]*/.test(generatedReadyState.signalCount), 'Audio Fourier signal count card should show active and total signals.');
    assert(generatedReadyState.playText === '⏸', 'Audio Fourier play control should remain icon-only and show pause while playing.');
    assert(generatedReadyState.playLabel === 'Pause', 'Audio Fourier play control should expose an accessible Pause label while playing.');
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
    await assertUtilityIsolationLayout(page, 'audio-preset:desktop');

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(120);
    const compactAudioLayout = await page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const box = element.getBoundingClientRect();
        const styles = window.getComputedStyle(element);
        return {
          visible: box.width > 0 && box.height > 0 && styles.display !== 'none' && styles.visibility !== 'hidden',
          display: styles.display
        };
      };
      return {
        scrollHeight: document.documentElement.scrollHeight,
        clientHeight: document.documentElement.clientHeight,
        htmlOverflow: getComputedStyle(document.documentElement).overflow,
        bodyOverflow: getComputedStyle(document.body).overflow,
        signals: rect('.audio-metric-card--signals'),
        strength: rect('.audio-metric-card--strength')
      };
    });
    assert(compactAudioLayout.scrollHeight <= compactAudioLayout.clientHeight + 1, 'Audio Fourier compact layout should not make the page scroll.');
    assert(/hidden/.test(`${compactAudioLayout.htmlOverflow} ${compactAudioLayout.bodyOverflow}`), 'Audio Fourier compact layout should keep document scrolling disabled.');
    assert(compactAudioLayout.signals?.visible === false, 'Audio Fourier should hide signals metric first on short layouts.');
    assert(compactAudioLayout.strength?.visible === true, 'Audio Fourier should keep signal strength visible before hiding lower-priority metrics.');

    await page.setViewportSize({ width: 1280, height: 640 });
    await page.waitForTimeout(120);
    const shortAudioLayout = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      signalsVisible: (() => {
        const element = document.querySelector('.audio-metric-card--signals');
        return Boolean(element && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none');
      })(),
      strengthVisible: (() => {
        const element = document.querySelector('.audio-metric-card--strength');
        return Boolean(element && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none');
      })()
    }));
    assert(shortAudioLayout.scrollHeight <= shortAudioLayout.clientHeight + 1, 'Audio Fourier short layout should not make the page scroll.');
    assert(shortAudioLayout.signalsVisible === false, 'Audio Fourier short layout should keep signals hidden.');
    assert(shortAudioLayout.strengthVisible === true, 'Audio Fourier short layout should keep signal strength visible.');

    await page.setViewportSize({ width: 1280, height: 540 });
    await page.waitForTimeout(120);
    const shortestAudioLayout = await page.evaluate(() => ({
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
      signalsVisible: (() => {
        const element = document.querySelector('.audio-metric-card--signals');
        return Boolean(element && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none');
      })(),
      strengthVisible: (() => {
        const element = document.querySelector('.audio-metric-card--strength');
        return Boolean(element && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none');
      })()
    }));
    assert(shortestAudioLayout.scrollHeight <= shortestAudioLayout.clientHeight + 1, 'Audio Fourier shortest layout should not make the page scroll.');
    assert(shortestAudioLayout.signalsVisible === false, 'Audio Fourier shortest layout should keep signals hidden.');
    assert(shortestAudioLayout.strengthVisible === false, 'Audio Fourier shortest layout should hide signal strength only in cramped layouts.');

    await page.setViewportSize({ width: 2048, height: 998 });
    await page.waitForTimeout(120);
    const prePlaybackWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    if (generatedReadyState.playDisabled === false) {
      await page.click('#audioFourierPlayBtn');
      await waitForAudioStatusMatch(page, 'Playing selected Fourier energy mix', 5000, 'built-in song preset playback starts');
    }
    await page.waitForTimeout(350);
    const playbackWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    assert(totalAbsoluteDifference(prePlaybackWavePixels, playbackWavePixels) > 0, 'Audio Fourier viewport should advance during playback.');
    await page.fill('#audioFourierComponentSlider', '20');
    await page.waitForTimeout(120);
    const sliderDuringPlaybackState = await page.evaluate(() => ({
      status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
      readout: document.getElementById('audioFourierComponentReadout')?.textContent?.trim() ?? '',
      signalStrength: document.getElementById('audioFourierSignalStrengthMetric')?.textContent?.trim() ?? ''
    }));
    assert(/Playing selected Fourier energy mix/.test(sliderDuringPlaybackState.status), 'Audio Fourier slider should not stop playback.');
    assert(/60% signal energy/.test(sliderDuringPlaybackState.readout), 'Audio Fourier readout should update with perceptual slider mapping during playback.');
    assert(sliderDuringPlaybackState.signalStrength === '60%', 'Audio Fourier signal strength metric should update during playback.');
    const preRapidSliderPixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    await page.evaluate(async () => {
      const slider = document.getElementById('audioFourierComponentSlider');
      if (!(slider instanceof HTMLInputElement)) {
        throw new Error('Audio Fourier slider missing.');
      }
      for (const value of [5, 35, 70, 25, 95, 45, 80]) {
        slider.value = String(value);
        slider.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    });
    await page.waitForTimeout(180);
    const postRapidSliderPixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    const rapidSliderState = await page.evaluate(() => ({
      audioState: document.getElementById('audioFourierApp')?.dataset.audioState ?? '',
      status: document.getElementById('audioFourierStatusText')?.textContent?.trim() ?? '',
      signalStrength: document.getElementById('audioFourierSignalStrengthMetric')?.textContent?.trim() ?? ''
    }));
    assert(rapidSliderState.audioState === 'animating', 'Rapid Audio Fourier slider changes should keep playback animating.');
    assert(/Playing selected Fourier energy mix/.test(rapidSliderState.status), 'Rapid Audio Fourier slider changes should not interrupt playback status.');
    assert(rapidSliderState.signalStrength === '92%', 'Rapid Audio Fourier slider changes should update signal strength after the final value.');
    assert(totalAbsoluteDifference(preRapidSliderPixels, postRapidSliderPixels) > 0, 'Rapid Audio Fourier slider changes should keep waveform rendering live.');
    await page.click('#audioFourierPauseBtn');
    await waitForAudioStatusMatch(page, 'Playback paused', 5000, 'built-in song preset playback pauses');

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
    });

    await runUtilitySection(utilitySectionFailures, 'Stress Test', async () => {
      await page.setViewportSize({ width: 2048, height: 998 });
      await navigateUtility(page, 'stress-test');
      await assertStressLayout(page, 'stress:desktop:idle', { requirePanelFit: true });

    const stressInitialState = await page.evaluate(() => ({
      state: document.getElementById('stressTestApp')?.dataset.stressState ?? '',
      mode: document.getElementById('stressTestApp')?.dataset.stressMode ?? '',
      workerCount: document.getElementById('stressTestApp')?.dataset.stressWorkerCount ?? '',
      backend: document.getElementById('stressTestApp')?.dataset.stressGpuBackend ?? '',
      startDisabled: document.getElementById('stressStartBtn')?.hasAttribute('disabled') ?? true,
      stopDisabled: document.getElementById('stressStopBtn')?.hasAttribute('disabled') ?? false,
      status: document.getElementById('stressStatusText')?.textContent?.trim() ?? ''
    }));

    assert(stressInitialState.state === 'idle', 'Stress Test should start idle.');
    assert(stressInitialState.mode === 'both', 'Stress Test should default to Both mode.');
    assert(stressInitialState.workerCount === '0', 'Stress Test should not start CPU workers on activation.');
    assert(stressInitialState.backend === 'none', 'Stress Test should not start GPU work on activation.');
    assert(stressInitialState.startDisabled === false, 'Stress Test start should be available when idle.');
    assert(stressInitialState.stopDisabled === true, 'Stress Test stop should stay disabled when idle.');
    assert(/hot|loud|slow|power/i.test(stressInitialState.status), 'Stress Test warning copy should be visible before start.');

    await page.setViewportSize({ width: 1024, height: 520 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(250);
    const shortStressLayout = await readStressLayoutMetrics(page);
    assert(shortStressLayout.controlOverflowY !== 'auto' && shortStressLayout.controlOverflowY !== 'scroll', 'Short Stress Test control panel should not be scrollable.');
    assert(shortStressLayout.visibleMetricCount > 0, 'Short Stress Test control panel should keep rendering the metric cards that fit.');
    await page.setViewportSize({ width: 2048, height: 998 });
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(250);
    await assertStressLayout(page, 'stress:desktop:idle-restored', { requirePanelFit: true });

    await page.click('[data-stress-mode-option="cpu"]');
    const stressCpuMode = await page.evaluate(() => document.getElementById('stressTestApp')?.dataset.stressMode ?? '');
    assert(stressCpuMode === 'cpu', 'Stress Test mode selector should update data-stress-mode.');

    await page.click('#stressStartBtn');
    await page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressState === 'running', null, {
      timeout: 10000
    });
    await page.waitForFunction(() => Number(document.getElementById('stressTestApp')?.dataset.stressWorkerCount ?? '0') > 0, null, {
      timeout: 10000
    });

    const stressRunningState = await page.evaluate(() => ({
      state: document.getElementById('stressTestApp')?.dataset.stressState ?? '',
      workers: document.getElementById('stressTestApp')?.dataset.stressWorkerCount ?? '',
      backend: document.getElementById('stressTestApp')?.dataset.stressGpuBackend ?? '',
      stopDisabled: document.getElementById('stressStopBtn')?.hasAttribute('disabled') ?? true
    }));

    assert(stressRunningState.state === 'running', 'Stress Test should enter running state after Start.');
    assert(stressRunningState.workers === '2', 'Stress Test browser check should honor the worker-count test cap.');
    assert(stressRunningState.backend === 'none', 'CPU-only Stress Test should not start GPU work.');
    assert(stressRunningState.stopDisabled === false, 'Stress Test stop should enable while running.');
    await page.waitForFunction(() => {
      const app = document.getElementById('stressTestApp');
      return Number(app?.dataset.stressTotalRenderedFrames ?? '0') >= 2 && app?.dataset.stressCanvasActive === 'true';
    }, null, {
      timeout: 10000
    });
    const stressCpuVisualText = await page.evaluate(() => document.getElementById('stressTestApp')?.dataset.stressCpuVisualText ?? '');
    assert(
      stressCpuVisualText === '' || /^(For visual effect only|Just a cool graphic)$/.test(stressCpuVisualText),
      'CPU Stress Test visual-effect text should be empty or one of the expected phrases.'
    );
    await assertStressCanvasActive(page, 'stress:cpu:running');
    await assertStressLayout(page, 'stress:desktop:cpu-running', { requirePanelFit: true });

    await page.click('#stressStopBtn');
    await page.waitForFunction(() => /^(idle|stopped)$/.test(document.getElementById('stressTestApp')?.dataset.stressState ?? ''), null, {
      timeout: 10000
    });
    const stressStoppedState = await page.evaluate(() => ({
      state: document.getElementById('stressTestApp')?.dataset.stressState ?? '',
      workers: document.getElementById('stressTestApp')?.dataset.stressWorkerCount ?? '',
      backend: document.getElementById('stressTestApp')?.dataset.stressGpuBackend ?? ''
    }));

    assert(/^(idle|stopped)$/.test(stressStoppedState.state), 'Stress Test should return to an inactive state after Stop.');
    assert(stressStoppedState.workers === '0', 'Stress Test should clear workers after Stop.');
    assert(stressStoppedState.backend === 'none', 'Stress Test should clear GPU backend after Stop.');
    await assertStressCanvasIdle(page, 'stress:cpu:stopped');

    await page.click('[data-stress-mode-option="gpu"]');
    await page.click('#stressStartBtn');
    await page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressState === 'running', null, {
      timeout: 10000
    });
    await page.waitForFunction(() => {
      const app = document.getElementById('stressTestApp');
      return (
        app &&
        app.dataset.stressGpuBackend &&
        app.dataset.stressGpuBackend !== 'none' &&
        Number(app.dataset.stressTotalRenderedFrames ?? '0') >= 2 &&
        Number(app.dataset.stressGpuWorkloadLevel ?? '0') >= 1 &&
        app.dataset.stressGpuCanvasActive === 'true'
      );
    }, null, { timeout: 12000 });
    const stressGpuState = await page.evaluate(() => ({
      state: document.getElementById('stressTestApp')?.dataset.stressState ?? '',
      backend: document.getElementById('stressTestApp')?.dataset.stressGpuBackend ?? '',
      frames: Number(document.getElementById('stressTestApp')?.dataset.stressTotalRenderedFrames ?? '0'),
      workload: Number(document.getElementById('stressTestApp')?.dataset.stressGpuWorkloadLevel ?? '0'),
      activeCanvas: document.getElementById('stressTestApp')?.dataset.stressGpuCanvasActive ?? ''
    }));

    assert(stressGpuState.state === 'running', 'GPU Stress Test should enter running state.');
    assert(
      /^(webgpu-compute|webgl2-fragment|webgl1-fragment)$/.test(stressGpuState.backend),
      `GPU Stress Test should select a browser GPU backend, got ${stressGpuState.backend}.`
    );
    assert(stressGpuState.frames >= 2, 'GPU Stress Test should render multiple GPU frames.');
    assert(stressGpuState.workload >= 1, 'GPU Stress Test should expose a positive workload level.');
    assert(stressGpuState.activeCanvas === 'true', 'GPU Stress Test should report active GPU canvas output.');
    await assertStressCanvasActive(page, 'stress:gpu:running');
    await assertStressLayout(page, 'stress:desktop:gpu-running', { requirePanelFit: true });

    await page.click('#stressStopBtn');
    await page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressState === 'idle', null, {
      timeout: 10000
    });
    await page.setViewportSize({ width: 1440, height: 1100 });

    const webGl1Page = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    await webGl1Page.addInitScript(() => {
      window.__OD_STRESS_TEST_MAX_WORKERS__ = 1;
      Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: undefined
      });
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
        if (type === 'webgl2') {
          return null;
        }
        return originalGetContext.call(this, type, ...args);
      };
    });
    await webGl1Page.goto(`${baseUrl}/pages/utilities/index.html#stress-test`, { waitUntil: 'networkidle' });
    await webGl1Page.waitForFunction(
      () => document.querySelector('.utility-stage[data-utility-id="stress-test"]')?.classList.contains('is-active'),
      { timeout: 10000 }
    );
    await webGl1Page.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 10000 });
    await webGl1Page.click('[data-stress-mode-option="gpu"]');
    await webGl1Page.click('#stressStartBtn');
    await webGl1Page.waitForFunction(() => {
      const app = document.getElementById('stressTestApp');
      return (
        app?.dataset.stressState === 'running' &&
        app.dataset.stressGpuBackend === 'webgl1-fragment' &&
        Number(app.dataset.stressTotalRenderedFrames ?? '0') >= 2 &&
        app.dataset.stressGpuCanvasActive === 'true'
      );
    }, null, { timeout: 12000 });
    await webGl1Page.click('#stressStopBtn');
    await webGl1Page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressState === 'idle', null, {
      timeout: 10000
    });
    await webGl1Page.close();

    const noGpuPage = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    await noGpuPage.addInitScript(() => {
      window.__OD_STRESS_TEST_MAX_WORKERS__ = 1;
      Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: undefined
      });
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
        if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
          return null;
        }
        return originalGetContext.call(this, type, ...args);
      };
    });
    await noGpuPage.goto(`${baseUrl}/pages/utilities/index.html#stress-test`, { waitUntil: 'networkidle' });
    await noGpuPage.waitForFunction(
      () => document.querySelector('.utility-stage[data-utility-id="stress-test"]')?.classList.contains('is-active'),
      { timeout: 10000 }
    );
    await noGpuPage.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 10000 });
    await noGpuPage.click('[data-stress-mode-option="gpu"]');
    await noGpuPage.click('#stressStartBtn');
    await noGpuPage.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressState === 'unsupported', {
      timeout: 10000
    });
    const noGpuStressState = await noGpuPage.evaluate(() => ({
      state: document.getElementById('stressTestApp')?.dataset.stressState ?? '',
      workers: document.getElementById('stressTestApp')?.dataset.stressWorkerCount ?? '',
      backend: document.getElementById('stressTestApp')?.dataset.stressGpuBackend ?? '',
      status: document.getElementById('stressStatusText')?.textContent?.trim() ?? ''
    }));

    assert(noGpuStressState.state === 'unsupported', 'GPU-only Stress Test should report unsupported without WebGPU/WebGL.');
    assert(noGpuStressState.workers === '0', 'Unsupported GPU Stress Test should not start CPU workers.');
    assert(noGpuStressState.backend === 'none', 'Unsupported GPU Stress Test should keep GPU backend none.');
    assert(/webgpu|webgl|gpu/i.test(noGpuStressState.status), 'Unsupported GPU Stress Test should surface readable fallback copy.');
    await noGpuPage.close();

    const stressMobilePage = await browser.newPage({
      viewport: { width: 390, height: 844 }
    });
    await stressMobilePage.addInitScript(() => {
      window.__OD_STRESS_TEST_MAX_WORKERS__ = 1;
    });
    await stressMobilePage.goto(`${baseUrl}/pages/utilities/index.html#stress-test`, { waitUntil: 'networkidle' });
    await stressMobilePage.waitForFunction(
      () => document.querySelector('.utility-stage[data-utility-id="stress-test"]')?.classList.contains('is-active'),
      { timeout: 10000 }
    );
    await stressMobilePage.waitForSelector('#stressTestApp[data-stress-state="idle"]', { timeout: 10000 });
      await assertStressLayout(stressMobilePage, 'stress:mobile:idle', { expectMetricsHidden: true });
      await stressMobilePage.close();
    });

    await runUtilitySection(utilitySectionFailures, 'Retro VM', async () => {
      const retroVmRequestsBeforeActivation = retroVmRequests.length;
      await navigateUtility(page, 'virtual-machine');
      await page.waitForTimeout(500);
      const initialVmState = await readRetroVmState(page);
      assert(retroVmRequestsBeforeActivation === 0, 'Retro VM should not fetch guest assets before activation.');
      if (initialVmState.supported !== 'true') {
        assert(/missing required element|unsupported|desktop-first/i.test(initialVmState.status), 'Retro VM should either initialize or report a readable inactive-state blocker.');
        return;
      }

      assert(initialVmState.state === 'idle', 'Retro VM should be idle on first paint.');
      assert(initialVmState.running === 'false', 'Retro VM should not report a running session before launch.');
      assert(initialVmState.launchDisabled === false, 'Retro VM launch should be available on desktop.');
      assert(initialVmState.networkReady === 'false', 'Retro VM should default to offline until a relay URL is configured.');
      assert(/local only/i.test(initialVmState.screenBadge), 'Retro VM should surface Tiny Core local-only status when no relay URL is configured.');
      assert(/tiny core linux 11/i.test(initialVmState.assetLabel), 'Retro VM should advertise the Tiny Core rollback image.');
      assert(/offline-first rollback/i.test(initialVmState.bridgeLabel), 'Retro VM should surface offline-first bridge copy by default.');
      assert(retroVmRequests.length === 0, 'Retro VM should not fetch guest assets before launch.');

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
        assert(launchedVmState.placeholderPointerEvents === 'none', 'Retro VM placeholder should not intercept desktop clicks.');

    await page.click('#retroVmScreen');
    await page.waitForFunction(() => document.getElementById('retroVmApp')?.dataset.vmCaptureState === 'captured');
    const capturedVmState = await readRetroVmState(page);
    assert(/captured/i.test(capturedVmState.captureBadge), 'Retro VM should show captured state after clicking the desktop.');
    assert(/mouse is captured/i.test(capturedVmState.status), 'Retro VM should explain how to release captured mouse input.');
    assert(capturedVmState.screenFocused === true, 'Retro VM screen should receive focus when clicked.');

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
        fullscreenMetrics.shell &&
        fullscreenMetrics.screen.width <= fullscreenMetrics.shell.width + 2 &&
        fullscreenMetrics.screen.height <= fullscreenMetrics.shell.height + 2 &&
        fullscreenMetrics.screen.width >= fullscreenMetrics.shell.width * 0.72 &&
        fullscreenMetrics.screen.height >= fullscreenMetrics.shell.height * 0.72,
      'Retro VM fullscreen guest viewport should remain large and contained inside the fullscreen shell.'
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
      });

    await runUtilitySection(utilitySectionFailures, 'Image Transform Worker Fallback', async () => {
      const noWorkerPage = await browser.newPage({
        viewport: { width: 1440, height: 1100 }
      });
      try {
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
      } finally {
        await noWorkerPage.close();
      }
    });

    await runUtilitySection(utilitySectionFailures, 'Mobile Utilities Layout', async () => {
      const mobilePage = await browser.newPage({
        viewport: { width: 390, height: 844 }
      });
      try {
        await mobilePage.addInitScript(() => {
          window.__OD_RETRO_VM_TEST_MODE__ = true;
        });
        await mobilePage.emulateMedia({ reducedMotion: 'reduce' });
        await loadUtilitiesPage(mobilePage, pageUrl, 'Built-in pair selected|Ready for input', 15000, 'reduced-motion startup');
        await mobilePage.click('#transformGenerateBtn');
        await waitForStatusMatch(mobilePage, 'Reduced motion', 30000, 'reduced-motion result');
        await mobilePage.evaluate(() => window.scrollTo(0, 0));
        await navigateUtility(mobilePage, 'virtual-machine');
        await mobilePage.waitForTimeout(500);

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
        assert(
          mobileState.vmState === 'unsupported' || /missing required/i.test(mobileState.vmStatus),
          'Retro VM should fall back on mobile-sized viewports or report a readable inactive-state blocker.'
        );
        if (mobileState.vmState === 'unsupported') {
          assert(/desktop-first|desktop browser/i.test(mobileState.vmStatus), 'Retro VM mobile fallback copy is missing.');
        }
        if (mobileState.heroTitleTop > 0) {
          assert(mobileState.heroTitleTop >= mobileState.navBottom + 8, 'Mobile utilities hero title sits too close to the navigation.');
        }
      } finally {
        await mobilePage.close();
      }
    });
    await page.close();

    throwIfUtilitySectionFailures(utilitySectionFailures);
    console.log('Utilities Playwright check passed.');
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('Utilities Playwright check failed:', error.stack || error.message);
  process.exit(1);
});
