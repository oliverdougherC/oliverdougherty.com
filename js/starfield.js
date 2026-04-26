/**
 * Starfield Canvas Animation
 * Renders a performant, parallax starfield on a canvas element.
 * Includes stars, distant planets, occasional comets, and colorful space dust.
 */
(function() {
  'use strict';

  const canvas = document.getElementById('starfield');
  if (!canvas) return;

  const ctx = canvas.getContext('2d', { alpha: false });
  let width, height;
  let stars = [];
  let planets = [];
  let comets = [];
  let nebulae = [];

  // Configuration
  const STAR_COUNT = 500;
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
    
    // Re-initialize elements on resize to ensure even distribution
    initSpace();
  }

  function initSpace() {
    // Initialize Stars
    stars = [];
    for (let i = 0; i < STAR_COUNT; i++) {
      stars.push(createStar());
    }

    // Initialize Nebulae (Space Dust)
    nebulae = [];
    const nebulaCount = Math.floor(Math.random() * 3) + 2; // 2 to 4 nebulae
    for (let i = 0; i < nebulaCount; i++) {
      nebulae.push(createNebula());
    }

    // Initialize Distant Planets
    planets = [];
    const planetCount = Math.floor(Math.random() * 2) + 1; // 1 or 2 planets
    for (let i = 0; i < planetCount; i++) {
      planets.push(createPlanet());
    }

    // Comets are spawned randomly during the update loop
    comets = [];
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
      twinkleSpeed: 0.02 + (Math.random() * 0.05),
      twinklePhase: Math.random() * Math.PI * 2,
      drift: (Math.random() - 0.5) * 0.1
    };
  }

  function createNebula() {
    const colors = [
      { r: 75, g: 0, b: 130 },   // Deep Purple
      { r: 25, g: 25, b: 112 },  // Midnight Blue
      { r: 139, g: 0, b: 139 },  // Dark Magenta
      { r: 0, g: 128, b: 128 }   // Teal
    ];
    const color = colors[Math.floor(Math.random() * colors.length)];
    
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      radius: 150 + Math.random() * 300,
      color: color,
      opacity: 0.03 + Math.random() * 0.05,
      speed: BASE_SPEED * 0.2, // Very slow
      drift: (Math.random() - 0.5) * 0.05
    };
  }

  function createPlanet() {
    const colors = [
      ['#2c3e50', '#000000'], // Dark blue to black
      ['#4a235a', '#000000'], // Dark purple to black
      ['#1e8449', '#000000'], // Dark green to black
      ['#7b241c', '#000000']  // Dark red to black
    ];
    const colorScheme = colors[Math.floor(Math.random() * colors.length)];
    
    // Position near edges
    const isLeft = Math.random() > 0.5;
    const x = isLeft ? Math.random() * (width * 0.2) : width - (Math.random() * (width * 0.2));
    
    return {
      x: x,
      y: Math.random() * height,
      radius: 20 + Math.random() * 60,
      colorStart: colorScheme[0],
      colorEnd: colorScheme[1],
      speed: BASE_SPEED * 0.5, // Slower than stars
      hasRings: Math.random() > 0.7,
      ringAngle: Math.random() * Math.PI
    };
  }

  function spawnComet() {
    const isLeftToRight = Math.random() > 0.5;
    return {
      x: isLeftToRight ? -50 : width + 50,
      y: Math.random() * (height * 0.5), // Mostly in upper half
      length: 100 + Math.random() * 150,
      speedX: (isLeftToRight ? 1 : -1) * (5 + Math.random() * 5),
      speedY: 1 + Math.random() * 3,
      opacity: 0.8,
      thickness: 1 + Math.random() * 2
    };
  }

  function update() {
    // Update Nebulae
    for (let i = 0; i < nebulae.length; i++) {
      const nebula = nebulae[i];
      nebula.y -= nebula.speed;
      nebula.x += nebula.drift;
      if (nebula.y + nebula.radius < 0) {
        nebula.y = height + nebula.radius;
        nebula.x = Math.random() * width;
      }
    }

    // Update Planets
    for (let i = 0; i < planets.length; i++) {
      const planet = planets[i];
      planet.y -= planet.speed;
      if (planet.y + planet.radius < 0) {
        planet.y = height + planet.radius;
        // Keep it near edges
        const isLeft = Math.random() > 0.5;
        planet.x = isLeft ? Math.random() * (width * 0.2) : width - (Math.random() * (width * 0.2));
      }
    }

    // Update Stars
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      star.y -= star.speed;
      star.x += star.drift;
      star.twinklePhase += star.twinkleSpeed;
      
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

    // Update Comets
    // 0.1% chance per frame to spawn a comet if none exist
    if (comets.length === 0 && Math.random() < 0.001) {
      comets.push(spawnComet());
    }

    for (let i = comets.length - 1; i >= 0; i--) {
      const comet = comets[i];
      comet.x += comet.speedX;
      comet.y += comet.speedY;
      
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

    // Draw Nebulae (Space Dust)
    // Use composite operation for additive blending
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < nebulae.length; i++) {
      const nebula = nebulae[i];
      const gradient = ctx.createRadialGradient(
        nebula.x, nebula.y, 0,
        nebula.x, nebula.y, nebula.radius
      );
      gradient.addColorStop(0, `rgba(${nebula.color.r}, ${nebula.color.g}, ${nebula.color.b}, ${nebula.opacity})`);
      gradient.addColorStop(1, `rgba(${nebula.color.r}, ${nebula.color.g}, ${nebula.color.b}, 0)`);
      
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(nebula.x, nebula.y, nebula.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over'; // Reset

    // Draw Planets
    for (let i = 0; i < planets.length; i++) {
      const planet = planets[i];
      
      // Draw rings if applicable
      if (planet.hasRings) {
        ctx.save();
        ctx.translate(planet.x, planet.y);
        ctx.rotate(planet.ringAngle);
        ctx.beginPath();
        ctx.ellipse(0, 0, planet.radius * 2, planet.radius * 0.4, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.beginPath();
        ctx.ellipse(0, 0, planet.radius * 2.4, planet.radius * 0.5, 0, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // Draw planet body
      const gradient = ctx.createRadialGradient(
        planet.x - planet.radius * 0.3, planet.y - planet.radius * 0.3, 0,
        planet.x, planet.y, planet.radius
      );
      gradient.addColorStop(0, planet.colorStart);
      gradient.addColorStop(1, planet.colorEnd);
      
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(planet.x, planet.y, planet.radius, 0, Math.PI * 2);
      ctx.fill();
    }

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

  function loop() {
    update();
    draw();
    requestAnimationFrame(loop);
  }

  // Initialization
  window.addEventListener('resize', resize);
  resize(); // This calls initSpace()
  
  // Start loop immediately, CSS handles the fade in
  requestAnimationFrame(loop);

})();
