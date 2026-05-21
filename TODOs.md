# TODOs

## Gallery Hero Image (Lighthouse) Loading Issue

### Problem
On the gallery page, the hero feature card shows the text "Lighthouse" briefly before the image loads. This happens because the hero image has no loading-state management, and the browser renders the `alt` text as a fallback while the image downloads.

### Root Cause Analysis

**1. Hero image has no `load` event listener or loading state classes**
- File: `js/gallery.js` — `syncHeroFeature()` (lines 345–381)
- The function sets `src`, `srcset`, `sizes`, and `alt` on `#galleryHeroImage` but never attaches a `load` event listener or toggles any loading class.
- Contrast with `createPhotoCard()` (lines 466–578) which correctly adds `is-loading` on creation and switches to `is-loaded` on the image `load` event (lines 543–546).

**2. Hero image CSS has no hidden/unloaded state**
- File: `css/gallery.css` — `.hero-feature-image` (lines 167–180)
- `.photo-image` (line 411–415) starts at `opacity: 0` and transitions to `opacity: 1` when `.photo-card.is-loaded` is applied.
- `.hero-feature-image` has no equivalent `opacity: 0` default or loading-state class. It renders immediately once `src` is set, showing alt text during the download gap.

**3. No `<link rel="preload">` for the hero image**
- File: `pages/gallery/index.html`
- The hero image (lighthouse, `a7rii_474`) is the highest-priority visual element on the page but has no preload hint in the `<head>`. The browser only discovers it after JS parses and runs `syncHeroFeature()`, adding unnecessary latency.
- The hero image uses responsive `srcset` with medium (124K JPG / 51K AVIF) and large (278K JPG / 84K AVIF) variants. Preloading the medium AVIF variant would be the most impactful single optimization.

**4. `alt` attribute set before image is loaded**
- File: `js/gallery.js` line 370: `gallery.elements.heroImage.alt = entry.displayTitle;`
- This sets `alt="Lighthouse"` synchronously alongside `src`. Browsers render the alt text in the image slot until the image data arrives, causing the visible "Lighthouse" text flicker.

### Actionable Fixes

1. **Add loading state to hero image** (`js/gallery.js` / `css/gallery.css`):
   - Set `.hero-feature-image` to `opacity: 0` by default (like `.photo-image`).
   - Add a `load` event listener in `syncHeroFeature()` that adds an `is-loaded` class to the hero picture/button.
   - Add `.hero-feature-image.is-loaded { opacity: 1; }` CSS rule with a smooth transition.

2. **Add a white placeholder background** (`css/gallery.css`):
   - Set `.hero-feature-media` background to `#FFFFFF` so the frame appears white while the image loads, matching the desired "empty white frame" behavior.
   - Current value is `background: transparent` (line 150).

3. **Preload the hero image** (`pages/gallery/index.html`):
   - Add a `<link rel="preload">` for the hero image's medium AVIF variant in the `<head>`.
   - Since the hero entry is dynamic (loaded from JSON), one approach is to hardcode the known hero preload in HTML, or alternatively use a `<link rel="modulepreload">`-style dynamic preload via JS before `syncHeroFeature()` runs.
   - The lighthouse is currently `hero.priority: 1` in `assets/photos/gallery-sequence.json`, making it the definitive hero. A hardcoded preload is safe as long as the hero doesn't rotate frequently.

4. **Consider deferring `alt` attribute** (`js/gallery.js`):
   - Set `alt=""` initially and only set the real alt text after the image loads. This prevents the browser from showing fallback text during the download window.

### Asset Sizes (Lighthouse: `a7rii_474`)
| Variant | AVIF | WebP | JPG |
|---------|------|------|-----|
| Thumb   | 17K  | 22K  | 28K |
| Medium  | 51K  | 113K | 124K |
| Large   | 84K  | 253K | 278K |

The AVIF encoding is already well-optimized (84K for large). Preloading the medium AVIF (51K) would give the fastest perceived load time for most viewports.

### Relevant Files
- `js/gallery.js` — `syncHeroFeature()` (line 345), `createPhotoCard()` (line 466) for reference pattern
- `css/gallery.css` — `.hero-feature-image` (line 167), `.hero-feature-media` (line 141), `.photo-image` (line 411) as reference
- `pages/gallery/index.html` — `<head>` for preload link insertion
- `assets/photos/gallery-sequence.json` — hero priority metadata
- `assets/photos/photos.json` — asset manifest

## Audio Fourier "Worker failure" on Deployed Site (CRITICAL)

### Problem
The Fourier Reconstruction utility is completely broken on the deployed GitHub Pages site. Both the built-in demo songs and uploaded audio files fail immediately with the error message "Worker failure" / "Audio worker unavailable. Press Generate to retry." The utility works perfectly in local development.

