/* Native text carries the artwork; the tiny color map supplies one color per cell. */
(function () {
  'use strict';

  const artwork = document.getElementById('nighthawksArtwork');
  const characters = document.getElementById('nighthawksCharacters');
  const fallback = artwork?.querySelector('.nighthawks-fallback');
  if (!artwork || !characters || !fallback) return;

  const source = characters.textContent;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const staged = document.documentElement.matches('.home-stage, .home-stage-collapsed');
  const readyDeadline = Number(document.documentElement.dataset.homeArtDeadline || 0);
  let frame = 0;
  let deadline = 0;
  let baseCells = Array.from(source);
  let revealShade = 1;
  // Returning visits use the opening's typical half-second switching interval.
  let flipCadence = 500;
  // The reveal supplies the current painting; hover composes only touched cells
  // over it. Neither animation can overwrite the other's progress.
  let renderCharacters = () => { characters.firstChild.textContent = baseCells.join(''); };
  // The inline bootstrap owns the black-start window, before this file downloads.
  // Playback belongs to this page visit, independent of scrolling or stage sizing.
  artwork.dataset.reveal = staged && !motion.matches
    && performance.now() < readyDeadline
    ? 'waiting' : 'complete';

  function finishReveal() {
    cancelAnimationFrame(frame);
    clearTimeout(deadline);
    delete document.documentElement.dataset.homeArtDeadline;
    characters.style.removeProperty('color');
    characters.style.removeProperty('filter');
    baseCells = Array.from(source);
    revealShade = 1;
    renderCharacters();
    artwork.dataset.reveal = 'complete';
    window.removeEventListener('pagehide', finishReveal);
  }

  if (artwork.dataset.reveal === 'waiting') {
    // Never hold the black stage indefinitely for a font or image request.
    deadline = setTimeout(finishReveal, Math.max(0, readyDeadline - performance.now()));
    window.addEventListener('pagehide', finishReveal);
  } else {
    delete document.documentElement.dataset.homeArtDeadline;
  }

  function revealCharacters() {
    if (artwork.dataset.reveal !== 'waiting') return;
    // Independent switches and tonal development overlap in the same text grid.
    const switching = 6400;
    const shadingStart = 700;
    const shadingEnd = 6500;
    const colorStart = 2400;
    const complete = 7500;
    const cells = Array.from(source);
    let lastFlip = 0;
    const schedules = cells.map((glyph) => {
      if (glyph === '\n') return null;
      const count = 2 + Math.floor(Math.random() * 9);
      const cadence = 190 + Math.random() * 80;
      let time = Math.random() * 120;
      const times = Array.from({ length: count }, () => {
        time += cadence * (0.8 + Math.random() * 0.4);
        return time;
      });
      lastFlip = Math.max(lastFlip, time);
      // Binary cells arrive at their true value on the last flip, without correction.
      const finalBit = glyph === '0' || glyph === '1' ? Number(glyph) : Math.round(Math.random());
      return { times, initial: finalBit ^ (count % 2), flipped: 0 };
    });
    flipCadence = 230 * switching / lastFlip;
    for (const schedule of schedules) {
      if (schedule) schedule.times = schedule.times.map((time) => time / lastFlip * switching);
    }
    baseCells = cells.map((glyph, index) => schedules[index]
      ? String(schedules[index].initial) : glyph);
    revealShade = 0;
    renderCharacters();
    artwork.dataset.reveal = 'switching';
    const began = performance.now();
    let lastStep = -1;
    clearTimeout(deadline);
    deadline = setTimeout(finishReveal, complete + 1000);

    function tick(now) {
      const elapsed = now - began;
      if (elapsed >= complete) { finishReveal(); return; }
      // The white fill slowly releases the painting's shading while digits still
      // change. Saturation follows later; there is no spatial wipe or phase pause.
      const shade = Math.max(0, Math.min(1, (elapsed - shadingStart) / (shadingEnd - shadingStart)));
      const saturation = Math.max(0, Math.min(1, (elapsed - colorStart) / (complete - colorStart)));
      revealShade = shade;
      characters.style.color = `rgba(255, 255, 255, ${1 - shade})`;
      characters.style.filter = `grayscale(${1 - saturation})`;
      if (elapsed >= switching) {
        if (artwork.dataset.reveal !== 'color') {
          baseCells = Array.from(source);
          artwork.dataset.reveal = 'color';
        }
      } else if (Math.floor(elapsed / 40) !== lastStep) {
        // Batch all cell changes; settled cells stay locked while neighbors continue.
        lastStep = Math.floor(elapsed / 40);
        baseCells = cells.map((glyph, index) => {
          const schedule = schedules[index];
          if (!schedule) return glyph;
          while (schedule.flipped < schedule.times.length
            && elapsed >= schedule.times[schedule.flipped]) schedule.flipped++;
          return schedule.flipped === schedule.times.length
            ? glyph : String(schedule.initial ^ (schedule.flipped % 2));
        });
      }
      renderCharacters();
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
  }

  function showFallback() {
    finishReveal();
    if (artwork.dataset.renderMode === 'text') return;
    characters.hidden = true;
    fallback.hidden = false;
    artwork.dataset.renderMode = 'fallback';
  }

  function enableHover(rowWidth) {
    const pointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const columns = source.indexOf('\n');
    const rows = source.trimEnd().split('\n').length;
    const active = new Map();
    // The artwork font is subsetted: reuse its own glyphs so scrambling credits
    // never falls back to a different font or changes the grid's cell widths.
    const creditGlyphs = Array.from(new Set(source.replace(/\s/g, ''))).join('');
    function scramble(index) {
      const alphabet = /[01]/.test(source[index]) ? '01' : creditGlyphs;
      return alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    // Touched cells briefly return toward the reveal's white fill. The same
    // glyph is used in both layers, including while the reveal is still running.
    const glow = document.createElement('canvas');
    glow.className = 'nighthawks-hover';
    glow.setAttribute('aria-hidden', 'true');
    glow.hidden = true;
    const context = glow.getContext('2d');
    if (!context) return;
    context.font = '800 25px "Nighthawks Mono"';
    const metrics = context.measureText('01');
    // Match the CSS line box, including its negative half-leading. A canvas
    // "middle" baseline uses the em square and would double the painted glyphs.
    const baseline = (26 + metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2;
    artwork.append(glow);
    let hoverFrame = 0;
    let previous = null;
    let bounds;
    let lastPaint = -Infinity;

    renderCharacters = () => {
      const cells = baseCells.slice();
      const now = performance.now();
      context.clearRect(0, 0, rowWidth, rows * 26);
      for (const [index, cell] of active) {
        cells[index] = cell.glyph;
        context.globalAlpha = cell.strength * Math.min(1, Math.max(0, cell.until - now) / 1400) * revealShade * 0.85;
        context.fillText(cell.glyph, cell.col * rowWidth / columns, cell.row * 26 + baseline);
      }
      const text = cells.join('');
      if (characters.firstChild.textContent !== text) characters.firstChild.textContent = text;
      glow.hidden = active.size === 0;
    };

    function reset() {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = 0;
      previous = null;
      active.clear();
      glow.hidden = true;
      renderCharacters();
    }

    function energize(x, y, now) {
      const cellWidth = bounds.width / columns;
      const cellHeight = bounds.height / rows;
      const radius = Math.min(42, bounds.width * 0.035);
      const left = Math.max(0, Math.floor((x - radius) / cellWidth));
      const right = Math.min(columns - 1, Math.floor((x + radius) / cellWidth));
      const top = Math.max(0, Math.floor((y - radius) / cellHeight));
      const bottom = Math.min(rows - 1, Math.floor((y + radius) / cellHeight));
      for (let row = top; row <= bottom; row++) {
        for (let col = left; col <= right; col++) {
          const distance = Math.hypot((col + 0.5) * cellWidth - x, (row + 0.5) * cellHeight - y);
          const index = row * (columns + 1) + col;
          if (distance >= radius || /\s/.test(source[index])) continue;
          const strength = 1 - distance / radius;
          let cell = active.get(index);
          if (!cell) {
            cell = {
              row, col, glyph: scramble(index),
              pace: flipCadence * (0.2 + Math.random() * 0.7),
              nextFlip: now + Math.random() * flipCadence,
              decay: 1100 + Math.random() * 900 + strength * 400,
              until: 0, strength: 0
            };
            active.set(index, cell);
          }
          cell.until = Math.max(cell.until, now + cell.decay);
          cell.strength = Math.max(cell.strength, strength);
        }
      }
    }

    function paint(now) {
      hoverFrame = 0;
      if (now - lastPaint >= 32) {
        lastPaint = now;
        if (previous) energize(previous.x, previous.y, now);
        for (const [index, cell] of active) {
          const remaining = cell.until - now;
          if (remaining <= 0) {
            active.delete(index);
            continue;
          }
          if (now >= cell.nextFlip) {
            cell.glyph = scramble(index);
            // Independent phases, rates, and occasional repeated glyphs create
            // local disorder instead of a patch of bits inverting in unison.
            const cooling = 1 + 2 * (1 - Math.min(1, remaining / cell.decay));
            cell.nextFlip = now + Math.max(65, cell.pace * (0.35 + Math.random() * 1.65) * cooling);
          }
        }
        renderCharacters();
      }
      if (active.size || previous) hoverFrame = requestAnimationFrame(paint);
    }

    artwork.addEventListener('pointermove', (event) => {
      if (!pointer.matches || motion.matches || event.pointerType === 'touch'
        || document.hidden
        || artwork.dataset.renderMode !== 'text') return;
      if (!hoverFrame) {
        bounds = characters.getBoundingClientRect();
        const density = Math.min(window.devicePixelRatio || 1, 2);
        glow.width = Math.ceil(bounds.width * density);
        glow.height = Math.ceil(bounds.height * density);
        context.setTransform(glow.width / rowWidth, 0, 0, glow.height / (rows * 26), 0, 0);
        context.font = '800 25px "Nighthawks Mono"';
        context.textBaseline = 'alphabetic';
        context.fillStyle = '#fff';
      }
      const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const now = performance.now();
      // Join fast pointer samples so a sweep leaves a continuous brush stroke.
      const steps = previous ? Math.min(40, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / 20)) : 1;
      for (let step = 1; step <= steps; step++) {
        energize(previous ? previous.x + (point.x - previous.x) * step / steps : point.x,
          previous ? previous.y + (point.y - previous.y) * step / steps : point.y, now);
      }
      previous = point;
      if (!hoverFrame) hoverFrame = requestAnimationFrame(paint);
    }, { passive: true });
    artwork.addEventListener('pointerleave', () => { previous = null; });
    artwork.addEventListener('pointercancel', reset);
    window.addEventListener('pagehide', reset);
    window.addEventListener('blur', reset);
    window.addEventListener('resize', reset, { passive: true });
    window.addEventListener('scroll', reset, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
    motion.addEventListener('change', reset);
    pointer.addEventListener('change', reset);
  }

  if (!document.fonts || !window.FontFace || !window.CSS
    || !(CSS.supports('background-clip', 'text') || CSS.supports('-webkit-background-clip', 'text'))
    || window.matchMedia('(forced-colors: active)').matches) {
    showFallback();
    return;
  }

  const font = '800 25px "Nighthawks Mono"';
  // Register the loaded face explicitly: WebKit can run deferred scripts before
  // stylesheet font faces enter document.fonts, making fonts.load resolve empty.
  const fontFace = new FontFace('Nighthawks Mono', `url("${artwork.dataset.fontSrc}")`, {
    weight: '800', style: 'normal'
  });
  const fontReady = fontFace.load().then((face) => {
    document.fonts.add(face);
    return face;
  });
  const colorMap = new Image();
  const colorsReady = new Promise((resolve, reject) => {
    colorMap.onload = () => colorMap.naturalWidth === 200 && colorMap.naturalHeight === 63
      ? resolve() : reject(new Error('Unexpected artwork color grid'));
    colorMap.onerror = () => reject(new Error('Artwork color map unavailable'));
    colorMap.src = artwork.dataset.colorMap;
  });
  Promise.all([fontReady, colorsReady])
    .then(async ([face]) => {
      if (face.status !== 'loaded') {
        throw new Error('Artwork font unavailable');
      }
      // A frame applies the artwork's own styles before measurement. Unrelated
      // images and scripts may still be loading; the fallback is already visible.
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const bounds = artwork.getBoundingClientRect();
      if (!bounds.width || !bounds.height) throw new Error('Artwork layout unavailable');
      const context = document.createElement('canvas').getContext('2d');
      if (!context) throw new Error('Font measurement unavailable');
      context.font = font;
      const rowWidth = context.measureText('0'.repeat(200)).width;
      if (!Number.isFinite(rowWidth) || rowWidth <= 0) throw new Error('Invalid character metrics');
      characters.style.width = `${rowWidth}px`;
      // Integer internal rows prevent WebKit rounding a 2.6px mobile line box
      // down to 2px. Text remains live; only its coordinate system is scaled.
      function fit() {
        const size = getComputedStyle(artwork);
        const x = parseFloat(size.width) / rowWidth;
        const y = parseFloat(size.height) / (63 * 26);
        characters.style.transform = `scale(${x}, ${y})`;
      }
      let pendingFrame = 0;
      function scheduleFit() {
        if (pendingFrame) return;
        pendingFrame = requestAnimationFrame(() => { pendingFrame = 0; fit(); });
      }
      fit();
      if (window.ResizeObserver) {
        new ResizeObserver(scheduleFit).observe(artwork);
      } else {
        window.addEventListener('resize', scheduleFit, { passive: true });
      }
      characters.hidden = false;
      fallback.hidden = true;
      revealCharacters();
      artwork.dataset.renderMode = 'text';
      enableHover(rowWidth);
    })
    .catch(showFallback);
})();
