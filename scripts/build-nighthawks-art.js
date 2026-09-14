#!/usr/bin/env node

// Build native-text color data and a credited raster fallback from the source export.
// Fallback raster authoring uses Menlo on the Mac; the website's font is self-hosted.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..');
const ART = path.join(ROOT, 'assets/art');
const CREDITS = [
  { row: 58, column: 3, text: 'NIGHTHAWKS' },
  { row: 60, column: 3, text: 'EDWARD HOPPER, 1942' }
];

function runs(values) {
  const result = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    if (values[i] && start < 0) start = i;
    if (!values[i] && start >= 0) {
      result.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return result;
}

function cellEdges(bands, index, limit) {
  return [
    index ? Math.floor((bands[index - 1].end + bands[index].start) / 2) + 1 : 0,
    index + 1 < bands.length ? Math.floor((bands[index].end + bands[index + 1].start) / 2) + 1 : limit
  ];
}

async function main() {
  const grid = (await fs.readFile(path.join(ART, 'nighthawks-binary.txt'), 'utf8')).trimEnd().split('\n');
  assert.equal(grid.length, 63);
  assert(grid.every((row) => row.length === 200));
  const { data: original, info } = await sharp(path.join(ART, 'nighthawks-binary.png'))
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const pixels = Buffer.from(original);
  const occupiedRows = new Uint8Array(height);
  const occupiedColumns = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      const peak = Math.max(original[offset], original[offset + 1], original[offset + 2]);
      if (peak > 15) occupiedRows[y] = 1;
      if (peak > 30) occupiedColumns[x] = 1;
    }
  }
  const rows = runs(occupiedRows);
  const columns = runs(occupiedColumns);
  assert.equal(rows.length, grid.length, 'Source glyph rows could not be identified');
  assert.equal(columns.length, 200, 'Source glyph columns could not be identified');
  const colorGrid = Buffer.alloc(200 * 63 * 3);
  for (let row = 0; row < 63; row++) {
    for (let column = 0; column < 200; column++) {
      let best = -1;
      let color = [0, 0, 0];
      for (let y = rows[row].start; y <= rows[row].end; y++) {
        for (let x = columns[column].start; x <= columns[column].end; x++) {
          const offset = (y * width + x) * 3;
          const sum = original[offset] + original[offset + 1] + original[offset + 2];
          if (sum > best) {
            best = sum;
            color = Array.from(original.subarray(offset, offset + 3));
          }
        }
      }
      if (CREDITS.some((credit) => credit.row === row
        && column >= credit.column && column < credit.column + credit.text.length)) {
        color = [255, 255, 255];
      }
      colorGrid.set(color, (row * 200 + column) * 3);
    }
  }
  await sharp(colorGrid, { raw: { width: 200, height: 63, channels: 3 } })
    .png({ palette: true, colours: 256, effort: 10 })
    .toFile(path.join(ART, 'nighthawks-colors.png'));
  const edits = [];
  for (const credit of CREDITS) {
    assert.equal(grid[credit.row].slice(credit.column, credit.column + credit.text.length), credit.text);
    for (let i = 0; i < credit.text.length; i++) {
      const character = grid[credit.row][credit.column + i];
      const column = credit.column + i;
      const [left, right] = cellEdges(columns, column, width);
      const [top, bottom] = cellEdges(rows, credit.row, height);
      const color = [255, 255, 255];
      // Clear only the replaced cell; white lettering stays legible in the field.
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const offset = (y * width + x) * 3;
          pixels.fill(0, offset, offset + 3);
        }
      }
      if (character !== ' ') {
        const { data: glyph, info: glyphInfo } = await sharp({ text: {
          text: `<span foreground="#ffffff">${character}</span>`,
          font: 'Menlo Bold 49', rgba: true, dpi: 72
        } }).raw().toBuffer({ resolveWithObject: true });
        assert(glyphInfo.width <= right - left, 'Replacement glyph exceeds its cell');
        const x0 = Math.round((columns[column].start + columns[column].end + 1 - glyphInfo.width) / 2);
        const y0 = character === ',' ? rows[credit.row].end - 3 : rows[credit.row].end + 1 - glyphInfo.height;
        for (let y = 0; y < glyphInfo.height; y++) {
          for (let x = 0; x < glyphInfo.width; x++) {
            const targetX = x0 + x;
            const targetY = y0 + y;
            if (targetX < left || targetX >= right || targetY < top || targetY >= bottom) continue;
            const alpha = glyph[(y * glyphInfo.width + x) * 4 + 3] / 255;
            const offset = (targetY * width + targetX) * 3;
            for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = Math.round(color[channel] * alpha);
          }
        }
      }
      edits.push({ row: credit.row, column, character, left, right, top, bottom, color });
    }
  }
  const output = path.join(ART, 'nighthawks-credited.png');
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toFile(output);
  for (const size of [720, 1440, 2880]) {
    await sharp(output).resize({ width: size }).webp({ quality: 95, effort: 6 })
      .toFile(path.join(ART, `nighthawks-credited-${size}.webp`));
  }
  const evidence = path.join(ROOT, 'output/nighthawks-cells');
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(path.join(evidence, 'edits.json'), JSON.stringify(edits, null, 2) + '\n');
  const text = grid.join('\n').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  for (const page of ['index.html', 'mobile/index.html']) {
    const filename = path.join(ROOT, page);
    const html = await fs.readFile(filename, 'utf8');
    const pattern = /(<pre\b[^>]*\bid="nighthawksCharacters"[^>]*>)[\s\S]*?<\/pre>/;
    assert(pattern.test(html), `Missing character-grid slot in ${page}`);
    await fs.writeFile(filename, html.replace(pattern, (_match, opening) => `${opening}${text}</pre>`));
  }
  console.log(`Built 200 × 63 text/color grid and raster fallbacks; ${edits.length} white credit cells.`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