### Root Cause Analysis

**1. Worker type mismatch: `{ type: 'module' }` vs IIFE-bundled output**

- Source file: `utilities-src/src/audioFourierController.ts` (line 704)
  ```ts
  this.worker = new Worker(new URL('./audioFourier.worker.ts', import.meta.url), {
    type: 'module'
  });
  ```
- The worker is created with `{ type: 'module' }`, telling the browser to parse the fetched file as an ES module.
- However, Vite 7 bundles the worker output as a classic IIFE script:
  - Built file: `pages/utilities/assets/assets/audioFourier.worker-CsfLzLF1.js`
  - Content starts with `(function(){"use strict";...` — this is a classic script, not an ES module.
  - Contains zero `import` statements and no module syntax at all.
- **Why it works locally**: Vite's dev server intercepts the `new URL('./audioFourier.worker.ts', import.meta.url)` resolution and serves the TypeScript source as a proper ES module via HMR, bypassing the bundled output entirely.
- **Why it fails on GitHub Pages**: The static server delivers the IIFE-bundled file. The browser tries to parse `(function(){...})()` as an ES module, which is not valid module syntax. This triggers the worker's `error` event, which calls `handleWorkerFailure()` at line 736–745, producing the "Worker failure" message.

**2. Same issue affects all three utility workers**

All three worker files are bundled as IIFE but loaded with `{ type: 'module' }`:
- `audioFourier.worker.ts` → `audioFourier.worker-CsfLzLF1.js` (IIFE, loaded as module)
- `stressTest.worker.ts` → `stressTest.worker-B6MGbhnL.js` (IIFE, loaded as module)
- `transform.worker.ts` → `transform.worker-dAD06nWs.js` (IIFE, loaded as module)
- `matching.worker.ts` → `matching.worker-el_56P4a.js` (IIFE, loaded as module)

The Image Transform utility has a fallback mechanism (falls back to main thread on worker failure), so it degrades gracefully. The Stress Test may also fail on deployment but hasn't been reported. The Audio Fourier has no fallback, making it completely broken.

**3. Vite config does not set `workerFormat`**

- File: `config/vite.utilities.mts`
- The config does not specify a `workerFormat` option. Vite 7 defaults to bundling workers as IIFE (classic script format) when `build.rollupOptions.output.format` is `'es'`. This creates the mismatch.
- The `build.rollupOptions.output.format` is set to `'es'` (line 18), which controls the main bundle format but workers get their own handling.

**4. Secondary issue: Hardcoded relative asset paths for built-in audio presets**

- File: `utilities-src/src/audioPresets.ts` (line 23)
  ```ts
  const FOURIER_DECOMPOSE_ASSET_BASE = '../../assets/utilities/fourier-decompose';
  ```
- These paths are relative to the HTML page (`pages/utilities/index.html`), not to the JS module.
- The `audioFourierController.js` chunk is loaded as an ES module from `./assets/utilities-app.js`, and `audioFourierController.js` imports from `./utilities-app.js`.
- When `resolveAudioSource()` calls `fetch(preset.url, { mode: 'same-origin' })` at line 637, the relative URL `../../assets/utilities/fourier-decompose/Best Friends.flac` is resolved relative to the HTML document URL (not the module URL), which should resolve correctly to `/assets/utilities/fourier-decompose/Best Friends.flac`.
- This is a secondary concern that would only surface after the worker issue is fixed.

### Actionable Fixes

1. **Set `workerFormat: 'module'` in Vite config** (`config/vite.utilities.mts`):
   - Add `workerFormat: 'module'` to the build options. This tells Vite to bundle workers as proper ES modules instead of IIFE scripts.
   - Example:
     ```ts
     export default defineConfig({
       base: './',
       build: {
         workerFormat: 'module',
         // ...existing options...
       }
     });
     ```
   - Alternatively, set `build.rollupOptions.output.format: 'es'` (already set) and ensure the worker bundling respects this. In Vite 7, `workerFormat` may need to be explicitly set.

2. **Or remove `{ type: 'module' }` from Worker constructors** if workers don't actually need module syntax:
   - Change `new Worker(new URL('./audioFourier.worker.ts', import.meta.url), { type: 'module' })` to `new Worker(new URL('./audioFourier.worker.ts', import.meta.url))`.
   - This matches the IIFE output format. Since the worker code has no `import`/`export` statements in its bundled form, it doesn't need module mode.
   - This would also need to be changed in `stressTestController.ts` (line 498) and `main.ts` (line 927).

3. **Or use Vite's `worker` plugin options** to ensure consistent bundling:
   - Configure `build.commonjsOptions` or use `@rollup/wasm-node` to ensure workers are bundled correctly.
   - The `__vite-browser-external.js` file exists but is empty, suggesting some external handling is in place.

