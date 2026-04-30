/**
 * Oliver Unified main JavaScript (shared)
 * Handles navigation, scroll animations, smooth scroll, and portal glow.
 * Loaded on all pages as the shared base.
 */

document.addEventListener('DOMContentLoaded', () => {
  initMotionPreference();
  initNavigation();
  initBlueprintWordmark();
  initHeroNavReveal();
  initDeferredImages();
  initScrollAnimations();
  initSmoothScroll();
  initPortalGlow();
});

const DOUGHERTY_BLUEPRINT_SEQUENCE_MS = 6600;

/**
 * Honor reduced-motion preference globally.
 */
function initMotionPreference() {
  if (prefersReducedMotion()) {
    document.documentElement.classList.add('reduced-motion');
  }
}

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function initBlueprintWordmark() {
  const title = document.querySelector('.blueprint-title');
  const finalWord = title?.querySelector('.blueprint-final-word');
  const svg = title?.querySelector('.blueprint-svg');

  if (!title || !finalWord || !svg) return;

  if (prefersReducedMotion()) {
    title.classList.add('is-blueprint-ready', 'is-blueprint-complete');
    return;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const word = finalWord.textContent?.trim() || 'DOUGHERTY.';
  let completionTimer = null;
  let lastSignature = '';

  const createSvgElement = (tagName, attributes = {}) => {
    const element = document.createElementNS(SVG_NS, tagName);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  };

  const setLineMetrics = (line, x1, y1, x2, y2, delayMs) => {
    const length = Math.hypot(x2 - x1, y2 - y1);
    line.style.setProperty('--line-length', `${length}px`);
    line.style.setProperty('--line-delay', `${delayMs}ms`);
  };

  const addLine = (group, className, x1, y1, x2, y2, delayMs) => {
    const line = createSvgElement('line', {
      class: `blueprint-grid-line ${className}`,
      x1,
      y1,
      x2,
      y2
    });
    setLineMetrics(line, x1, y1, x2, y2, delayMs);
    group.appendChild(line);
  };

  const renderOverlay = () => {
    if (title.classList.contains('is-blueprint-complete')) return;

    const box = finalWord.getBoundingClientRect();
    const width = Math.round(box.width * 100) / 100;
    const height = Math.round(box.height * 100) / 100;
    if (width <= 0 || height <= 0) return;

    const wordStyle = window.getComputedStyle(finalWord);
    const signature = [
      width,
      height,
      wordStyle.fontSize,
      wordStyle.letterSpacing
    ].join('|');

    if (signature === lastSignature && title.classList.contains('is-blueprint-ready')) {
      return;
    }

    lastSignature = signature;
    title.classList.remove('is-blueprint-complete');
    title.classList.add('is-blueprint-ready');
    title.style.setProperty('--blueprint-font-size', wordStyle.fontSize);
    title.style.setProperty('--blueprint-letter-spacing', wordStyle.letterSpacing);

    svg.replaceChildren();
    svg.removeAttribute('viewBox');
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    const clipId = `blueprint-word-reveal-${Math.round(width)}-${Math.round(height)}`;
    const defs = createSvgElement('defs');
    const clipPath = createSvgElement('clipPath', { id: clipId, clipPathUnits: 'userSpaceOnUse' });
    const revealRect = createSvgElement('rect', {
      class: 'blueprint-reveal-rect',
      x: 0,
      y: 0,
      width,
      height
    });
    clipPath.appendChild(revealRect);
    defs.appendChild(clipPath);
    svg.appendChild(defs);

    const layer = createSvgElement('g', { class: 'blueprint-drafting-layer' });
    const grid = createSvgElement('g', { class: 'blueprint-grid' });
    const outline = createSvgElement('g', { class: 'blueprint-outline' });

    const top = height * 0.04;
    const cap = height * 0.18;
    const center = height * 0.55;
    const baseline = height * 0.86;
    const bottom = height * 0.96;
    const cellWidth = width / word.length;

    for (let index = 0; index <= word.length; index += 1) {
      const x = cellWidth * index;
      addLine(grid, 'blueprint-grid-line--major', x, top, x, bottom, index * 26);
      if (index < word.length) {
        addLine(grid, 'blueprint-grid-line--minor', x + cellWidth / 2, cap, x + cellWidth / 2, baseline, 130 + index * 20);
      }
    }

    addLine(grid, 'blueprint-grid-line--rail', 0, top, width, top, 40);
    addLine(grid, 'blueprint-grid-line--rail', 0, baseline, width, baseline, 120);
    addLine(grid, 'blueprint-grid-line--center', 0, center, width, center, 240);
    addLine(grid, 'blueprint-grid-line--minor', 0, cap, width, cap, 300);
    addLine(grid, 'blueprint-grid-line--minor', 0, bottom, width, bottom, 360);

    for (let index = 0; index < word.length; index += 1) {
      const char = word[index];
      const outlineText = createSvgElement('text', {
        class: 'blueprint-outline-text',
        x: cellWidth * index,
        y: 0, // Will be aligned via dominant-baseline: text-before-edge and CSS
        'clip-path': `url(#${clipId})`
      });
      // Stagger letter sketching
      outlineText.style.setProperty('--letter-step', `${index * 160}ms`);
      outlineText.textContent = char;
      outline.appendChild(outlineText);
    }
    layer.appendChild(grid);
    layer.appendChild(outline);
    svg.appendChild(layer);

    if (completionTimer !== null) {
      window.clearTimeout(completionTimer);
    }
    completionTimer = window.setTimeout(() => {
      title.classList.add('is-blueprint-complete');
      completionTimer = null;
    }, DOUGHERTY_BLUEPRINT_SEQUENCE_MS);
  };

  renderOverlay();
  if (document.fonts?.ready) {
    document.fonts.ready.then(renderOverlay).catch(() => {});
  }

  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(renderOverlay);
    });
    observer.observe(finalWord);
  } else {
    window.addEventListener('resize', debounce(renderOverlay, 120));
  }
}

