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

function formatFps(value) {
  return `${Number(value).toFixed(1)}fps`;
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

async function createAudioFixture(filePath) {
  const sampleRate = 16000;
  const durationSeconds = 5 * 60;
  const sampleCount = sampleRate * durationSeconds;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);

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
      Math.sin(2 * Math.PI * 196 * time) * 0.42 +
      Math.sin(2 * Math.PI * 392 * time + 0.3) * 0.26 +
      Math.sin(2 * Math.PI * 784 * time) * 0.09;
    buffer.writeInt16LE(Math.max(-1, Math.min(1, value * envelope)) * 32767, 44 + index * 2);
  }

  await fs.promises.writeFile(filePath, buffer);
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

async function waitForAudioTelemetry(page, previousRequestId, timeout = 45000) {
  await page.waitForFunction(
    (lastCompletedRequestId) => {
      const root = document.getElementById('audioFourierApp');
      return (
        root &&
        root.dataset.audioLastRequestId &&
        root.dataset.audioLastRequestId !== lastCompletedRequestId &&
        Boolean(root.dataset.audioTotalMs)
      );
    },
    previousRequestId,
    { timeout }
  );
}

async function readAudioTelemetry(page) {
  return page.evaluate(() => {
    const root = document.getElementById('audioFourierApp');
    if (!root) {
      throw new Error('Audio Fourier root missing.');
    }

    return {
      totalMs: Number(root.dataset.audioTotalMs ?? '0'),
      proxyMs: Number(root.dataset.audioProxyMs ?? '0'),
      analysisMs: Number(root.dataset.audioAnalysisMs ?? '0'),
      bandMs: Number(root.dataset.audioBandMs ?? '0'),
      componentCount: Number(root.dataset.audioComponentCount ?? '0'),
      sampleRate: Number(root.dataset.audioSampleRate ?? '0'),
      proxyDuration: Number(root.dataset.audioProxyDuration ?? '0'),
      bandCount: Number(root.dataset.audioBandCount ?? '0')
    };
  });
}

async function currentRequestId(page) {
  return page.evaluate(() => document.getElementById('utilitiesApp')?.dataset.lastRequestId ?? '');
}

async function currentAudioRequestId(page) {
  return page.evaluate(() => document.getElementById('audioFourierApp')?.dataset.audioLastRequestId ?? '');
}

async function navigateUtility(page, baseUrl, utilityId) {
  const targetUrl = `${baseUrl}/pages/utilities/index.html#${utilityId}`;
  if (page.url() !== targetUrl) {
    await page.goto(targetUrl, { waitUntil: 'networkidle' });
  }

  await page.waitForFunction(
    (id) => document.querySelector(`.utility-stage[data-utility-id="${id}"]`)?.classList.contains('is-active'),
    utilityId,
    { timeout: 10000 }
  );
}

