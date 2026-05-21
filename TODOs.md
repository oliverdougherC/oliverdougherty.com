# Website Code Review TODOs
Generated: Thursday, May 21, 2026

## Home Page

### Accessibility

- [ ] [Priority: LOW] [Accessibility] `.marquee-track` animation on the home page relies on the global `prefers-reduced-motion` rule in design-system.css to stop. Consider adding an explicit pause in schematic.css for clarity and resilience if the global rule is ever removed. (css/schematic.css:402-405, handled by css/design-system.css:1442-1452)

### Performance

- [ ] [Priority: MED] [Performance] Google Fonts loaded via `<link rel="stylesheet">` without `rel="preload"` for the critical font CSS. This can cause FOIT (Flash of Invisible Text) on the hero wordmark which depends on JetBrains Mono. Consider preloading the font CSS or using `font-display: optional`. (index.html:16-18)
- [ ] [Priority: LOW] [Performance] `starfield.js` fallback renderer registers `resize`, `visibilitychange`, and `utilities-load-state` listeners at script-load time (outside DOMContentLoaded). If the canvas element is absent, these listeners persist for the page lifetime with no cleanup. (js/starfield.js:622-640)

### Code Quality

- [ ] [Priority: MED] [Code Quality] Worker body serialized via `Function.prototype.toString()` is fragile under minification (comments stripped, arrow functions rewritten, unused locals removed). If a build pipeline is ever introduced, this will silently break. Consider extracting the worker to a separate file. (js/starfield.js:49-53)
- [ ] [Priority: LOW] [Code Quality] Dead CSS rules for legacy cursor elements (`.cursor-dot`, `.cursor-circle`) set to `display: none`. Safe to remove since the comment confirms they are no longer used. (css/design-system.css:906-911)
- [ ] [Priority: LOW] [Code Quality] `debounce()` utility defined at line 677 is only called once (line 287, as a ResizeObserver fallback). Consider inlining or removing if the fallback path is deemed unnecessary for modern browsers. (js/main.js:677-686, used at js/main.js:287)
- [ ] [Priority: LOW] [Code Quality] `typeof Element === 'undefined'` guard at line 526 is unnecessary in a browser-only context. The check never triggers. (js/main.js:526)

### Security

- [ ] [Priority: LOW] [Security] `window.revealNavDot` and `window.revealDeferredElements` are exposed on the global `window` object for cross-script use. While documented and intentional, this pollutes the global namespace. Consider a more scoped approach (e.g., `window.oliver` namespace or CustomEvents) if the surface grows. (js/main.js:38-39)

## Resume Page

### Accessibility

- [ ] [Priority: MED] [Accessibility] Empty typewriter cursor `<span id="typeCursor">` lacks `aria-hidden="true"`. Screen readers may announce it as empty content. Since it is a purely decorative animation element, add `aria-hidden="true"`. (pages/resume/index.html:88)
- [ ] [Priority: LOW] [Accessibility] Redundant `<span class="sr-only" data-nav-toggle-label>Open menu</span>` inside the nav toggle button. The button already has `aria-label="Open menu"` which provides the accessible name. The inner span duplicates it and adds no value. (pages/resume/index.html:52)

### Code Quality

- [ ] [Priority: MED] [Code Quality] Dead CSS: `.footer` and `.footer-text` rules are defined but no `<footer>` element exists in the resume page HTML. Either add a footer element or remove these rules. (css/resume.css:728-736)
- [ ] [Priority: LOW] [Code Quality] Redundant selector `a.skill-tag { color: #000000; }` — `.skill-tag` already sets `color: #000000` at line 645. The `a.skill-tag` override does nothing. (css/resume.css:654-656)
- [ ] [Priority: LOW] [Code Quality] Redundant `a.skill-tag:hover` in the hover rule — `.skill-tag:hover` already covers all `.skill-tag` elements regardless of tag type. (css/resume.css:658-661)

