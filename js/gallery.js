/**
 * Gallery JavaScript
 * Handles photo loading, lightbox, and search.
 * EXIF metadata is pre-extracted at build time and embedded in photos.json.
 * Navigation and utilities are provided by main.js (loaded before this script).
 */

document.addEventListener('DOMContentLoaded', () => {
  initGallery();
  initLightbox();
  initGallerySearch();
  initLightboxSwipe();
});

/**
 * Gallery state and configuration
 */
const gallery = {
  photos: [],
  currentIndex: 0,
  photosPath: '../../photos/',
  thumbsPath: '../../photos/thumbs/',
  mediumPath: '../../photos/medium/',
  largePath: '../../photos/large/',
  triggerElement: null // Stores the element that opened the lightbox for focus return
};

function updateRenderedPhotoCount() {
  const countEl = document.getElementById('photoCount');
  if (!countEl) return;

  const visibleCards = document.querySelectorAll(
    '.photo-card:not(.photo-card--broken):not(.search-hidden)'
  ).length;
  countEl.textContent = String(visibleCards);
}

/**
 * Initialize gallery - load photos from directory
 */
async function initGallery() {
  const grid = document.getElementById('galleryGrid');
  const loading = document.getElementById('galleryLoading');
  const empty = document.getElementById('galleryEmpty');

  try {
    const response = await fetch('../../photos/photos.json');

    if (response.ok) {
      const data = await response.json();
      gallery.photos = data.photos || [];
    } else {
      gallery.photos = await detectPhotos();
    }

    if (loading) loading.style.display = 'none';

    if (gallery.photos.length === 0) {
      if (empty) empty.style.display = 'flex';
      return;
    }

    // Use DocumentFragment for batch DOM insertion (single reflow)
    const fragment = document.createDocumentFragment();
    gallery.photos.forEach((photo, index) => {
      const card = createPhotoCard(photo, index);
      fragment.appendChild(card);
    });
    grid.appendChild(fragment);
    updateRenderedPhotoCount();

  } catch (error) {
    console.error('Error loading gallery:', error);
    if (loading) loading.style.display = 'none';
    if (empty) empty.style.display = 'flex';
  }
}

/**
 * Detect photos - tries common filenames (fallback)
 */
async function detectPhotos() {
  const photos = [];
  const testFiles = [
    'test.jpg', 'photo1.jpg', 'photo2.jpg', 'photo3.jpg',
    'image1.jpg', 'image2.jpg', 'IMG_001.jpg', 'IMG_002.jpg',
    'DSC_001.jpg', 'DSC_002.jpg'
  ];

  for (const filename of testFiles) {
    try {
      const response = await fetch(`../../photos/${filename}`, { method: 'HEAD' });
      if (response.ok) {
        photos.push({ filename, title: formatTitle(filename) });
      }
    } catch (e) {
      // File doesn't exist, continue
    }
  }

  return photos;
}

/**
 * Format filename to readable title
 */
