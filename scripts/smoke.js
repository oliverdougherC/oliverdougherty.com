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
  '404.html',
  'pages/resume/index.html',
  'pages/gallery/index.html',
  'mobile/index.html',
  'mobile/resume/index.html',
  'mobile/gallery/index.html',
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

function validatePages() {
  for (const page of REQUIRED_PAGES) {
    const pagePath = path.join(ROOT, page);
    assert(fs.existsSync(pagePath), `Missing page: ${page}`);

    const html = fs.readFileSync(pagePath, 'utf8');
    assert(html.includes('<title>'), `Missing <title> tag in ${page}`);
    if (page.startsWith('mobile/') || page === 'pages/utilities/index.html') {
      assert(html.includes('data-current-year'), `Missing dynamic year placeholder in ${page}`);
    }

    // A render-blocking Google Fonts <link> white-screens the whole page until
    // the stylesheet resolves; every font link must use the media=print swap.
    const outsideNoScript = html.replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
    const fontLinks = outsideNoScript.match(/<link[^>]*fonts\.googleapis\.com\/css2[^>]*>/g) ?? [];
    for (const fontLink of fontLinks) {
      assert(
        /media="print"/.test(fontLink) && /onload="this\.media='all'"/.test(fontLink),
        `Google Fonts link in ${page} must load non-blocking (media="print" swap pattern)`
      );
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
  assert(galleryHtml.includes('data-disable-color-mode'), 'Gallery fixed color scheme missing');

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
  assert(
    fs.existsSync(path.join(ROOT, 'assets', 'utilities', 'fourier-decompose', 'Best Friends.flac')),
    'Fourier built-in audio asset missing: assets/utilities/fourier-decompose/Best Friends.flac'
  );

  validateRetainedUtilityAssets(ROOT);

  for (const page of ['index.html', 'mobile/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    assert(html.includes('id="nighthawksArtwork"'), `${page}: Nighthawks artwork missing`);
    assert(html.includes('id="home-intro-title"'), `${page}: introduction missing`);
    assert(html.includes('home-header'), `${page}: shared homepage header missing`);
    assert(!/class="[^"]*(?:about-stats|mobile-stat-grid)/.test(html), `${page}: retired profile facts remain`);
    const projects = [...html.matchAll(/data-project="([^"]+)"/g)].map((match) => match[1]);
    assert(projects.join('|') === 'Encoding_Database|BetterVMAF|Keiri|Lyra', `${page}: pinned project order incomplete`);
    for (const project of html.matchAll(/<article\b[^>]*data-project="([^"]+)"[^>]*>([\s\S]*?)<\/article>/g)) {
      const [, name, content] = project;
      assert((content.match(/<h3\b/g) || []).length === 1, `${page}: ${name} title missing`);
      for (const marker of ['project-copy', 'project-hook', 'project-link']) {
        assert((content.match(new RegExp(`class="[^"]*\\b${marker}\\b`, 'g')) || []).length === 1, `${page}: ${name} should contain one ${marker}`);
      }
      assert(/class="project-blurb"/.test(content), `${page}: ${name} prose missing`);
      assert(!/<details\b|<img\b|<button\b|<input\b|<label\b|tabindex=|project-art|motion-stage|<svg\b|<canvas\b/.test(content), `${page}: ${name} retains project controls or screenshots`);
    }
    assert(!/project-motion|keiri-motion|data-motion=/.test(html), `${page}: retired animation runtime remains`);
    for (const marker of ['data-copy-email', 'data-copy-status', 'js/home-interactions.js']) {
      assert(html.includes(marker), `${page}: homepage interaction missing: ${marker}`);
    }
    assert(!html.includes('data-binary-hello'), `${page}: retired binary greeting remains`);
    assert(html.includes('nighthawks-credited.png') && html.includes('<noscript>'), `${page}: credited no-JavaScript fallback missing`);
    assert(html.includes('js/nighthawks.js'), `${page}: character renderer missing`);
    const characters = html.match(/<pre\b[^>]*id="nighthawksCharacters"[^>]*>([\s\S]*?)<\/pre>/);
    assert(characters, `${page}: character grid missing`);
    const source = fs.readFileSync(path.join(ROOT, 'assets/art/nighthawks-binary.txt'), 'utf8');
    const normalise = (text) => text.replace(/\r\n/g, '\n').replace(/\n$/, '');
    assert(normalise(characters[1]) === normalise(source), `${page}: character grid differs from credited text source`);
    assert(html.includes('role="img"') && html.includes('aria-hidden="true"'), `${page}: artwork accessibility markup missing`);
    assert(!/blueprint-title|particle-canvas|diamond-divider/.test(html), `${page}: retired homepage hero remains`);
  }
  for (const file of ['nighthawks-binary.png', 'nighthawks-binary.txt', 'nighthawks-credited.png', 'nighthawks-colors.png']) {
    assert(fs.existsSync(path.join(ROOT, 'assets/art', file)), `Missing homepage artwork: ${file}`);
  }

  assert(fs.existsSync(path.join(ROOT, 'js/nighthawks.js')), 'Character artwork renderer missing');

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
}

function validateRetainedUtilityAssets(root) {
  const retained = [
    'assets/utilities/vm/tinycore-retro-vm.iso',
    'assets/utilities/vm/seabios.bin',
    'assets/utilities/vm/vgabios.bin'
  ];
  for (const file of retained) {
    assert(fs.existsSync(path.join(root, file)), `Retained utility asset missing: ${path.relative(ROOT, root)}/${file}`);
  }
  assert(fs.existsSync(path.join(root, 'pages/utilities/assets/v86.wasm')), 'Retained v86 runtime missing');
  const workerDir = path.join(root, 'pages/utilities/assets/assets');
  assert(fs.existsSync(workerDir), `Utility worker directory missing: ${rel(workerDir)}`);
  const entries = fs.readdirSync(workerDir);
  for (const pattern of [/^audioFourier\.worker-.*\.js$/, /^transform\.worker-.*\.js$/]) {
    assert(entries.some((name) => pattern.test(name)), `Utility build asset missing: ${pattern}`);
  }
  assert(!entries.some((name) => /^matching\.worker-/.test(name)), 'Retired matching worker should not ship');
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
  assert(fs.existsSync(distDir), 'Deploy output missing: run npm run build:deploy');

  const cnamePath = path.join(distDir, 'CNAME');
  assert(fs.existsSync(cnamePath), 'Deploy output missing CNAME');

  assert(fs.readFileSync(cnamePath, 'utf8').trim() === 'oliverdougherty.com', 'Deploy output CNAME has unexpected contents');
  assert(fs.existsSync(path.join(distDir, '.nojekyll')), 'Deploy output missing .nojekyll');
  for (const page of REQUIRED_PAGES) assert(fs.existsSync(path.join(distDir, page)), `Deploy output missing page: ${page}`);
  assert(
    fs.existsSync(path.join(distDir, 'assets', 'utilities', 'fourier-decompose', 'Best Friends.flac')),
    'Deploy output missing Fourier built-in audio asset'
  );

  validateRetainedUtilityAssets(distDir);
  for (const excluded of [
    'assets/utilities/vm/TinyCore-11.0.iso',
    'assets/utilities/vm/flwm_topside.tcz',
    'assets/utilities/vm/flwm_topside.tcz.md5.txt',
    'assets/photos/descriptions.md',
    'assets/project-motion',
    'css/project-motion',
    'css/project-motion.css',
    'js/project-motion.js',
    'js/keiri-motion.js',
    'blogs',
    'pages/archive',
    'css/darkroom',
    'js/darkroom'
  ]) {
    assert(!fs.existsSync(path.join(distDir, excluded)), `Deploy output contains retired or authoring-only path: ${excluded}`);
  }
  return true;
}

function main() {
  console.log('Smoke Script');
  console.log('='.repeat(60));

  const deployOnly = process.argv.includes('--deploy-only');
  const sourceOnly = process.argv.includes('--source-only');
  if (!deployOnly) validatePages();
  const photoCount = deployOnly ? 0 : validatePhotos();
  const deployOutputChecked = sourceOnly ? false : validateDeployOutput();
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