### Performance

- [ ] [Priority: LOW] [Performance] `mobile-gate.js` is loaded as a non-deferred blocking script in the `<head>`. It runs before DOM construction which is intentional for mobile redirection, but consider adding `async` or moving it lower if the redirect logic does not need to block parsing. (pages/resume/index.html:18)

### Structure

- [ ] [Priority: LOW] [Structure] Page has no `<footer>` element. The CSS defines `.footer` styles and the `year.js` script likely targets a footer year element, but the HTML lacks a footer section. This breaks semantic page structure (header/main/footer). (pages/resume/index.html)

## Photo Gallery Page

### Accessibility

- [ ] NOTE: [Priority: MED] [Accessibility] Hero `<img>` has empty `alt=""` attribute — FALSE POSITIVE. JS (`syncHeroFeature()` at gallery.js:370) populates `alt` with `entry.displayTitle` before the image is visible. The image is dynamically populated by JS. (pages/gallery/index.html:76)
- [ ] NOTE: [Priority: MED] [Accessibility] Lightbox `<img>` has empty `alt=""` attribute — FALSE POSITIVE. JS (`renderLightboxEntry()` at gallery.js:695) populates `alt` with `entry.displayTitle` before the image is displayed. The image is dynamically populated by JS. (pages/gallery/index.html:168)
- [ ] [Priority: LOW] [Accessibility] Redundant `<span class="sr-only" data-nav-toggle-label>Open menu</span>` inside the nav toggle button. The button already has `aria-label="Open menu"` which provides the accessible name. The inner span duplicates it and adds no value. Same issue found on the resume page. (pages/gallery/index.html:32)

### Code Quality

- [ ] [Priority: MED] [Code Quality] `cleanupLightboxImageOpacity()` is called without an `event` argument in `closeLightbox()` (line 819). The function checks `event.propertyName !== 'opacity'` which evaluates to `undefined !== 'opacity'` = `true`, causing an early return. The inline `style.opacity` set during navigation is therefore never cleaned up when the lightbox closes, leaving a stale inline style on the element. (js/gallery.js:819)
- [ ] [Priority: MED] [Code Quality] `gallery.preloadImages` array is populated in `preloadAdjacentEntries()` (lines 1026, 1033) but is never read, iterated, or used for cleanup. It is reset to `[]` on the next call, so the previous Image objects are simply orphaned for GC. The array serves no purpose and can be removed. (js/gallery.js:1026,1033)
- [ ] [Priority: MED] [Code Quality] `refreshLightboxFocusables()` is called redundantly on lightbox open: once in `openLightboxById` (line 657) and again inside `renderLightboxEntry` (line 716), which is called by `openLightboxById` at line 656. Each call iterates all lightbox children and calls `getComputedStyle`, so this double-calls layout-triggering code unnecessarily. (js/gallery.js:656-657, 716)

### Performance

- [ ] [Priority: LOW] [Performance] `refreshLightboxFocusables()` calls `window.getComputedStyle(element)` for every focusable element inside the lightbox (line 928). This forces synchronous layout recalculation on each call. Consider caching the result or using a less expensive visibility check. (js/gallery.js:928)
- [ ] [Priority: LOW] [Performance] `buildLightboxThumbStrip()` renders all thumbnail buttons at once (lines 611-642). For large galleries (100+ photos), this creates hundreds of DOM nodes and image elements simultaneously. Consider lazy-rendering or virtualizing the thumb strip. (js/gallery.js:611-642)

### Structure

- [ ] [Priority: LOW] [Structure] Page has no `<footer>` element. The `year.js` script likely targets a footer year element. This breaks semantic page structure (header/main/footer). Same issue found on the resume page. (pages/gallery/index.html)

## Utilities Home Page

### Accessibility