4. **Add worker error diagnostics for production** (`audioFourierController.ts`):
   - The `handleWorkerFailure()` method (line 736) currently has no logging. Adding `console.error` with the event details (filename, lineno, message) would help diagnose the exact error on deployed sites.
   - The `shouldDebugAudioFourierWarnings` function already exists but only enables warnings on localhost. Consider extending this or adding a separate production error logger.

5. **Rebuild after fix**: Run `npm run utilities:build` and verify the worker file starts with proper module syntax (or that the `{ type: 'module' }` flag is removed).

### Relevant Files
- `utilities-src/src/audioFourierController.ts` — worker instantiation (line 704), `handleWorkerFailure()` (line 736), `supportsModuleWorkers()` (line 44)
- `utilities-src/src/audioFourier.worker.ts` — worker source (bundled as IIFE by Vite)
- `utilities-src/src/audioPresets.ts` — hardcoded relative asset paths (line 23)
- `config/vite.utilities.mts` — Vite build config (missing `workerFormat` option)
- `utilities-src/src/stressTestController.ts` — same pattern at line 498
- `utilities-src/src/main.ts` — same pattern at line 927
- `pages/utilities/assets/assets/audioFourier.worker-CsfLzLF1.js` — built output (IIFE format)
- `pages/utilities/assets/audioFourierController.js` — built controller (line 108: `new Worker(...{type:"module"})`)
- `pages/utilities/assets/__vite-browser-external.js` — Vite browser-external shim (empty object)

## Local LLM Chat — Model Cached After Hard Refresh (CRITICAL)

### Problem
The Bonsai model remains cached in the browser even after a hard refresh (Cmd+Shift+R / Ctrl+Shift+R). The user expects the model to be cleared from cache when not actively loaded, but it persists across page reloads.

### Root Cause Analysis

**1. Hard refresh does not clear the Cache API**

- The model is cached via the **Browser Cache API** (not HTTP cache, not localStorage, not IndexedDB).
- Transformers.js enables this at `js/local-llm-worker.js` line 354: `env.useBrowserCache = true`.
- A hard refresh clears the browser's HTTP fetch cache but **does not touch the Cache API**. The Cache API is a persistent JavaScript-managed storage that survives hard refreshes, tab closures, and even browser restarts.
- The `deleteLocalModelCaches()` function in `js/local-llm-cache.js` (lines 1–13) targets cache names matching `/huggingface|transformers|local-llm|bonsai/i` and calls `cacheStorage.delete(name)`. This works, but it is only invoked programmatically.

**2. Cache cleanup on pagehide is unreliable (fire-and-forget async)**

- File: `js/local-llm-chat.js` line 214: `_pagehideHandler` calls `endModelSession({ clearMessages: false, updateUi: false })`.
- `endModelSession()` (line 1099) calls `terminateWorker({ clearCache: true, delayMs: 800 })` and `this.clearBrowserModelCaches().catch(...)`.
- `terminateWorker()` (line 1127) sends a `{ type: 'dispose', clearCache: true }` message to the worker, then waits `delayMs: 800` before calling `worker.terminate()`.
- The worker's `disposeModel()` (line 258) calls `deleteLocalModelCaches(self.caches, ...)` — but this is async.
- **The problem**: On `pagehide`, the browser may abort pending async operations before they complete. The `clearBrowserModelCaches()` call on the main thread is fire-and-forget (`.catch()` only, no `.then()`), and the worker's cleanup is gated behind an 800ms delay. The browser does not wait for either during page unload.
- Even if the cache deletion starts, the 800ms delay means the worker might still be processing when the page is torn down.

**3. No cache-busting for model files themselves**

- The script tag uses a versioned query param: `?v=utilities-2026-05-16-local-assistant-copy` (line 121 of `js/utilities-shell.js`). This only affects the JS/CSS file cache, not the model files cached by Transformers.js.
- Transformers.js caches model files under its own cache names (typically matching `transformers` or `huggingface`). The version string in the script URL has no effect on these.

### Actionable Fixes

1. **Use `beforeunload` instead of (or in addition to) `pagehide` for cache cleanup**:
   - The `beforeunload` event is synchronous — the browser waits for handlers to complete before unloading. Move the cache deletion logic to `beforeunload` or use it as a backup.
   - Alternatively, use the `navigator.sendBeacon()` API to signal cache cleanup, though this doesn't directly help with Cache API deletion.

2. **Reduce or eliminate the `delayMs` for cache-clearing terminations**:
   - In `terminateWorker()`, when `clearCache` is true, the 800ms delay gives the worker time to clean up, but on pagehide this delay is counterproductive. Consider a shorter delay (e.g., 100ms) or immediate termination when clearing cache on unload.

