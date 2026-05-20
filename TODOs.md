# Website Code Review TODOs
Generated: Wednesday, May 20, 2026

## Home Page

### Browser Compatibility
- [ ] NOTE: [Priority: MED] [Browser Compatibility] `color-mix()` used extensively in `css/design-system.css` (lines 278, 621, 622, 632, 633, 684, 950, 1232, 1294) without fallback. Not supported in Safari < 16.2 or Firefox < 117. Consider providing fallback `background`/`border-color` declarations before the `color-mix()` line so older browsers degrade gracefully. (VERIFIED: every `color-mix()` line is preceded by a hardcoded fallback value — e.g., line 619 `background: #F7F8F6` before line 621, line 620 `border-color: #C7D1C4` before line 622, line 949 before 950, line 1231 before 1232, line 1293 before 1294, line 683 before 684. This is the intentional Firefox fallback pattern.)
- [ ] [Priority: LOW] [Browser Compatibility] CSS `max()` function used in `css/schematic.css:277` (`max(0.75px, 0.007em)`) is not supported in older browsers (Firefox < 110, Safari < 15.4). Provide a static fallback.
- [ ] [Priority: LOW] [Browser Compatibility] `mask-composite: exclude` in `css/design-system.css:602` is not supported in Firefox. The `-webkit-mask-composite: xor` fallback covers Safari/Chrome but Firefox renders the card border gradient incorrectly. Consider a `@supports` block or alternative approach.

### Performance & Memory
- [ ] [Priority: MED] [Memory] `ResizeObserver` created in `initBlueprintWordmark()` (`js/main.js:261-262`) is never disconnected. If the `.blueprint-title` element is ever removed from the DOM, the observer retains a strong reference causing a memory leak. Store the observer reference and call `.disconnect()` on cleanup or when the blueprint animation completes permanently.
- [ ] NOTE: [Priority: LOW] [Performance] `initNavigation()` adds a scroll listener at `js/main.js:468` that references `document.getElementById('nav')` (`js/main.js:305`). On the home page there is no element with `id="nav"` (the home page uses the `nav-dot` / `navOverlay` pattern instead). The `if (nav)` guard at line 466 prevents errors, but the listener setup is wasted work on pages without a `#nav` element. Consider moving the scroll listener inside the `if (nav)` block so it is only attached when needed. (VERIFIED: the scroll listener at line 468 is already inside the `if (nav)` block at lines 466-469. The suggestion is already implemented.)

### Code Quality
- [ ] [Priority: LOW] [Code Quality] `confettiFired` module-level flag (`js/main.js:20`) is never reset on bfcache restore. If a user navigates away and returns via back-forward cache, the confetti effect will not fire again because the flag persists. Consider resetting it in the `pageshow` handler at `js/main.js:446-453`.
- [ ] [Priority: LOW] [Code Quality] Significant code duplication between the worker renderer (`js/starfield.js:116-364`) and main-thread fallback (`js/starfield.js:366-647`). Functions like `createStar`, `spawnComet`, `update`, and `draw` are nearly identical. This is unavoidable due to the Web Worker boundary, but extracting shared constants (`BASE_STAR_COUNT`, `BASE_SPEED`, `MAX_DPR`, `STAR_COLORS`) to a shared config object would reduce drift risk.

### Accessibility
- [ ] [Priority: LOW] [Accessibility] The redundant `aria-hidden="true"` on the second `.marquee-inner` span (`index.html:80`) can be removed since the parent `.marquee-track` already has `aria-hidden="true"`, which hides all descendants. Minor cleanup.

## Resume Page

### Performance
- [ ] [Priority: LOW] [Performance] Google Fonts loaded with `rel="stylesheet"` at `pages/resume/index.html:26` is render-blocking. Consider using the `media="print"` + `onload="this.media='all'"` swap pattern for non-blocking font loading, reducing initial paint time.