- [ ] [Priority: MED] [Accessibility] Decorative `<canvas id="starfield">` lacks `aria-hidden="true"`. Screen readers may attempt to announce the canvas as an empty image or ignore it inconsistently across browsers. Add `aria-hidden="true"` to signal it is purely visual background. (pages/utilities/index.html:24)
- [ ] [Priority: MED] [Accessibility] Decorative `<div class="noise-overlay">` lacks `aria-hidden="true"`. It renders a visual noise texture but has no accessible markup to indicate it is decorative. (pages/utilities/index.html:25)

### Performance

- [ ] [Priority: MED] [Performance] `.demo-chip-minimal` uses `transition: all` (css/utilities.css:1092). Transitioning `all` properties can trigger expensive layout recalculations when non-composited properties change. Replace `all` with the specific properties being animated (e.g., `background, border-color, color, transform, opacity`). (css/utilities.css:1092)

### Code Quality

- [ ] NOTE: [Priority: MED] [Code Quality] Excessive `!important` usage in css/utilities.css (9 instances across lines 60, 86, 88, 1332, 1872, 1873, 2102, 3389, 3390) — FALSE POSITIVE. All 9 instances are intentional forced state overrides: line 60 (`.nav-home-btn:hover` opacity), lines 86/88 (`.nav-home-btn` hidden via `html[data-active-utility]`), line 1332 (`[hidden]` display), lines 1872/1873 (reduced-motion animation/transition kill), line 2102 (`.death-screen[hidden]` display), lines 3389/3390 (`.utility-stage.is-active [data-animate]` forced visibility). These are legitimate utility class overrides, not specificity management issues. (css/utilities.css)
- [ ] [Priority: LOW] [Code Quality] `window['__utilitiesShellController__']` at line 338 exposes a controller object on the global `window` namespace. While the key is obfuscated, this pollutes the global scope. Consider using a `WeakMap` keyed by the DOM root element or a `window.oliver` namespace object instead. (js/utilities-shell.js:338)
- [ ] [Priority: LOW] [Code Quality] Inline `<script type="application/json" id="retroVmConfig">` block (281-295) embeds VM configuration directly in the HTML. This is reasonable for a static site, but if configuration grows or needs server-side injection, consider moving to a separate `.json` file loaded via `fetch()`. (pages/utilities/index.html:281-295)

### Error Handling

- [ ] [Priority: LOW] [Error Handling] `loadLocalAssistantScript()` caches its result in `localAssistantScriptPromise`. On failure, the promise is reset to `null` (line 129), allowing retries. However, the `.catch()` attached at line 139 runs on every rejection before the caller's `.catch()` at line 186. This means errors are logged twice (once here, once in `activateStage`). Consider removing the redundant catch at line 139-147 and letting `activateStage` handle error rendering, or use a single error-handling path. (js/utilities-shell.js:139-147, 186-193)

## Fourier Utility

### Code Quality

- [ ] [Priority: HIGH] [Code Quality] No test files exist for the Fourier Utility module. The glob `utilities-src/tests/audioFourier*.test.ts` matches nothing -- the `tests` directory appears to be empty or absent entirely. This module contains complex FFT logic, Web Worker message passing, and WebGL rendering, all of which would benefit from unit tests. (utilities-src/tests/)
- [ ] [Priority: MED] [Code Quality] `AudioFourierController` is a single monolithic class at 1444 lines handling UI state, Web Worker lifecycle, Audio API playback, Canvas/WebGL rendering, and resize management. Consider splitting into smaller focused classes (e.g., `AudioFourierPlayback`, `AudioFourierVisualizer`, `AudioFourierWorkerManager`) for testability and maintainability. (utilities-src/src/audioFourierController.ts)
- [ ] [Priority: LOW] [Code Quality] Redundant check in worker message handler: `isAudioFourierAnalyzeRequest` already validates that `presetId` is a string (line 50), but the handler re-checks `if (!request.presetId)` at line 302. The second check can never trigger. (utilities-src/src/audioFourier.worker.ts:302-309)
- [ ] [Priority: LOW] [Code Quality] Worker maintains module-level mutable state (`cancelledRequests` Set, `pendingRequests` array, `isProcessing` flag) that persists across requests. If the worker is reused across multiple `AudioFourierController` instances or if the page creates multiple workers, stale state from prior requests could leak. Consider scope guards or explicit reset paths. (utilities-src/src/audioFourier.worker.ts:15-18)