function formatTitle(filename) {
  return filename
    .replace(/\.[^/.]+$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Escape dynamic text before interpolating into HTML strings.
 */
function escapeHTML(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makeResponsiveCandidate(src, width) {
  if (!src) return null;
  return Number.isFinite(width) && width > 0 ? `${src} ${width}w` : src;
}

function joinSrcset(candidates) {
  return candidates.filter(Boolean).join(', ');
}

function setPictureSource(source, srcset, sizes) {
  if (!source) return;

  if (!srcset) {
    source.removeAttribute('srcset');
    source.removeAttribute('sizes');
    return;
  }

  source.srcset = srcset;
  if (sizes) {
    source.sizes = sizes;
  } else {
    source.removeAttribute('sizes');
  }
}

function resolveVariantPath(variant, format, basePath) {
  if (!variant || !variant[format]) return null;
  return `${basePath}${variant[format]}`;
}

/**
 * Create photo card element with responsive images (<picture> + WebP)
 */
function createPhotoCard(photo, index) {
  const card = document.createElement('div');
  card.className = 'photo-card is-loading';
  card.dataset.index = index;
  card.setAttribute('tabindex', '0');
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `View ${photo.title || 'photograph'}`);

  const thumbJpg = resolveVariantPath(photo.thumbs, 'jpg', gallery.thumbsPath);
  const thumbWebp = resolveVariantPath(photo.thumbs, 'webp', gallery.thumbsPath);
  const thumbFallback = thumbJpg || `${gallery.photosPath}${photo.filename}`;
  const photoTitle = photo.title || 'Untitled';
  const imgAlt = photo.title || 'Photograph';
  const thumbWidth = Number(photo.thumbs?.width);
  const thumbHeight = Number(photo.thumbs?.height);
  const thumbSizes = '(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw';
  const thumbJpgSrcset = joinSrcset([
    makeResponsiveCandidate(thumbJpg, thumbWidth)
  ]);
  const thumbWebpSrcset = joinSrcset([
    makeResponsiveCandidate(thumbWebp, thumbWidth)
  ]);

  // Build image media element without template HTML interpolation
  const imageEl = document.createElement('img');
  imageEl.src = thumbFallback;
  imageEl.alt = imgAlt;
  imageEl.className = 'photo-image';
  const isFirstRowCandidate = index < 4;
  imageEl.loading = isFirstRowCandidate ? 'eager' : 'lazy';
  imageEl.decoding = isFirstRowCandidate ? 'sync' : 'auto';
  imageEl.fetchPriority = isFirstRowCandidate ? 'high' : 'auto';
  if (thumbJpgSrcset) {
    imageEl.srcset = thumbJpgSrcset;
    imageEl.sizes = thumbSizes;
  }
  if (Number.isFinite(thumbWidth) && thumbWidth > 0) imageEl.width = thumbWidth;
  if (Number.isFinite(thumbHeight) && thumbHeight > 0) imageEl.height = thumbHeight;

  const markLoaded = () => {
    card.classList.remove('is-loading');
    card.classList.add('is-loaded');
  };

  const markBroken = () => {
    card.classList.remove('is-loading');
    card.classList.add('photo-card--broken');
    card.setAttribute('aria-hidden', 'true');
    card.removeAttribute('tabindex');
    updateRenderedPhotoCount();
  };

  imageEl.addEventListener('load', markLoaded, { once: true });
  imageEl.addEventListener('error', markBroken, { once: true });

  if (imageEl.complete) {
    if (imageEl.naturalWidth > 0) {
      markLoaded();
    } else {
      markBroken();
    }
  }

  if (thumbWebpSrcset) {
    const picture = document.createElement('picture');
    const sourceWebp = document.createElement('source');
    sourceWebp.type = 'image/webp';
    sourceWebp.srcset = thumbWebpSrcset;
    sourceWebp.sizes = thumbSizes;
    picture.appendChild(sourceWebp);

    picture.appendChild(imageEl);
    card.appendChild(picture);
  } else {
    card.appendChild(imageEl);
  }

  const info = document.createElement('div');
  info.className = 'photo-info';

  const title = document.createElement('h3');
  title.className = 'photo-title';
  title.textContent = photoTitle;

  const meta = document.createElement('div');
  meta.className = 'photo-meta';
  meta.id = `meta-${index}`;
  renderMetaHTML(meta, photo.exif, true);

  info.append(title, meta);
  card.appendChild(info);

  // Click and keyboard to open lightbox
  card.addEventListener('click', () => {
    gallery.triggerElement = card;
    openLightbox(index);
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      gallery.triggerElement = card;
      openLightbox(index);
    }
  });

  return card;
}

/**
 * Format EXIF data as HTML
 */
function formatMetaHTML(exif, compact = false) {
  const items = [];

  if (exif.focalLength) {
    const focalLength = escapeHTML(exif.focalLength);
    items.push(`
      <span class="meta-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
        </svg>
        ${focalLength}mm
      </span>
    `);
  }

  if (exif.aperture) {
    const aperture = escapeHTML(exif.aperture);
    items.push(`
      <span class="meta-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
        </svg>
        f/${aperture}
      </span>
    `);
  }

  if (exif.shutter) {
    const shutter = escapeHTML(exif.shutter);
    items.push(`
      <span class="meta-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
        ${shutter}s
      </span>
    `);
  }

  if (exif.iso) {
    const iso = escapeHTML(exif.iso);
    items.push(`
      <span class="meta-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>
        </svg>
        ISO ${iso}
      </span>
    `);
  }

  if (!compact && exif.camera) {
    const camera = escapeHTML(exif.camera);
    items.push(`
      <span class="meta-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        ${camera}
      </span>
    `);
  }

  if (!compact && exif.lens) {
    const lens = escapeHTML(exif.lens);
    items.push(`
      <span class="meta-item">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>
        </svg>
        ${lens}
      </span>
    `);
  }

  return items.length > 0 ? items.join('') : '<span class="meta-item">No metadata</span>';
}

/**
 * Render metadata content while keeping markup generation centralized.
 */
function renderMetaHTML(container, exif, compact = false) {
  const template = document.createElement('template');
  template.innerHTML = exif
    ? formatMetaHTML(exif, compact)
    : '<span class="meta-item">No metadata</span>';
  container.replaceChildren(template.content.cloneNode(true));
}

/**
 * Lightbox functionality - keyboard listener scoped to open state
 */
let lightboxKeyHandler = null;
let lightboxResizeHandler = null;

function initLightbox() {
  const lightbox = document.getElementById('lightbox');
  const closeBtn = document.getElementById('lightboxClose');
  const prevBtn = document.getElementById('lightboxPrev');
  const nextBtn = document.getElementById('lightboxNext');

  if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
  if (prevBtn) prevBtn.addEventListener('click', () => navigateLightbox(-1));
  if (nextBtn) nextBtn.addEventListener('click', () => navigateLightbox(1));

  // Close on background click
  if (lightbox) {
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox) closeLightbox();
    });
  }
}

