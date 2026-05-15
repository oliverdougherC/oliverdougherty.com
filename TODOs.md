# TODOs

> Action items from code review and daily work.

## Priority 0 — do now

- [ ] Run `npx vitest run` to get baseline test results before any fixes

## Image transform utility — code review fixes

### Critical

- [ ] Fix `transformIntelligence.ts:90` — `buildSourceBucketCounts` caps `Math.min(quantizationBits, 6)`, producing `shift = 8 - min(bits, 6)`, but `transformCore.ts:178` uses `shift = 8 - quantizationBits` with no cap. For 7-bit or 8-bit quantization the analysis operates on a coarser bucket grid than the matcher, so usefulness scores are computed on misaligned color buckets
- [ ] Fix `transformCore.ts:712` — `findBestGroupedSourceIndex` (shell-search branch) exits the radius loop as soon as `bestIndex !== -1`, evaluating only the innermost shell that contains any available donor. A closer color match one or two shells further out is never considered, producing visibly wrong assignments
- [ ] Fix `transformCore.ts:552` — `findBestAvailableSourceIndex` has the same early-exit bug (`bestIndex === -1` guard). If this fallback path ever triggers, the same visual artifact occurs

### Significant

- [ ] Fix `transformCore.ts:289-319` — `forEachShellBucket` iterates the full 3D bounding box per radius (O(r³) cells) then filters with `shellDistance !== radius`. The L-infinity shell surface has only ~12r² cells. At large radii this wastes ~10x CPU iterating empty interior cells. Rewrite to iterate only the cube shell's 6 faces
- [ ] Fix `transformRenderPlan.ts:25` — `buildTransformRenderPlan` calls `analyzeTransformImages` redundantly. `transformPreparedImages` already computed a full `TransformImageAnalysis` at `transformCore.ts:1036`. Pass the existing analysis as a parameter to halve analysis-phase cost
- [ ] Fix `transformAnimation.ts:118` — Default `destination` parameter creates a fresh `Uint8ClampedArray` on every call. At 60fps for 3200ms+ this generates massive per-frame GC pressure. Buffer should be caller-managed and reused
- [ ] Fix `transformCache.ts:40-42` — `arrayBufferToBase64` builds a binary string via `binary += String.fromCharCode(bytes[index])` in a loop, which is O(n²) string concatenation. For 512×512 images (262KB per buffer × 4 buffers) this is ~1M iterations of growing string allocations. Use `Buffer.from` or batch via chunks
- [ ] Fix `workerRuntime.ts:143-146` — During the assigning stage, both `onStageProgress` and `onProgress` fire `postProgress('assigning', ...)` for each tick, sending duplicate progress messages. UI receives double events causing jittering progress bars
- [ ] Fix `workerRuntime.ts:45` — `deflatePreparedImage` transfers `image.pixels.buffer` directly, but a `Uint8ClampedArray` view can have `byteOffset > 0`, causing the transferred buffer to include leading garbage bytes. Use `buffer.slice(byteOffset, byteOffset + byteLength)`
- [ ] Fix `parallelMatcher.ts:171-176` — `matchPackedPixelsInParallel` rebuilds a full `MatchingSearchContext` for the merge phase, duplicating 40+ typed arrays already allocated per worker. For 512×512 images this adds hundreds of MB of redundant allocations
- [ ] Fix `generate-built-in-transform-cache.mjs:87` — `sharp().resize(width, height, { fit: 'fill' })` stretches images to exact dimensions ignoring aspect ratio. Matches the worker behavior at `transform.worker.ts:16`, but should use `fit: 'contain'` or `fit: 'cover'` for quality. Ensure cache generation and runtime worker use identical resizing strategy
- [ ] Fix `transformCore.ts:241-244` — `buildGroupedDonorState` sorts donors via `.sort()` (O(n log n)) for every color group. Most groups have 1–3 donors. Consider insertion sort or pre-sorted insertion for small arrays
- [ ] Fix `generate-built-in-transform-cache.mjs:52-54` — `compileModule` regex only matches relative imports starting with `..` or `.`, but misses type-only imports and re-exports that don't follow the `from` keyword pattern. Some transitive dependencies aren't compiled, causing runtime `import` failures in the cache build script

### Minor / polish

