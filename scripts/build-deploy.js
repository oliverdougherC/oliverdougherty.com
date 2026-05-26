#!/usr/bin/env node
/**
 * Build deployable static output into dist/.
 * Copies the shipped static site, including the gallery assets under /assets/photos.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const ASSET_PHOTOS_DIR = path.join(ROOT, 'assets', 'photos');

const ROOT_ENTRIES = [
  'index.html',
  'CNAME',
  '.nojekyll',
  'mobile',
  'css',
  'js',
  'pages',
  'assets',
  'favicon.svg',
  'favicon.ico',
  'favicon-happy.svg',
  'favicon-happy.ico',
  'favicon-sad.svg',
  'favicon-sad.ico',
  'blogs'
];

function relPath(filePath) {
  return path.relative(ROOT, filePath) || '.';
}

function filterCopy(sourcePath) {
  const base = path.basename(sourcePath);
  if (base === '.DS_Store') return false;
  return true;
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

function main() {
  console.log('Build Deploy Script');
  // Generate blog manifest from .md files
  const buildBlogManifestPath = path.join(__dirname, 'build-blog-manifest.js');
  if (fs.existsSync(buildBlogManifestPath)) {
    require(buildBlogManifestPath);
  }
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

  const sizeBytes = getDirectorySizeBytes(DIST_DIR);
  console.log('-'.repeat(60));
  console.log(`dist/ size: ${bytesToMB(sizeBytes)}`);
  console.log('Build complete: dist/ mirrors the shipped static site.');
}

try {
  main();
} catch (err) {
  console.error('Build failed:', err.message);
  process.exit(1);
}