3. **Clear cache synchronously on the main thread before pagehide**:
   - Call `deleteLocalModelCaches(window.caches, ...)` directly in the `pagehide` handler without waiting for the worker. The worker's own cleanup is redundant if the main thread already deleted the caches.

4. **Add a "Clear cache" option to the Reset button or make it default on dispose**:
   - Currently the "Clear cache" button only appears in the diagnostics panel after an error. Consider always showing it or making cache clearing part of the normal dispose flow.

5. **Consider using a versioned cache name in Transformers.js**:
   - If Transformers.js allows customizing the cache name, include a version suffix. This way, updating the model version automatically bypasses the old cache without needing explicit deletion.

### Relevant Files
- `js/local-llm-worker.js` — `env.useBrowserCache = true` (line 354), `disposeModel()` (line 258)
- `js/local-llm-chat.js` — `_pagehideHandler` (line 214), `endModelSession()` (line 1099), `terminateWorker()` (line 1127), `clearModelCache()` (line 1037)
- `js/local-llm-cache.js` — `deleteLocalModelCaches()` (line 1)
- `js/utilities-shell.js` — script loading with `?v=` param (line 121)

## Local LLM Chat — Non-Responsive After Model Load (CRITICAL)

### Problem
The utility does not respond to user messages even when the model shows as "Loaded" / READY. The user types a message, clicks Send, but no response is generated.

### Root Cause Analysis

**1. Worker module import chain may fail silently on GitHub Pages**

- File: `js/local-llm-chat.js` line 248: `new Worker(new URL('./local-llm-worker.js', import.meta.url), { type: 'module' })`
- The parent script is loaded via `<script type="module" src="../../js/local-llm-chat.js?v=utilities-2026-05-16-local-assistant-copy">` (line 121 of `js/utilities-shell.js`).
- The `import.meta.url` of the parent includes the `?v=` query parameter. When resolving `new URL('./local-llm-worker.js', import.meta.url)`, the worker URL inherits this query param.
- The worker's own ES module imports (`./local-llm-config.js`, `./local-llm-cache.js`, `./local-llm-rendering.js` at lines 1–3 of `js/local-llm-worker.js`) also inherit the query param. GitHub Pages serves these correctly (ignoring query params), but the import resolution chain adds complexity.
- **Unlike the Vite-bundled utility workers** (which have the documented IIFE/module mismatch), this worker is a raw JS file, so `{ type: 'module' }` is correct. The import chain should resolve.

**2. Dynamic import of Transformers.js from CDN inside the worker**

- File: `js/local-llm-worker.js` line 97: `transformersModule = await import(LOCAL_LLM_CONFIG.runtime.moduleUrl)`
- This resolves to `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0`.
- This is a cross-origin dynamic import inside a Web Worker. While jsDelivr serves CORS headers, some browser configurations or network conditions may block or silently fail this import.
- If the import fails, `loadModelInternal()` catches the error and sends an error message — but the error handler in `handleWorkerMessage` (line 344–348) shows diagnostics. If the user dismisses diagnostics or the error message is subtle, the UI may appear "stuck" at READY from a previous session.

**3. `pastKeyValuesCache` reuse across generations may cause silent hangs**

- File: `js/local-llm-worker.js` line 8: `let pastKeyValuesCache = null`
- Line 149: `pastKeyValuesCache ??= new DynamicCache()`
- Line 208: `past_key_values: pastKeyValuesCache`
- The `DynamicCache` is reused across all generations. After `generateReply` completes, `disposePastKeyValues()` (line 222) calls `pastKeyValuesCache?.dispose?.()` and sets it to null.
- However, if generation is interrupted (line 240–245), `disposePastKeyValues()` is NOT called. The next generation reuses a potentially corrupted cache via `pastKeyValuesCache ??= new DynamicCache()`.
- Similarly, if an error occurs during generation that doesn't trigger the `disposePastKeyValues()` call in the catch block, the cache may be in an inconsistent state.

**4. `pendingGenerateCount` silently drops messages**

- File: `js/local-llm-worker.js` lines 27–32: If `pendingGenerateCount >= MAX_PENDING_GENERATE_MESSAGES` (2), the message is silently dropped.
- The main thread has no way to know the message was dropped — it just waits for a response that never comes.

**5. Model state may desync between main thread and worker**

- The main thread tracks `this.modelReady` and `this.status`. The worker tracks its own `state` variable.
- If the worker encounters an error during `generateReply` but the main thread's status is still READY, subsequent messages will be sent to a worker that may be in an inconsistent state.
- The `generationId` guard (`activeGeneration`) prevents stale responses, but if the worker is stuck, no new response arrives.

### Actionable Fixes

