/**
 * Oliver Dougherty - Main JavaScript (shared)
 * Handles navigation, scroll animations, smooth scroll, and portal glow.
 * Loaded on all pages as the shared base.
 */

document.addEventListener('DOMContentLoaded', () => {
  initMotionPreference();
  initNavigation();
  initScrollAnimations();
  initSmoothScroll();
  initPortalGlow();
});

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
