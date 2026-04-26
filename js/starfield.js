/**
 * Starfield Canvas Animation
 * Renders a performant, parallax starfield on a canvas element.
 */
(function() {
  'use strict';

  const canvas = document.getElementById('starfield');
  if (!canvas) return;

  const ctx = canvas.getContext('2d', { alpha: false });
  let width, height;
  let stars = [];

  // Configuration
  const STAR_COUNT = 400;
  const BASE_SPEED = 0.15;
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
    
    // Handle high-DPI displays
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    
    ctx.scale(dpr, dpr);
    
    // Re-initialize stars on resize to ensure even distribution
    initStars();
  }

  function initStars() {
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push(createStar());
    }
  }

  function createStar() {
    // Depth determines size, speed, and base opacity for parallax effect
    // depth: 0 (furthest) to 1 (closest)
    const depth = Math.random();
    
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      size: Math.max(0.5, depth * 2.5),
      speed: BASE_SPEED + (depth * BASE_SPEED * 2),
      color: STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)],
      baseOpacity: 0.2 + (depth * 0.6),
      
      // Twinkle properties
      twinkleSpeed: 0.02 + (Math.random() * 0.05),
      twinklePhase: Math.random() * Math.PI * 2,
      
      // Horizontal drift
      drift: (Math.random() - 0.5) * 0.1
    };
  }

  function update() {
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      
      // Move stars upwards
      star.y -= star.speed;
      star.x += star.drift;
      
      // Update twinkle phase
      star.twinklePhase += star.twinkleSpeed;
      
      // Wrap around screen
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
  }

  function draw() {
    // Fill background with pure black (OLED friendly)
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);
    
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      
      // Calculate current opacity with twinkle effect
      const twinkle = Math.sin(star.twinklePhase) * 0.3;
      const currentOpacity = Math.max(0.1, Math.min(1, star.baseOpacity + twinkle));
      
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.size, 0, Math.PI * 2);
      
      // Apply opacity to color
      ctx.fillStyle = star.color;
      ctx.globalAlpha = currentOpacity;
      ctx.fill();
    }
    
    // Reset global alpha
    ctx.globalAlpha = 1;
  }

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // Initialization
  window.addEventListener('resize', resize);
  resize(); // This calls initStars()
  requestAnimationFrame(loop);

})();
