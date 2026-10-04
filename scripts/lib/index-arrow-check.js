const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const TOOLS = ['image-transform', 'audio-fourier', 'stress-test'];
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 800, height: 520 }];
const ZOOMS = [1, 1.25, 1.5, 2];
const FONT = fs.readFileSync(path.resolve(__dirname, '../test-fixtures/inter/inter-latin-500-normal.woff2'));

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function activeTool(page, tool) {
  await page.waitForFunction(id => document.documentElement.dataset.activeUtility === id, tool);
  await settle(page);
  assert.equal(await page.locator('.utilities-footer').isVisible(), false, 'Active tools must hide the footer');
}

function inkBounds(pixels, info, rect, clip, scale) {
  const left = Math.max(0, Math.ceil((rect.x - clip.x) * scale));
  const right = Math.min(info.width, Math.floor((rect.x + rect.width - clip.x) * scale));
  const top = Math.max(0, Math.ceil((rect.y - clip.y) * scale));
  const bottom = Math.min(info.height, Math.floor((rect.y + rect.height - clip.y) * scale));
  let first = Infinity;
  let last = -Infinity;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const offset = (y * info.width + x) * info.channels;
      // Ignore near-white antialiasing fringes; include black and hover purple.
      if (Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 200) {
        first = Math.min(first, y);
        last = Math.max(last, y);
      }
    }
  }
  assert(Number.isFinite(first) && Number.isFinite(last), 'Icon and label must both have visible ink');
  return { top: first, bottom: last, center: (first + last) / 2 };
}

async function measureArrow(page, { output, name, zoom, dpr, state = 'normal' }) {
  await settle(page);
  const button = page.getByRole('button', { name: 'Index', exact: true });
  assert.equal(await button.count(), 1, 'Keep the native button accessible name Index');
  const geometry = await button.evaluate(element => {
    const rect = node => node.getBoundingClientRect().toJSON();
    const icon = element.querySelector('.nav-back-arrow');
    const label = element.querySelector('.nav-back-label');
    return {
      button: rect(element), icon: rect(icon), label: rect(label),
      toolbar: rect(element.closest('.workbench-toolbar')),
      toolbarHeight: matchMedia('(max-height: 650px)').matches ? 46 : 54,
      decorative: icon.getAttribute('aria-hidden') === 'true' && icon.getAttribute('focusable') === 'false',
      svg: icon instanceof SVGElement,
      stroke: getComputedStyle(icon).stroke, color: getComputedStyle(element).color,
      focus: element.matches(':focus-visible'), outline: getComputedStyle(element).outlineStyle
    };
  });
  assert(geometry.decorative && geometry.svg, 'Use a nonfocusable decorative SVG');
  assert.equal(geometry.stroke, geometry.color, 'The icon must follow the button color');
  if (state === 'focus') assert(geometry.focus && geometry.outline !== 'none', 'Keyboard focus must retain its visible outline');
  const center = rect => rect.y + rect.height / 2;
  assert(Math.abs(center(geometry.icon) - center(geometry.label)) / zoom < 0.1, 'Icon and label must share a layout center');
  assert(Math.abs(geometry.toolbar.height / zoom - geometry.toolbarHeight) < 0.1, 'Keep the existing responsive toolbar height');
  assert(Math.abs(geometry.button.height / zoom - 30.8) < 0.1, 'Keep the existing Index click-target height');
  const clip = {
    x: Math.floor(geometry.button.x - 6), y: Math.floor(geometry.button.y - 6),
    width: Math.ceil(geometry.button.width + 13), height: Math.ceil(geometry.button.height + 13)
  };
  const png = await page.screenshot({ clip, animations: 'disabled', timeout: 10000 });
  fs.writeFileSync(path.join(output, `${name}-${state}.png`), png);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const iconInk = inkBounds(data, info, geometry.icon, clip, dpr);
  const labelInk = inkBounds(data, info, geometry.label, clip, dpr);
  // One unscaled CSS pixel allows rasterization rounding at fractional zoom/DPR,
  // but catches a two-pixel lift even when the element boxes still align.
  const inkDelta = (iconInk.center - labelInk.center) / (dpr * zoom);
  assert(Math.abs(inkDelta) <= 1, `${name}:${state}: visible arrow/text centers differ by ${inkDelta.toFixed(2)} CSS px`);
  if (zoom === 1) {
    await sharp(png).resize({ width: clip.width * dpr * 8, kernel: 'nearest' }).png()
      .toFile(path.join(output, `${name}-${state}-8x.png`));
  }
  return { name, state, inkDelta, geometry, iconInk, labelInk };
}

async function checkNavigation(page, measure) {
  await page.locator('#utilitySwitcher').selectOption('audio-fourier');
  await activeTool(page, 'audio-fourier');
  await measure('switch-audio');
  await page.locator('#utilitySwitcher').selectOption('stress-test');
  await activeTool(page, 'stress-test');
  await measure('switch-stress');
  await page.goBack();
  await activeTool(page, 'audio-fourier');
  await measure('history-back');
  await page.goForward();
  await activeTool(page, 'stress-test');
  await measure('history-forward');
  for (const [index, tool] of TOOLS.entries()) {
    if (index > 0) {
      await page.locator(`.utilities-buttons [data-utility="${tool}"]`).click();
      await activeTool(page, tool);
    }
    const button = page.getByRole('button', { name: 'Index', exact: true });
    if (index === 0) await button.click();
    else {
      await page.mouse.move(500, 300);
      await page.keyboard.press('Tab');
      await button.focus();
      await measure(`keyboard-${index}`, 'focus');
      await page.keyboard.press(index === 1 ? 'Enter' : 'Space');
    }
    await page.locator('.utilities-buttons').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.nav-back-btn').isVisible(), false);
    assert.equal(await page.locator('.utilities-footer').isVisible(), true, 'Returning to Index restores its footer');
  }
}

