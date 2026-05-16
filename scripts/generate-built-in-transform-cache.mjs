import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import sharp from 'sharp';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ROOT = path.join(ROOT, 'utilities-src', 'src');
const OUTPUT_DIR = path.join(SOURCE_ROOT, 'data', 'precomputed-transforms');
const TEMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'utilities-transform-cache-'));
const COMPILED_ROOT = path.join(TEMP_DIR, 'compiled');

const ENTRY_MODULES = [
  path.join(SOURCE_ROOT, 'presets.ts'),
  path.join(SOURCE_ROOT, 'transformCore.ts'),
  path.join(SOURCE_ROOT, 'transformRenderPlan.ts'),
  path.join(SOURCE_ROOT, 'transformCache.ts'),
  path.join(SOURCE_ROOT, 'uiState.ts')
];
const PRESET_FILTER = new Set(
  (process.env.TRANSFORM_CACHE_PRESETS ?? 'balanced')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);
const DEMO_FILTER = new Set(
  (process.env.TRANSFORM_CACHE_DEMOS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
);

function toArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function rewriteRelativeImports(outputText) {
  return outputText
    .replace(/(from\s+['"])(\.{1,2}\/[^'"]+?)(['"])/g, (_match, prefix, specifier, suffix) =>
      `${prefix}${specifier.endsWith('.json') || specifier.endsWith('.js') ? specifier : `${specifier}.js`}${suffix}`
    )
    .replace(/(import\s*['"])(\.{1,2}\/[^'"]+?)(['"])/g, (_match, prefix, specifier, suffix) =>
      `${prefix}${specifier.endsWith('.json') || specifier.endsWith('.js') ? specifier : `${specifier}.js`}${suffix}`
    );
}

async function resolveRelativeModule(absolutePath, specifier) {
  const basePath = path.resolve(path.dirname(absolutePath), specifier);
  const candidates = path.extname(basePath) ? [basePath] : [`${basePath}.ts`, `${basePath}.json`];

  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Try the next extension candidate.
    }
  }

  throw new Error(`Unable to resolve ${specifier} imported by ${absolutePath}`);
}

async function compileModule(absolutePath, seen = new Set()) {
  if (seen.has(absolutePath)) {
    return;
  }
  seen.add(absolutePath);

  const sourceText = await fs.readFile(absolutePath, 'utf8');
  const importMatches = sourceText.matchAll(
    /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g
  );

  for (const match of importMatches) {
    const specifier = match[1];
    const dependencyPath = await resolveRelativeModule(absolutePath, specifier);
    if (!dependencyPath.endsWith('.ts')) {
      continue;
    }
    await compileModule(dependencyPath, seen);
  }

  const transpiled = ts.transpileModule(sourceText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      resolveJsonModule: true
    },
    fileName: absolutePath
  });

  const relativePath = path.relative(SOURCE_ROOT, absolutePath).replace(/\.ts$/, '.js');
  const outputPath = path.join(COMPILED_ROOT, relativePath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, rewriteRelativeImports(transpiled.outputText));
}