/**
 * Determine whether lightbox metadata fits below the image.
 * Uses known image dimensions from photos.json for a deterministic,
 * layout-independent calculation. Falls back to measuring after image load.
 */
let measuring = false;
function updateLightboxMeta() {
  if (measuring) return;
  measuring = true;
  const photo = gallery.photos[gallery.currentIndex];
  const image = document.getElementById('lightboxImage');
  const info = document.querySelector('.lightbox-info');
  if (!photo || !image || !info) {
    measuring = false;
    return;
  }

  const vh = window.innerHeight;
  const vw = window.innerWidth;
  // Match CSS layout constraints so the calculation is pixel-accurate:
  // Width:  desktop = calc(100vw - 192px) to clear prev/next buttons
  //         mobile (<=768px) = 92vw (nav buttons hidden)
  // Height: desktop = calc(100vh - 104px) for close button (80px) + bottom (24px)
  //         small (<=480px) = calc(100vh - 84px) for smaller close button zone
  const isMobile = vw <= 768;
  const isSmall = vw <= 480;
  const availW = isMobile ? vw * 0.92 : vw - 192;
  const availH = isSmall ? vh - 84 : vh - 104;

  // Get intrinsic image dimensions (prefer largest optimized variant, then original)
  const imgW = photo.large?.width || photo.medium?.width || photo.width || image.naturalWidth || 0;
  const imgH = photo.large?.height || photo.medium?.height || photo.height || image.naturalHeight || 0;

  if (!imgW || !imgH) {
    // Dimensions unknown - hide metadata to be safe
    info.classList.add('meta-hidden');
    measuring = false;
    return;
  }

  // Calculate how tall the image renders when it has the FULL available space
  // (object-fit: contain scales to fit within both width and height constraints)
  const scale = Math.min(availW / imgW, availH / imgH, 1);
  const renderedH = Math.ceil(imgH * scale);

  // Remaining vertical space below the image
  const remaining = availH - renderedH;

  // Measure the info section's actual height without affecting flex layout.
  // Temporarily make it position:absolute so it doesn't take flex space.
  info.classList.remove('meta-hidden');
  info.style.position = 'absolute';
  info.style.visibility = 'hidden';
  info.style.width = `${Math.min(600, availW)}px`;
  const infoH = info.offsetHeight;
  info.style.position = '';
  info.style.visibility = '';
  info.style.width = '';

  if (remaining >= infoH) {
    // Metadata fits naturally in the space below the image
    info.classList.remove('meta-hidden');
  } else {
    // Not enough room - hide metadata so image gets full space
    info.classList.add('meta-hidden');
  }
  measuring = false;
}