async function measureAudioPlaybackResponsiveness(page) {
  await page.waitForFunction(
    () => {
      const root = document.getElementById('audioFourierApp');
      const play = document.getElementById('audioFourierPlayBtn');
      return root?.dataset.audioState === 'animating' || (play && !play.hasAttribute('disabled'));
    },
    { timeout: 10000 }
  );

  const state = await page.evaluate(() => document.getElementById('audioFourierApp')?.dataset.audioState ?? '');
  if (state !== 'animating') {
    await page.click('#audioFourierPlayBtn');
    await page.waitForFunction(() => document.getElementById('audioFourierApp')?.dataset.audioState === 'animating', {
      timeout: 10000
    });
  }

  return page.evaluate(async () => {
    const samples = [];
    const slider = document.getElementById('audioFourierComponentSlider');
    const sliderValues = [8, 25, 60, 95, 40, 75, 15, 85];
    let sliderEvents = 0;
    const startedAt = performance.now();
    let previous = startedAt;

    await new Promise((resolve) => {
      function step(timestamp) {
        samples.push(timestamp - previous);
        previous = timestamp;
        if (slider instanceof HTMLInputElement && samples.length % 4 === 0) {
          slider.value = String(sliderValues[sliderEvents % sliderValues.length]);
          slider.dispatchEvent(new InputEvent('input', { bubbles: true }));
          sliderEvents += 1;
        }
        if (timestamp - startedAt >= 2000) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });

    const sorted = samples.slice(1).sort((left, right) => left - right);
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : 0;
    const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
    return {
      rafFps: samples.length / elapsedSeconds,
      rafP95FrameMs: p95,
      rafSampleCount: samples.length,
      sliderEvents
    };
  });
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

async function runAudioPresetCase(page, name, presetId) {
  const previousRequestId = await currentAudioRequestId(page);
  const startedAt = performance.now();
  await page.selectOption('#audioFourierQuality', 'fast');
  await page.click(`[data-audio-preset="${presetId}"]`);
  await page.click('#audioFourierGenerateBtn');
  await waitForAudioTelemetry(page, previousRequestId);
  const telemetry = await readAudioTelemetry(page);
  const responsiveness = await measureAudioPlaybackResponsiveness(page);
  return {
    name,
    wallMs: performance.now() - startedAt,
    ...telemetry,
    ...responsiveness
  };
}

async function runAudioUploadCase(page, name, audioPath) {
  const previousRequestId = await currentAudioRequestId(page);
  const startedAt = performance.now();
  await page.selectOption('#audioFourierQuality', 'fast');
  await page.setInputFiles('#audioFourierInput', audioPath);
  await page.click('#audioFourierGenerateBtn');
  await waitForAudioTelemetry(page, previousRequestId);
  const telemetry = await readAudioTelemetry(page);
  const responsiveness = await measureAudioPlaybackResponsiveness(page);
  return {
    name,
    wallMs: performance.now() - startedAt,
    ...telemetry,
    ...responsiveness
  };
}

async function main() {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'utilities-perf-'));
  const denseSourcePath = path.join(tempDir, 'dense-source.png');
  const denseTargetPath = path.join(tempDir, 'dense-target.png');
  const audioPath = path.join(tempDir, 'audio-source.wav');
  await createDenseFixture(denseSourcePath, 640, 420, 1);
  await createDenseFixture(denseTargetPath, 640, 420, 2);
  await createAudioFixture(audioPath);

  const server = await startLocalStaticServer({
    url: BASE_URL,
    cwd: ROOT
  });
  const baseUrl = server?.url || BASE_URL;

  const browser = await chromium.launch({ headless: true });

  try {
    await waitForServer(`${baseUrl}/pages/utilities/index.html`);

    const page = await browser.newPage({
      viewport: { width: 1440, height: 1100 }
    });
    await navigateUtility(page, baseUrl, 'image-transform');

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

    await navigateUtility(page, baseUrl, 'audio-fourier');
    const audioResults = [
      await runAudioPresetCase(page, 'audio-built-in-song', 'best-friends'),
      await runAudioUploadCase(page, 'audio-upload-wav', audioPath)
    ];

    const lines = [
      'Utilities performance snapshot',
      '========================================'
    ];

    for (const result of results) {
      lines.push(
        `${result.name}: strategy=${result.matcherStrategy} wall=${formatMs(result.wallMs)} total=${formatMs(result.totalMs)} decode=${formatMs(result.decodeMs)} analyze=${formatMs(result.analyzeMs)} rank=${formatMs(result.rankMs)} assign=${formatMs(result.assignMs)} fallback=${result.fallbackCount} shortlistHitRate=${result.shortlistHitRate.toFixed(3)} evaluatedCandidates=${result.evaluatedCandidateCount} evaluatedGroups=${result.evaluatedGroupCount} avgGroupsPerTarget=${result.averageGroupsPerTarget.toFixed(2)}`
      );
    }

    for (const result of audioResults) {
      lines.push(
        `${result.name}: wall=${formatMs(result.wallMs)} total=${formatMs(result.totalMs)} proxy=${formatMs(result.proxyMs)} analysis=${formatMs(result.analysisMs)} bands=${formatMs(result.bandMs)} bandCount=${result.bandCount} components=${result.componentCount} sampleRate=${result.sampleRate.toFixed(1)} proxyDuration=${result.proxyDuration.toFixed(1)}s playbackRaf=${formatFps(result.rafFps)} playbackP95=${formatMs(result.rafP95FrameMs)} rafSamples=${result.rafSampleCount} sliderEvents=${result.sliderEvents}`
      );
    }

    console.log(lines.join('\n'));

    const slowPlayback = audioResults.find((result) => result.rafP95FrameMs > 50);
    if (slowPlayback) {
      throw new Error(
        `${slowPlayback.name} playback responsiveness regressed: p95 RAF frame ${formatMs(slowPlayback.rafP95FrameMs)} exceeds 50ms.`
      );
    }
    const missingSliderStress = audioResults.find((result) => result.sliderEvents < 10);
    if (missingSliderStress) {
      throw new Error(`${missingSliderStress.name} playback responsiveness probe did not exercise enough rapid slider updates.`);
    }
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
