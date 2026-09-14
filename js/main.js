/**
 * Oliver Unified main JavaScript (shared)
 * Handles scroll animations, smooth scroll, and flashlight mode.
 * Loaded on all pages as the shared base.
 *
 * Wrapped in IIFE to avoid polluting global scope.
 * Intentionally exposed on window: revealDeferredElements
 * (used by page-specific scripts such as gallery.js).
 */
(function () {
  'use strict';

  let confettiFired = false;
  const FLASHLIGHT_MODE_STORAGE_KEY = 'od-flashlight-mode';
  const FLASHLIGHT_BATTERY_SESSION_KEY = 'od-flashlight-battery';
  const FLASHLIGHT_POINTER_SESSION_KEY = 'od-flashlight-pointer';
  const FLASHLIGHT_MODE_ON = 'on';
  const FLASHLIGHT_MODE_OFF = 'off';

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

  function isFlashlightTargetPage() {
    if (
      document.body.classList.contains('page-home')
      || document.body.classList.contains('page-resume')
      || document.body.classList.contains('page-gallery')
    ) {
      return true;
    }

    const normalizedPath = window.location.pathname.replace(/\/index\.html$/, '/');
    return normalizedPath === '/'
      || normalizedPath.endsWith('/pages/resume/')
      || normalizedPath.endsWith('/pages/gallery/');
  }

  function isFlashlightModeAvailable() {
    if (!window.matchMedia) return false;
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return false;
    if (window.matchMedia('(forced-colors: active)').matches) return false;
    if (prefersReducedMotion()) return false;
    return true;
  }

  function readStoredFlashlightMode() {
    try {
      return window.localStorage.getItem(FLASHLIGHT_MODE_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function persistFlashlightMode(enabled) {
    try {
      window.localStorage.setItem(
        FLASHLIGHT_MODE_STORAGE_KEY,
        enabled ? FLASHLIGHT_MODE_ON : FLASHLIGHT_MODE_OFF
      );
    } catch {
      // Intentionally ignored: localStorage may be unavailable in some contexts.
    }
  }

  function initFlashlightMode() {
    if (!isFlashlightTargetPage()) return;

    const modeToggleButton = document.querySelector('[data-flashlight-toggle]');
    if (!(modeToggleButton instanceof HTMLButtonElement)) return;

    const FLASHLIGHT_DRAIN_MS = 60000;
    const FLASHLIGHT_FINAL_FLICKER_MS = 900;
    const FLASHLIGHT_FINAL_FADE_MS = 850;
    const FLASHLIGHT_MIN_FLICKER_GAP_MS = 450;
    const FLASHLIGHT_FLICKER_GAP_RANGE_MS = 2200;
    const FLASHLIGHT_MIN_FLICKER_BURST_MS = 260;
    const FLASHLIGHT_FLICKER_BURST_RANGE_MS = 480;
    const FLASHLIGHT_MIN_FLICKER_PULSE_MS = 24;
    const FLASHLIGHT_FLICKER_PULSE_RANGE_MS = 68;
    const root = document.documentElement;

    let modeEnabled = false;
    let modeActive = false;
    let lastPointerPosition = null;
    let animationFrameId = 0;
    let lastBatteryFrameTime = null;
    let batteryRemainingMs = FLASHLIGHT_DRAIN_MS;
    let nextFlickerAt = 0;
    let flickerUntil = 0;
    let nextFlickerPulseAt = 0;
    let finalFlickerStartedAt = null;
    let finalFadeStartedAt = null;
    let lastBatteryPercent = -1;
    let lastBatterySegmentCount = -1;
    let currentCoverOpacity = '';
    let currentFlicker = '';
    let currentBeamOpacity = '';
    let hudElement = null;
    let hudPercentage = null;
    let hudSegments = [];

    const setCoverOpacity = (value) => {
      const nextValue = Math.max(0, Math.min(1, value)).toFixed(3);
      if (nextValue === currentCoverOpacity) return;
      currentCoverOpacity = nextValue;
      root.style.setProperty('--flashlight-cover-opacity', nextValue);
    };

    const setFlicker = (value) => {
      const nextValue = Math.max(0, Math.min(1, value)).toFixed(3);
      if (nextValue === currentFlicker) return;
      currentFlicker = nextValue;
      root.style.setProperty('--flashlight-flicker', nextValue);
    };

    const setBeamOpacity = (value) => {
      const nextValue = Math.max(0, Math.min(1, value)).toFixed(3);
      if (nextValue === currentBeamOpacity) return;
      currentBeamOpacity = nextValue;
      root.style.setProperty('--flashlight-beam-opacity', nextValue);
    };

    const resetEffectVars = () => {
      setCoverOpacity(0);
      setFlicker(1);
      setBeamOpacity(1);
    };

    const clampBatteryRemaining = (value) => {
      if (!Number.isFinite(value)) return FLASHLIGHT_DRAIN_MS;
      return Math.max(0, Math.min(FLASHLIGHT_DRAIN_MS, value));
    };

    const isReloadNavigation = () => {
      const navigationEntry = window.performance
        ?.getEntriesByType
        ?.('navigation')
        ?.[0];

      if (navigationEntry?.type === 'reload') return true;
      return window.performance?.navigation?.type === 1;
    };

    const readStoredBatteryRemaining = () => {
      if (isReloadNavigation()) {
        try {
          window.sessionStorage.removeItem(FLASHLIGHT_BATTERY_SESSION_KEY);
        } catch {
          // Intentionally ignored: sessionStorage may be unavailable in some contexts.
        }
        return FLASHLIGHT_DRAIN_MS;
      }

      try {
        const storedBatteryRemaining = window.sessionStorage.getItem(FLASHLIGHT_BATTERY_SESSION_KEY);
        if (storedBatteryRemaining === null) return FLASHLIGHT_DRAIN_MS;
        return clampBatteryRemaining(Number(storedBatteryRemaining));
      } catch {
        return FLASHLIGHT_DRAIN_MS;
      }
    };

    const persistBatteryRemaining = () => {
      try {
        window.sessionStorage.setItem(
          FLASHLIGHT_BATTERY_SESSION_KEY,
          String(Math.round(clampBatteryRemaining(batteryRemainingMs)))
        );
      } catch {
        // Intentionally ignored: sessionStorage may be unavailable in some contexts.
      }
    };
    const persistPointerPosition = (pointerPosition) => {
      try {
        window.sessionStorage.setItem(
          FLASHLIGHT_POINTER_SESSION_KEY,
          `${Math.round(pointerPosition.x)},${Math.round(pointerPosition.y)}`
        );
      } catch {
        // Intentionally ignored: sessionStorage may be unavailable in some contexts.
      }
    };

    const readStoredPointerPosition = () => {
      try {
        const storedPointerPosition = window.sessionStorage.getItem(FLASHLIGHT_POINTER_SESSION_KEY);
        if (storedPointerPosition === null) return null;

        const separatorIndex = storedPointerPosition.indexOf(',');
        if (separatorIndex <= 0 || separatorIndex === storedPointerPosition.length - 1) {
          return null;
        }

        const x = Number(storedPointerPosition.slice(0, separatorIndex));
        const y = Number(storedPointerPosition.slice(separatorIndex + 1));
        if (
          !Number.isFinite(x)
          || !Number.isFinite(y)
          || x < 0
          || y < 0
          || x > window.innerWidth
          || y > window.innerHeight
        ) {
          return null;
        }

        return { x, y };
      } catch {
        return null;
      }
    };


    const resolveInitialStoredMode = () => {
      if (!isReloadNavigation()) return readStoredFlashlightMode();
      persistFlashlightMode(false);
      return FLASHLIGHT_MODE_OFF;
    };

    const setPointerPosition = (clientX, clientY) => {
      root.style.setProperty('--flashlight-x', `${clientX}px`);
      root.style.setProperty('--flashlight-y', `${clientY}px`);
    };

    const readPointerPosition = (event) => {
      if (
        !event
        || typeof event.clientX !== 'number'
        || typeof event.clientY !== 'number'
        || !Number.isFinite(event.clientX)
        || !Number.isFinite(event.clientY)
      ) {
        return null;
      }

      if (
        event.type === 'click'
        && event.detail === 0
        && event.clientX === 0
        && event.clientY === 0
      ) {
        return null;
      }

      return { x: event.clientX, y: event.clientY };
    };

    const rememberPointerPosition = (event) => {
      const pointerPosition = readPointerPosition(event);
      if (!pointerPosition) return null;
      lastPointerPosition = pointerPosition;
      persistPointerPosition(pointerPosition);
      return pointerPosition;
    };

    const resolveActivationPosition = (event) => {
      return rememberPointerPosition(event) || lastPointerPosition || readStoredPointerPosition();
    };

    const syncToggleLabel = () => {
      const visibleLabel = modeToggleButton.querySelector(modeEnabled ? '.lights-on-label' : '.lights-off-label');
      const action = modeEnabled ? 'Disable blackout mode' : 'Enable blackout mode';
      const nextAction = visibleLabel ? `${visibleLabel.textContent.trim()}: ${action}` : action;
      modeToggleButton.setAttribute('aria-label', nextAction);
      modeToggleButton.setAttribute('aria-pressed', String(modeEnabled));
      modeToggleButton.dataset.mode = modeEnabled ? FLASHLIGHT_MODE_ON : FLASHLIGHT_MODE_OFF;
      modeToggleButton.title = nextAction;
    };

    const createHud = () => {
      if (hudElement) return;

      hudElement = document.createElement('div');
      hudElement.className = 'flashlight-hud';
      hudElement.setAttribute('aria-hidden', 'true');
      hudElement.innerHTML = `
        <div class="flashlight-hud__readout">
          <span class="flashlight-hud__label">Power left</span>
          <span class="flashlight-hud__percent" data-flashlight-power-value>100%</span>
        </div>
        <div class="flashlight-hud__battery" aria-hidden="true">
          <span class="flashlight-hud__segment"></span>
          <span class="flashlight-hud__segment"></span>
          <span class="flashlight-hud__segment"></span>
          <span class="flashlight-hud__segment"></span>
          <span class="flashlight-hud__segment"></span>
        </div>
      `;
      hudPercentage = hudElement.querySelector('[data-flashlight-power-value]');
      hudSegments = Array.from(hudElement.querySelectorAll('.flashlight-hud__segment'));
      document.body.appendChild(hudElement);
    };

    const updateHud = (percent) => {
      const nextPercent = Math.max(0, Math.min(100, Math.round(percent)));
      if (nextPercent === lastBatteryPercent) return;

      lastBatteryPercent = nextPercent;
      root.style.setProperty('--flashlight-power', `${nextPercent}%`);

      if (hudPercentage) {
        hudPercentage.textContent = `${nextPercent}%`;
      }

      if (hudElement) {
        let powerState = 'ok';
        if (nextPercent === 0) {
          powerState = 'empty';
        } else if (nextPercent <= 15) {
          powerState = 'critical';
        } else if (nextPercent <= 35) {
          powerState = 'low';
        }
        hudElement.dataset.powerState = powerState;
      }

      const activeSegmentCount = Math.ceil(nextPercent / 20);
      if (activeSegmentCount === lastBatterySegmentCount) return;

      lastBatterySegmentCount = activeSegmentCount;
      hudSegments.forEach((segment, index) => {
        segment.classList.toggle('is-active', index < activeSegmentCount);
      });
    };

    const stopBatteryLoop = () => {
      if (!animationFrameId) return;
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    };

    const queueBatteryFrame = () => {
      animationFrameId = window.requestAnimationFrame(handleBatteryFrame);
    };

    const scheduleNextFlicker = (timestamp) => {
      nextFlickerAt = timestamp
        + FLASHLIGHT_MIN_FLICKER_GAP_MS
        + (Math.random() * FLASHLIGHT_FLICKER_GAP_RANGE_MS);
    };

    const scheduleNextFlickerPulse = (timestamp) => {
      nextFlickerPulseAt = timestamp
        + FLASHLIGHT_MIN_FLICKER_PULSE_MS
        + (Math.random() * FLASHLIGHT_FLICKER_PULSE_RANGE_MS);
    };

    const nextFlickerIntensity = () => {
      if (Math.random() < 0.22) {
        return 0.74 + (Math.random() * 0.22);
      }
      return 0.28 + (Math.random() * 0.42);
    };

    const updateActiveFlicker = (timestamp) => {
      if (nextFlickerAt === 0) {
        scheduleNextFlicker(timestamp);
      }

      if (timestamp >= nextFlickerAt) {
        flickerUntil = timestamp
          + FLASHLIGHT_MIN_FLICKER_BURST_MS
          + (Math.random() * FLASHLIGHT_FLICKER_BURST_RANGE_MS);
        nextFlickerPulseAt = 0;
        scheduleNextFlicker(timestamp + (Math.random() * FLASHLIGHT_FLICKER_GAP_RANGE_MS));
      }

      if (timestamp < flickerUntil) {
        if (nextFlickerPulseAt === 0 || timestamp >= nextFlickerPulseAt) {
          const coverOpacity = nextFlickerIntensity();
          setCoverOpacity(coverOpacity);
          setFlicker(1 - coverOpacity);
          scheduleNextFlickerPulse(timestamp);
        }
        return;
      }

      setCoverOpacity(0);
      setFlicker(1);
    };

    const updateDepletedState = (timestamp) => {
      updateHud(0);

      if (finalFlickerStartedAt === null) {
        finalFlickerStartedAt = timestamp;
      }

      const flickerElapsed = timestamp - finalFlickerStartedAt;
      if (flickerElapsed < FLASHLIGHT_FINAL_FLICKER_MS) {
        const progress = flickerElapsed / FLASHLIGHT_FINAL_FLICKER_MS;
        const coverOpacity = Math.min(0.74, 0.18 + (progress * 0.32) + (Math.random() * 0.28));
        setCoverOpacity(coverOpacity);
        setFlicker(1 - coverOpacity);
        setBeamOpacity(1);
        return true;
      }

      if (finalFadeStartedAt === null) {
        finalFadeStartedAt = timestamp;
      }

      const fadeProgress = Math.min(1, (timestamp - finalFadeStartedAt) / FLASHLIGHT_FINAL_FADE_MS);
      const beamOpacity = 1 - fadeProgress;
      setBeamOpacity(beamOpacity);
      setFlicker(beamOpacity);
      setCoverOpacity(fadeProgress);
      return fadeProgress < 1;
    };

    function handleBatteryFrame(timestamp) {
      animationFrameId = 0;
      if (!modeEnabled) return;

      if (lastBatteryFrameTime === null) {
        lastBatteryFrameTime = timestamp;
        scheduleNextFlicker(timestamp);
      } else {
        batteryRemainingMs = clampBatteryRemaining(batteryRemainingMs - Math.max(0, timestamp - lastBatteryFrameTime));
        lastBatteryFrameTime = timestamp;
      }

      persistBatteryRemaining();

      if (batteryRemainingMs <= 0) {
        if (updateDepletedState(timestamp)) {
          queueBatteryFrame();
        }
        return;
      }

      updateHud((batteryRemainingMs / FLASHLIGHT_DRAIN_MS) * 100);
      setBeamOpacity(1);
      updateActiveFlicker(timestamp);
      queueBatteryFrame();
    }

    const startBatteryLoop = () => {
      stopBatteryLoop();
      lastBatteryFrameTime = null;
      nextFlickerAt = 0;
      flickerUntil = 0;
      nextFlickerPulseAt = 0;
      finalFlickerStartedAt = batteryRemainingMs <= 0 ? 0 : null;
      finalFadeStartedAt = batteryRemainingMs <= 0 ? 0 : null;
      lastBatteryPercent = -1;
      lastBatterySegmentCount = -1;
      resetEffectVars();
      updateHud((batteryRemainingMs / FLASHLIGHT_DRAIN_MS) * 100);

      if (batteryRemainingMs <= 0) {
        setCoverOpacity(1);
        setFlicker(0);
        setBeamOpacity(0);
        return;
      }

      queueBatteryFrame();
    };

    const activateModeAtPosition = (pointerPosition) => {
      setPointerPosition(pointerPosition.x, pointerPosition.y);
      createHud();
      root.setAttribute('data-flashlight-mode', FLASHLIGHT_MODE_ON);
      document.body.classList.add('flashlight-mode-active');

      if (modeActive) return;
      modeActive = true;
      startBatteryLoop();
    };

    const suspendActiveMode = (shouldPersistBattery = true) => {
      if (!modeActive) return;
      modeActive = false;
      stopBatteryLoop();
      if (shouldPersistBattery) {
        persistBatteryRemaining();
      }
      root.setAttribute('data-flashlight-mode', FLASHLIGHT_MODE_ON);
      document.body.classList.add('flashlight-mode-active');
      setCoverOpacity(1);
      setFlicker(0);
      setBeamOpacity(0);
    };

    function handlePointerMove(event) {
      const pointerPosition = rememberPointerPosition(event);
      if (!pointerPosition) return;

      if (modeEnabled && !modeActive) {
        activateModeAtPosition(pointerPosition);
        return;
      }

      if (modeActive) {
        setPointerPosition(pointerPosition.x, pointerPosition.y);
      }
    }

    function handlePointerInput(event) {
      const pointerPosition = rememberPointerPosition(event);
      if (!pointerPosition) return;

      if (modeEnabled && !modeActive) {
        activateModeAtPosition(pointerPosition);
        return;
      }

      if (modeActive) {
        setPointerPosition(pointerPosition.x, pointerPosition.y);
      }
    }

    const isViewportBoundaryEvent = (event) => {
      return event.relatedTarget === null && event.toElement === null;
    };

    function handleViewportExit(event) {
      if (!isViewportBoundaryEvent(event)) return;
      suspendActiveMode();
    }

    function handleViewportReentry(event) {
      if (!isViewportBoundaryEvent(event)) return;
      handlePointerInput(event);
    }
    function handleWindowBlur() {
      suspendActiveMode();
    }


    const startModeTracking = () => {
      window.addEventListener('pointermove', handlePointerMove, { passive: true });
      window.addEventListener('pointerdown', handlePointerInput, { passive: true });
      window.addEventListener('click', handlePointerInput, { passive: true });
      window.addEventListener('mouseout', handleViewportExit, { passive: true });
      window.addEventListener('mouseover', handleViewportReentry, { passive: true });
      window.addEventListener('blur', handleWindowBlur);
    };

    const stopModeTracking = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerdown', handlePointerInput);
      window.removeEventListener('click', handlePointerInput);
      window.removeEventListener('mouseout', handleViewportExit);
      window.removeEventListener('mouseover', handleViewportReentry);
      window.removeEventListener('blur', handleWindowBlur);
    };

    const clearMode = (shouldPersistBattery = true) => {
      stopModeTracking();
      stopBatteryLoop();
      modeActive = false;
      if (shouldPersistBattery) {
        persistBatteryRemaining();
      }
      root.removeAttribute('data-flashlight-mode');
      document.body.classList.remove('flashlight-mode-active');
      root.style.setProperty('--flashlight-x', '50vw');
      root.style.setProperty('--flashlight-y', '50vh');
      resetEffectVars();
    };
    if (!isFlashlightModeAvailable()) {
      clearMode(false);
      modeToggleButton.remove();
      return;
    }


    const applyMode = (enabled, event, options = {}) => {
      modeEnabled = Boolean(enabled);

      if (modeEnabled) {
        startModeTracking();
        const activationPosition = resolveActivationPosition(event);
        if (activationPosition) {
          activateModeAtPosition(activationPosition);
        } else {
          suspendActiveMode(false);
        }
      } else {
        clearMode(options.persistBattery !== false);
      }

      syncToggleLabel();
    };

    modeToggleButton.addEventListener('pointermove', rememberPointerPosition, { passive: true });
    modeToggleButton.addEventListener('pointerdown', rememberPointerPosition, { passive: true });

    batteryRemainingMs = readStoredBatteryRemaining();
    const storedMode = resolveInitialStoredMode();
    applyMode(storedMode === FLASHLIGHT_MODE_ON, undefined, { persistBattery: !isReloadNavigation() });

    modeToggleButton.addEventListener('click', (event) => {
      applyMode(!modeEnabled, event);
      persistFlashlightMode(modeEnabled);
    });

    window.addEventListener('pageshow', () => {
      if (!modeEnabled || modeActive) return;
      const activationPosition = lastPointerPosition || readStoredPointerPosition();
      if (activationPosition) {
        activateModeAtPosition(activationPosition);
      }
    });
  }

  /**
   * Scroll-triggered animations using Intersection Observer
   */
  function initScrollAnimations() {
    const animatedElements = document.querySelectorAll('[data-animate]');

    if (!animatedElements.length) return;

    if (prefersReducedMotion()) {
      animatedElements.forEach((el) => el.classList.add('visible'));
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
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, observerOptions);

    animatedElements.forEach(el => observer.observe(el));
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
   * OSU stat hover: orange confetti emanates from the OSU text once per page load.
   */
  function initOsuConfetti() {
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
      if (prefersReducedMotion() || confettiFired) return;
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
    if (trigger instanceof HTMLButtonElement) {
      trigger.addEventListener('click', (event) => {
        const cheering = trigger.getAttribute('aria-pressed') !== 'true';
        trigger.setAttribute('aria-pressed', String(cheering));
        trigger.classList.toggle('is-cheered', cheering);
        trigger.classList.toggle('keyboard-cheer', event.detail === 0);
        if (cheering && event.detail > 0) fireConfetti();
      });
    }
  }

  // --- Initialization ---
  document.addEventListener('DOMContentLoaded', () => {
    initMotionPreference();
    initFlashlightMode();
    initScrollAnimations();
    initSmoothScroll();
    initOsuConfetti();
  });
})();
