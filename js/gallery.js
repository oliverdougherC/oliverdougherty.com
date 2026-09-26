/**
 * Gallery JavaScript
 * Builds the editorial gallery experience from generated asset data plus
 * human-authored sequence metadata.
 *
 * Wrapped in an IIFE to avoid polluting the global scope.
 */
(function () {
  'use strict';

  const GALLERY_HASH_PREFIX = '#photo=';
  const MANIFEST_PATH = '../../assets/photos/photos.json';
  const SEQUENCE_PATH = '../../assets/photos/gallery-sequence.json';
  const HERO_QUEUE_LIMIT = 4;

const gallery = {
  entries: [],
  featuredEntries: [],
  heroEntries: [],
  visibleEntries: [],
  currentIndex: -1,
  heroEntryId: '',
  lightboxOpen: false,
  infoPanelOpen: false,
  triggerElement: null,
  lightboxNavigationTimer: 0,
  hashChangeTimer: 0,
  scrollRevealObserver: null,
  inertElements: [],
  inertFallbackState: new Map(),
  lightboxFocusables: [],
  supportsScrollIntoViewInline: null,
  preloadImages: [],
  heroRevealTimers: [],
  heroRevealComplete: false,
  heroRevealScrollHandler: null,
  archiveItems: [],
  archiveLayout: {
    frame: 0,
    signature: '',
    pending: false,
    observer: null,
    resizeHandler: null,
    placardHeight: 34,
    placardRetuned: false
  },
  elements: {}
};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  bindStaticEvents();
  initGalleryHeroReveal();
  initGallery().catch((error) => {
    gallery.heroRevealTimers.forEach((t) => window.clearTimeout(t));
    gallery.heroRevealTimers = [];
    console.error('Gallery initialization error:', error);
    showErrorState('The archive data could not be loaded. Refresh the page or try again later.');
  });
});

function cacheElements() {
  gallery.elements = {
    heroFeature: document.getElementById('galleryHeroFeature'),
    heroPicture: document.getElementById('galleryHeroPicture'),
    heroSourceAvif: document.getElementById('galleryHeroSourceAvif'),
    heroSourceWebp: document.getElementById('galleryHeroSourceWebp'),
    heroImage: document.getElementById('galleryHeroImage'),
    heroOpen: document.getElementById('galleryHeroOpen'),
    loading: document.getElementById('galleryLoading'),
    empty: document.getElementById('galleryEmpty'),
    emptyTitle: document.getElementById('galleryEmptyTitle'),
    emptyCopy: document.getElementById('galleryEmptyCopy'),
    error: document.getElementById('galleryError'),
    errorCopy: document.getElementById('galleryErrorCopy'),
    archiveSection: document.getElementById('galleryArchiveSection'),
    archiveGrid: document.getElementById('galleryArchiveGrid'),
    lightbox: document.getElementById('lightbox'),
    lightboxPanel: document.getElementById('lightboxPanel'),
    lightboxMedia: document.getElementById('lightboxMedia'),
    lightboxClose: document.getElementById('lightboxClose'),
    lightboxPrev: document.getElementById('lightboxPrev'),
    lightboxNext: document.getElementById('lightboxNext'),
    lightboxInfoToggle: document.getElementById('lightboxInfoToggle'),
    lightboxSourceAvif: document.getElementById('lightboxSourceAvif'),
    lightboxSourceWebp: document.getElementById('lightboxSourceWebp'),
    lightboxImage: document.getElementById('lightboxImage'),
    lightboxEyebrow: document.getElementById('lightboxEyebrow'),
    lightboxTitle: document.getElementById('lightboxTitle'),
    lightboxSubline: document.getElementById('lightboxSubline'),
    lightboxNotes: document.getElementById('lightboxNotes'),
    lightboxMeta: document.getElementById('lightboxMeta'),
    lightboxThumbStrip: document.getElementById('lightboxThumbStrip')
  };
  gallery.inertElements = Array.from(document.body.children).filter((element) => {
    if (element.id === 'lightbox') return false;
    return element.querySelector('a[href], button, input, select, textarea, [tabindex]') !== null;
  });
}

function replaceChildrenCompat(container, ...children) {
  if (typeof container.replaceChildren === 'function') {
    container.replaceChildren(...children);
    return;
  }

  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
  container.append(...children);
}

const GALLERY_HERO_REVEAL_MS = 4100;

/**
 * Gallery hero: reveal deferred elements once
 * the calibrate + color-reveal animations complete.
 * Calibrate: 3.8s duration + 0.3s delay = 4.1s
 * Color reveal: 3.4s duration + 0.6s delay = 4.0s
 *
 * If the user scrolls past the hero before that sequence finishes, skip the
 * wait and reveal the archive (and any rendered photo cards) immediately.
 */
function initGalleryHeroReveal() {
  const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) {
    completeGalleryHeroReveal({ finishAnimations: true });
    return;
  }

  if (window.pageAnimations?.shouldSkip?.()) {
    completeGalleryHeroReveal({ finishAnimations: true });
    return;
  }

  window.pageAnimations?.markSeen?.();

  const hero = document.querySelector('.gallery-hero');
  if (!hero) {
    scheduleGalleryHeroRevealTimers();
    return;
  }

  let scrollFrame = 0;
  const onScrollMaybePastHero = () => {
    if (gallery.heroRevealComplete || scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      if (hero.getBoundingClientRect().bottom < 0) {
        completeGalleryHeroReveal({ finishAnimations: true });
      }
    });
  };

  gallery.heroRevealScrollHandler = onScrollMaybePastHero;
  window.addEventListener('scroll', onScrollMaybePastHero, { passive: true });
  scheduleGalleryHeroRevealTimers();
}

function scheduleGalleryHeroRevealTimers() {
  gallery.heroRevealTimers.forEach((timer) => window.clearTimeout(timer));

  const revealTimer = window.setTimeout(() => {
    completeGalleryHeroReveal();
  }, GALLERY_HERO_REVEAL_MS);

  gallery.heroRevealTimers = [revealTimer];
}

function finishGalleryHeroAnimations() {
  const hero = document.querySelector('.gallery-hero');
  if (!hero) return;

  if (typeof Element === 'undefined' || !Element.prototype.getAnimations) {
    hero.classList.add('is-hero-complete');
    return;
  }

  const animations = hero.getAnimations({ subtree: true });
  for (const animation of animations) {
    if (animation.playState === 'finished') continue;
    try {
      animation.finish();
    } catch (error) {
      console.debug('Unable to finish gallery hero animation:', error);
    }
  }
  hero.classList.add('is-hero-complete');
}

function revealAllPhotoCards() {
  const cards = document.querySelectorAll('.photo-card:not(.is-revealed)');
  if (!cards.length) return;
  cards.forEach((card) => card.classList.add('is-revealed'));
  gallery.scrollRevealObserver?.disconnect();
  gallery.scrollRevealObserver = null;
}

function completeGalleryHeroReveal({ finishAnimations = false } = {}) {
  if (gallery.heroRevealComplete) return;
  gallery.heroRevealComplete = true;

  gallery.heroRevealTimers.forEach((timer) => window.clearTimeout(timer));
  gallery.heroRevealTimers = [];

  if (gallery.heroRevealScrollHandler) {
    window.removeEventListener('scroll', gallery.heroRevealScrollHandler, { passive: true });
    gallery.heroRevealScrollHandler = null;
  }

  if (finishAnimations) {
    finishGalleryHeroAnimations();
  }

  window.revealDeferredElements?.();
  revealAllPhotoCards();
}

