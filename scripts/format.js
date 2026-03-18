#!/usr/bin/env node
/**
 * Minimal text normalizer with check/write modes.
 *
 * --check  : report files that need normalization and exit non-zero
 * --write  : apply normalization in-place
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.svg',
  '.txt',
  '.yml',
  '.yaml'
]);

const TEXT_FILENAMES = new Set(['.gitignore', '.gitattributes']);

const SKIP_DIRECTORIES = new Set(['.git', '.claude', '.codex-tmp', 'dist', 'node_modules', 'output']);
const SKIP_PREFIXES = ['assets/photos/thumbs', 'assets/photos/medium', 'assets/photos/large', 'pages/game/assets'];

function rel(filePath) {
  return path.relative(ROOT, filePath);
}

function shouldSkipDirectory(relativePath) {
  if (!relativePath) return false;

  const base = path.basename(relativePath);
  if (SKIP_DIRECTORIES.has(base)) return true;

  return SKIP_PREFIXES.some((prefix) =>
    relativePath === prefix || relativePath.startsWith(`${prefix}${path.sep}`)
  );
}

function isTextFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  return TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(name);
}

function normalizeText(content) {
  let next = content.replace(/\r\n/g, '\n');
  next = next.replace(/[ \t]+$/gm, '');

  if (!next.endsWith('\n')) {
    next += '\n';
  }

  return next;
}

function collectFiles(dirPath, output = []) {
  const relativeDir = rel(dirPath);
  if (shouldSkipDirectory(relativeDir)) return output;

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      collectFiles(fullPath, output);
      continue;
    }

    if (!isTextFile(fullPath)) continue;
    output.push(fullPath);
  }

  return output;
}

function main() {
  const isWriteMode = process.argv.includes('--write');
  const mode = isWriteMode ? 'write' : 'check';

  const files = collectFiles(ROOT);
  const changed = [];

  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const normalized = normalizeText(original);

    if (original === normalized) continue;

    changed.push(filePath);

    if (mode === 'write') {
      fs.writeFileSync(filePath, normalized);
    }
  }

  console.log(`Format Script (${mode})`);
  console.log('='.repeat(60));

  if (changed.length === 0) {
    console.log('No formatting changes needed.');
    return;
  }

  if (mode === 'write') {
    console.log(`Updated ${changed.length} file(s):`);
  } else {
    console.log(`Formatting required in ${changed.length} file(s):`);
  }

  for (const filePath of changed) {
    console.log(`- ${rel(filePath)}`);
  }

  if (mode === 'check') {
    process.exit(1);
  }
}

main();