- [ ] Fix `transformCore.ts:849-850` — `maybeReportProgress` skips the 100% stage report when `completed === total`. Direct hook callers never see the final stage completion event
- [ ] Fix `transformAnimation.ts:151` — `positionPriorityScratch` gives nearly all pixels the same `drawPriority`. Last pixel to claim each destination slot wins by iteration order — effectively arbitrary z-ordering with no documented tiebreaker
- [ ] Fix `transformAnimation.ts:180-182` — `resolveAccentParticlesFrame` always returns `[]` with unused `_state`/`_phase` parameters. Either implement motion accents or remove the dead stub and its references from `TransformAnimationState.accentParticles`
- [ ] Fix `parallelMatcher.ts:88-106` — `runRankingWorker` has no timeout for unresponsive workers. A hung worker blocks the entire parallel matching pipeline indefinitely. Add a configurable timeout with worker termination
- [ ] Fix `workerRuntime.ts:229` — `cancelled` set only removes IDs in `finally`, but if `finally` never fires (unhandled promise rejection in the caller), the set grows without bound across request lifetimes
- [ ] Fix `generate-built-in-transform-cache.mjs:40-42` — `rewriteRelativeImports` regex `[^'".]+` fails on import specifiers containing dots in filenames (e.g. `./some.module.ts`). Transpilation produces broken imports
- [ ] Fix `transformCache.ts:57` — `base64ToArrayBuffer` returns `bytes.buffer` which could be larger than `bytes.byteLength` if the engine allocates an oversized backing store. Return `bytes.buffer.slice(0, bytes.byteLength)`
- [ ] Add validation in `createMatchingSearchContext` (`transformCore.ts:338`) — no guard for empty `sourcePacked` or `targetPacked` arrays. A 0-pixel image produces zero-length arrays and confusing downstream behavior
- [ ] Add dedicated error variant for dimension mismatch — `transformPreparedImages` (`transformCore.ts:1030`) throws a generic `TransformError`. A dedicated error type with structured details (actual vs expected dimensions) improves debuggability
- [ ] Fix `builtInTransformAssets.ts` — URL constants are duplicated between `uiState.ts` and `builtInTransformAssets.ts`. Import from a single source of truth to prevent drift

## Local assistant utility — code review fixes

### Critical

- [ ] Fix `local-llm-worker.js:87` — `InterruptableStoppingCriteria` is instantiated once but reused without `reset()` between turns; call `stoppingCriteria.reset()` before each `generateReply()`
- [ ] Fix `local-llm-chat.js:507` — `sendMessage` passes raw `this.messages` (including notice and draft objects) to the worker; use the same `compactMessages` filter instead
- [ ] Fix `local-llm-chat.js:525` — `cleanupModelText` is called twice on `finalText` (once here, again in `finishAssistantMessage` at line 528); remove the pre-check cleanup
- [ ] Fix `local-llm-worker.js:145` — `tokenRate` starts at 0 because `numTokens` is incremented *after* the callback in `token_callback_function`; swap the order
- [ ] Fix `local-llm-chat.js:178-179` — `pagehide` listener and `utility-deactivate` listener are never removed; store references and call `removeEventListener` on disposal
- [ ] Fix `local-llm-chat.js:525` — the `finalText` length comparison uses cleaned-up strings but then assigns the *uncleaned* `finalText`; both sides should be pre-cleaned
- [ ] FIX ME — `local-llm-chat.js:582-584` / `local-llmState.ts:21-27` — the `compactMessages` function differs between the JS and TS versions; unify into the single exported `compactLocalLlmMessages` and import it from both `local-llm-chat.js` and `local-llm-worker.js`
- [ ] FIX ME — `local-llm-chat.js:503-507` — `this.messages` still contains the `assistantDraft` object (role: assistant, content: "") when `sendMessage` posts to the worker, sending an empty assistant message that corrupts conversation context

### Significant