1. **Add error logging to `pendingGenerateCount` drop path**:
   - Log a warning when a generate message is dropped, and optionally send an error message back to the main thread.

2. **Call `disposePastKeyValues()` in `interruptGeneration()`**:
   - Add `disposePastKeyValues()` to the interrupt handler (line 240–245) to prevent cache corruption on interrupted generations.

3. **Add worker health check before sending generate messages**:
   - In `sendMessage()`, add a heartbeat/ping mechanism to verify the worker is responsive before sending a generate request.

4. **Strip query params from worker URL**:
   - In `createWorker()`, resolve the worker URL without inheriting the parent script's query params:
     ```js
     const workerUrl = new URL('./local-llm-worker.js', import.meta.url);
     workerUrl.search = ''; // Strip query params
     return new Worker(workerUrl, { type: 'module' });
     ```

5. **Add a timeout to generation requests**:
   - If no tokens arrive within a configurable timeout (e.g., 30 seconds), treat it as a failure and reset the worker state.

6. **Improve error visibility**:
   - When the worker sends an error during generation, ensure the main thread surfaces it prominently (not just in a diagnostics panel that may be hidden).

### Relevant Files
- `js/local-llm-chat.js` — `createWorker()` (line 244), `sendMessage()` (line 722), `handleWorkerMessage()` (line 285)
- `js/local-llm-worker.js` — `generateReply()` (line 133), `interruptGeneration()` (line 239), `pendingGenerateCount` guard (line 27), `pastKeyValuesCache` (line 8, 149, 208)
- `js/local-llm-config.js` — `runtime.moduleUrl` (line 26)
- `js/utilities-shell.js` — script loading with `?v=` param (line 121)

## Retro VM — Mouse Capture Is Buggy (HIGH)

### Problem
The mouse capture in the Retro VM (v86 x86 emulator running Tiny Core Linux) is described as "very buggy and not at all smooth or natural feeling."

### Root Cause Analysis

**1. Absolute mousemove listener is scoped to the screen container, not document**

- File: `utilities-src/src/retroVmController.ts` — `RetroVmMouseBridge.attachAbsoluteMouseMove()` (line 402)
- The `mousemove` listener for absolute mode is attached to `this.root` (the `.vm-screen` container). When the host cursor leaves the VM viewport boundary, `mousemove` events stop firing entirely. The guest mouse freezes at the last known position until the cursor re-enters the viewport.
- Contrast with pointer-locked mode: `onLockedMouseMove` is correctly attached to `document` (line 377), which receives events even when the cursor is "captured."
- **Impact**: Before pointer lock is acquired (the default state), any mouse movement that exits the VM screen area causes the guest cursor to freeze. This feels "stuck" and unresponsive.

**2. `requestPointerLock()` is called on every mousedown, not just the first click**

- File: `utilities-src/src/retroVmController.ts` — `onMouseDown` (line 291)
- `void this.requestPointerLock()` fires on every mouse click inside the VM, even when pointer lock is already active.
- `requestPointerLock()` has a guard (`if (this.pointerLocked || !this.canCapture()) return` at line 510), but the `pointerLocked` flag is only updated asynchronously via the `pointerlockchange` event (line 347–355). Between the first click and the `pointerlockchange` event firing, a second click can attempt a redundant lock request.
- **Impact**: Redundant lock requests can cause brief visual glitches (browser cursor flicker) and unnecessary event churn, making the capture feel "jittery."

**3. Delta mouse movement is divided by display scale — wrong for pointer lock**

- File: `utilities-src/src/retroVmController.ts` — `sendLockedDelta` (lines 498–506)
- The code divides `movementX` and `movementY` by `safeScale` (the display scaling factor):
  ```ts
  const deltaX = (typeof event.movementX === 'number' ? event.movementX : 0) / safeScale;
  const deltaY = (typeof event.movementY === 'number' ? event.movementY : 0) / safeScale;
  ```
- With `{ unadjustedMovement: true }` (line 525), `movementX/Y` are already raw pixel deltas from the OS. Dividing by scale means:
  - At 0.5x display scale (VM fits in half the viewport), deltas are doubled → mouse feels 2x hypersensitive.
  - At 1.5x display scale (VM fills most of viewport), deltas are reduced by 0.67x → mouse feels sluggish.
- **Impact**: Mouse sensitivity changes based on window size. At smaller windows, the guest mouse flies around; at larger windows, it feels heavy. This is the most likely cause of the "not natural feeling" complaint.

**4. No `event.preventDefault()` in `sendLockedDelta` for non-zero deltas**

- File: `utilities-src/src/retroVmController.ts` — `sendLockedDelta` (lines 487–507)
- The function returns early if both deltas are zero (line 502–504), but for non-zero deltas it sends the event to the bus without calling `event.preventDefault()`.
- **Impact**: If pointer lock is somehow lost mid-drag (e.g., via Alt+Tab or browser tab switch), the `mousemove` event could still propagate and cause page scroll. Minor issue but worth fixing.

