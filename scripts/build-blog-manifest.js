#!/usr/bin/env node
/**
 * Scans blogs/ directory for .md files and writes blogs/manifest.json.
 * Each entry contains the filename, slug, and optional frontmatter date.
 */

const fs = require('fs');
const path = require('path');

const BLOGS_DIR = path.join(__dirname, '..', 'blogs');
const MANIFEST_PATH = path.join(BLOGS_DIR, 'manifest.json');

function slugify(filename) {
  return filename
    .replace('.md', '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result = {};
  for (const line of match[1].split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

function main() {
  if (!fs.existsSync(BLOGS_DIR)) {
    console.error('blogs/ directory not found');
    process.exit(1);
  }

  const entries = [];

  for (const name of fs.readdirSync(BLOGS_DIR)) {
    if (!name.endsWith('.md')) continue;

    const filePath = path.join(BLOGS_DIR, name);
    if (!fs.statSync(filePath).isFile()) continue;

    const content = fs.readFileSync(filePath, 'utf8');
    const frontmatter = parseFrontmatter(content);

    entries.push({
      filename: name,
      slug: slugify(name),
      date: frontmatter.date || null
    });
  }

  entries.sort((a, b) => {
    const tsA = a.date ? new Date(a.date).getTime() : 0;
    const tsB = b.date ? new Date(b.date).getTime() : 0;
    if (tsA && tsB) return tsB - tsA;
    if (tsA) return -1;
    if (tsB) return 1;
    return a.filename.localeCompare(b.filename);
  });

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2) + '\n');
  console.log(`Wrote ${entries.length} entries to manifest.json`);
}

main();