function bindStaticEvents() {
  gallery.elements.heroOpen?.addEventListener('click', () => {
    if (!gallery.heroEntryId) return;
    openLightboxById(gallery.heroEntryId, gallery.elements.heroOpen);
  });

  gallery.elements.lightboxClose?.addEventListener('click', () => closeLightbox());
  gallery.elements.lightboxPrev?.addEventListener('click', () => navigateLightbox(-1));
  gallery.elements.lightboxNext?.addEventListener('click', () => navigateLightbox(1));
  gallery.elements.lightboxInfoToggle?.addEventListener('click', () => {
    setInfoPanelOpen(!gallery.infoPanelOpen);
  });

  gallery.elements.lightbox?.querySelectorAll('[data-lightbox-dismiss]').forEach((element) => {
    element.addEventListener('click', () => closeLightbox());
  });

  bindRuntimeListeners();
  // Suspension/restore pair: pagehide only detaches what resume re-arms, so a
  // page restored from the BFCache (no DOMContentLoaded) relives the runtime.
  window.addEventListener('pagehide', suspendGalleryRuntime);
  window.addEventListener('pageshow', resumeGalleryRuntime);

  if (gallery.elements.lightboxMedia) {
    let touchStartX = 0;
    let touchEndX = 0;

    gallery.elements.lightboxMedia.addEventListener('touchstart', (event) => {
      touchStartX = event.changedTouches[0].screenX;
    }, { passive: true });

    gallery.elements.lightboxMedia.addEventListener('touchend', (event) => {
      touchEndX = event.changedTouches[0].screenX;
      const diff = touchStartX - touchEndX;
      if (Math.abs(diff) < 50 || !gallery.lightboxOpen) return;
      navigateLightbox(diff > 0 ? 1 : -1);
    }, { passive: true });
  }
}

// Dynamic listeners that a BFCache restore must re-establish. Remove-before-add
// keeps this idempotent across repeated trips. The click/touch bindings above
// live on the persisted DOM itself and are never removed.
function bindRuntimeListeners() {
  document.removeEventListener('keydown', handleGlobalKeydown);
  document.addEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('hashchange', handleHashChange);
  window.addEventListener('hashchange', handleHashChange);
}

async function initGallery() {
  setLoadingState(true);
  const entries = await loadGalleryEntries();

  gallery.entries = entries.sort((a, b) => a.order - b.order);
  gallery.featuredEntries = gallery.entries.filter((entry) => entry.featured);
  gallery.heroEntries = gallery.entries
    .filter((entry) => Number.isFinite(Number(entry.hero?.priority)))
    .sort((a, b) => Number(a.hero.priority) - Number(b.hero.priority))
    .slice(0, HERO_QUEUE_LIMIT);
  gallery.heroEntryId = gallery.heroEntries[0]?.id || gallery.featuredEntries[0]?.id || gallery.entries[0]?.id || '';

  if (!gallery.entries.length) {
    setLoadingState(false);
    showEmptyState(
      'No photographs found',
      'Add photographs to the archive manifest to populate the gallery.'
    );
    return;
  }

  syncHeroFeature();
  buildLightboxThumbStrip();
  renderGallery();
  initScrollReveal();
  setLoadingState(false);
  syncGalleryFromUrl();

}

async function loadGalleryEntries() {
  const [manifestResult, sequenceResult] = await Promise.all([
    fetchJson(MANIFEST_PATH, true),
    fetchJson(SEQUENCE_PATH, false)
  ]);

  if (!Array.isArray(manifestResult?.photos)) {
    throw new Error('Invalid gallery manifest schema');
  }

  const manifestPhotos = manifestResult.photos;
  const sequenceItems = Array.isArray(sequenceResult?.items) ? sequenceResult.items : [];
  const sequenceLookup = buildSequenceLookup(sequenceItems);

  return manifestPhotos.map((photo, manifestIndex) =>
    mergeGalleryEntry({
      photo,
      manifestIndex,
      sequenceItems,
      sequenceLookup
    })
  );
}

async function fetchJson(path, throwOnFailure) {
  try {
    const response = await fetch(path);
    if (!response.ok) {
      if (throwOnFailure) {
        throw new Error(`Failed to load ${path}`);
      }
      return null;
    }
    return await response.json();
  } catch (error) {
    if (throwOnFailure) throw error;
    return null;
  }
}

function buildSequenceLookup(sequenceItems) {
  const lookup = new Map();

  sequenceItems.forEach((item, index) => {
    item.__sequenceIndex = index;
    [
      item.id,
      item.title,
      basenameFromPath(item.src?.large),
      basenameFromPath(item.src?.medium),
      basenameFromPath(item.src?.thumb)
    ].forEach((value) => registerSequenceKey(lookup, value, item));
  });

  return lookup;
}

function registerSequenceKey(map, value, item) {
  if (!value) return;
  map.set(normalizeGalleryKey(value), item);
}

function mergeGalleryEntry({ photo, manifestIndex, sequenceItems, sequenceLookup }) {
  const matchedSequence = sequenceLookup.get(normalizeGalleryKey(photo.id))
    || sequenceLookup.get(normalizeGalleryKey(photo.filename))
    || sequenceLookup.get(normalizeGalleryKey(photo.displayTitle))
    || sequenceLookup.get(normalizeGalleryKey(photo.title))
    || null;

  const sequenceIndex = Number.isInteger(matchedSequence?.__sequenceIndex)
    ? matchedSequence.__sequenceIndex
    : null;

  const id = matchedSequence?.id
    || photo.id
    || normalizeGalleryKey(photo.filename || photo.displayTitle || photo.title || `photo-${manifestIndex + 1}`);
  const displayTitle = matchedSequence?.title
    || photo.displayTitle
    || photo.title
    || formatTitle(photo.filename || `Photo ${manifestIndex + 1}`);
  const date = photo.exif?.date || matchedSequence?.meta?.date || '';
  const year = matchedSequence?.index?.year || extractYear(date) || '';
  const location = matchedSequence?.meta?.location || photo.location || '';
  const description = photo.description || buildFallbackDescription(photo);
  const notes = matchedSequence?.meta?.notes || '';
  const featured = Boolean(matchedSequence?.featured);
  const order = sequenceIndex !== null ? sequenceIndex : sequenceItems.length + manifestIndex;
  const hero = matchedSequence?.hero
    ? {
      priority: Number(matchedSequence.hero.priority) || 0,
      theme: String(matchedSequence.hero.theme || '').trim(),
      teaser: String(matchedSequence.hero.teaser || '').trim()
    }
    : null;

  const entry = {
    id,
    displayTitle,
    description,
    location,
    notes,
    featured,
    hero,
    order,
    year,
    date,
    dateLabel: formatDate(date),
    dateShortLabel: formatShortDate(date),
    source: sequenceIndex !== null ? 'curated' : 'manifest',
    width: Number(photo.width) || Number(photo.large?.width) || Number(photo.medium?.width) || 1600,
    height: Number(photo.height) || Number(photo.large?.height) || Number(photo.medium?.height) || 1067,
    exif: photo.exif || {},
    assets: buildAssetMap(photo)
  };

  return entry;
}

function buildAssetMap(photo) {
  return {
    original: photo.filename ? `../../assets/photos/${photo.filename}` : '',
    thumbJpg: resolveVariantPath(photo.thumbs, 'jpg', '../../assets/photos/thumbs/', photo.filename),
    thumbWebp: resolveVariantPath(photo.thumbs, 'webp', '../../assets/photos/thumbs/'),
    thumbAvif: resolveVariantPath(photo.thumbs, 'avif', '../../assets/photos/thumbs/'),
    mediumJpg: resolveVariantPath(photo.medium, 'jpg', '../../assets/photos/medium/', photo.filename),
    mediumWebp: resolveVariantPath(photo.medium, 'webp', '../../assets/photos/medium/'),
    mediumAvif: resolveVariantPath(photo.medium, 'avif', '../../assets/photos/medium/'),
    largeJpg: resolveVariantPath(photo.large, 'jpg', '../../assets/photos/large/', photo.filename),
    largeWebp: resolveVariantPath(photo.large, 'webp', '../../assets/photos/large/'),
    largeAvif: resolveVariantPath(photo.large, 'avif', '../../assets/photos/large/'),
    thumbWidth: Number(photo.thumbs?.width) || 800,
    thumbHeight: Number(photo.thumbs?.height) || 534,
    mediumWidth: Number(photo.medium?.width) || 1600,
    mediumHeight: Number(photo.medium?.height) || 1067,
    largeWidth: Number(photo.large?.width) || 2400,
    largeHeight: Number(photo.large?.height) || 1601
  };
}

