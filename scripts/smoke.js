#!/usr/bin/env node
/**
 * Basic smoke checks for critical static-site paths and gallery assets.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'assets', 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'photos.json');
const SEQUENCE_PATH = path.join(PHOTOS_DIR, 'gallery-sequence.json');

const REQUIRED_PAGES = [
  'index.html',
  'pages/resume/index.html',
  'pages/gallery/index.html',
  'pages/archive/index.html',
  'pages/utilities/index.html'
];

const VARIANT_CONFIG = {
  thumbs: 'thumbs',
  medium: 'medium',
  large: 'large'
};

function rel(filePath) {
  return path.relative(ROOT, filePath);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function collectHtmlFiles(dirPath, output = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      collectHtmlFiles(fullPath, output);
      continue;
    }

    if (entry.name.endsWith('.html')) {
      output.push(fullPath);
    }
  }

  return output;
}

function validatePages() {
  for (const page of REQUIRED_PAGES) {
    const pagePath = path.join(ROOT, page);
    assert(fs.existsSync(pagePath), `Missing page: ${page}`);

    const html = fs.readFileSync(pagePath, 'utf8');
    assert(html.includes('<title>'), `Missing <title> tag in ${page}`);
    if (page !== 'index.html' && page !== 'pages/resume/index.html' && page !== 'pages/gallery/index.html') {
      assert(html.includes('data-current-year'), `Missing dynamic year placeholder in ${page}`);
    }

    if (page !== 'index.html' && page !== 'pages/resume/index.html' && page !== 'pages/gallery/index.html' && page !== 'pages/utilities/index.html') {
      assert(html.includes('id="navToggle"'), `Missing shared nav toggle in ${page}`);
    }
  }

  const galleryHtml = fs.readFileSync(path.join(ROOT, 'pages/gallery/index.html'), 'utf8');
  assert(galleryHtml.includes('class="noise-overlay"'), 'Gallery noise overlay missing');
  assert(galleryHtml.includes('id="galleryHeroFeature"'), 'Gallery hero feature card missing');
  assert(galleryHtml.includes('id="galleryArchiveGrid"'), 'Archive gallery grid missing');
  assert(galleryHtml.includes('id="lightboxThumbStrip"'), 'Lightbox thumbnail strip missing');
  assert(!galleryHtml.includes('class="footer gallery-footer"'), 'Gallery footer should be removed');
  assert(!galleryHtml.includes('id="galleryHeroQueue"'), 'Gallery hero support queue should not ship');
  assert(!galleryHtml.includes('id="gallerySearch"'), 'Gallery search input should not ship');
  assert(!galleryHtml.includes('id="galleryHeroTheme"'), 'Gallery category label should not ship');
  assert(!galleryHtml.includes('id="galleryFilterChips"'), 'Gallery filter chips should not ship');
  assert(!galleryHtml.includes('id="galleryClearFilters"'), 'Gallery clear filters control should not ship');
  assert(!galleryHtml.includes('id="galleryEmptyReset"'), 'Gallery empty reset control should not ship');
  assert(!galleryHtml.includes('id="galleryHeroStats"'), 'Legacy hero stat cards should not ship');
  assert(!galleryHtml.includes('id="galleryHeroStrip"'), 'Gallery hero strip should not ship');
  assert(!galleryHtml.includes('id="galleryWebglCanvas"'), 'Gallery should not ship the non-default WebGL canvas');
  assert(!galleryHtml.includes('id="galleryModeSwitch"'), 'Gallery should not include legacy WebGL mode switch');
  assert(!galleryHtml.includes('data-disable-color-mode="true"'), 'Gallery should participate in shared color mode');

  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'pages/utilities/index.html'), 'utf8');
  assert(dashboardHtml.includes('Utilities'), 'Utilities page title missing');
  assert(dashboardHtml.includes('id="utilitiesApp"'), 'Utilities app shell missing');
  assert(dashboardHtml.includes('id="transformGenerateBtn"'), 'Utilities generate button missing');
  assert(dashboardHtml.includes('id="transformSourceCanvas"'), 'Utilities source canvas missing');
  assert(dashboardHtml.includes('id="transformResultCanvas"'), 'Utilities result canvas missing');
  assert(dashboardHtml.includes('id="audioFourierApp"'), 'Audio Fourier shell missing.');
  assert(dashboardHtml.includes('id="audioFourierWaveCanvas"'), 'Audio Fourier waveform canvas missing.');
  assert(dashboardHtml.includes('id="audioFourierGenerateBtn"'), 'Audio Fourier generate button missing.');
  assert(dashboardHtml.includes('id="retroVmApp"'), 'Retro VM shell missing.');
  assert(dashboardHtml.includes('id="retroVmLaunchBtn"'), 'Retro VM launch button missing.');
  assert(dashboardHtml.includes('id="retroVmScreen"'), 'Retro VM screen container missing.');
  assert(dashboardHtml.includes('assets/utilities-app.js'), 'Utilities bundle include missing');
  assert(!dashboardHtml.includes('servicesRefreshBtn'), 'Legacy services refresh UI should not ship');
  assert(!dashboardHtml.includes('data-health-url='), 'Legacy service health attributes should not ship');

  const utilitiesBundlePath = path.join(ROOT, 'pages', 'utilities', 'assets', 'utilities-app.js');
  assert(fs.existsSync(utilitiesBundlePath), 'Utilities bundle missing: pages/utilities/assets/utilities-app.js');
  const utilitiesWorkerDir = path.join(ROOT, 'pages', 'utilities', 'assets', 'assets');
  assert(fs.existsSync(utilitiesWorkerDir), 'Utilities worker asset directory missing: pages/utilities/assets/assets');
  const utilitiesWorkerEntries = fs.readdirSync(utilitiesWorkerDir);
  assert(
    utilitiesWorkerEntries.some((name) => /^audioFourier\.worker-.*\.js$/.test(name)),
    'Audio Fourier worker chunk missing from pages/utilities/assets/assets'
  );
  assert(
    utilitiesWorkerEntries.some((name) => /^transform\.worker-.*\.js$/.test(name)),
    'Image Transform worker chunk missing from pages/utilities/assets/assets'
  );
  assert(
    fs.existsSync(path.join(ROOT, 'assets', 'utilities', 'fourier-decompose', 'Best Friends.flac')),
    'Fourier built-in audio asset missing: assets/utilities/fourier-decompose/Best Friends.flac'
  );

  const homeHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert(!homeHtml.includes('href="pages/archive/index.html"'), 'Homepage should not expose the archive route');
  assert(!homeHtml.includes('Technical Archive'), 'Homepage should not surface the archive portal');
  assert(!homeHtml.includes('Neurophasia'), 'Homepage still references the old archive name');

  const surfacedPages = [
    'pages/resume/index.html',
    'pages/gallery/index.html',
    'pages/utilities/index.html'
  ];
  for (const page of surfacedPages) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert(!html.includes('../archive/index.html'), `${page} should not expose the archive route`);
  }

  const archiveHtmlFiles = collectHtmlFiles(path.join(ROOT, 'pages', 'archive'));
  for (const archiveFilePath of archiveHtmlFiles) {
    const archiveFileHtml = fs.readFileSync(archiveFilePath, 'utf8');
    assert(!archiveFileHtml.includes('Neurophasia'), `Stale archive name present in ${rel(archiveFilePath)}`);
  }
}

function validatePhotoVariantFile(variantKey, photo, format) {
  const variant = photo[variantKey];
  const filename = variant?.[format];
  assert(filename, `Missing ${variantKey}.${format} for ${photo.filename}`);

  const filePath = path.join(PHOTOS_DIR, VARIANT_CONFIG[variantKey], filename);
  assert(fs.existsSync(filePath), `Missing file ${rel(filePath)} for ${photo.filename}`);
}

function validatePhotos() {
  assert(fs.existsSync(MANIFEST_PATH), 'Missing assets/photos/photos.json');
  assert(fs.existsSync(SEQUENCE_PATH), 'Missing assets/photos/gallery-sequence.json');

  const manifest = readJson(MANIFEST_PATH);
  const photos = manifest.photos;
  assert(Array.isArray(photos), 'assets/photos/photos.json must contain a photos array');
  assert(photos.length > 0, 'assets/photos/photos.json has no photos');

  const sequence = readJson(SEQUENCE_PATH);
  assert(Array.isArray(sequence.items), 'assets/photos/gallery-sequence.json must contain an items array');

  for (const photo of photos) {
    assert(photo.filename, 'Photo entry missing filename');
    assert(photo.displayTitle, `Photo entry missing displayTitle for ${photo.filename}`);
    assert(photo.description, `Photo entry missing description for ${photo.filename}`);
    assert(photo.width > 0 && photo.height > 0, `Invalid original dimensions for ${photo.filename}`);

    const originalPath = path.join(PHOTOS_DIR, photo.filename);
    assert(fs.existsSync(originalPath), `Missing original file ${rel(originalPath)}`);

    for (const variantKey of Object.keys(VARIANT_CONFIG)) {
      assert(photo[variantKey], `Missing ${variantKey} object for ${photo.filename}`);

      const width = Number(photo[variantKey].width);
      const height = Number(photo[variantKey].height);
      assert(width > 0 && height > 0, `Invalid ${variantKey} dimensions for ${photo.filename}`);

      validatePhotoVariantFile(variantKey, photo, 'jpg');
      validatePhotoVariantFile(variantKey, photo, 'webp');
      validatePhotoVariantFile(variantKey, photo, 'avif');
    }
  }

  return photos.length;
}

function validateDeployOutput() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return false;

  const cnamePath = path.join(distDir, 'CNAME');
  if (!fs.existsSync(cnamePath)) return false;

  assert(fs.readFileSync(cnamePath, 'utf8').trim() === 'oliverdougherty.com', 'Deploy output CNAME has unexpected contents');
  assert(fs.existsSync(path.join(distDir, '.nojekyll')), 'Deploy output missing .nojekyll');
  assert(
    fs.existsSync(path.join(distDir, 'assets', 'utilities', 'fourier-decompose', 'Best Friends.flac')),
    'Deploy output missing Fourier built-in audio asset'
  );

  const distUtilitiesWorkerDir = path.join(distDir, 'pages', 'utilities', 'assets', 'assets');
  assert(fs.existsSync(distUtilitiesWorkerDir), 'Deploy output missing utilities worker asset directory');
  const workerEntries = fs.readdirSync(distUtilitiesWorkerDir);
  assert(
    workerEntries.some((name) => /^audioFourier\.worker-.*\.js$/.test(name)),
    'Deploy output missing Audio Fourier worker chunk'
  );
  return true;
}

function main() {
  console.log('Smoke Script');
  console.log('='.repeat(60));

  validatePages();
  const photoCount = validatePhotos();
  const deployOutputChecked = validateDeployOutput();
  const verifiedPages = REQUIRED_PAGES.length;

  console.log(`Verified ${verifiedPages} critical pages.`);
  console.log(`Verified optimized assets for ${photoCount} gallery photos.`);
  if (deployOutputChecked) {
    console.log('Verified deploy output utilities assets.');
  }
  console.log('Smoke checks passed.');
}

try {
  main();
} catch (err) {
  console.error('Smoke check failed:', err.message);
  process.exit(1);
}