### Error Handling

- [ ] [Priority: MED] [Error Handling] Worker `messageerror` handler calls `handleWorkerFailure()` without inspecting `event.data` or `event.filename`/`event.message`. The `messageerror` event fires when deserialization fails (e.g., transferred ArrayBuffer was already consumed). Logging the event details would help diagnose serialization bugs. (utilities-src/src/audioFourierController.ts:721-726)
- [ ] [Priority: LOW] [Error Handling] `onended` callback is only attached to `firstNode.source` (line 1096). If the first band buffer is shorter than others (e.g., due to a decoding edge case), playback could end before all bands finish, leaving orphaned AudioBufferSourceNodes still running. (utilities-src/src/audioFourierController.ts:1094-1111)

### Performance

- [ ] [Priority: MED] [Performance] Worker silently drops oldest pending request when queue exceeds `MAX_PENDING_REQUESTS` (line 311-313) without notifying the main thread. The dropped request's `requestId` is never matched, so the controller stays in `processing` state until timeout or manual reset. (utilities-src/src/audioFourier.worker.ts:311-313)
- [ ] [Priority: LOW] [Performance] `resolveVisibleMixedAmplitude` iterates all bands for every bucket on every render frame during animation. With 12-20 bands and hundreds of buckets, this is O(bands * buckets) per frame. Consider caching or incremental updates when band gains haven't changed. (utilities-src/src/audioFourierController.ts:961-980)

### TypeScript

- [ ] [Priority: LOW] [TypeScript] `isAudioFourierAnalyzeRequest` casts `request` to `{ source?: unknown }` and checks `=== 'object'`, which passes for `null` and arrays. The subsequent null check on line 52 catches `null`, but arrays would pass the guard. The function should add `Array.isArray` exclusion or check for the specific `channelBuffers` property. (utilities-src/src/audioFourier.worker.ts:44-53)

## Local Assistant Utility

### Performance

- [ ] [Priority: HIGH] [Performance] `renderMessages()` has an O(n*m) WeakMap lookup pattern. Lines 841-848 iterate all DOM `<article>` children and, for each one, iterate the entire `_messageElements` WeakMap to find the matching message object. With N messages this is O(N^2). Replace with a `Map<HTMLElement, LocalLlmMessage>` for O(1) lookups, or store a data attribute on the article referencing the message. (js/local-llm-chat.js:841-848)

### Security

- [ ] NOTE: [Priority: MED] [Security] `flushStatePanelRender()` sets `this.loadCopy.innerHTML` at lines 621, 625, 629 with `safeCopy` — FALSE POSITIVE. `safeCopy` is computed via `escapeHtml(copy)` (for busy states) or `renderSafeInlineText(copy)` (for non-busy states, which itself calls `escapeHtml()` first). All data sources are static constants (`STATE_COPY`, `LOAD_SEQUENCE_COPY`, `READY_SUGGESTIONS`). The content is sanitized before being set via innerHTML. (js/local-llm-chat.js:621,625,629)

### Accessibility

- [ ] [Priority: MED] [Accessibility] The typing indicator (`<span class="local-llm-typing" id="localLlmTyping">` at line 146) is a purely visual animation with no `aria-live` region or `aria-label` to announce the "assistant is typing" state to screen readers. The status chip has `aria-live="polite"` but it announces "Thinking locally" / "Streaming locally" text, not the typing dots. Consider adding `aria-hidden="true"` to the typing dots and ensuring the live region or status chip communicates the typing state. (js/local-llm-chat.js:146, css/local-llm-chat.css:626-650)