function buildFallbackDescription(photo) {
  if (photo.location) {
    return `A frame from ${String(photo.location).toLowerCase()} preserved in the archive.`;
  }

  return 'A frame preserved in the archive with generated metadata only.';
}

function syncHeroFeature() {
  const entry = getEntryById(gallery.heroEntryId) || gallery.heroEntries[0] || gallery.featuredEntries[0] || gallery.entries[0];
  if (!entry) return;

  gallery.heroEntryId = entry.id;

  setPictureSource(
    gallery.elements.heroSourceAvif,
    buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumAvif, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeAvif, entry.assets.largeWidth)
    ]),
    '(max-width: 900px) 100vw, 40vw'
  );
  setPictureSource(
    gallery.elements.heroSourceWebp,
    buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumWebp, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeWebp, entry.assets.largeWidth)
    ]),
    '(max-width: 900px) 100vw, 40vw'
  );

  if (gallery.elements.heroImage) {
    const heroImage = gallery.elements.heroImage;
    const heroOpen = gallery.elements.heroOpen;
    const heroSrc = entry.assets.largeJpg || entry.assets.mediumJpg || entry.assets.original;

    heroImage.classList.remove('is-loaded');
    heroOpen?.classList.remove('is-loaded');
    heroImage.alt = '';
    heroImage.dataset.entryId = entry.id;

    const markHeroLoaded = () => {
      if (heroImage.dataset.entryId !== entry.id) return;
      heroImage.alt = entry.displayTitle;
      heroImage.classList.add('is-loaded');
      heroOpen?.classList.add('is-loaded');
    };

    heroImage.addEventListener('load', markHeroLoaded, { once: true });
    heroImage.addEventListener('error', markHeroLoaded, { once: true });
    heroImage.srcset = buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumJpg, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeJpg, entry.assets.largeWidth)
    ]);
    gallery.elements.heroImage.sizes = '(max-width: 900px) 100vw, 40vw';
    heroImage.src = heroSrc;

    if (heroImage.complete && heroImage.naturalWidth > 0) {
      markHeroLoaded();
    }
  }

  if (gallery.elements.heroOpen) {
    gallery.elements.heroOpen.dataset.entryId = entry.id;
  }
}

function renderGallery() {
  const visibleEntries = gallery.entries.filter((entry) => entry.id !== gallery.heroEntryId);

  gallery.visibleEntries = visibleEntries;

  if (!visibleEntries.length) {
    if (gallery.elements.archiveSection) gallery.elements.archiveSection.hidden = true;
    showEmptyState(
      'No photographs found',
      'The archive does not contain any published photographs yet.'
    );
    return;
  }

  hideStatusStates();

  if (gallery.elements.archiveSection) gallery.elements.archiveSection.hidden = false;

  buildArchiveCards(visibleEntries);
  applyArchiveLayout();
  gallery.archiveLayout.signature = computeArchiveLayoutSignature(gallery.elements.archiveGrid);
  initArchiveLayout();
}

function initScrollReveal() {
  const cards = document.querySelectorAll('.photo-card');
  if (!cards.length) return;

  gallery.scrollRevealObserver?.disconnect();
  gallery.scrollRevealObserver = null;

  if (gallery.heroRevealComplete || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    cards.forEach((card) => card.classList.add('is-revealed'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      }
    });
  }, {
    rootMargin: '0px 0px -8% 0px',
    threshold: 0.15
  });

  cards.forEach((card) => observer.observe(card));
  gallery.scrollRevealObserver = observer;
}

function buildArchiveCards(entries) {
  const prominentSet = buildProminentSet(entries);

  gallery.archiveItems = entries.map((entry, index) => ({
    entry,
    index,
    card: null,
    aspect: sanitiseAspect(entry),
    prominent: prominentSet.has(index)
  }));

  gallery.archiveItems.forEach((item) => {
    item.card = createPhotoCard(item);
  });
}

function sanitiseAspect(entry) {
  const width = Number(entry.width);
  const height = Number(entry.height);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio > 0.1 && ratio < 12) return ratio;
  }
  return 1.5;
}

function buildProminentSet(entries) {
  const set = new Set();
  let gap = 4;

  entries.forEach((entry, index) => {
    if (entry.featured && gap >= 4) {
      set.add(index);
      gap = 0;
    } else {
      gap++;
      if (gap >= 9) {
        set.add(index);
        gap = 0;
      }
    }
  });

  return set;
}

function createPhotoCard(item) {
  const { entry, index } = item;
  const isProminent = item.prominent;
  const context = 'archive';
  const article = document.createElement('article');
  article.className = 'photo-card is-loading';
  article.dataset.entryId = entry.id;
  article.dataset.context = context;

  if (isProminent) {
    article.classList.add('photo-card--prominent');
  }

  article.style.setProperty('--reveal-delay', `${isProminent ? 0 : (index % 2) * 80}ms`);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'photo-card-button';
  button.setAttribute('aria-label', `Inspect ${entry.displayTitle}`);
  button.setAttribute('data-cursor', 'hover');

  const media = document.createElement('div');
  media.className = 'photo-media';
  // Pre-layout intrinsic box: the justified engine replaces this with an
  // explicit pixel height once row packing runs. Aspect stays natural —
  // photos are never cropped to fit a grid cell anymore.
  media.style.aspectRatio = `${item.aspect.toFixed(4)} / 1`;

  const picture = document.createElement('picture');
  const imageSizes = getCardImageSizes(context, index, isProminent);
  const smallSrc = 'thumb';
  const largeSrc = 'medium';

  const sourceAvif = document.createElement('source');
  sourceAvif.type = 'image/avif';
  if (entry.assets[`${smallSrc}Avif`]) {
    sourceAvif.srcset = buildSrcset([
      makeResponsiveCandidate(entry.assets[`${smallSrc}Avif`], entry.assets[`${smallSrc}Width`]),
      makeResponsiveCandidate(entry.assets[`${largeSrc}Avif`], entry.assets[`${largeSrc}Width`])
    ]);
    sourceAvif.sizes = imageSizes;
  }

  const sourceWebp = document.createElement('source');
  sourceWebp.type = 'image/webp';
  if (entry.assets[`${smallSrc}Webp`]) {
    sourceWebp.srcset = buildSrcset([
      makeResponsiveCandidate(entry.assets[`${smallSrc}Webp`], entry.assets[`${smallSrc}Width`]),
      makeResponsiveCandidate(entry.assets[`${largeSrc}Webp`], entry.assets[`${largeSrc}Width`])
    ]);
    sourceWebp.sizes = imageSizes;
  }

  const image = document.createElement('img');
  image.className = 'photo-image';
  image.src = entry.assets[`${largeSrc}Jpg`] || entry.assets.mediumJpg || entry.assets.original;
  image.alt = entry.displayTitle;
  image.loading = index < 4 ? 'eager' : 'lazy';
  image.decoding = index < 4 ? 'sync' : 'async';
  image.fetchPriority = index < 4 ? 'high' : 'auto';
  image.width = entry.assets[`${largeSrc}Width`] || entry.width;
  image.height = entry.assets[`${largeSrc}Height`] || entry.height;
  image.srcset = buildSrcset([
    makeResponsiveCandidate(entry.assets[`${smallSrc}Jpg`], entry.assets[`${smallSrc}Width`]),
    makeResponsiveCandidate(entry.assets[`${largeSrc}Jpg`], entry.assets[`${largeSrc}Width`])
  ]);
  image.sizes = imageSizes;
  image.addEventListener('load', () => {
    article.classList.remove('is-loading');
    article.classList.add('is-loaded');
    reconcileCardAspect(item, image);
  }, { once: true });
  image.addEventListener('error', () => {
    console.warn('Gallery image failed to load:', image.currentSrc || image.src);
    article.classList.remove('is-loading');
    article.classList.add('photo-card--broken');
  }, { once: true });

  picture.append(sourceAvif, sourceWebp, image);
  media.appendChild(picture);

  const caption = document.createElement('div');
  caption.className = 'photo-placard';

  const number = document.createElement('span');
  number.className = 'photo-placard-number';
  number.textContent = String(index + 1).padStart(2, '0');

  const title = document.createElement('span');
  title.className = 'photo-placard-title';
  title.textContent = entry.displayTitle;

  caption.append(number, title);

  button.append(media);
  article.append(button, caption);

  button.addEventListener('click', () => {
    gallery.triggerElement = button;
    openLightboxById(entry.id, button);
  });

  return article;
}

