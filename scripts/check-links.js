#!/usr/bin/env node
/**
 * Validate local links in HTML files.
 * Checks href/src attributes that point to local files.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRECTORIES = new Set(['.git', 'dist', 'node_modules', 'target', 'image-transform']);

function rel(filePath) {
  return path.relative(ROOT, filePath);
}

function collectHtmlFiles(dirPath, output = []) {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      collectHtmlFiles(fullPath, output);
      continue;
    }

    if (entry.name.endsWith('.html')) {
      output.push(fullPath);
    }
  }

  return output;
}

function isExternalTarget(target) {
  return /^(?:[a-z]+:)?\/\//i.test(target) ||
    target.startsWith('mailto:') ||
    target.startsWith('tel:') ||
    target.startsWith('javascript:') ||
    target.startsWith('data:');
}

function sanitizeTarget(target) {
  return target.split('#')[0].split('?')[0];
}

function resolveLocalTarget(filePath, target) {
  if (target.startsWith('/')) {
    return path.join(ROOT, target.slice(1));
  }

  return path.resolve(path.dirname(filePath), target);
}

function existsLocalTarget(filePath, target) {
  const cleaned = sanitizeTarget(target);
  if (!cleaned) return true;

  const resolved = resolveLocalTarget(filePath, cleaned);

  if (fs.existsSync(resolved)) return true;

  if (!path.extname(resolved) && fs.existsSync(`${resolved}.html`)) {
    return true;
  }

  if (fs.existsSync(path.join(resolved, 'index.html'))) {
    return true;
  }

  return false;
}

function extractLinks(html) {
  const links = [];
  const pattern = /\b(?:href|src)=["']([^"']+)["']/gi;

  let match;
  while ((match = pattern.exec(html)) !== null) {
    links.push(match[1].trim());
  }

  return links;
}

function main() {
  const htmlFiles = collectHtmlFiles(ROOT);
  const failures = [];

  for (const filePath of htmlFiles) {
    const html = fs.readFileSync(filePath, 'utf8');
    const links = extractLinks(html);

    for (const link of links) {
      if (!link || link.startsWith('#')) continue;
      if (isExternalTarget(link)) continue;

      if (!existsLocalTarget(filePath, link)) {
        failures.push({
          filePath,
          link
        });
      }
    }
  }

  console.log('Link Check Script');
  console.log('='.repeat(60));

  if (failures.length > 0) {
    console.error(`Found ${failures.length} broken local link(s):`);
    for (const failure of failures) {
      console.error(`- ${rel(failure.filePath)} -> ${failure.link}`);
    }
    process.exit(1);
  }

  console.log(`All local links resolve (${htmlFiles.length} HTML files checked).`);
}

main();
