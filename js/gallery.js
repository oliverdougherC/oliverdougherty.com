/**
 * Gallery JavaScript
 * Builds the editorial gallery experience from generated asset data plus
 * human-authored sequence metadata.
 */

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
  elements: {}
};

document.addEventListener('DOMContentLoaded', () => {
  cacheElements();
  bindStaticEvents();
  initGallery().catch((error) => {
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
    heroTitle: document.getElementById('galleryHeroTitle'),
    heroMeta: document.getElementById('galleryHeroMeta'),
    heroSupport: document.getElementById('galleryHeroSupport'),
    heroOpen: document.getElementById('galleryHeroOpen'),
    loading: document.getElementById('galleryLoading'),
    empty: document.getElementById('galleryEmpty'),
    emptyTitle: document.getElementById('galleryEmptyTitle'),
    emptyCopy: document.getElementById('galleryEmptyCopy'),
    error: document.getElementById('galleryError'),
    errorCopy: document.getElementById('galleryErrorCopy'),
    featuredSection: document.getElementById('galleryFeaturedSection'),
    featuredGrid: document.getElementById('galleryFeaturedGrid'),
    archiveSection: document.getElementById('galleryArchiveSection'),
    archiveGrid: document.getElementById('galleryArchiveGrid'),
    lightbox: document.getElementById('lightbox'),
    lightboxPanel: document.getElementById('lightboxPanel'),
    lightboxMedia: document.getElementById('lightboxMedia'),
    lightboxCounter: document.getElementById('lightboxCounter'),
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

  document.querySelectorAll('[data-lightbox-dismiss]').forEach((element) => {
    element.addEventListener('click', () => closeLightbox());
  });

  document.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('hashchange', handleHashChange);

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
  setLoadingState(false);
  handleHashChange();

  window.__galleryState = {
    getEntries: () => gallery.entries,
    getVisibleEntries: () => gallery.visibleEntries,
    getHeroEntries: () => gallery.heroEntries,
    openPhotoById: (id) => openLightboxById(id),
    closeLightbox
  };
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
    const response = await fetch(path, { cache: 'no-store' });
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
    title: displayTitle,
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
    '(max-width: 900px) 100vw, 32vw'
  );
  setPictureSource(
    gallery.elements.heroSourceWebp,
    buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumWebp, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeWebp, entry.assets.largeWidth)
    ]),
    '(max-width: 900px) 100vw, 32vw'
  );

  if (gallery.elements.heroImage) {
    gallery.elements.heroImage.src = entry.assets.largeJpg || entry.assets.mediumJpg || entry.assets.original;
    gallery.elements.heroImage.alt = entry.displayTitle;
    gallery.elements.heroImage.srcset = buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumJpg, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeJpg, entry.assets.largeWidth)
    ]);
    gallery.elements.heroImage.sizes = '(max-width: 900px) 100vw, 32vw';
  }

  if (gallery.elements.heroTitle) {
    gallery.elements.heroTitle.textContent = entry.displayTitle;
  }

  if (gallery.elements.heroMeta) {
    gallery.elements.heroMeta.textContent = [
      entry.location,
      entry.dateLabel
    ].filter(Boolean).join(' · ');
  }

  if (gallery.elements.heroSupport) {
    const supportCopy = pickHeroSupportCopy(entry);
    gallery.elements.heroSupport.hidden = !supportCopy;
    gallery.elements.heroSupport.textContent = supportCopy;
  }

  if (gallery.elements.heroOpen) {
    gallery.elements.heroOpen.dataset.entryId = entry.id;
  }
}

function renderGallery() {
  const visibleEntries = gallery.entries;
  const visibleFeatured = gallery.featuredEntries;

  gallery.visibleEntries = visibleEntries;

  if (!visibleEntries.length) {
    gallery.elements.featuredSection.hidden = true;
    gallery.elements.archiveSection.hidden = true;
    showEmptyState(
      'No photographs found',
      'The archive does not contain any published photographs yet.'
    );
    return;
  }

  hideStatusStates();

  const showFeaturedSection = visibleFeatured.length > 0;
  gallery.elements.featuredSection.hidden = !showFeaturedSection;
  gallery.elements.archiveSection.hidden = false;

  if (showFeaturedSection) {
    renderPhotoGrid(gallery.elements.featuredGrid, visibleFeatured, 'featured');
  } else {
    gallery.elements.featuredGrid.replaceChildren();
  }

  renderPhotoGrid(gallery.elements.archiveGrid, visibleEntries, 'archive');
}

