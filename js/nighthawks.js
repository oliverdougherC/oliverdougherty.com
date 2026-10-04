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
    characters.textContent = source;
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
    for (const schedule of schedules) {
      if (schedule) schedule.times = schedule.times.map((time) => time / lastFlip * switching);
    }
    characters.textContent = cells.map((glyph, index) => schedules[index]
      ? String(schedules[index].initial) : glyph).join('');
    artwork.dataset.reveal = 'switching';
    const text = characters.firstChild;
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
      characters.style.color = `rgba(255, 255, 255, ${1 - shade})`;
      characters.style.filter = `grayscale(${1 - saturation})`;
      if (elapsed >= switching) {
        if (artwork.dataset.reveal !== 'color') {
          text.textContent = source;
          artwork.dataset.reveal = 'color';
        }
      } else if (Math.floor(elapsed / 40) !== lastStep) {
        // Batch all cell changes; settled cells stay locked while neighbors continue.
        lastStep = Math.floor(elapsed / 40);
        text.textContent = cells.map((glyph, index) => {
          const schedule = schedules[index];
          if (!schedule) return glyph;
          while (schedule.flipped < schedule.times.length
            && elapsed >= schedule.times[schedule.flipped]) schedule.flipped++;
          return schedule.flipped === schedule.times.length
            ? glyph : String(schedule.initial ^ (schedule.flipped % 2));
        }).join('');
      }
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
    })
    .catch(showFallback);
})();
