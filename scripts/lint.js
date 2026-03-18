#!/usr/bin/env node
/**
 * Lightweight lint checks for this static site repo.
 * - Validates JavaScript syntax via `node --check`
 * - Validates key JSON files parse correctly
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const JS_DIRECTORIES = ['js', 'scripts'];
const JSON_FILES = ['package.json', 'assets/photos/photos.json', 'assets/photos/gallery-sequence.json'];

function walk(dir, matcher, output = []) {
  if (!fs.existsSync(dir)) return output;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
        continue;
      }
      walk(fullPath, matcher, output);
      continue;
    }

    if (matcher(fullPath)) output.push(fullPath);
  }

  return output;
}

function rel(filePath) {
  return path.relative(ROOT, filePath);
}

function lintJavaScriptFiles() {
  const files = JS_DIRECTORIES.flatMap((dir) =>
    walk(path.join(ROOT, dir), (filePath) => filePath.endsWith('.js'))
  );

  const failures = [];

  for (const filePath of files) {
    try {
      execFileSync(process.execPath, ['--check', filePath], {
        stdio: 'pipe'
      });
    } catch (err) {
      failures.push({ filePath, message: err.stderr?.toString().trim() || err.message });
    }
  }

  if (failures.length > 0) {
    console.error('JavaScript syntax failures:');
    for (const failure of failures) {
      console.error(`- ${rel(failure.filePath)}`);
      console.error(`  ${failure.message}`);
    }
    return false;
  }

  console.log(`JavaScript syntax ok (${files.length} files)`);
  return true;
}

function lintJsonFiles() {
  const failures = [];

  for (const jsonFile of JSON_FILES) {
    const fullPath = path.join(ROOT, jsonFile);

    if (!fs.existsSync(fullPath)) {
      failures.push({ filePath: fullPath, message: 'File not found' });
      continue;
    }

    try {
      JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (err) {
      failures.push({ filePath: fullPath, message: err.message });
    }
  }

  if (failures.length > 0) {
    console.error('JSON validation failures:');
    for (const failure of failures) {
      console.error(`- ${rel(failure.filePath)}: ${failure.message}`);
    }
    return false;
  }

  console.log(`JSON parse ok (${JSON_FILES.length} files)`);
  return true;
}

function lintExternalLinks() {
  const htmlFiles = walk(ROOT, (filePath) => filePath.endsWith('.html'));
  const failures = [];

  for (const filePath of htmlFiles) {
    const html = fs.readFileSync(filePath, 'utf8');
    const anchors = html.match(/<a\b[^>]*target=["']_blank["'][^>]*>/gi) || [];

    anchors.forEach((anchor, index) => {
      const relMatch = anchor.match(/\brel=["']([^"']+)["']/i);
      const relValue = relMatch ? relMatch[1].toLowerCase() : '';
      const hasNoopener = /\bnoopener\b/.test(relValue);
      const hasNoreferrer = /\bnoreferrer\b/.test(relValue);

      if (!hasNoopener || !hasNoreferrer) {
        failures.push({
          filePath,
          index: index + 1,
          anchor
        });
      }
    });
  }

  if (failures.length > 0) {
    console.error('External-link rel validation failures:');
    for (const failure of failures) {
      console.error(`- ${rel(failure.filePath)} (anchor #${failure.index})`);
      console.error(`  ${failure.anchor}`);
    }
    return false;
  }

  console.log(`External-link rel policy ok (${htmlFiles.length} HTML files)`);
  return true;
}

function main() {
  console.log('Lint Script');
  console.log('='.repeat(60));

  const jsOk = lintJavaScriptFiles();
  const jsonOk = lintJsonFiles();
  const linksOk = lintExternalLinks();

  if (!jsOk || !jsonOk || !linksOk) {
    process.exit(1);
  }

  console.log('All lint checks passed.');
}

main();