/**
 * Keep below-fold imagery out of the initial home-page load.
 */
function initDeferredImages() {
  const images = document.querySelectorAll('img[data-deferred-src]');
  if (!images.length) return;

  const loadImage = (image) => {
    const src = image.getAttribute('data-deferred-src');
    if (!src) return;

    image.src = src;
    image.removeAttribute('data-deferred-src');
  };

  if (!('IntersectionObserver' in window)) {
    images.forEach(loadImage);
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      loadImage(entry.target);
      observer.unobserve(entry.target);
    });
  }, {
    rootMargin: '80px 0px'
  });

  images.forEach((image) => observer.observe(image));
}

/**
 * Navigation functionality (Fullscreen Overlay)
 */
function initNavigation() {
  const nav = document.getElementById('nav');
  const navToggle = document.getElementById('navToggle');
  const navOverlay = document.getElementById('navOverlay');
  const navOverlayBg = navOverlay?.querySelector('.nav-overlay-bg');
  const syncNavScrollState = () => {
    if (!nav) return;
    nav.classList.toggle('scrolled', window.scrollY > 50);
  };

  if (navToggle && navOverlay) {
    const openingDurationMs = prefersReducedMotion() ? 0 : 280;
    let openingTimer = null;
    const isMenuOpen = () => navOverlay.classList.contains('active');

    const clearOpeningState = () => {
      if (openingTimer !== null) {
        window.clearTimeout(openingTimer);
        openingTimer = null;
      }
      navOverlay.classList.remove('opening');
    };

    const startOpeningState = () => {
      clearOpeningState();
      navOverlay.classList.add('opening');

      if (openingDurationMs === 0) {
        navOverlay.classList.remove('opening');
        return;
      }

      openingTimer = window.setTimeout(() => {
        navOverlay.classList.remove('opening');
        openingTimer = null;
      }, openingDurationMs);
    };

    const setNavState = (nextOpen, { opening = false } = {}) => {
      const isOpen = Boolean(nextOpen);
      navToggle.classList.toggle('active', isOpen);
      navOverlay.classList.toggle('active', isOpen);
      navToggle.setAttribute('aria-expanded', String(isOpen));
      navOverlay.setAttribute('aria-hidden', String(!isOpen));
      document.body.classList.toggle('nav-open', isOpen);
      if (navToggle.classList.contains('nav-dot')) {
        navToggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
      }

      if (isOpen && opening) {
        startOpeningState();
      } else {
        clearOpeningState();
      }
    };

    const closeMobileNav = () => {
      setNavState(false);
    };

    navToggle.addEventListener('click', () => {
      const shouldOpen = !isMenuOpen();
      setNavState(shouldOpen, { opening: shouldOpen });
    });

    // Close menu when clicking a link inside the overlay
    navOverlay.querySelectorAll('.nav-link, .footer-link').forEach(link => {
      link.addEventListener('click', closeMobileNav);
    });

    // Explicitly close when clicking the overlay background.
    navOverlayBg?.addEventListener('click', closeMobileNav);

    // Close when users click any non-interactive part of the open overlay.
    navOverlay.addEventListener('click', (event) => {
      if (!isMenuOpen()) return;
      if (event.target.closest('.nav-link, .footer-link, #navToggle, .theme-toggle, [data-theme-toggle]')) {
        return;
      }
      closeMobileNav();
    });

    // Allow keyboard users to close the overlay quickly.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isMenuOpen()) {
        closeMobileNav();
      }
    });

    // Defensively reset persisted nav state only for history/bfcache restores.
    window.addEventListener('pageshow', (event) => {
      const navEntry = performance.getEntriesByType?.('navigation')?.[0];
      const isHistoryRestore = Boolean(event?.persisted) || navEntry?.type === 'back_forward';
      if (isHistoryRestore) {
        closeMobileNav();
        syncNavScrollState();
      }
    });

    // Ensure we do not carry locked scroll if the document is hidden mid-transition.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        clearOpeningState();
      }
    });

    closeMobileNav();
  }

  // Scroll behavior for nav
  if (nav) {
    syncNavScrollState();
    window.addEventListener('scroll', syncNavScrollState, { passive: true });
  }
}