function renderPhotoGrid(container, entries, context) {
  const fragment = document.createDocumentFragment();

  entries.forEach((entry, index) => {
    fragment.appendChild(createPhotoCard(entry, {
      context,
      index
    }));
  });

  container.replaceChildren(fragment);
}

function createPhotoCard(entry, { context, index }) {
  const article = document.createElement('article');
  article.className = 'photo-card is-loading';
  article.dataset.entryId = entry.id;
  article.dataset.context = context;

  if (context === 'featured') {
    article.classList.add('photo-card--featured');
    if (index === 0) {
      article.classList.add('photo-card--feature-hero');
    } else {
      article.classList.add('photo-card--feature-secondary');
    }
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'photo-card-button';
  button.setAttribute('aria-label', `Inspect ${entry.displayTitle}`);
  button.setAttribute('data-cursor', 'hover');

  const media = document.createElement('div');
  media.className = 'photo-media';

  const picture = document.createElement('picture');
  const imageSizes = getCardImageSizes(context, index);
  const sourceAvif = document.createElement('source');
  sourceAvif.type = 'image/avif';
  if (entry.assets.thumbAvif) {
    sourceAvif.srcset = buildSrcset([
      makeResponsiveCandidate(entry.assets.thumbAvif, entry.assets.thumbWidth),
      makeResponsiveCandidate(entry.assets.mediumAvif, entry.assets.mediumWidth)
    ]);
    sourceAvif.sizes = imageSizes;
  }

  const sourceWebp = document.createElement('source');
  sourceWebp.type = 'image/webp';
  if (entry.assets.thumbWebp) {
    sourceWebp.srcset = buildSrcset([
      makeResponsiveCandidate(entry.assets.thumbWebp, entry.assets.thumbWidth),
      makeResponsiveCandidate(entry.assets.mediumWebp, entry.assets.mediumWidth)
    ]);
    sourceWebp.sizes = imageSizes;
  }

  const image = document.createElement('img');
  image.className = 'photo-image';
  image.src = entry.assets.mediumJpg || entry.assets.thumbJpg || entry.assets.original;
  image.alt = entry.displayTitle;
  image.loading = index < 4 ? 'eager' : 'lazy';
  image.decoding = index < 4 ? 'sync' : 'async';
  image.fetchPriority = index < 4 ? 'high' : 'auto';
  image.width = entry.assets.mediumWidth || entry.width;
  image.height = entry.assets.mediumHeight || entry.height;
  image.srcset = buildSrcset([
    makeResponsiveCandidate(entry.assets.thumbJpg, entry.assets.thumbWidth),
    makeResponsiveCandidate(entry.assets.mediumJpg, entry.assets.mediumWidth)
  ]);
  image.sizes = imageSizes;
  image.addEventListener('load', () => {
    article.classList.remove('is-loading');
    article.classList.add('is-loaded');
  }, { once: true });
  image.addEventListener('error', () => {
    article.classList.remove('is-loading');
    article.classList.add('photo-card--broken');
  }, { once: true });

  picture.append(sourceAvif, sourceWebp, image);
  media.appendChild(picture);

  const overlay = document.createElement('div');
  overlay.className = 'photo-info';

  const title = document.createElement('h3');
  title.className = 'photo-title';
  title.textContent = entry.displayTitle;

  const meta = document.createElement('p');
  meta.className = 'photo-meta';
  meta.textContent = buildCardMeta(entry);

  overlay.append(title, meta);
  button.append(media, overlay);
  article.appendChild(button);

  button.addEventListener('click', () => {
    gallery.triggerElement = button;
    openLightboxById(entry.id, button);
  });

  return article;
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
  gallery.elements.featuredSection.hidden = true;
  gallery.elements.archiveSection.hidden = true;
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

  gallery.elements.lightboxThumbStrip.replaceChildren(fragment);
}

function openLightboxById(entryId, triggerElement) {
  const index = gallery.entries.findIndex((entry) => entry.id === entryId);
  if (index === -1) return;

  gallery.currentIndex = index;
  gallery.lightboxOpen = true;
  gallery.triggerElement = triggerElement || gallery.triggerElement;
  gallery.elements.lightbox.hidden = false;
  gallery.elements.lightbox.classList.add('is-active');
  document.body.classList.add('gallery-lightbox-open');
  setInfoPanelOpen(!window.matchMedia('(max-width: 900px)').matches);
  renderLightboxEntry(gallery.entries[index]);
  syncHash(entryId);
  gallery.elements.lightboxClose.focus();
}

function renderLightboxEntry(entry) {
  setPictureSource(
    gallery.elements.lightboxSourceAvif,
    buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumAvif, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeAvif, entry.assets.largeWidth)
    ]),
    '(max-width: 900px) 100vw, calc(100vw - 480px)'
  );
  setPictureSource(
    gallery.elements.lightboxSourceWebp,
    buildSrcset([
      makeResponsiveCandidate(entry.assets.mediumWebp, entry.assets.mediumWidth),
      makeResponsiveCandidate(entry.assets.largeWebp, entry.assets.largeWidth)
    ]),
    '(max-width: 900px) 100vw, calc(100vw - 480px)'
  );

  gallery.elements.lightboxImage.src = entry.assets.largeJpg || entry.assets.mediumJpg || entry.assets.original;
  gallery.elements.lightboxImage.alt = entry.displayTitle;
  gallery.elements.lightboxImage.srcset = buildSrcset([
    makeResponsiveCandidate(entry.assets.mediumJpg, entry.assets.mediumWidth),
    makeResponsiveCandidate(entry.assets.largeJpg, entry.assets.largeWidth)
  ]);
  gallery.elements.lightboxImage.sizes = '(max-width: 900px) 100vw, calc(100vw - 480px)';

  gallery.elements.lightboxCounter.textContent = `${String(gallery.currentIndex + 1).padStart(2, '0')} / ${String(gallery.entries.length).padStart(2, '0')}`;
  gallery.elements.lightboxEyebrow.textContent = entry.featured ? 'Featured frame' : 'Archive frame';
  gallery.elements.lightboxTitle.textContent = entry.displayTitle;
  gallery.elements.lightboxSubline.textContent = [
    entry.location,
    entry.dateLabel
  ].filter(Boolean).join(' · ');
  gallery.elements.lightboxNotes.textContent = buildNarrativeCopy(entry);
  gallery.elements.lightboxMeta.replaceChildren(buildLightboxMeta(entry));

  gallery.elements.lightboxThumbStrip.querySelectorAll('.lightbox-thumb').forEach((button) => {
    const active = button.dataset.entryId === entry.id;
    button.classList.toggle('is-active', active);
    if (active) {
      button.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
  });

  preloadAdjacentEntries(gallery.currentIndex);
}

