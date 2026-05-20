# Website Code Review TODOs
Generated: Wednesday, May 20, 2026

## Home Page

### index.html

- [ ] [Priority: MED] [Code Quality] Multiple inline styles should be extracted to CSS classes for maintainability: `style="color:#FF6700"` (line 53), `style="border-top: 1px solid #000000"` (line 76), `style="margin-top: 1rem"` (lines 164, 183), `style="margin-top: 2rem"` (line 200), `style="margin-top: 2rem; display: flex; gap: 2rem"` (line 211), and `style="padding: 1rem; display: block; text-decoration: none"` (lines 212, 216).
- [ ] [Priority: LOW] [Accessibility] The `data-disable-color-mode` attribute on `<html>` (line 2) is a non-standard custom attribute. Consider documenting its purpose or using a data-attribute with a more descriptive name.
- [ ] [Priority: LOW] [Code Quality] The OSU beaver SVG (lines 108-117) is inlined at ~2.5KB with extremely long path data. Consider moving to an external SVG file or using `<svg><use>` for reuse and cleaner HTML.

### js/main.js

- [ ] [Priority: MED] [Code Quality] Two global variables pollute the global scope without IIFE/module wrapping: `DOUGHERTY_BLUEPRINT_SEQUENCE_MS` (line 19) and `confettiFired` (line 20). Wrap the entire script in an IIFE or convert to ES module to avoid namespace collision.
- [ ] [Priority: LOW] [Performance] The `onScrollMaybePastDougherty` scroll handler (line 562) calls `getBoundingClientRect()` on every scroll event without throttling or requestAnimationFrame batching. Add rAF throttling to reduce layout thrashing.
- [ ] [Priority: LOW] [Performance] The `initSmoothScroll` function (line 627) sets `scrollMarginTop` inline on scroll targets and removes it via `setTimeout` (line 656). This causes a forced reflow and leaves residual styles if the user navigates away quickly. Consider using CSS `:target` or a CSS class instead.
- [ ] [Priority: LOW] [Error Handling] The `document.fonts.ready.then()` promise at line 280 has a `.catch()` that only logs to `console.debug`. If fonts fail to load, the blueprint wordmark may render incorrectly with no user-visible fallback.

### js/starfield.js

- [ ] [Priority: LOW] [Browser Compatibility] The worker renderer path (line 36) uses `transferControlToOffscreen` which is unsupported in Firefox and Safari. The fallback to main-thread canvas works, but the worker code path at line 47 uses `starfieldWorkerMain.toString()` to serialize the function -- this works but is fragile if minifiers mangle the function body. Consider bundling the worker separately.
- [ ] [Priority: LOW] [Performance] The main-thread fallback loop (line 565) calls `syncDiagnostics` on every frame, which reads/writes `canvas.dataset` properties. This is a minor per-frame DOM write that could be batched to every N frames.

### css/design-system.css

- NOTE: [Priority: LOW] [Browser Compatibility] `color-mix()` is used extensively (lines 627, 628, 638, 639, 690, 956, 1300). Browsers without support (Safari < 16.2, Firefox < 113, Chrome < 111) will treat the declaration as invalid and fall back to the previous value or default. Add fallback declarations before `color-mix()` lines. NOTE: Hardcoded fallback values are already declared before each `color-mix()` line (e.g., lines 626-627: `background: #F7F8F6; border-color: #C7D1C4;` before the `color-mix()` overrides). This is an intentional progressive enhancement pattern.
- [ ] [Priority: LOW] [Browser Compatibility] `mask-composite: exclude` (line 602) has a `@supports` fallback at line 606, which is good. However, `-webkit-mask-composite: xor` (line 600) may not render identically in all WebKit versions. Verify cross-browser consistency.

### css/schematic.css

- [ ] [Priority: MED] [Code Quality] `::selection` (line 34) is unscoped to `body.schematic-mode` and will override the design-system selection style globally. Since schematic.css is only loaded on the home page this is currently safe, but scoping it prevents accidental override if the stylesheet is ever shared.
- [ ] [Priority: MED] [Code Quality] `.container` (line 358) and `.tag` (line 571) are unscoped overrides of design-system.css classes. If schematic.css is ever loaded on another page, these will cause unintended style leaks. Prefix with `body.schematic-mode` or a wrapper selector.
- [ ] [Priority: LOW] [Code Quality] `:root` custom properties (lines 43-56) override design-system tokens globally. While intentional for the schematic theme, this means `--font-display` is redefined from `'Instrument Serif'` to `'JetBrains Mono'` which could confuse developers expecting the design-system default.
- NOTE: [Priority: LOW] [Browser Compatibility] `color-mix(in srgb, var(--schematic-text) 66%, var(--schematic-flare))` (line 276) has no fallback. Older browsers will drop the stroke color entirely. NOTE: Line 275 has `stroke: #572300;` as the fallback declaration before the `color-mix()` override.
- NOTE: [Priority: LOW] [Code Quality] `!important` is used in `.schematic-border` variants (lines 400-403) and `.schematic-text` (line 372). While intentional for override, this increases specificity debt. Consider using a more specific selector instead. NOTE: These are utility classes; `!important` is intentional for override.