/* ------------------------------------------------------------------
 * Carrara mosaic layout
 *
 * The archive is solved as one absolutely-positioned mosaic — no row
 * containers, no bands that read as shelves. Three tile classes mix:
 *
 *   A3 / A2  justified single-photo courses (exact aspect, zero crop),
 *            three-up standard size or two-up large.
 *   B        a spanning course-pair: one big tile (two columns wide)
 *            straddling two side courses, breaking the horizontal
 *            seam; the paired singles beside it stay uncropped. The
 *            spanner takes the only crop in the system (~4-8% max,
 *            centered), which is what lets tiles hug on all sides.
 *            The spanner side alternates, so vertical seams wander.
 *
 * Everything is solved top-to-bottom into pixel boxes; the solver
 * picks course types per beat against a height rhythm so sizes vary
 * without a repeating pattern. Photos keep story order.
 * ---------------------------------------------------------------- */

const ARCHIVE_LAYOUT = {
  maxSpanCrop: 0.085,
  gapFactor: 0.021,
  minGap: 14,
  maxGap: 26,
  // Course-type economics. The solver minimizes total cost, so these
  // numbers set how often each class shows up; the repeat penalty is
  // what forces variation instead of long runs of one class.
  costA3: 0.32,
  costA2: 0.26,
  costB: 0.24,
  costLone: 0.6,
  cropCost: 12,
  spannerSwapPenalty: 0.03,
  repeatPenalty: 0.2
};

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function computeArchiveMetrics(containerWidth) {
  const gapX = clampNumber(
    containerWidth * ARCHIVE_LAYOUT.gapFactor,
    ARCHIVE_LAYOUT.minGap,
    ARCHIVE_LAYOUT.maxGap
  );
  const columns = containerWidth >= 900 ? 3 : (containerWidth >= 560 ? 2 : 1);
  // Full-bleed edge treatment: justified courses span the entire container
  // width (see measureJustifiedCourse), so columns only subtract the interior
  // gutters. The former extra `- gapX` removed one gutter too many, leaving a
  // spare right gutter unmirrored and doubling the interior gap when mirrored.
  const columnWidth = (containerWidth - gapX * (columns - 1)) / columns;

  return {
    width: containerWidth,
    gapX,
    gapY: Math.round(gapX * 1.5),
    columns,
    columnWidth,
    minMediaHeight: clampNumber(containerWidth * 0.2, 175, 215),
    placardHeight: gallery.archiveLayout.placardHeight,
    spanEligible: columns >= 3 && containerWidth >= 900
  };
}

// Geometry for a justified single-photo course: photos keep exact
// aspect, media height solved so the row is exactly full width.
function measureJustifiedCourse(items, metrics) {
  let sumAspect = 0;
  items.forEach((item) => { sumAspect += item.aspect; });
  const mediaHeight = (metrics.width - metrics.gapX * (items.length - 1)) / sumAspect;
  if (mediaHeight < metrics.minMediaHeight) return null;
  return {
    kind: 'justified',
    items,
    mediaHeight,
    boxHeight: mediaHeight + metrics.placardHeight
  };
}

// Geometry for a spanning course-pair: [ spanner | single ] twice,
// where one big tile straddles both courses in the left column (the
// side flips every occurrence). The seam under the single exists but
// stops dead at the spanner's bottom edge, so courses never read as
// shelves. The single keeps its exact aspect at full size; the
// spanner absorbs the mismatch, cropped at most maxSpanCrop, centered.
function measureSpanCourse(topItem, bottomItem, spanItem, metrics) {
  const singleWidth = metrics.columnWidth;
  const topMedia = singleWidth / topItem.aspect;
  const bottomMedia = singleWidth / bottomItem.aspect;
  if (topMedia < metrics.minMediaHeight || bottomMedia < metrics.minMediaHeight) {
    return null;
  }

  const topBox = topMedia + metrics.placardHeight;
  const bottomBox = bottomMedia + metrics.placardHeight;
  const boxHeight = topBox + metrics.gapY + bottomBox;
  const spannerWidth = metrics.columnWidth * 2 + metrics.gapX;
  const spannerMedia = boxHeight - metrics.placardHeight;

  const boxAspect = spannerWidth / spannerMedia;
  const crop =
    1 - Math.min(boxAspect / spanItem.aspect, spanItem.aspect / boxAspect);
  if (crop > ARCHIVE_LAYOUT.maxSpanCrop) return null;

  return {
    kind: 'span',
    topItem,
    bottomItem,
    spanItem,
    singleWidth,
    topMedia,
    bottomMedia,
    spannerWidth,
    spannerMedia,
    boxHeight,
    crop
  };
}

// Course-type ids for the DP state (the "previous course type" axis
// powers the anti-repeat penalty).
const COURSE_A3 = 0;
const COURSE_A2 = 1;
const COURSE_B = 2;
const COURSE_LONE = 3;