function buildNarrativeCopy(entry) {
  const parts = [entry.description];
  const note = [entry.hero?.teaser, entry.notes]
    .map((value) => String(value || '').trim())
    .find((value) => value && value !== entry.description);

  if (note) {
    parts.push(note);
  }

  return parts.filter(Boolean).join(' ');
}

function buildLightboxMeta(entry) {
  const fragment = document.createDocumentFragment();
  const rows = [
    entry.location ? ['Location', entry.location] : null,
    entry.dateLabel ? ['Date', entry.dateLabel] : null,
    entry.exif?.camera ? ['Camera', entry.exif.camera] : null,
    entry.exif?.lens ? ['Lens', entry.exif.lens] : null,
    entry.exif?.focalLength ? ['Focal length', `${entry.exif.focalLength}mm`] : null,
    entry.exif?.aperture ? ['Aperture', `f/${entry.exif.aperture}`] : null,
    entry.exif?.shutter ? ['Shutter', `${entry.exif.shutter}s`] : null,
    entry.exif?.iso ? ['ISO', String(entry.exif.iso)] : null
  ].filter(Boolean);

  rows.forEach(([label, value]) => {
    const row = document.createElement('div');
    row.className = 'lightbox-meta-row';

    const term = document.createElement('span');
    term.className = 'lightbox-meta-term';
    term.textContent = label;

    const desc = document.createElement('span');
    desc.className = 'lightbox-meta-desc';
    desc.textContent = value;

    row.append(term, desc);
    fragment.appendChild(row);
  });

  return fragment;
}

