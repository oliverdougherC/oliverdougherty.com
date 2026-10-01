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
  // Issue #40: bound every fetch so a stalled optional sequence falls back to
  // manifest order quickly and a stalled required manifest lands in a visible,
  // retryable error state instead of an endless spinner. Test hook mirrors the
  // desktop one so suites can shorten the waits deterministically.
  var GALLERY_FETCH_TIMEOUTS = (function () {
    var configured = (typeof window !== 'undefined' && window.__MOBILE_GALLERY_FETCH_TIMEOUTS__) || {};
    var pick = function (value, fallback) {
      return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
    };
    return {
      manifest: pick(configured.manifest, 8000),
      sequence: pick(configured.sequence, 3000)
    };
  })();
  var GALLERY_RETRY_COPY = 'Gallery data could not be loaded. Check your connection and try again.';

  let entries = [];
  let requestedIndex = -1;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchIdentifier = null;
  // One displayed frame and one requested frame; only decoded requests commit.
  let displayedIndex = -1;
  let navigationToken = 0;
  let pendingImage = null;
  let retiredPicture = null;
  let retirementTimer = 0;
  let lastTriggerElement = null;
  let inertElements = [];
  // Issue #40 fresh-attempt bookkeeping: bumping `loadAttempt` invalidates
  // prior in-flight work; `loadController` cancels it. See runLoad().
  let loadAttempt = 0;
  let loadController = null;
  let thumbnailLoading = null;

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

  // Issue #40: one AbortController bounds BOTH the request and its body read;
  // the deadline abort covers a response whose JSON body never completes, and
  // `cancelSignal` (the current attempt's controller) lets a retry abandon
  // stale work outright. Required fetches reject; optional fetches resolve to
  // null so a hung/absent sequence degrades to manifest order, never a stall.
  function createMobileAbortError(kind) {
    if (typeof DOMException === 'function') {
      return new DOMException('Gallery request ' + kind, kind === 'timeout' ? 'TimeoutError' : 'AbortError');
    }
    var error = new Error('Gallery request ' + kind);
    error.name = kind === 'timeout' ? 'TimeoutError' : 'AbortError';
    return error;
  }

  async function fetchJsonBounded(path, required, timeoutMs, cancelSignal) {
    var controller = new AbortController();
    var timedOut = false;
    var timer = window.setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    var abortFromOuter = function () { controller.abort(); };
    if (cancelSignal) {
      if (cancelSignal.aborted) {
        window.clearTimeout(timer);
        if (required) throw createMobileAbortError('cancelled');
        return null;
      }
      cancelSignal.addEventListener('abort', abortFromOuter, { once: true });
    }
    var aborted = new Promise(function (resolve, reject) {
      controller.signal.addEventListener('abort', function () {
        reject(createMobileAbortError(timedOut ? 'timeout' : 'cancelled'));
      }, { once: true });
    });
    try {
      var response = await Promise.race([fetch(path, { signal: controller.signal }), aborted]);
      if (!response.ok) {
        if (required) throw new Error('Manifest fetch failed: ' + response.status);
        return null;
      }
      return await Promise.race([response.json(), aborted]);
    } catch (e) {
      if (required) throw e;
      return null;
    } finally {
      window.clearTimeout(timer);
      if (cancelSignal) cancelSignal.removeEventListener('abort', abortFromOuter);
    }
  }

  async function loadData(cancelSignal) {
    var results = await Promise.all([
      fetchJsonBounded(MANIFEST_PATH, true, GALLERY_FETCH_TIMEOUTS.manifest, cancelSignal),
      fetchJsonBounded(SEQUENCE_PATH, false, GALLERY_FETCH_TIMEOUTS.sequence, cancelSignal)
    ]);
    var manifest = results[0];
    if (!manifest || !Array.isArray(manifest.photos)) {
      throw new Error('Invalid gallery manifest schema.');
    }
    var photos = manifest.photos;
    var sequenceItems = results[1] && Array.isArray(results[1].items) ? results[1].items : [];
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
    if (thumbnailLoading) thumbnailLoading.dispose();
    var fragment = document.createDocumentFragment();
    var thumbnails = [];
    var active = 0;
    var paused = false;
    var disposed = false;
    var observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(function (changes) {
        if (disposed || paused) return;
        changes.forEach(function (change) {
          var thumbnail = thumbnails.find(function (item) { return item.image === change.target; });
          if (thumbnail) thumbnail.near = change.isIntersecting;
        });
        pump();
      }, { rootMargin: '80px 0px' })
      : null;

    function pump() {
      if (disposed || paused || requestedIndex >= 0) return;
      var visible = thumbnails.filter(function (item) { return item.near && !item.started; });
      // CSS columns flow down before across; sort by visual position so the
      // top row of both columns wins over pictures farther down the first.
      visible.sort(function (a, b) {
        return a.image.getBoundingClientRect().top - b.image.getBoundingClientRect().top;
      });
      while (active < 2 && visible.length) visible.shift().start();
    }

    thumbnailLoading = {
      pause: function () {
        paused = true;
        if (observer) observer.disconnect();
        thumbnails.forEach(function (item) { item.near = false; });
      },
      resume: function () {
        if (disposed) return;
        paused = false;
        if (observer) {
          thumbnails.forEach(function (item) { if (!item.started) observer.observe(item.image); });
        }
      },
      dispose: function () {
        disposed = true;
        if (observer) observer.disconnect();
        thumbnails.forEach(function (item) { if (item.cancel) item.cancel(); });
      }
    };

    photoEntries.forEach(function (entry, index) {
      var picture = document.createElement('picture');
      picture.style.background = '#f0f0f0';
      var assets = entry.assets;

      if (assets.thumbAvif) {
        var avifSource = document.createElement('source');
        avifSource.dataset.srcset = assets.thumbAvif;
        avifSource.type = 'image/avif';
        picture.appendChild(avifSource);
      }

      if (assets.thumbWebp) {
        var webpSource = document.createElement('source');
        webpSource.dataset.srcset = assets.thumbWebp;
        webpSource.type = 'image/webp';
        picture.appendChild(webpSource);
      }

      var img = document.createElement('img');
      img.alt = entry.displayTitle || 'Photograph';
      img.style.opacity = '0';
      img.setAttribute('data-entry-index', index);
      img.width = assets.thumbWidth;
      img.height = assets.thumbHeight;

      img.decoding = 'async';
      img.setAttribute('fetchpriority', 'low');
      if (index >= 4) img.loading = 'lazy';

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
      var thumbnail = { image: img, near: false, started: false, cancel: null, start: startThumbnail };
      thumbnails.push(thumbnail);

      function startThumbnail() {
        if (thumbnail.started || disposed) return;
        thumbnail.started = true;
        active += 1;
        if (observer) observer.unobserve(img);
        var settled = false;
        var triedJpeg = false;
        var deadline;
        function finish(failed) {
          if (settled) return;
          settled = true;
          window.clearTimeout(deadline);
          img.removeEventListener('load', loaded);
          img.removeEventListener('error', failedImage);
          button.classList.toggle('mobile-photo-unavailable', failed);
          img.style.opacity = failed ? '0' : '1';
          active -= 1;
          pump();
        }
        function loaded() { finish(false); }
        // Keep the same queue slot while trying the JPEG fallback.
        function failedImage() {
          if (!triedJpeg && picture.querySelector('source') && assets.thumbJpg) {
            triedJpeg = true;
            picture.querySelectorAll('source').forEach(function (source) { source.remove(); });
            img.src = assets.thumbJpg;
          } else {
            finish(true);
          }
        }
        thumbnail.cancel = function () {
          finish(true);
          img.removeAttribute('src');
          picture.querySelectorAll('source').forEach(function (source) { source.removeAttribute('srcset'); });
        };
        img.addEventListener('load', loaded);
        img.addEventListener('error', failedImage);
        if (observer) deadline = window.setTimeout(thumbnail.cancel, 15000);
        picture.querySelectorAll('source').forEach(function (source) {
          source.srcset = source.dataset.srcset;
          delete source.dataset.srcset;
        });
        // IO controls proximity; native lazy loading remains the fallback when
        // IO is unavailable. Request sources together to avoid an unused JPEG.
        if (observer) img.loading = 'eager';
        img.src = assets.thumbJpg || '';
      }
      fragment.appendChild(button);
    });

    container.appendChild(fragment);
    if (observer) thumbnailLoading.resume();
    else thumbnails.forEach(function (item) { item.start(); });
  }

  /* ---- Lightbox ---- */

  function getLightboxElements() {
    return {
      overlay: document.getElementById('mobileLightbox'),
      close: document.getElementById('mobileLightboxClose'),
      media: document.getElementById('mobileLightboxMedia'),
      image: document.getElementById('mobileLightboxImage')
    };
  }

  function setViewerStatus(message, failed) {
    var el = getLightboxElements();
    var status = document.getElementById('mobileLightboxStatus');
    var retry = document.getElementById('mobileLightboxRetry');
    status.textContent = message;
    status.hidden = !message;
    if (!failed && document.activeElement === retry) el.close.focus();
    retry.hidden = !failed;
    el.media.setAttribute('aria-busy', message && !failed ? 'true' : 'false');
  }

  function removeRetiredPicture() {
    window.clearTimeout(retirementTimer);
    retirementTimer = 0;
    // A rapid request can interrupt a reveal. Make its committed frame fully
    // opaque before releasing the backing frame beneath it.
    var current = document.getElementById('mobileLightboxImage');
    if (current) current.closest('picture').classList.remove('mobile-lightbox-reveal');
    if (retiredPicture) retiredPicture.remove();
    retiredPicture = null;
  }

  function cancelPendingNavigation() {
    navigationToken += 1;
    if (pendingImage) pendingImage.cancel();
    pendingImage = null;
    removeRetiredPicture();
  }

  function prepareLightboxImage(index) {
    cancelPendingNavigation();
    requestedIndex = index;
    var token = navigationToken;
    var el = getLightboxElements();
    var entry = entries[index];
    var assets = entry.assets;
    var picture = document.createElement('picture');
    picture.className = 'mobile-lightbox-incoming';
    picture.setAttribute('aria-hidden', 'true');
    var image = document.createElement('img');
    image.alt = entry.displayTitle || 'Photograph';
    image.width = entry.width;
    image.height = entry.height;
    image.decoding = 'async';
    image.setAttribute('fetchpriority', 'high');
    // Portrait photos occupy less than the viewport width. Tell the browser
    // their contain-sized width so high-DPR phones need not fetch oversized files.
    var sizes = '(max-aspect-ratio: ' + entry.width + '/' + entry.height + ') 100vw, '
      + Math.round(100 * entry.width / entry.height) + 'vh';
    function candidates(format) {
      return ['medium', 'large'].map(function (size) {
        return assets[size + format] ? assets[size + format] + ' ' + assets[size + 'Width'] + 'w' : '';
      }).filter(Boolean).join(', ');
    }
    ['Avif', 'Webp'].forEach(function (format) {
      var srcset = candidates(format);
      if (!srcset) return;
      var source = document.createElement('source');
      source.type = 'image/' + format.toLowerCase();
      source.sizes = sizes;
      source.srcset = srcset;
      picture.appendChild(source);
    });
    image.sizes = sizes;
    picture.appendChild(image);
    image.srcset = candidates('Jpg');
    var settled = false;
    var decoding = false;
    var deadline;
    function detachHandlers() {
      window.clearTimeout(deadline);
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
    }
    function cancel() {
      settled = true;
      detachHandlers();
      picture.remove();
      // Keep modern sources until fallback URLs are gone; removing them first
      // can start an unused JPEG request in WebKit even after detaching.
      image.removeAttribute('src');
      image.removeAttribute('srcset');
      picture.querySelectorAll('source').forEach(function (source) { source.removeAttribute('srcset'); });
    }
    function failed() {
      if (settled || token !== navigationToken) return;
      cancel();
      pendingImage = null;
      setViewerStatus('Photo could not be loaded. Try again or choose another photo.', true);
    }
    function commit() {
      if (settled || token !== navigationToken || requestedIndex < 0) return;
      if (!image.naturalWidth) { failed(); return; }
      settled = true;
      detachHandlers();
      pendingImage = null;
      var previous = el.image.closest('picture');
      previous.querySelectorAll('[id]').forEach(function (node) { node.removeAttribute('id'); });
      previous.setAttribute('aria-hidden', 'true');
      image.id = 'mobileLightboxImage';
      picture.querySelectorAll('source').forEach(function (source) {
        source.id = source.type === 'image/avif' ? 'mobileLightboxSourceAvif' : 'mobileLightboxSourceWebp';
      });
      picture.className = 'mobile-lightbox-current';
      picture.removeAttribute('aria-hidden');
      image.style.opacity = '1';
      if (displayedIndex >= 0 && !prefersReducedMotion()) {
        picture.classList.add('mobile-lightbox-reveal');
        retiredPicture = previous;
        retirementTimer = window.setTimeout(removeRetiredPicture, 180);
      } else {
        previous.remove();
      }
      displayedIndex = index;
      setViewerStatus('', false);
    }
    function loaded() {
      if (settled || decoding || token !== navigationToken) return;
      if (!image.naturalWidth) { failed(); return; }
      decoding = true;
      if (typeof image.decode === 'function') {
        image.decode().then(commit, failed);
      } else {
        commit();
      }
    }
    pendingImage = { cancel: cancel };
    image.addEventListener('load', loaded);
    image.addEventListener('error', failed);
    deadline = window.setTimeout(failed, 15000);
    setViewerStatus('Loading photo…', false);
    // Set the fallback only after the responsive sources exist; this avoids
    // starting a large JPEG transfer before picture selection can run.
    image.src = assets.mediumJpg || assets.largeJpg || '';
    el.media.appendChild(picture);
    if (image.complete && image.naturalWidth > 0) loaded();
  }

  // Navigation keeps the current pixels/alt text until the requested photo is
  // ready. Opening from the grid resets any frame from a previous dialog session.
  function openLightbox(index, trigger) {
    if (index < 0 || index >= entries.length) return;
    var el = getLightboxElements();
    var wasOpen = !el.overlay.hasAttribute('hidden');
    if (!wasOpen) {
      displayedIndex = -1;
      el.image.closest('picture').hidden = true;
      lastTriggerElement = trigger || null;
      if (thumbnailLoading) thumbnailLoading.pause();
      el.overlay.removeAttribute('hidden');
      document.body.classList.add('mobile-lightbox-open');
      setBackgroundInert(true);
      if (el.close) el.close.focus();
    }
    prepareLightboxImage(index);
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
    requestedIndex = -1;
    displayedIndex = -1;
    touchIdentifier = null;
    setViewerStatus('', false);
    setBackgroundInert(false);
    if (thumbnailLoading) thumbnailLoading.resume();

    // F08: return focus to the control that opened the dialog.
    if (lastTriggerElement && typeof lastTriggerElement.focus === 'function' && lastTriggerElement.isConnected) {
      lastTriggerElement.focus({ preventScroll: true });
    }
    lastTriggerElement = null;
  }

  // Every gesture advances the requested target, including while it loads.
  // Replacing a request cancels its listeners/deadline and releases its layer.
  function navigateLightbox(direction) {
    if (requestedIndex < 0 || !entries.length) return;
    openLightbox((requestedIndex + direction + entries.length) % entries.length);
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

    document.getElementById('mobileLightboxRetry').addEventListener('click', function () {
      if (requestedIndex >= 0) prepareLightboxImage(requestedIndex);
    });

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
      if (e.touches.length !== 1) { touchIdentifier = null; return; }
      touchIdentifier = e.touches[0].identifier === undefined ? 0 : e.touches[0].identifier;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    el.overlay.addEventListener('touchcancel', function () { touchIdentifier = null; }, { passive: true });
    el.overlay.addEventListener('touchend', function (e) {
      if (touchIdentifier === null || !e.changedTouches.length) return;
      var touch = Array.prototype.find.call(e.changedTouches, function (point) {
        return (point.identifier === undefined ? 0 : point.identifier) === touchIdentifier;
      });
      touchIdentifier = null;
      if (!touch) return;
      var endX = touch.clientX;
      var endY = touch.clientY;

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
      if (requestedIndex < 0) return;

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

    // Pending decoding must not survive page suspension.
    window.addEventListener('pagehide', function () {
      if (thumbnailLoading) thumbnailLoading.pause();
      touchIdentifier = null;
      cancelPendingNavigation();
      if (displayedIndex >= 0) {
        requestedIndex = displayedIndex;
        setViewerStatus('', false);
      } else if (requestedIndex >= 0) {
        setViewerStatus('Photo loading was interrupted. Try again.', true);
      }
    });
  }

  window.addEventListener('pageshow', function () {
    if (thumbnailLoading && requestedIndex < 0) thumbnailLoading.resume();
  });

  function trapDialogFocus(event) {
    var overlay = document.getElementById('mobileLightbox');
    if (!overlay || overlay.hasAttribute('hidden')) return;

    var focusables = Array.prototype.filter.call(
      overlay.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
      function (node) { return !node.hasAttribute('hidden'); }
    );
    if (!focusables.length) return;

    // Browser keyboard preferences can skip buttons during native Tab walks.
    // Step every Tab explicitly so Close and a visible Retry remain reachable.
    event.preventDefault();
    var index = focusables.indexOf(document.activeElement);
    var next = index < 0 ? 0 : (index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    focusables[next].focus();
  }

  /* ---- Init ---- */

  function showLoading(show) {
    var loading = document.getElementById('mobileGalleryLoading');
    if (loading) {
      if (show) loading.removeAttribute('hidden');
      else loading.setAttribute('hidden', '');
    }
  }

  function showError(msg, retryable) {
    var error = document.getElementById('mobileGalleryError');
    var loading = document.getElementById('mobileGalleryLoading');
    if (!error) return;
    if (msg) {
      var p = error.querySelector('p');
      if (p) p.textContent = msg;
    }
    // Announce the failure and offer recovery only when retrying can help;
    // the button is created here (not in HTML) so it only exists when needed.
    error.setAttribute('role', 'alert');
    error.removeAttribute('hidden');
    if (loading) loading.setAttribute('hidden', '');
    var retry = error.querySelector('button');
    if (retryable) {
      if (!retry) {
        retry = document.createElement('button');
        retry.type = 'button';
        retry.id = 'mobileGalleryRetryButton';
        retry.className = 'btn btn-secondary mobile-gallery-retry';
        retry.textContent = 'Try again';
        retry.addEventListener('click', function () { runLoad(); });
        error.appendChild(retry);
      }
      if (typeof retry.focus === 'function') retry.focus();
    } else if (retry) {
      retry.remove();
    }
  }

  function hideError() {
    var error = document.getElementById('mobileGalleryError');
    if (error) error.setAttribute('hidden', '');
  }

  // Each load is a fresh attempt: the previous attempt's in-flight requests
  // are aborted, and the attempt token discards any completion that lands
  // after a newer attempt started, so a late response cannot overwrite newer
  // state.
  async function runLoad() {
    var grid = document.getElementById('mobileGalleryGrid');
    if (!grid) return;
    var attempt = ++loadAttempt;
    if (loadController) loadController.abort();
    var controller = new AbortController();
    loadController = controller;
    hideError();
    showLoading(true);

    var nextEntries;
    try {
      var data = await loadData(controller.signal);
      nextEntries = buildEntries(data.photos, data.sequenceItems);
    } catch (e) {
      if (attempt !== loadAttempt) return; // superseded by a newer retry
      loadController = null;
      console.error('Mobile gallery load failed:', e);
      showError(GALLERY_RETRY_COPY, true);
      return;
    }

    if (attempt !== loadAttempt) return; // late completion, newer attempt wins
    loadController = null;
    entries = nextEntries;
    hideError();
    showLoading(false);

    if (!entries.length) {
      showError('No photographs found.', false);
      return;
    }

    grid.textContent = '';
    renderGrid(grid, entries);
  }

  function init() {
    var grid = document.getElementById('mobileGalleryGrid');
    if (!grid) return;

    bindLightboxEvents();
    // Delegated clicks bind once; re-renders on retry reuse the listener.
    bindGridClicks(grid);

    runLoad();
  }

  // Issue #40 test seam: trigger a fresh attempt deterministically without
  // waiting for the error-state button to exist.
  window.__mobileGalleryRetry = runLoad;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
