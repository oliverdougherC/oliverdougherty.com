#!/usr/bin/env node

const path = require('node:path');
const { chromium } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4175';
const BASE_URL = process.env.UTILITIES_CHECK_URL || DEFAULT_BASE_URL;
const IDLE_SAMPLE_MS = 5000;
const ROUTE_SAMPLE_MS = 3000;
const MAX_STYLE_RECALC_SECONDS = 0.05;
const MAX_RASTER_TASKS = 40;
const MAX_RASTER_MS = 90;
const PAINT_HEAVY_ANIMATION_PROPS = new Set([
  'backdropFilter',
  'backgroundPosition',
  'backgroundPositionX',
  'backgroundPositionY',
  'boxShadow',
  'filter',
  'webkitBackdropFilter'
]);

function metricMap(metrics) {
  return Object.fromEntries(metrics.metrics.map((metric) => [metric.name, metric.value]));
}

async function readStarfieldState(page) {
  return page.evaluate(() => {
    const canvas = document.getElementById('starfield');
    return {
      count: Number(canvas?.dataset.starCount || '0'),
      frames: Number(canvas?.dataset.starfieldFrameCount || '0'),
      layers: Number(canvas?.dataset.starfieldLayerCount || '0'),
      mode: canvas?.dataset.starfieldMode || ''
    };
  });
}

async function waitForStarfield(page) {
  await page.waitForFunction(() => {
    const canvas = document.getElementById('starfield');
    return canvas instanceof HTMLCanvasElement &&
      Number(canvas.dataset.starCount || '0') > 0 &&
      Number(canvas.dataset.starfieldLayerCount || '0') > 0;
  }, { timeout: 10000 });
}

