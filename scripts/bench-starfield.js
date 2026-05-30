/**
 * Starfield Benchmark Script v2 — Isolated Impact Measurement
 * Run in browser DevTools console on the utilities page.
 *
 * Usage:
 *   1. Open pages/utilities/index.html in browser
 *   2. Open DevTools console
 *   3. Copy-paste this entire file and press Enter
 *
 * Measures page FPS WITH and WITHOUT the starfield to isolate its impact.
 * Each phase runs for 5 seconds. The starfield is restored after the test.
 */
(async function benchStarfield() {
  'use strict';

  const canvas = document.getElementById('starfield');
  if (!canvas) {
    console.error('[bench] No #starfield canvas found. Are you on the utilities page?');
    return;
  }

  const PHASE_MS = 5_000;
  const WARMUP_MS = 500;

  // --- Measure rAF FPS over a window ---
  function measureFPS(durationMs) {
    return new Promise((resolve) => {
      const timestamps = [];
      const start = performance.now();

      function tick(ts) {
        timestamps.push(ts);
        if (ts - start < durationMs) {
          requestAnimationFrame(tick);
        } else {
          // Compute deltas
          const deltas = [];
          for (let i = 1; i < timestamps.length; i++) {
            deltas.push(timestamps[i] - timestamps[i - 1]);
          }
          const fps = timestamps.length / (durationMs / 1000);
          deltas.sort((a, b) => a - b);
          const avg = deltas.length ? deltas.reduce((s, v) => s + v, 0) / deltas.length : 0;
          resolve({
            fps,
            frameCount: timestamps.length,
            avgDelta: avg,
            p5: deltas[Math.floor(deltas.length * 0.05)] ?? null,
            p50: deltas[Math.floor(deltas.length * 0.5)] ?? null,
            p95: deltas[Math.floor(deltas.length * 0.95)] ?? null,
            p99: deltas[Math.floor(deltas.length * 0.99)] ?? null,
            janky20ms: deltas.filter(d => d > 20).length,
            janky33ms: deltas.filter(d => d > 33.33).length,
          });
        }
      }
      requestAnimationFrame(tick);
    });
  }

  // --- Pause/resume the starfield ---
  function pauseStarfield() {
    // Dispatch the same event the utilities-shell uses to pause rendering
    window.dispatchEvent(new CustomEvent('utilities-load-state', {
      detail: { source: 'benchmark', active: false, pauseRendering: true }
    }));
  }

  function resumeStarfield() {
    window.dispatchEvent(new CustomEvent('utilities-load-state', {
      detail: { source: 'benchmark', active: false, pauseRendering: false }
    }));
  }

  // --- Canvas info ---
  function getCanvasInfo() {
    return {
      cssSize: `${canvas.clientWidth}x${canvas.clientHeight}`,
      drawSize: `${canvas.width}x${canvas.height}`,
      pixelArea: canvas.width * canvas.height,
      dpr: (canvas.clientWidth ? canvas.width / canvas.clientWidth : '?'),
      starCount: canvas.dataset.starCount || '?',
      mode: canvas.dataset.starfieldMode || '?',
    };
  }

  // --- Main ---
  console.groupCollapsed('%c[starfield bench v2] isolated impact test', 'color: #ff6700; font-weight: bold');
  console.log(`Phase duration: ${(PHASE_MS / 1000).toFixed(0)}s each, ${WARMUP_MS}ms warmup`);

  const info = getCanvasInfo();
  console.log('Canvas info:');
  for (const [k, v] of Object.entries(info)) {
    console.log(`  ${k}: ${v}`);
  }
  console.log(`  pixel area: ${(info.pixelArea / 1000000).toFixed(2)}M pixels per frame`);

  // Phase 1: WITH starfield
  console.log('\n[Phase 1] Measuring WITH starfield...');
  await new Promise(r => setTimeout(r, WARMUP_MS));
  const withStarfield = await measureFPS(PHASE_MS);
  console.log(`  FPS: ${withStarfield.fps.toFixed(1)} (${withStarfield.frameCount} frames)`);

  // Phase 2: WITHOUT starfield (paused)
  console.log('\n[Phase 2] Pausing starfield, measuring WITHOUT...');
  pauseStarfield();
  await new Promise(r => setTimeout(r, WARMUP_MS));
  const withoutStarfield = await measureFPS(PHASE_MS);
  console.log(`  FPS: ${withoutStarfield.fps.toFixed(1)} (${withoutStarfield.frameCount} frames)`);

  // Restore starfield
  resumeStarfield();

  // --- Results ---
  const fpsImpact = withStarfield.fps - withoutStarfield.fps;
  const avgDeltaImpact = withStarfield.avgDelta - withoutStarfield.avgDelta;
  const jankyImpact = withStarfield.janky20ms - withoutStarfield.janky20ms;

  console.log('\n--- RESULTS ---\n');

  console.group('WITH starfield:');
  console.log(`  FPS:        ${withStarfield.fps.toFixed(1)}`);
  console.log(`  avg delta:  ${withStarfield.avgDelta.toFixed(2)}ms`);
  console.log(`  p5/p50:     ${withStarfield.p5?.toFixed(2)} / ${withStarfield.p50?.toFixed(2)}ms`);
  console.log(`  p95/p99:    ${withStarfield.p95?.toFixed(2)} / ${withStarfield.p99?.toFixed(2)}ms`);
  console.log(`  janky (>20): ${withStarfield.janky20ms}`);
  console.log(`  janky (>33): ${withStarfield.janky33ms}`);
  console.groupEnd();

  console.group('WITHOUT starfield:');
  console.log(`  FPS:        ${withoutStarfield.fps.toFixed(1)}`);
  console.log(`  avg delta:  ${withoutStarfield.avgDelta.toFixed(2)}ms`);
  console.log(`  p5/p50:     ${withoutStarfield.p5?.toFixed(2)} / ${withoutStarfield.p50?.toFixed(2)}ms`);
  console.log(`  p95/p99:    ${withoutStarfield.p95?.toFixed(2)} / ${withoutStarfield.p99?.toFixed(2)}ms`);
  console.log(`  janky (>20): ${withoutStarfield.janky20ms}`);
  console.log(`  janky (>33): ${withoutStarfield.janky33ms}`);
  console.groupEnd();

  console.group('ISOLATED IMPACT (starfield cost):');
  console.log(`  FPS loss:       ${fpsImpact > 0 ? '-' : ''}${fpsImpact.toFixed(1)} fps`);
  console.log(`  avg delta:      ${avgDeltaImpact > 0 ? '+' : ''}${avgDeltaImpact.toFixed(2)}ms`);
  console.log(`  extra janky:    ${jankyImpact > 0 ? '+' : ''}${jankyImpact} frames (>20ms)`);
  console.groupEnd();

  // --- Per-frame pixel math ---
  const pixelsPerFrame = info.pixelArea;
  const starsPerFrame = Number(info.starCount) || 0;
  console.log('\n--- PER-FRAME WORK ---');
  console.log(`  Canvas pixels cleared: ${pixelsPerFrame.toLocaleString()} (${(pixelsPerFrame / 1e6).toFixed(2)}M)`);
  console.log(`  Stars drawn:           ${starsPerFrame}`);
  console.log(`  Pixels per star:       ${(pixelsPerFrame / starsPerFrame).toFixed(0)}`);
  console.log(`  Effective DPR:         ${info.dpr}x (draw area ${info.drawSize} vs CSS ${info.cssSize})`);

  // --- Verdict ---
  console.log('\n--- INTERPRETATION ---');
  if (Math.abs(fpsImpact) < 2) {
    console.log('  Starfield impact is NEGLIGIBLE (<2fps cost).');
    console.log('  If you see high GPU/power usage, it is likely from canvas compositing');
    console.log('  (GPU still has to composite the canvas layer every frame even if drawing is cheap).');
  } else if (Math.abs(fpsImpact) < 5) {
    console.log('  Starfield has a MODERATE impact.');
    console.log('  Consider reducing DPR, star count, or switching to a static image.');
  } else {
    console.log('  Starfield has a SIGNIFICANT impact on page performance.');
    console.log('  Strong candidate for replacement with pre-rendered or CSS-based alternative.');
  }

  console.log('\n  NOTE: rAF measures main-thread scheduling. OffscreenCanvas worker drawing');
  console.log('  happens on a background thread. The real cost is GPU compositing of the');
  console.log('  canvas layer, which this benchmark cannot directly measure.');
  console.log('  For GPU power impact, check Activity Monitor > Energy tab while on this page.');

  console.groupEnd();
})();