// Dynamic program over (itemIndex, lastCourseType): every partition of
// the archive into justified/spanning/lone courses is a path, the
// cheapest wins. Course geometry is closed-form, so this is exact and
// runs in microseconds for a 28-photo archive.
function solveArchiveCourses(items, metrics) {
  const count = items.length;
  const typeCount = 4;
  const best = [];
  const back = [];
  for (let i = 0; i <= count; i += 1) {
    best.push(new Array(typeCount).fill(Infinity));
    back.push(new Array(typeCount).fill(null));
  }
  best[0][COURSE_LONE] = 0; // neutral "no previous course" state

  for (let i = 0; i < count; i += 1) {
    for (let prevType = 0; prevType < typeCount; prevType += 1) {
      if (!Number.isFinite(best[i][prevType])) continue;

      const relax = (end, type, course, costBase) => {
        const cost = costBase + (type === prevType ? ARCHIVE_LAYOUT.repeatPenalty : 0);
        const total = best[i][prevType] + cost;
        if (total < best[end][type]) {
          best[end][type] = total;
          back[end][type] = { from: i, prevType, course };
        }
      };

      if (i + 3 <= count) {
        const course = measureJustifiedCourse(items.slice(i, i + 3), metrics);
        if (course) relax(i + 3, COURSE_A3, course, ARCHIVE_LAYOUT.costA3);
      }
      if (i + 2 <= count) {
        const course = measureJustifiedCourse(items.slice(i, i + 2), metrics);
        if (course) relax(i + 2, COURSE_A2, course, ARCHIVE_LAYOUT.costA2);
      }

      // Span course: one big tile straddling two side courses. The
      // spanner may be any of the three photos (swap = tiny penalty),
      // the other two stay exact, stacked beside it in story order.
      if (metrics.spanEligible && i + 3 <= count) {
        for (let s = 0; s < 3; s += 1) {
          const triple = items.slice(i, i + 3);
          const spanItem = triple[s];
          const singles = triple.filter((_, k) => k !== s);
          const course = measureSpanCourse(singles[0], singles[1], spanItem, metrics, false);
          if (!course) continue;
          relax(
            i + 3,
            COURSE_B,
            course,
            ARCHIVE_LAYOUT.costB +
              course.crop * course.crop * ARCHIVE_LAYOUT.cropCost +
              s * ARCHIVE_LAYOUT.spannerSwapPenalty
          );
        }
      }

      // Lone course: a single photo, never stretched. On phones it is
      // the only legal shape; on wider screens it closes the archive
      // with one centered tile — the mosaic's ragged tail, like the
      // stone slab's own silhouette.
      if (i + 1 <= count && (metrics.columns === 1 || i + 1 === count)) {
        const width = metrics.columns === 1
          ? metrics.width
          : Math.min(metrics.columnWidth, metrics.width);
        const mediaHeight = width / items[i].aspect;
        relax(i + 1, COURSE_LONE, {
          kind: 'lone',
          item: items[i],
          width,
          mediaHeight,
          centered: metrics.columns !== 1
        }, metrics.columns === 1 ? 0 : ARCHIVE_LAYOUT.costLone);
      }
    }
  }

  let bestType = 0;
  for (let t = 1; t < typeCount; t += 1) {
    if (best[count][t] < best[count][bestType]) bestType = t;
  }
  if (!Number.isFinite(best[count][bestType])) return null;

  const courses = [];
  let position = count;
  let type = bestType;
  while (position > 0) {
    const link = back[position][type];
    if (!link) return null;
    courses.unshift(link.course);
    position = link.from;
    type = link.prevType;
  }
  return courses;
}

// Guaranteed-feasible fallback for inputs the DP cannot partition (for
// example two panoramas whose only shared course would fall under the
// readability floor while a lone course is illegal at index 0). Rows keep
// the mosaic's justified, aspect-preserving grammar: shrink the row until
// it clears the floor, then accept a short full-width single. Extreme
// portraits cap at one container width of height and center instead of
// producing a ten-thousand-pixel media box.
function buildFallbackCourses(items, metrics) {
  const courses = [];
  const maxRow = Math.max(1, metrics.columns);
  const maxHeight = Math.max(metrics.minMediaHeight, metrics.width);

  for (let start = 0; start < items.length;) {
    let row = items.slice(start, start + maxRow);
    let mediaHeight = 0;
    for (;;) {
      let sumAspect = 0;
      row.forEach((item) => { sumAspect += item.aspect; });
      mediaHeight = (metrics.width - metrics.gapX * (row.length - 1)) / sumAspect;
      if (row.length <= 1 || mediaHeight >= metrics.minMediaHeight) break;
      row = row.slice(0, row.length - 1);
    }

    let x0 = 0;
    if (mediaHeight > maxHeight) {
      mediaHeight = maxHeight;
      let rowWidth = metrics.gapX * (row.length - 1);
      row.forEach((item) => { rowWidth += item.aspect * mediaHeight; });
      x0 = Math.max(0, (metrics.width - rowWidth) / 2);
    }

    courses.push({
      kind: 'justified',
      items: row,
      mediaHeight,
      boxHeight: mediaHeight + metrics.placardHeight,
      x0
    });
    start += row.length;
  }

  return courses;
}

// Resolve courses into absolute pixel boxes. The spanner side flips on
// every other span course so vertical seams wander instead of stacking.
function buildMosaicBoxes(courses, metrics) {
  const boxes = [];
  const g = metrics.gapX;
  let y = 0;
  let spanMirrored = false;

  courses.forEach((course) => {
    if (course.kind === 'justified') {
      let x = course.x0 || 0;
      course.items.forEach((item) => {
        const width = Math.round(item.aspect * course.mediaHeight);
        boxes.push({
          item,
          x: Math.round(x),
          y: Math.round(y),
          width,
          mediaHeight: Math.round(course.mediaHeight)
        });
        x += width + g;
      });
      y += course.boxHeight + metrics.gapY;
      return;
    }

    if (course.kind === 'lone') {
      const width = Math.round(course.width);
      const mediaHeight = Math.round(course.mediaHeight);
      boxes.push({
        item: course.item,
        x: course.centered ? Math.round((metrics.width - width) / 2) : 0,
        y: Math.round(y),
        width,
        mediaHeight
      });
      y += mediaHeight + metrics.placardHeight + metrics.gapY;
      return;
    }

    const mirrored = spanMirrored;
    spanMirrored = !spanMirrored;
    const spanWidth = Math.round(course.spannerWidth);
    const singleWidth = Math.round(course.singleWidth);
    const spanX = mirrored ? Math.round(metrics.width) - spanWidth : 0;
    const singleX = mirrored ? 0 : spanWidth + Math.round(g);

    boxes.push({
      item: course.spanItem,
      x: spanX,
      y: Math.round(y),
      width: spanWidth,
      mediaHeight: Math.round(course.spannerMedia),
      spanner: true
    });
    boxes.push({
      item: course.topItem,
      x: singleX,
      y: Math.round(y),
      width: singleWidth,
      mediaHeight: Math.round(course.topMedia)
    });
    boxes.push({
      item: course.bottomItem,
      x: singleX,
      y: Math.round(y + course.topMedia + metrics.placardHeight + metrics.gapY),
      width: singleWidth,
      mediaHeight: Math.round(course.bottomMedia)
    });
    y += course.boxHeight + metrics.gapY;
  });

  return { boxes, height: Math.max(0, y - metrics.gapY) };
}

function applyArchiveLayout() {
  const grid = gallery.elements.archiveGrid;
  if (!grid || !gallery.archiveItems.length) return;

  const width = grid.clientWidth;
  if (width < 120) return;

  const metrics = computeArchiveMetrics(width);
  // The DP can legitimately have no legal partition (e.g. two panoramas whose
  // only shared row drops under the readability floor). Fall back to a
  // guaranteed-feasible stack instead of leaving an empty/stale archive.
  const courses = solveArchiveCourses(gallery.archiveItems, metrics)
    || buildFallbackCourses(gallery.archiveItems, metrics);

  const mosaic = buildMosaicBoxes(courses, metrics);
  grid.style.height = `${Math.round(mosaic.height)}px`;

  // F05: Moving cards through a detached fragment blurs any focused descendant.
  // Remember a focus that was inside the grid and give it back after reinsert,
  // without scrolling. A focus outside the grid (modal, nav) is never touched.
  const focusedBefore = document.activeElement;
  const preserveFocus = focusedBefore && grid.contains(focusedBefore) ? focusedBefore : null;

  const fragment = document.createDocumentFragment();

  // Reveal in reading order: top-to-bottom, left-to-right.
  mosaic.boxes
    .slice()
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .forEach((box, index) => {
      prepareArchiveCard(box, `${Math.min(210, index * 45)}ms`);
      fragment.appendChild(box.item.card);
    });

  replaceChildrenCompat(grid, fragment);

  if (preserveFocus && preserveFocus.isConnected) {
    preserveFocus.focus({ preventScroll: true });
  }

  if (!gallery.archiveLayout.placardRetuned) {
    const placard = grid.querySelector('.photo-placard');
    const measured = placard ? Math.round(placard.getBoundingClientRect().height) : 0;
    if (measured > 0) {
      gallery.archiveLayout.placardRetuned = true;
      if (Math.abs(measured - gallery.archiveLayout.placardHeight) > 1) {
        gallery.archiveLayout.placardHeight = measured;
        scheduleArchiveLayout({ force: true });
      }
    }
  }
}

