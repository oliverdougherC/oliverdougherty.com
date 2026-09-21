#!/usr/bin/env node
'use strict';
// Original continuous Saturn drawing sampled onto one fixed character lattice.
// The degraded plate is derived from those exact samples: block averaging and
// quantization, never a second drawing or a change in camera/framing.
const fs = require('node:fs');
const path = require('node:path');
const columns = 85;
const rows = 43;
const dx = 5.1;
const dy = 6.2;
const left = (500 - columns * dx) / 2;
const top = (320 - rows * dy) / 2;
const ramp = ' .:oO*#%@';
const clamp = (n) => Math.max(0, Math.min(1, n));
function scene(x, y) {
  const px = x - 250;
  const py = y - 157;
  const radius = 83;
  const distance = Math.hypot(px, py);
  const angle = -.27;
  const rx = px * Math.cos(angle) + py * Math.sin(angle);
  const ry = -px * Math.sin(angle) + py * Math.cos(angle);
  const ring = Math.hypot(rx / 174, ry / 47);
  const ringMask = ring > .59 && ring < 1;
  const cassini = ring > .825 && ring < .853;
  const ringLight = cassini ? .015 : ring < .67 ? .32 : ring < .77 ? .66
    : ring < .825 ? .9 : ring < .9 ? .72 : ring < .96 ? .48 : .25;
  let brightness = ringMask ? ringLight : 0;
  if (distance < radius) {
    const nx = px / radius;
    const ny = py / radius;
    const nz = Math.sqrt(1 - nx * nx - ny * ny);
    const lighting = clamp(-nx * .48 - ny * .34 + nz * .78);
    const latitude = ny + nx * .14;
    const bands = .84 + .13 * Math.cos(latitude * 18 + nx * .6);
    brightness = (.1 + .86 * Math.pow(lighting, .75)) * bands;
  }
  // The foreground arc crosses the same sphere rather than orbiting a different
  // center. Its fine Cassini division is intentionally lost in the coarse plate.
  if (ringMask && ry > 0) brightness = ringLight;
  return brightness;
}
const fine = Array.from({ length: rows }, (_, y) => Array.from({ length: columns }, (_, x) =>
  scene(left + (x + .5) * dx, top + y * dy)));
const coarse = fine.map((row, y) => row.map((_value, x) => {
  const bx = Math.floor(x / 3) * 3;
  const by = Math.floor(y / 2) * 2;
  let sum = 0;
  let count = 0;
  for (let yy = by; yy < Math.min(rows, by + 2); yy += 1) {
    for (let xx = bx; xx < Math.min(columns, bx + 3); xx += 1) { sum += fine[yy][xx]; count += 1; }
  }
  return Math.round(sum / count * 4) / 4;
}));
function plate(values, className) {
  return `<g class="vmaf-plate ${className}"><rect width="500" height="320" fill="#090909"/>\n` + values.map((row, y) => {
    const text = row.map((value) => ramp[Math.round(clamp(value) * (ramp.length - 1))]).join('');
    return `    <text x="${left}" y="${(top + y * dy).toFixed(1)}" textLength="${columns * dx}" lengthAdjust="spacingAndGlyphs" xml:space="preserve">${text}</text>`;
  }).join('\n') + '\n  </g>';
}
const markup = `<!-- Both plates share the same sample lattice and continuous source image. -->
<svg class="vmaf-scene" viewBox="0 0 500 320" aria-hidden="true" focusable="false">
  ${plate(coarse, 'vmaf-coarse')}
  ${plate(fine, 'vmaf-fine')}
  <g class="vmaf-stars"><path d="M75 57v5m-2.5-2.5h5M424 256v4m-2-2h4"/><circle cx="389" cy="46" r=".65"/></g>
  <path class="vmaf-boundary" d="M0 38V282"/>
</svg>\n`;
fs.writeFileSync(path.resolve(__dirname, '../assets/project-motion/vmaf.html'), markup);
console.log(`Built aligned ${columns}×${rows} VMAF character plates from one source.`);