### Code Quality

- [ ] [Priority: LOW] [Code Quality] The `didTrim` check at line 780 is unnecessarily complex. `trimmed.some((message, index) => message !== this.messages[index])` compares object references, but `trimHistory()` always returns a new array with new references (from `slice` and spread), so this check is effectively always true when lengths match. The whole `didTrim` branch can be simplified to `trimmed.length !== this.messages.length`. (js/local-llm-chat.js:780)

- [ ] [Priority: LOW] [Code Quality] `buildFailureCopy()` uses `console.warn` at line 1253 when diagnostics are unavailable. Since this function is only called during error states, `console.warn` adds noise to the error console. Downgrade to `console.debug` to match the error-handling logging pattern used elsewhere (e.g., lines 1053, 1075, 1102). (js/local-llm-chat.js:1253)

- [ ] [Priority: LOW] [Code Quality] `renderSafeInlineText()` (lines 1278-1283) is a local function that duplicates the escape-then-render pattern of the imported `renderSafeText` but with a simpler markdown subset. If the two rendering paths ever diverge in security behavior, this creates a maintenance risk. Consider extracting the escape step and having both functions share it. (js/local-llm-chat.js:1278-1283)

### Browser Compatibility

- [ ] [Priority: LOW] [Browser Compatibility] `color-mix()` is used extensively throughout `css/local-llm-chat.css` (50+ instances). While rgba fallbacks are provided via duplicate declarations, the comment at lines 18-25 notes these are "visually matched, not mathematically identical." Browsers that don't support `color-mix()` (Safari < 16.4, Firefox < 124, Edge < 124) will see slightly different colors. For a personal portfolio this is acceptable, but worth noting. (css/local-llm-chat.css)

## Virtual Machine Utility

### Error Handling

- [ ] [Priority: HIGH] [Error Handling] `showConfirmModal()` has a dead fallback path. The guard at line 144 checks `typeof document === 'undefined' || typeof window.confirm === 'function'` but the if block is empty. If `document` is undefined (SSR), the function crashes at line 148 calling `document.createElement()`. If the intent was to fall back to `window.confirm()`, the call is missing. Either implement the `window.confirm` fallback or remove the dead guard. (utilities-src/src/retroVmController.ts:144-146)

### TypeScript

- [ ] [Priority: MED] [TypeScript] `readRetroVmJsonConfig()` at line 24 uses `parsed && typeof parsed === 'object'` which passes for `null` and arrays. The `null` case is caught by the `parsed &&` truthiness check, but arrays would pass through to `readRetroVmDatasetConfig()`. Add `!Array.isArray(parsed)` to the guard. (utilities-src/src/retroVmController.ts:24)

- [ ] [Priority: LOW] [TypeScript] Test file uses `(window as any).__OD_RETRO_VM_TEST_MODE__` at lines 136 and 140. The global interface is declared in `retroVmController.ts` (lines 33-37) but the test file does not import the controller module in a way that exposes the global augmentation. Import the controller or declare the augmentation locally to eliminate the `as any` cast. (utilities-src/tests/retroVmController.test.ts:136,140)

### Security

- [ ] [Priority: LOW] [Security] `pasteClipboard()` reads raw clipboard text and sends it directly to the guest VM via `keyboard_send_text()` (line 861). While there is a confirmation modal and a 2048-char truncation limit, the pasted text is sent as keystrokes without any content filtering. A user could accidentally paste malicious shell commands (e.g., reverse shells, token exfiltration scripts) into the guest OS. Consider adding a warning for text containing shell metacharacters or common command patterns. (utilities-src/src/retroVmController.ts:861)

### Code Quality

