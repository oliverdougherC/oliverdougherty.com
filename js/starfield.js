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
  const HEAVY_MAX_DPR = 1;
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
    if (reducedMotion || heavyUtilityActive) {
      return Math.min(window.devicePixelRatio || 1, HEAVY_MAX_DPR);
    }
    return Math.min(window.devicePixelRatio || 1, MAX_DPR);
  }

  function resolveStarCount() {
    if (reducedMotion) {
      return Math.min(140, BASE_STAR_COUNT);
    }

    const areaScale = Math.max(0.45, Math.min(1.15, width * height / (1440 * 900)));
    const coreScale = (navigator.hardwareConcurrency || 4) <= 4 ? 0.72 : 1;
    const loadScale = heavyUtilityActive ? 0.5 : 1;
    return Math.round(BASE_STAR_COUNT * areaScale * coreScale * loadScale);
  }

  function reconcileSpace() {
    const targetCount = resolveStarCount();
    while (stars.length < targetCount) {
      stars.push(createStar());
    }
    if (stars.length > targetCount) {
      stars.length = targetCount;
    }
    if (heavyUtilityActive || reducedMotion) {
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
      length: 100 + Math.random() * 150,
      speedX: (isLeftToRight ? 1 : -1) * (300 + Math.random() * 300),
      speedY: 60 + Math.random() * 180,
      opacity: 0.8,
      thickness: 1 + Math.random() * 2
    };
  }

  function update(deltaSeconds) {
    const timeScale = heavyUtilityActive ? 0.75 : 1;

    // Update Stars
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      star.y -= star.speed * deltaSeconds * timeScale;
      star.x += star.drift * deltaSeconds * timeScale;
      if (!heavyUtilityActive) {
        star.twinklePhase += star.twinkleSpeed * deltaSeconds;
      }
      
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

    if (!heavyUtilityActive && comets.length === 0 && Math.random() < 0.06 * deltaSeconds) {
      comets.push(spawnComet());
    }

    for (let i = comets.length - 1; i >= 0; i--) {
      const comet = comets[i];
      comet.x += comet.speedX * deltaSeconds;
      comet.y += comet.speedY * deltaSeconds;
      
      // Remove if off screen
      if (comet.x > width + 200 || comet.x < -200 || comet.y > height + 200) {
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
      const twinkle = heavyUtilityActive ? 0 : Math.sin(star.twinklePhase) * 0.3;
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
      
      // Calculate tail end point
      const tailX = comet.x - (comet.speedX * comet.length * 0.1);
      const tailY = comet.y - (comet.speedY * comet.length * 0.1);
      
      const gradient = ctx.createLinearGradient(comet.x, comet.y, tailX, tailY);
      gradient.addColorStop(0, `rgba(255, 255, 255, ${comet.opacity})`);
      gradient.addColorStop(0.2, `rgba(200, 220, 255, ${comet.opacity * 0.5})`);
      gradient.addColorStop(1, 'rgba(100, 150, 255, 0)');
      
      ctx.beginPath();
      ctx.moveTo(comet.x, comet.y);
      ctx.lineTo(tailX, tailY);
      ctx.strokeStyle = gradient;
      ctx.lineWidth = comet.thickness;
      ctx.lineCap = 'round';
      ctx.stroke();
      
      // Comet head glow
      ctx.beginPath();
      ctx.arc(comet.x, comet.y, comet.thickness * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${comet.opacity})`;
      ctx.fill();
    }
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
  } else {
    startLoop();
  }

})();
