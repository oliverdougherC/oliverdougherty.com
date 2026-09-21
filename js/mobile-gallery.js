/**
 * Mobile Gallery JavaScript
 * Self-contained IIFE: loads photo data, renders a 2-column masonry grid,
 * and provides a fullscreen swipeable lightbox.
 *
 * No dependency on gallery.js global state.
 */
(function () {
  'use strict';

  const MANIFEST_PATH = '../../assets/photos/photos.json';
  const SEQUENCE_PATH = '../../assets/photos/gallery-sequence.json';
  const ASSET_BASE = '../../assets/photos/';
  const THUMB_BASE = ASSET_BASE + 'thumbs/';
  const MEDIUM_BASE = ASSET_BASE + 'medium/';
  const LARGE_BASE = ASSET_BASE + 'large/';
  const SWIPE_THRESHOLD = 50;

  let entries = [];
  let currentIndex = -1;
  let touchStartX = 0;
  let touchStartY = 0;
  // Delayed-navigation state: an explicit token + pending target lets close,
  // replacement navigation, and lifecycle events invalidate queued work.
  let navigationTimer = 0;
  let navigationToken = 0;
  let pendingTargetIndex = -1;
  let lastTriggerElement = null;
  let inertElements = [];

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /* ---- Utility functions ---- */

  function basenameFromPath(value) {
    if (!value) return '';
    const normalized = String(value).split('?')[0].split('#')[0];
    const segments = normalized.split('/');
    return segments[segments.length - 1];
  }

  function normalizeGalleryKey(value) {
    const stem = basenameFromPath(value).toLowerCase().replace(/\.(avif|webp|jpe?g|png)$/i, '');
    return stem.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  function formatTitle(filename) {
    const parts = basenameFromPath(filename)
      .replace(/\.(avif|webp|jpe?g|png)$/i, '')
      .split(/[-_]+/)
      .filter(Boolean);
    return parts
      .map(function (part) {
        if (/\d/.test(part)) return part.toUpperCase();
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(' ');
  }

  function resolveVariantPath(variant, format, basePath, fallbackFilename) {
    if (fallbackFilename === void 0) fallbackFilename = '';
    if (variant && variant[format]) return basePath + variant[format];
    if (fallbackFilename && format === 'jpg') return basePath + fallbackFilename;
    return '';
  }

  function extractYear(dateStr) {
    if (!dateStr) return '';
    var match = String(dateStr).match(/^(\d{4})/);
    return match ? match[1] : '';
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    try {
      var date = new Date(dateStr + 'T00:00:00');
      if (isNaN(date.getTime())) return dateStr;
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    } catch (e) {
      return dateStr;
    }
  }

  function buildAssetMap(photo) {
    return {
      thumbJpg: resolveVariantPath(photo.thumbs, 'jpg', THUMB_BASE, photo.filename),
      thumbWebp: resolveVariantPath(photo.thumbs, 'webp', THUMB_BASE),
      thumbAvif: resolveVariantPath(photo.thumbs, 'avif', THUMB_BASE),
      mediumJpg: resolveVariantPath(photo.medium, 'jpg', MEDIUM_BASE, photo.filename),
      mediumWebp: resolveVariantPath(photo.medium, 'webp', MEDIUM_BASE),
      mediumAvif: resolveVariantPath(photo.medium, 'avif', MEDIUM_BASE),
      largeJpg: resolveVariantPath(photo.large, 'jpg', LARGE_BASE, photo.filename),
      largeWebp: resolveVariantPath(photo.large, 'webp', LARGE_BASE),
      largeAvif: resolveVariantPath(photo.large, 'avif', LARGE_BASE),
      thumbWidth: Number(photo.thumbs?.width) || 800,
      thumbHeight: Number(photo.thumbs?.height) || 534,
      mediumWidth: Number(photo.medium?.width) || 1600,
      mediumHeight: Number(photo.medium?.height) || 1067,
      largeWidth: Number(photo.large?.width) || 2400,
      largeHeight: Number(photo.large?.height) || 1601
    };
  }

  function mergeGalleryEntry(photo, manifestIndex, sequenceItems, sequenceLookup) {
    var matchedSequence = sequenceLookup.get(normalizeGalleryKey(photo.id))
      || sequenceLookup.get(normalizeGalleryKey(photo.filename))
      || sequenceLookup.get(normalizeGalleryKey(photo.displayTitle))
      || sequenceLookup.get(normalizeGalleryKey(photo.title))
      || null;

    var sequenceIndex = (matchedSequence && Number.isInteger(matchedSequence.__sequenceIndex))
      ? matchedSequence.__sequenceIndex
      : null;

    var id = matchedSequence?.id
      || photo.id
      || normalizeGalleryKey(photo.filename || photo.displayTitle || photo.title || 'photo-' + (manifestIndex + 1));
    var displayTitle = matchedSequence?.title
      || photo.displayTitle
      || photo.title
      || formatTitle(photo.filename || 'Photo ' + (manifestIndex + 1));
    var date = photo.exif?.date || matchedSequence?.meta?.date || '';
    var year = matchedSequence?.index?.year || extractYear(date) || '';
    var order = sequenceIndex !== null ? sequenceIndex : sequenceItems.length + manifestIndex;

    return {
      id: id,
      displayTitle: displayTitle,
      date: date,
      year: year,
      dateLabel: formatDate(date),
      order: order,
      width: Number(photo.width) || Number(photo.large?.width) || Number(photo.medium?.width) || 1600,
      height: Number(photo.height) || Number(photo.large?.height) || Number(photo.medium?.height) || 1067,
      assets: buildAssetMap(photo)
    };
  }

  /* ---- Data loading ---- */

  async function loadData() {
    var manifestResp, sequenceResp;
    try {
      manifestResp = await fetch(MANIFEST_PATH);
      if (!manifestResp.ok) throw new Error('Manifest fetch failed: ' + manifestResp.status);
    } catch (e) {
      console.error('Failed to load photo manifest:', e);
      throw e;
    }

    var manifest = await manifestResp.json();
    var photos = manifest.photos || [];

    var sequenceItems = [];
    try {
      sequenceResp = await fetch(SEQUENCE_PATH);
      if (sequenceResp.ok) {
        var sequence = await sequenceResp.json();
        sequenceItems = sequence.items || [];
      }
    } catch (e) {
      console.warn('Sequence file not found or failed to load; using manifest order:', e);
    }

    return { photos: photos, sequenceItems: sequenceItems };
  }

  function buildEntries(photos, sequenceItems) {
    var sequenceLookup = new Map();
    sequenceItems.forEach(function (item, idx) {
      item.__sequenceIndex = idx;
      var key = item.id ? normalizeGalleryKey(item.id) : '';
      if (key) sequenceLookup.set(key, item);
      if (item.title) sequenceLookup.set(normalizeGalleryKey(item.title), item);
    });

    return photos.map(function (photo, idx) {
      return mergeGalleryEntry(photo, idx, sequenceItems, sequenceLookup);
    }).sort(function (a, b) {
      return a.order - b.order;
    });
  }

  /* ---- Grid rendering ---- */

  function renderGrid(container, photoEntries) {
    var fragment = document.createDocumentFragment();

    photoEntries.forEach(function (entry, index) {
      var picture = document.createElement('picture');
      var assets = entry.assets;

      if (assets.thumbAvif) {
        var avifSource = document.createElement('source');
        avifSource.srcset = assets.thumbAvif;
        avifSource.type = 'image/avif';
        picture.appendChild(avifSource);
      }

      if (assets.thumbWebp) {
        var webpSource = document.createElement('source');
        webpSource.srcset = assets.thumbWebp;
        webpSource.type = 'image/webp';
        picture.appendChild(webpSource);
      }

      var img = document.createElement('img');
      img.src = assets.thumbJpg || '';
      img.alt = entry.displayTitle || 'Photograph';
      img.setAttribute('data-entry-index', index);
      img.width = assets.thumbWidth;
      img.height = assets.thumbHeight;

      if (index >= 4) {
        img.loading = 'lazy';
        img.decoding = 'async';
      }

      // F08: semantic, keyboard-operable button per photo; the img keeps its
      // data-entry-index attribute for existing selectors. Appearance matches
      // the previous bare-picture grid via css/mobile-gallery.css.
      picture.appendChild(img);

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'mobile-photo-button';
      button.setAttribute('data-entry-index', index);
      button.setAttribute('aria-label', 'Open ' + (entry.displayTitle || 'Photograph') + ' in photo viewer');
      button.appendChild(picture);
      fragment.appendChild(button);
    });

    container.appendChild(fragment);
  }

  /* ---- Lightbox ---- */

  function getLightboxElements() {
    return {
      overlay: document.getElementById('mobileLightbox'),
      close: document.getElementById('mobileLightboxClose'),
      media: document.getElementById('mobileLightboxMedia'),
      sourceAvif: document.getElementById('mobileLightboxSourceAvif'),
      sourceWebp: document.getElementById('mobileLightboxSourceWebp'),
      image: document.getElementById('mobileLightboxImage')
    };
  }

  // trigger: the originating grid button on initial open (drives focus entry
  // and later focus return). Navigation passes no trigger so focus stays put.
  function openLightbox(index, trigger) {
    if (index < 0 || index >= entries.length) return;
    var wasOpen = currentIndex >= 0;
    currentIndex = index;

    var el = getLightboxElements();
    var entry = entries[index];
    var assets = entry.assets;

    // Build srcset with medium + large variants
    var srcsetCandidates = [];
    if (assets.mediumJpg) srcsetCandidates.push(assets.mediumJpg + ' ' + assets.mediumWidth + 'w');
    if (assets.largeJpg) srcsetCandidates.push(assets.largeJpg + ' ' + assets.largeWidth + 'w');
    var jpgSrcset = srcsetCandidates.join(', ');

    var avifSrcsetCandidates = [];
    if (assets.mediumAvif) avifSrcsetCandidates.push(assets.mediumAvif + ' ' + assets.mediumWidth + 'w');
    if (assets.largeAvif) avifSrcsetCandidates.push(assets.largeAvif + ' ' + assets.largeWidth + 'w');

    var webpSrcsetCandidates = [];
    if (assets.mediumWebp) webpSrcsetCandidates.push(assets.mediumWebp + ' ' + assets.mediumWidth + 'w');
    if (assets.largeWebp) webpSrcsetCandidates.push(assets.largeWebp + ' ' + assets.largeWidth + 'w');

    if (el.sourceAvif && avifSrcsetCandidates.length) {
      el.sourceAvif.srcset = avifSrcsetCandidates.join(', ');
      el.sourceAvif.sizes = '100vw';
    }
    if (el.sourceWebp && webpSrcsetCandidates.length) {
      el.sourceWebp.srcset = webpSrcsetCandidates.join(', ');
      el.sourceWebp.sizes = '100vw';
    }

    el.image.src = assets.largeJpg || assets.mediumJpg || '';
    el.image.alt = entry.displayTitle || 'Photograph';
    el.image.style.opacity = '1';

    el.overlay.removeAttribute('hidden');
    document.body.classList.add('mobile-lightbox-open');

    if (!wasOpen) {
      setBackgroundInert(true);
      if (trigger) {
        lastTriggerElement = trigger;
      }
      // F08: move focus into the modal dialog so keyboard and switch-control
      // users are inside it while the photo viewer is up.
      if (el.close) el.close.focus();
    }

    // Preload adjacent entries
    preloadAdjacent(index);
  }

  // F08: with the dialog modal, background content must not be interactive.
  // inert covers modern engines; the fixed full-viewport overlay plus the Tab
  // trap keep interaction contained even where inert is unsupported.
  function setBackgroundInert(active) {
    if (active) {
      inertElements = Array.prototype.filter.call(document.body.children, function (node) {
        return node.nodeType === 1 && node.id !== 'mobileLightbox';
      }).map(function (node) { return { node: node, wasInert: node.hasAttribute('inert') }; });
      inertElements.forEach(function (state) {
        state.node.setAttribute('inert', '');
      });
    } else {
      inertElements.forEach(function (state) {
        if (state.wasInert) state.node.setAttribute('inert', '');
        else state.node.removeAttribute('inert');
      });
      inertElements = [];
    }
  }

  function closeLightbox() {
    cancelPendingNavigation();
    var el = getLightboxElements();
    el.overlay.setAttribute('hidden', '');
    document.body.classList.remove('mobile-lightbox-open');
    currentIndex = -1;
    setBackgroundInert(false);

    // F08: return focus to the control that opened the dialog.
    if (lastTriggerElement && typeof lastTriggerElement.focus === 'function' && lastTriggerElement.isConnected) {
      lastTriggerElement.focus({ preventScroll: true });
    }
    lastTriggerElement = null;
  }

  function cancelPendingNavigation() {
    getLightboxElements().image.style.opacity = '1';
    if (navigationTimer) {
      window.clearTimeout(navigationTimer);
      navigationTimer = 0;
    }
    // Invalidates scheduled fades and pending image-load callbacks too.
    navigationToken += 1;
    pendingTargetIndex = -1;
  }

  // Deterministic rapid-navigation policy: every gesture advances the pending
  // target by one (wraparound), so three fast swipes move three photos even
  // before any commit runs; rendering coalesces onto the newest target and the
  // older timers are cancelled. Close/lifecycle events invalidate the token.
  function navigateLightbox(direction) {
    if (currentIndex < 0 || !entries.length) return;

    var base = pendingTargetIndex >= 0 ? pendingTargetIndex : currentIndex;
    var target = base + direction;
    if (target < 0) target = entries.length - 1;
    if (target >= entries.length) target = 0;

    cancelPendingNavigation();
    var token = navigationToken;
    pendingTargetIndex = target;

    var el = getLightboxElements();
    el.image.style.opacity = '0';

    if (prefersReducedMotion()) {
      commitNavigation(target, token);
      return;
    }

    navigationTimer = window.setTimeout(function () {
      navigationTimer = 0;
      commitNavigation(target, token);
    }, 150);
  }

  function commitNavigation(target, token) {
    if (token !== navigationToken || currentIndex < 0) return;
    pendingTargetIndex = -1;
    openLightbox(target);

    var el = getLightboxElements();
    var img = el.image;
    var reveal = function () {
      if (token !== navigationToken || currentIndex < 0) return;
      img.style.opacity = '1';
    };
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        if (token !== navigationToken || currentIndex < 0) return;
        if (img.complete || img.naturalWidth > 0) {
          reveal();
        } else {
          img.addEventListener('load', reveal, { once: true });
        }
      });
    });
  }

  function preloadAdjacent(index) {
    var prevIndex = index - 1;
    var nextIndex = index + 1;

    if (prevIndex >= 0) {
      var prevJpg = entries[prevIndex].assets.mediumJpg;
      if (prevJpg) {
        var prevImg = new Image();
        prevImg.src = prevJpg;
      }
    }

    if (nextIndex < entries.length) {
      var nextJpg = entries[nextIndex].assets.mediumJpg;
      if (nextJpg) {
        var nextImg = new Image();
        nextImg.src = nextJpg;
      }
    }
  }

  /* ---- Event binding ---- */

  function bindGridClicks(grid) {
    grid.addEventListener('click', function (e) {
      // Delegates from the img (clicks, and Enter/Space activation of the
      // semantic button in real browsers) up to the photo button.
      var button = e.target && e.target.closest
        ? e.target.closest('button[data-entry-index]')
        : null;
      if (!button || !grid.contains(button)) return;
      var index = parseInt(button.getAttribute('data-entry-index'), 10);
      if (!isNaN(index)) {
        openLightbox(index, button);
      }
    });
  }

  function bindLightboxEvents() {
    var el = getLightboxElements();

    // Close button
    el.close.addEventListener('click', function (e) {
      e.stopPropagation();
      closeLightbox();
    });

    // Backdrop tap to close
    el.media.addEventListener('click', function (e) {
      if (e.target === el.media || e.target.tagName === 'PICTURE') {
        closeLightbox();
      }
    });

    // Touch swipe handling
    el.overlay.addEventListener('touchstart', function (e) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    el.overlay.addEventListener('touchend', function (e) {
      var endX = e.changedTouches[0].clientX;
      var endY = e.changedTouches[0].clientY;

      var diffX = touchStartX - endX;
      var diffY = touchStartY - endY;

      // Horizontal swipe: navigate
      if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > SWIPE_THRESHOLD) {
        if (diffX > 0) {
          navigateLightbox(1);  // swipe left → next
        } else {
          navigateLightbox(-1); // swipe right → prev
        }
      }
      // Swipe down: close
      else if (Math.abs(diffY) > Math.abs(diffX) && diffY < -SWIPE_THRESHOLD) {
        closeLightbox();
      }
    }, { passive: true });

    // F08: keyboard control for the modal dialog — Escape dismisses, arrows
    // navigate, Tab stays inside the dialog. Covers keyboard/switch-control
    // users on mobile and anyone opening the mobile URL on a desktop.
    document.addEventListener('keydown', function (e) {
      if (currentIndex < 0) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateLightbox(1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateLightbox(-1);
        return;
      }
      if (e.key === 'Tab') {
        trapDialogFocus(e);
      }
    });

    // Delayed navigation must not survive page suspension.
    window.addEventListener('pagehide', cancelPendingNavigation);
  }

  function trapDialogFocus(event) {
    var overlay = document.getElementById('mobileLightbox');
    if (!overlay || overlay.hasAttribute('hidden')) return;

    var focusables = Array.prototype.filter.call(
      overlay.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      function (node) { return !node.hasAttribute('hidden'); }
    );
    if (!focusables.length) return;

    var first = focusables[0];
    var last = focusables[focusables.length - 1];
    var active = document.activeElement;

    if (!overlay.contains(active)) {
      // Focus escaped into (inert-unsupported) background content: pull it back.
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /* ---- Init ---- */

  function showLoading(show) {
    var loading = document.getElementById('mobileGalleryLoading');
    if (loading) {
      if (show) loading.removeAttribute('hidden');
      else loading.setAttribute('hidden', '');
    }
  }

  function showError(msg) {
    var error = document.getElementById('mobileGalleryError');
    var loading = document.getElementById('mobileGalleryLoading');
    if (msg) {
      var p = error.querySelector('p');
      if (p) p.textContent = msg;
    }
    if (error) error.removeAttribute('hidden');
    if (loading) loading.setAttribute('hidden', '');
  }

  async function init() {
    var grid = document.getElementById('mobileGalleryGrid');
    if (!grid) return;

    bindLightboxEvents();

    try {
      var data = await loadData();
      entries = buildEntries(data.photos, data.sequenceItems);
    } catch (e) {
      console.error('Mobile gallery init failed:', e);
      showError('Gallery data could not be loaded.');
      return;
    }

    showLoading(false);

    if (!entries.length) {
      showError('No photographs found.');
      return;
    }

    renderGrid(grid, entries);
    bindGridClicks(grid);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