function prepareArchiveCard(box, revealDelay) {
  const card = box.item.card;
  if (!card) return;

  card.style.left = `${box.x}px`;
  card.style.top = `${box.y}px`;
  card.style.width = `${box.width}px`;
  card.classList.toggle('photo-card--placard-compact', box.width < 132);
  card.classList.toggle('photo-card--spanner', !!box.spanner);
  card.style.setProperty('--reveal-delay', revealDelay);

  const media = card.querySelector('.photo-media');
  if (media) media.style.height = `${box.mediaHeight}px`;

  setCardImageWidthHint(card, box.width);
}

function setCardImageWidthHint(card, widthPx) {
  const sizes = `${Math.ceil(widthPx)}px`;
  const picture = card.querySelector('picture');
  const image = card.querySelector('img');
  if (picture) {
    picture.querySelectorAll('source').forEach((source) => {
      if (source.hasAttribute('sizes')) source.sizes = sizes;
    });
  }
  if (image && image.hasAttribute('sizes')) image.sizes = sizes;
}

function reconcileCardAspect(item, image) {
  const natural = image.naturalWidth && image.naturalHeight
    ? image.naturalWidth / image.naturalHeight
    : 0;
  if (!natural || natural <= 0.1 || natural >= 12) return;
  if (Math.abs(natural - item.aspect) / item.aspect <= 0.01) return;
  item.aspect = natural;
  const media = item.card ? item.card.querySelector('.photo-media') : null;
  if (media) media.style.aspectRatio = `${natural.toFixed(4)} / 1`;
  scheduleArchiveLayout({ force: true });
}

function computeArchiveLayoutSignature(grid) {
  return String(Math.round(grid ? grid.clientWidth : 0));
}

function scheduleArchiveLayout({ force = false } = {}) {
  if (gallery.lightboxOpen && !force) {
    gallery.archiveLayout.pending = true;
    return;
  }

  if (gallery.archiveLayout.frame) {
    if (!force) return;
    window.cancelAnimationFrame(gallery.archiveLayout.frame);
    gallery.archiveLayout.frame = 0;
  }

  gallery.archiveLayout.frame = window.requestAnimationFrame(() => {
    gallery.archiveLayout.frame = 0;

    const grid = gallery.elements.archiveGrid;
    if (!grid) return;

    const signature = computeArchiveLayoutSignature(grid);
    if (signature !== gallery.archiveLayout.signature) {
      gallery.archiveLayout.signature = signature;
    } else if (!force) {
      return;
    }

    applyArchiveLayout();
  });
}

function initArchiveLayout() {
  if (typeof ResizeObserver !== 'undefined' && !gallery.archiveLayout.observer) {
    gallery.archiveLayout.observer = new ResizeObserver(() => scheduleArchiveLayout());
    gallery.archiveLayout.observer.observe(gallery.elements.archiveGrid);
  }
  if (!gallery.archiveLayout.resizeHandler) {
    gallery.archiveLayout.resizeHandler = () => scheduleArchiveLayout();
    window.addEventListener('resize', gallery.archiveLayout.resizeHandler, { passive: true });
  }
}

function setLoadingState(active) {
  if (gallery.elements.loading) {
    gallery.elements.loading.hidden = !active;
  }
  if (active) {
    gallery.elements.empty.hidden = true;
    gallery.elements.error.hidden = true;
  }
}

function hideStatusStates() {
  gallery.elements.empty.hidden = true;
  gallery.elements.error.hidden = true;
}

function showEmptyState(title, copy) {
  gallery.elements.loading.hidden = true;
  gallery.elements.error.hidden = true;
  gallery.elements.empty.hidden = false;
  gallery.elements.emptyTitle.textContent = title;
  gallery.elements.emptyCopy.textContent = copy;
}

function showErrorState(copy) {
  gallery.elements.loading.hidden = true;
  gallery.elements.empty.hidden = true;
  if (gallery.elements.archiveSection) gallery.elements.archiveSection.hidden = true;
  gallery.elements.error.hidden = false;
  gallery.elements.errorCopy.textContent = copy;
}

function buildLightboxThumbStrip() {
  const fragment = document.createDocumentFragment();

  gallery.entries.forEach((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lightbox-thumb';
    button.dataset.entryId = entry.id;
    button.setAttribute('aria-label', `Open ${entry.displayTitle}`);
    button.setAttribute('data-cursor', 'hover');

    const image = document.createElement('img');
    image.src = entry.assets.thumbJpg || entry.assets.mediumJpg || entry.assets.original;
    image.alt = entry.displayTitle;
    image.loading = 'lazy';
    image.decoding = 'async';

    const label = document.createElement('span');
    label.className = 'lightbox-thumb-label';
    label.textContent = entry.displayTitle;

    button.append(image, label);
    button.addEventListener('click', () => {
      gallery.triggerElement = button;
      openLightboxById(entry.id, button);
    });

    fragment.appendChild(button);
  });

  replaceChildrenCompat(gallery.elements.lightboxThumbStrip, fragment);
}

function openLightboxById(entryId, triggerElement) {
  if (triggerElement) {
    gallery.triggerElement = triggerElement;
  }
  writePhotoHash(entryId);
  syncGalleryFromUrl();
}

function openLightboxUi(entryId, triggerElement) {
  const index = gallery.entries.findIndex((entry) => entry.id === entryId);
  if (index === -1 || !gallery.elements.lightbox) return;

  gallery.currentIndex = index;
  gallery.lightboxOpen = true;
  if (triggerElement) {
    gallery.triggerElement = triggerElement;
  }
  gallery.elements.lightbox.hidden = false;
  gallery.elements.lightbox.classList.add('is-active');
  document.body.classList.add('gallery-lightbox-open');
  setPageInert(true);
  setInfoPanelOpen(!window.matchMedia('(max-width: 900px)').matches);
  renderLightboxEntry(gallery.entries[index]);
  refreshLightboxFocusables();
  gallery.elements.lightboxClose?.focus();
}

function renderLightboxEntry(entry) {
  const elements = gallery.elements;
  if (
    !elements.lightboxImage ||
    !elements.lightboxEyebrow ||
    !elements.lightboxTitle ||
    !elements.lightboxSubline ||
    !elements.lightboxNotes ||
    !elements.lightboxMeta ||
    !elements.lightboxThumbStrip
  ) {
    return;
  }

  setPictureSource(
    elements.lightboxSourceAvif,
    buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumAvif, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeAvif, entry.assets.largeWidth)
    ]),
    '(max-width: 900px) 100vw, calc(100vw - 400px)'
  );
  setPictureSource(
    elements.lightboxSourceWebp,
    buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumWebp, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeWebp, entry.assets.largeWidth)
    ]),
    '(max-width: 900px) 100vw, calc(100vw - 400px)'
  );

  elements.lightboxImage.src = entry.assets.largeJpg || entry.assets.mediumJpg || entry.assets.original;
  elements.lightboxImage.alt = entry.displayTitle;
  elements.lightboxImage.srcset = buildSrcset([
    makeResponsiveCandidate(entry.assets.mediumJpg, entry.assets.mediumWidth),
    makeResponsiveCandidate(entry.assets.largeJpg, entry.assets.largeWidth)
  ]);
  elements.lightboxImage.sizes = '(max-width: 900px) 100vw, calc(100vw - 400px)';

  elements.lightboxEyebrow.textContent = entry.featured ? String(gallery.currentIndex + 1).padStart(2, '0') : 'Archive frame';
  elements.lightboxTitle.textContent = entry.displayTitle;
  elements.lightboxSubline.textContent = '';
  elements.lightboxNotes.textContent = '';
  replaceChildrenCompat(elements.lightboxMeta, buildLightboxMeta(entry));

  elements.lightboxThumbStrip.querySelectorAll('.lightbox-thumb').forEach((button) => {
    const active = button.dataset.entryId === entry.id;
    button.classList.toggle('is-active', active);
    if (active) {
      scrollThumbIntoView(button);
    }
  });
  refreshLightboxFocusables();

  preloadAdjacentEntries(gallery.currentIndex);
}