async function assertIndexArrow(browser, baseUrl, browserName, { fullMatrix = true } = {}) {
  // Playwright normally waits for fonts before screenshots. This check must
  // capture the deliberately pending font; restore the setting for other checks.
  const previousFontWait = process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
  process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
  const output = path.resolve(__dirname, `../../output/playwright/index-arrow/${browserName}${fullMatrix ? '' : '/compact'}`);
  fs.mkdirSync(output, { recursive: true });
  const report = {
    browser: browserName, version: browser.version(), platform: process.platform,
    fullMatrix,
    zoomCoverage: fullMatrix ? 'CSS zoom 100/125/150/200%; native browser zoom is not automated' : '100% scale; native browser zoom is not automated',
    platformCoverage: 'Installed Linux fallback fonts; Windows/macOS system fonts are not available',
    fontCoverage: 'Real Inter 500 fixture via intercepted Google Fonts requests; live Google endpoints are not tested',
    results: [], errors: [], status: 'fail'
  };
  try {
    for (const dpr of fullMatrix ? [1, 2] : [1]) {
      for (const mode of ['blocked', 'swap']) {
        const context = await browser.newContext({ viewport: VIEWPORTS[0], deviceScaleFactor: dpr, reducedMotion: 'reduce' });
        let releaseFont;
        const released = new Promise(resolve => { releaseFont = resolve; });
        let fontRequested = false;
        try {
          await context.route('https://fonts.googleapis.com/**', route => mode === 'blocked' ? route.abort() : route.fulfill({
            contentType: 'text/css',
            body: '@font-face { font-family: Inter; font-weight: 500; font-display: swap; src: url(https://fonts.gstatic.com/index-arrow-inter.woff2) format("woff2"); }'
          }));
          await context.route('https://fonts.gstatic.com/**', async route => {
            fontRequested = true;
            await released;
            await route.fulfill({ contentType: 'font/woff2', body: FONT, headers: { 'access-control-allow-origin': '*' } });
          });
          const page = await context.newPage();
          page.on('pageerror', error => report.errors.push(error.message));
          await page.goto(`${baseUrl}/pages/utilities/?full=1#image-transform`, { waitUntil: 'domcontentloaded' });
          await activeTool(page, TOOLS[0]);
          if (mode === 'swap') await page.waitForFunction(() => document.fonts.status === 'loading');
          const states = mode === 'blocked' ? ['blocked'] : ['delayed', 'inter'];
          for (const fontState of states) {
            if (fontState === 'inter') {
              assert(fontRequested, 'The delayed font must actually have been requested');
              releaseFont();
              await page.evaluate(() => document.fonts.ready);
              assert(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Inter' && font.status === 'loaded')), 'Inter must have loaded after first paint');
            } else {
              assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Inter' && font.status === 'loaded')), false, 'Fallback state must not silently use Inter');
            }
            for (const viewport of fullMatrix ? VIEWPORTS : [VIEWPORTS[0]]) {
              await page.setViewportSize(viewport);
              for (const zoom of fullMatrix ? ZOOMS : [1]) {
                // CSS zoom exercises layout/rasterization, not browser chrome zoom.
                await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
                for (const tool of TOOLS) {
                  await page.evaluate(id => { location.hash = id; }, tool);
                  await activeTool(page, tool);
                  await page.mouse.move(viewport.width - 10, viewport.height - 10);
                  await page.locator('.nav-back-btn').evaluate(element => element.blur());
                  const name = `${fontState}-dpr${dpr}-${viewport.width}x${viewport.height}-zoom${zoom}-${tool}`;
                  const measure = state => measureArrow(page, { output, name, zoom, dpr, state });
                  report.results.push(await measure('normal'));
                  if (zoom === 1 && tool === TOOLS[0]) {
                    await page.locator('.nav-back-btn').hover();
                    report.results.push(await measure('hover'));
                    await page.mouse.move(viewport.width - 10, viewport.height - 10);
                    await page.keyboard.press('Tab');
                    await page.locator('.nav-back-btn').focus();
                    report.results.push(await measure('focus'));
                  }
                }
              }
            }
          }
          await page.setViewportSize(VIEWPORTS[0]);
          await page.evaluate(() => { document.documentElement.style.zoom = '1'; });
          await settle(page);
          await checkNavigation(page, async (step, state = 'normal') => {
            report.results.push(await measureArrow(page, { output, name: `${mode}-dpr${dpr}-${step}`, zoom: 1, dpr, state }));
          });
        } finally {
          releaseFont();
          await context.close();
        }
      }
    }
    assert.deepEqual(report.errors, [], 'No page errors during Index navigation');
    report.status = 'pass';
  } catch (error) {
    report.error = error.stack || String(error);
    throw error;
  } finally {
    if (previousFontWait === undefined) delete process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY;
    else process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = previousFontWait;
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(`Index arrow check passed: ${browserName}, ${report.results.length} rendered samples`);
}

module.exports = { assertIndexArrow };
