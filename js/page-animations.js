/**
 * Once-per-visit page animation gate.
 * Loaded synchronously in <head> before stylesheets so CSS autoplay
 * animations can be suppressed on revisit within the same tab session.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'od-page-animations-seen';
  const HARD_RELOAD_KEY = 'od-hard-reload';
  const VALID_PAGE_IDS = new Set(['home', 'resume', 'gallery', 'utilities']);
  const script = document.currentScript;
  const pageId = script?.dataset?.pageId || '';

  function readSeenMap() {
    try {
      const raw = window.sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function writeSeenMap(map) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch (_error) {
      // Ignore storage failures (privacy modes / blocked storage).
    }
  }

  function setHardReloadFlag() {
    try { window.sessionStorage.setItem(HARD_RELOAD_KEY, '1'); } catch (_) {}
    const url = new URL(window.location.href);
    if (!url.searchParams.has('_hr')) {
      url.searchParams.set('_hr', '1');
      history.replaceState(null, '', url);
    }
  }

  function wasHardReload() {
    try {
      if (window.sessionStorage.getItem(HARD_RELOAD_KEY) === '1') return true;
    } catch (_) {}
    try {
      if (new URL(window.location.href).searchParams.get('_hr') === '1') return true;
    } catch (_) {}
    return false;
  }

  function clearHardReloadFlag() {
    try { window.sessionStorage.removeItem(HARD_RELOAD_KEY); } catch (_) {}
    const url = new URL(window.location.href);
    if (url.searchParams.has('_hr')) {
      url.searchParams.delete('_hr');
      history.replaceState(null, '', url);
    }
  }

  function clearPageOnReload(id) {
    if (!id || !VALID_PAGE_IDS.has(id)) return;
    const navEntry = window.performance?.getEntriesByType?.('navigation')?.[0];
    if (!navEntry || navEntry.type !== 'reload') return;
    if (!wasHardReload()) return;
    const seen = readSeenMap();
    delete seen[id];
    writeSeenMap(seen);
  }

  function isPageSeen(id) {
    if (!id || !VALID_PAGE_IDS.has(id)) return false;
    return readSeenMap()[id] === true;
  }

  function markPageSeen(id) {
    if (!id || !VALID_PAGE_IDS.has(id)) return;
    const seen = readSeenMap();
    seen[id] = true;
    writeSeenMap(seen);
  }

  function applySkipFlags(id) {
    const root = document.documentElement;
    root.classList.add('skip-page-animation');
    root.dataset.pageId = id;
    if (id === 'utilities') {
      root.classList.add('utilities-returned');
    }
  }

  let skipApplied = false;

  if (pageId && VALID_PAGE_IDS.has(pageId)) {
    clearPageOnReload(pageId);
    if (isPageSeen(pageId)) {
      applySkipFlags(pageId);
      skipApplied = true;
    } else {
      // Mark on first load so revisits skip even if deferred scripts fail or run late.
      markPageSeen(pageId);
    }
  }

  document.addEventListener('keydown', (event) => {
    const isShift = event.shiftKey;
    const isMetaOrCtrl = event.metaKey || event.ctrlKey;
    const isHardReloadShortcut = (isMetaOrCtrl && isShift && event.code === 'KeyR') ||
                                  (isShift && event.code === 'F5');
    if (isHardReloadShortcut) {
      event.preventDefault();
      setHardReloadFlag();
      window.location.reload();
    }
  });

  window.addEventListener('load', clearHardReloadFlag);

  window.pageAnimations = {
    pageId,
    shouldSkip() {
      return skipApplied;
    },
    markSeen() {
      if (!pageId || skipApplied) return;
      markPageSeen(pageId);
    }
  };
})();