## Resume Page

### pages/resume/index.html

- [ ] [Priority: MED] [Accessibility] The `.nav-dot` button (line 36) has no visible text content — it relies entirely on `aria-label` and a `.sr-only` span. Screen readers will announce "Open menu" but the button is a solid 20×20 black circle with no discernible icon or label for visual users. Consider adding a visible icon (hamburger/menu symbol) or a tooltip.
- [ ] [Priority: HIGH] [Accessibility] The `data-animate="fade-up"` elements (lines 102, 128, 170, 191, 231) are hidden via CSS `opacity: 0` until JavaScript adds the `.visible` class. If JS is disabled or fails to load, the entire resume content (Education, Projects, Experience, Skills, Clubs) remains invisible. Add a `noscript` rule or `@media (prefers-reduced-motion)` CSS to show them by default.
- [ ] [Priority: LOW] [Code Quality] Inline `style="opacity: 0;"` is used on `.meta-tiny` (line 62), `#typeTargetSubtitle` (line 75), `.hero-contact` (line 76), and `#navToggle` (line 36). These are controlled by `resume-typing.js` which sets `opacity: '1'` via JS. Consider using a CSS class like `.is-hidden` instead of inline styles for better maintainability.
- [ ] [Priority: LOW] [Code Quality] Inline `style="display: none;"` on `#typeCursor` (line 73) is toggled by JS. Move to a CSS class for consistency.

### css/resume.css

- [ ] [Priority: MED] [Browser Compatibility] `78svh` is used (line 758) for the hero min-height on mobile. The `svh` unit (small viewport height) has good modern support but is not supported in Safari < 15.4 and older mobile browsers. The fallback `78vh` is declared on the line above, which is correct, but note that `vh` can cause layout shifts on mobile Safari when the address bar toggles. Consider using `dvh` (dynamic viewport height) as a middle ground, or a JS-based fallback.
- [ ] [Priority: LOW] [Code Quality] `.nav-dot` styles (lines 43-72) are duplicated from `schematic.css` rather than imported or shared. The comment on line 40 acknowledges this ("copied from schematic.css"). DRY up by importing shared nav styles or extracting them to a shared partial.
- [ ] [Priority: LOW] [Code Quality] `!important` is used in `.nav-overlay-bg` (line 79: `background-color: #FFFFFF !important;`). This overrides design-system styling. Consider increasing selector specificity instead to reduce `!important` usage.

### js/resume-typing.js

- [ ] [Priority: MED] [Accessibility] The typing animation blocks the display of the subtitle and contact info for ~3 seconds (lines 65-96: cumulative delays of 800ms + typing + 400ms + typing + 350ms + typing + 300ms + 1600ms). Users with `prefers-reduced-motion` get the instant reveal, but the animation path is still quite long. Consider reducing the total animation duration or making the subtitle/contact info appear in parallel rather than sequentially after the full typing completes.
- [ ] [Priority: LOW] [Code Quality] `revealPage()` (line 22) uses `document.querySelector` for `.hero-contact` and `.meta-tiny` on every call. Cache these references at the top level alongside the other element lookups.
- [ ] [Priority: LOW] [Code Quality] The `runSequence()` function (line 58) calls `name1.textContent = ''` and `name2.textContent = ''` (lines 59-60) which duplicates what `typeText()` already does on line 42 (`element.textContent = ''`). The clears on lines 59-60 are redundant.

## Photo Gallery

### pages/gallery/index.html

- [ ] [Priority: MED] [Code Quality] Inline `style="color:#004BA8"` on `.meta-tiny` span (line 52) and `style="background-color: #FFFFFF;"` on `.nav-overlay-bg` (line 31) should be extracted to CSS classes for maintainability.
- NOTE: [Priority: LOW] [Accessibility] The hero `<img>` (line 71) and lightbox `<img>` (line 163) ship with empty `alt=""` attributes. They are populated dynamically by gallery.js, but if JS fails to load or is blocked, these images render with no accessible description. Consider adding a minimal fallback alt text in the HTML. NOTE: Images with alt="" dynamically populated by JS per the exemption rules.
- [ ] [Priority: LOW] [Code Quality] `data-disable-color-mode` attribute on `<html>` (line 2) is a non-standard custom attribute. Consider documenting its purpose or using a more descriptive data attribute name.

### js/gallery.js