- [ ] [Priority: LOW] [Code Quality] `sendAbsolutePosition()` (line 447) and `sendAbsolutePositionFromPoint()` (line 468) both compute `safeScale = viewport.scale || 1`. The `||` fallback is redundant since both callers already check `viewport.scale <= 0` and return early. The `|| 1` can never trigger. Same pattern in `sendLockedDelta()` at line 498. (utilities-src/src/retroVmController.ts:447,468,498)

- [ ] [Priority: LOW] [Code Quality] `autoAdvanceBootMenu()` at line 933 uses a very short `timeout_msec: 500` for the second boot-menu visibility check. If the guest rendering is slow, this 500ms timeout may miss the prompt and skip the second Enter key dispatch, leaving the VM stuck at the boot menu. Consider increasing to at least 1000-2000ms. (utilities-src/src/retroVmController.ts:933-935)

- [ ] [Priority: LOW] [Code Quality] `build-retro-vm-image.sh` mounts the entire repository root into the Docker container at line 61 (`-v "${ROOT_DIR}:/repo"`). This exposes all project files to the container's filesystem. Consider narrowing the mount to only the required subdirectories (e.g., `assets/utilities/vm`, `vm-src`, `.tmp`) to reduce the attack surface. (scripts/build-retro-vm-image.sh:61)

### Performance

- [ ] [Priority: LOW] [Performance] `syncUi()` at line 1102 is called on every state change, progress update, and capture state change. It performs DOM writes (textContent, className, style.width) and calls `applyRuntimeLabels()` and `applyInteractionStatusCopy()` on every invocation. Consider batching DOM updates with `document.startViewTransition()` or deferring non-critical updates when rapid state changes occur (e.g., during download progress). (utilities-src/src/retroVmController.ts:1102-1138)

### Browser Compatibility

- [ ] [Priority: LOW] [Browser Compatibility] `requestPointerLock({ unadjustedMovement: true })` at line 525 uses the `unadjustedMovement` option which is not supported in all browsers (e.g., Firefox does not support it). The fallback at line 526 calls `requestPointerLock()` without options, which is correct, but the `.catch()` on line 526 swallows the error from the first attempt silently before the fallback fires. Consider using a feature detection check before passing the option. (utilities-src/src/retroVmController.ts:525-526)

## Stress Test Utility

### Performance

- [ ] [Priority: MED] [Performance] `resolveDisplayRefreshRate()` is called on every WebGL frame inside `resolveWebGlWorkloadLevel()` (line 1052). This reads `window.screen.refreshRate` on every animation frame, which is unnecessary since the display refresh rate does not change during a stress test session. Cache the result at session start or in the constructor. (utilities-src/src/stressTestController.ts:1052, 215-218)
- [ ] [Priority: LOW] [Performance] `renderCpuVisualsFrame()` creates multiple `CanvasGradient` objects per frame (radial gradients for 42 thermal nodes, a linear gradient for background, and linear gradients for each worker packet). These allocations on every animation frame create GC pressure. Consider pre-allocating and reusing gradient objects, or drawing with `arc()` strokes instead of gradient fills. (utilities-src/src/stressTestController.ts:1160-1267)
- [ ] [Priority: LOW] [Performance] `syncMetrics()` writes 11+ `dataset` attributes to `this.root` on every metric update (lines 1318-1327). While throttled to 250ms, each `dataset` write can trigger CSS attribute selector re-evaluation. Consider batching writes or using a single serialized data attribute. (utilities-src/src/stressTestController.ts:1318-1327)

### Accessibility

- [ ] NOTE: [Priority: MED] [Accessibility] The status text element (`stressStatusText`) updated via `setState()` (line 1346) uses `textContent` but the element likely lacks `aria-live="polite"` or `role="status"` — FALSE POSITIVE. The element at `pages/utilities/index.html:337` already has `aria-live="polite"`: `<p class="stress-warning" id="stressStatusText" aria-live="polite">`. (utilities-src/src/stressTestController.ts:1346, pages/utilities/index.html)
- [ ] [Priority: LOW] [Accessibility] The stress test canvas is an animated visualization whose information is fully conveyed by the metrics panel. Consider adding `aria-hidden="true"` to the canvas when the stress test is running so screen readers focus on the metrics rather than encountering a canvas with a generic "Stress test output" label. (utilities-src/src/stressTestController.ts:291, 1449)