function buildLightboxMeta(entry) {
  const fragment = document.createDocumentFragment();

  // Primary meta rows (always visible)
  const primaryRows = [
    entry.location ? ['Location', entry.location] : null,
    entry.dateLabel ? ['Date', entry.dateLabel] : null,
    entry.exif?.focalLength ? ['Focal length', `${entry.exif.focalLength}mm`] : null,
    entry.exif?.aperture ? ['Aperture', `f/${entry.exif.aperture}`] : null
  ].filter(Boolean);

  // Additional EXIF details (hidden behind accordion)
  const expandedRows = [
    entry.exif?.camera ? ['Camera', entry.exif.camera] : null,
    entry.exif?.lens ? ['Lens', entry.exif.lens] : null,
    entry.exif?.shutter ? ['Shutter', `${entry.exif.shutter}s`] : null,
    entry.exif?.iso ? ['ISO', String(entry.exif.iso)] : null
  ].filter(Boolean);

  const renderRow = ([label, value]) => {
    const row = document.createElement('div');
    row.className = 'lightbox-meta-row';

    const term = document.createElement('span');
    term.className = 'lightbox-meta-term';
    term.textContent = label;

    const desc = document.createElement('span');
    desc.className = 'lightbox-meta-desc';
    desc.textContent = value;

    row.append(term, desc);
    return row;
  };

  primaryRows.forEach((rowData) => {
    fragment.appendChild(renderRow(rowData));
  });

  if (expandedRows.length > 0) {
    const details = document.createElement('details');
    details.className = 'lightbox-meta-details';

    const summary = document.createElement('summary');
    summary.className = 'lightbox-meta-summary';
    summary.setAttribute('aria-label', 'Toggle additional photo metadata');
    summary.textContent = 'Additional Info';

    const detailsContent = document.createElement('div');
    detailsContent.className = 'lightbox-meta-expanded';

    expandedRows.forEach((rowData) => {
      detailsContent.appendChild(renderRow(rowData));
    });

    details.append(summary, detailsContent);
    fragment.appendChild(details);
  }

  return fragment;
}

function navigateLightbox(direction) {
  if (!gallery.entries.length || gallery.currentIndex < 0 || !gallery.elements.lightboxImage) return;

  if (gallery.lightboxNavigationTimer) {
    window.clearTimeout(gallery.lightboxNavigationTimer);
  }

  gallery.elements.lightboxImage.style.opacity = '0';

  gallery.lightboxNavigationTimer = window.setTimeout(() => {
    gallery.lightboxNavigationTimer = 0;
    if (!gallery.lightboxOpen) return;

    const length = gallery.entries.length;
    gallery.currentIndex = (gallery.currentIndex + direction + length) % length;
    const nextEntry = gallery.entries[gallery.currentIndex];
    writePhotoHash(nextEntry.id);
    renderLightboxEntry(nextEntry);

    requestAnimationFrame(() => {
      gallery.elements.lightboxImage.style.opacity = '1';
      gallery.elements.lightboxImage.addEventListener('transitionend', cleanupLightboxImageOpacity, { once: true });
    });
  }, 150);
}

function cleanupLightboxImageOpacity(event) {
  if (event && event.propertyName !== 'opacity') return;
  gallery.elements.lightboxImage?.style.removeProperty('opacity');
}

function closeLightbox() {
  writePhotoHash(null);
  syncGalleryFromUrl();
}

function closeLightboxUi() {
  if (!gallery.lightboxOpen) return;

  if (gallery.lightboxNavigationTimer) {
    window.clearTimeout(gallery.lightboxNavigationTimer);
    gallery.lightboxNavigationTimer = 0;
  }
  if (gallery.hashChangeTimer) {
    window.clearTimeout(gallery.hashChangeTimer);
    gallery.hashChangeTimer = 0;
  }

  gallery.lightboxOpen = false;
  gallery.elements.lightbox?.classList.remove('is-active');
  document.body.classList.remove('gallery-lightbox-open');
  setPageInert(false);
  cleanupLightboxImageOpacity();
  if (gallery.elements.lightbox) {
    gallery.elements.lightbox.hidden = true;
  }
  if (gallery.archiveLayout.pending) {
    gallery.archiveLayout.pending = false;
    scheduleArchiveLayout();
  }
  gallery.triggerElement?.focus?.();
  gallery.triggerElement = null;
}

function setPageInert(active) {
  const supportsNativeInert = typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype;
  gallery.inertElements.forEach((element) => {
    if (active) {
      element.setAttribute('inert', '');
      if (!supportsNativeInert && !gallery.inertFallbackState.has(element)) {
        const focusables = Array.from(element.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ));
        gallery.inertFallbackState.set(element, {
          ariaHidden: element.getAttribute('aria-hidden'),
          focusables: focusables.map((focusable) => ({
            element: focusable,
            tabIndex: focusable.getAttribute('tabindex')
          }))
        });
        element.setAttribute('aria-hidden', 'true');
        focusables.forEach((focusable) => focusable.setAttribute('tabindex', '-1'));
      }
    } else {
      element.removeAttribute('inert');
      const previous = gallery.inertFallbackState.get(element);
      if (previous) {
        if (previous.ariaHidden === null) {
          element.removeAttribute('aria-hidden');
        } else {
          element.setAttribute('aria-hidden', previous.ariaHidden);
        }
        previous.focusables.forEach(({ element: focusable, tabIndex }) => {
          if (tabIndex === null) {
            focusable.removeAttribute('tabindex');
          } else {
            focusable.setAttribute('tabindex', tabIndex);
          }
        });
        gallery.inertFallbackState.delete(element);
      }
    }
  });
}

function handleGlobalKeydown(event) {
  if (!gallery.lightboxOpen) return;

  if (event.key === 'Escape') {
    event.preventDefault();
    closeLightbox();
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    navigateLightbox(-1);
    return;
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault();
    navigateLightbox(1);
    return;
  }

  if (event.key === 'Tab') {
    trapFocus(event);
  }
}

function trapFocus(event) {
  if (!gallery.elements.lightbox) return;
  const focusables = gallery.lightboxFocusables.length ? gallery.lightboxFocusables : refreshLightboxFocusables();
  if (!focusables.length) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function refreshLightboxFocusables() {
  if (!gallery.elements.lightbox) {
    gallery.lightboxFocusables = [];
    return gallery.lightboxFocusables;
  }

  gallery.lightboxFocusables = Array.from(gallery.elements.lightbox.querySelectorAll(
    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  )).filter((element) => {
    return !element.hasAttribute('hidden') && element.offsetParent !== null;
  });
  return gallery.lightboxFocusables;
}

function supportsScrollIntoViewInline() {
  if (gallery.supportsScrollIntoViewInline !== null) {
    return gallery.supportsScrollIntoViewInline;
  }

  gallery.supportsScrollIntoViewInline = false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    // Feature-detect via string inspection of the native method's source,
    // avoiding the need to create detached DOM nodes.
    if (typeof descriptor?.value === 'function') {
      const source = descriptor.value.toString();
      gallery.supportsScrollIntoViewInline = source.includes('inline');
    }
  } catch (_error) {
    gallery.supportsScrollIntoViewInline = false;
  }
  return gallery.supportsScrollIntoViewInline;
}