- [ ] [Priority: HIGH] [Code Quality] Six top-level declarations pollute the global scope without IIFE/module wrapping: `GALLERY_HASH_PREFIX` (line 7), `MANIFEST_PATH` (line 8), `SEQUENCE_PATH` (line 9), `HERO_QUEUE_LIMIT` (line 10), and the `gallery` object (line 12). This also includes all ~40 functions declared at the top level. Wrap the entire script in an IIFE or convert to an ES module to avoid namespace collision with other page scripts.
- [ ] [Priority: MED] [Performance] The `cleanupLightboxImageOpacity` handler (line 789) listens for `transitionend` without checking `event.propertyName === 'opacity'`. Since `.lightbox-image` has a `transition` on opacity only (line 493 of CSS), this is currently safe, but if the CSS transitions change (e.g., adding `transform`), the handler will fire prematurely and remove the inline opacity style before the transition completes. Add a property name check for robustness.
- [ ] [Priority: MED] [Performance] `preloadAdjacentEntries()` (lines 1009-1017) creates detached `Image` objects that are never stored in a variable. While the browser caches them, the detached objects are not garbage-collected until the next GC cycle and accumulate if lightbox navigation is rapid. Consider storing references in a WeakMap or a small array that is replaced on each call.
- [ ] [Priority: LOW] [Code Quality] `gallery.inertElements` (line 76) captures ALL `document.body.children` including `<script>`, `<link>`, and other non-interactive elements. Setting `inert` on these is unnecessary overhead. Filter to only elements that can contain focusable descendants.
- [ ] [Priority: LOW] [Error Handling] The `initGallery` function (line 154) has a `.catch()` at line 36-39 that shows the error state, but `initGalleryHeroReveal()` call (line 35) uses `window.setTimeout` with fixed delays (2000ms, 4100ms) that are never cleaned up on error. Add timer cleanup in the error path.
- [ ] [Priority: LOW] [Code Quality] The `supportsScrollIntoViewInline()` feature detection (lines 920-938) creates a detached `<div>` element on every first call that is never removed. While it's a one-time call, storing the result without creating DOM nodes would be cleaner.

### css/gallery.css

- [ ] [Priority: MED] [Code Quality] `.nav-dot` styles (lines 895-916) are duplicated from `schematic.css` rather than imported or shared. This creates maintenance drift between the two definitions. Extract shared nav styles to a common partial or import schematic.css nav rules.
- [ ] [Priority: LOW] [Code Quality] `html { color-scheme: light; }` (line 7) overrides the design-system color scheme. This is intentional for the gallery's light theme, but note that it forces system UI (scrollbars, form controls) to light mode even if the user has a dark mode system preference. Ensure this aligns with the design intent.
- [ ] [Priority: LOW] [Code Quality] `!important` is used in `.photo-card { --reveal-delay: 0ms !important; }` (line 1030) inside the 768px breakpoint. While functional, consider using a more specific selector or a CSS class toggle instead to reduce specificity debt.
- [ ] [Priority: LOW] [Code Quality] Empty formatting in `@media (max-width: 1280px)` block (lines 926-931) -- extra closing brace on line 931. Clean up the formatting.

## Utilities Home Page

### pages/utilities/index.html

- NOTE: [Priority: MED] [Code Quality] `data-color` attributes on title buttons (lines 44-48) are never read by `utilities-shell.js`. The shell uses `resolveFlairColor()` with a deterministic hash instead, making these HTML attributes dead data. Remove them or wire them up. (lines 44-48) NOTE: These attributes ARE used by CSS (utilities.css lines 3235-3254: `.utilities-buttons button[data-color="lavender"]` etc.) for per-button styling. They are not dead data.
- [ ] [Priority: LOW] [Code Quality] `data-utilities-shell` attribute on `<html>` (line 3) is a non-standard version-tracking attribute. Consider documenting its purpose or removing if not used for debugging. (line 3)

### js/utilities-shell.js

- [ ] [Priority: MED] [Error Handling] The `loadLocalAssistantScript()` function (line 105) creates a cached promise that is reset to `null` on error (line 129), but the `.catch()` handler on line 139 swallows the error with only `console.error`. If the script fails to load and the user never navigates to Local Assistant, the error is silently lost. Consider surfacing a non-intrusive notification or logging to a telemetry endpoint. (lines 139-141)
- [ ] [Priority: LOW] [Code Quality] The `UTILITY_MAP` (lines 18-24) maps every key to itself, making it a pass-through. It could be replaced with a `Set` or a simple `Object.hasOwn()` check for clarity. (lines 18-24)

### css/utilities.css