- [ ] Fix `local-llm-worker.js:323` — `postTransformersProgress` inverts the state mapping: `'loading'` sends `WORKER_STATE.OPTIMIZING` and vice versa, contradicting the shared function `normalizeLocalLlmProgressState` in `localLlmState.ts:11-13`
- [ ] Fix `local-llm-worker.js:129` — `pastKeyValuesCache` is created once and never reset or recreated between turns; this causes stale KV cache to grow per turn and leak GPU memory; create a new `DynamicCache()` at the start of each `generateReply()`
- [ ] Fix `js/utilities-shell.js:59-76` — `loadLocalAssistantScript` caches its Promise in `localAssistantScriptPromise` but never resets it on error; a single script load failure permanently breaks the local assistant
- [ ] Fix `local-llm-worker.js:11-13` — `console.debug` and `console.info` are silenced for the entire worker lifecycle; restore them after `loadModel` finishes or scope the override to the load phase only
- [ ] Add guard in `renderSafeText` / `renderLocalLlmSafeText` — empty `<ul></ul>` or `<ol></ol>` is produced when a block matches the list regex but has no valid list item lines
- [ ] Fix `renderSafeText` code blocks — `block.replace(/^```[a-z0-9-]*\n?/i, '')` only strips the opening fence with one optional newline; trailing content on the fence line (e.g. language tag remnants) leaks into the rendered output
- [ ] Fix `renderSafeText` bold regex — `\*\*([^*]+)\*\*` is greedy-correct but fails on nested or adjacent bold segments (`**a** and **b**`) because `[^*]+` won't match zero-stars boundaries; use `([^*]+(?:\*\*[^*]+)*)` or a non-greedy approach
- [ ] Fix `local-llm-worker.js:244-248` — `compactMessages` has a different implementation than `compactLocalLlmMessages` in `localLlmState.ts`; the worker's version lacks the `cleanupLocalLlmText` call and differs in filtering logic; unify to the TypeScript export

### Minor / polish

- [ ] Add `center.hidden` and `center.classList.toggle` dedup in `renderStatePanel` — line 417-418 does both; keep one
- [ ] Make `startChat` provide feedback on early return when model is already `READY` — currently silent
- [ ] Fix `local-llm-config.js:36` — `do_sample: false` makes `temp`, `top_k`, `top_p`, `penalty_repeat` dead config; either set `do_sample: true` or remove the sampling parameters
- [ ] Fix `announceLastAssistantMessage` (`local-llm-chat.js:614-618`) — screen reader announces interrupted (truncated) content; append "(stopped)" so assistive tech users know why the message ends mid-sentence
- [ ] Add `escapeHtml` backtick handling — backticks pass through unescaped; not strictly an HTML issue but worth documenting in the function's intent
- [ ] Consider debouncing `updateCharCount` and `autoSizeInput` on the `input` event handler

## Death calculator utility — code review fixes

### Critical

- [ ] Fix `deathCalculatorController.ts:569-575` — `collectAnswers()` reads `systolicBloodPressure`, `diastolicBloodPressure`, `usesBloodPressureMedication`, `totalCholesterol`, `hdlCholesterol`, `usesLipidMedication`, and `restingHeartRate` from `FormData`, but none of these form fields exist in `pages/utilities/index.html`. All seven fields are always `null`/`false`, making the entire clinical biomarker driver branch in `longevityEngine.ts:271-348` (systolic, diastolic, cholesterol ratio, BP medication, lipid medication, resting heart rate) dead code. Either add the missing HTML inputs or remove the dead code paths
- [ ] Fix `deathCalculatorController.ts:402-403` — `syncFormerSmokerField()` overwrites `this.yearsSinceQuitInput.value` to `'5'` every time the smoking status is changed to non-"former". If the user enters a value, changes smoking status away from "former", then switches back, the original value is lost. Only reset when the field is hidden, or preserve user-entered value
- [ ] Fix `deathCalculatorController.ts:302` — The `document.addEventListener('keydown', ...)` listener is attached in `init()` but never removed. Every initialization cycle adds another listener, causing a memory leak and duplicate Enter-key handling. Store the handler reference and either use `{ once: false }` with proper cleanup, or attach to `this.root` with `capture: true` instead of `document`
- [ ] Fix `deathCalculatorController.ts:524-526` — Only an upper age bound (`> 122`) is checked before calling `predictLongevity()`. Users under 18 bypass the controller but `longevityEngine.ts:552-554` throws `"Death Calculator v1 only supports adults 18 and older."`, which surfaces as a generic error screen at line 537-543. Add an `< 18` check in the controller and render a specific message instead of a caught exception

### Significant

- [ ] Fix `deathCalculatorController.ts:524` vs `longevityEngine.ts:13` — The controller calculates age with `365.25` days per year while the engine uses `DAYS_PER_YEAR = 365.2425`. Ages near a year boundary (especially the 18-year minimum and 122-year immortal threshold) can differ slightly, leading to edge-case mismatch between the pre-flight check and the engine's age calculation. Share `DAYS_PER_YEAR` from the engine
- [ ] Fix `longevityEngine.ts:644-651` — `formatCountdown` uses a `while(true)` loop that iterates once per year, calling `addUtcYears` and `getTime` each iteration. For a 60-year countdown this runs 60+ iterations every second via `setInterval` at `deathCalculatorController.ts:625`. Rewrite to O(1) arithmetic: compute years via UTC date math, then compute remaining days/hours/minutes/seconds
- [ ] Fix `deathCalculatorController.ts:371` — The `'error'` screen reuses the survey screen (`this.surveyScreen.hidden = false`) with only the status text to differentiate. Users see the same question UI with a vague error message and no call to action. Either add a dedicated error screen with instructions, or redirect to intro with `this.beginButton` feedback
- [ ] Fix `deathCalculatorController.ts:421-425` vs `deathCalculatorController.ts:399-405` — `yearsSinceQuitField` is controlled by both `syncQuestionUi()` (via `questionCards` map, line 421) and `syncFormerSmokerField()` (direct `hidden` assignment, line 400). If `syncQuestionUi` hides the card for a non-active question, then `syncFormerSmokerField` shows it because the user selected "former", the last writer wins but the question card visibility state is corrupted. The `yearsSinceQuit` question should be hidden only when the smoking status isn't "former", not via the question card rotation logic

### Minor / polish

- [ ] Fix `deathCalculatorController.ts:653-654` — `reset()` calls `this.setScreen('intro')` then `this.syncQuestionUi()`. The survey screen is already hidden, so updating the question UI is a no-op that wastes DOM writes. Remove the `syncQuestionUi()` call from `reset()`
- [ ] Fix `deathCalculatorController.ts:245` — `this.prediction` is assigned in four places (lines 390, 538, 606, 637) but never read anywhere. Dead state. Remove the field or use it for a purposeful feature (e.g., showing prediction details on reset confirmation)
- [ ] Fix `deathCalculatorController.ts:553` — `collectAnswers()` allows `birthDate` to be an empty string (`String(formData.get('birthDate') ?? '')`). The engine at `longevityEngine.ts:24-28` then throws `"Birth date is invalid"`, which surfaces as a generic error screen. Validate `birthDate` is non-empty in `collectAnswers()` or the controller's pre-flight, and show a field-level validation error instead
- [ ] Fix `deathCalculatorController.ts:346-347` — `init()` calls `this.syncFormerSmokerField()` then `this.reset()`, which also calls `this.syncFormerSmokerField()` at line 651. Remove the redundant call from `init()`
- [ ] Fix `longevityEngine.ts:443-479` — `projectSurvivalCurve` iterates day-by-day up to age 121. For a newborn (`currentAgeYears = 0`), `maxDays` is ~44,200, each iteration running `interpolateAnnualHazard` (which does an O(n) `find` over 121 entries), `computeMortalityProjectionFactor`, and a percentiles pass. The total work is ~44,200 × (O(121) + constant). For a 120-year-old it's ~365 iterations. Consider whether the day-by-day loop is necessary or if a coarser step for high-confidence tail values would be sufficient for the percentile thresholds
- [ ] Fix `longevityEngine.ts:47` — `interpolateAnnualHazard` uses `entries.find()` twice per call (lines 58, 59), scanning up to 121 entries for each `find`. Since the curve is called once per day for tens of thousands of days, this is O(n × entries.length) per call. The entries are sorted by age — use binary search or pre-build a `Map<number, MortalityBaselineEntry>` lookup
- [ ] Fix `deathCalculatorController.ts:592` — `renderImmortal()` sets `innerHTML` on `countdownDisplay` rather than `textContent`. If the infinity symbol or CSS class changes this introduces an XSS surface. Use `textContent` with a separate `<span>` element or create the element via `document.createElement`
- [ ] Fix `deathCalculatorController.ts:523` — The birth date is parsed as UTC noon (`T12:00:00Z`) in the controller for the age check, but `longevityEngine.ts:24` also parses as UTC noon. These agree, but the choice is arbitrary and can cause the age to be off by up to 12 hours depending on the user's timezone. The `predictLongevity` function receives `new Date()` as the default `now`, which is wall-clock local time. The age calculation should be consistent: either all UTC or all local
- [ ] Fix `deathCalculatorController.ts:272-277` — `questionCards` is built from `this.root.querySelectorAll('[data-question-card]')`, but `this.root` is passed from `main.ts:1405` as `#deathCalculatorApp`. If the HTML template ever reorders or dynamically loads question cards, this map won't update. Consider rebuilding the map in `init()` rather than the constructor

