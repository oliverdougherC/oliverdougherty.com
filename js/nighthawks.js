/* Native text carries the artwork; the tiny color map supplies one color per cell. */
(function () {
  'use strict';

  const artwork = document.getElementById('nighthawksArtwork');
  const characters = document.getElementById('nighthawksCharacters');
  const fallback = artwork?.querySelector('.nighthawks-fallback');
  if (!artwork || !characters || !fallback) return;

  function showFallback() {
    if (artwork.dataset.renderMode === 'text') return;
    characters.hidden = true;
    for (const source of fallback.querySelectorAll('source[data-srcset]')) {
      source.srcset = source.dataset.srcset;
    }
    const image = fallback.querySelector('img');
    if (!image.hasAttribute('src')) image.src = image.dataset.src;
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
  // WebKit may finish these resources before deferred styles apply. Measuring
  // then yields auto dimensions and would briefly expose an unscaled text grid.
  const layoutReady = document.readyState === 'complete' ? Promise.resolve()
    : new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
  // A stalled resource must not leave an empty hero indefinitely.
  const fallbackTimer = window.setTimeout(showFallback, 2500);

  Promise.all([fontReady, colorsReady, layoutReady])
    .then(([face]) => {
      if (face.status !== 'loaded') {
        throw new Error('Artwork font unavailable');
      }
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
      artwork.dataset.renderMode = 'text';
    })
    .catch(showFallback)
    .finally(() => window.clearTimeout(fallbackTimer));
})();