- [ ] [Priority: MED] [Accessibility] `.btn-swap-minimal` (line 928) has no `:focus-visible` styles defined. The swap button (HTML line 76) is a fully icon-only interactive element with no visible focus indicator for keyboard users. Add a `:focus-visible` rule matching the pattern used by other utility buttons. (line 928)
- NOTE: [Priority: MED] [Browser Compatibility] `color-mix()` is used 14 times (lines 1893-2009) without any fallback declarations. Browsers without support (Safari < 16.2, Firefox < 113, Chrome < 111) will silently drop the flair color effects, leaving `--flair-dark`, `--flair-glow`, `--flair-soft` and dependent properties unresolved. Add explicit fallback values before the `color-mix()` declarations. (lines 1893-2009) NOTE: Hardcoded fallback values ARE declared before each `color-mix()` (e.g., lines 1890-1892: `--flair-dark: #9a3d00; --flair-glow: rgba(255, 103, 0, 0.3); --flair-soft: rgba(255, 103, 0, 0.15);` before the `color-mix()` overrides on lines 1893-1895). This is an intentional progressive enhancement pattern.
- NOTE: [Priority: LOW] [Code Quality] Duplicate CSS custom property declarations: `--flair-dark` is declared at lines 1890 and 1893, and `--flair-glow` at lines 1891 and 1894. The first declarations (hardcoded hex/rgba values) are immediately overridden by the `color-mix()` versions. Remove the redundant first declarations. (lines 1890-1895) NOTE: These are intentional fallback declarations for browsers without `color-mix()` support (Firefox < 113, Safari < 16.2, Chrome < 111). The first hardcoded values serve as fallbacks.
- NOTE: [Priority: LOW] [Code Quality] Nine `!important` usages scattered throughout the file (lines 60, 86, 88, 1322, 1862, 1863, 2092, 3379, 3380). The `prefers-reduced-motion` block (lines 1862-1863) legitimately needs `!important`, but others (lines 60, 86, 88) could potentially use more specific selectors. Audit each for necessity. (lines 60, 86, 88, 1322, 2092, 3379, 3380) NOTE: All nine usages are intentional utility class overrides: lines 60/86/88 override animations for nav button state management, line 1322 enforces `[hidden]` display, lines 1862-1863 are in `prefers-reduced-motion`, line 2092 enforces `[hidden]` on death screen, lines 3379-3380 override scroll animations for active stages. These are all legitimate `!important` uses for utility overrides.

## Fourier Utility

### utilities-src/src/audioFourierController.ts

- [ ] [Priority: HIGH] [Error Handling] Empty catch block in `supportsModuleWorkers()` (line 55) silently swallows all errors. If `new Worker()` throws for a reason other than module worker support (e.g., security policy, blob URL restrictions), the function returns `false` and the user sees a generic "module workers not supported" error instead of the real cause. Add `console.warn` inside the catch to log the actual error for debugging.
- [ ] [Priority: MED] [Error Handling] Empty catch block in `stopPlayback()` (line 1133) swallows errors from `node.source.stop()`. While the comment says "stopping an already-ended one-shot source is harmless", this also hides unexpected errors like `InvalidStateError` from an already-disconnected node. Add a `console.warn` to log unexpected failures.
- [ ] [Priority: MED] [Error Handling] The `onended` callback on `firstNode.source` (line 1089) references `this.activeResult?.metadata.proxyDurationSeconds` and `this.setState()` without checking if the controller has been destroyed. If `destroy()` is called while audio is still playing, `this.activeResult` is null and `this.setState()` dispatches events on a destroyed controller. Add a guard like `if (this.state === 'idle' && this.activeResult === null) return;` or track a destroyed flag.
- [ ] [Priority: MED] [Performance] `drawSpectrumFrame()` (line 1335) and `drawComponentFrame()` (line 1359) are called on every slider input change without throttling or debouncing. During rapid slider drags this fires `input` events at ~60fps, each triggering full canvas redraws. The slider handler does use `requestAnimationFrame` for the non-animating case (line 878), but during animation the canvases are redrawn synchronously on every `input` event (line 870-872). Consider deferring the canvas redraws through the existing animation frame loop.
- [ ] [Priority: LOW] [Code Quality] `abandonActiveComputation()` (line 565) sends a cancel message to the worker then immediately calls `worker.terminate()`. The cancel message (line 571) is effectively dead code because `terminate()` kills the worker before it can process the cancel. Either remove the cancel message or replace `terminate()` with a graceful shutdown that waits for the worker to acknowledge cancellation.
- [ ] [Priority: LOW] [Code Quality] `handlePlayClick()` (line 1019) has a dead code path: when `this.state === 'animating'` it increments `playbackElapsedSeconds` by 0.75 seconds and re-renders, effectively creating a skip-forward feature. However, this behavior is undocumented in the UI -- the play/pause button's aria-label says "Pause" (from `resolveAudioPlaybackButtonState`) but clicking it skips forward instead of pausing. The pause functionality is handled by a separate `pauseButton`. Clarify the intended UX or rename the handler.

### utilities-src/src/audioFourierCore.ts

- [ ] [Priority: LOW] [Code Quality] `buildEnergyBandReconstruction()` (line 568) allocates `bandSamples` as a single contiguous `Float32Array` of size `resolvedBandCount * analysis.samples.length`. For the "detailed" preset (20 bands, 8M samples) this is ~640 MB of heap memory. The function has a hard limit check at 512 MB (line 578), but the "detailed" preset would exceed it. The `maxProxySampleCount` for "detailed" is 8M, so `20 * 8_000_000 * 4 = 640 MB > 512 MB`. This means the detailed preset can never actually process a file at its maximum sample count -- the error will always trigger. Consider raising the limit or lowering the detailed preset's `maxProxySampleCount`.

### utilities-src/src/audioFourierWaveRenderer.ts

