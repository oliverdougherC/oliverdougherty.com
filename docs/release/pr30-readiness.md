# PR #30 release readiness

This report accompanies `release/pr30-readiness`. It covers corrections to “Utilities rebuild, homepage/gallery/resume refresh, blog + local-assistant retirement.” No production merge or deployment is part of this work.

## Candidate provenance

- Reviewed and fetched beta: `c7a5075962bc75e8de4630b0352e710cdf3b61df`.
- Reviewed and fetched main: `95376cefa8729b6ab1c92dc10397c062f9c0115b`.
- Original merge base: `20dbf6e75e8de07dee7d19cde021e072bfef8c11`.
- Non-destructive integration commit: `8f2a802`.
- The tested artifact's exact commit and entry filename are recorded in `dist/release-artifact.json`; the browser evidence repeats that identity in `output/release/results.json`.

Main-only history comprised mobile-gallery commit `11971e1`, résumé commit `f2438c3`, and their PR merge commits `e29e299` and `95376ce`. Their mobile gallery and September résumé content were already represented in beta. Six actual conflict files were reviewed individually: `css/utilities.css`, `js/utilities-shell.js`, `mobile/gallery/index.html`, `mobile/index.html`, `mobile/resume/index.html`, and `pages/resume/index.html`. The merge retains the separate mobile gallery, current résumé prose and updated mobile assertions. Beta's later numbered headings, removed tech tags, accented Résumé labels, Nighthawks mobile navigation and white utility workbench take precedence over superseded main styling. The old glass utility layout/flair settings do not apply to the intended workbench. No shared history was reset or force-pushed.

## Findings

Numbering follows the fourteen findings in the supplied review, in order.

