# Code Review Findings - 2026-05-21 Deployment Fixes

## Reviewed Changes
All 15 files from the "deployment readiness fixes" commit (1c2963f) were reviewed for correctness, edge cases, regressions, and GitHub Pages compatibility.

---

## Findings

### 1. [MEDIUM] Gallery hero preload is hardcoded to a specific image
- **File:** `pages/gallery/index.html` (line 20)
- **Issue:** `<link rel="preload" as="image" href="../../assets/photos/medium/a7rii_474.avif" type="image/avif">` is hardcoded to `a7rii_474.avif`. The gallery hero is dynamically selected from `gallery-sequence.json` based on hero priority. If the hero entry changes in the sequence config, this preload will either be wasted (preloading the wrong image) or missing (not preloading the actual hero).
- **Impact:** Minor performance regression if hero changes. Page still works correctly.
- **Fix:** Either make the preload dynamic (e.g., via a small inline script that reads the sequence and injects the preload), or accept this as a known limitation and document it.

### 2. [LOW] LLM loading copy contradicts actual caching behavior
- **File:** `js/local-llm-chat.js` (line 53)
- **Issue:** Loading sequence copy says: `"Don't worry, I won't cache it in your browser ;)"` but `js/local-llm-worker.js` (line 367) sets `env.useBrowserCache = true`, which means the model IS cached in the browser via the Cache API.
- **Impact:** Misleading user-facing text. The model will be cached, which is actually good for subsequent loads, but the copy promises otherwise.
- **Fix:** Update the copy to something like `"Runs entirely on your device"` (drop the caching promise) or set `env.useBrowserCache = false` if caching should truly be disabled.

### 3. [LOW] VM toolbar actions `flex-wrap: nowrap` may overflow on narrow screens
- **File:** `css/utilities.css` (line 2594-2596)
- **Issue:** `.vm-toolbar-actions` was changed from `flex-wrap: wrap` to `flex-wrap: nowrap` with `flex: 0 0 auto`. On narrow viewports (e.g., 768px tablets or small laptops), the four buttons (Launch, Paste, Fullscreen, Wipe) plus status chip and capture badge may overflow horizontally.
- **Impact:** Buttons could be clipped or cause horizontal scroll on narrow viewports.
- **Fix:** Consider reverting to `flex-wrap: wrap` or adding a media query that allows wrapping below a certain breakpoint.

### 4. [LOW] Gallery `color-scheme: light` on `html` is a global rule
- **File:** `css/gallery.css` (line 18-20)
- **Issue:** `html { color-scheme: light; }` is a global selector that affects the entire document. The comment says this is intentional for the gallery's light theme, and since `gallery.css` is only loaded on the gallery page, this is scoped correctly. However, if this stylesheet is ever accidentally included on another page, it would override dark mode site-wide.
- **Impact:** None currently (stylesheet is page-specific). Future maintenance risk if CSS is refactored.
- **Fix:** Consider scoping to `.page-gallery` or `html[data-theme="gallery"]` for defensive safety: `html[data-theme="gallery"] { color-scheme: light; }`.

### 5. [MINOR] Gallery hero image error handler shows image on failure
- **File:** `js/gallery.js` (lines 385-386)
- **Issue:** Both `load` and `error` events call `markHeroLoaded()`, which sets `alt` and adds `.is-loaded` class. On error, this means the hero image container will show a white/transparent box with the alt text visible (since `opacity: 1` is set), rather than showing a broken image indicator.
- **Impact:** If the hero image fails to load, the user sees a blank card instead of an error state.
- **Fix:** Separate the error handler to show a fallback or broken state (similar to how grid photo cards use `photo-card--broken`).

### 6. [MINOR] Stress test `pendingGenerateCount` decrement in finally block is correct but subtle
- **File:** `js/local-llm-worker.js` (lines 245-247)
- **Note:** The `pendingGenerateCount` decrement was moved from the start of `generateReply` to the `finally` block. This is correct - it ensures the counter is always decremented even on error. No issue, just noting this was a good fix.

### 7. [MINOR] `beforeunload` handler may trigger browser confirmation dialog
- **File:** `js/local-llm-chat.js` (line 218)
- **Issue:** `window.addEventListener('beforeunload', this._beforeUnloadHandler)` - the handler calls `endModelSession()` but doesn't set `event.returnValue`. Modern browsers only show a confirmation dialog if `event.returnValue` is set. Since it's not set here, the handler runs silently. This is fine, but if the handler throws or takes too long, it could delay page unload.
- **Impact:** Negligible - the handler is synchronous and fast.
- **Fix:** None needed.