**5. Position jump when transitioning from absolute to delta mode**

- When the user clicks to capture:
  1. `onMouseDown` sends the current absolute position (`sendAbsolutePosition` at line 290).
  2. Pointer lock is requested.
  3. `pointerlockchange` fires, `syncAbsoluteMouseMoveListener()` detaches the absolute listener.
  4. Subsequent `mousemove` events fire `onLockedMouseMove` → `sendLockedDelta`.
- The problem: the first `mousemove` after pointer lock acquires sends a delta from wherever the OS cursor was "locked." v86's mouse driver may not have a consistent origin, causing the guest cursor to jump.
- **Impact**: After clicking to capture, the guest mouse cursor may jump to a different position before settling, feeling "glitchy."

### Actionable Fixes

1. **Remove scale division from delta movement** (`retroVmController.ts` line 498–500):
   - For pointer-locked mouse input, use raw `movementX`/`movementY` directly without dividing by `safeScale`. The OS already sends raw pixel deltas, and v86 expects 1:1 mapping.
   - Change to:
     ```ts
     const deltaX = typeof event.movementX === 'number' ? event.movementX : 0;
     const deltaY = typeof event.movementY === 'number' ? event.movementY : 0;
     ```
   - This is the single most impactful fix for the "not natural feeling" issue.

2. **Add `event.preventDefault()` to `sendLockedDelta`** (line 506):
   - Add `event.preventDefault()` after `bus.send('mouse-delta', ...)` to prevent any page-level side effects.

3. **Send an initial absolute position after pointer lock acquires** (in `onPointerLockChange`):
   - After pointer lock is confirmed, send a `mouse-absolute` event with the last known position to anchor the guest cursor. This prevents the positional jump when transitioning modes.
   - Track the last absolute position in a private field, then send it via `bus.send('mouse-absolute', ...)` in `onPointerLockChange` after confirming lock.

4. **Extend absolute mousemove listener to a broader scope** (`attachAbsoluteMouseMove`):
   - Instead of attaching `mousemove` to `this.root`, attach it to `document` when not pointer-locked. This ensures the guest mouse keeps receiving position updates even when the host cursor leaves the VM viewport.
   - Guard with a bounds check: only send `mouse-absolute` if the cursor is within the VM container's bounding rect.
   - Alternatively, request pointer lock on `mouseenter` of the VM screen instead of waiting for `mousedown`, giving smoother initial capture.

5. **Guard `requestPointerLock()` more aggressively** (`onMouseDown`):
   - Add a cooldown or flag to prevent redundant lock requests. The existing `this.pointerLocked` guard is race-prone because it's updated asynchronously. Add a `lockRequested` flag that is set immediately when `requestPointerLock()` is called and cleared on `pointerlockchange`.

### Relevant Files
- `utilities-src/src/retroVmController.ts` — `RetroVmMouseBridge` class (lines 276–550), especially:
  - `attachAbsoluteMouseMove()` (line 397)
  - `onMouseDown` (line 288)
  - `sendLockedDelta` (line 487)
  - `requestPointerLock` (line 509)
  - `onPointerLockChange` (line 347)
  - `sendAbsolutePosition` (line 435)
- `pages/utilities/index.html` — VM HTML structure (line 280–330)

## Retro VM — Top Bar Buttons Stack Vertically at Reasonable Width (MEDIUM)

### Problem
The VM toolbar buttons (Launch, Paste, Fullscreen, Wipe) start stacking vertically when the browser window narrows, and this happens at a "very reasonable width" — meaning the breakpoint is too wide and the buttons wrap prematurely.

### Root Cause Analysis

**1. `.vm-toolbar-actions` has `flex-wrap: wrap` with no min-width protection**

- File: `css/utilities.css` line 2577–2581:
  ```css
  .vm-toolbar-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  ```
- `flex-wrap: wrap` allows buttons to flow to a second line whenever horizontal space is insufficient. There is no `min-width` on the container to force a wider breakpoint before wrapping.

**2. `btn-secondary-utility--compact` class has no CSS definition**

- The buttons use class `btn-secondary-utility btn-secondary-utility--compact` (HTML line 310–313).
- The `--compact` modifier has **zero CSS rules** defined in `css/utilities.css`. A search for `btn-secondary-utility--compact` finds only the HTML usage and one usage in `js/local-llm-chat.js`.
- Without the compact styles, buttons inherit the full `.btn-secondary-utility` sizing: `min-height: 2.65rem` and `padding: 0 1rem` (line 514–516).

**3. Toolbar is packed with 9 elements, none of which can shrink**