### Code Quality

- [ ] [Priority: MED] [Code Quality] `replaceCanvasElement()` (lines 1441-1458) duplicates the canvas replacement logic found in `startCpuVisuals()` (lines 1106-1121). Both methods create a new canvas, copy `id`, `aria-label`, `dataset.stressIdle`, `style.cssText`, replace in DOM, rebind the ResizeObserver, and set dimensions. The logic in `startCpuVisuals()` should call `replaceCanvasElement()` instead of duplicating it. (utilities-src/src/stressTestController.ts:1106-1121, 1441-1458)
- [ ] [Priority: LOW] [Code Quality] `canCreateContext()` sets `canvas.width = 0` and `canvas.height = 0` in the `finally` block (lines 615-616) for a detached canvas element that was never appended to the DOM. These assignments have no effect on a detached element and can be removed. (utilities-src/src/stressTestController.ts:615-616)
- [ ] [Priority: LOW] [Code Quality] `syncCanvasSize()` is called both directly (from `prepareGpuCanvas()`, `startCpuVisuals()`, `clearCanvasSurface()`) and indirectly via `queueCanvasResizeSync()`. The rAF-based deduplication in `queueCanvasResizeSync()` only helps for rapid resize events, not for the synchronous call chains. The direct callers could benefit from the same deduplication guard. (utilities-src/src/stressTestController.ts:1419-1439)

### TypeScript

- [ ] [Priority: LOW] [TypeScript] `WebGpuShaderModuleLike`, `WebGpuBindGroupLayoutLike`, `WebGpuPipelineLayoutLike`, `WebGpuComputePipelineLike`, and `WebGpuBindGroupLike` are empty interfaces (lines 49-57). These provide no compile-time type safety -- they are equivalent to `object` and will accept any non-nullish value. Consider adding a branded property (e.g., `readonly _brand: 'WebGpuShaderModuleLike'`) or using `unknown` with runtime type guards. (utilities-src/src/stressTestController.ts:49-57)

### Error Handling

- [ ] [Priority: LOW] [Error Handling] `getWebGpuUsageFlag()` and `getWebGpuTextureUsageFlag()` return `0` when the requested flag is unavailable (lines 203, 212). A value of `0` is a valid bitflag (meaning "no usage"), so the caller in `startWebGpuStress()` (lines 758, 772) would create buffers with zero usage, which WebGPU would reject at runtime. The `console.warn` at lines 201 and 210 provides visibility, but the function should throw instead of silently returning an invalid value. (utilities-src/src/stressTestController.ts:197-213, 758, 772)

## Archive/Mobile/Game Pages

### Bug

- [ ] [Priority: HIGH] [Bug] `debounce()` is called in `js/archive.js` at line 44 but is not available globally. The `debounce` utility is defined inside the IIFE in `js/main.js` (line 677) and is never exposed on `window`. Since both scripts use `defer` and main.js loads first, the IIFE executes but `debounce` remains scoped. This throws a `ReferenceError` during `DOMContentLoaded`, completely breaking the archive search functionality. Expose `debounce` on `window` or inline a local debounce in archive.js. (js/archive.js:44, js/main.js:677-686)

- [ ] [Priority: HIGH] [Bug] Malformed closing script tag in archive sub-page. Line 10 ends with `</script>script>` -- the extra `script>` is parsed as text content after the script closes, which is invalid HTML. While most browsers recover gracefully, this is a clear HTML error that could cause unpredictable parsing in strict parsers. (pages/archive/av1/av1.html:10)