## Virtual machine utility — code review fixes

### Critical

- [ ] Fix `retroVmController.ts:354-355` — `statusChip` and `statusText` are resolved via `document.getElementById('retroVmStatusChip')` and `document.getElementById('retroVmStatusText')`, but neither element exists in `pages/utilities/index.html`. The `retroVmApp` section has no status chip or status text element. `statusChip` being `null` is guarded in `syncUi()` (line 733), but `statusText` is written to unconditionally in `setVmStatusLine()` at line 431 (`this.statusText.textContent = text`), causing a `TypeError` on every status update. Add the missing HTML elements or remove the dead references
- [ ] Fix `retroVmController.ts:393-395` — `document.addEventListener('keydown', ...)`, `document.addEventListener('fullscreenchange', ...)`, `window.addEventListener('resize', ...)`, and `window.addEventListener('pagehide', ...)` are all attached in `init()` with no corresponding removal. There is no `dispose()` or `destroy()` lifecycle method. If the utility stage is reactivated (navigated away and back), duplicate listeners accumulate. The `pagehide` handler calls `void this.destroySession()` but doesn't return a string, so no unload confirmation dialog is shown. Add a `dispose()` method that cleans up all global listeners and calls `mouseBridge.detach()`
- [ ] Fix `retroVmController.ts:566-598` — `autoAdvanceBootMenu()` / `dispatchEnterKey()` dispatch DOM `KeyboardEvent`s on `this.screenContainer` (a `<div>`). But v86 captures input at the WASM level, not through host DOM events on the container div. The Enter key never reaches the guest boot menu, so the boot menu is never auto-advanced. Use `this.emulator.keyboard_send_keys([28])` (scan code for Enter) instead of synthetic DOM events
- [ ] Fix `retroVmController.ts:532-549` — `reset()` has no try-catch around the teardown sequence. If `destroySession()` rejects (e.g., `active.destroy()` throws), the state machine is left stuck in `'resetting'` forever. The user sees a "Resetting" chip with no recovery path. Wrap the body in try-catch and transition to `'error'` on failure