- The `.vm-toolbar` (line 2514–2522) contains these elements in a single flex row:
  1. `.vm-status-dot` — 0.4rem circle (flex-shrink: 0)
  2. `.vm-toolbar-title` — "Idle" text (no flex-shrink override)
  3. `.vm-toolbar-meta` — "Tiny Core Linux 11" (no flex-shrink override)
  4. `.utility-status-chip` — "Idle" chip with `min-width: 6rem` (line 269)
  5. `.sr-only` — screen reader text (visually hidden)
  6. `.vm-capture-badge` — "Click desktop to capture mouse" (no truncation)
  7. `.vm-screen-badge` — "Local only" (no flex-shrink override)
  8. `.vm-toolbar-actions` div containing 4 buttons
  9. (implicit gap between each)
- The `.vm-capture-badge` has `margin-left: auto` (line 2592), which pushes it and everything after it to the right edge. Combined with the long text "Click desktop to capture mouse," this consumes significant horizontal space.

**4. No text truncation on any toolbar text elements**

- `.vm-toolbar-title`, `.vm-toolbar-meta`, `.vm-capture-badge`, and `.vm-screen-badge` have no `overflow: hidden`, `text-overflow: ellipsis`, or `white-space: nowrap` rules. Long text expands the toolbar width.

**5. `.utility-status-chip` has `min-width: 6rem`**

- File: `css/utilities.css` line 269
- This forces the status chip to always take at least 96px, which is a large fixed commitment in a narrow toolbar.

### Actionable Fixes

1. **Define `.btn-secondary-utility--compact` CSS** (`css/utilities.css`):
   - Add a compact variant with reduced padding and smaller font:
     ```css
     .btn-secondary-utility--compact {
       min-height: 2rem;
       padding: 0 0.65rem;
       font-size: 0.8rem;
     }
     ```
   - This alone would save ~20-30px per button (4 buttons × ~25px = ~100px of horizontal space).

2. **Add `flex-shrink: 0` to `.vm-toolbar-actions`** (`css/utilities.css` line 2577):
   - Prevent the actions container from shrinking below its natural width, which forces other elements to compress first:
     ```css
     .vm-toolbar-actions {
       flex-shrink: 0;
       /* ...existing rules... */
     }
     ```

3. **Truncate `.vm-capture-badge` text** (`css/utilities.css`):
   - Add text truncation to the capture badge since its text is long ("Click desktop to capture mouse" / "Mouse captured · Press Escape to release"):
     ```css
     .vm-capture-badge {
       max-width: 12rem;
       overflow: hidden;
       text-overflow: ellipsis;
       white-space: nowrap;
     }
     ```

4. **Reduce `.utility-status-chip` min-width in VM context** (`css/utilities.css`):
   - Override the global `min-width: 6rem` for the VM toolbar specifically:
     ```css
     .vm-toolbar .utility-status-chip {
       min-width: 4.5rem;
     }
     ```

5. **Remove `flex-wrap: wrap` or add a `min-width` to `.vm-toolbar-actions`**:
   - Either remove `flex-wrap: wrap` entirely (buttons stay on one line, overflow scrolls if needed), or add a minimum width that forces wrapping only at very narrow viewports:
     ```css
     .vm-toolbar-actions {
       min-width: 18rem; /* forces buttons to stay inline until toolbar is very narrow */
     }
     ```

### Relevant Files
- `css/utilities.css` — `.vm-toolbar` (line 2514), `.vm-toolbar-actions` (line 2577), `.utility-status-chip` (line 265), `.vm-capture-badge` (line 2591)
- `pages/utilities/index.html` — VM toolbar HTML (line 300–315)

## CPU Stress Test Not Working on Deployed Site (CRITICAL)

### Problem
The CPU stress test does not work on the deployed GitHub Pages site. The GPU stress test works fine. The user reports: "The CPU stress test just doesn't work. The GPU test seems to be alright though."

### Root Cause Analysis

**1. Same worker type mismatch as Audio Fourier: `{ type: 'module' }` vs IIFE-bundled output**

This is the exact same root cause documented in the "Audio Fourier Worker failure" section above. The CPU stress test was already flagged as potentially affected (TODOs.md line 91–92: "`stressTest.worker.ts` → `stressTest.worker-B6MGbhnL.js` (IIFE, loaded as module)") but noted as "hasn't been reported." It is now confirmed broken.

- Source file: `utilities-src/src/stressTestController.ts` (line 498)
  ```ts
  const worker = new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' });
  ```
- Built file: `pages/utilities/assets/assets/stressTest.worker-B6MGbhnL.js`
- Built file starts with: `(function(){"use strict";...` — classic IIFE script, not an ES module.
- The browser tries to parse IIFE code as ES module, triggers the worker's `error` event, which calls the error handler at lines 502–510 of `stressTestController.ts`, producing a "CPU stress worker failed" error state.