function navigateLightbox(direction) {
  if (!gallery.entries.length) return;
  const length = gallery.entries.length;
  gallery.currentIndex = (gallery.currentIndex + direction + length) % length;
  const nextEntry = gallery.entries[gallery.currentIndex];
  syncHash(nextEntry.id);
  renderLightboxEntry(nextEntry);
}

function closeLightbox({ updateHashState = true } = {}) {
  if (!gallery.lightboxOpen) return;

  gallery.lightboxOpen = false;
  gallery.elements.lightbox.classList.remove('is-active');
  gallery.elements.lightbox.hidden = true;
  document.body.classList.remove('gallery-lightbox-open');
  if (updateHashState) {
    clearHash();
  }
  gallery.triggerElement?.focus?.();
  gallery.triggerElement = null;
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
  const focusables = gallery.elements.lightbox.querySelectorAll(
    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  );
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

function setInfoPanelOpen(active) {
  gallery.infoPanelOpen = Boolean(active);
  gallery.elements.lightboxPanel.classList.toggle('is-open', gallery.infoPanelOpen);
  gallery.elements.lightboxInfoToggle.setAttribute('aria-expanded', String(gallery.infoPanelOpen));
}

function syncHash(entryId) {
  const nextHash = `${GALLERY_HASH_PREFIX}${encodeURIComponent(entryId)}`;
  if (window.location.hash === nextHash) return;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}${nextHash}`);
}

function clearHash() {
  if (!window.location.hash.startsWith(GALLERY_HASH_PREFIX)) return;
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function handleHashChange() {
  const hashId = readHashEntryId();
  if (!hashId) {
    if (gallery.lightboxOpen) {
      closeLightbox({ updateHashState: false });
    }
    return;
  }

  if (!gallery.entries.length) return;

  if (!gallery.lightboxOpen || gallery.entries[gallery.currentIndex]?.id !== hashId) {
    openLightboxById(hashId);
  }
}

function readHashEntryId() {
  if (!window.location.hash.startsWith(GALLERY_HASH_PREFIX)) return '';
  return decodeURIComponent(window.location.hash.slice(GALLERY_HASH_PREFIX.length));
}

function preloadAdjacentEntries(index) {
  [index - 1, index + 1].forEach((targetIndex) => {
    const entry = gallery.entries[(targetIndex + gallery.entries.length) % gallery.entries.length];
    const source = entry?.assets?.largeJpg || entry?.assets?.mediumJpg;
    if (!source) return;
    const image = new Image();
    image.src = source;
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

function pickHeroSupportCopy(entry) {
  return [
    entry.hero?.teaser,
    entry.notes,
    entry.description
  ]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
}

function getCardImageSizes(context, index) {
  if (context === 'featured') {
    return index === 0
      ? '(max-width: 900px) 100vw, (max-width: 1440px) 84vw, 1220px'
      : '(max-width: 900px) 100vw, (max-width: 1440px) 41vw, 580px';
  }

  return '(max-width: 900px) 100vw, (max-width: 1440px) 41vw, 580px';
}

function buildCardMeta(entry) {
  return [
    entry.location,
    entry.dateShortLabel
  ].filter(Boolean).join(' · ');
}

function normalizeGalleryKey(value) {
  let stem = basenameFromPath(value).toLowerCase();
  let next = stem.replace(/\.(avif|webp|jpe?g|png)$/i, '');

  while (next !== stem) {
    stem = next;
    next = stem.replace(/\.(avif|webp|jpe?g|png)$/i, '');
  }

  return stem
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatTitle(filename) {
  const parts = basenameFromPath(filename)
    .replace(/\.(avif|webp|jpe?g|png)$/i, '')
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

function formatDateRange(startDate, endDate) {
  if (!startDate && !endDate) return 'Open archive';
  if (startDate === endDate) return formatDate(startDate);

  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return [startDate, endDate].filter(Boolean).join(' - ');
  }

  const sameYear = start.getFullYear() === end.getFullYear();
  const startFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(start);
  const endFmt = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(end);
  return `${startFmt} - ${endFmt}`;
}
