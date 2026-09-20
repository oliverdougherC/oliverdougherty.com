#!/usr/bin/env node
/**
 * Build deployable static output into dist/.
 * Copies the shipped static site, including the gallery assets under /assets/photos.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const ASSET_PHOTOS_DIR = path.join(ROOT, 'assets', 'photos');

const ROOT_ENTRIES = [
  'index.html',
  '404.html',
  'CNAME',
  '.nojekyll',
  'mobile',
  'css',
  'js',
  'pages',
  'assets',
  'favicon-happy.svg',
  'favicon-happy.ico',
  'favicon-sad.svg',
  'favicon-sad.ico'
];

function relPath(filePath) {
  return path.relative(ROOT, filePath) || '.';
}

const EXCLUDED_FILES = new Set([
  'assets/utilities/vm/TinyCore-11.0.iso',
  'assets/utilities/vm/flwm_topside.tcz',
  'assets/utilities/vm/flwm_topside.tcz.md5.txt',
  'assets/photos/descriptions.md',
  'assets/project-motion',
  'css/project-motion',
  'css/project-motion.css',
  'js/project-motion.js',
  'js/keiri-motion.js',
  'pages/utilities/assets/utilities-app.js',
  'assets/art/nighthawks-binary.png',
  'assets/art/nighthawks-binary.txt'
]);

function filterCopy(sourcePath) {
  const relativePath = path.relative(ROOT, sourcePath).split(path.sep).join('/');
  return path.basename(sourcePath) !== '.DS_Store'
    && !EXCLUDED_FILES.has(relativePath);
}

function assertExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required path missing: ${relPath(filePath)}`);
  }
}

function copyEntry(fromPath, toPath) {
  fs.cpSync(fromPath, toPath, {
    recursive: true,
    force: true,
    filter: filterCopy
  });
  console.log(`Copied ${relPath(fromPath)} -> ${relPath(toPath)}`);
}

function getDirectorySizeBytes(dirPath) {
  let total = 0;

  if (!fs.existsSync(dirPath)) return total;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += getDirectorySizeBytes(fullPath);
    } else {
      total += fs.statSync(fullPath).size;
    }
  }

  return total;
}

function bytesToMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

// Refresh classic script/style URLs when their contents change. Immutable
// utility modules must keep their exact URLs: adding query strings there would
// create a second module identity when a lazy chunk imports the shared entry.
function versionPageAssets(directory, versions = {}) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      versionPageAssets(file, versions);
    } else if (entry.name.endsWith('.html')) {
      const html = fs.readFileSync(file, 'utf8').replace(/((?:src|href)=["'])([^"']+)(["'])/g, (match, before, ref, after) => {
        if (/^(?:[a-z]+:|\/\/)/i.test(ref)) return match;
        const url = new URL(ref, `https://release.invalid/${path.relative(DIST_DIR, file).split(path.sep).join('/')}`);
        if (!/\.(?:css|js)$/.test(url.pathname) || url.pathname.startsWith('/pages/utilities/assets/')) return match;
        const asset = path.join(DIST_DIR, decodeURIComponent(url.pathname));
        assertExists(asset);
        const version = createHash('sha256').update(fs.readFileSync(asset)).digest('hex').slice(0, 16);
        versions[url.pathname] = version;
        url.searchParams.set('v', version);
        return `${before}${ref.split(/[?#]/)[0]}${url.search}${url.hash}${after}`;
      });
      fs.writeFileSync(file, html);
    }
  }
  return versions;
}

function main() {
  console.log('Build Deploy Script');
  console.log('='.repeat(60));

  assertExists(path.join(ASSET_PHOTOS_DIR, 'photos.json'));
  assertExists(path.join(ASSET_PHOTOS_DIR, 'gallery-sequence.json'));
  assertExists(path.join(ASSET_PHOTOS_DIR, 'thumbs'));
  assertExists(path.join(ASSET_PHOTOS_DIR, 'medium'));
  assertExists(path.join(ASSET_PHOTOS_DIR, 'large'));
  [
    'CNAME',
    '.nojekyll',
    'favicon-happy.svg',
    'favicon-happy.ico',
    'favicon-sad.svg',
    'favicon-sad.ico'
  ].forEach((entry) => assertExists(path.join(ROOT, entry)));

  fs.rmSync(DIST_DIR, { recursive: true, force: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  for (const entry of ROOT_ENTRIES) {
    const fromPath = path.join(ROOT, entry);
    if (!fs.existsSync(fromPath)) {
      console.warn(`Skipped missing optional entry: ${entry}`);
      continue;
    }

    const toPath = path.join(DIST_DIR, entry);
    copyEntry(fromPath, toPath);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(DIST_DIR, 'pages/utilities/assets/.vite/manifest.json'), 'utf8'));
  const entry = Object.values(manifest).find(item => item.isEntry);
  if (!entry || !/^utilities-app-[\w-]+\.js$/.test(entry.file)) throw new Error('Hashed utilities entry missing');
  assertExists(path.join(DIST_DIR, 'pages/utilities/assets', entry.file));
  const htmlPath = path.join(DIST_DIR, 'pages/utilities/index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  if (!html.includes('./assets/utilities-app.js?v=workbench-1')) throw new Error('Utilities entry template changed');
  fs.writeFileSync(htmlPath, html.replace('./assets/utilities-app.js?v=workbench-1', `./assets/${entry.file}`));
  // Cached pre-hash HTML/entries still request these stable URLs. Retire them
  // with an explicit reload action instead of a 404 or incompatible controller.
  const migrationImport = "import '../../../js/utilities-legacy-recovery.js';\n";
  const utilityAssets = path.join(DIST_DIR, 'pages/utilities/assets');
  fs.writeFileSync(path.join(utilityAssets, 'utilities-app.js'), migrationImport);
  for (const name of ['AudioFourierController', 'StressTestController', 'RetroVmController']) {
    const file = name[0].toLowerCase() + name.slice(1) + '.js';
    fs.writeFileSync(path.join(utilityAssets, file), migrationImport
      + `export class ${name} { constructor() { throw new Error('Reload tools to use the latest version.'); } }\n`);
  }

  const staticAssetVersions = versionPageAssets(DIST_DIR);
  fs.writeFileSync(path.join(DIST_DIR, 'release-artifact.json'), JSON.stringify({
    kind: 'oliverdougherty-deploy',
    commit: require('node:child_process').execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    worktreeDirty: Boolean(require('node:child_process').execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()),
    entry: entry.file,
    staticAssetVersions
  }, null, 2) + '\n');

  const sizeBytes = getDirectorySizeBytes(DIST_DIR);
  console.log('-'.repeat(60));
  console.log(`dist/ size: ${bytesToMB(sizeBytes)} (${sizeBytes} bytes)`);
  console.log('Build complete: dist/ mirrors the shipped static site.');
}

try {
  main();
} catch (err) {
  console.error('Build failed:', err.message);
  process.exit(1);
}
