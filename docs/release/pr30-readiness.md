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

The local integrated suite passes 278 tests in 32 files with the original ES2022 type contract. Exact browser command outcomes, commit identity and explicitly unverified capabilities are recorded in `output/release/results.json`; required GitHub CI must be green before merging.

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
| `npm run utilities:check` | Passed: TypeScript and 278 tests across 32 files. |
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

The first Linux CI run also exposed software-renderer saturation, a pending audio-unlock dependency, and a timeout cleanup gap for detached browser processes. New regressions reproduce these cases. Software GL now has a conservative render budget while hardware retains full scaling; analysis no longer waits for audio-device unlock; the runner terminates detached descendants and streams diagnostic output. The second Linux run passed Firefox but isolated a remaining WebGL 1 input/compositor starvation path. The self-posting MessageChannel was replaced with a yielding timer, with a scheduling/Stop regression. These checks were kept and rerun.

The first regression runs deliberately exposed failures before correction (canvas initial ownership, startup await gap, telemetry source mixing, gallery mid-fade suspension and pre-existing inert state). Initial stale navigation/hidden-plot assertions and browser-harness assumptions were corrected rather than counted as passes. Browser reports include engine versions and console/resource failures. The final candidate handoff links required CI separately; a CI failure remains a blocker regardless of these local results.

[Complete changed-file inventory](changed-files.txt) lists source, tests, documentation and generated runtime output relative to the reviewed beta head. Representative screenshots include `output/release/chromium-desktop-gallery-restored.png`, `chromium-mobile-gallery-grid.png`, high-DPI audio images, and `output/playwright/stress-both-short.png`; the full run logs and JSON evidence are under `output/release/`.

See [validation and human release/rollback instructions](validation.md). This is not a security audit or a physical GPU benchmark campaign.

## Second-round follow-up: R2-01

The second review found a remaining canvas-ownership race on beta candidate `471f970ee3e673873a7548691594adbfe2cc7c61`. An untracked initial idle animation callback could run after GPU initialization, request an incompatible 2D context and replace the canvas while GPU submissions remained pending. The controller continued reporting a running backend against the detached surface. The backing-size ownership guard alone did not cover context acquisition, clearing or replacement. Reduced-motion changes during asynchronous startup exposed the same path through `stopCpuVisuals()`.

This follow-up is limited to that lifecycle correction, deterministic regressions, regenerated runtime output and validation evidence. Physical GPU behavior remains outside the deterministic adapter evidence. The existing Firefox host-launch and Firefox/WebKit BFCache limitations remain explicitly distinguished from successful browser acceptance.

**Disposition: corrected.** The initial idle frame is tracked and cancelled on Start/dispose, with generation, idle-state and terminal-disposal checks if a retained callback still executes. A shared ownership predicate now protects context acquisition, clearing, CPU visual startup, canvas replacement and idle painting as well as backing-size writes. The reduced-motion handler can still cancel CPU visuals during pending GPU startup, but its clearing path cannot acquire or replace the claimed surface. Queued layout, resize and metric callbacks also stay inert after disposal. Backend-directed replacement and ownership release on Stop/failure remain available.

The real-controller/real-backend integration harness retains initial animation callbacks and invokes them after cancellation. Its per-canvas context exclusivity and deferred device/completion fixtures verify connected canvas identity, absence of 2D requests, idle marking, pending submissions and cleanup. Coverage includes live/pending WebGPU, the WebGL2 startup handoff and installed fallback, disposal with no pending frame, Start → Stop → Start, late idle painting during CPU-only rendering, reduced-motion changes followed by successful startup, WebGPU → WebGL2 replacement, GPU loss → CPU fallback, and Stop during pending device creation. Initial idle rendering and the existing resize/drain/Stop/failure controls remain covered.

Using the final 18 integration tests with only the controller restored to `471f970`, **10 failed and 8 passed**; the failures expose the canvas-ownership/lifecycle violations. Restoring the corrected controller yields **18 passing integration tests** and **289 passing tests across all 32 files**. The baseline log is retained locally in `output/pr30-r2/baseline-regressions.log`; this is deterministic fixture evidence, not physical-device testing. Existing acceptance scripts and thresholds are unchanged.

