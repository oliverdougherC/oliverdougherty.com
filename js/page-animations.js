/**
 * Once-per-visit page animation gate.
 * Loaded synchronously in <head> before stylesheets so CSS autoplay
 * animations can be suppressed on revisit within the same tab session.
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'od-page-animations-seen';
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

  function clearPageOnReload(id) {
    if (!id || !VALID_PAGE_IDS.has(id)) return;

    const navEntry = window.performance?.getEntriesByType?.('navigation')?.[0];
    if (!navEntry || navEntry.type !== 'reload') return;

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
