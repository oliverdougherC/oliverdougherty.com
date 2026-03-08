#!/usr/bin/env node
/**
 * Basic smoke checks for critical static-site paths and gallery assets.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'photos.json');

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
  assert(galleryHtml.includes('id="galleryWebglCanvas"'), 'Gallery WebGL canvas missing');
  assert(galleryHtml.includes('id="galleryTabRail"'), 'Gallery tab rail missing');
  assert(galleryHtml.includes('id="galleryModeSwitch"'), 'Gallery mode switch missing');
  assert(galleryHtml.includes('id="galleryModeOverview"'), 'Gallery overview mode button missing');
  assert(galleryHtml.includes('id="galleryModeIndex"'), 'Gallery index mode button missing');
  assert(galleryHtml.includes('id="galleryIndexPanel"'), 'Gallery index panel missing');
  assert(galleryHtml.includes('id="galleryIndexList"'), 'Gallery index list missing');
  assert(galleryHtml.includes('id="galleryCounter"'), 'Gallery counter missing');
  assert(galleryHtml.includes('id="galleryCaption"'), 'Gallery caption missing');
  assert(galleryHtml.includes('id="galleryScrollTrack"'), 'Gallery scroll track missing');
  assert(galleryHtml.includes('data-disable-color-mode="true"'), 'Gallery should disable shared color mode toggle');

  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'pages/dashboard/index.html'), 'utf8');
  assert(dashboardHtml.includes('id="servicesRefreshBtn"'), 'Services refresh button missing');
  assert(dashboardHtml.includes('data-health-url='), 'Services health check attributes missing');
  assert(dashboardHtml.includes('js/dashboard.js'), 'Dashboard status script include missing');

  const homeHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert(homeHtml.includes('id="boredVoid"'), 'Homepage bored-void section missing');
  assert(homeHtml.includes('id="boredPortalButton"'), 'Homepage bored portal button missing');
  assert(homeHtml.includes('href="pages/game/index.html"'), 'Homepage game route link missing');

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
  assert(fs.existsSync(MANIFEST_PATH), 'Missing photos/photos.json');

  const manifest = readJson(MANIFEST_PATH);
  const photos = manifest.photos;
  assert(Array.isArray(photos), 'photos/photos.json must contain a photos array');
  assert(photos.length > 0, 'photos/photos.json has no photos');

  for (const photo of photos) {
    assert(photo.filename, 'Photo entry missing filename');
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
