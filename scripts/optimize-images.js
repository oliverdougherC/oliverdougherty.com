#!/usr/bin/env node
/**
 * Image Optimization Script
 * Generates optimized gallery variants and updates assets/photos/photos.json.
 *
 * Outputs:
 *   assets/photos/thumbs/  - 800px variants (JPEG + WebP + AVIF)
 *   assets/photos/medium/  - 1600px variants (JPEG + WebP + AVIF)
 *   assets/photos/large/   - 2400px variants (JPEG + WebP + AVIF)
 *
 * Usage: node scripts/optimize-images.js
 * Optional env: IMAGE_CONCURRENCY=4
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const exifr = require('exifr');

const PHOTOS_DIR = path.join(__dirname, '..', 'assets', 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'photos.json');
const DESCRIPTIONS_PATH = path.join(PHOTOS_DIR, 'descriptions.md');
const PHOTO_EXT_RE = /\.(jpe?g|png)$/i;

const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to']);

const PHOTO_CATALOG = [
  { filename: 'squirrel.jpg', variantBaseName: 'a7rii_335', category: 'WILDLIFE', location: 'Field Edge' },
  { filename: 'lighthouse.jpg', variantBaseName: 'a7rii_474', category: 'LANDSCAPE', location: 'Peninsula Edge' },
  { filename: 'ember_m4.jpg', variantBaseName: 'DSC04084', category: 'AUTOMOTIVE', location: 'Mountain Pullout' },
  { filename: 'union.jpg', variantBaseName: 'IMG_20251211_232447_034', category: 'NIGHT_STUDIES', location: 'Civic Center' },
  { filename: 'hawk.jpg', variantBaseName: 'DSC04229', category: 'WILDLIFE', location: 'Tree Line' },
  { filename: 'chairs.jpeg', variantBaseName: 'Hawaii_S25_121', category: 'LANDSCAPE', location: 'Beachfront' },
  { filename: 'forest.jpg', variantBaseName: 'DSC04166', category: 'LANDSCAPE', location: 'Forest Line' },
  { filename: 'looking_for_shells.jpg', variantBaseName: 'a7rii_492', category: 'FIGURES', location: 'Rocky Shore' },
  { filename: 'pond.jpeg', variantBaseName: 'Dream_Pond', category: 'LANDSCAPE', location: 'Garden Pond' },
  { filename: 'hills.jpg', variantBaseName: 'DSC04139', category: 'LANDSCAPE', location: 'Open Range' },
  { filename: 'fog.jpg', variantBaseName: 'DSC04161', category: 'LANDSCAPE', location: 'Distant Ridge' },
  { filename: 'moon.jpg', variantBaseName: 'DSC04599', category: 'NIGHT_STUDIES', location: 'Night Sky' },
  { filename: 'sitting.jpg', variantBaseName: 'DSC04549', category: 'WILDLIFE', location: 'Fence Line' },
  { filename: 'in_flight.jpg', variantBaseName: 'DSC04554', category: 'WILDLIFE', location: 'Open Sky' },
  { filename: 'Caught.jpg', variantBaseName: 'a7rii_477', category: 'FIGURES', location: 'Concrete Stairwell' },
  { filename: 'stroller.jpg', variantBaseName: 'DSC04205', category: 'FIGURES', location: 'Waterfront Path' },
  { filename: 'swing.jpg', variantBaseName: 'DSC04179', category: 'FIGURES', location: 'Driving Range' },
  { filename: 'putt.jpg', variantBaseName: 'DSC04209', category: 'FIGURES', location: 'Practice Green' },
  { filename: 'nose.jpg', variantBaseName: 'DSC04098', category: 'AUTOMOTIVE', location: 'Street Shoulder' },
  { filename: 'stare.jpg', variantBaseName: 'DSC04102', category: 'AUTOMOTIVE', location: 'Street Shoulder' },
  { filename: 'yellow.jpg', variantBaseName: 'IMG_20251211_225252_010', category: 'NIGHT_STUDIES', location: 'Intersection' },
  { filename: 'night.jpg', variantBaseName: 'IMG_20251211_225510_015', category: 'NIGHT_STUDIES', location: 'Neighborhood Park' },
  { filename: 'yield.jpg', variantBaseName: 'IMG_20251211_225546_016', category: 'NIGHT_STUDIES', location: 'Street Corner' },
  { filename: 'lights.jpg', variantBaseName: 'IMG_20251211_225914_024_crop', category: 'NIGHT_STUDIES', location: 'Downtown Sidewalk' }
];

const VARIANTS = [
  {
    key: 'thumbs',
    dir: path.join(PHOTOS_DIR, 'thumbs'),
    maxWidth: 800,
    jpegQuality: 92,
    webpQuality: 95,
    avifQuality: 90
  },
  {
    key: 'medium',
    dir: path.join(PHOTOS_DIR, 'medium'),
    maxWidth: 1600,
    jpegQuality: 94,
    webpQuality: 96,
    avifQuality: 92
  },
  {
    key: 'large',
    dir: path.join(PHOTOS_DIR, 'large'),
    maxWidth: 2400,
    jpegQuality: 95,
    webpQuality: 97,
    avifQuality: 94
  }
];

async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${path.relative(PHOTOS_DIR, dir)}`);
  }
}

function basenameFromPath(value) {
  const normalized = String(value || '').split('?')[0].split('#')[0];
  const parts = normalized.split('/');
  return parts[parts.length - 1];
}

function extractPhotoStem(filename) {
  let stem = basenameFromPath(filename);
  let next = stem.replace(/\.(avif|webp|jpe?g|png)$/i, '');

  while (next !== stem) {
    stem = next;
    next = stem.replace(/\.(avif|webp|jpe?g|png)$/i, '');
  }

  return stem;
}

function normalizePhotoKey(value) {
  return extractPhotoStem(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function bytesToMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function bytesToKB(bytes) {
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function parseConcurrency() {
  const requested = Number.parseInt(process.env.IMAGE_CONCURRENCY || '', 10);
  if (Number.isFinite(requested) && requested > 0) return requested;

  const cpuCount = os.cpus()?.length || 1;
  return Math.max(1, Math.min(cpuCount, 6));
}

function formatTitleToken(token, index, total) {
  if (!token) return '';

  if (/\d/.test(token)) {
    return token.toUpperCase();
  }

  const lower = token.toLowerCase();
  if (index > 0 && index < total - 1 && SMALL_WORDS.has(lower)) {
    return lower;
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function formatDisplayTitle(filename) {
  const parts = extractPhotoStem(filename)
    .split(/[-_]+/)
    .filter(Boolean);

  return parts
    .map((part, index) => formatTitleToken(part, index, parts.length))
    .join(' ');
}

function parseDescriptions() {
  if (!fs.existsSync(DESCRIPTIONS_PATH)) {
    return new Map();
  }

  const descriptions = new Map();
  const content = fs.readFileSync(DESCRIPTIONS_PATH, 'utf8');

  for (const line of content.split('\n')) {
    const match = line.match(/```([^`]+)```\s*(?:&rarr;|->|→)\s*(.+)$/);
    if (!match) continue;

    descriptions.set(normalizePhotoKey(match[1]), match[2].trim());
  }

  return descriptions;
}

function listSourcePhotoFiles() {
  return fs.readdirSync(PHOTOS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && PHOTO_EXT_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function buildSourcePhotos() {
  const files = listSourcePhotoFiles();
  const available = new Set(files);
  const ordered = [];
  const seen = new Set();

  PHOTO_CATALOG.forEach((entry) => {
    if (!available.has(entry.filename)) {
      console.warn(`Catalog entry missing source file: ${entry.filename}`);
      return;
    }

    ordered.push(entry);
    seen.add(entry.filename);
  });

  files.forEach((filename) => {
    if (seen.has(filename)) return;
    ordered.push({
      filename,
      variantBaseName: extractPhotoStem(filename),
      category: 'ARCHIVE',
      location: ''
    });
  });

  return ordered;
}

function getVariantBaseName(photo) {
  return photo.variantBaseName || extractPhotoStem(photo.filename);
}

async function generateVariant(inputPath, baseName, originalWidth, originalHeight, variant) {
  const width = Math.min(variant.maxWidth, originalWidth);
  const height = Math.max(1, Math.round((width / originalWidth) * originalHeight));

  const jpgName = `${baseName}.jpg`;
  const webpName = `${baseName}.webp`;
  const avifName = `${baseName}.avif`;

  const jpgPath = path.join(variant.dir, jpgName);
  const webpPath = path.join(variant.dir, webpName);
  const avifPath = path.join(variant.dir, avifName);

  const basePipeline = sharp(inputPath)
    .rotate()
    .resize(width, null, { withoutEnlargement: true });

  await Promise.all([
    basePipeline
      .clone()
      .jpeg({ quality: variant.jpegQuality, mozjpeg: true })
      .toFile(jpgPath),
    basePipeline
      .clone()
      .webp({ quality: variant.webpQuality })
      .toFile(webpPath),
    basePipeline
      .clone()
      .avif({ quality: variant.avifQuality, effort: 7 })
      .toFile(avifPath)
  ]);

  const totalBytes =
    fs.statSync(jpgPath).size +
    fs.statSync(webpPath).size +
    fs.statSync(avifPath).size;

  return {
    manifestData: {
      jpg: jpgName,
      webp: webpName,
      avif: avifName,
      width,
      height
    },
    totalBytes,
    webpBytes: fs.statSync(webpPath).size,
    avifBytes: fs.statSync(avifPath).size
  };
}

function parseDateFromFilename(filename) {
  const stem = extractPhotoStem(filename);
  const compactMatch = stem.match(/((?:19|20)\d{2})(\d{2})(\d{2})/);
  if (!compactMatch) return '';

  const [, year, month, day] = compactMatch;
  return `${year}-${month}-${day}`;
}

function parseExifShutter(exposureTime) {
  if (!exposureTime) return null;
  if (exposureTime < 1) return `1/${Math.round(1 / exposureTime)}`;
  return `${exposureTime.toFixed(1)}`;
}

async function extractExif(inputPath) {
  try {
    const exif = await exifr.parse(inputPath, {
      pick: [
        'Model',
        'LensModel',
        'FocalLength',
        'FNumber',
        'ExposureTime',
        'ISO',
        'DateTimeOriginal'
      ]
    });

    if (!exif) {
      const fallbackDate = parseDateFromFilename(path.basename(inputPath));
      return fallbackDate ? { date: fallbackDate } : null;
    }

    const result = {};
    if (exif.Model) result.camera = exif.Model;
    if (exif.LensModel) result.lens = exif.LensModel;
    if (exif.FocalLength) result.focalLength = Math.round(exif.FocalLength);
    if (exif.FNumber) result.aperture = parseFloat(exif.FNumber.toFixed(1));

    const shutter = parseExifShutter(exif.ExposureTime);
    if (shutter) result.shutter = shutter;

    if (exif.ISO) result.iso = exif.ISO;
    if (exif.DateTimeOriginal) {
      const date = exif.DateTimeOriginal;
      result.date = date instanceof Date
        ? date.toISOString().split('T')[0]
        : String(date);
    } else {
      const fallbackDate = parseDateFromFilename(path.basename(inputPath));
      if (fallbackDate) result.date = fallbackDate;
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch (_err) {
    const fallbackDate = parseDateFromFilename(path.basename(inputPath));
    return fallbackDate ? { date: fallbackDate } : null;
  }
}

async function processImage(photo, index, total) {
  const inputPath = path.join(PHOTOS_DIR, photo.filename);

  if (!fs.existsSync(inputPath)) {
    console.warn(`[${index + 1}/${total}] SKIP missing file: ${photo.filename}`);
    return null;
  }

  const metadata = await sharp(inputPath).rotate().metadata();
  const originalWidth = metadata.width;
  const originalHeight = metadata.height;

  if (!originalWidth || !originalHeight) {
    console.warn(`[${index + 1}/${total}] SKIP unreadable dimensions: ${photo.filename}`);
    return null;
  }

  const baseName = getVariantBaseName(photo);
  const output = {
    ...photo,
    width: originalWidth,
    height: originalHeight
  };

  let optimizedBytes = 0;
  const perVariant = {};

  for (const variant of VARIANTS) {
    const generated = await generateVariant(
      inputPath,
      baseName,
      originalWidth,
      originalHeight,
      variant
    );

    output[variant.key] = generated.manifestData;
    optimizedBytes += generated.totalBytes;

    perVariant[variant.key] = {
      webpBytes: generated.webpBytes,
      avifBytes: generated.avifBytes
    };
  }

  const exif = await extractExif(inputPath);
  const derivedDate = exif?.date
    || parseDateFromFilename(photo.filename)
    || parseDateFromFilename(getVariantBaseName(photo));

  if (exif || derivedDate) {
    output.exif = {
      ...(exif || {}),
      ...(derivedDate ? { date: derivedDate } : {})
    };
  }

  const originalBytes = fs.statSync(inputPath).size;
  const reduction = originalBytes > 0
    ? 100 - ((optimizedBytes / originalBytes) * 100)
    : 0;

  const exifStatus = exif ? 'EXIF ok' : 'no EXIF';
  console.log(
    `[${index + 1}/${total}] ${photo.filename}: ${bytesToMB(originalBytes)} -> ` +
    `thumb ${bytesToKB(perVariant.thumbs.webpBytes)} webp / ${bytesToKB(perVariant.thumbs.avifBytes)} avif, ` +
    `medium ${bytesToKB(perVariant.medium.webpBytes)} webp / ${bytesToKB(perVariant.medium.avifBytes)} avif, ` +
    `large ${bytesToKB(perVariant.large.webpBytes)} webp / ${bytesToKB(perVariant.large.avifBytes)} avif ` +
    `(${reduction.toFixed(1)}% net) [${exifStatus}]`
  );

  return {
    photo: output,
    originalBytes,
    optimizedBytes
  };
}

async function processWithConcurrency(items, concurrency, handler) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) return;

      try {
        results[index] = await handler(items[index], index, items.length);
      } catch (err) {
        console.error(`Failed processing ${items[index]?.filename || 'unknown file'}:`, err.message);
        results[index] = null;
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

async function main() {
  console.log('Image Optimization Script');
  console.log('='.repeat(70));

  const descriptions = parseDescriptions();
  const sourcePhotos = buildSourcePhotos();
  const photos = sourcePhotos.map((photo) => {
    const id = normalizePhotoKey(photo.filename);
    const displayTitle = photo.displayTitle || formatDisplayTitle(photo.filename);

    return {
      id,
      filename: photo.filename,
      title: displayTitle,
      displayTitle,
      description: descriptions.get(id) || '',
      category: photo.category || 'ARCHIVE',
      location: photo.location || '',
      variantBaseName: getVariantBaseName(photo)
    };
  });

  const concurrency = parseConcurrency();
  const describedCount = photos.filter((photo) => photo.description).length;

  console.log(`Found ${photos.length} source photos in assets/photos`);
  console.log(`Matched descriptions for ${describedCount}/${photos.length} photos`);
  console.log(`Using concurrency: ${concurrency}`);

  for (const variant of VARIANTS) {
    await ensureDir(variant.dir);
  }

  if (photos.length === 0) {
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify({ photos: [] }, null, 2)}\n`);
    console.log('\nNo photos found. Wrote manifest with empty photos array.');
    console.log('Nothing to optimize.');
    return;
  }

  const processed = await processWithConcurrency(
    photos,
    concurrency,
    processImage
  );

  const results = processed.filter(Boolean);
  const optimizedPhotos = results.map((result) => result.photo);

  const totalOriginalBytes = results.reduce((sum, result) => sum + result.originalBytes, 0);
  const totalOptimizedBytes = results.reduce((sum, result) => sum + result.optimizedBytes, 0);

  const updatedManifest = {
    photos: optimizedPhotos
  };

  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(updatedManifest, null, 2)}\n`);

  const totalReduction = totalOriginalBytes > 0
    ? 100 - ((totalOptimizedBytes / totalOriginalBytes) * 100)
    : 0;

  console.log('\n' + '='.repeat(70));
  console.log(`Processed ${optimizedPhotos.length}/${photos.length} images`);
  console.log(`Original total:  ${bytesToMB(totalOriginalBytes)}`);
  console.log(`Optimized total: ${bytesToMB(totalOptimizedBytes)} (thumbs + medium + large, all formats)`);
  console.log(`Reduction:       ${totalReduction.toFixed(1)}%`);
  console.log('Updated assets/photos/photos.json with variant dimensions, titles, and descriptions.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