### Code Quality
- [ ] NOTE: [Priority: LOW] [Code Quality] `!important` used at `css/resume.css:71` (`.nav-overlay-bg { background-color: #FFFFFF !important; }`). Could be resolved with a more specific selector to avoid specificity escalation. (VERIFIED: this is page-specific CSS for the resume page's light theme override, which is an intentional use of `!important` per known patterns.)

### Accessibility
- [ ] [Priority: LOW] [Accessibility] No explicit `:focus` styles defined in `css/resume.css`. Interactive elements (`.nav-dot`, `.contact-item`, `.project-link`, `.skill-tag`) rely on browser defaults or global styles from `design-system.css`. Verify that `design-system.css` provides visible focus indicators; if it strips default outlines without replacements, keyboard users lose focus visibility on the resume page.

## Photo Gallery Page

### Browser Compatibility
- [ ] [Priority: HIGH] [Browser Compatibility] `inert` attribute used in `setPageInert()` (`js/gallery.js:779`) to lock focus inside the lightbox. Not supported in Safari < 15.4 or Firefox < 89. Without a polyfill, keyboard users on those browsers can tab outside the lightbox dialog. Consider adding an `inert` polyfill (e.g., `@oddbird/css-inert` or a JS shim) or falling back to `tabindex="-1"` on focusable descendants.
- [ ] [Priority: HIGH] [Browser Compatibility] `Element.replaceChildren()` used at `js/gallery.js:387` (`container.replaceChildren(fragment)`) and `js/gallery.js:585` (thumb strip). Not supported in Safari < 15.4. Replace with `container.innerHTML = ''` followed by `container.appendChild(fragment)`, or use `while (container.firstChild) container.removeChild(container.firstChild)`.
- [ ] [Priority: MED] [Browser Compatibility] `scrollIntoView({ inline: 'center' })` at `js/gallery.js:656`. The `inline` option is not supported in Safari < 15.4. Provide a fallback like `scrollIntoView({ block: 'nearest', behavior: 'smooth' })` or detect support before passing `inline`.
- [ ] [Priority: MED] [Browser Compatibility] CSS `aspect-ratio` used at `css/gallery.css:124` (`.hero-feature-media`), `:339` (`.photo-media`), and `:838` (`.lightbox-thumb img`). Not supported in Safari < 15. Provide a `padding-top` ratio fallback for those breakpoints.
- [ ] [Priority: MED] [Browser Compatibility] CSS `clamp()` used extensively throughout `css/gallery.css` (e.g., lines 62, 105, 220, 289, 690, 973) without fallback. Not supported in Firefox < 75 or Safari < 13.1. Provide static fallback values before `clamp()` declarations.
- [ ] [Priority: LOW] [Browser Compatibility] `backdrop-filter` used at `css/gallery.css:470`, `:534`, `:580`, `:633`. Has `-webkit-backdrop-filter` prefix for Safari/Chrome, but no `@supports` fallback for browsers that don't support it at all (e.g., older Firefox). Consider a solid background fallback.

### Performance
- [ ] [Priority: MED] [Performance] Google Fonts loaded with `rel="stylesheet"` at `pages/gallery/index.html:15` is render-blocking. Use the `media="print"` + `onload="this.media='all'"` swap pattern (same as the Resume page finding) for non-blocking font loading.
- [ ] [Priority: LOW] [Performance] `setPageInert()` at `js/gallery.js:776-784` calls `document.querySelectorAll('body > :not(#lightbox)')` on every lightbox open/close. Cache the child element references or store them in `gallery.elements` to avoid repeated DOM queries.
- [ ] [Priority: LOW] [Performance] `trapFocus()` at `js/gallery.js:814-815` calls `querySelectorAll` on every Tab keypress. For a gallery with many focusable elements (thumb strip buttons + controls), this query runs frequently. Cache the focusable list or use a `FocusTrap` library.
- [ ] [Priority: LOW] [Performance] `buildLightboxThumbStrip()` at `js/gallery.js:555-586` creates all thumbnail buttons and images upfront. For galleries with hundreds of photos, consider lazy-rendering or virtualizing the thumb strip.

### Code Quality
- [ ] [Priority: LOW] [Code Quality] Dead logic in `normalizeGalleryKey()` at `js/gallery.js:958-961`. The `while (next !== stem)` loop is unnecessary because the regex `/\.(avif|webp|jpe?g|png)$/i` strips all extensions in a single pass -- the loop body never executes more than once. Remove the loop and keep only the single `replace` call.
- [ ] [Priority: LOW] [Code Quality] `will-change: transform` declared on `.calibrate-text` (`css/gallery.css:166`), `.lightbox-stage` (`:506`), and `.lightbox-panel` (`:667`). Overusing `will-change` promotes elements to their own compositing layers, increasing memory. Remove `will-change` from `.lightbox-stage` and `.lightbox-panel` since they don't have continuous animations; keep it only on `.calibrate-text` during its animation and remove it after completion via JS.

### Accessibility
- [ ] NOTE: [Priority: LOW] [Accessibility] Hero image (`pages/gallery/index.html:70`) and lightbox image (`:162`) both start with empty `alt=""` attributes. While JS populates them, a screen reader reading the page before JS executes sees no description. Consider adding `alt="Gallery photograph"` as a placeholder that JS overwrites, or add `role="img"` with `aria-label` that JS updates. (VERIFIED: the hero image is wrapped in a button with `aria-label="Open featured photo"` (line 66), making the empty alt appropriate for the decorative pre-JS state. The lightbox is `hidden` until opened. Empty alt is correct for these dynamically populated images.)

## Utilities Home Page

### Performance
- [ ] [Priority: MED] [Performance] Google Fonts loaded with `rel="stylesheet"` at `pages/utilities/index.html:15` is render-blocking. Use the `media="print"` + `onload="this.media='all'"` swap pattern (same as the Resume and Gallery pages) for non-blocking font loading.

### Code Quality
- [ ] [Priority: MED] [Code Quality] Dead CSS rule at `css/utilities.css:747-749`. The selector `#utilitiesApp:not([data-transform-has-result='true']) .support-panels { display: none; }` is immediately overridden by `#utilitiesApp .support-panels { display: none !important; }` at lines 751-753. The conditional rule at 747-749 never takes effect because the blanket rule on line 752 always wins. Remove the dead rule.
- [ ] [Priority: LOW] [Code Quality] CSS file `css/utilities.css` is 3378 lines covering five distinct utilities (image transform, audio fourier, local LLM chat, VM, stress test) plus shared primitives and responsive rules. Consider splitting into utility-scoped partials (e.g., `utilities-image.css`, `utilities-audio.css`) imported via `<link>` or `@import` to improve maintainability and cache granularity.
- [ ] [Priority: LOW] [Code Quality] `!important` used at `css/utilities.css:752` (`#utilitiesApp .support-panels { display: none !important; }`). This blanket override makes the conditional rule at 747-749 dead code. A more specific selector without `!important` would be cleaner.

### Accessibility
- [ ] NOTE: [Priority: MED] [Accessibility] The `<nav>` element at `pages/utilities/index.html:26` has no `aria-label`. Screen readers announce it as a generic "navigation" landmark with no distinguishing name. Add `aria-label="Utilities navigation"` or similar. (VERIFIED: this is the only `<nav>` on the page and it contains visible text links ("Home", "Back"). Per known patterns, nav links/buttons with visible text do NOT need aria-label.)
- [ ] [Priority: LOW] [Accessibility] The `.nav-back-btn` button at `pages/utilities/index.html:30` has visible text "Back" which is sufficient for screen readers, but the button overlays the Home link using `position: absolute; inset: 0` (CSS line 69-81). When the Home link is visible (opacity 1), both buttons occupy the same space. The Home link correctly gets `pointer-events: none` when a utility is active, but verify that the Back button does not trap focus or create a confusing tab order when both are technically in the tab sequence.

### Browser Compatibility
- [ ] [Priority: MED] [Browser Compatibility] CSS `clamp()` used extensively throughout `css/utilities.css` (e.g., lines 132, 141, 183, 269, 270, 647, 665, 3345, 3349, 3352) without fallback. Not supported in Firefox < 75 or Safari < 13.1. Provide static fallback values before `clamp()` declarations for properties where the fallback matters (font-size, gap, padding).
- [ ] [Priority: LOW] [Browser Compatibility] `backdrop-filter` used at `css/utilities.css:187-188` and `css/utilities.css:634-635`. Has `-webkit-backdrop-filter` prefix for Safari/Chrome, but no solid background fallback for browsers that don't support it. Consider adding a `@supports (backdrop-filter: blur(0))` block or a fallback background color.

### Error Handling
- [ ] [Priority: LOW] [Error Handling] `loadLocalAssistantScript()` at `js/utilities-shell.js:139-141` attaches a `.catch()` that only calls `console.error(error)` without any user-facing fallback UI beyond the error message injected at line 155. Consider adding a retry button or more helpful messaging when the script fails to load, especially since the promise is reset on failure (line 129) allowing retries.

## Fourier Utility

### Bug
- [ ] [Priority: HIGH] [Bug] `resolveAudioPlaybackButtonLabel()` in `utilities-src/src/audioFourierUiState.ts:7-9` returns `'Play'` when `options.isPlaying` is `true`. The label should be `'Pause'` (the icon at line 25 correctly shows `'\u23f8'` which is the pause symbol, but the aria-label and title will say "Play" while the action is pause). Fix line 8 to return `'Pause'`.

### TypeScript / Code Quality
- [ ] [Priority: MED] [TypeScript] Unsafe `event as DragEvent` casts at `utilities-src/src/audioFourierController.ts:306,313,319`. The `dragenter`/`dragover`/`dragleave`/`drop` listeners receive `Event` from the generic `addEventListener` call but are cast to `DragEvent` without runtime validation. Use typed event listeners (`this.dropzone.addEventListener('drop', (event: DragEvent) => ...)` via an overload or add an `instanceof` guard before accessing `event.dataTransfer`).
- [ ] [Priority: LOW] [TypeScript] `document.getElementById(id) as T` at `utilities-src/src/audioFourierController.ts:386` uses an unsafe type assertion. The null check on line 387-389 prevents runtime errors, but the cast itself is unchecked. Consider using a typed query helper that validates the element type (e.g., checking `element instanceof HTMLButtonElement` for buttons).
- [ ] [Priority: LOW] [Code Quality] Unused catch binding `_error` at `utilities-src/src/audioFourierController.ts:1134` (`catch (_error)`). The variable is never used; omit the binding entirely (`catch {`) to match the pattern used elsewhere in the codebase (e.g., line 55).

### Testing
- [ ] [Priority: MED] [Testing] No test files found matching `utilities-src/tests/audioFourier*.test.ts`. The Fourier utility has significant logic (FFT analysis, energy band reconstruction, slider mapping, envelope computation) that would benefit from unit tests, especially for `audioFourierCore.ts` functions like `mapSliderValueToComponentCount`, `resolveEnergyBandGains`, `resolveSampleEnvelope`, and `buildSampleEnvelope`.

### Performance
- [ ] [Priority: MED] [Performance] `buildEnergyBandReconstruction()` in `utilities-src/src/audioFourierCore.ts:566-641` allocates `bandSamples` as `Float32Array(resolvedBandCount * analysis.samples.length)`. For the "detailed" preset (20 bands, 8M samples) this is ~640 MB. The code logs a warning above 256 MB (line 576-580) but continues allocation. Consider adding a hard limit that throws an error instead of risking OOM crashes on lower-memory devices.
- [ ] [Priority: LOW] [Performance] `createReconstructionScratch()` in `utilities-src/src/audioFourierCore.ts:435-445` allocates `spectraReal` and `spectraImag` as `Float32Array(analysis.frameCount * analysis.frameSize)`. For a 7M-sample signal at 22kHz with frameSize 4096, this is ~2.8M frames * 4096 * 2 * 4 bytes = ~90 MB per array. The scratch is created fresh per band reconstruction call in `reconstructWindowedComponentRange` (line 482) when no scratch is passed. The caller at line 432 always passes a scratch, but the public API allows omitting it.

### Accessibility
- [ ] NOTE: [Priority: LOW] [Accessibility] The component slider (`audioFourierComponentSlider`) has its min/max labels set dynamically (`audioFourierController.ts:285-286, 836-837`) but no `aria-label` or `aria-labelledby` is set on the slider itself. The labels "Sparse" and "Full proxy" are in separate elements. Add `aria-label` to the slider or use `aria-labelledby` referencing the label elements, so screen readers announce the slider's purpose and range. (VERIFIED: the slider at `pages/utilities/index.html:256` already has `aria-label="Fourier signals added"`. This finding is incorrect.)

## Local Assistant Utility

### Error Handling
- [ ] [Priority: HIGH] [Error Handling] `clearModelCache()` at `js/local-llm-chat.js:970-989` is `async` and calls `this.clearBrowserModelCaches()` at line 982 without a try/catch. If cache deletion throws (e.g., Cache API throws a `SecurityError`), the remaining UI updates at lines 986-988 (`updateProgressBar`, `updateStatus`, `renderStatePanel`) never run, leaving the UI in a stuck state. Wrap in try/catch or use optional chaining with a fallback.
- [ ] [Priority: MED] [Error Handling] The worker message handler at `js/local-llm-worker.js:16-46` has no default case for unknown message types. If the main thread sends an unexpected message type, it is silently dropped with no warning. Add a default branch that logs a debug warning (e.g., `console.debug('Unknown message type:', message.type)`) to aid debugging.
- [ ] [Priority: MED] [Error Handling] `dispose()` at `js/local-llm-chat.js:991-1021` clears `promptTimer`, `loadingSequenceTimer`, `_copyTimer`, and animation frames, but does not clear `this.typingTimer`. If the 350ms typing delay fires after dispose, it accesses `this.typingIndicator.hidden` on a potentially detached element. Add `clearTimeout(this.typingTimer); this.typingTimer = null;` to the dispose method.

### Memory
- [ ] [Priority: MED] [Memory] `_messageElements` and `_renderedMessageContent` are `WeakMap`s keyed by message objects at `js/local-llm-chat.js:79-80`. When `trimHistory()` returns a new array with the same message objects (line 827), the WeakMaps keep stale references. However, if `trimHistory` creates new message objects (it does not currently), those WeakMap entries would be orphaned. The current implementation is safe, but if `trimHistory` ever maps to new objects, entries accumulate. Consider clearing both WeakMaps when `resetChat({ clearMessages: true })` is called.

### Performance
- [ ] [Priority: MED] [Performance] `renderMessages()` at `js/local-llm-chat.js:830-853` iterates all messages and reconciles the entire DOM tree on every call (send, reset, finish, etc.). For a chat with many messages, this is O(n) DOM work per render. Since messages are only appended (never reordered or deleted mid-stream), consider tracking an insertion index and only appending new `<article>` elements instead of full reconciliation.
- [ ] [Priority: LOW] [Performance] `flushStatePanelRender()` at `js/local-llm-chat.js:597-637` reads `this.loadCopy.offsetHeight` (line 616) to force a reflow for the CSS transition reset. This forces a synchronous layout recalculation on every state panel render. Consider using `requestAnimationFrame` batching or `will-change` to avoid the forced reflow.

### Code Quality
- [ ] [Priority: MED] [Code Quality] `isBusy()` at `js/local-llm-chat.js:509-511` only returns true for `CHECKING`, `LOADING`, `OPTIMIZING` states. But callers at lines 473, 488, 490 also check `status === WORKER_STATE.THINKING || status === WORKER_STATE.STREAMING` separately. The method name `isBusy` implies it covers all non-idle states, which is misleading. Either rename to `isLoading()` or expand it to include `THINKING` and `STREAMING` and update callers.
- [ ] [Priority: LOW] [Code Quality] `compactMessages()` in `js/local-llm-worker.js:278-294` duplicates the same message sanitization logic as `compactLocalLlmMessages()` in `utilities-src/src/localLlmState.ts:42-62`. The worker version filters by `message && typeof message.content === 'string'` while the TS version filters by `message.role !== 'notice' && typeof message.content === 'string'`. The TS version is more rigorous. Consider importing the TS-compiled version into the worker or extracting shared logic to avoid drift.
- [ ] [Priority: LOW] [Code Quality] `deleteLocalModelCaches()` is defined identically in both `js/local-llm-chat.js:1220-1232` and `js/local-llm-worker.js:456-468` (differing only in `window.` vs `self.` prefix). Extract to a shared module to avoid duplication.

### Browser Compatibility
- [ ] NOTE: [Priority: MED] [Browser Compatibility] `color-mix()` used extensively in `css/local-llm-chat.css` (lines 56, 61, 120, 121, 128, 129, 137, 138, 246, 276, 318, 319, 388, 391, 435, 463, 501, 513, 519, 525, 569, 571) without fallback. Not supported in Safari < 16.2 or Firefox < 117. Provide fallback `background`/`border-color` declarations before the `color-mix()` line so older browsers degrade gracefully. (VERIFIED: every `color-mix()` line is preceded by a hardcoded fallback — e.g., line 55 `border: 1px solid rgba(...)` before 56, line 60 `background: rgba(...)` before 61, line 118 `border-color: rgba(...)` before 120, line 119 `background: rgba(...)` before 121, etc. This is the intentional Firefox fallback pattern.)
- [ ] [Priority: LOW] [Browser Compatibility] CSS `clamp()` used in `css/local-llm-chat.css` (lines 31, 213, 222, 375, 474, 475) without fallback. Not supported in Firefox < 75 or Safari < 13.1. Provide static fallback values before `clamp()` declarations.

### Accessibility
- [ ] [Priority: LOW] [Accessibility] The `startButton` (Load/Retry button) at `js/local-llm-chat.js:516` uses only `.disabled` property, while `resetButton` at line 489 explicitly sets `aria-disabled`. While the native `disabled` attribute propagates to `aria-disabled` for `<button>` elements, adding the explicit `aria-disabled` attribute for consistency with the reset button would improve accessibility tooling compatibility.

## Virtual Machine Utility

### TypeScript / Code Quality
- [ ] [Priority: MED] [TypeScript] Unsafe generic element cast at `utilities-src/src/retroVmController.ts:516`. The `requireElement<T extends HTMLElement>(id: string)` method uses `document.getElementById(id) as T | null`, an unchecked type assertion. The null check at lines 517-519 prevents runtime errors, but if the DOM element exists with the wrong type (e.g., a `<div>` when `HTMLButtonElement` is expected), the cast silently lies. Consider adding an `instanceof` validation for the expected element type, matching the pattern already flagged in `audioFourierController.ts:386`.
- [ ] [Priority: LOW] [Code Quality] Unused dynamic import result at `utilities-src/src/retroVmController.ts:561`. `await import('v86/build/v86-fallback.wasm?url')` is awaited but its return value is never assigned or used. If this is an intentional preload, add a comment explaining why the fallback wasm URL must be fetched before the V86 constructor. If it has no effect, remove it to avoid an unnecessary network request.
- [ ] NOTE: [Priority: LOW] [Code Quality] `innerHTML = ''` used for clearing at `utilities-src/src/retroVmController.ts:670` and `:939`. Both are safe (clearing, not inserting user data), but `while (el.firstChild) el.removeChild(el.firstChild)` or `el.replaceChildren()` would avoid triggering static analysis XSS scanners that flag `innerHTML` without context. (VERIFIED: both instances clear to empty string, not inserting user data. Per known patterns, this is NOT a security issue.)

### Browser Compatibility
- [ ] [Priority: LOW] [Browser Compatibility] `requestPointerLock({ unadjustedMovement: true })` at `utilities-src/src/retroVmController.ts:316`. The `unadjustedMovement` option is only supported in Chrome/Edge. Firefox silently ignores the option (it does not reject the promise). The `.catch()` fallback at line 317 handles promise rejection but won't trigger in Firefox. This is acceptable since the option is advisory, but the fallback chain should be documented.

### Testing
- [ ] [Priority: LOW] [TypeScript] Unsafe `{} as HTMLElement` cast at `utilities-src/tests/retroVmConfig.test.ts:64`. The test passes an empty object cast to `HTMLElement` as the `screenContainer` argument to `buildRetroVmV86Options`. While this works because the function only reads `screenContainer` as a value (not calling DOM methods on it), a proper `document.createElement('div')` mock would be more robust if the function ever starts accessing DOM properties of the container.

## Stress Test Utility

### Performance
- [ ] [Priority: MED] [Performance] Hardcoded `targetRefreshRate = 60` at `utilities-src/src/stressTestController.ts:1030` in `resolveWebGlWorkloadLevel()`. On high-refresh-rate displays (120Hz, 144Hz, etc.), the workload ramp logic compares FPS against 45 (60 * 0.75) which is meaningless -- the GPU may be rendering at 120fps but the ramp still triggers incorrectly. Use `window.screen.refreshRate ?? 60` or `performance.getEntriesByType('navigation')[0]` heuristics to adapt to the actual display refresh rate.
- [ ] [Priority: LOW] [Performance] `syncMetrics()` sets `data-stress-gpu-frame-count` and `data-stress-total-rendered-frames` to the exact same value (`this.frameCount`) at lines 1285-1286. One of these redundant data attributes can be removed, or they should track different values if they serve distinct purposes.
- [ ] [Priority: LOW] [Performance] Inconsistent canvas pixel scale: `syncCanvasSize()` at line 1398 caps `devicePixelRatio` at 3, but `replaceCanvasElement()` at line 1421 caps it at 2. When the canvas is replaced (e.g., switching from WebGL to 2D context), a user with a 3x display gets a lower-resolution canvas. Use the same cap in both methods.
- [ ] [Priority: LOW] [Performance] `canCreateContext()` at lines 590-601 creates a temporary `<canvas>` element via `document.createElement('canvas')` but never removes it or nullifies the reference. Although detached elements are typically GC'd by modern browsers, the element retains its context until GC runs. Nullify the canvas reference after the context probe or reuse a single probe canvas instance.

### Code Quality
- [ ] [Priority: MED] [Code Quality] `getWebGpuTextureUsageFlag()` at lines 206-209 silently returns `0` when `GPUTextureUsage` is undefined or the named flag is missing. Unlike its sibling `getWebGpuUsageFlag()` (line 201) which logs a warning, this function provides no diagnostic output. When `GPUTextureUsage.RENDER_ATTACHMENT` is unavailable (e.g., older WebGPU implementations), the canvas context is configured with `usage: 0`, which causes a silent WebGPU validation error. Add a `console.warn` matching the pattern in `getWebGpuUsageFlag()`.
- [ ] [Priority: LOW] [Code Quality] `recordGpuFrame()` is called from the CPU visuals animation loop at `utilities-src/src/stressTestController.ts:1109`. The method name implies GPU frame tracking, but it's also used for CPU-only visual frames. Consider renaming to `recordRenderFrame()` or splitting into `recordGpuFrame()` and `recordCpuVisualFrame()` for clarity.
- [ ] [Priority: LOW] [Code Quality] `compileShader()` at line 1058 accepts `type: number` for the WebGL shader type parameter. This should be typed as `WebGLRenderingContext.VERTEX_SHADER | WebGLRenderingContext.FRAGMENT_SHADER` or at minimum a named constant to prevent passing arbitrary numbers. The `texImage3D` duck-type check at line 1060 is a clever backend detection but could be extracted to a named method for readability.
- [ ] [Priority: LOW] [Code Quality] `WEBGL_lose_context().loseContext()` is called as part of error recovery at lines 948-949, 957-959, and 1069-1071. While this is a valid cleanup pattern, it can cause unexpected browser behavior (e.g., some browsers show a "WebGL context lost" overlay). Consider only calling `loseContext()` when `loseContext` is explicitly requested (as done in `stopGpuStress` at line 1052) rather than automatically on shader/link failures.

### Error Handling
- [ ] [Priority: MED] [Error Handling] WebGPU device loss handler at lines 779-795 calls `this.stopCpuStress()` (line 785) when only the GPU device was lost. If the user is running in `mode: 'both'`, losing the GPU device should stop GPU stress and fall back to CPU-only visuals, not terminate the entire stress test. Consider catching the device loss, stopping only GPU stress, and restarting CPU visuals if CPU stress is still running.

### TypeScript
- [ ] [Priority: LOW] [TypeScript] Unsafe type assertions at `utilities-src/src/stressTestController.ts:614` (`as WebGL2RenderingContext | null`) and `:618` (`as WebGLRenderingContext | null`). The `getContext()` method's return type is already narrowed by the context ID string literal, but TypeScript's DOM lib doesn't fully model this. The casts are safe in practice but could use an `instanceof` runtime check for defense in depth.

### Browser Compatibility
- [ ] [Priority: LOW] [Browser Compatibility] `ResizeObserver` used at line 1379 without a fallback. The guard at lines 1374-1376 (`typeof ResizeObserver === 'undefined'`) prevents crashes, but browsers without `ResizeObserver` (IE11, very old mobile browsers) won't get canvas resize updates from layout changes -- only from `window.resize` events. This is acceptable for a stress test utility, but worth noting.
- [ ] [Priority: LOW] [Browser Compatibility] `navigator.hardwareConcurrency` at line 481 returns `undefined` in some contexts (e.g., Safari Private Browsing). The `resolveCpuWorkerCount` function handles this (defaults to 4), but the stress test could briefly show misleading worker count metrics before workers are spawned.

### Accessibility
- [ ] [Priority: LOW] [Accessibility] The stress test HTML markup is well-structured with `aria-live="polite"` on the status text, `aria-pressed` on mode toggle buttons, `aria-label` on the canvas, and `role="group"` on the mode button group. No significant accessibility issues found.