/**
 * Focusable elements inside the lightbox for focus trapping
 */
function getLightboxFocusables() {
  const lightbox = document.getElementById('lightbox');
  return lightbox.querySelectorAll(
    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  );
}

function openLightbox(index) {
  const lightbox = document.getElementById('lightbox');
  const sourceAvif = document.getElementById('lightboxSourceAvif');
  const sourceWebp = document.getElementById('lightboxSourceWebp');
  const image = document.getElementById('lightboxImage');
  const title = document.getElementById('lightboxTitle');
  const meta = document.getElementById('lightboxMeta');

  gallery.currentIndex = index;
  const photo = gallery.photos[index];

  const lightboxSizes = '(max-width: 768px) 92vw, calc(100vw - 192px)';

  const avifSrcset = joinSrcset([
    makeResponsiveCandidate(
      resolveVariantPath(photo.medium, 'avif', gallery.mediumPath),
      Number(photo.medium?.width)
    ),
    makeResponsiveCandidate(
      resolveVariantPath(photo.large, 'avif', gallery.largePath),
      Number(photo.large?.width)
    )
  ]);
  const webpSrcset = joinSrcset([
    makeResponsiveCandidate(
      resolveVariantPath(photo.medium, 'webp', gallery.mediumPath),
      Number(photo.medium?.width)
    ),
    makeResponsiveCandidate(
      resolveVariantPath(photo.large, 'webp', gallery.largePath),
      Number(photo.large?.width)
    )
  ]);
  const jpgSrcset = joinSrcset([
    makeResponsiveCandidate(
      resolveVariantPath(photo.medium, 'jpg', gallery.mediumPath),
      Number(photo.medium?.width)
    ),
    makeResponsiveCandidate(
      resolveVariantPath(photo.large, 'jpg', gallery.largePath),
      Number(photo.large?.width)
    )
  ]);

  setPictureSource(sourceAvif, avifSrcset, lightboxSizes);
  setPictureSource(sourceWebp, webpSrcset, lightboxSizes);

  if (jpgSrcset) {
    image.srcset = jpgSrcset;
    image.sizes = lightboxSizes;
  } else {
    image.removeAttribute('srcset');
    image.removeAttribute('sizes');
  }

  image.src =
    resolveVariantPath(photo.large, 'jpg', gallery.largePath) ||
    resolveVariantPath(photo.medium, 'jpg', gallery.mediumPath) ||
    `${gallery.photosPath}${photo.filename}`;

  image.alt = photo.title || 'Photograph';
  title.textContent = photo.title || 'Untitled';
  renderMetaHTML(meta, photo.exif, false);

  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';

  const counter = document.getElementById('lightboxCounter');
  if (counter) counter.textContent = `${index + 1} / ${gallery.photos.length}`;

  // Intelligently show/hide metadata based on available space.
  // Run immediately (dimensions are known from photos.json) and also
  // after image load as a safety net for edge cases.
  updateLightboxMeta();
  image.addEventListener('load', updateLightboxMeta, { once: true });
  image.addEventListener('error', () => {
    const info = document.querySelector('.lightbox-info');
    if (info) {
      info.classList.remove('meta-hidden');
      const metaEl = document.getElementById('lightboxMeta');
      if (metaEl) metaEl.innerHTML = '<span class="meta-item">Image failed to load</span>';
    }
    image.alt = 'Image failed to load';
  }, { once: true });

  // Re-check on resize (e.g. rotating phone, resizing window)
  if (lightboxResizeHandler) {
    window.removeEventListener('resize', lightboxResizeHandler);
  }
  lightboxResizeHandler = debounce(updateLightboxMeta, 150);
  window.addEventListener('resize', lightboxResizeHandler);

  // Attach keyboard listener (scoped to lightbox open)
  if (lightboxKeyHandler) {
    document.removeEventListener('keydown', lightboxKeyHandler);
  }
  lightboxKeyHandler = (e) => {
    switch (e.key) {
      case 'Escape':
        closeLightbox();
        break;
      case 'ArrowLeft':
        navigateLightbox(-1);
        break;
      case 'ArrowRight':
        navigateLightbox(1);
        break;
      case 'Tab':
        // Focus trap
        trapFocus(e);
        break;
    }
  };
  document.addEventListener('keydown', lightboxKeyHandler);

  // Move focus into lightbox
  const closeBtn = document.getElementById('lightboxClose');
  if (closeBtn) closeBtn.focus();
}