| Finding | Disposition and evidence |
| --- | --- |
| F01 — divergent release history | Main integrated with a merge commit; final remote mergeability is reported with the candidate handoff. |
| F02 — artifact/acceptance gate | `Build` now constructs `dist`, runs separate source/deployment smoke and link checks, installs all three browser engines, executes bounded packaged acceptance and uploads failure evidence. Deployment consumes the validated Pages artifact. Missing `dist`/`CNAME` are regression-tested failures. The runner checks its served marker and rejects authoring-root exposure. |
| F03 — hidden audio canvas growth | Inherited sizing defect fixed: use measurable CSS dimensions only, skip hidden surfaces, enforce dimension/pixel limits, and skip unused support-plot rendering. Unit tests cover DPR 1/2/3, repeated observer callbacks, hide/return, visible resizing, huge mocked layout and restoration. Browser tests exercise the production DOM across DPR 1/2/3. Waveform quality policy remains, with absolute limits taking precedence for extreme surfaces. |
| F04 — gallery BFCache lifecycle | Idempotent suspension/restoration rebinds keyboard/hash listeners and observers without duplicating static handlers. Suspension also clears a pending navigation fade. The original page was reproduced with `pageshow.persisted === true` and broken Escape; corrected Chromium tests verify two actual cached returns, including an open mid-fade lightbox, plus keyboard/hash, resize and previously unrevealed cards. WebKit reloads even a minimal cacheable control, so its cached restoration is explicitly unverified; its gallery interactions still run. |
| F05 — gallery focus during layout | Preserve and restore only the focused grid descendant with `preventScroll`; leave modal and outside focus alone. Tests use production markup. Browser coverage holds real photo responses against deliberately disagreeing metadata, verifies image-load geometry reconciliation without focus loss, and exercises resize plus deferred post-close layout. |
| F06 — mosaic feasibility/gutters | A guaranteed feasible, aspect-preserving fallback handles null DP solutions; ordinary mosaics retain their solver and artistic pattern. Column math now subtracts interior gutters exactly once. Tests cover zero/one/two archive items, two panoramas at 900px, portraits, mixed sets, image/metadata disagreement, breakpoint widths and a real-manifest width sweep, requiring each item once, finite geometry, consistent gaps and no overlap. |
| F07 — mobile delayed navigation | Inherited main defect fixed with a cancellation token and a tracked pending target/timer. Rapid gestures advance the pending destination deterministically; close, replacement and pagehide invalidate delayed work. Stale image/frame callbacks are guarded. Suspension restores opacity, and reduced motion commits without the delay. Unit/browser tests cover swipes, close/reopen, alternating directions, wraparound and suspension. |
| F08 — mobile keyboard/modal behavior | Inherited main gap fixed with labeled native photo buttons, dialog focus entry/trapping/return, Escape/arrows and inert background regions. Prior inert state is preserved. Browser tests exercise Enter/Space, Tab/Shift+Tab, arrows, close, touch-handler behavior and reduced motion while preserving the mobile layout. |
| F09 — homepage media/cursor lifecycle | Immediate, idempotent hidden/pagehide stop cancels both frame loops, pauses/resets audio and invalidates pending play completions. Rejection and stale completion tests pass. Reduced-motion changes preserve a native cursor without removing the easter egg. |
| F10 — GPU backing-size ownership | A generation-specific claim prevents controller writes during backend startup/rendering and releases on stop/fallback. Zero explicitly means unowned, preserving initial idle sizing. Real controller + real backend integration tests use delayed WebGPU completions and WebGL2 fences with an instrumented observer, CSS-size/DPR changes, stop and fallback; they prove no backing-size write before drain. |
| F11 — GPU asynchronous startup failure | Reproduced and fixed both callbacks before factory resolution and a second race between the factory/controller awaits. Validation at the actual installation boundary rejects failed handles. Lower-level initialization device loss and composed controller tests verify honest GPU-only errors, combined CPU fallback, resource release and stale-generation rejection. |
| F12 — telemetry semantics | UI distinguishes `GPU batches/s` from `Visual callbacks/s`; `Gaps >34 ms` is an explicit callback-gap count, never dropped display frames or GPU utilization. Cadence samples restart when the render source changes, so GPU completions are not relabeled as CPU frames. Worker-derived prime/candidate telemetry is unchanged. Burst, gap, reduced-motion and backend-transition regressions pass. |
| F13 — mixed release assets | Content hashes couple entry, controllers, workers and generated transform data; deployed classic scripts/styles also receive content-derived query versions. VM WASM compatibility names remain. Deployment HTML selects the manifest entry; the stable source-preview loader is replaced by a migration-only recovery endpoint. The actual reviewed beta HTML and cached entry bundle are tested against the new artifact; legacy entry/lazy requests get an explicit reload action. Actual two-release builds change a worker and prove controller/entry invalidation, returning-cache operation, deleted lazy-module recovery and deleted worker recovery. A separate HTML fallback handles a missing entry before application code executes. Already-running cached code retains its old behavior until reload; new requests to the old entry/controller URLs receive recovery. |
| F14 — retired output/route audit | Retained animation reference sources/generators stay in the repository; unused animation assets/CSS/JS are excluded from production. Required gallery, credited art, font-license and VM assets remain. Blog/archive routes are intentionally retired and receive a custom 404 without an unrelated redirect. Production link checks and route/error tests cover the shipped graph. |

## Validation evidence

The local integrated suite passes 277 tests in 32 files with the original ES2022 type contract. Exact browser command outcomes, commit identity and explicitly unverified capabilities are recorded in `output/release/results.json`; required GitHub CI must be green before merging.