/**
 * Home hero: keep the top bar off-screen until the DOUGHERTY blueprint finishes,
 * or until the user scrolls past the wordmark (animations jump to the end, then the bar slides in).
 */
function initHeroNavReveal() {
  if (!document.body.classList.contains('page-home')) return;

  const blueprint = document.querySelector('.blueprint-title');
  if (!blueprint) return;

  if (prefersReducedMotion()) {
    document.body.classList.add('dougherty-nav-revealed');
    return;
  }

  let revealTimer = null;
  let revealed = false;
  const DOUGHERTY_SEQUENCE_MS = DOUGHERTY_BLUEPRINT_SEQUENCE_MS;

  const finishBlueprintAnimations = () => {
    if (typeof Element === 'undefined' || !Element.prototype.getAnimations) return;
    const root = document.querySelector('.blueprint-title');
    if (!root) return;
    const animations = root.getAnimations({ subtree: true });
    for (const anim of animations) {
      if (anim.playState === 'finished') continue;
      try {
        anim.finish();
      } catch {
        // Ignore unsupported or non-finite animations
      }
    }
    root.classList.add('is-blueprint-complete');
  };

  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (revealTimer !== null) {
      window.clearTimeout(revealTimer);
      revealTimer = null;
    }
    document.body.classList.add('dougherty-nav-revealed');
    window.removeEventListener('scroll', onScrollMaybePastDougherty, { passive: true });
  };

  const onScrollMaybePastDougherty = () => {
    if (blueprint.getBoundingClientRect().bottom < 0) {
      finishBlueprintAnimations();
      requestAnimationFrame(reveal);
    }
  };

  window.addEventListener('scroll', onScrollMaybePastDougherty, { passive: true });

  revealTimer = window.setTimeout(reveal, DOUGHERTY_SEQUENCE_MS);
}