### 8. [VERIFIED OK] Vite worker format fix
- **File:** `config/vite.utilities.mts` (lines 10-12)
- **Finding:** `worker: { format: 'es' }` correctly ensures Vite bundles workers as ES modules. Built outputs confirmed to contain the new code.

### 9. [VERIFIED OK] Retro VM mouse capture fixes
- **File:** `utilities-src/src/retroVmController.ts` -> `pages/utilities/assets/retroVmController.js`
- **Finding:** All changes (isPointInsideRect, lockRequested, lastAbsolutePosition, sendLastAbsolutePosition) are present in the built output. The mouse event listener correctly moved from `this.root` to `document` for absolute mouse tracking.

### 10. [VERIFIED OK] Stress test error handling
- **File:** `utilities-src/src/stressTestController.ts` -> `pages/utilities/assets/stressTestController.js`
- **Finding:** `handleCpuStressFailure` and `cpuStartError` graceful degradation are present in the built output. The error handling correctly allows GPU to continue running when CPU fails in "both" mode.

### 11. [VERIFIED OK] LLM worker fixes
- **File:** `js/local-llm-worker.js`
- **Finding:** DynamicCache disposal, flushTimer cleanup, pendingGenerateCount in finally block, and generation-busy error response all look correct.

---

## Summary
- **5 major issues fixed:** All verified correct
- **1 medium finding:** Hardcoded gallery preload image
- **2 low findings:** Misleading LLM cache copy, VM toolbar overflow risk
- **2 minor findings:** Hero image error state, defensive CSS scoping
- **5 verified OK:** Vite config, Retro VM, Stress test, LLM worker, Utilities shell

No critical regressions or deployment blockers found.

---

## Subagent Review: Local LLM Chat Utility Deep Dive (2026-05-21)

### 12. [CRITICAL] `pendingGenerateCount` allows 2 concurrent generations causing shared-state corruption
- **File:** `js/local-llm-worker.js` (lines 13, 27-38)
- **Issue:** `MAX_PENDING_GENERATE_MESSAGES = 2` allows two concurrent `generateReply()` calls. Both share `stoppingCriteria` (line 154-155: `stoppingCriteria ??= new InterruptableStoppingCriteria(); stoppingCriteria.reset()`) and the same `generator` pipeline. When the second generation resets `stoppingCriteria` at line 155, it corrupts the first generation's interrupt mechanism. Both also call `generator(conversation, ...)` concurrently, which can corrupt the shared model inference state.
- **Impact:** If two messages are sent in rapid succession (e.g., user double-clicks Send before the first message dispatches), both generations run concurrently and corrupt each other's state. The first generation may be silently interrupted or produce garbled output.
- **Fix:** Change `MAX_PENDING_GENERATE_MESSAGES` to `1`, OR add a state guard: `if (state === WORKER_STATE.THINKING || state === WORKER_STATE.STREAMING)` before accepting a new `generate` message.

### 13. [MEDIUM] Delta streaming render path can produce malformed HTML
- **File:** `js/local-llm-chat.js` (lines 935-941)
- **Issue:** The fast-path delta render checks `currentContent.startsWith(prevRendered)` and then calls `renderSafeText(delta)` on the raw text difference. If the delta splits a markdown construct mid-way (e.g., previous content ends with `**bold` and delta starts with ` text**`), `renderSafeText(delta)` produces `<strong> text**</strong>` or other malformed HTML. Similarly, a delta that splits a code fence or list marker would produce invalid structure.
- **Impact:** Streamed assistant messages can briefly show broken HTML during token arrival, especially with markdown-heavy responses. The final `finishAssistantMessage` does a full re-render which fixes it, but the intermediate state is visually broken.
- **Fix:** Either (a) disable the delta fast-path and always do full re-renders, (b) accumulate raw text and only render on token boundaries that don't split markdown, or (c) use a streaming-safe markdown renderer that tracks open tags.

