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
  'pages/dashboard/index.html'
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
    assert(html.includes('data-current-year'), `Missing dynamic year placeholder in ${page}`);

    if (page !== 'pages/gallery/index.html') {
      assert(html.includes('id="navToggle"'), `Missing shared nav toggle in ${page}`);
      assert(html.includes('data-theme-toggle'), `Missing theme toggle mount in ${page}`);
    }
  }

  const galleryHtml = fs.readFileSync(path.join(ROOT, 'pages/gallery/index.html'), 'utf8');
  assert(galleryHtml.includes('id="navToggle"'), 'Gallery shared nav toggle missing');
  assert(galleryHtml.includes('data-theme-toggle'), 'Gallery theme toggle missing');
  assert(galleryHtml.includes('id="navOverlay"'), 'Gallery shared nav overlay missing');
  assert(galleryHtml.includes('class="noise-overlay"'), 'Gallery noise overlay missing');
  assert(galleryHtml.includes('id="galleryHeroFeature"'), 'Gallery hero feature card missing');
  assert(galleryHtml.includes('id="galleryArchiveGrid"'), 'Archive gallery grid missing');
  assert(galleryHtml.includes('id="lightboxThumbStrip"'), 'Lightbox thumbnail strip missing');
  assert(galleryHtml.includes('class="footer gallery-footer"'), 'Gallery footer class missing');
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

  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'pages/dashboard/index.html'), 'utf8');
  assert(dashboardHtml.includes('Utilities - Oliver Dougherty'), 'Utilities page title missing');
  assert(dashboardHtml.includes('id="utilitiesApp"'), 'Utilities app shell missing');
  assert(dashboardHtml.includes('id="transformGenerateBtn"'), 'Utilities generate button missing');
  assert(dashboardHtml.includes('id="transformSourceCanvas"'), 'Utilities source canvas missing');
  assert(dashboardHtml.includes('id="transformResultCanvas"'), 'Utilities result canvas missing');
  assert(dashboardHtml.includes('id="retroVmApp"'), 'Retro VM shell missing.');
  assert(dashboardHtml.includes('id="retroVmLaunchBtn"'), 'Retro VM launch button missing.');
  assert(dashboardHtml.includes('id="retroVmScreen"'), 'Retro VM screen container missing.');
  assert(dashboardHtml.includes('assets/utilities-app.js'), 'Utilities bundle include missing');
  assert(!dashboardHtml.includes('servicesRefreshBtn'), 'Legacy services refresh UI should not ship');
  assert(!dashboardHtml.includes('data-health-url='), 'Legacy service health attributes should not ship');

  const utilitiesBundlePath = path.join(ROOT, 'pages', 'dashboard', 'assets', 'utilities-app.js');
  assert(fs.existsSync(utilitiesBundlePath), 'Utilities bundle missing: pages/dashboard/assets/utilities-app.js');

  const homeHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert(homeHtml.includes('id="boredVoid"'), 'Homepage bored-void section missing');
  assert(homeHtml.includes('id="boredPortalButton"'), 'Homepage bored portal button missing');
  assert(homeHtml.includes('href="pages/game/index.html"'), 'Homepage game route link missing');
  assert(homeHtml.includes('Technical Archive'), 'Homepage archive portal title missing');
  assert(!homeHtml.includes('Neurophasia'), 'Homepage still references the old archive name');

  const archiveHtmlFiles = collectHtmlFiles(path.join(ROOT, 'pages', 'archive'));
  for (const archiveFilePath of archiveHtmlFiles) {
    const archiveFileHtml = fs.readFileSync(archiveFilePath, 'utf8');
    assert(!archiveFileHtml.includes('Neurophasia'), `Stale archive name present in ${rel(archiveFilePath)}`);
  }

  const gamePagePath = path.join(ROOT, 'pages/game/index.html');
  assert(fs.existsSync(gamePagePath), 'Game page missing: pages/game/index.html');
  const gameHtml = fs.readFileSync(gamePagePath, 'utf8');
  assert(gameHtml.includes('id="gameRoot"'), 'Game root container missing');
  assert(gameHtml.includes('assets/') && gameHtml.includes('.js'), 'Game page missing built JS asset reference');

  const gameAssetsDir = path.join(ROOT, 'pages/game/assets');
  assert(fs.existsSync(gameAssetsDir), 'Game assets directory missing');
  const gameAssetEntries = fs.readdirSync(gameAssetsDir);
  assert(gameAssetEntries.some((name) => name.endsWith('.js')), 'No game JS bundle found in pages/game/assets');
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

function main() {
  console.log('Smoke Script');
  console.log('='.repeat(60));

  validatePages();
  const photoCount = validatePhotos();
  const verifiedPages = REQUIRED_PAGES.length + 1; // + game page

  console.log(`Verified ${verifiedPages} critical pages.`);
  console.log(`Verified optimized assets for ${photoCount} gallery photos.`);
  console.log('Smoke checks passed.');
}

try {
  main();
} catch (err) {
  console.error('Smoke check failed:', err.message);
  process.exit(1);
}
