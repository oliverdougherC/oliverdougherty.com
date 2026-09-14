/* Playback lifecycle only. The four drawings and their timing live in HTML/CSS. */
(function () {
  'use strict';
  const pieces = Array.from(document.querySelectorAll('.project-art[data-motion]'));
  if (!pieces.length || !window.IntersectionObserver) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const visible = new Set();
  function syncPlayback() {
    pieces.forEach((piece) => {
      piece.dataset.running = String(visible.has(piece) && !document.hidden && !reduced.matches);
    });
  }

  function start() {
    pieces.forEach((piece) => {
      piece.querySelector('.motion-stage').style.transform = `translate(-50%,-50%) scale(${piece.clientWidth / 500})`;
      piece.dataset.running = 'false';
    });
    if (window.ResizeObserver) {
      const resize = new ResizeObserver((entries) => {
        entries.forEach(({ target, contentRect }) => {
          target.querySelector('.motion-stage').style.transform = `translate(-50%,-50%) scale(${contentRect.width / 500})`;
        });
      });
      pieces.forEach((piece) => resize.observe(piece));
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(({ target, isIntersecting, intersectionRatio }) => {
        if (isIntersecting && intersectionRatio >= .15) visible.add(target);
        else visible.delete(target);
      });
      syncPlayback();
    }, { threshold: [0, .15] });
    pieces.forEach((piece) => observer.observe(piece));
    document.addEventListener('visibilitychange', syncPlayback);
    reduced.addEventListener('change', syncPlayback);
  }
  // Deferred scripts can precede applied styles in WebKit; size after layout.
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
