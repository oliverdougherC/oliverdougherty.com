// Throwaway profiling harness — locate slow stages in the image transform pipeline.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { getPreset } from '@utilities/presets';
import { resolveOutputDimensions, transformPreparedImages } from '@utilities/transformCore';
import type { PreparedImageData } from '@utilities/types';

async function preparedImage(filePath: string, maxDimension: number): Promise<PreparedImageData> {
  const metadata = await sharp(filePath).metadata();
  const dims = resolveOutputDimensions(metadata.width!, metadata.height!, maxDimension);
  const raw = await sharp(filePath)
    .resize(dims.width, dims.height, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return { width: dims.width, height: dims.height, pixels: new Uint8ClampedArray(raw) };
}

function denseFixture(variant: number, size = 384): PreparedImageData {
  const width = size;
  const height = size;
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
  return { width, height, pixels: new Uint8ClampedArray(pixels) };
}

const fixtureDir = path.resolve(__dirname, 'fixtures');

interface Case {
  name: string;
  source: PreparedImageData;
  target: PreparedImageData;
}

it('profile transform stages', async () => {
  for (const presetId of ['fast', 'balanced', 'detailed'] as const) {
    const preset = getPreset(presetId);
    const cases: Case[] = [];
    for (const fileCase of [
      { name: 'representative-upload', source: 'source.png', target: 'target.png' },
      { name: 'white-heavy', source: 'white-heavy-source.png', target: 'white-heavy-target.png' }
    ]) {
      cases.push({
        name: fileCase.name,
        source: await preparedImage(path.join(fixtureDir, fileCase.source), preset.maxDimension),
        target: await preparedImage(path.join(fixtureDir, fileCase.target), preset.maxDimension)
      });
    }
    cases.push({ name: 'dense-384', source: denseFixture(1), target: denseFixture(2) });

    for (const testCase of cases) {
      const iterations = testCase.name === 'dense-384' ? 3 : 2;
      let last = null;
      for (let run = 0; run < iterations; run += 1) {
        last = transformPreparedImages(
          testCase.source,
          testCase.target,
          preset.quantizationBits
        );
      }
      const result = last!;
      const t = result.timingsMs;
      const s = result.matcherStats;
      console.log(
        `${presetId}/${testCase.name}: ${result.pixelCount}px ` +
          `total=${t.total.toFixed(0)}ms analyze=${t.analyze.toFixed(0)} rank=${t.rank.toFixed(0)} ` +
          `assign=${t.assign.toFixed(0)} other=${(t.total - t.analyze - t.rank - t.assign).toFixed(0)} | ` +
          `groups/target=${s.averageGroupsPerTarget.toFixed(1)} evaluated=${s.evaluatedGroupCount} ` +
          `fallback=${s.fallbackCount} hitRate=${s.shortlistHitRate.toFixed(3)}`
      );
    }
  }
}, 600_000);