### Significant

- [ ] Fix `retroVmConfig.ts:19` — `bootOrder: 0x132` (306 decimal) sets CD-ROM + network boot, omitting the hard disk entry. The documented v86 standard for CD-ROM boot with hard disk fallback is `0x210`. `0x132` includes network boot (which is disabled) and omits hard disk, so the BIOS boot menu won't show the hard disk option
- [ ] Fix `retroVmController.ts:610-618` — `getGuestViewport()` returns `scale: 0` when `graphicalModeActive` is false. `sendAbsolutePosition()` in the mouse bridge uses `safeScale = viewport.scale || 1`, which short-circuits to `1` instead of the actual scale. During text-mode boot (before graphics init), mouse coordinates are mapped incorrectly. Use the real unscaled guest dimensions or skip mouse forwarding entirely during text mode
- [ ] Fix `retroVmController.ts:651-654` — `getBus()` casts `this.emulator` to `unknown as { bus?: RawBus }`, but `EmulatorLike` doesn't declare `bus`. `FakeRetroVm` has no `bus` property, so test-mode mouse interaction via `RetroVmMouseBridge` silently fails
- [ ] Fix `retroVmSupport.ts:15-65` — `detectRetroVmSupport()` checks WebAssembly and Web Workers but doesn't check for Fullscreen API (`document.fullscreenEnabled`) or Pointer Lock API (`document.requestPointerLock`). The VM silently initializes and then fails when the user clicks Fullscreen or tries to capture the mouse. Add checks with a graceful degraded message
- [ ] Fix `retroVmController.ts:730-741` — `syncUi()` writes `getDefaultSupportNote()` to `supportNote.textContent` for non-error states (line 741), then `applyInteractionStatusCopy()` (line 757) overwrites it again for running/fullscreen states. During loading/resetting, `applyInteractionStatusCopy()` returns early (line 671), so the support note shows the generic online/offline copy instead of a context-specific message about what's happening
- [ ] Fix `retroVmConfig.ts:95-132` — `buildRetroVmV86Options()` doesn't set `writable_fs: false`. Without it, v86 may create an implicit writable overlay that consumes memory on every boot. Explicitly set `writable_fs: false` to match the "ephemeral per tab" marketing claim
- [ ] Fix `retroVmController.ts:336-348` — `onReady()` is registered as an `'emulator-ready'` listener, but v86 fires this after BIOS init, not after the guest desktop loads. The `bootHintTimer` fires 4 seconds later regardless. If the guest takes longer than 4 seconds to reach the desktop, the hint text overwrites boot information the user is reading
- [ ] Fix `retroVmController.ts:301-307` — `fullscreenChangeHandler` handles both `fullscreenchange` and `window.resize`. During active resizing, `ResizeObserver` (line 401-405) also fires `syncGuestFit()`. Both read `getBoundingClientRect()` synchronously during layout thrashing. Debounce the window resize path
- [ ] Fix `retroVmSupport.ts:157-160` — `transitionRetroVmState` with event `'reset-complete'` always returns `'idle'`. If `reset()` encountered an error internally but still dispatched `reset-complete`, the state would jump to `'idle'` masking the error. Controller should only transition to reset-complete on success
- [ ] Fix `retroVmController.ts:497-510` — `enterFullscreen()` only checks `!this.emulator` and `!document.fullscreenEnabled`. It doesn't check for `'error'` or `'unsupported'` state. If the VM previously errored but `emulator` holds a stale reference, `requestFullscreen()` succeeds but nothing renders
- [ ] Fix `retroVmController.ts:302-307` — `fullscreenChangeHandler` reads `this.state`, calls `setState()` which calls `syncUi()` which reads `this.state` again. If `syncUi()` throws (e.g., due to the null `statusText` bug), the state is already committed, leaving the controller in an inconsistent state