**2. Why GPU stress works but CPU stress doesn't**

The GPU stress test does NOT use Web Workers at all. It runs entirely on the main thread:
- WebGPU path: `startWebGpuStress()` (line 640) — creates compute/render pipelines directly on the main thread, drives animation via `requestAnimationFrame`.
- WebGL path: `startWebGlStress()` (line 868) — compiles shaders and renders via `requestAnimationFrame` on the main thread.
- No worker instantiation, no `{ type: 'module' }` flag, no IIFE/module mismatch. This is why GPU stress works perfectly on GitHub Pages.

The CPU stress test, by contrast, spawns N workers (based on `navigator.hardwareConcurrency`) at line 497–528. Each worker fails immediately because of the module type mismatch.

**3. No fallback mechanism for CPU stress workers**

Unlike the Image Transform utility (which falls back to main thread on worker failure), the CPU stress test has zero fallback:
- `supportsModuleWorkers()` (line 165–184) checks if the browser supports module workers via a blob URL test — this always returns `true` in modern browsers. It does NOT check whether the Vite-bundled worker file is actually parseable as a module.
- If `supportsModuleWorkers()` returns false, it throws: "This browser does not support module workers required for CPU stress."
- If workers are created but fail to parse, the `error` event fires (line 502–510), which stops ALL stress (both CPU and GPU) and sets state to `'error'`.
- In "both" mode (the default), the GPU stress starts successfully, then the CPU workers fail, and the error handler at line 503–504 calls `stopGpuStress()` — killing the working GPU stress too.

**4. Error handler kills GPU stress when CPU workers fail**

This is a critical interaction bug. In the default "both" mode:
1. `startCpuStress()` runs (line 404) — spawns workers, they fail.
2. `startGpuStress()` runs (line 408) — succeeds.
3. A CPU worker's `error` event fires asynchronously (line 502–510).
4. The error handler calls `stopGpuStress({ loseContext: true })` (line 504).
5. GPU stress is killed even though it was working fine.
6. State is set to `'error'` with message like "CPU stress worker failed: [error details]."

This means even in "both" mode, the user sees an error state rather than "GPU running, CPU unavailable."

**5. `supportsModuleWorkers()` blob test is misleading**

The function at line 165–184 creates a blank blob worker with `{ type: 'module' }`. This tests browser support for module workers in general, but it does NOT test whether the actual Vite-bundled worker file is valid module syntax. The blob contains `''` (empty string), which is valid module syntax. The real worker file contains IIFE code, which is NOT valid module syntax. The check passes but the actual workers fail.

### Actionable Fixes

1. **Apply the same fix as Audio Fourier** — either set `workerFormat: 'module'` in `config/vite.utilities.mts` or remove `{ type: 'module' }` from the Worker constructor at line 498. This is the primary fix and will resolve both the CPU stress test and Audio Fourier simultaneously.

2. **Isolate CPU worker failures from GPU stress** (`stressTestController.ts` line 502–510):
   - The error handler should check `this.mode` before stopping GPU stress. Currently it unconditionally calls `stopGpuStress()` on any CPU worker error.
   - In "both" mode, a CPU worker failure should degrade to GPU-only (like the existing "GPU unavailable" path at line 431), not kill everything.
   - Suggested fix: Only call `stopGpuStress()` if `this.mode === 'cpu'` (i.e., the user only asked for CPU stress). In "both" mode, stop only the CPU workers and continue with GPU.

3. **Replace `supportsModuleWorkers()` with actual worker validation**:
   - The blob-based check is not sufficient. Consider spawning a test worker with the actual bundled URL and verifying it sends a ready message before spawning the full worker pool.
   - Alternatively, wrap `startCpuStress()` in a try-catch that catches the first worker error and falls back to "GPU only" mode gracefully.

4. **Add error diagnostics to the worker error handler**:
   - The current error handler logs via `console.error` (line 506) but the user-facing message is generic. Include the worker filename and line number in the status text to help diagnose the IIFE/module mismatch on deployed sites.

### Relevant Files
- `utilities-src/src/stressTestController.ts` — worker instantiation (line 498), error handler (line 502–510), `supportsModuleWorkers()` (line 165), `startCpuStress()` (line 487)
- `utilities-src/src/stressTest.worker.ts` — worker source (bundled as IIFE by Vite)
- `config/vite.utilities.mts` — Vite build config (missing `workerFormat` option)
- `pages/utilities/assets/assets/stressTest.worker-B6MGbhnL.js` — built output (IIFE format, confirmed broken)
- `pages/utilities/assets/stressTestController.js` — built controller (line 1: `new Worker(...{type:"module"})`)
