/**
 * Starfield Canvas Animation
 * Renders a performant, parallax starfield on a canvas element.
 * Includes stars and occasional comets.
 */
(function() {
  'use strict';

  const canvas = document.getElementById('starfield');
  if (!canvas) return;

  const ctx = canvas.getContext('2d', { alpha: false });
  let width, height;
  let stars = [];
  let comets = [];
  let animationFrameId = 0;
  let lastTimestamp = 0;
  let isHidden = document.hidden;
  let heavyUtilityActive = false;
  const activeLoadSources = new Set();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Configuration
  const BASE_STAR_COUNT = 500;
  const BASE_SPEED = 9; // px/sec at shallow depth
  const MAX_DPR = 1.5;
  const STAR_COLORS = [
    '#ffffff', // White
    '#e0f7fa', // Light blue
    '#fff3e0', // Light yellow
    '#fce4ec', // Light orange
    '#f3e5f5'  // Light pink
  ];

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;

    const dpr = resolveDpr();
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    reconcileSpace();
    draw();
  }

  function resolveDpr() {
    if (reducedMotion) {
      return 1;
    }
    return Math.min(window.devicePixelRatio || 1, MAX_DPR);
  }

  function resolveStarCount() {
    if (reducedMotion) {
      return Math.min(140, BASE_STAR_COUNT);
    }

    const areaScale = Math.max(0.45, Math.min(1.15, width * height / (1440 * 900)));
    const coreScale = (navigator.hardwareConcurrency || 4) <= 4 ? 0.72 : 1;
    return Math.round(BASE_STAR_COUNT * areaScale * coreScale);
  }

  function reconcileSpace() {
    const targetCount = resolveStarCount();
    while (stars.length < targetCount) {
      stars.push(createStar());
    }
    if (stars.length > targetCount) {
      stars.length = targetCount;
    }
    if (reducedMotion) {
      comets = [];
    }
  }

  function createStar() {
    const depth = Math.random();
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.max(0.5, depth * 2.5),
      speed: BASE_SPEED + (depth * BASE_SPEED * 2),
      color: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
      baseOpacity: 0.2 + (depth * 0.6),
      twinkleSpeed: 1.2 + (Math.random() * 3),
      twinklePhase: Math.random() * Math.PI * 2,
      drift: (Math.random() - 0.5) * 6
    };
  }

  function spawnComet() {
    const isLeftToRight = Math.random() > 0.5;
    return {
      x: isLeftToRight ? -50 : width + 50,
      y: Math.random() * (height * 0.5), // Mostly in upper half
      length: 200 + Math.random() * 400, // Longer, more majestic tail
      speedX: (isLeftToRight ? 1 : -1) * (150 + Math.random() * 250), // Slightly slower for a grander feel
      speedY: 30 + Math.random() * 100, // Slower descent
      opacity: 0.6 + Math.random() * 0.4,
      thickness: 1.5 + Math.random() * 2.5 // Slightly thicker core
    };
  }

  function update(deltaSeconds) {
    // Update Stars
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      star.y -= star.speed * deltaSeconds;
      star.x += star.drift * deltaSeconds;
      star.twinklePhase += star.twinkleSpeed * deltaSeconds;
      
      if (star.y < -10) {
        star.y = height + 10;
        star.x = Math.random() * width;
      }
      if (star.x < -10) {
        star.x = width + 10;
      } else if (star.x > width + 10) {
        star.x = -10;
      }
    }

    if (comets.length === 0 && Math.random() < 0.06 * deltaSeconds) {
      comets.push(spawnComet());
    }

    for (let i = comets.length - 1; i >= 0; i--) {
      const comet = comets[i];
      comet.x += comet.speedX * deltaSeconds;
      comet.y += comet.speedY * deltaSeconds;

      // Graceful edge fade
      const fadeMargin = 150;
      let fade = 1;

      if (comet.speedX > 0) {
        if (comet.x > width - fadeMargin) fade = Math.max(0, 1 - (comet.x - (width - fadeMargin)) / fadeMargin);
      } else {
        if (comet.x < fadeMargin) fade = Math.max(0, 1 - (fadeMargin - comet.x) / fadeMargin);
      }

      if (comet.y > height - fadeMargin) {
        fade = Math.min(fade, Math.max(0, 1 - (comet.y - (height - fadeMargin)) / fadeMargin));
      }

      comet.opacity = 0.8 * fade;

      // Remove only when fully faded or well off-screen
      if (comet.opacity < 0.01 || comet.x > width + 200 || comet.x < -200 || comet.y > height + 200) {
        comets.splice(i, 1);
      }
    }
  }

  function draw() {
    // Fill background with pure black
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    // Draw Stars
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      const twinkle = Math.sin(star.twinklePhase) * 0.3;
      const currentOpacity = Math.max(0.1, Math.min(1, star.baseOpacity + twinkle));
      
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      ctx.fillStyle = star.color;
      ctx.globalAlpha = currentOpacity;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw Comets
    for (let i = 0; i < comets.length; i++) {
      const comet = comets[i];
      
      // Calculate direction and tail
      const speed = Math.sqrt(comet.speedX * comet.speedX + comet.speedY * comet.speedY);
      const dirX = speed > 0.001 ? comet.speedX / speed : 0;
      const dirY = speed > 0.001 ? comet.speedY / speed : 0;
      
      const tailX = comet.x - dirX * comet.length;
      const tailY = comet.y - dirY * comet.length;

      // Perpendicular vector for the width of the comet head
      const perpX = -dirY;
      const perpY = dirX;
      
      const headWidth = comet.thickness * 1.8;

      const gradient = ctx.createLinearGradient(comet.x, comet.y, tailX, tailY);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${comet.opacity})`);
      gradient.addColorStop(0.05, `rgba(180, 220, 255, ${comet.opacity * 0.8})`);
      gradient.addColorStop(0.3, `rgba(100, 150, 255, ${comet.opacity * 0.3})`);
      gradient.addColorStop(1, 'rgba(100, 150, 255, 0)');
      
      // Draw the tapered tail shape
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(comet.x - perpX * headWidth, comet.y - perpY * headWidth);
      
      // Arc around the front of the head
      const angle = Math.atan2(dirY, dirX);
      ctx.arc(comet.x, comet.y, headWidth, angle - Math.PI / 2, angle + Math.PI / 2);
      
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();
      
      // Comet coma (glowing aura)
      const glowRadius = comet.thickness * 6;
      const headGlow = ctx.createRadialGradient(comet.x, comet.y, 0, comet.x, comet.y, glowRadius);
      headGlow.addColorStop(0, `rgba(255, 255, 255, ${comet.opacity})`);
      headGlow.addColorStop(0.15, `rgba(200, 230, 255, ${comet.opacity * 0.6})`);
      headGlow.addColorStop(0.4, `rgba(100, 150, 255, ${comet.opacity * 0.2})`);
      headGlow.addColorStop(1, 'rgba(100, 150, 255, 0)');
      
      ctx.beginPath();
      ctx.arc(comet.x, comet.y, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = headGlow;
      ctx.fill();

      // Solid inner core
      ctx.beginPath();
      ctx.arc(comet.x, comet.y, comet.thickness * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${comet.opacity})`;
      ctx.fill();
    }
  }

  function syncDiagnostics(mode) {
    canvas.dataset.starCount = String(stars.length);
    canvas.dataset.starfieldMode = mode;
    canvas.dataset.starfieldFrameCount = String(Number(canvas.dataset.starfieldFrameCount || '0') + 1);
  }

  function loop(timestamp) {
    if (isHidden) {
      animationFrameId = 0;
      return;
    }

    const deltaSeconds = lastTimestamp ? Math.min(0.08, (timestamp - lastTimestamp) / 1000) : 1 / 60;
    lastTimestamp = timestamp;
    update(deltaSeconds);
    draw();
    syncDiagnostics(heavyUtilityActive ? 'load-full-motion' : 'full-motion');
    animationFrameId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (animationFrameId || reducedMotion || isHidden) {
      return;
    }
    lastTimestamp = 0;
    animationFrameId = requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    }
  }

  function syncLoadState(active) {
    if (heavyUtilityActive === active) {
      return;
    }
    heavyUtilityActive = active;
    reconcileSpace();
    resize();
  }

  // Initialization
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', function() {
    isHidden = document.hidden;
    if (isHidden) {
      stopLoop();
    } else {
      startLoop();
    }
  });
  window.addEventListener('utilities-load-state', function(event) {
    const detail = event.detail || {};
    const source = detail.source || 'unknown';
    if (detail.active) {
      activeLoadSources.add(source);
    } else {
      activeLoadSources.delete(source);
    }
    syncLoadState(activeLoadSources.size > 0);
  });
  resize();
  if (reducedMotion) {
    draw();
    syncDiagnostics('reduced-motion');
  } else {
    startLoop();
  }

})();