/**
 * Scroll-triggered animations using Intersection Observer
 */
function initScrollAnimations() {
  const animatedElements = document.querySelectorAll('[data-animate]');
  const maskElements = document.querySelectorAll('.scroll-mask-wrap');

  if (!animatedElements.length && !maskElements.length) return;

  if (prefersReducedMotion()) {
    animatedElements.forEach((el) => el.classList.add('visible'));
    maskElements.forEach((el) => {
      const inner = el.querySelector('.mask-inner');
      if (inner) inner.style.transform = 'translateY(0)';
    });
    return;
  }

  const observerOptions = {
    root: null,
    rootMargin: '0px 0px -15% 0px',
    threshold: 0.1
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        if (entry.target.hasAttribute('data-animate')) {
          entry.target.classList.add('visible');
        } else if (entry.target.classList.contains('scroll-mask-wrap')) {
          const inner = entry.target.querySelector('.mask-inner');
          if (inner) inner.style.animationName = 'maskReveal';
        }
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  animatedElements.forEach(el => observer.observe(el));
  maskElements.forEach(el => {
    const inner = el.querySelector('.mask-inner');
    if (inner) inner.style.animationName = 'none'; // Pause until intersected
    observer.observe(el);
  });
}

/**
 * Smooth scroll for anchor links
 */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
      const href = this.getAttribute('href');

      if (href === '#') return;

      const target = document.querySelector(href);

      if (target) {
        e.preventDefault();

        const navHeight = document.querySelector('.nav')?.offsetHeight || 0;
        const scrollMarginTop = Number.parseFloat(window.getComputedStyle(target).scrollMarginTop) || 0;
        const fallbackOffset = navHeight + 20;
        const targetOffset = scrollMarginTop || fallbackOffset;
        const targetPosition = target.getBoundingClientRect().top + window.scrollY - targetOffset;

        if (prefersReducedMotion()) {
          window.scrollTo(0, targetPosition);
        } else {
          smoothScrollTo(targetPosition, 1200);
        }
      }
    });
  });
}

/**
 * Custom smooth scroll with eased duration
 */
function smoothScrollTo(targetY, duration) {
  if (prefersReducedMotion()) {
    window.scrollTo(0, targetY);
    return;
  }

  const startY = window.scrollY;
  const distance = targetY - startY;
  let startTime = null;

  function easeInOutCubic(t) {
    return t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function step(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = easeInOutCubic(progress);

    window.scrollTo(0, startY + distance * eased);

    if (progress < 1) {
      requestAnimationFrame(step);
    }
  }

  requestAnimationFrame(step);
}

/**
 * Utility: Debounce function
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Portal card cursor-following glow effect (landing page only)
 * Throttled with requestAnimationFrame to avoid excessive reflows
 */
function initPortalGlow() {
  const portalCards = document.querySelectorAll('.portal-card');

  if (!portalCards.length) return;
  if (prefersReducedMotion()) return;

  portalCards.forEach(card => {
    const portalBg = card.querySelector('.portal-bg');
    let rafPending = false;

    card.addEventListener('mousemove', (e) => {
      if (rafPending) return;
      rafPending = true;

      requestAnimationFrame(() => {
        const rect = card.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        card.style.setProperty('--mouse-x', `${x}px`);
        card.style.setProperty('--mouse-y', `${y}px`);
        rafPending = false;
      });
    });

    card.addEventListener('mouseleave', () => {
      if (portalBg) {
        portalBg.style.transition = 'opacity 400ms ease';
        portalBg.style.opacity = '0';
        setTimeout(() => {
          card.style.setProperty('--mouse-x', '50%');
          card.style.setProperty('--mouse-y', '50%');
          portalBg.style.transition = '';
          portalBg.style.opacity = '';
        }, 400);
      }
    });
  });
}