- Node `v22.23.0`, npm `10.9.8`, repository-pinned Playwright `1.58.2`.
- Dependencies installed with `npm ci`; Chromium, Firefox and WebKit installed explicitly.
- Chromium has passed the existing home/navigation/mobile/gallery/utilities/stress scripts against `dist` during development. Stale assertions for the retired navigation button and rendering hidden support plots were replaced with assertions for current behavior.
- Chromium and WebKit have passed the packaged route/utility/canvas/cache checks, including short viewports and a 960 × 540 viewport equivalent to a 1920 × 1080 screen at 200% zoom. Existing homepage tests additionally exercise CSS zoom and no-JavaScript/font/color-map failure cases.
- The original BFCache failure is recorded in `output/release/bfcache-before.log`; server diagnostics are in `output/release/bfcache-server-diagnosis.log`.
- Local Firefox fails before page acceptance on this Mac with sandbox-extension/compositor errors. Reinstallation, a software-rendering diagnostic and a headed launch did not resolve it. This is not a passing Firefox result. Linux CI retains the required Firefox checks.
- Stress browser execution uses one or two reported cores and SwiftShader WebGL 1/2. Physical GPU behavior is unverified; unavailable WebGPU is reported explicitly. Deterministic device-loss/completion tests supplement browser execution.
- The deployment size is measured by the build; no unmeasured bundle-size improvement is claimed.

## Commands and recorded outcomes

| Command | Outcome |
| --- | --- |
| `npm ci` | Passed. Existing dependency-audit advisories were emitted; this task did not perform a dependency security audit. |
| `npm run lint` | Passed. |
| `npm run format:check` | Passed. |
| `npm run check-links` | Passed, including current navigation/asset references. |
| `npm run utilities:check` | Passed: TypeScript and 277 tests across 32 files. |
| `npm run utilities:build` | Passed; committed output regenerated through Vite. |
| `npm run build:deploy` | Passed; artifact size is printed in bytes and MiB. |
| `npm run smoke` | Passed against source and required deployment output. |
| `CHECK_LINKS_ROOT=dist npm run check-links` | Passed against packaged HTML. |
| `npx playwright install chromium firefox webkit` | Completed; CI uses `--with-deps`. |
| `npm run home:check`, `npm run nav:check`, `npm run mobile:check`, `npm run gallery:check` | Passed against the served deployment via their URL environment settings. |
| `npm run utilities:browser-check`, `node scripts/stress-test-check.js` | Passed against deployment with bounded reported-core fixtures; WebGL 1/2 executed through SwiftShader. |
| `node scripts/cache-release-check.js` | Passed two actual release graphs, returning cache and explicit stale-module/worker recovery. |
| `RELEASE_BROWSERS=chromium,webkit npm run release:check` | All 12 requested groups passed locally; Firefox is explicitly omitted, not counted as a pass. |
| Local Firefox launch probes | Failed before page acceptance with host sandbox/compositor errors, including after reinstall. Required Linux CI runs Firefox separately. |
| WebKit BFCache control and site trips | Reloaded instead of restoring, including a minimal cacheable control; cached restoration is unverified. Other WebKit gallery and utility behavior passed. |
| Physical WebGPU/physical GPU benchmark | Not performed; deterministic WebGPU lifecycle integration and software WebGL acceptance are separate evidence. |

The first Linux CI run also exposed software-renderer saturation, a pending audio-unlock dependency, and a timeout cleanup gap for detached browser processes. New regressions reproduce these cases. Software GL now has a conservative render budget while hardware retains full scaling; analysis no longer waits for audio-device unlock; the runner terminates detached descendants and streams diagnostic output. These checks were kept and rerun.

The first regression runs deliberately exposed failures before correction (canvas initial ownership, startup await gap, telemetry source mixing, gallery mid-fade suspension and pre-existing inert state). Initial stale navigation/hidden-plot assertions and browser-harness assumptions were corrected rather than counted as passes. Browser reports include engine versions and console/resource failures. The final candidate handoff links required CI separately; a CI failure remains a blocker regardless of these local results.

[Complete changed-file inventory](changed-files.txt) lists source, tests, documentation and generated runtime output relative to the reviewed beta head. Representative screenshots include `output/release/chromium-desktop-gallery-restored.png`, `chromium-mobile-gallery-grid.png`, high-DPI audio images, and `output/playwright/stress-both-short.png`; the full run logs and JSON evidence are under `output/release/`.

See [validation and human release/rollback instructions](validation.md). This is not a security audit or a physical GPU benchmark campaign.
