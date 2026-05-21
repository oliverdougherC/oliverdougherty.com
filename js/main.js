/**
 * Oliver Unified main JavaScript (shared)
 * Handles navigation, scroll animations, smooth scroll, and portal glow.
 * Loaded on all pages as the shared base.
 *
 * Wrapped in IIFE to avoid polluting global scope.
 * Intentionally exposed on window: revealNavDot, revealDeferredElements
 * (used by page-specific scripts such as gallery.js).
 */
(function () {
  'use strict';

  const DOUGHERTY_BLUEPRINT_SEQUENCE_MS = 7400;
  let confettiFired = false;

  /**
   * Reveal the nav dot with a fade-in (opacity only, no transform).
   * Exposed globally for use by page-specific scripts (e.g. gallery.js).
   */
  function revealNavDot() {
    const navDot = document.getElementById('navToggle');
    if (!navDot) return;
    navDot.style.pointerEvents = 'auto';
    navDot.style.transition = 'opacity 2s cubic-bezier(0.19, 1, 0.22, 1)';
    navDot.style.opacity = '1';
  }

  /**
   * Reveal all .hero-deferred elements by adding .is-visible.
   * Exposed globally for use by page-specific scripts (e.g. gallery.js).
   */
  function revealDeferredElements() {
    document.querySelectorAll('.hero-deferred:not(.is-visible)').forEach((el) => {
      el.classList.add('is-visible');
    });
  }

  // Expose for use by page-specific scripts
  window.revealNavDot = revealNavDot;
  window.revealDeferredElements = revealDeferredElements;

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
      const lengthJitter = Math.random() * 8 - 2; // slightly overshoot or undershoot lines
      line.style.setProperty('--line-length', `${length + lengthJitter}px`);
      line.style.setProperty('--line-delay', `${Math.max(0, delayMs)}ms`);
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

    const measureCharacters = (wordText, box) => {
      const textNode = Array.from(finalWord.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
      if (!textNode || textNode.textContent.length < wordText.length) {
        const fallbackWidth = box.width / wordText.length;
        return Array.from(wordText, (char, index) => ({
          char,
          x: fallbackWidth * index,
          width: fallbackWidth
        }));
      }

      return Array.from(wordText, (char, index) => {
        const range = document.createRange();
        range.setStart(textNode, index);
        range.setEnd(textNode, index + 1);
        const rect = range.getBoundingClientRect();
        range.detach();

        return {
          char,
          x: Math.round((rect.left - box.left) * 100) / 100,
          width: Math.round(rect.width * 100) / 100
        };
      });
    };

    const renderOverlay = () => {
      if (title.classList.contains('is-blueprint-complete')) return;

      const box = finalWord.getBoundingClientRect();
      let textBox = box;
      try {
        const range = document.createRange();
        range.selectNodeContents(finalWord);
        textBox = range.getBoundingClientRect();
        range.detach();
      } catch (error) {
        textBox = box;
      }

      const textOffsetY = Math.round((textBox.top - box.top) * 100) / 100;
      const width = Math.round(box.width * 100) / 100;
      const height = Math.round(box.height * 100) / 100;
      if (width <= 0 || height <= 0) return;

      const wordStyle = window.getComputedStyle(finalWord);
      const characters = measureCharacters(word, box);
      const signature = [
        textOffsetY,
        width,
        height,
        wordStyle.fontSize,
        wordStyle.letterSpacing,
        characters.map(({ x, width: characterWidth }) => `${x}:${characterWidth}`).join(',')
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
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('width', width);
      svg.setAttribute('height', height);
      svg.style.left = '0';
      svg.style.top = '0';
      svg.style.width = `${width}px`;
      svg.style.height = `${height}px`;

      const layer = createSvgElement('g', { class: 'blueprint-drafting-layer' });
      const grid = createSvgElement('g', { class: 'blueprint-grid' });
      const outline = createSvgElement('g', { class: 'blueprint-outline' });

      const railInset = 0.75;
      const top = railInset;
      const cap = height * 0.26;
      const center = height * 0.55;
      const lowerGuide = height * 0.82;
      const bottom = height - railInset;
      const cellWidth = width / word.length;

      for (let index = 0; index <= word.length; index += 1) {
        const x = cellWidth * index;
        addLine(grid, 'blueprint-grid-line--major', x, top, x, bottom, index * 26 + (Math.random() * 40 - 20));
        if (index < word.length) {
          addLine(grid, 'blueprint-grid-line--minor', x + cellWidth / 2, cap, x + cellWidth / 2, lowerGuide, 130 + index * 20 + (Math.random() * 40 - 20));
        }
      }

      addLine(grid, 'blueprint-grid-line--rail', 0, top, width, top, 40 + (Math.random() * 30 - 15));
      addLine(grid, 'blueprint-grid-line--rail', 0, bottom, width, bottom, 120 + (Math.random() * 30 - 15));
      addLine(grid, 'blueprint-grid-line--center', 0, center, width, center, 240 + (Math.random() * 30 - 15));
      addLine(grid, 'blueprint-grid-line--minor', 0, cap, width, cap, 300 + (Math.random() * 30 - 15));
      addLine(grid, 'blueprint-grid-line--minor', 0, lowerGuide, width, lowerGuide, 360 + (Math.random() * 30 - 15));

      const baseLetterTiming = [
        { delay: 0, duration: 2500, dash: 4.8 },
        { delay: 430, duration: 2300, dash: 4.4 },
        { delay: 850, duration: 2200, dash: 4.2 },
        { delay: 1220, duration: 2400, dash: 4.8 },
        { delay: 1650, duration: 2100, dash: 4.2 },
        { delay: 2010, duration: 2050, dash: 4.0 },
        { delay: 2350, duration: 2200, dash: 4.3 },
        { delay: 2760, duration: 1800, dash: 3.6 },
        { delay: 3100, duration: 1900, dash: 3.8 },
        { delay: 3520, duration: 1150, dash: 2.2 }
      ];

      const getLetterTiming = (index, total) => {
        if (total <= 1 || total === baseLetterTiming.length) {
          return baseLetterTiming[index] || baseLetterTiming[baseLetterTiming.length - 1];
        }

        const position = index / (total - 1);
        const mappedIndex = position * (baseLetterTiming.length - 1);
        const lowerIndex = Math.floor(mappedIndex);
        const upperIndex = Math.min(baseLetterTiming.length - 1, lowerIndex + 1);
        const blend = mappedIndex - lowerIndex;
        const lower = baseLetterTiming[lowerIndex];
        const upper = baseLetterTiming[upperIndex];

        return {
          delay: lower.delay + (upper.delay - lower.delay) * blend,
          duration: lower.duration + (upper.duration - lower.duration) * blend,
          dash: lower.dash + (upper.dash - lower.dash) * blend
        };
      };

      characters.forEach(({ char, x, width: characterWidth }, index) => {
        const timing = getLetterTiming(index, characters.length);
        const randomizedDelay = Math.max(0, timing.delay + (Math.random() * 80 - 40));
        const randomizedDuration = timing.duration + (Math.random() * 400 - 200);

        const outlineText = createSvgElement('text', {
          class: 'blueprint-outline-text',
          x,
          y: textOffsetY
        });
        outlineText.style.setProperty('--letter-step', `${randomizedDelay}ms`);
        outlineText.style.setProperty('--letter-duration', `${randomizedDuration}ms`);
        outlineText.style.setProperty('--letter-dash', `${timing.dash}em`);
        outlineText.style.setProperty('--letter-nearly-complete', `${timing.dash * 0.13}em`);
        outlineText.textContent = char;
        outline.appendChild(outlineText);
      });

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

    let overlayFrame = 0;
    const scheduleRenderOverlay = () => {
      if (overlayFrame) return;
      overlayFrame = window.requestAnimationFrame(() => {
        overlayFrame = 0;
        renderOverlay();
      });
    };

    renderOverlay();
    if (document.fonts?.ready) {
      document.fonts.ready.then(scheduleRenderOverlay).catch((error) => {
        console.warn('Blueprint wordmark font readiness failed; rendering with fallback metrics:', error);
        // Re-render immediately with whatever metrics are available so the wordmark
        // still displays even if the font promise rejects.
        scheduleRenderOverlay();
      });
    }

    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(scheduleRenderOverlay);
      observer.observe(finalWord);
      window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
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
    let navScrollFrame = 0;
    const syncNavScrollState = () => {
      if (!nav) return;
      nav.classList.toggle('scrolled', window.scrollY > 50);
    };
    const scheduleNavScrollState = () => {
      if (navScrollFrame) return;
      navScrollFrame = window.requestAnimationFrame(() => {
        navScrollFrame = 0;
        syncNavScrollState();
      });
    };

    if (navToggle && navOverlay) {
      const openingDurationMs = prefersReducedMotion() ? 0 : 280;
      let openingTimer = null;
      let previouslyFocusedElement = null;
      const isMenuOpen = () => navOverlay.classList.contains('active');
      const getOverlayFocusables = () => Array.from(navOverlay.querySelectorAll(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter((element) => {
        const style = window.getComputedStyle(element);
        return !element.hasAttribute('hidden') && style.display !== 'none' && style.visibility !== 'hidden';
      });

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
          const label = isOpen ? 'Close menu' : 'Open menu';
          navToggle.setAttribute('aria-label', label);
          const visibleLabel = navToggle.querySelector('[data-nav-toggle-label]');
          if (visibleLabel) visibleLabel.textContent = label;
        }

        if (isOpen && opening) {
          previouslyFocusedElement = document.activeElement;
          startOpeningState();
          window.setTimeout(() => {
            getOverlayFocusables()[0]?.focus();
          }, openingDurationMs);
        } else {
          clearOpeningState();
          if (!isOpen) {
            const focusTarget = previouslyFocusedElement && document.contains(previouslyFocusedElement)
              ? previouslyFocusedElement
              : navToggle;
            if (document.activeElement && navOverlay.contains(document.activeElement)) {
              focusTarget.focus?.();
            }
            previouslyFocusedElement = null;
          }
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
        if (!isMenuOpen()) return;
        if (event.key === 'Escape') {
          closeMobileNav();
          return;
        }

        if (event.key === 'Tab') {
          const focusables = getOverlayFocusables();
          if (!focusables.length) {
            event.preventDefault();
            navToggle.focus();
            return;
          }

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
      window.addEventListener('scroll', scheduleNavScrollState, { passive: true });
    }
  }

  /**
   * Home hero: keep the top bar off-screen until the DOUGHERTY blueprint finishes,
   * or until the user scrolls past the wordmark (animations jump to the end, then the bar slides in).
   *
   * Timing:
   *   - Nav dot fades in at ~50% of the blueprint sequence (~3.7s)
   *   - Deferred elements (corners, below-fold) fade in when the blueprint completes (~7.4s)
   *   - If user scrolls past the hero, everything reveals immediately
   */
  function initHeroNavReveal() {
    if (!document.body.classList.contains('page-home')) return;

    const blueprint = document.querySelector('.blueprint-title');
    if (!blueprint) return;

    if (prefersReducedMotion()) {
      document.body.classList.add('dougherty-nav-revealed');
      revealNavDot();
      revealDeferredElements();
      return;
    }

    let revealTimer = null;
    let navDotTimer = null;
    let revealed = false;
    const DOUGHERTY_SEQUENCE_MS = DOUGHERTY_BLUEPRINT_SEQUENCE_MS;
    const NAV_DOT_REVEAL_MS = Math.round(DOUGHERTY_SEQUENCE_MS * 0.5);

    const finishBlueprintAnimations = () => {
      const root = document.querySelector('.blueprint-title');
      if (!root) return;
      if (typeof Element === 'undefined' || !Element.prototype.getAnimations) {
        root.classList.add('is-blueprint-complete');
        return;
      }
      const animations = root.getAnimations({ subtree: true });
      for (const anim of animations) {
        if (anim.playState === 'finished') continue;
        try {
          anim.finish();
        } catch (error) {
          console.debug('Unable to finish blueprint animation:', error);
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
      if (navDotTimer !== null) {
        window.clearTimeout(navDotTimer);
        navDotTimer = null;
      }
      document.body.classList.add('dougherty-nav-revealed');
      revealNavDot();
      revealDeferredElements();
      window.removeEventListener('scroll', onScrollMaybePastDougherty, { passive: true });
    };

    // rAF-throttled scroll handler to avoid calling getBoundingClientRect on every scroll event.
    let scrollFrame = 0;
    const onScrollMaybePastDougherty = () => {
      if (scrollFrame) return;
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0;
        if (blueprint.getBoundingClientRect().bottom < 0) {
          finishBlueprintAnimations();
          reveal();
        }
      });
    };

    window.addEventListener('scroll', onScrollMaybePastDougherty, { passive: true });

    // Nav dot fades in at ~50% of the animation
    navDotTimer = window.setTimeout(revealNavDot, NAV_DOT_REVEAL_MS);

    // Everything else reveals when the blueprint completes
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
   * Smooth scroll for anchor links.
   * Uses a CSS class (.smooth-scroll-target) instead of inline scrollMarginTop
   * to avoid forced reflows and residual styles.
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

          if (prefersReducedMotion()) {
            const targetPosition = target.getBoundingClientRect().top + window.scrollY - targetOffset;
            window.scrollTo(0, targetPosition);
          } else {
            // Temporarily add a CSS class that provides the scroll-margin-top offset,
            // then remove it after the scroll animation completes.
            if (!scrollMarginTop && targetOffset > 0) {
              target.classList.add('smooth-scroll-target');
              target.style.setProperty('--smooth-scroll-offset', `${targetOffset}px`);
            }

            target.scrollIntoView({ behavior: 'smooth', block: 'start' });

            if (!scrollMarginTop && targetOffset > 0) {
              window.setTimeout(() => {
                target.classList.remove('smooth-scroll-target');
                target.style.removeProperty('--smooth-scroll-offset');
              }, prefersReducedMotion() ? 0 : 1200);
            }
          }
        }
      });
    });
  }

  /**
   * Utility: Debounce function
   */
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
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

  /**
   * OSU stat hover: orange confetti emanates from the OSU text once per page load.
   */
  function initOsuConfetti() {
    if (prefersReducedMotion()) return;

    const osuText = document.querySelector('.osu-text');
    if (!osuText) return;

    const trigger = osuText.closest('.stat-value');
    if (!trigger) return;

    window.addEventListener('pageshow', (event) => {
      const navEntry = performance.getEntriesByType?.('navigation')?.[0];
      if (event.persisted || navEntry?.type === 'back_forward') {
        confettiFired = false;
      }
    });

    const colors = ['#d73f09', '#FF6700', '#ff8c42', '#000000'];

    const createCanvas = () => {
      const canvas = document.createElement('canvas');
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      canvas.style.position = 'fixed';
      canvas.style.top = '0';
      canvas.style.left = '0';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.pointerEvents = 'none';
      canvas.style.zIndex = '100';
      document.body.appendChild(canvas);
      return { canvas, ctx: canvas.getContext('2d'), dpr };
    };

    const createParticles = (originX, originY) => {
      const count = 100 + Math.floor(Math.random() * 41); // 100-140
      const particles = [];
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 6 - Math.random() * (2 * Math.PI / 3); // -30deg to -150deg
        const velocity = 3 + Math.random() * 9;
        particles.push({
          x: originX,
          y: originY,
          vx: Math.cos(angle) * velocity,
          vy: Math.sin(angle) * velocity,
          size: 4 + Math.random() * 6,
          color: colors[Math.floor(Math.random() * colors.length)],
          alpha: 1,
          decay: 0.008 + Math.random() * 0.018,
          gravity: 0.12 + Math.random() * 0.12
        });
      }
      return particles;
    };

    const fireConfetti = () => {
      if (confettiFired) return;
      confettiFired = true;

      const rect = trigger.getBoundingClientRect();
      const originX = rect.left + rect.width / 2;
      const originY = rect.top + rect.height / 2;

      const { canvas, ctx, dpr } = createCanvas();
      const particles = createParticles(originX * dpr, originY * dpr);

      let animationId;

      const render = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let alive = false;

        for (const p of particles) {
          if (p.alpha <= 0) continue;
          alive = true;
          p.x += p.vx;
          p.y += p.vy;
          p.vy += p.gravity;
          p.alpha -= p.decay;

          ctx.globalAlpha = Math.max(0, p.alpha);
          ctx.fillStyle = p.color;
          ctx.fillRect(p.x, p.y, p.size * dpr, p.size * dpr);
        }

        ctx.globalAlpha = 1;

        if (alive) {
          animationId = requestAnimationFrame(render);
        } else {
          cancelAnimationFrame(animationId);
          canvas.remove();
        }
      };

      animationId = requestAnimationFrame(render);
      trigger.removeEventListener('mouseenter', fireConfetti);
    };

    trigger.addEventListener('mouseenter', fireConfetti);
  }

  // --- Initialization ---
  document.addEventListener('DOMContentLoaded', () => {
    initMotionPreference();
    initNavigation();
    initBlueprintWordmark();
    initHeroNavReveal();
    initDeferredImages();
    initScrollAnimations();
    initSmoothScroll();
    initPortalGlow();
    initOsuConfetti();
  });
})();