- [ ] [Priority: MED] [Bug] Extra `</div>` in footer of archive sub-page. The footer at lines 305-309 has a nested closing structure: `</div>    </div>` inside the footer, suggesting an extra closing div tag. This breaks the footer's DOM structure. (pages/archive/av1/av1.html:308)

### Accessibility

- [ ] [Priority: MED] [Accessibility] Tab buttons in archive sub-pages lack ARIA tab roles and keyboard navigation. The tabs at lines 129-131 use plain `<button>` elements without `role="tab"`, `aria-selected`, or `role="tablist"` on the container. Arrow key navigation between tabs is not implemented. Screen readers announce them as generic buttons with no relationship. (pages/archive/av1/av1.html:129-131)

- [ ] [Priority: MED] [Accessibility] Chart `<canvas>` element lacks accessible description. The performance chart canvas at line 246 has no `role="img"`, `aria-label`, or associated `<figcaption>`. Screen readers cannot describe the chart data. Add an aria-label like "Bar chart showing AV1 bitrate savings versus H.264, VP9, and H.265" and consider adding a data table fallback. (pages/archive/av1/av1.html:246)

- [ ] [Priority: LOW] [Accessibility] `nav-overlay` in mobile/resume/index.html lacks initial `aria-hidden="true"`. Before `main.js` runs and calls `closeMobileNav()`, the overlay is technically visible to assistive technologies. Add `aria-hidden="true"` to the initial HTML. (mobile/resume/index.html:167)

### Performance

- [ ] [Priority: MED] [Performance] Chart.js defaults are modified globally in archive sub-pages. Lines 338-339 set `Chart.defaults.color` and `Chart.defaults.borderColor`, which affects ALL Chart.js instances on the page and persists if the user navigates to another page using the same Chart.js instance (SPAs or bfcache). Use per-chart configuration instead of modifying global defaults. (pages/archive/av1/av1.html:338-339)

- [ ] [Priority: LOW] [Performance] Archive sub-pages load Chart.js from CDN synchronously (no `defer`/`async` on the script tag at line 19). While `defer` is present, the script blocks parsing until downloaded. Since Chart.js (~200KB minified) is only needed for the chart near the bottom of the page, consider lazy-loading it when the chart section enters the viewport. (pages/archive/av1/av1.html:19)

### Code Quality

- [ ] [Priority: MED] [Code Quality] Inline script in archive sub-pages modifies global Chart.js configuration. The entire tab-switching and chart logic (lines 311-403) is embedded inline rather than extracted to a shared module. This pattern is repeated across multiple archive sub-pages (videocodecs, ft_fft, etc.), creating maintenance duplication. (pages/archive/av1/av1.html:311-403)

- [ ] [Priority: LOW] [Code Quality] Favicon swap inline script is duplicated across every page. The same minified `visibilitychange` listener appears on lines 10-11 of nearly every HTML file (archive, game, mobile, archive sub-pages, etc.). Extract to a shared `js/favicon-swap.js` file. (pages/archive/index.html:10, pages/game/index.html:10, mobile/index.html:11, and all archive sub-pages)

- [ ] [Priority: LOW] [Code Quality] `createArchiveState()` at line 17 maps all report cards at page load time, extracting text content for search. If the HTML is ever generated dynamically or loaded via fetch, this initial snapshot would be stale. Currently fine since cards are static, but worth noting for future-proofing. (js/archive.js:17-27)

### Security

- [ ] [Priority: LOW] [Security] Archive sub-pages load Chart.js from `cdn.jsdelivr.net` via HTTPS with SRI integrity check, which is good practice. However, the inline script at lines 311-403 accesses the global `Chart` object without verifying it loaded successfully. If the CDN is blocked or fails, `new Chart()` throws a ReferenceError. Add a guard checking `typeof Chart !== 'undefined'`. (pages/archive/av1/av1.html:341)