The local follow-up checks passed with Node `v22.23.0`, npm `10.9.8` and pinned Playwright `1.58.2`: `npm ci`, lint, formatting, TypeScript, the complete unit/integration suite, normal Vite bundle regeneration, deployment packaging, separate source/packaged smoke checks, and separate source/packaged link checks. Command exits and logs are recorded in `output/pr30-r2/checks.json` and `output/pr30-r2/build.json`. The isolated checkout uses its own pinned dependency installation; a temporary linked-dependency setup was replaced after Vite rejected an out-of-root VM asset, without changing application code or test gates.

Packaged browser evidence is recorded in `output/release/results.json` and per-check logs. The local command is `RELEASE_BROWSERS=chromium,webkit npm run release:check`; Firefox remains explicitly omitted locally because its launch probe still fails with the documented macOS sandbox/compositor error. Required Linux CI runs the unchanged complete Chromium/Firefox/WebKit matrix and uploads `release-validation-evidence` for the exact committed candidate. Local pre-commit evidence identifies the base SHA plus `worktreeDirty: true`; the final handoff must identify the new candidate and its CI run separately. Physical-GPU behavior remains unverified, and Firefox/WebKit BFCache restoration must not be inferred from their other browser checks. PR #30 remains for human review without merge, deployment or auto-merge.

## Third-round review follow-up

The independent review of `a55de5a1b97ac4c91aaaf32049ed3fb67e66c42d` confirmed the GPU canvas-ownership blocker was resolved and found no remaining deployment blocker. Its deterministic bundle replay and the passing 289-test/full-browser CI evidence are distinct from physical-device testing. This follow-up addresses only the review's small preference-sync issue: a reduced-motion change during asynchronous startup must be applied to the successfully installed GPU handle, after stale-generation and startup-failure checks, so later GPU submissions use the current preference.

**Disposition: corrected.** The successful handle receives the current reduced-motion value through its existing setter at the installation boundary. Two deterministic real-backend regressions defer adapter startup, toggle the preference in both directions, copy uniform payloads at `queue.writeBuffer`, and verify newly submitted post-installation animation times: zero when reduced motion is enabled, advancing when disabled. Restoring only the controller to `a55de5a` produces **2 failures and 18 passing integration controls**; the correction passes all **20 integration tests and 291 tests across 32 files**, plus TypeScript. Baseline and complete command evidence are in `output/pr30-r3/`.

A brief physical-device smoke also passed in installed Chrome 153 on the local Apple M4 Pro (20-core GPU), using the normal WebGPU backend and a non-fallback Apple `metal-3` adapter. GPU-only and combined mode rendered visibly, retained the connected GPU canvas, and completed real submitted work. Combined mode made CPU progress with the local two-worker debug limit. Stop returned to idle, released each GPU device, cleared the worker count and stopped further submissions during the post-Stop observation. Screenshots and native-call observations are in `output/playwright/pr30-r3/`; these wrap and forward the real browser GPU methods without a synthetic adapter. This is a brief check on one physical device, not an exhaustive GPU/driver benchmark. Earlier round-two statements about unverified hardware describe that earlier evidence; this smoke supplies the requested additional device check.

Lint, formatting, TypeScript, the complete test suite, normal utilities bundle regeneration, deployment packaging, source/packaged smoke checks and source/packaged link checks passed for this follow-up. The final handoff records the new candidate's hosted CI and packaged Chromium/Firefox/WebKit acceptance results. Firefox/WebKit BFCache restoration retains its previously documented non-blocking limitation. PR #30 is left open for the human merge/deployment decision; this work does not enable auto-merge, merge or deploy.

The final hosting check found Pages still using legacy `main`-root publishing. It was switched to GitHub Actions publishing (`build_type: workflow`) to match the validated-artifact release path. The `github-pages` environment remains restricted to `main`, the custom domain and remaining Pages settings were preserved, and the latest deployment record was unchanged before/after the configuration update. No candidate content was deployed. The final handoff retains the configuration and deployment-record evidence.
