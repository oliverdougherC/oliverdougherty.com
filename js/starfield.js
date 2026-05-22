/**
 * Starfield Canvas Animation
 * Renders a performant, parallax starfield on a canvas element.
 * Includes stars and occasional comets.
 */
(function() {
  'use strict';

  const canvas = document.getElementById('starfield');
  if (!canvas) return;

  var STARFIELD_CONFIG = Object.freeze({
    baseStarCount: 500,
    baseSpeed: 9,
    maxDpr: 1.5,
    colors: ['#ffffff', '#e0f7fa', '#fff3e0', '#fce4ec', '#f3e5f5']
  });

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (startWorkerRenderer(canvas, reducedMotion)) {
    return;
  }

  const ctx = canvas.getContext('2d', { alpha: false });
  let width, height;
  let stars = [];
  let comets = [];
  let animationFrameId = 0;
  let resizeFrameId = 0;
  let lastTimestamp = 0;
  let isHidden = document.hidden;
  let heavyUtilityActive = false;
  let diagnosticsFrameCounter = 0;
  const DIAGNOSTICS_BATCH_INTERVAL = 30; // sync dataset every N frames
  const activeLoadSources = new Set();

  function startWorkerRenderer(targetCanvas, reduceMotion) {
    if (
      reduceMotion ||
      typeof Worker !== 'function' ||
      typeof Blob !== 'function' ||
      typeof URL === 'undefined' ||
      typeof targetCanvas.transferControlToOffscreen !== 'function'
    ) {
      return false;
    }

    try {
      // NOTE: Uses Function.prototype.toString() to serialize the worker body into a Blob URL.
      // This is fragile if a minifier mangles the function body (e.g. removes comments, rewrites
      // arrow syntax, or strips unused locals). If bundling the worker separately is not feasible,
      // ensure your build pipeline preserves `starfieldWorkerMain` as a named function literal.
      const workerSource = `const STARFIELD_CONFIG = ${JSON.stringify(STARFIELD_CONFIG)};\n(${starfieldWorkerMain.toString()})()`;
      const workerUrl = URL.createObjectURL(new Blob([workerSource], {
        type: 'text/javascript'
      }));
      const worker = new Worker(workerUrl);
      URL.revokeObjectURL(workerUrl);

      worker.addEventListener('message', function(event) {
        const data = event.data || {};
        if (data.type !== 'diagnostics') {
          return;
        }
        targetCanvas.dataset.starCount = String(data.starCount || 0);
        targetCanvas.dataset.starfieldMode = data.mode || 'full-motion-worker';
        targetCanvas.dataset.starfieldFrameCount = String(data.frameCount || 0);
      });

      const offscreen = targetCanvas.transferControlToOffscreen();
      let resizeFrame = 0;
      const postViewport = function(type) {
        worker.postMessage({
          type,
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          hidden: document.hidden
        });
      };

      worker.postMessage({
        type: 'init',
        canvas: offscreen,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        hardwareConcurrency: navigator.hardwareConcurrency || 4,
        hidden: document.hidden
      }, [offscreen]);

      window.addEventListener('resize', function() {
        if (resizeFrame) return;
        resizeFrame = window.requestAnimationFrame(function() {
          resizeFrame = 0;
          postViewport('resize');
        });
      });
      document.addEventListener('visibilitychange', function() {
        postViewport('visibility');
      });
      window.addEventListener('utilities-load-state', function(event) {
        const detail = event.detail || {};
        worker.postMessage({
          type: 'load-state',
          source: detail.source || 'unknown',
          active: Boolean(detail.active)
        });
      });

      return true;
    } catch (error) {
      console.debug('Starfield worker renderer unavailable:', error);
      return false;
    }
  }

  function starfieldWorkerMain() {
    let canvas = null;
    let ctx = null;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let stars = [];
    let comets = [];
    let timerId = 0;
    let lastTimestamp = 0;
    let frameCount = 0;
    let lastDiagnosticsAt = 0;
    let isHidden = false;
    const activeLoadSources = new Set();

    let hardwareConcurrency = 4;

    function resolveStarCount() {
      const areaScale = Math.max(0.45, Math.min(1.15, width * height / (1440 * 900)));
      const coreScale = hardwareConcurrency <= 4 ? 0.72 : 1;
      return Math.round(STARFIELD_CONFIG.baseStarCount * areaScale * coreScale);
    }

    function createStar() {
      const depth = Math.random();
      return {
        x: Math.random() * width,
        y: Math.random() * height,
        size: Math.max(0.5, depth * 2.5),
        speed: STARFIELD_CONFIG.baseSpeed + depth * STARFIELD_CONFIG.baseSpeed * 2,
        color: STARFIELD_CONFIG.colors[Math.floor(Math.random() * STARFIELD_CONFIG.colors.length)],
        baseOpacity: 0.2 + depth * 0.6,
        twinkleSpeed: 1.2 + Math.random() * 3,
        twinklePhase: Math.random() * Math.PI * 2,
        drift: (Math.random() - 0.5) * 6
      };
    }

    function reconcileSpace() {
      const targetCount = resolveStarCount();
      while (stars.length < targetCount) {
        stars.push(createStar());
      }
      if (stars.length > targetCount) {
        stars.length = targetCount;
      }
    }

    function resize(nextWidth, nextHeight, nextDpr) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      dpr = Math.min(nextDpr || 1, STARFIELD_CONFIG.maxDpr);
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      reconcileSpace();
      draw();
      postDiagnostics(performance.now(), true);
    }

    function spawnComet() {
      const isLeftToRight = Math.random() > 0.5;
      return {
        x: isLeftToRight ? -50 : width + 50,
        y: Math.random() * (height * 0.5),
        length: 200 + Math.random() * 400,
        speedX: (isLeftToRight ? 1 : -1) * (150 + Math.random() * 250),
        speedY: 30 + Math.random() * 100,
        opacity: 0.6 + Math.random() * 0.4,
        thickness: 1.5 + Math.random() * 2.5
      };
    }

    function update(deltaSeconds) {
      for (let i = 0; i < stars.length; i += 1) {
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

      for (let i = comets.length - 1; i >= 0; i -= 1) {
        const comet = comets[i];
        comet.x += comet.speedX * deltaSeconds;
        comet.y += comet.speedY * deltaSeconds;

        const fadeMargin = 150;
        let fade = 1;
        if (comet.speedX > 0) {
          if (comet.x > width - fadeMargin) fade = Math.max(0, 1 - (comet.x - (width - fadeMargin)) / fadeMargin);
        } else if (comet.x < fadeMargin) {
          fade = Math.max(0, 1 - (fadeMargin - comet.x) / fadeMargin);
        }
        if (comet.y > height - fadeMargin) {
          fade = Math.min(fade, Math.max(0, 1 - (comet.y - (height - fadeMargin)) / fadeMargin));
        }
        comet.opacity = 0.8 * fade;
        if (comet.opacity < 0.01 || comet.x > width + 200 || comet.x < -200 || comet.y > height + 200) {
          comets.splice(i, 1);
        }
      }
    }

    function draw() {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);

      for (let i = 0; i < stars.length; i += 1) {
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

      for (let i = 0; i < comets.length; i += 1) {
        const comet = comets[i];
        const speed = Math.sqrt(comet.speedX * comet.speedX + comet.speedY * comet.speedY);
        const dirX = speed > 0.001 ? comet.speedX / speed : 0;
        const dirY = speed > 0.001 ? comet.speedY / speed : 0;
        const tailX = comet.x - dirX * comet.length;
        const tailY = comet.y - dirY * comet.length;
        const perpX = -dirY;
        const perpY = dirX;
        const headWidth = comet.thickness * 1.8;
        const gradient = ctx.createLinearGradient(comet.x, comet.y, tailX, tailY);
        gradient.addColorStop(0, `rgba(255, 255, 255, ${comet.opacity})`);
        gradient.addColorStop(0.05, `rgba(180, 220, 255, ${comet.opacity * 0.8})`);
        gradient.addColorStop(0.3, `rgba(100, 150, 255, ${comet.opacity * 0.3})`);
        gradient.addColorStop(1, 'rgba(100, 150, 255, 0)');
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(comet.x - perpX * headWidth, comet.y - perpY * headWidth);
        const angle = Math.atan2(dirY, dirX);
        ctx.arc(comet.x, comet.y, headWidth, angle - Math.PI / 2, angle + Math.PI / 2);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

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
        ctx.beginPath();
        ctx.arc(comet.x, comet.y, comet.thickness * 0.7, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 255, 255, ${comet.opacity})`;
        ctx.fill();
      }
    }

    function postDiagnostics(timestamp, force) {
      if (!force && timestamp - lastDiagnosticsAt < 250) {
        return;
      }
      lastDiagnosticsAt = timestamp;
      self.postMessage({
        type: 'diagnostics',
        starCount: stars.length,
        frameCount,
        mode: activeLoadSources.size > 0 ? 'load-full-motion-worker' : 'full-motion-worker'
      });
    }

    function loop() {
      timerId = 0;
      if (isHidden || !ctx) {
        return;
      }
      const timestamp = performance.now();
      const deltaSeconds = lastTimestamp ? Math.min(0.08, (timestamp - lastTimestamp) / 1000) : 1 / 60;
      lastTimestamp = timestamp;
      update(deltaSeconds);
      draw();
      frameCount += 1;
      postDiagnostics(timestamp, false);
      timerId = setTimeout(loop, 16);
    }

    function start() {
      if (timerId || isHidden || !ctx) {
        return;
      }
      lastTimestamp = 0;
      timerId = setTimeout(loop, 16);
    }

    function stop() {
      if (timerId) {
        clearTimeout(timerId);
        timerId = 0;
      }
    }

    self.onmessage = function(event) {
      const data = event.data || {};
      if (data.type === 'init') {
        canvas = data.canvas;
        ctx = canvas.getContext('2d', { alpha: false });
        hardwareConcurrency = data.hardwareConcurrency || 4;
        isHidden = Boolean(data.hidden);
        resize(data.width, data.height, data.dpr);
        start();
      } else if (data.type === 'resize') {
        resize(data.width, data.height, data.dpr);
      } else if (data.type === 'visibility') {
        isHidden = Boolean(data.hidden);
        if (isHidden) {
          stop();
        } else {
          start();
        }
      } else if (data.type === 'load-state') {
        if (data.active) {
          activeLoadSources.add(data.source || 'unknown');
        } else {
          activeLoadSources.delete(data.source || 'unknown');
        }
        postDiagnostics(performance.now(), true);
      }
    };
  }

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
    return Math.min(window.devicePixelRatio || 1, STARFIELD_CONFIG.maxDpr);
  }

  function resolveStarCount() {
    if (reducedMotion) {
      return Math.min(140, STARFIELD_CONFIG.baseStarCount);
    }

    const areaScale = Math.max(0.45, Math.min(1.15, width * height / (1440 * 900)));
    const coreScale = (navigator.hardwareConcurrency || 4) <= 4 ? 0.72 : 1;
    return Math.round(STARFIELD_CONFIG.baseStarCount * areaScale * coreScale);
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
      speed: STARFIELD_CONFIG.baseSpeed + (depth * STARFIELD_CONFIG.baseSpeed * 2),
      color: STARFIELD_CONFIG.colors[Math.floor(Math.random() * STARFIELD_CONFIG.colors.length)],
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
    diagnosticsFrameCounter += 1;
    if (diagnosticsFrameCounter >= DIAGNOSTICS_BATCH_INTERVAL) {
      diagnosticsFrameCounter = 0;
      syncDiagnostics(heavyUtilityActive ? 'load-full-motion' : 'full-motion');
    }
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
  }

  function queueResize() {
    if (resizeFrameId) {
      return;
    }
    resizeFrameId = requestAnimationFrame(function() {
      resizeFrameId = 0;
      resize();
    });
  }

  // Initialization
  window.addEventListener('resize', queueResize);
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
