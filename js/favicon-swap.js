(function () {
  'use strict';

  function resolveNextHref(href, hidden) {
    return String(href || '').replace(
      /favicon-(happy|sad)\.(svg|ico)/,
      'favicon-' + (hidden ? 'sad' : 'happy') + '.$2'
    );
  }

  function syncFavicons() {
    var hidden = document.hidden;
    var favicon = document.getElementById('favicon');
    var fallback = document.getElementById('favicon-fallback');

    if (favicon) {
      favicon.href = resolveNextHref(favicon.getAttribute('href'), hidden);
    }
    if (fallback) {
      fallback.href = resolveNextHref(fallback.getAttribute('href'), hidden);
    }
  }

  document.addEventListener('visibilitychange', syncFavicons);
})();