async function runningPaintHeavyAnimations(page) {
  return page.evaluate((paintProps) => {
    const paintPropertySet = new Set(paintProps);
    return document.getAnimations({ subtree: true })
      .filter((animation) => animation.playState === 'running')
      .map((animation) => {
        const effect = animation.effect;
        const target = effect && 'target' in effect ? effect.target : null;
        const element = target instanceof Element ? target : null;
        const keyframes = effect && typeof effect.getKeyframes === 'function' ? effect.getKeyframes() : [];
        const properties = new Set();
        for (const keyframe of keyframes) {
          for (const property of Object.keys(keyframe)) {
            if (paintPropertySet.has(property)) {
              properties.add(property);
            }
          }
        }
        return {
          name: animation.animationName || animation.constructor.name,
          properties: Array.from(properties),
          target: element
            ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}${element.className ? `.${String(element.className).trim().replace(/\s+/g, '.')}` : ''}`
            : ''
        };
      })
      .filter((animation) => animation.properties.length > 0);
  }, Array.from(PAINT_HEAVY_ANIMATION_PROPS));
}

async function measureIdleWindow(page, client, sampleMs) {
  const beforeMetrics = metricMap(await client.send('Performance.getMetrics'));
  const beforeStarfield = await readStarfieldState(page);
  await page.waitForTimeout(sampleMs);
  const afterMetrics = metricMap(await client.send('Performance.getMetrics'));
  const afterStarfield = await readStarfieldState(page);
  return {
    starfieldFrames: afterStarfield.frames - beforeStarfield.frames,
    recalcStyleDuration: Number(((afterMetrics.RecalcStyleDuration || 0) - (beforeMetrics.RecalcStyleDuration || 0)).toFixed(6)),
    layoutDuration: Number(((afterMetrics.LayoutDuration || 0) - (beforeMetrics.LayoutDuration || 0)).toFixed(6)),
    taskDuration: Number(((afterMetrics.TaskDuration || 0) - (beforeMetrics.TaskDuration || 0)).toFixed(6)),
    starfield: afterStarfield
  };
}

async function traceRasterWork(page, client, sampleMs) {
  const chunks = [];
  client.on('Tracing.dataCollected', (event) => chunks.push(...event.value));
  await client.send('Tracing.start', {
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,cc,gpu',
    transferMode: 'ReportEvents'
  });
  await page.waitForTimeout(sampleMs);
  await client.send('Tracing.end');
  await new Promise((resolve) => client.once('Tracing.tracingComplete', resolve));

  let rasterTasks = 0;
  let rasterMs = 0;
  for (const event of chunks) {
    if (event.ph !== 'X') continue;
    if (!/RasterTask|RasterizerTask|DisplayItemList::Raster|ZeroCopyRasterBuffer::Playback/.test(event.name)) {
      continue;
    }
    rasterTasks += 1;
    rasterMs += (event.dur || 0) / 1000;
  }

  return {
    rasterTasks,
    rasterMs: Number(rasterMs.toFixed(3))
  };
}

async function navigateUtility(page, baseUrl, utilityId) {
  await page.goto(`${baseUrl}/pages/utilities/index.html#${utilityId}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    (id) => document.querySelector(`.utility-stage[data-utility-id="${id}"]`)?.classList.contains('is-active'),
    utilityId,
    { timeout: 10000 }
  );
}

async function assertTitleIdle(page, client, baseUrl) {
  await page.goto(`${baseUrl}/pages/utilities/index.html`, { waitUntil: 'networkidle' });
  await waitForStarfield(page);
  await page.waitForTimeout(8500);

  const idle = await measureIdleWindow(page, client, IDLE_SAMPLE_MS);
  const paintAnimations = await runningPaintHeavyAnimations(page);
  const raster = await traceRasterWork(page, client, 2500);

  if (idle.starfieldFrames !== 0) {
    throw new Error(`Starfield produced ${idle.starfieldFrames} JS/worker frames while idle.`);
  }
  if (paintAnimations.length > 0) {
    throw new Error(`Paint-heavy animations still running: ${JSON.stringify(paintAnimations)}`);
  }
  if (idle.recalcStyleDuration > MAX_STYLE_RECALC_SECONDS) {
    throw new Error(`Idle style recalculation ${idle.recalcStyleDuration}s exceeds ${MAX_STYLE_RECALC_SECONDS}s.`);
  }
  if (raster.rasterTasks > MAX_RASTER_TASKS || raster.rasterMs > MAX_RASTER_MS) {
    throw new Error(`Idle raster work too high: ${raster.rasterTasks} tasks / ${raster.rasterMs}ms.`);
  }

  await page.evaluate(() => window.dispatchEvent(new Event('starfield-spawn-comet')));
  await page.waitForSelector('.starfield-comet', { timeout: 1000 });
  await page.waitForFunction(() => document.querySelectorAll('.starfield-comet').length === 0, { timeout: 7000 });

  return {
    idle,
    paintAnimations,
    raster
  };
}

async function assertRouteIdle(page, client, baseUrl, utilityId) {
  await navigateUtility(page, baseUrl, utilityId);
  await waitForStarfield(page);
  await page.waitForTimeout(2500);
  const idle = await measureIdleWindow(page, client, ROUTE_SAMPLE_MS);
  const paintAnimations = await runningPaintHeavyAnimations(page);

  if (idle.starfieldFrames !== 0) {
    throw new Error(`${utilityId} route produced ${idle.starfieldFrames} starfield JS/worker frames while idle.`);
  }
  if (paintAnimations.length > 0) {
    throw new Error(`${utilityId} has running paint-heavy animations: ${JSON.stringify(paintAnimations)}`);
  }

  return {
    utilityId,
    idle,
    paintAnimations
  };
}

async function main() {
  const server = await startLocalStaticServer({
    url: BASE_URL,
    cwd: ROOT
  });
  const baseUrl = server?.url || BASE_URL;
  const browser = await chromium.launch({ headless: true });

  try {
    await waitForServer(`${baseUrl}/pages/utilities/index.html`);
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 },
      deviceScaleFactor: 2
    });
    const client = await page.context().newCDPSession(page);
    await client.send('Performance.enable');

    const title = await assertTitleIdle(page, client, baseUrl);
    const routes = [];
    for (const utilityId of ['image-transform', 'audio-fourier', 'local-assistant', 'virtual-machine', 'stress-test']) {
      routes.push(await assertRouteIdle(page, client, baseUrl, utilityId));
    }

    console.log('Utilities idle performance snapshot');
    console.log('========================================');
    console.log(
      `title: mode=${title.idle.starfield.mode} stars=${title.idle.starfield.count} layers=${title.idle.starfield.layers} starfieldFrames=${title.idle.starfieldFrames} recalc=${title.idle.recalcStyleDuration}s rasterTasks=${title.raster.rasterTasks} raster=${title.raster.rasterMs}ms`
    );
    for (const route of routes) {
      console.log(
        `${route.utilityId}: mode=${route.idle.starfield.mode} starfieldFrames=${route.idle.starfieldFrames} recalc=${route.idle.recalcStyleDuration}s task=${route.idle.taskDuration}s`
      );
    }
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('Utilities idle perf gate failed:', error.message);
  process.exit(1);
});