- [ ] [Priority: LOW] [Browser Compatibility] `getAudioWaveGlContext()` (line 622) falls back to `'experimental-webgl'` (line 629). This context type has been deprecated since 2014 and is removed in modern browsers. It's harmless as a fallback since it returns null, but the string could be removed to avoid confusion.

### utilities-src/src/audioFourier.worker.ts

- [ ] [Priority: MED] [Error Handling] `self.onmessage` (line 285) has no top-level try-catch. If `isAudioFourierAnalyzeRequest()` or `isAudioFourierCancelRequest()` throw on an unexpected message shape (e.g., a circular reference causing infinite recursion in `typeof` checks), the error is unhandled and silently kills the worker. Wrap the handler body in try-catch with `postUnexpectedWorkerError`.

### utilities-src/src/audioFourierUiState.ts

- No significant issues found. Pure utility functions with no side effects.

### utilities-src/src/audioPresets.ts

- No significant issues found. Pure data definitions and type guards.

### Test coverage

- [ ] [Priority: MED] [Code Quality] No test files exist for the Fourier utility (`utilities-src/tests/audioFourier*.test.ts` matches zero files). This is a significant gap for a module with complex audio signal processing (FFT reconstruction, energy band mixing, envelope computation). At minimum, unit tests for `audioFourierCore.ts` pure functions (`mapSliderValueToComponentCount`, `resolveEnergyBandGains`, `resolveSampleEnvelope`, `buildSampleEnvelope`) would catch regressions in the mathematical logic.

## Local Assistant Utility

### js/local-llm-chat.js

- [ ] [Priority: HIGH] [Performance] `updateAssistantElement()` (line 888) calls `renderSafeText()` which fully parses and re-renders markdown (including LaTeX, code blocks, lists) on every token append. For long responses this means O(n) re-parsing where n is the total token count. Consider appending only the new token's rendered delta instead of re-rendering the entire message content.
- [ ] [Priority: MED] [Accessibility] The `#localLlmStatusChip` span (line 107) dynamically changes its text content (e.g., "Idle" to "Loading" to "Ready") but lacks an `aria-live` attribute. Screen readers will not announce these status transitions. Add `aria-live="polite"` to the status chip element.
- [ ] [Priority: MED] [Performance] `renderMessages()` (lines 833-856) iterates all messages and calls `appendChild` on every invocation, even for messages whose DOM elements already exist in the correct position. While `appendChild` is a no-op move for same-parent elements, the full iteration and `Set` construction add up on frequent calls (fired on every token, every status change, every renderStatePanel). Consider diffing only new/removed messages against the existing DOM children.
- [ ] [Priority: MED] [Error Handling] `terminateWorker()` (line 1086) sets `this.worker = null` immediately, but the actual `worker.terminate()` call is deferred by `delayMs` (line 1082). If another method (e.g., `sendMessage()`) checks `this.worker` between the null assignment and the timeout firing, the worker reference is lost and messages cannot be sent. Store the worker reference locally and null it after the timeout, or use a separate flag for "worker being terminated".
- [ ] [Priority: LOW] [Code Quality] `renderSafeInlineText()` (line 1216) uses a regex for emphasis `(^|[\s(])\*([^*\n]+)\*(?=([\s).,;:!?]|$))` that requires a space or punctuation boundary. Emphasis at the start of a string like `*bold* text` works, but `*text*more` (no trailing space) would not match. This is a minor edge case in the inline renderer used for loading sequence copy.
- [ ] [Priority: LOW] [Code Quality] The `showDiagnostics()` method (line 936) uses `innerHTML` with `escapeHtml()` for all dynamic content, which is safe. However, the button elements are hardcoded in the template string rather than created via DOM APIs. This is acceptable given the escaping, but creating elements via `document.createElement` would be more defensive against future changes.

### js/local-llm-worker.js

- [ ] [Priority: MED] [Error Handling] The top-level `self.addEventListener('message', ...)` handler (lines 17-50) has no try-catch wrapper. If any async message handler like `loadModel()` or `generateReply()` throws on an unexpected message shape (e.g., null prototype, malformed messages array), the error is unhandled and silently kills the worker. Wrap the handler body in try-catch with `postMessage({ type: 'error', ... })` to the main thread.
- [ ] [Priority: LOW] [Error Handling] The `loadModel()` function (lines 74-79) catches and logs the error with `console.error(error)` after the structured error has already been sent to the UI. The comment says "The UI receives a structured error message" which is correct, but the `.catch()` on line 65 already calls `setState` with the error. The outer try-catch on line 76 is redundant since `loadPromise` already handles errors. Consider removing the redundant catch or consolidating error handling.

### js/local-llm-config.js

- No significant issues found. Clean configuration object with well-structured constants.

### css/local-llm-chat.css