### 14. [MEDIUM] `beforeunload` / `pagehide` fire-and-forget cache deletion may not complete
- **File:** `js/local-llm-chat.js` (lines 217-218, 1138-1141)
- **Issue:** `endModelSession()` calls `this.clearBrowserModelCaches()` which is async. The `.catch()` handler at line 1139 is fire-and-forget. During `beforeunload` and `pagehide`, the browser gives only a few milliseconds before destroying the page context. The `CacheStorage.delete()` promise may never settle, meaning the Cache API entries persist despite the intent to clear them. This partially undermines the "cache cleanup on unload" fix.
- **Impact:** After navigating away from the utility, model files may remain cached. On next visit, the model reloads from stale cache instead of fresh download.
- **Fix:** Consider using `navigator.serviceWorker.getRegistrations()` to manage cache via a service worker (which survives page unload), or accept that `pagehide` cleanup is best-effort and rely on the explicit "Clear cache" button in the diagnostics panel for reliable deletion.

### 15. [MEDIUM] Worker has no state guard against `generate` during non-READY states
- **File:** `js/local-llm-worker.js` (lines 26-39)
- **Issue:** The `generate` message handler only checks `pendingGenerateCount` and has no guard against `state !== WORKER_STATE.READY`. If a `generate` message arrives while the worker is in `LOADING`, `CHECKING`, or `ERROR` state, it increments `pendingGenerateCount` and calls `generateReply()`, which then calls `await loadModel()`. This queues the generation behind the load, but `pendingGenerateCount` is held during the entire load time, potentially blocking subsequent legitimate requests.
- **Impact:** If the main thread sends a `generate` before receiving the `ready` message (a race condition that's possible given the async loading), the worker holds a pending slot during model download, wasting capacity.
- **Fix:** Add `if (state !== WORKER_STATE.READY)` guard at the top of the `generate` handler, posting an error back to the main thread.

### 16. [LOW] `interruptGeneration` posts `interrupted` message before generation actually stops
- **File:** `js/local-llm-worker.js` (lines 251-258)
- **Issue:** `interruptGeneration()` posts `{ type: 'interrupted' }` synchronously at line 257, but the actual generation stop is async (via `stoppingCriteria.interrupt()` at line 254). The main thread's `finishInterruptedGeneration()` may update the UI to "Generation stopped" before the worker has actually stopped generating tokens. Subsequent `token` messages from the interrupted generation could arrive and be processed by `appendAssistantToken()` even though the main thread thinks generation is done.
- **Impact:** Rare race where tokens from an interrupted generation leak into the UI after the "stopped" state is shown. The `generationId !== activeGeneration` check at line 185 in the streamer callback provides some protection, but the `token` message type handler at line 325-332 in the main thread doesn't check generation IDs.
- **Fix:** In the main thread's `handleWorkerMessage`, ignore `token` and `complete` messages when `this.status === WORKER_STATE.READY` (i.e., after interruption has been processed).

### 17. [LOW] `renderMessages()` has O(n*m) WeakMap lookup
- **File:** `js/local-llm-chat.js` (lines 863-871)
- **Issue:** For each DOM `<article>` child, the code iterates through ALL entries in `this._messageElements` WeakMap to find the matching message object. With many messages, this quadratic behavior degrades performance.
- **Impact:** Negligible for typical chat lengths (<20 messages), but could slow re-renders for long conversations near the `maxHistoryMessages: 10` limit plus notices.
- **Fix:** Add a reverse `Map<HTMLElement, Object>` or store the message object as a DOM property (e.g., `article._messageRef = message`) for O(1) lookup.

### 18. [LOW] `env.useBrowserCache = true` contradicts loading copy text
- **File:** `js/local-llm-worker.js` (line 367), `js/local-llm-chat.js` (line 53)
- **Issue:** Already noted in finding #2 above, but the root cause is confirmed: `configureTransformers()` sets `env.useBrowserCache = true` which causes transformers.js to cache model files under a Cache API namespace matching `/transformers|huggingface/i`. The loading copy at line 53 says `"Don't worry, I won't cache it in your browser ;)"`.
- **Impact:** Misleading user-facing text.
- **Fix:** Update the copy text (finding #2 already covers this).

### 19. [MINOR] `pendingGenerateCount` can leak if worker throws synchronously
- **File:** `js/local-llm-worker.js` (lines 37-38)
- **Issue:** `pendingGenerateCount` is incremented at line 37 before `generateReply()` is called. If `generateReply()` threw synchronously (before its first `await` at line 145), the outer try-catch at lines 18-67 would catch it, but `pendingGenerateCount` would never be decremented since the `finally` block at line 245-248 is inside `generateReply`. This would permanently reduce available generation slots.
- **Impact:** Extremely unlikely in practice (the first few lines of `generateReply` are simple variable declarations), but represents a defensive gap.
- **Fix:** Move the increment inside `generateReply` or add a try-finally around the `void generateReply(...)` call in the message handler.

### 20. [MINOR] Double cache deletion on page unload
- **File:** `js/local-llm-chat.js` (lines 217-218, 225-226)
- **Issue:** Both `pagehide` and `beforeunload` fire on navigation and both call `endModelSession()` which calls `clearBrowserModelCaches()`. The second call is redundant since the first already deleted the caches and terminated the worker. The `if (!worker) return;` guard in `terminateWorker` prevents double-termination, but the second `cacheStorage.keys()` + `cacheStorage.delete()` cycle is wasted work.
- **Impact:** Negligible performance cost, but adds unnecessary async work during page unload.
- **Fix:** Use only `pagehide` (which is more reliable in modern browsers) or add a guard flag to prevent double-execution.

---

## Subagent Review: Retro VM and Stress Test Deep Dive (2026-05-21)

### 21. [VERIFIED OK] Retro VM mouse delta fix
- **File:** `utilities-src/src/retroVmController.ts` (line 523) -> `pages/utilities/assets/retroVmController.js`
- **Finding:** `bus.send('mouse-delta', [deltaX, -deltaY])` correctly negates Y-axis for v86 coordinate system. Built output confirmed: `s.send("mouse-delta",[o,-n])`.

### 22. [VERIFIED OK] Retro VM pointer lock with `unadjustedMovement`
- **File:** `utilities-src/src/retroVmController.ts` (line 546) -> `pages/utilities/assets/retroVmController.js`
- **Finding:** `requestPointerLock({ unadjustedMovement: true })` with fallback to bare `requestPointerLock()` for older browsers. Built output confirmed.

### 23. [VERIFIED OK] Retro VM pointer lock state management
- **File:** `utilities-src/src/retroVmController.ts` (lines 288, 353-364, 527-553)
- **Finding:** `lockRequested` guard prevents duplicate lock requests. `onPointerLockChange` resets the flag. `sendLastAbsolutePosition` fires on lock grant to reposition cursor. Lock/unlock listener sync (`syncAbsoluteMouseMoveListener`) correctly toggles between absolute and delta tracking.

### 24. [VERIFIED OK] Stress test module worker fix
- **File:** `utilities-src/src/stressTestController.ts` (line 514) -> `pages/utilities/assets/stressTestController.js`
- **Finding:** `new Worker(new URL('./stressTest.worker.ts', import.meta.url), { type: 'module' })` correctly creates module workers. Built output resolves to `assets/stressTest.worker-DtXYxNMg.js` with `{type:"module"}`. Worker file exists at `pages/utilities/assets/assets/stressTest.worker-DtXYxNMg.js`.

### 25. [VERIFIED OK] Stress test worker content matches source
- **File:** `utilities-src/src/stressTest.worker.ts` -> `pages/utilities/assets/assets/stressTest.worker-DtXYxNMg.js`
- **Finding:** Built worker contains the chunked execution loop (90ms time-sliced), heartbeat messaging (250ms interval), and proper start/stop request handling. Logic matches source exactly.

### 26. [VERIFIED OK] GPU stress isolation in "both" mode
- **File:** `utilities-src/src/stressTestController.ts` (lines 579-594)
- **Finding:** `handleCpuStressFailure` correctly keeps GPU running when CPU fails in "both" mode, updating status to "GPU stress is still running. CPU stress worker failed." Also starts CPU visuals as fallback.

### 27. [VERIFIED OK] WebGPU device loss handling
- **File:** `utilities-src/src/stressTestController.ts` (lines 820-842)
- **Finding:** `device.lost` handler cancels animation frame, cleans up GPU state, and falls back to CPU visuals in "both" mode. Error state in "gpu"-only mode.

### 28. [LOW] `onLockedMouseMove` listener permanently attached to document
- **File:** `utilities-src/src/retroVmController.ts` (line 387)
- **Issue:** `document.addEventListener('mousemove', this.onLockedMouseMove, { passive: false })` is attached in `attach()` and only removed in `detach()`. The handler guards with `if (!this.pointerLocked) return;` so it's a no-op when not locked, but it still fires on every mouse move event globally. This means the handler runs on every mouse move across the entire page, not just when the VM is active.
- **Impact:** Minor performance overhead -- a function call + property check on every mouse move event document-wide, even when the VM tab isn't active or the VM isn't running.
- **Fix:** Move the `onLockedMouseMove` attachment into `syncAbsoluteMouseMoveListener` or attach it only when `canCapture()` returns true, and detach when the VM is destroyed/reset.

### 29. [LOW] `sendAbsolutePosition` and `sendAbsolutePositionFromPoint` are duplicated
- **File:** `utilities-src/src/retroVmController.ts` (lines 445-468, 470-493)
- **Issue:** These two methods are nearly identical (28 lines each), differing only in how they obtain `clientX`/`clientY` (from `event` vs direct parameters). Both contain the same guard checks, rect computation, scale division, clamping, and bus send.
- **Impact:** Code duplication increases maintenance burden. Any future fix to coordinate calculation would need to be applied in two places.
- **Fix:** Extract a shared `sendAbsolutePositionInternal(clientX: number, clientY: number)` method and have both callers delegate to it.

### 30. [LOW] `showConfirmModal` has dead fallback code
- **File:** `utilities-src/src/retroVmController.ts` (lines 144-146)
- **Issue:** The condition `typeof window.confirm === 'function'` is always true in any browser environment. The comment says "Use window.confirm only as last resort" but the code inside the if block is empty -- it never actually calls `window.confirm`. The block is effectively dead code.
- **Impact:** None (cosmetic). The custom modal always works correctly.
- **Fix:** Remove the dead if block or implement the actual `window.confirm` fallback if CSP/SSR environments are a real concern.

### 31. [LOW] `onContextMenu` always prevents default on VM screen
- **File:** `utilities-src/src/retroVmController.ts` (lines 316-318)
- **Issue:** `event.preventDefault()` is called unconditionally on all right-click events on the VM screen container. This prevents the guest OS from receiving right-click context menu events. While this prevents the browser's context menu from appearing (which is the intended fix), it also means the user cannot right-click inside the VM guest.
- **Impact:** Users cannot access right-click context menus inside the guest OS. This is a usability limitation.
- **Fix:** Only prevent default when the mouse is captured (`this.pointerLocked`) or send the right-click to the guest via `bus.send('mouse-click', [...])`. The `updateButtons` method already handles button 2 (right-click), so the context menu prevention could be conditional on capture state.

### 32. [MINOR] Stress test `startCpuStress` creates workers synchronously in a loop
- **File:** `utilities-src/src/stressTestController.ts` (lines 513-539)
- **Issue:** Workers are created in a synchronous for-loop. If `workerCount` is large (e.g., 64 on a high-core machine), this creates 64 Worker instances and posts messages synchronously before any of them have started executing. The browser may throttle or delay worker creation under heavy load.
- **Impact:** Minor -- the workers still start, but there's a brief burst of worker creation that could momentarily impact main thread responsiveness.
- **Fix:** Stagger worker creation with microtask delays (`queueMicrotask`) or batch them in chunks of 4-8.

### 33. [MINOR] Error handling duplication between `handleStartFailure` and `start()` catch
- **File:** `utilities-src/src/stressTestController.ts` (lines 457-464, 467-476)
- **Issue:** The `catch` block in `start()` and `handleStartFailure` both perform nearly identical cleanup: `stopCpuStress()`, `stopGpuStress({ loseContext: true })`, setting `gpuBackend = 'none'`, setting state to 'error', and `syncMetrics(true)`. The only difference is that `handleStartFailure` also calls `stopMetricLoop()`.
- **Impact:** Code duplication, maintenance risk if cleanup logic changes.
- **Fix:** Extract a private `cleanUpAfterFailure(error: unknown)` method that both paths call.

### 34. [MINOR] `canCreateContext` creates a throwaway canvas that isn't removed from DOM
- **File:** `utilities-src/src/stressTestController.ts` (lines 624-641)
- **Issue:** `document.createElement('canvas')` creates a detached canvas element (not appended to DOM), so there's no DOM leak. The `finally` block sets `canvas = null` but the element is already garbage-collectable since it was never attached. This is fine, just noting that the `finally` block's `canvas.width = 0; canvas.height = 0; canvas = null;` pattern is unnecessary for a detached element.
- **Impact:** None.
- **Fix:** None needed, but the `finally` block could be simplified to just `canvas = null`.

---

## Summary of Retro VM / Stress Test Subagent Findings
- **7 verified OK:** Mouse delta fix, pointer lock, lock state management, module worker fix, worker content, GPU isolation, WebGPU device loss
- **4 low:** Permanent document mouse listener, duplicated coordinate methods, dead fallback code, unconditional context menu prevention
- **3 minor:** Synchronous worker burst, error handling duplication, unnecessary canvas cleanup