async function loadImageData(imagePath, width, height) {
  const image = sharp(imagePath);
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to read image dimensions for ${imagePath}`);
  }

  const { data, info } = await image
    .resize(width, height, {
      fit: 'cover',
      kernel: sharp.kernel.lanczos3
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    originalWidth: metadata.width,
    originalHeight: metadata.height,
    width: info.width,
    height: info.height,
    pixels: new Uint8ClampedArray(data)
  };
}

await fs.mkdir(COMPILED_ROOT, { recursive: true });
await fs.writeFile(path.join(COMPILED_ROOT, 'package.json'), JSON.stringify({ type: 'module' }));

for (const entryModule of ENTRY_MODULES) {
  await compileModule(entryModule);
}

const presetsModule = await import(pathToFileURL(path.join(COMPILED_ROOT, 'presets.js')).href);
const transformCoreModule = await import(pathToFileURL(path.join(COMPILED_ROOT, 'transformCore.js')).href);
const renderPlanModule = await import(pathToFileURL(path.join(COMPILED_ROOT, 'transformRenderPlan.js')).href);
const transformCacheModule = await import(pathToFileURL(path.join(COMPILED_ROOT, 'transformCache.js')).href);
const uiStateModule = await import(pathToFileURL(path.join(COMPILED_ROOT, 'uiState.js')).href);

const { TRANSFORM_PRESETS } = presetsModule;
const { resolveOutputDimensions, transformPreparedImages } = transformCoreModule;
const { buildTransformRenderPlan } = renderPlanModule;
const { serializePrecomputedBuiltInTransform } = transformCacheModule;
const { DEMOS } = uiStateModule;

await fs.rm(OUTPUT_DIR, { recursive: true, force: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

for (const [demoKey, demo] of Object.entries(DEMOS)) {
  if (DEMO_FILTER.size > 0 && !DEMO_FILTER.has(demoKey)) {
    continue;
  }

  const sourceImagePath = path.resolve(ROOT, 'pages/utilities', demo.source.url);
  const targetImagePath = path.resolve(ROOT, 'pages/utilities', demo.target.url);

  const sourceMetadata = await sharp(sourceImagePath).metadata();
  const targetMetadata = await sharp(targetImagePath).metadata();
  if (!sourceMetadata.width || !sourceMetadata.height || !targetMetadata.width || !targetMetadata.height) {
    throw new Error(`Missing dimensions for demo pair ${demoKey}`);
  }

  for (const preset of Object.values(TRANSFORM_PRESETS)) {
    if (!PRESET_FILTER.has(preset.id)) {
      continue;
    }

    const outputSize = resolveOutputDimensions(targetMetadata.width, targetMetadata.height, preset.maxDimension);
    const source = await loadImageData(sourceImagePath, outputSize.width, outputSize.height);
    const target = await loadImageData(targetImagePath, outputSize.width, outputSize.height);
    const result = transformPreparedImages(
      {
        width: source.width,
        height: source.height,
        pixels: source.pixels
      },
      {
        width: target.width,
        height: target.height,
        pixels: target.pixels
      },
      preset.quantizationBits
    );
    const renderPlan = buildTransformRenderPlan(
      {
        width: source.width,
        height: source.height,
        pixels: source.pixels
      },
      {
        width: target.width,
        height: target.height,
        pixels: target.pixels
      },
      result.assignment,
      preset.quantizationBits,
      result.analysis
    );

    const serialized = serializePrecomputedBuiltInTransform(
      {
        type: 'success',
        requestId: 0,
        source: {
          width: source.width,
          height: source.height,
          pixels: toArrayBuffer(source.pixels),
          originalWidth: source.originalWidth,
          originalHeight: source.originalHeight,
          scaled: source.originalWidth !== source.width || source.originalHeight !== source.height
        },
        target: {
          width: target.width,
          height: target.height,
          pixels: toArrayBuffer(target.pixels),
          originalWidth: target.originalWidth,
          originalHeight: target.originalHeight,
          scaled: target.originalWidth !== target.width || target.originalHeight !== target.height
        },
        assignment: toArrayBuffer(result.assignment),
        metadata: {
          presetId: preset.id,
          quantizationBits: preset.quantizationBits,
          outputWidth: result.source.width,
          outputHeight: result.source.height,
          pixelCount: result.pixelCount,
          sourceOriginalWidth: source.originalWidth,
          sourceOriginalHeight: source.originalHeight,
          targetOriginalWidth: target.originalWidth,
          targetOriginalHeight: target.originalHeight,
          sourceScaled: source.originalWidth !== source.width || source.originalHeight !== source.height,
          targetScaled: target.originalWidth !== target.width || target.originalHeight !== target.height,
          processingMs: result.timingsMs.total,
          timingsMs: result.timingsMs,
          matcherStrategy: result.matcherStrategy,
          fallbackCount: result.matcherStats.fallbackCount,
          shortlistHitRate: result.matcherStats.shortlistHitRate,
          evaluatedCandidateCount: result.matcherStats.evaluatedCandidateCount,
          evaluatedGroupCount: result.matcherStats.evaluatedGroupCount,
          averageGroupsPerTarget: result.matcherStats.averageGroupsPerTarget,
          workerCount: result.workerCount
        }
      },
      renderPlan
    );

    await fs.writeFile(
      path.join(OUTPUT_DIR, `${demoKey}-${preset.id}.json`),
      `${JSON.stringify(serialized)}\n`
    );
  }
}

console.log(`Built-in transform cache written to ${OUTPUT_DIR}`);