- NOTE: [Priority: MED] [Browser Compatibility] `color-mix()` is used 20+ times (lines 57, 62, 122, 123, 130, 131, 139, 140, 252, 282, 324, 325, 395, 398, 442, 470, 510, 522, 528, 534, 578, 580) without any fallback declarations. Browsers without support (Safari < 16.2, Firefox < 113, Chrome < 111) will silently drop these declarations, leaving border colors, backgrounds, and focus styles unresolved. Add explicit fallback values before each `color-mix()` declaration. NOTE: Hardcoded rgba fallback values ARE declared before each `color-mix()` (e.g., line 56: `border: 1px solid rgba(0, 229, 255, 0.45);` before line 57: `border-color: color-mix(...)`. This is an intentional progressive enhancement pattern.
- [ ] [Priority: LOW] [Code Quality] Duplicate `border-color` and `background` declarations are used as a fallback pattern (e.g., lines 57-58, 62, 122-123, etc.) where the first line uses `rgba()` and the second uses `color-mix()`. This is a valid progressive enhancement pattern, but the `rgba()` fallback values should be verified to match the `color-mix()` output visually, as some `rgba()` values (e.g., line 510: `rgba(0, 229, 255, 0.58)`) may not exactly match the `color-mix()` result (line 511).

### utilities-src/src/localLlmState.ts

- No significant issues found. Clean TypeScript with proper type annotations. The `normalizeLocalLlmProgressState` function accepts `unknown` and returns a proper string union type. `compactLocalLlmMessages` has explicit input/output types.

### utilities-src/tests/localLlmState.test.ts

- [ ] [Priority: LOW] [Code Quality] The test suite covers rendering, sanitization, LaTeX parsing, and message compaction well. However, there are no tests for the `InlineLocalLlmSegment` type's discriminated union behavior or for edge cases in `cleanupLocalLlmText` (e.g., nested think tags, empty content, extremely long strings). Consider adding tests for these edge cases.

## VM Utility

### utilities-src/src/retroVmController.ts

- [ ] [Priority: MED] [Code Quality] No test file exists for `RetroVmController` despite its 945 lines of complex logic (lifecycle management, event wiring, state machine, pointer lock, fullscreen, clipboard paste, resize handling). The `FakeRetroVm` class exists for testing but is never imported by any test file. At minimum, tests should cover `launch()`, `reset()`, `dispose()`, and error state transitions. (lines 343-945)
- [ ] [Priority: MED] [Accessibility] `screenContainer.tabIndex = 0` (line 494) makes the VM screen keyboard-focusable, but there is no `:focus-visible` CSS rule defined for `#retroVmScreen`. Keyboard users navigating to the screen will see no focus indicator. Add a `:focus-visible` outline rule matching the utility button pattern.
- [ ] [Priority: MED] [Code Quality] `autoAdvanceBootMenu()` (lines 697-721) dispatches Enter keys at fixed delays (900ms) after detecting the boot menu prompt. If the guest OS processes input faster or slower than expected, the Enter key could land on the wrong prompt or be sent to an already-booted desktop. Consider adding a second `wait_until_vga_screen_contains` check before the delayed Enter dispatch to confirm the expected prompt is still visible.
- [ ] [Priority: LOW] [Performance] `RetroVmMouseBridge` (lines 135-341) handles only mouse events. Touch laptops running in desktop mode (passing `detectRetroVmSupport`) will not forward touch input to the VM. Consider adding `touchstart`/`touchmove`/`touchend` handlers that synthesize equivalent mouse events for hybrid devices.
- [ ] [Priority: LOW] [Code Quality] `screenContainer.innerHTML = ''` is used in `reset()` (line 671) and `dispose()` (line 940). While the container only holds v86-generated elements, using `el.replaceChildren()` would be more explicit about the intent to clear children.
- [ ] [Priority: LOW] [Error Handling] `createEmulator()` (lines 556-565) dynamically imports `v86` (line 563) without any timeout. If the network request hangs (e.g., CDN issue, large WASM download stalled), the `launch()` try-catch at line 547 will never resolve. Consider wrapping with a timeout promise.
- [ ] [Priority: LOW] [Code Quality] `pasteClipboard()` (lines 616-653) uses `window.confirm()` (line 630) which blocks the main thread and cannot be styled or dismissed programmatically. For a better UX, consider a custom modal dialog that matches the site's design system.

### utilities-src/src/retroVmConfig.ts

- [ ] [Priority: LOW] [Code Quality] `parseBooleanFlag()` (lines 59-72) accepts `'on'` and `'off'` as truthy/falsy values but not `'enabled'`/`'disabled'` or `'y'`/`'n'`. The function is not exported and has no documentation. Consider adding a JSDoc comment listing accepted values for future maintainers.

### utilities-src/src/retroVmSupport.ts

- [ ] [Priority: LOW] [Code Quality] `detectRetroVmSupport()` (lines 29-103) checks `typeof HTMLElement !== 'undefined'` (line 45) to detect pointer lock support, but `HTMLElement` is always defined in a browser context. The check effectively only tests whether `requestPointerLock` exists on the prototype, which is the right behavior, but the conditional structure is slightly misleading.
- [ ] [Priority: LOW] [Code Quality] `formatBytes()` (lines 106-115) handles bytes, KB, and MB but not GB or TB. Given the current CD-ROM size is ~20 MB this is not an issue, but the function would silently format a 2 GB file as `2097152.0 KB`. Consider extending to GB/TB for future-proofing.

### utilities-src/src/retroVmTypes.ts

- No significant issues found. Clean type definitions with proper discriminated unions and optional fields.

### utilities-src/tests/retroVmConfig.test.ts

- [ ] [Priority: LOW] [Code Quality] `parseBooleanFlag` edge cases are not tested: empty string, whitespace-only string, or mixed-case values like `'TrUe'`. The function normalizes with `toLowerCase()` so `'TrUe'` works, but these are untested paths.
- [ ] [Priority: LOW] [Code Quality] `buildRetroVmV86Options` is tested for network device presence/absence but not for the optional network fields (`routerMac`, `routerIp`, `vmIp`, `masquerade`, `dnsMethod`, `dohServer`, `corsProxy`, `mtu`). These are all conditionally applied (lines 157-164 of retroVmConfig.ts) but never verified in tests.

### utilities-src/tests/retroVmSupport.test.ts

- [ ] [Priority: LOW] [Code Quality] `resolveRetroVmStatusView` is tested for `loading` and `running` states but not for `error` or `unsupported` states, which are the states where `supportReason` is most critical. Consider adding tests verifying the error reason propagates correctly to `statusText`.
- [ ] [Priority: LOW] [Code Quality] `transitionRetroVmState` is tested for happy-path transitions but not for invalid transitions (e.g., `transitionRetroVmState('idle', 'enter-fullscreen')` should stay at `'idle'`). The `assertNever` fallback is tested implicitly but explicit coverage would be more robust.

### scripts/build-retro-vm-image.sh

- [ ] [Priority: MED] [Error Handling] The `cpio` extraction (line 59) uses `set +e` and only fails on exit code >= 2. Exit code 1 from `cpio` means "some files were not extracted" which is silently ignored. This could produce a partially extracted rootfs that passes the build but produces a broken VM image. Consider treating exit code 1 as a warning at minimum, or as a failure.
- [ ] [Priority: LOW] [Code Quality] The script does not validate the output ISO's file size after building. If the build produces an empty or truncated ISO, the `test -f` check on line 97 would still pass. Consider adding a minimum size check to catch silent build failures.
- [ ] [Priority: LOW] [Error Handling] `rsvg-convert` (lines 38-45) runs outside Docker and could fail if SVG source files are missing. While `set -e` would catch the failure, the error message would not indicate which specific SVG file was missing. Consider adding per-file existence checks before conversion.

## Stress Test Utility

### utilities-src/src/stressTestController.ts

- [ ] [Priority: HIGH] [Error Handling] The CPU worker `errorListener` (lines 499-508) calls `stopCpuStress()`, `stopGpuStress()`, and `setState('error')` but does NOT call `stopMetricLoop()`. This leaves the metric loop running indefinitely after a worker error, continuing to update metrics on an error-state page. Compare with `handleStartFailure()` (line 454) which correctly calls `stopMetricLoop()`. Add `this.stopMetricLoop()` to the error listener. (lines 499-508)
- [ ] [Priority: MED] [TypeScript] `getWebGlContext()` uses unsafe type assertions: `as WebGL2RenderingContext | null` (line 629) and `as WebGLRenderingContext | null` (line 633). If `getContext()` returns a non-WebGL context (e.g., a future context type that happens to match the string), the assertion would silently lie to the type system. Use a runtime type check (e.g., `instanceof WebGL2RenderingContext`) instead of `as`. (lines 629, 633)
- [ ] [Priority: MED] [Code Quality] `syncControlPanelFit()` reads `window.getComputedStyle(this.metricsPanel).rowGap` (line 1358) to determine the gap between metric cards. However, modern browsers report grid/container gaps via the `gap` property, not `rowGap`. The `rowGap` property is for legacy table layouts. The fallback to `gap` is present but secondary. Swap the order to check `gap` first, then `rowGap` as fallback. (line 1358)
- [ ] [Priority: LOW] [Code Quality] `stop()` (lines 462-482) resets `totalIterations`, `gpuBackend`, `gpuWorkloadLevel`, and `gpuCanvasActive`, but does NOT reset `frameCount`, `droppedFrames`, or `lastFps`. In contrast, `start()` (lines 388-390) resets all three to zero. This means after stopping and restarting, the cumulative frame and dropped-frame counts persist across runs, and the `data-stress-total-rendered-frames` attribute shows a running total rather than per-run data. Add `this.frameCount = 0`, `this.droppedFrames = 0`, and `this.lastFps = 0` to `stop()`. (lines 462-482)
- [ ] [Priority: LOW] [Performance] `startCpuVisuals()` (line 1095) calls `this.canvas.getContext('2d')` and if it returns null, calls `replaceCanvasElement()` followed by another `getContext('2d')`. However, `prepareGpuCanvas()` (line 1440) already calls `replaceCanvasElement()` before starting GPU stress. If the GPU device is later lost and `startCpuVisuals()` is re-entered (line 806), this causes a second canvas replacement. While functionally correct, the redundant DOM replacement could be avoided by checking whether the canvas already supports 2D context before replacing. (lines 1095-1100)
- [ ] [Priority: LOW] [Browser Compatibility] `experimental-webgl` context type is used as a fallback (lines 575, 632-633). This context type has been deprecated since 2014 and is removed in all modern browsers. It's harmless as a fallback since it returns null, but the string could be removed to avoid confusion for future maintainers. (lines 575, 632-633)
- [ ] [Priority: LOW] [Code Quality] `startWebGlStress()` (line 864) calls `prepareGpuCanvas()` (which replaces the canvas element) before checking if the WebGL context is available. If `getWebGlContext()` returns null, the function returns null but the canvas has already been replaced. If the backend fallback loop then tries other backends, each attempt replaces the canvas again. Consider deferring `prepareGpuCanvas()` until after the context is confirmed available. (lines 865-869)
NOTE: [Priority: LOW] [Browser Compatibility] `color-mix()` is used extensively (lines 627, 628, 638, 639, 690, 956, 1300). Browsers without support (Safari < 16.2, Firefox < 113, Chrome < 111) will treat the declaration as invalid and fall back to the previous value or default. Add fallback declarations before `color-mix()` lines. NOTE: Hardcoded fallback values are already declared before each `color-mix()` line (e.g., lines 626-627: `background: #F7F8F6; border-color: #C7D1C4;` before the `color-mix()` overrides). This is an intentional progressive enhancement pattern.
NOTE: [Priority: LOW] [Browser Compatibility] `color-mix(in srgb, var(--schematic-text) 66%, var(--schematic-flare))` (line 276) has no fallback. Older browsers will drop the stroke color entirely. NOTE: Line 275 has `stroke: #572300;` as the fallback declaration before the `color-mix()` override.
NOTE: [Priority: LOW] [Code Quality] `!important` is used in `.schematic-border` variants (lines 400-403) and `.schematic-text` (line 372). While intentional for override, this increases specificity debt. Consider using a more specific selector instead. NOTE: These are utility classes; `!important` is intentional for override.
NOTE: [Priority: LOW] [Accessibility] The hero `<img>` (line 71) and lightbox `<img>` (line 163) ship with empty `alt=""` attributes. They are populated dynamically by gallery.js, but if JS fails to load or is blocked, these images render with no accessible description. Consider adding a minimal fallback alt text in the HTML. NOTE: Images with alt="" dynamically populated by JS per the exemption rules.
NOTE: [Priority: LOW] [Code Quality] Empty formatting in `@media (max-width: 1280px)` block (lines 926-931) -- extra closing brace on line 931. Clean up the formatting. NOTE: No extra closing brace exists; line 931 is the correct closing brace for the `@media` block. Line 930 is just an empty formatting line.
NOTE: [Priority: LOW] [Browser Compatibility] `color-mix()` is used 14 times (lines 1893-2009) without any fallback declarations. Browsers without support (Safari < 16.2, Firefox < 113, Chrome < 111) will silently drop the flair color effects, leaving `--flair-dark`, `--flair-glow`, `--flair-soft` and dependent properties unresolved. Add explicit fallback values before the `color-mix()` declarations. (lines 1893-2009) NOTE: Hardcoded fallback values ARE declared before each `color-mix()` (e.g., lines 1890-1892: `--flair-dark: #9a3d00; --flair-glow: rgba(255, 103, 0, 0.3); --flair-soft: rgba(255, 103, 0, 0.15);` before the `color-mix()` overrides on lines 1893-1895). This is an intentional progressive enhancement pattern.
NOTE: [Priority: LOW] [Code Quality] Duplicate CSS custom property declarations: `--flair-dark` is declared at lines 1890 and 1893, and `--flair-glow` at lines 1891 and 1894. The first declarations (hardcoded hex/rgba values) are immediately overridden by the `color-mix()` versions. Remove the redundant first declarations. (lines 1890-1895) NOTE: These are intentional fallback declarations for browsers without `color-mix()` support (Firefox < 113, Safari < 16.2, Chrome < 111). The first hardcoded values serve as fallbacks.
NOTE: [Priority: MED] [Browser Compatibility] `color-mix()` is used 20+ times (lines 57, 62, 122, 123, 130, 131, 139, 140, 252, 282, 324, 325, 395, 398, 442, 470, 510, 522, 528, 534, 578, 580) without any fallback declarations. Browsers without support (Safari < 16.2, Firefox < 113, Chrome < 111) will silently drop these declarations, leaving border colors, backgrounds, and focus styles unresolved. Add explicit fallback values before each `color-mix()` declaration. NOTE: Hardcoded rgba fallback values ARE declared before each `color-mix()` (e.g., line 56: `border: 1px solid rgba(0, 229, 255, 0.45);` before line 57: `border-color: color-mix(...)`. This is an intentional progressive enhancement pattern.
