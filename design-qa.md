# Utilities workbench QA

Final result: passed.

## Scope and reference

Desktop-only workbench with the image-sidebar and scrubber refinement pass.
Strict no-scrolling policy: every active utility is the control panel itself.
Home, Résumé and Gallery are the visual references: white surface, bold
JetBrains Mono identity on the index, thin rules, restrained page accent.
Inside tools, Inter supplies compact UI text and monospace supplies numerical readouts. The user delegated
initial visual choices and requested a working first draft. No mobile redesign.

The index contains only numbered utility names. Workspaces reuse navigation,
control styles, status, and output framing. Image Transform, Fourier Reconstruction
and Stress Test remain functional; the VM implementation remains hidden and retained.
The old Assistant, glass layer, iridescent background and title-reveal runtime are removed.

## Visual review

Inspected in the in-app browser at a narrow desktop window and 1280×720.
Strict automated geometry checks cover 1440×900, 1280×720, 1024×600, 1280×600
and 800×600, for every tool both idle and generated/running, with resize restoration.
Screenshots for this pass are in `output/playwright/utilities-panels/`:

- `image.png`: image result, input rail and bottom controls/readouts all visible.
- `fourier.png`: horizontal audio rack, full-width signal, energy control and playback.
- `stress-idle.png`: top control strip, output and all six bottom readings.

The workspace title, index return and switcher now occupy one compact row.
Image output receives the remaining height beside a compact rail. Fourier uses a
horizontal control rack; Stress Test uses a control strip and bottom telemetry.
There is no utility footer, oversized heading, scrolling document or internal scroll
panel. Actual bounds are verified; overflow clipping is not used to conceal controls.
A narrow-width dropdown label initially truncated and was widened.

No outstanding P0/P1/P2 visual findings. Visual taste remains open for Oliver's
first review; this pass verifies the proposed draft rather than asserting approval.

## Image refinement pass

Numbered index, workspace and switcher labels use double slashes. Fourier layout
and its controls remain unchanged. Image settings stay bottom-aligned, with source
and target frames receiving spare height. The frames stack vertically at ordinary
heights and sit side by side at 560px or shorter. Images fill their own preview width and stay square and vertically centered.
Shorter frames crop vertically; narrower side-by-side frames reduce image size to
match their own width.

The image result now has a native animation scrubber: generation autoplays, the range
follows playback, pointer-down pauses, and pointer or keyboard seeking renders either
direction. Release retains the chosen frame; Resume continues from it. Reset disables
and zeros the control. Reduced-motion generation remains instant; manual seeking and
explicit playback are available.

Manually inspected and dragged the scrubber in the in-app browser; left it paused at
45%. Current screenshots are `output/playwright/image-scrubber/scrubbed.png` and
`short-final.png`. Automated sidebar checks cover 1440×1100/900/600/500 at fixed width,
including image scale/centering, useful frame area and bottom-aligned controls.

## Stress-test integration

Preserved the other agent's CPU worker scheduling, exact primality, adaptive GPU
backends, gyroid sculpture, intensity controls, orbit interaction and teardown.
The actual search starts at 1; 1 is rejected and 2 is tested exactly once.
The initial 1 is a start marker, followed by genuine reported prime results.

The output now uses the workbench paper surface, black weight-800 JetBrains Mono
numbers anchored to the right, and violet/graphite GPU materials. Dynamic type sizing
accounts for digit count and the available output area. CPU/GPU combined mode places
the sculpture left and the result right with a thin separator. Decorative glows,
marketing copy and explanatory hover tooltips are removed. Worker activity remains
an actual throughput display. Short desktop windows retain all controls and readings.

In-app browser captures: `output/playwright/stress-integration/cpu-final.png`,
`gpu.png`, and `combined.png`. All manual workloads were stopped after capture.
Focused browser checks passed on WebGPU (Apple Metal), WebGL2, WebGL1 and no-GPU
fallback, including actual increasing primes, font/weight/right edge, desktop
geometry at 800×600 through 1440×900 and 1024×520, intensity/orbit and teardown.
All 198 current unit tests and the standard quality/typecheck gates pass. The full
utilities browser regression also passes; active GPU output is checked from the
presented canvas screenshot because the retained renderer intentionally does not
preserve its drawing buffer after presentation.

## Optimized sustained-load pass

CPU trial division was replaced with a reusable 32 KiB segmented sieve and cached
base primes. Consecutive blocks are allocated on demand with four-block prefetch;
fast workers take more work, and the old 64-worker cap is removed. Refill bookkeeping
stays in numeric state; diagnostics publish in the throttled UI loop. Known prime
counts, arbitrary intervals, heterogeneous 1/2/8/128-worker schedules, stale messages
and cancellation are covered. A local single-thread algorithm benchmark over
1–10,000,000 returned 664,579 primes and largest 9,999,991 in both versions; median
419ms trial division versus 10.5ms sieve, about 40× faster. This excludes browser
startup/communication and is not a utilization claim. Reproduce with
`node scripts/stress-prime-bench.js`; JSON is in `output/stress-bench/`.

The intensity dropdown/API is removed. WebGPU and WebGL2 keep up to two bounded
batches queued with completion-driven refills; WebGL1 completes real work and yields
via MessageChannel without a refresh-rate cap. Shaders/scene styling are preserved.
Device limits, resize draining, cancellation, loss and teardown remain enforced.

All 211 unit tests, typecheck, quality checks, both real-browser suites and builds
passed. Real WebGPU/WebGL2/WebGL1 and no-GPU fallback were exercised. Every worker in
the browser test made progress and received refills. Manual default dispatch used
all 14 browser-reported threads and was stopped after verification. The newly larger
candidate readout fits its exact value to the available column; targeted geometry
checks include MAX_SAFE_INTEGER at 800px and 1280px widths. No hardware utilization,
board-power or multi-physical-GPU guarantee is claimed.

## Functional verification

- Full Chromium utilities browser regression passed: index/deep links/history,
  keyboard focus, active/hidden routes, uploads, presets, thumbnails, swap, reset,
  image pixel results, playback, Fourier energy controls, stress modes/start/stop,
  errors, worker fallback and reduced motion.
- Delayed image-cache cancellation and retry passed.
- Leaving Fourier during delayed decode does not start hidden playback.
- Leaving and returning during delayed audio resume invalidates the old request;
  overlapping Play requests start one tracked playback instance.
- Standard quality checks, utility typecheck and all 171 tests passed.
- No-scroll assertions verify document dimensions, every essential control/status/output,
  all six stress metrics, ancestor containment, and absence of internal scroll containers.
- Image animation control was extended; the pixel renderer and the other tool controllers
  are unchanged in this refinement. The reused-buffer test verifies seeking backwards.
- Browser tests cover synchronized autoplay, exact repeated seek frames, stationary
  release, keyboard seeking, resume from the selected point, completion/reset endpoints
  and manual seeking under reduced motion.
- Utility and static deployment builds passed. Nothing deployed or merged.
- VM source/runtime/test preservation check: 32 tracked files byte-identical to HEAD.
  No existing asset files or VM build inputs were changed. Other page implementations
  and shared styles are unchanged.

## Limits

No phone utility experience was added. No exhaustive assistive-technology audit,
Firefox certification, or VM boot test is claimed. The VM remains inaccessible by
public route. The retained v86 bundle produces its existing Vite Node-module
externalization notices during builds; builds succeed.