function scrollThumbIntoView(button) {
  if (supportsScrollIntoViewInline()) {
    button.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    return;
  }
  button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function setInfoPanelOpen(active) {
  gallery.infoPanelOpen = Boolean(active);
  gallery.elements.lightboxPanel?.classList.toggle('is-open', gallery.infoPanelOpen);
  gallery.elements.lightboxInfoToggle?.setAttribute('aria-expanded', String(gallery.infoPanelOpen));
}

function readPhotoHash() {
  if (!window.location.hash.startsWith(GALLERY_HASH_PREFIX)) return '';
  try {
    return decodeURIComponent(window.location.hash.slice(GALLERY_HASH_PREFIX.length));
  } catch {
    return '';
  }
}

function writePhotoHash(entryId) {
  const base = `${window.location.pathname}${window.location.search}`;
  const nextUrl = entryId
    ? `${base}${GALLERY_HASH_PREFIX}${encodeURIComponent(entryId)}`
    : base;

  if (entryId ? readPhotoHash() === entryId : !readPhotoHash()) return;

  history.replaceState(
    { ...(history.state || {}), galleryPhoto: entryId ?? null },
    '',
    nextUrl
  );

  if (entryId ? readPhotoHash() !== entryId : readPhotoHash()) {
    window.location.hash = entryId
      ? `${GALLERY_HASH_PREFIX}${encodeURIComponent(entryId)}`
      : '';
  }
}

function handleHashChange() {
  if (gallery.hashChangeTimer) {
    window.clearTimeout(gallery.hashChangeTimer);
  }

  gallery.hashChangeTimer = window.setTimeout(() => {
    gallery.hashChangeTimer = 0;
    syncGalleryFromUrl();
  }, 80);
}

function syncGalleryFromUrl() {
  const hashId = readPhotoHash();
  if (!hashId) {
    if (gallery.lightboxOpen) closeLightboxUi();
    return;
  }

  if (!gallery.entries.length) return;

  const index = gallery.entries.findIndex((entry) => entry.id === hashId);
  if (index === -1) {
    writePhotoHash(null);
    if (gallery.lightboxOpen) closeLightboxUi();
    return;
  }

  if (!gallery.lightboxOpen || gallery.currentIndex !== index) {
    openLightboxUi(hashId, null);
  }
}

// F04: Suspension detaches only the dynamic listeners/observers/timers that
// resumeGalleryRuntime re-arms. It is idempotent and safe both for real unload
// (document is discarded) and for BFCache suspension (document may return).
function suspendGalleryRuntime() {
  cleanupLightboxImageOpacity();
  document.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('hashchange', handleHashChange);
  gallery.scrollRevealObserver?.disconnect();
  gallery.scrollRevealObserver = null;
  if (gallery.archiveLayout.frame) {
    window.cancelAnimationFrame(gallery.archiveLayout.frame);
    gallery.archiveLayout.frame = 0;
  }
  gallery.archiveLayout.observer?.disconnect();
  gallery.archiveLayout.observer = null;
  if (gallery.archiveLayout.resizeHandler) {
    window.removeEventListener('resize', gallery.archiveLayout.resizeHandler);
    gallery.archiveLayout.resizeHandler = null;
  }
  if (gallery.lightboxNavigationTimer) {
    window.clearTimeout(gallery.lightboxNavigationTimer);
    gallery.lightboxNavigationTimer = 0;
  }
  if (gallery.hashChangeTimer) {
    window.clearTimeout(gallery.hashChangeTimer);
    gallery.hashChangeTimer = 0;
  }
  gallery.heroRevealTimers.forEach((t) => window.clearTimeout(t));
  gallery.heroRevealTimers = [];
  if (gallery.heroRevealScrollHandler) {
    window.removeEventListener('scroll', gallery.heroRevealScrollHandler, { passive: true });
    gallery.heroRevealScrollHandler = null;
  }
}

// A fresh load already bound everything in bindStaticEvents; only a persisted
// restore needs to re-arm the runtime. Scroll, lightbox, and selection state
// are untouched — the restored DOM never lost them.
function resumeGalleryRuntime(event) {
  if (event && !event.persisted) return;

  bindRuntimeListeners();

  // Scroll-reveal observation re-arms either way; when the hero sequence was
  // interrupted mid-trip, its timers/scroll-skip are re-armed as well.
  initScrollReveal();
  if (!gallery.heroRevealComplete) {
    initGalleryHeroReveal();
  }

  if (gallery.entries.length) {
    initArchiveLayout();
    scheduleArchiveLayout({ force: true });
    syncGalleryFromUrl();
  }
}

function preloadAdjacentEntries(index) {
  gallery.preloadImages = [];
  [index - 1, index + 1].forEach((targetIndex) => {
    const entry = gallery.entries[(targetIndex + gallery.entries.length) % gallery.entries.length];
    const source = entry?.assets?.largeJpg || entry?.assets?.mediumJpg;
    if (!source) return;
    const image = new Image();
    image.src = source;
    gallery.preloadImages.push(image);
  });
}

function getEntryById(entryId) {
  return gallery.entries.find((entry) => entry.id === entryId) || null;
}

function setPictureSource(source, srcset, sizes) {
  if (!source) return;
  if (!srcset) {
    source.removeAttribute('srcset');
    source.removeAttribute('sizes');
    return;
  }
  source.srcset = srcset;
  source.sizes = sizes;
}

function resolveVariantPath(variant, format, basePath, fallbackFilename = '') {
  if (variant?.[format]) return `${basePath}${variant[format]}`;
  if (fallbackFilename && format === 'jpg') return `${basePath}${fallbackFilename}`;
  return '';
}

function buildSrcset(candidates) {
  return candidates.filter(Boolean).join(', ');
}

function makeResponsiveCandidate(src, width) {
  if (!src) return '';
  if (Number.isFinite(width) && width > 0) return `${src} ${width}w`;
  return src;
}

function basenameFromPath(value) {
  if (!value) return '';
  const normalized = String(value).split('?')[0].split('#')[0];
  const segments = normalized.split('/');
  return segments[segments.length - 1];
}

function getCardImageSizes(context, index, isProminent) {
  if (isProminent) {
    return '(max-width: 900px) 100vw, (max-width: 1440px) 84vw, 1220px';
  }

  if (context === 'featured') {
    return index === 0
      ? '(max-width: 900px) 100vw, (max-width: 1440px) 84vw, 1220px'
      : '(max-width: 900px) 100vw, (max-width: 1440px) 41vw, 580px';
  }

  return '(max-width: 900px) 100vw, (max-width: 1440px) 41vw, 580px';
}

function normalizeGalleryKey(value) {
  const stem = basenameFromPath(value).toLowerCase().replace(/\.(avif|webp|jpe?g|png)$/i, '');

  return stem
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatTitle(filename) {
  const parts = basenameFromPath(filename)
    .replace(/\.(avif|webp|jpe?g|png)$/i, '')
    .split(/[-_]+/)
    .filter(Boolean);

  return parts
    .map((part, index) => {
      if (/\d/.test(part)) {
        return part.toUpperCase();
      }

      const lower = part.toLowerCase();
      if (index > 0 && index < parts.length - 1 && ['a', 'an', 'and', 'at', 'for', 'in', 'of', 'on', 'or', 'the', 'to'].includes(lower)) {
        return lower;
      }

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

function extractYear(dateValue) {
  const match = String(dateValue || '').match(/(19|20)\d{2}/);
  return match ? match[0] : '';
}

function formatDate(dateValue) {
  if (!dateValue) return '';
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parsed);
}

function formatShortDate(dateValue) {
  if (!dateValue) return '';
  const parsed = new Date(`${dateValue}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric'
  }).format(parsed);
}

})();