function closeLightbox() {
  const lightbox = document.getElementById('lightbox');
  lightbox.classList.remove('active');
  document.body.style.overflow = '';

  // Remove scoped keyboard listener
  if (lightboxKeyHandler) {
    document.removeEventListener('keydown', lightboxKeyHandler);
    lightboxKeyHandler = null;
  }

  // Remove resize listener
  if (lightboxResizeHandler) {
    window.removeEventListener('resize', lightboxResizeHandler);
    lightboxResizeHandler = null;
  }

  // Return focus to the card that triggered the lightbox
  if (gallery.triggerElement) {
    gallery.triggerElement.focus();
    gallery.triggerElement = null;
  }
}

/**
 * Trap focus inside the lightbox
 */
function trapFocus(e) {
  const focusables = getLightboxFocusables();
  if (focusables.length === 0) return;

  const first = focusables[0];
  const last = focusables[focusables.length - 1];

  if (e.shiftKey) {
    if (document.activeElement === first) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

function navigateLightbox(direction) {
  const newIndex = gallery.currentIndex + direction;

  if (newIndex >= 0 && newIndex < gallery.photos.length) {
    openLightbox(newIndex);
  } else if (newIndex < 0) {
    openLightbox(gallery.photos.length - 1);
  } else {
    openLightbox(0);
  }
}

/**
 * Gallery search - searches across all EXIF fields
 */
function initGallerySearch() {
  const searchInput = document.getElementById('gallerySearch');

  if (!searchInput) return;

  const performSearch = debounce((query) => {
    const normalizedQuery = query.toLowerCase().trim();
    const cards = document.querySelectorAll('.photo-card');
    let visibleCount = 0;

    cards.forEach((card) => {
      const index = parseInt(card.dataset.index, 10);
      const photo = gallery.photos[index];
      if (!photo) return;
      if (card.classList.contains('photo-card--broken')) return;

      if (!normalizedQuery) {
        card.classList.remove('search-hidden');
        visibleCount++;
        return;
      }

      const searchFields = [
        photo.title,
        photo.filename,
        photo.exif?.camera,
        photo.exif?.lens,
        photo.exif?.iso ? `ISO ${photo.exif.iso}` : '',
        photo.exif?.aperture ? `f/${photo.exif.aperture}` : '',
        photo.exif?.focalLength ? `${photo.exif.focalLength}mm` : '',
        photo.exif?.shutter ? `${photo.exif.shutter}s` : '',
        photo.exif?.date
      ].filter(Boolean).join(' ').toLowerCase();

      if (searchFields.includes(normalizedQuery)) {
        card.classList.remove('search-hidden');
        visibleCount++;
      } else {
        card.classList.add('search-hidden');
      }
    });

    const countEl = document.getElementById('photoCount');
    if (countEl) countEl.textContent = String(visibleCount);
  }, 200);

  searchInput.addEventListener('input', (e) => {
    performSearch(e.target.value);
  });
}

/**
 * Touch swipe support for lightbox on mobile
 */
function initLightboxSwipe() {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox) return;

  let touchStartX = 0;
  let touchEndX = 0;

  lightbox.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  lightbox.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > 50) {
      if (diff > 0) {
        navigateLightbox(1);
      } else {
        navigateLightbox(-1);
      }
    }
  }, { passive: true });
}
