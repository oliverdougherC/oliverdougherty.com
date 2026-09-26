#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium, firefox, webkit } = require('playwright');
const sharp = require('sharp');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4175';
const BASE_URL = process.env.UTILITIES_CHECK_URL || DEFAULT_BASE_URL;
const BROWSER_NAME = process.env.UTILITIES_BROWSER || 'chromium';
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

async function ensureAudioFourierPlayback(page, label = 'Audio Fourier playback') {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.waitForTimeout(160);
    const state = await page.evaluate(() => document.getElementById('audioFourierApp')?.dataset.audioState ?? '');
    if (state === 'animating') {
      await waitForAudioStatusMatch(page, 'Playing selected Fourier energy mix', 5000, label);
      return;
    }
    await page.click('#audioFourierPlayBtn');
  }

  await waitForAudioStatusMatch(page, 'Playing selected Fourier energy mix', 5000, label);
}

async function assertPendingAudioPlayback(page) {
  await page.evaluate(() => {
    const prototype = (window.AudioContext || window.webkitAudioContext).prototype;
    const resume = prototype.resume;
    const start = AudioBufferSourceNode.prototype.start;
    const pending = { resolvers: [], starts: 0 };
    window.__pendingAudioTest = pending;
    prototype.resume = async function (...args) {
      await resume.apply(this, args);
      await new Promise(resolve => pending.resolvers.push(resolve));
    };
    AudioBufferSourceNode.prototype.start = function (...args) {
      pending.starts += 1;
      return start.apply(this, args);
    };
    pending.restore = () => {
      prototype.resume = resume;
      AudioBufferSourceNode.prototype.start = start;
      pending.resolvers.splice(0).forEach(resolve => resolve());
      delete window.__pendingAudioTest;
    };
  });
  try {
    await page.click('#audioFourierPlayBtn');
    await page.waitForFunction(() => window.__pendingAudioTest.resolvers.length === 1);
    await navigateUtility(page, 'stress-test');
    await navigateUtility(page, 'audio-fourier');
    await page.evaluate(async () => {
      window.__pendingAudioTest.resolvers.splice(0).forEach(resolve => resolve());
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const returned = await page.evaluate(() => ({
      state: document.getElementById('audioFourierApp')?.dataset.audioState,
      starts: window.__pendingAudioTest.starts
    }));
    assert(returned.state === 'ready' && returned.starts === 0, 'Leaving and returning must invalidate a pending Play attempt even if its resume resolves after return.');

    await page.click('#audioFourierPlayBtn');
    await page.click('#audioFourierPlayBtn');
    await page.waitForFunction(() => window.__pendingAudioTest.resolvers.length === 2);
    await page.evaluate(async () => {
      window.__pendingAudioTest.resolvers.splice(0).forEach(resolve => resolve());
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForFunction(() => document.getElementById('audioFourierApp')?.dataset.audioState === 'animating');
    const started = await page.evaluate(() => ({
      sources: window.__pendingAudioTest.starts,
      bands: Number(document.getElementById('audioFourierApp')?.dataset.audioBandCount)
    }));
    assert(started.bands > 0 && started.sources === started.bands, 'Two pending Play clicks should create only one set of audio sources.');
    await page.click('#audioFourierPlayBtn');
    await waitForAudioStatusMatch(page, 'Playback paused', 5000, 'pending playback test pauses');
  } finally {
    await page.evaluate(() => window.__pendingAudioTest?.restore());
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

async function assertPublicUtilityRoutes(browser, baseUrl) {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  const retiredFeatureRequests = [];
  page.on('request', (request) => {
    if (/\/(?:local-llm-chat|retroVmController|iridescence|liquid-glass)(?:[./?-]|$)/.test(request.url())) {
      retiredFeatureRequests.push(request.url());
    }
  });

  try {
    await page.goto(`${baseUrl}/pages/utilities/index.html`, { waitUntil: 'networkidle' });
    const visibleRoutes = await page.locator('.utilities-buttons [data-utility]:visible')
      .evaluateAll((entries) => entries.map((entry) => entry.dataset.utility));
    assert(
      JSON.stringify(visibleRoutes) === JSON.stringify(['image-transform', 'audio-fourier', 'stress-test']),
      'Utilities should offer exactly the three public routes.'
    );

    for (const utilityId of ['local-assistant', 'virtual-machine', 'unknown-tool', '%E0%A4%A']) {
      await page.goto(`${baseUrl}/pages/utilities/index.html#${utilityId}`, { waitUntil: 'networkidle' });
      const state = await page.evaluate(() => ({
        retiredLaunchers: document.querySelectorAll('.utilities-buttons [data-utility="local-assistant"], .utilities-buttons [data-utility="virtual-machine"]').length,
        assistantPresent: Boolean(document.querySelector('[data-utility-id="local-assistant"], #localLlmUtilityApp')),
        vmRetained: Boolean(document.querySelector('[data-utility-id="virtual-machine"] #retroVmApp')),
        vmHidden: document.querySelector('[data-utility-id="virtual-machine"]')?.hidden === true,
        activeStageCount: document.querySelectorAll('.utility-stage.is-active').length,
        titleVisible: document.getElementById('utilitiesTitleView')?.hidden === false,
        workspaceHidden: document.getElementById('utilitiesUtilityView')?.hidden === true
      }));
      assert(state.retiredLaunchers === 0, 'Retired tools should not retain launchers.');
      assert(!state.assistantPresent, 'Local Assistant markup should be removed.');
      assert(state.vmRetained && state.vmHidden, 'VM implementation should remain hidden for future work.');
      assert(state.titleVisible && state.workspaceHidden && state.activeStageCount === 0, `${utilityId} deep links should stay on the index.`);
    }
    assert(retiredFeatureRequests.length === 0, 'Utilities should not load retired decoration, Local Assistant, or the hidden VM controller.');
  } finally {
    await page.close();
  }
}

async function assertWorkbenchShell(browser, baseUrl) {
  const tools = [
    { id: 'image-transform', name: 'Image Transform', number: '01' },
    { id: 'audio-fourier', name: 'Fourier Reconstruction', number: '02' },
    { id: 'stress-test', name: 'Stress Test', number: '03' }
  ];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const label = `${viewport.width}x${viewport.height}`;
    try {
      await page.goto(`${baseUrl}/pages/utilities/index.html`, { waitUntil: 'networkidle' });
      const index = await page.evaluate(() => ({
        background: getComputedStyle(document.body).backgroundColor,
        backgroundImage: getComputedStyle(document.body).backgroundImage,
        decorations: Array.from(document.querySelectorAll('#iridescence-bg, .liquid-glass, [data-animate]')).filter(node => !node.closest('[data-utility-id="virtual-machine"]')).length,
        entries: Array.from(document.querySelectorAll('.utilities-buttons [data-utility]')).map(entry => ({
          id: entry.dataset.utility,
          href: entry.getAttribute('href'),
          tag: entry.tagName,
          text: entry.textContent.replace(/\s+/g, ' ').trim(),
          hasExplanation: Boolean(entry.querySelector('p, [role="tooltip"], [title]')) || entry.hasAttribute('title')
        })),
        links: Array.from(document.querySelectorAll('a[href]'))
          .filter(link => !link.closest('#utilitiesShell'))
          .map(link => ({ text: link.textContent.trim().toLowerCase(), pathname: new URL(link.href).pathname })),
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
      }));
      assert(index.background === 'rgb(255, 255, 255)' && index.backgroundImage === 'none', `[${label}] workbench should have a plain white background.`);
      assert(index.decorations === 0, `[${label}] retired decorative markup should be absent.`);
      assert(!index.overflow, `[${label}] index should not overflow horizontally.`);
      assert(index.entries.length === tools.length, `[${label}] index should contain three entries.`);
      for (const tool of tools) {
        const entry = index.entries.find(item => item.id === tool.id);
        assert(entry?.tag === 'A' && entry.href === `#${tool.id}`, `[${label}] ${tool.name} should be a native deep link.`);
        assert(entry.text.includes(tool.name) && !entry.hasExplanation, `[${label}] ${tool.name} should remain a name-only invitation.`);
        assert(entry.text.replace(tool.name, '').replace(/[\d\s.↗↖↘↙→←↑↓⟶+\-/]/g, '') === '', `[${label}] ${tool.name} entry should not add explanatory copy.`);
      }
      for (const route of ['/', '/pages/resume/', '/pages/gallery/', '/pages/utilities/']) {
        assert(index.links.some(link => link.pathname.replace(/index\.html$/, '') === route), `[${label}] page navigation should include ${route}.`);
      }

      const firstEntry = page.locator('.utilities-buttons [data-utility]').first();
      await firstEntry.focus();
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const active = document.activeElement;
        const style = getComputedStyle(active);
        return {
          utility: active.dataset.utility,
          visible: active.matches(':focus-visible'),
          outline: style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 1,
          shadow: style.boxShadow !== 'none'
        };
      });
      assert(focus.utility === 'audio-fourier' && focus.visible && (focus.outline || focus.shadow), `[${label}] keyboard navigation should show a clear focus indicator.`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-utility-id="audio-fourier"]')?.classList.contains('is-active'));
      for (const tool of tools) {
        await page.selectOption('#utilitySwitcher', tool.id);
        await page.waitForFunction(id => document.querySelector(`[data-utility-id="${id}"]`)?.classList.contains('is-active'), tool.id);
        const state = await page.evaluate(() => ({
          heading: document.getElementById('utilityTitle')?.textContent.trim(),
          number: document.getElementById('utilityNumber')?.textContent.trim(),
          selected: document.getElementById('utilitySwitcher')?.value,
          selectedLabel: document.getElementById('utilitySwitcher')?.selectedOptions[0]?.textContent.trim(),
          focused: document.activeElement?.id,
          activeCount: document.querySelectorAll('.utility-stage.is-active:not([hidden])').length,
          titleHidden: document.getElementById('utilitiesTitleView')?.hidden,
          workspaceHidden: document.getElementById('utilitiesUtilityView')?.hidden,
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        }));
        assert(state.heading === tool.name && state.number.replace(/\s*\/\/\s*$/, '') === tool.number && state.selected === tool.id, `[${label}] ${tool.name} heading and selector should agree.`);
        assert(state.selectedLabel === `${tool.number} // ${tool.name}`, `[${label}] utility selector should use double-slash numbering.`);
        assert(state.focused === 'utilityTitle', `[${label}] ${tool.name} should focus its heading on entry.`);
        assert(state.activeCount === 1 && state.titleHidden && !state.workspaceHidden, `[${label}] ${tool.name} should be the only exposed workspace.`);
        assert(!state.overflow, `[${label}] ${tool.name} should not overflow horizontally.`);
      }
      await page.click('.nav-back-btn');
      assert(await page.locator('#utilitiesTitleView').isVisible(), `[${label}] collection control should return to the index.`);
      assert(await page.locator('.utilities-buttons [data-utility="audio-fourier"]').evaluate(entry => entry === document.activeElement), `[${label}] returning to the index should restore entry focus.`);
      await page.goBack();
      await page.waitForFunction(() => document.querySelector('[data-utility-id="stress-test"]')?.classList.contains('is-active'));
      await page.goForward();
      await page.waitForFunction(() => document.getElementById('utilitiesTitleView')?.hidden === false);
      assert(errors.length === 0, `[${label}] shell should not produce browser errors: ${errors.join('; ')}`);
    } finally {
      await page.close();
    }
  }
}

const CONTROL_PANEL_VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 600 },
  { width: 1280, height: 600 },
  { width: 800, height: 600 }
];

async function assertControlPanelGeometry(page, utilityId, label) {
  const state = await page.evaluate(id => {
    const requiredByTool = {
      'image-transform': [
        '#sourceDropzone', '#targetDropzone', '#transformSwapBtn', '#transformPreset',
        '#transformGenerateBtn', '[data-demo-key]', '#transformPlayBtn', '#transformResetBtn',
        '#transformSpeedDownBtn', '#transformSpeedValue', '#transformSpeedUpBtn', '#transformBackgroundBtn',
        '#transformStatusChip', '#transformProgressText', '#transformProgressMeta',
        '#transformTimeline', '#transformTimelinePosition', '#sourceDropzonePreview', '#targetDropzonePreview',
        '#transformOutputSize', '#transformPixelCount', '#transformDuration'
      ],
      'audio-fourier': [
        '#audioFourierDropzone', '#audioFourierQuality', '#audioFourierGenerateBtn',
        '#audioFourierResetBtn', '[data-audio-preset]', '#audioFourierComponentSlider',
        '#audioFourierPlayBtn', '#audioFourierStatusChip', '#audioFourierProgressText',
        '#audioFourierProgressMeta', '#audioFourierSignalStrengthMetric', '#audioFourierSignalCountMetric',
        '#audioFourierSampleRate', '#audioFourierComponentCount', '#audioFourierSourceDuration', '#audioFourierDuration'
      ],
      'stress-test': [
        '[data-stress-mode-option]', '#stressStartBtn', '#stressStopBtn',
        '#stressElapsed', '#stressWorkerCount', '#stressGpuBackend', '#stressRenderRate',
        '#stressCallbackStalls', '#stressCandidates', '#stressSceneTitle'
      ]
    };
    if (id === 'stress-test') {
      const root = document.getElementById('stressTestApp');
      if (root.dataset.stressMode !== 'gpu') requiredByTool[id].push('#stressPrimeDisplay', '#stressLatestPrime', '#stressWorkerSummary');
      if (Number(root.dataset.stressWorkerCount) > 0) requiredByTool[id].push('#stressWorkerActivity', '#stressWorkerActivity > span');
      if (root.dataset.stressMode !== 'cpu' && root.dataset.stressGpuCanvasActive === 'true') requiredByTool[id].push('#stressGpuDetail');
    }
    const canvasByTool = {
      'image-transform': '#transformResultCanvas',
      'audio-fourier': '#audioFourierWaveCanvas',
      'stress-test': '#stressCanvas'
    };
    const workspace = document.getElementById('utilitiesUtilityView');
    const stage = document.querySelector(`.utility-stage[data-utility-id="${id}"]`);
    const identify = element => element.id ? `#${element.id}` : `${element.tagName.toLowerCase()}.${Array.from(element.classList).join('.')}`;
    const box = element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const visible = element => {
      if (!element || element.closest('[hidden], .sr-only')) return false;
      if (element.getClientRects().length === 0) return false;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const describe = element => {
      const ancestors = [];
      for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
        // Inline text wrappers and display:contents are not layout containment boundaries.
        const style = getComputedStyle(node);
        if (style.display !== 'inline' && style.display !== 'contents') {
          ancestors.push({ name: identify(node), rect: box(node) });
        }
      }
      return { name: identify(element), visible: visible(element), rect: box(element), ancestors };
    };
    const required = [];
    const missing = [];
    for (const selector of ['#utilityTitle', '#utilitySwitcher', '.nav-back-btn', ...requiredByTool[id], canvasByTool[id]]) {
      const elements = document.querySelectorAll(selector);
      if (elements.length === 0) missing.push(selector);
      for (const element of elements) required.push(describe(element));
    }
    const visibleElements = Array.from(workspace.querySelectorAll('*')).filter(element =>
      visible(element) && !element.matches('input[type="file"], script, style, option')
    );
    const scrollContainers = visibleElements.filter(element => {
      const style = getComputedStyle(element);
      return /^(auto|scroll)$/.test(style.overflowX) || /^(auto|scroll)$/.test(style.overflowY);
    }).map(element => ({ name: identify(element), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    const escapedElements = visibleElements.filter(element => {
      // These two centered square images are intentionally cropped by their checked frames.
      if (element.matches('#transformSourcePreview, #transformTargetPreview')) return false;
      const rect = box(element);
      return rect.width > 0 && rect.height > 0 && (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1);
    }).map(element => ({ name: identify(element), rect: box(element) }));
    const canvas = document.querySelector(canvasByTool[id]);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight },
      scroll: { x: scrollX, y: scrollY },
      active: stage?.classList.contains('is-active') && !stage.hidden && !workspace.hidden,
      required, missing, scrollContainers, escapedElements,
      output: canvas ? { rect: box(canvas), width: canvas.width, height: canvas.height } : null
    };
  }, utilityId);
  const problems = [];
  const finitePositive = rect => Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0;
  const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1 && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1;
  const viewport = { left: 0, top: 0, right: state.viewport.width, bottom: state.viewport.height };
  if (!state.active) problems.push('workspace is not active');
  if (state.document.width > state.document.clientWidth + 1 || state.document.height > state.document.clientHeight + 1) problems.push(`document scrolls: ${JSON.stringify(state.document)}`);
  if (state.scroll.x !== 0 || state.scroll.y !== 0) problems.push(`document has moved: ${JSON.stringify(state.scroll)}`);
  if (state.missing.length) problems.push(`missing controls: ${state.missing.join(', ')}`);
  for (const element of state.required) {
    if (!element.visible || !finitePositive(element.rect)) {
      problems.push(`${element.name} is hidden or has no positive area`);
      continue;
    }
    if (!inside(element.rect, viewport)) problems.push(`${element.name} escapes viewport: ${JSON.stringify(element.rect)}`);
    for (const ancestor of element.ancestors) {
      if (!finitePositive(ancestor.rect) || !inside(element.rect, ancestor.rect)) problems.push(`${element.name} escapes ${ancestor.name}: ${JSON.stringify(element.rect)} vs ${JSON.stringify(ancestor.rect)}`);
    }
  }
  if (state.scrollContainers.length) problems.push(`internal scroll containers: ${JSON.stringify(state.scrollContainers)}`);
  if (state.escapedElements.length) problems.push(`offscreen rendered elements: ${JSON.stringify(state.escapedElements)}`);
  if (!state.output || !finitePositive(state.output.rect) || !Number.isFinite(state.output.width * state.output.height) || state.output.width * state.output.height <= 0) problems.push('output lacks a finite positive drawing area');
  assert(problems.length === 0, `[${label}:${state.viewport.width}x${state.viewport.height}] control-panel geometry failed:\n${problems.join('\n')}`);
}

async function assertControlPanelSizes(page, utilityId, label) {
  const originalViewport = page.viewportSize();
  try {
    const viewports = utilityId === 'stress-test' ? [...CONTROL_PANEL_VIEWPORTS, { width: 1024, height: 520 }, { width: 1280, height: 800 }] : CONTROL_PANEL_VIEWPORTS;
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await assertControlPanelGeometry(page, utilityId, label);
    }
  } finally {
    await page.setViewportSize(originalViewport);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  await assertControlPanelGeometry(page, utilityId, `${label}:restored`);
}

async function assertImageSidebarSizes(page) {
  const originalViewport = page.viewportSize();
  const measurements = [];
  try {
    for (const height of [1100, 900, 600, 500]) {
      await page.setViewportSize({ width: 1440, height });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await assertControlPanelGeometry(page, 'image-transform', 'image:sidebar');
      measurements.push(await page.evaluate(() => {
        const rect = element => {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
        };
        const rail = document.querySelector('#utilitiesApp .utility-rail');
        const controls = document.querySelector('#utilitiesApp .utility-controls-minimal');
        return {
          height: innerHeight,
          rail: rect(rail),
          controls: rect(controls),
          bottomPadding: Number.parseFloat(getComputedStyle(rail).paddingBottom),
          previews: ['source', 'target'].map(kind => {
            const frame = document.getElementById(`${kind}DropzonePreview`);
            const image = frame.querySelector('img');
            return { kind, frame: rect(frame), contentWidth: frame.clientWidth, image: rect(image), overflow: getComputedStyle(frame).overflow };
          })
        };
      }));
    }
    const reference = measurements[0];
    for (const measurement of measurements) {
      if (measurement.height > 560) {
        assert(measurement.previews[0].frame.bottom <= measurement.previews[1].frame.top + 1, `[sidebar:${measurement.height}] source and target preview frames should form vertical rows.`);
      } else {
        assert(Math.abs(measurement.previews[0].frame.top - measurement.previews[1].frame.top) <= 1 && measurement.previews[0].frame.right <= measurement.previews[1].frame.left + 1, `[sidebar:${measurement.height}] very short windows should place previews side by side without overlap.`);
      }
      assert(measurement.previews[1].frame.bottom <= measurement.controls.top + 1, `[sidebar:${measurement.height}] image controls should follow both preview rows.`);
      assert(Math.abs(measurement.rail.bottom - measurement.bottomPadding - measurement.controls.bottom) <= 4, `[sidebar:${measurement.height}] controls should stay anchored at the bottom of the sidebar.`);
      for (const preview of measurement.previews) {
        const baseline = reference.previews.find(item => item.kind === preview.kind);
        assert(preview.frame.width > 0 && preview.frame.height > 48, `[sidebar:${measurement.height}] ${preview.kind} frame must retain more than 48px of height: ${JSON.stringify(preview.frame)}`);
        assert(Math.abs(preview.image.width - preview.contentWidth) <= 1, `[sidebar:${measurement.height}] ${preview.kind} square should fill its own preview width.`);
        assert(/hidden|clip/.test(preview.overflow), `[sidebar:${measurement.height}] ${preview.kind} frame should clip its square image.`);
        assert(Math.abs(preview.image.width - preview.image.height) <= 1, `[sidebar:${measurement.height}] ${preview.kind} image should stay square.`);
        if (Math.abs(preview.contentWidth - baseline.contentWidth) <= 1) {
          assert(Math.abs(preview.image.width - baseline.image.width) <= 1 && Math.abs(preview.image.height - baseline.image.height) <= 1, `[sidebar:${measurement.height}] ${preview.kind} image scale should stay stable while its frame width is unchanged.`);
        }
        assert(Math.abs((preview.image.left + preview.image.right) - (preview.frame.left + preview.frame.right)) <= 2 && Math.abs((preview.image.top + preview.image.bottom) - (preview.frame.top + preview.frame.bottom - 24)) <= 2, `[sidebar:${measurement.height}] ${preview.kind} image should stay centered above its frame's 24px Choose strip.`);
      }
    }
    const shortest = measurements[measurements.length - 1];
    assert(reference.previews.every((preview, index) => preview.frame.height > shortest.previews[index].frame.height + 20), 'Tall image sidebars should distribute extra height to their preview frames.');
  } finally {
    await page.setViewportSize(originalViewport);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
}

async function readTimelineState(page) {
  return page.evaluate(() => {
    const timeline = document.getElementById('transformTimeline');
    return {
      value: Number(timeline.value),
      disabled: timeline.disabled,
      position: document.getElementById('transformTimelinePosition')?.textContent.trim(),
      state: document.getElementById('utilitiesApp')?.dataset.transformStatusChip,
      frame: document.getElementById('transformResultCanvas').toDataURL()
    };
  });
}

async function seekImageTimeline(page, value) {
  await page.evaluate(position => {
    const timeline = document.getElementById('transformTimeline');
    timeline.value = String(position);
    timeline.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
  return readTimelineState(page);
}

async function assertTimelineAutoplay(page) {
  await page.waitForFunction(() => {
    const timeline = document.getElementById('transformTimeline');
    return !timeline.disabled && Number(timeline.value) >= 200 && Number(timeline.value) < 650;
  });
  const earlier = await readTimelineState(page);
  await page.waitForFunction(value => Number(document.getElementById('transformTimeline').value) > value + 150, earlier.value);
  const later = await readTimelineState(page);
  assert(later.value > earlier.value && later.frame !== earlier.frame, 'Autoplay should advance the image timeline together with the rendered canvas.');
}

async function assertImageTimeline(page, { reducedMotion = false } = {}) {
  const completed = await readTimelineState(page);
  assert(!completed.disabled && completed.value === 1000, 'A completed image transform should enable the timeline at its end.');
  if (!reducedMotion) {
    await page.click('#transformPlayBtn');
    await page.waitForFunction(() => Number(document.getElementById('transformTimeline').value) > 80 && Number(document.getElementById('transformTimeline').value) < 800);
    await page.locator('#transformTimeline').dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true });
    await waitForStatusMatch(page, 'Paused', 5000, 'pointerdown pauses image playback');
  }
  const zero = await seekImageTimeline(page, 0);
  const forward = await seekImageTimeline(page, 800);
  const backward = await seekImageTimeline(page, 200);
  const forwardAgain = await seekImageTimeline(page, 800);
  assert(zero.value === 0 && forward.value === 800 && backward.value === 200 && forwardAgain.value === 800, 'Timeline input should seek both forward and backward.');
  assert(zero.frame !== forward.frame && backward.frame !== forward.frame, 'Different timeline positions should visibly reconstruct different frames.');
  assert(forward.frame === forwardAgain.frame, 'Seeking back to a timeline position should reproduce identical pixels.');
  assert(zero.position && forward.position && zero.position !== forward.position, 'Timeline position readout should track manual seeking.');
  await page.locator('#transformTimeline').dispatchEvent('pointerup', { pointerId: 1, pointerType: 'mouse', button: 0, bubbles: true });
  await page.waitForTimeout(180);
  const released = await readTimelineState(page);
  assert(released.value === 800 && released.frame === forwardAgain.frame, 'Releasing the timeline should leave the selected frame stationary.');

  await page.locator('#transformTimeline').focus();
  await page.keyboard.press('Home');
  const keyboardStart = await readTimelineState(page);
  assert(keyboardStart.value === 0 && keyboardStart.frame === zero.frame, 'Keyboard Home should seek to the exact first frame.');
  await page.keyboard.press('ArrowRight');
  assert((await readTimelineState(page)).value === 1, 'Keyboard ArrowRight should advance one timeline step.');
  await page.keyboard.press('End');
  const keyboardEnd = await readTimelineState(page);
  assert(keyboardEnd.value === 1000 && keyboardEnd.frame === completed.frame, 'Keyboard End should seek to the exact completed frame.');

  if (!reducedMotion) {
    await seekImageTimeline(page, 800);
    await page.click('#transformPlayBtn');
    const resumed = await readTimelineState(page);
    assert(resumed.value >= 800 && resumed.value < 1000, 'Resume should continue from the selected position without jumping back or finishing immediately.');
    await waitForStatusMatch(page, 'Animation complete', 15000, 'timeline resume completion');
    assert((await readTimelineState(page)).value === 1000, 'Playback completion should return the timeline to its end.');
  }
}

async function assertImageSpeedAndBackground(page) {
  const speedState = () =>
    page.evaluate(() => ({
      value: document.getElementById('transformSpeedValue')?.textContent?.trim(),
      downDisabled: document.getElementById('transformSpeedDownBtn')?.disabled,
      upDisabled: document.getElementById('transformSpeedUpBtn')?.disabled
    }));

  assert((await speedState()).value === '1.00x', 'Playback speed should start at 1.00x.');
  for (let i = 0; i < 2; i += 1) {
    await page.click('#transformSpeedUpBtn');
  }
  let speed = await speedState();
  assert(
    speed.value === '2.00x' && speed.upDisabled && !speed.downDisabled,
    'Stepping up should stop at 2.00x with the plus control disabled.'
  );
  for (let i = 0; i < 5; i += 1) {
    await page.click('#transformSpeedDownBtn');
  }
  speed = await speedState();
  assert(
    speed.value === '0.10x' && speed.downDisabled && !speed.upDisabled,
    'Repeated decreases should stop at 0.10x with the minus control disabled.'
  );
  await page.click('#transformSpeedUpBtn');
  await page.click('#transformSpeedUpBtn');
  assert((await speedState()).value === '0.50x', 'Decreasing then increasing should step back through the speed ladder.');

  await seekImageTimeline(page, 0);
  await page.click('#transformPlayBtn');
  await waitForStatusMatch(page, 'Animating', 5000, 'half-speed playback starts');
  await page.waitForFunction(() => Number(document.getElementById('transformTimeline').value) > 150);
  const beforeSpeedChange = await readTimelineState(page);
  await page.click('#transformSpeedUpBtn');
  assert((await speedState()).value === '1.00x', 'Speed changes should apply while the animation is playing.');
  await waitForStatusMatch(page, 'Animating', 3000, 'speed change keeps playback running');
  await page.waitForFunction(
    value => Number(document.getElementById('transformTimeline').value) !== value,
    beforeSpeedChange.value,
    { timeout: 3000 }
  );
  const afterSpeedUp = await readTimelineState(page);
  assert(
    afterSpeedUp.value >= beforeSpeedChange.value - 4 && afterSpeedUp.value <= beforeSpeedChange.value + 40,
    `Speeding up mid-playback should keep the current phase (was ${beforeSpeedChange.value}, now ${afterSpeedUp.value}).`
  );
  await waitForStatusMatch(page, 'Animation complete', 20000, 'speed-adjusted playback completes');
  assert((await readTimelineState(page)).value === 1000, 'Speed-adjusted playback should finish at the timeline end.');

  await seekImageTimeline(page, 0);
  await page.click('#transformPlayBtn');
  await waitForStatusMatch(page, 'Animating', 5000, 'slow-down playback starts');
  await page.waitForFunction(() => Number(document.getElementById('transformTimeline').value) > 150);
  const beforeSpeedDown = await readTimelineState(page);
  await page.click('#transformSpeedDownBtn');
  assert((await speedState()).value === '0.50x', 'Speeding down should apply while the animation is playing.');
  await page.waitForFunction(
    value => Number(document.getElementById('transformTimeline').value) !== value,
    beforeSpeedDown.value,
    { timeout: 3000 }
  );
  const afterSpeedDown = await readTimelineState(page);
  assert(
    afterSpeedDown.value >= beforeSpeedDown.value - 4 && afterSpeedDown.value <= beforeSpeedDown.value + 40,
    `Slowing down mid-playback should keep the current phase (was ${beforeSpeedDown.value}, now ${afterSpeedDown.value}).`
  );
  await waitForStatusMatch(page, 'Animation complete', 30000, 'slowed playback completes');
  assert((await readTimelineState(page)).value === 1000, 'Slowed playback should finish at the timeline end.');

  const stageState = () =>
    page.evaluate(() => ({
      stage: getComputedStyle(document.querySelector('#utilitiesApp .canvas-stage--result')).backgroundColor,
      panelBackground: getComputedStyle(document.querySelector('#utilitiesApp .canvas-panel--result')).backgroundColor,
      panel: document.querySelector('#utilitiesApp .canvas-panel--result')?.dataset?.stageBackground ?? 'light',
      pressed: document.getElementById('transformBackgroundBtn')?.getAttribute('aria-pressed')
    }));

  const before = await stageState();
  assert(before.panel !== 'dark' && before.stage !== 'rgb(0, 0, 0)', 'The animation stage should start with a light background.');
  assert(before.panelBackground !== 'rgb(0, 0, 0)', 'The result panel should start without a black background.');
  await page.click('#transformBackgroundBtn');
  await page.waitForTimeout(340);
  const dark = await stageState();
  assert(dark.stage === 'rgb(0, 0, 0)', `Toggling should paint the animation stage black; got ${dark.stage}.`);
  assert(dark.panelBackground !== 'rgb(0, 0, 0)', `Dark mode must black out only the stage, not the panel below it; panel background is ${dark.panelBackground}.`);
  assert(dark.panel === 'dark' && dark.pressed === 'true', 'The background toggle should expose its dark state.');
  await page.click('#transformBackgroundBtn');
  await page.waitForTimeout(340);
  const light = await stageState();
  assert(light.panel === 'light' && light.stage !== 'rgb(0, 0, 0)', 'Toggling again should restore the light animation stage.');
  assert(light.panelBackground !== 'rgb(0, 0, 0)', 'Restoring the light stage should leave the panel without a black background.');
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

async function createGeneratedWavFile(durationSeconds = 5 * 60) {
  const sampleRate = 16000;
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

async function readImagePreviews(page) {
  await page.waitForFunction(() => ['transformSourcePreview', 'transformTargetPreview'].every(id => {
    const image = document.getElementById(id);
    return image instanceof HTMLImageElement && !image.hidden && image.complete && image.naturalWidth > 0;
  }));
  return page.evaluate(() => ['transformSourcePreview', 'transformTargetPreview'].map(id => {
    const image = document.getElementById(id);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    canvas.getContext('2d').drawImage(image, 0, 0, 16, 16);
    return { source: image.src, pixels: canvas.toDataURL() };
  }));
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

async function readCanvasActiveBounds(page, id) {
  return page.evaluate((canvasId) => {
    const canvas = document.getElementById(canvasId);
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error(`Canvas not found: ${canvasId}`);
    }
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error(`Unable to read canvas: ${canvasId}`);
    }
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let activePixels = 0;
    let minX = canvas.width;
    let maxX = -1;
    for (let offset = 0; offset < data.length; offset += 4) {
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (red + green + blue <= 120) {
        continue;
      }
      const pixelIndex = offset / 4;
      const x = pixelIndex % canvas.width;
      activePixels += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    return {
      width: canvas.width,
      activePixels,
      horizontalSpread: maxX >= minX ? maxX - minX + 1 : 0
    };
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
  }, null, { timeout: 5000 });
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
    assert(root.rect.top >= -1 && root.rect.bottom <= state.viewport.height + 1, `[${label}] ${root.utility || root.id} utility root must fit vertically within the viewport.`);
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

async function readStressPrime(page) {
  const state = await page.evaluate(() => ({
    value: Number(document.getElementById('stressTestApp')?.dataset.stressLatestPrime),
    label: Number(document.getElementById('stressLatestPrime')?.textContent.replaceAll(',', '').trim())
  }));
  assert(Number.isSafeInteger(state.value) && state.value > 1 && state.value < 1e12, `CPU search should grow from small numbers: ${state.value}.`);
  let prime = state.value === 2 || state.value % 2 !== 0;
  for (let divisor = 3; prime && divisor * divisor <= state.value; divisor += 2) prime = state.value % divisor !== 0;
  assert(prime, `CPU search reported a composite number: ${state.value}.`);
  assert(state.label === state.value, 'Displayed prime must equal the actual worker result.');
  return state.value;
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
    let nonWhitePixels = 0;
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
      if (alpha > 0 && Math.min(red, green, blue) < 235) nonWhitePixels += 1;
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
      nonWhitePixels,
      opaquePixels,
      totalRgb,
      maxChannel
    };
  });
}

async function assertStressCanvasActive(page, label) {
  // GPU drawing buffers are deliberately not preserved after presentation. Inspect
  // the composited frame, avoiding the scene's header/footer text as pixel evidence.
  const screenshot = await page.locator('#stressCanvas').screenshot();
  const metadata = await sharp(screenshot).metadata();
  const { data, info } = await sharp(screenshot).extract({
    left: Math.floor(metadata.width * 0.2),
    top: Math.floor(metadata.height * 0.2),
    width: Math.max(1, Math.floor(metadata.width * 0.6)),
    height: Math.max(1, Math.floor(metadata.height * 0.6))
  }).resize(96, 54).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let visiblePixels = 0;
  let geometryPixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    if (red + green + blue > 24) visiblePixels += 1;
    if (Math.min(red, green, blue) < 235) geometryPixels += 1;
  }
  assert(visiblePixels > 48, `[${label}] GPU scene should contain visible rendered output.`);
  assert(geometryPixels > 48, `[${label}] GPU scene should contain geometry beyond the plain paper background; ${geometryPixels} nonwhite pixels.`);
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
  assert(state.shell.top >= -1 && state.shell.bottom <= state.viewport.height + 1, `[${label}] stress shell must fit vertically within the control panel.`);
  assert(state.layoutScrollWidth <= state.layoutClientWidth + 1, `[${label}] stress layout should not overflow horizontally.`);
  if (options.requirePanelFit) {
    if (!options.expectMetricsHidden) {
      assert(state.metrics.left >= state.layout.left - 1 && state.metrics.right <= state.layout.right + 1 && state.metrics.top >= state.layout.top - 1 && state.metrics.bottom <= state.layout.bottom + 1, `[${label}] stress metrics must fit inside their layout grid.`);
    }
    assert(state.controlScrollHeight <= state.controlClientHeight + 1, `[${label}] stress control panel should fit without internal clipping.`);
  }
}

async function main() {
  const server = await startLocalStaticServer({
    url: BASE_URL,
    cwd: ROOT,
    skip: Boolean(process.env.UTILITIES_CHECK_URL)
  });
  const baseUrl = server?.url || BASE_URL;

  const browserType = { chromium, firefox, webkit }[BROWSER_NAME];
  let browser;
  const utilitySectionFailures = [];

  try {
    browser = await browserType.launch({
      headless: true,
      args: BROWSER_NAME === 'chromium' ? CHROMIUM_WEBGL_ARGS : undefined
    });
    await waitForServer(`${baseUrl}/pages/utilities/index.html`);
    await runUtilitySection(utilitySectionFailures, 'Public and Hidden Routes', async () => {
      await assertPublicUtilityRoutes(browser, baseUrl);
    });

    await runUtilitySection(utilitySectionFailures, 'Desktop Workbench Shell', async () => {
      await assertWorkbenchShell(browser, baseUrl);
    });

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    await page.addInitScript(() => {
      window.__OD_RETRO_VM_TEST_MODE__ = true;
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 2, configurable: true });
      // This page asserts a specific worker count while it exercises layout and
      // interaction, so the pool is pinned to a count it can predict instead of
      // following whatever the host reports.
      window.__OD_STRESS_TEST_WORKERS__ = 2;
    });

    const precomputedTransformRequests = [];
    page.on('request', (request) => {
      if (
        /(?:pattern-face|source-target|face-pattern)-balanced(?:-[\w-]+)?\.json/.test(request.url())
      ) {
        precomputedTransformRequests.push(request.url());
      }
    });

    const pageUrl = `${baseUrl}/pages/utilities/index.html#image-transform`;
    await loadUtilitiesPage(page, pageUrl, 'Built-in pair selected|Ready for input', 15000, 'initial transform state');
    await assertUtilityIsolationLayout(page, 'initial:desktop');
    const sourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'source.png');
    const targetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'target.png');
    const whiteHeavySourcePath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-source.png');
    const whiteHeavyTargetPath = path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-target.png');

    await runUtilitySection(utilitySectionFailures, 'Image Transform', async () => {

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
      activeDemo: document.querySelector('.demo-chip.active')?.getAttribute('data-demo-key') ?? '',
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
    assert(initialTransformState.playLabel === 'Play', 'Playback control should clearly label Play before generation.');
    assert(initialTransformState.playAria === 'Play animation', 'Primary playback control should expose Play before generation.');
    assert(initialTransformState.replayButtonExists === false, 'Dedicated replay button should not be rendered.');
    assert(initialTransformState.activeDemo === 'pattern-face', 'Pattern → Face should be selected by default.');
    assert(initialTransformState.generateDisabled === false, 'Generate should be available when the built-in pair is preselected.');
    assert(initialTransformState.hasResult !== 'true', 'Image Transform should not report a result before generation.');
    assert(initialTransformState.supportPanelsDisplay === 'none', 'Image Transform source/reference panels should stay hidden before generation.');
    assert(precomputedTransformRequests.length === 0, 'Initial load should not fetch precomputed demo transforms.');
    const initialTimeline = await page.locator('#transformTimeline').evaluate(input => ({ disabled: input.disabled, value: input.value, min: input.min, max: input.max, step: input.step }));
    assert(initialTimeline.disabled && initialTimeline.value === '0' && initialTimeline.min === '0' && initialTimeline.max === '1000' && initialTimeline.step === '1', 'Image timeline should start disabled with a 0–1000 range and unit steps.');
    await runUtilitySection(utilitySectionFailures, 'Image Sidebar Distribution', async () => {
      await assertImageSidebarSizes(page);
    });

    await runUtilitySection(utilitySectionFailures, 'Image Idle Geometry', async () => {
      await assertControlPanelSizes(page, 'image-transform', 'image:idle');
    });

    const initialPreviews = await readImagePreviews(page);
    await page.click('[data-demo-key="source-target"]');
    await page.waitForTimeout(300);

    const selectedPreviews = await readImagePreviews(page);
    assert(selectedPreviews[1].source !== initialPreviews[1].source && selectedPreviews[1].pixels !== initialPreviews[1].pixels, 'Selecting another demo should visibly update the target thumbnail.');

    const afterDemoSelection = await page.evaluate(() => ({
      status: (() => {
        const app = document.getElementById('utilitiesApp');
        const fromData = app?.dataset?.transformStatusMessage?.trim() ?? '';
        const fromLegacy = document.getElementById('transformStatusText')?.textContent?.trim() ?? '';
        return fromData || fromLegacy;
      })(),
      outputSize: document.getElementById('transformOutputSize')?.textContent?.trim(),
      activeDemo: document.querySelector('.demo-chip.active')?.getAttribute('data-demo-key') ?? ''
    }));

    assert(
      afterDemoSelection.status && /built-in pair selected/i.test(afterDemoSelection.status),
      'Selecting a built-in demo chip should update the ready state without auto-generating.'
    );
    assert(afterDemoSelection.outputSize === '—', 'Selecting a built-in demo chip should not auto-fill transform metrics.');
    assert(afterDemoSelection.activeDemo === 'source-target', 'Demo chip selection should update the active built-in pair.');
    assert(precomputedTransformRequests.length === 0, 'Selecting a built-in demo chip should not fetch precomputed data.');

    await page.click('[data-demo-key="pattern-face"]');
    await page.click('#transformGenerateBtn');
    await waitForStatusMatch(page, 'Loading precomputed|Preparing|Analyzing|Assigning|Animating', 7000);
    await assertTimelineAutoplay(page);
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
      playLabel: document.getElementById('transformPlayBtn')?.textContent?.trim(),
      playAria: document.getElementById('transformPlayBtn')?.getAttribute('aria-label') ?? '',
      supportPanelsDisplay: getComputedStyle(document.querySelector('#utilitiesApp .support-panels')).display,
      hasResult: document.getElementById('utilitiesApp')?.dataset.transformHasResult ?? ''
    }));

    assert(afterDemo.status && /Transform ready|Animation complete|Reduced motion/i.test(afterDemo.status), 'Built-in demo did not initialize after generate.');
    assert(afterDemo.outputSize && afterDemo.outputSize !== '—', 'Built-in demo output size missing after generate.');
    assert(afterDemo.pixels && afterDemo.pixels !== '—', 'Built-in demo pixel count missing after generate.');
    assert(afterDemo.playLabel === 'Replay', 'Playback control should label Replay after the built-in animation runs.');
    assert(afterDemo.playAria === 'Replay animation', 'Primary playback control should expose Replay after the built-in animation runs.');
    assert(afterDemo.hasResult === 'true', 'Image Transform should report a result after generation.');
    assert(afterDemo.supportPanelsDisplay === 'none', 'Image Transform compatibility support panels should stay hidden in the compact redesign.');
    assert(precomputedTransformRequests.length > 0, 'Built-in demo generation should fetch a shipped precomputed transform asset.');
    await runUtilitySection(utilitySectionFailures, 'Image Generated Geometry', async () => {
      await assertControlPanelSizes(page, 'image-transform', 'image:generated');
    });

    await page.evaluate(() => window.scrollTo(0, 0));
    const desktopLayout = await readLayoutMetrics(page);
    assert(desktopLayout.scrollWidth === desktopLayout.clientWidth, 'Utilities page should not overflow horizontally.');
    assert(desktopLayout.shell && desktopLayout.shell.top >= -1 && desktopLayout.shell.bottom <= desktopLayout.viewport.height + 1, 'Image Transform shell must fit completely within the desktop viewport.');
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
    await assertImageTimeline(page);
    await runUtilitySection(utilitySectionFailures, 'Image Speed And Background', async () => {
      await assertImageSpeedAndBackground(page);
    });

    await page.click('#transformPlayBtn');
    await waitForStatusMatch(page, 'Animating', 5000, 'navigation pause start');
    await navigateUtility(page, 'stress-test');
    await waitForStatusMatch(page, 'Paused', 5000, 'navigation pauses image animation');
    const pausedPixels = await readCanvasPixels(page, 'transformResultCanvas');
    await page.waitForTimeout(200);
    assert(totalAbsoluteDifference(pausedPixels, await readCanvasPixels(page, 'transformResultCanvas')) === 0, 'Image animation should stop changing while its workspace is hidden.');
    await navigateUtility(page, 'image-transform');
    assert(await page.locator('#transformPlayBtn').textContent() === 'Resume', 'Returning to a paused image animation should offer Resume.');
    await page.click('#transformPlayBtn');
    await waitForStatusMatch(page, 'Animation complete', 30000, 'navigation resume completes');

    const beforeSwapPreviews = await readImagePreviews(page);
    await page.click('#transformSwapBtn');
    const swappedPreviews = await readImagePreviews(page);
    assert(swappedPreviews[0].pixels === beforeSwapPreviews[1].pixels && swappedPreviews[1].pixels === beforeSwapPreviews[0].pixels, 'Swap should exchange both visible image thumbnails.');
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
    assert(/Generate a new transform|Ready for input|^Ready\.$/i.test(staleState.progress || ''), 'Selecting a new source should clear the old result progress copy.');
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
    await page.click('[data-demo-key="pattern-face"]');
    await readImagePreviews(page);
    await page.click('#transformResetBtn');
    const resetTimeline = await readTimelineState(page);
    assert(resetTimeline.disabled && resetTimeline.value === 0, 'Reset should disable and rewind the image timeline.');
    assert(await page.evaluate(() => ['transformSourcePreview', 'transformTargetPreview'].every(id => {
      const image = document.getElementById(id);
      return image?.hidden && !image.hasAttribute('src');
    })), 'Reset should remove stale source and target thumbnails.');

    });

    await runUtilitySection(utilitySectionFailures, 'Audio Fourier', async () => {
      await navigateUtility(page, 'audio-fourier');
      await page.waitForFunction(() => {
        const app = document.getElementById('audioFourierApp');
        return app?.dataset.audioState === 'idle' && Boolean(app.dataset.audioWaveRenderer) &&
          document.getElementById('audioFourierGenerateBtn')?.disabled === false;
      });

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

    assert(/ready|choose|track|audio/i.test(initialAudioState.status), 'Audio Fourier should start ready for input.');
    assert(initialAudioState.selected === "I Can't Wait To Get There", "Audio Fourier should default to the I Can't Wait To Get There song preset.");
    assert(initialAudioState.sampleRate === '—', 'Audio Fourier sample-rate metric should stay blank before generation.');
    assert(initialAudioState.componentCount === '—', 'Audio Fourier component count should stay blank before generation.');
    assert(initialAudioState.resultMeta === '', 'Audio Fourier waveform viewport should not show instructional copy before generation.');
    assert(initialAudioState.sliderDisabled === true, 'Audio Fourier component slider should stay disabled before generation.');
    assert(initialAudioState.generateDisabled === false, 'Audio Fourier generate should be available for the default preset.');
    assert(initialAudioState.playDisabled === true, 'Audio Fourier playback should be disabled before generation.');
    assert(initialAudioState.telemetryPresent === false, 'Audio Fourier should not analyze audio on first paint.');
    await runUtilitySection(utilitySectionFailures, 'Audio Idle Geometry', async () => {
      await assertControlPanelSizes(page, 'audio-fourier', 'audio:idle');
    });

    await page.selectOption('#audioFourierQuality', 'fast');
    await page.click('[data-audio-preset="best-friends"]');
    await page.click('#audioFourierGenerateBtn');
    await waitForAudioStatusMatch(page, 'Fourier proxy ready|auditory midpoint|Playing selected|Press Play', 60000, 'built-in song preset ready');
    await ensureAudioFourierPlayback(page, 'built-in song preset playback starts');

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
    assert(generatedReadyState.playText === 'Pause', 'Audio Fourier play control should label Pause while playing.');
    assert(generatedReadyState.playLabel === 'Pause', 'Audio Fourier play control should expose an accessible Pause label while playing.');
    assert(generatedReadyState.telemetry.requestId, 'Audio Fourier telemetry should include the completed request id.');
    assert(generatedReadyState.telemetry.totalMs > 0, 'Audio Fourier telemetry should include total processing time.');
    assert(generatedReadyState.telemetry.proxyMs > 0, 'Audio Fourier telemetry should include proxy processing time.');
    assert(generatedReadyState.telemetry.analysisMs > 0, 'Audio Fourier telemetry should include windowed analysis time.');
    assert(generatedReadyState.telemetry.bandMs > 0, 'Audio Fourier telemetry should include band rendering time.');
    assert(generatedReadyState.telemetry.components > 1000, 'Audio Fourier should expose a substantial component count.');
    assert(generatedReadyState.telemetry.proxyDuration > 0, 'Audio Fourier should expose proxy duration.');
    assert(generatedReadyState.telemetry.bandCount > 0, 'Audio Fourier should expose live energy band count.');
    await runUtilitySection(utilitySectionFailures, 'Audio Generated Geometry', async () => {
      await assertControlPanelSizes(page, 'audio-fourier', 'audio:generated');
    });
    const generatedWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    await page.fill('#audioFourierComponentSlider', '100');
    await waitForAudioProgressFill(page, 99, 15000, 'built-in song preset slider max');
    const fullSignalWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    const generatedSpectrumPixels = await readCanvasPixels(page, 'audioFourierSpectrumCanvas');
    const generatedComponentPixels = await readCanvasPixels(page, 'audioFourierComponentCanvas');
    assert(countActiveCanvasPixels(generatedWavePixels) > 100, 'Audio Fourier waveform canvas should be visibly nonblank.');
    assert(totalAbsoluteDifference(generatedWavePixels, fullSignalWavePixels) > 0, 'Dragging the Audio Fourier slider should visibly change the waveform.');
    assert(countActiveCanvasPixels(generatedSpectrumPixels) === 0, 'Hidden spectrum plot should not render expensive unused output.');
    assert(countActiveCanvasPixels(generatedComponentPixels) === 0, 'Hidden component plot should not render expensive unused output.');
    await assertUtilityIsolationLayout(page, 'audio-preset:desktop');

    await page.setViewportSize({ width: 1280, height: 800 });
    await assertUtilityIsolationLayout(page, 'audio-preset:compact-desktop');

    await page.setViewportSize({ width: 2048, height: 998 });
    await page.waitForTimeout(120);
    const prePlaybackWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    await ensureAudioFourierPlayback(page, 'built-in song preset playback restarts');
    await page.waitForTimeout(1400);
    const playbackWavePixels = await readCanvasPixels(page, 'audioFourierWaveCanvas');
    const playbackWaveBounds = await readCanvasActiveBounds(page, 'audioFourierWaveCanvas');
    assert(totalAbsoluteDifference(prePlaybackWavePixels, playbackWavePixels) > 0, 'Audio Fourier viewport should advance during playback.');
    assert(playbackWaveBounds.activePixels > 100, 'Audio Fourier advancing viewport should remain visibly nonblank.');
    assert(
      playbackWaveBounds.horizontalSpread > playbackWaveBounds.width * 0.25,
      `Audio Fourier advancing viewport should render waveform content across the canvas, not only the playhead (${JSON.stringify(playbackWaveBounds)}).`
    );
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
    await page.click('#audioFourierPlayBtn');
    await waitForAudioStatusMatch(page, 'Playback paused', 5000, 'built-in song preset playback pauses');
    await assertPendingAudioPlayback(page);

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

    await runUtilitySection(utilitySectionFailures, 'Image Navigation During Cached Generation', async () => {
      const navigationPage = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
      let releaseCache;
      const cacheRelease = new Promise(resolve => { releaseCache = resolve; });
      let cacheRequested;
      const cacheRequest = new Promise(resolve => { cacheRequested = resolve; });
      let cacheDelivered;
      const cacheDelivery = new Promise(resolve => { cacheDelivered = resolve; });
      try {
        await navigationPage.route('**/pattern-face-balanced*.json', async route => {
          const response = await route.fetch();
          cacheRequested();
          await cacheRelease;
          try {
            await route.fulfill({ response });
          } finally {
            cacheDelivered();
          }
        }, { times: 1 });
        await loadUtilitiesPage(navigationPage, pageUrl, 'Built-in pair selected|Ready for input', 15000, 'cached navigation startup');
        await navigationPage.click('#transformGenerateBtn');
        await Promise.race([cacheRequest, new Promise((_, reject) => setTimeout(() => reject(new Error('Demo cache request was not observed.')), 10000))]);
        await navigationPage.click('.nav-back-btn');
        releaseCache();
        await cacheDelivery;
        await navigationPage.waitForLoadState('networkidle');
        await navigationPage.click('.utilities-buttons [data-utility="image-transform"]');
        await navigationPage.waitForFunction(() => document.getElementById('transformGenerateBtn')?.disabled === false, null, { timeout: 5000 });
        const state = await navigationPage.evaluate(() => ({
          chip: document.getElementById('utilitiesApp')?.dataset.transformStatusChip,
          result: document.getElementById('utilitiesApp')?.dataset.transformHasResult,
          playDisabled: document.getElementById('transformPlayBtn')?.disabled
        }));
        assert(state.chip !== 'Processing' && state.result !== 'true' && state.playDisabled, 'A cancelled demo cache response should not restart hidden processing or publish a result.');
        await navigationPage.click('#transformGenerateBtn');
        await waitForStatusMatch(navigationPage, 'Reduced motion', 30000, 'cached navigation retry');
      } finally {
        releaseCache();
        await navigationPage.close();
      }
    });

    await runUtilitySection(utilitySectionFailures, 'Audio Navigation During Generation', async () => {
      const navigationPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const wavPath = await createGeneratedWavFile(1);
      try {
        await navigationPage.addInitScript(() => {
          const contextPrototype = (window.AudioContext || window.webkitAudioContext).prototype;
          const decode = contextPrototype.decodeAudioData;
          contextPrototype.decodeAudioData = async function (...args) {
            const decoded = await decode.apply(this, args);
            window.__audioDecodeWaiting = true;
            await new Promise(resolve => window.addEventListener('release-test-audio', resolve, { once: true }));
            window.__audioDecodeReleased = true;
            return decoded;
          };
          const start = AudioBufferSourceNode.prototype.start;
          window.__hiddenAudioStarts = 0;
          AudioBufferSourceNode.prototype.start = function (...args) {
            if (location.hash !== '#audio-fourier') window.__hiddenAudioStarts += 1;
            return start.apply(this, args);
          };
        });
        await navigationPage.goto(`${baseUrl}/pages/utilities/index.html#audio-fourier`, { waitUntil: 'networkidle' });
        await navigationPage.waitForFunction(() => Boolean(document.getElementById('audioFourierApp')?.dataset.audioWaveRenderer));
        await navigationPage.setInputFiles('#audioFourierInput', wavPath);
        await navigationPage.click('#audioFourierGenerateBtn');
        await navigationPage.waitForFunction(() => window.__audioDecodeWaiting === true);
        await navigateUtility(navigationPage, 'stress-test');
        await navigationPage.evaluate(() => window.dispatchEvent(new Event('release-test-audio')));
        await navigationPage.waitForFunction(() => window.__audioDecodeReleased === true && document.getElementById('audioFourierApp')?.dataset.audioState !== 'processing');
        await navigationPage.waitForTimeout(300);
        const state = await navigationPage.evaluate(() => ({
          state: document.getElementById('audioFourierApp')?.dataset.audioState,
          starts: window.__hiddenAudioStarts
        }));
        assert(['idle', 'ready', 'complete'].includes(state.state), 'Leaving during audio generation should leave an idle or ready hidden tool.');
        assert(state.starts === 0, 'A late audio decode must never start playback in a hidden workspace.');
      } finally {
        await navigationPage.close();
        fs.rmSync(wavPath, { force: true });
      }
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
      hasStatusText: Boolean(document.getElementById('stressStatusText'))
    }));

    assert(stressInitialState.state === 'idle', 'Stress Test should start idle.');
    assert(stressInitialState.mode === 'both', 'Stress Test should default to Both mode.');
    assert(await page.locator('#stressTestApp #stressIntensity, #stressTestApp .stress-intensity, #stressTestApp select').count() === 0, 'Stress Test should run without an intensity selector.');
    assert((await page.locator('#stressLatestPrime').textContent()).trim() === '1', 'Stress Test should begin with the 1 starting marker.');
    assert(Number(await page.locator('#stressTestApp').getAttribute('data-stress-latest-prime')) === 0, 'Initial 1 must not count as a discovered prime.');
    assert(stressInitialState.workerCount === '0', 'Stress Test should not start CPU workers on activation.');
    assert(stressInitialState.backend === 'none', 'Stress Test should not start GPU work on activation.');
    assert(stressInitialState.startDisabled === false, 'Stress Test start should be available when idle.');
    assert(stressInitialState.stopDisabled === true, 'Stress Test stop should stay disabled when idle.');
    assert(stressInitialState.hasStatusText === false, 'Stress Test should not render the retired status line.');
    await runUtilitySection(utilitySectionFailures, 'Stress Idle Geometry', async () => {
      await assertControlPanelSizes(page, 'stress-test', 'stress:idle');
    });

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
    assert(stressRunningState.workers === '2', 'Stress Test browser check should honor the exact worker-count test hook.');
    assert(stressRunningState.backend === 'none', 'CPU-only Stress Test should not start GPU work.');
    assert(stressRunningState.stopDisabled === false, 'Stress Test stop should enable while running.');
    await page.waitForFunction(() => {
      const app = document.getElementById('stressTestApp');
      return Number(app?.dataset.stressTotalRenderedFrames ?? '0') >= 2 && app?.dataset.stressCanvasActive === 'true';
    }, null, {
      timeout: 10000
    });
    await page.waitForFunction(() => Number(document.getElementById('stressTestApp')?.dataset.stressLatestPrime) > 1);
    const firstPrime = await readStressPrime(page);
    await page.waitForFunction(previous => Number(document.getElementById('stressTestApp')?.dataset.stressLatestPrime) > previous, firstPrime);
    await readStressPrime(page);
    await page.waitForFunction(() => {
      const app = document.getElementById('stressTestApp');
      const workers = Array.from(document.querySelectorAll('#stressWorkerActivity > span'));
      return app.dataset.stressCpuAlgorithm === 'segmented-sieve' && workers.length === 2 &&
        workers.every(worker => Number(worker.dataset.candidates) > 0 && Number(worker.dataset.primesFound) > 0
          && Number(worker.dataset.rangeLow) > 0);
    }, null, { timeout: 15000 });
    await assertStressLayout(page, 'stress:desktop:cpu-running', { requirePanelFit: true });
    await runUtilitySection(utilitySectionFailures, 'Stress Running Geometry', async () => {
      await assertControlPanelSizes(page, 'stress-test', 'stress:running');
    });

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
    assert(stressGpuState.workload >= 1, 'GPU Stress Test should expose a positive adaptive workload level.');
    assert(stressGpuState.activeCanvas === 'true', 'GPU Stress Test should report active GPU canvas output.');
    await assertStressCanvasActive(page, 'stress:gpu:running');
    await assertStressLayout(page, 'stress:desktop:gpu-running', { requirePanelFit: true });

    await page.click('#stressStopBtn');
    await page.waitForFunction(() => document.getElementById('stressTestApp')?.dataset.stressState === 'idle', null, {
      timeout: 10000
    });
    const stressGpuStoppedState = await page.evaluate(() => ({
      backend: document.getElementById('stressTestApp')?.dataset.stressGpuBackend ?? '',
      workload: document.getElementById('stressTestApp')?.dataset.stressGpuWorkloadLevel ?? '',
      activeCanvas: document.getElementById('stressTestApp')?.dataset.stressGpuCanvasActive ?? ''
    }));
    assert(stressGpuStoppedState.backend === 'none', 'Stopped GPU Stress Test should clear the GPU backend.');
    assert(stressGpuStoppedState.workload === '0', 'Stopped GPU Stress Test should clear the adaptive workload level.');
    assert(stressGpuStoppedState.activeCanvas === 'false', 'Stopped GPU Stress Test should clear the active GPU canvas flag.');
    await page.setViewportSize({ width: 1440, height: 1100 });

    const webGl1Page = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    await webGl1Page.addInitScript(() => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 1, configurable: true });
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
      null,
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
        Number(app.dataset.stressGpuWorkloadLevel ?? '0') >= 1 &&
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
      Object.defineProperty(navigator, 'hardwareConcurrency', { value: 1, configurable: true });
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
      null,
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
    }));

    assert(noGpuStressState.state === 'unsupported', 'GPU-only Stress Test should report unsupported without WebGPU/WebGL.');
    assert(noGpuStressState.workers === '0', 'Unsupported GPU Stress Test should not start CPU workers.');
    assert(noGpuStressState.backend === 'none', 'Unsupported GPU Stress Test should keep GPU backend none.');
    await noGpuPage.close();

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

    await runUtilitySection(utilitySectionFailures, 'Reduced Motion', async () => {
      const reducedMotionPage = await browser.newPage({
        viewport: { width: 1280, height: 800 },
        reducedMotion: 'reduce'
      });
      try {
        await loadUtilitiesPage(reducedMotionPage, pageUrl, 'Built-in pair selected|Ready for input', 15000, 'reduced-motion startup');
        await reducedMotionPage.click('#transformGenerateBtn');
        await waitForStatusMatch(reducedMotionPage, 'Reduced motion', 30000, 'reduced-motion result');
        await assertImageTimeline(reducedMotionPage, { reducedMotion: true });
        await assertUtilityIsolationLayout(reducedMotionPage, 'reduced-motion:desktop');
      } finally {
        await reducedMotionPage.close();
      }
    });

    await page.close();

    throwIfUtilitySectionFailures(utilitySectionFailures);
    console.log('Utilities Playwright check passed.');
  } finally {
    await browser?.close();
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('Utilities Playwright check failed:', error.stack || error.message);
  process.exit(1);
});
