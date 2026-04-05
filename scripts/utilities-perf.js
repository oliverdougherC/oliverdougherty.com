#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { chromium } = require('playwright');
const {
  startLocalStaticServer,
  waitForServer
} = require('./lib/playwright-static');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://127.0.0.1:4175';
const BASE_URL = process.env.UTILITIES_CHECK_URL || DEFAULT_BASE_URL;

function formatMs(value) {
  return `${Number(value).toFixed(1)}ms`;
}

async function createDenseFixture(filePath, width, height, variant) {
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const waveA = Math.sin((x + 17 * variant) * 0.061) * 0.5 + 0.5;
      const waveB = Math.cos((y + 23 * variant) * 0.053) * 0.5 + 0.5;
      const waveC = Math.sin((x + y + variant * 11) * 0.038) * 0.5 + 0.5;

      pixels[offset] = Math.round(255 * (0.55 * waveA + 0.45 * waveC));
      pixels[offset + 1] = Math.round(255 * (0.5 * waveB + 0.5 * waveA));
      pixels[offset + 2] = Math.round(255 * (0.6 * waveC + 0.4 * waveB));
      pixels[offset + 3] = 255;
    }
  }

  await sharp(pixels, {
    raw: {
      width,
      height,
      channels: 4
    }
  })
    .png()
    .toFile(filePath);
}

async function waitForTelemetry(page, previousRequestId, timeout = 30000) {
  await page.waitForFunction(
    (lastCompletedRequestId) => {
      const root = document.getElementById('utilitiesApp');
      return (
        root &&
        root.dataset.lastRequestId &&
        root.dataset.lastRequestId !== lastCompletedRequestId &&
        Boolean(root.dataset.totalMs)
      );
    },
    previousRequestId,
    { timeout }
  );
}

async function readTelemetry(page) {
  return page.evaluate(() => {
    const root = document.getElementById('utilitiesApp');
    if (!root) {
      throw new Error('Utilities root missing.');
    }

    return {
      matcherStrategy: root.dataset.matcherStrategy ?? '',
      fallbackCount: Number(root.dataset.fallbackCount ?? '0'),
      shortlistHitRate: Number(root.dataset.shortlistHitRate ?? '0'),
      decodeMs: Number(root.dataset.decodeMs ?? '0'),
      analyzeMs: Number(root.dataset.analyzeMs ?? '0'),
      rankMs: Number(root.dataset.rankMs ?? '0'),
      assignMs: Number(root.dataset.assignMs ?? '0'),
      totalMs: Number(root.dataset.totalMs ?? '0'),
      evaluatedCandidateCount: Number(root.dataset.evaluatedCandidateCount ?? '0'),
      evaluatedGroupCount: Number(root.dataset.evaluatedGroupCount ?? '0'),
      averageGroupsPerTarget: Number(root.dataset.averageGroupsPerTarget ?? '0')
    };
  });
}

async function currentRequestId(page) {
  return page.evaluate(() => document.getElementById('utilitiesApp')?.dataset.lastRequestId ?? '');
}

async function runCase(page, name, sourcePath, targetPath) {
  const previousRequestId = await currentRequestId(page);
  const startedAt = performance.now();
  await page.setInputFiles('#transformSourceInput', sourcePath);
  await page.setInputFiles('#transformTargetInput', targetPath);
  await page.click('#transformGenerateBtn');
  await waitForTelemetry(page, previousRequestId);
  const telemetry = await readTelemetry(page);
  const wallMs = performance.now() - startedAt;

  return {
    name,
    wallMs,
    ...telemetry
  };
}

async function main() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utilities-perf-'));
  const denseSourcePath = path.join(tempDir, 'dense-source.png');
  const denseTargetPath = path.join(tempDir, 'dense-target.png');
  await createDenseFixture(denseSourcePath, 640, 420, 1);
  await createDenseFixture(denseTargetPath, 640, 420, 2);

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
    await page.goto(`${baseUrl}/pages/dashboard/index.html`, { waitUntil: 'networkidle' });

    const benchmarkCases = [
      {
        name: 'representative-upload',
        source: path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'source.png'),
        target: path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'target.png')
      },
      {
        name: 'white-heavy',
        source: path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-source.png'),
        target: path.join(ROOT, 'utilities-src', 'tests', 'fixtures', 'white-heavy-target.png')
      },
      {
        name: 'high-detail-generated',
        source: denseSourcePath,
        target: denseTargetPath
      }
    ];

    const results = [];
    for (const benchmarkCase of benchmarkCases) {
      results.push(await runCase(page, benchmarkCase.name, benchmarkCase.source, benchmarkCase.target));
    }

    const lines = [
      'Utilities performance snapshot',
      '========================================'
    ];

    for (const result of results) {
      lines.push(
        `${result.name}: strategy=${result.matcherStrategy} wall=${formatMs(result.wallMs)} total=${formatMs(result.totalMs)} decode=${formatMs(result.decodeMs)} analyze=${formatMs(result.analyzeMs)} rank=${formatMs(result.rankMs)} assign=${formatMs(result.assignMs)} fallback=${result.fallbackCount} shortlistHitRate=${result.shortlistHitRate.toFixed(3)} evaluatedCandidates=${result.evaluatedCandidateCount} evaluatedGroups=${result.evaluatedGroupCount} avgGroupsPerTarget=${result.averageGroupsPerTarget.toFixed(2)}`
      );
    }

    console.log(lines.join('\n'));
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
    }
  }
}

main().catch((error) => {
  console.error('Utilities perf probe failed:', error.message);
  process.exit(1);
});