### Minor / polish

- [ ] Fix `retroVmController.ts:283` — `progress` is initialized with `RETRO_VM_CONFIG.cdromSizeBytes` (module-level constant), but the constructor at line 353 reassigns it to `this.config.cdromSizeBytes`. Remove the initial value and use `null` as the field initializer to avoid the stale reference
- [ ] Fix `retroVmMouseBridge.ts:219-240` — `requestPointerLock()` has nested try-catch blocks. The inner fallback (`await this.root.requestPointerLock()` without options) at line 234 is not awaited because it's inside a non-awaited catch block — the outer try-catch at line 230 swallows it. Consolidate to one try-catch
- [ ] Fix `retroVmMouseBridge.ts:94-96` — `onMouseMove` runs `sendAbsolutePosition()` on every mouse move. During pointer lock the call returns early but the event still fires. Consider removing the listener during pointer lock and re-adding after unlock to eliminate per-move overhead
- [ ] Fix `FakeRetroVm.ts:36` — `FALLBACK_ISO_SIZE_BYTES` (128 MB) is dead code since `RETRO_VM_CONFIG.cdromSizeBytes` (20082688) is always defined. Consider testing the fallback path separately
- [ ] Fix `retroVmConfig.ts:37-40` — `nicType: 'ne2k'`, `id: 0`, and `mtu: 1500` are included in the network config but only used when `isRetroVmNetworkReady()` returns true. Since networking is always disabled, these are dead configuration. Document or remove
- [ ] Fix `build-retro-vm-image.sh:55-56` — `cpio_status > 2` silently ignores exit code 2 from `cpio` ("some files cannot be read/processed"). A truncated kernel image would be silently embedded into the ISO. Use `>= 2` to treat code 2 as a hard failure
- [ ] Fix `build-retro-vm-image.sh:4-6` — `SOURCE_ISO` points to `TinyCore-11.0.iso` but there's no existence check before `bsdtar -xf`. If the base ISO is missing, the Docker container hangs trying to extract from a nonexistent file
- [ ] Fix `build-retro-vm-image.sh:30-39` — `rsvg-convert` is called twice to generate PNG icons. If one conversion fails (malformed SVG), the script continues with a missing icon file, producing desktop entries with broken icons. Add `set -e` protection per conversion or check exit status
- [ ] Fix `retro-vm-guide` / `retro-vm-browser` shell scripts — Hard-depend on `aterm` with no fallback to `xterm` or `xterm-js`. If aterm isn't installed in the base image, these launchers fail silently
- [ ] Fix `retro-vm-guide.desktop` — Missing `StartupNotify=false`. Desktop environments like GNOME/KDE show a loading spinner for a window that never matches the startup ID. Also, `Terminal=false` with `Exec` running a terminal emulator is non-standard for GNOME/KDE (works for FLWM)
- [ ] Fix `retroVmController.ts:224-227` and `244-248` — `RetroVmMouseBridge` checks `window.__OD_RETRO_VM_TEST_MODE__` in `requestPointerLock()` and `releasePointerLock()` to fake pointer state. But `onPointerLockChange` at line 125-128 also reads `document.pointerLockElement`, which is always `null` in test mode. The test-mode path in `requestPointerLock` sets `this.pointerLocked = true` directly, but `onPointerLockChange` could still fire and reset it to `false` if the browser sends the event
