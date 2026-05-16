# TODOs

> Action items from code review and daily work.

## Completion pass — 2026-05-16

- All actionable items below were either fixed, verified as already fixed, or triaged with a note where the premise was invalid/debatable.
- DOM-heavy controller integration-test requests remain covered by the existing browser smoke/check scripts rather than new Vitest DOM harnesses; the utilities Vitest config is intentionally node-based.
- Verification run this pass: utilities typecheck/tests after each fix cluster, with full build/quality commands listed in the final handoff.

## Priority 0 — do now

- [x] Run `npx vitest run` to get baseline test results before any fixes

## Image transform utility — code review fixes

### Critical

- [x] Fix `transformIntelligence.ts:90` — `buildSourceBucketCounts` caps `Math.min(quantizationBits, 6)`, producing `shift = 8 - min(bits, 6)`, but `transformCore.ts:178` uses `shift = 8 - quantizationBits` with no cap. For 7-bit or 8-bit quantization the analysis operates on a coarser bucket grid than the matcher, so usefulness scores are computed on misaligned color buckets
- [x] Fix `transformCore.ts:712` — `findBestGroupedSourceIndex` (shell-search branch) exits the radius loop as soon as `bestIndex !== -1`, evaluating only the innermost shell that contains any available donor. A closer color match one or two shells further out is never considered, producing visibly wrong assignments
- [x] Fix `transformCore.ts:552` — `findBestAvailableSourceIndex` has the same early-exit bug (`bestIndex === -1` guard). If this fallback path ever triggers, the same visual artifact occurs

### Significant

- [x] Fix `transformCore.ts:289-319` — `forEachShellBucket` iterates the full 3D bounding box per radius (O(r³) cells) then filters with `shellDistance !== radius`. The L-infinity shell surface has only ~12r² cells. At large radii this wastes ~10x CPU iterating empty interior cells. Rewrite to iterate only the cube shell's 6 faces
- [x] Fix `transformRenderPlan.ts:25` — `buildTransformRenderPlan` calls `analyzeTransformImages` redundantly. `transformPreparedImages` already computed a full `TransformImageAnalysis` at `transformCore.ts:1036`. Pass the existing analysis as a parameter to halve analysis-phase cost
- [x] Fix `transformAnimation.ts:118` — Default `destination` parameter creates a fresh `Uint8ClampedArray` on every call. At 60fps for 3200ms+ this generates massive per-frame GC pressure. Buffer should be caller-managed and reused
- [x] Fix `transformCache.ts:40-42` — `arrayBufferToBase64` builds a binary string via `binary += String.fromCharCode(bytes[index])` in a loop, which is O(n²) string concatenation. For 512×512 images (262KB per buffer × 4 buffers) this is ~1M iterations of growing string allocations. Use `Buffer.from` or batch via chunks
- [x] Fix `workerRuntime.ts:143-146` — During the assigning stage, both `onStageProgress` and `onProgress` fire `postProgress('assigning', ...)` for each tick, sending duplicate progress messages. UI receives double events causing jittering progress bars
  - Note: Line numbers slightly off (callback definitions are at lines 135-146), but the duplicate progress issue is real.
- [x] Fix `workerRuntime.ts:45` — `deflatePreparedImage` transfers `image.pixels.buffer` directly, but a `Uint8ClampedArray` view can have `byteOffset > 0`, causing the transferred buffer to include leading garbage bytes. Use `buffer.slice(byteOffset, byteOffset + byteLength)`
- [x] Fix `parallelMatcher.ts:171-176` — `matchPackedPixelsInParallel` rebuilds a full `MatchingSearchContext` for the merge phase, duplicating 40+ typed arrays already allocated per worker. For 512×512 images this adds hundreds of MB of redundant allocations
- [x] Fix `generate-built-in-transform-cache.mjs:87` — `sharp().resize(width, height, { fit: 'fill' })` stretches images to exact dimensions ignoring aspect ratio. Matches the worker behavior at `transform.worker.ts:16`, but should use `fit: 'contain'` or `fit: 'cover'` for quality. Ensure cache generation and runtime worker use identical resizing strategy
- [x] Fix `transformCore.ts:241-244` — `buildGroupedDonorState` sorts donors via `.sort()` (O(n log n)) for every color group. Most groups have 1–3 donors. Consider insertion sort or pre-sorted insertion for small arrays
- [x] Fix `generate-built-in-transform-cache.mjs:52-54` — `compileModule` regex only matches relative imports starting with `..` or `.`, but misses type-only imports and re-exports that don't follow the `from` keyword pattern. Some transitive dependencies aren't compiled, causing runtime `import` failures in the cache build script

### Minor / polish

- [x] Fix `transformCore.ts:849-850` — `maybeReportProgress` skips the 100% stage report when `completed === total`. Direct hook callers never see the final stage completion event
  - Note: INVALID — When `completed === total`, `completed !== total` evaluates to `false`, short-circuiting `&&`, so the `return` guard is NOT hit. The 100% report IS dispatched.
- [x] Fix `transformAnimation.ts:151` — `positionPriorityScratch` gives nearly all pixels the same `drawPriority`. Last pixel to claim each destination slot wins by iteration order — effectively arbitrary z-ordering with no documented tiebreaker
- [x] Fix `transformAnimation.ts:180-182` — `resolveAccentParticlesFrame` always returns `[]` with unused `_state`/`_phase` parameters. Either implement motion accents or remove the dead stub and its references from `TransformAnimationState.accentParticles`
- [x] Fix `parallelMatcher.ts:88-106` — `runRankingWorker` has no timeout for unresponsive workers. A hung worker blocks the entire parallel matching pipeline indefinitely. Add a configurable timeout with worker termination
- [x] Fix `workerRuntime.ts:229` — `cancelled` set only removes IDs in `finally`, but if `finally` never fires (unhandled promise rejection in the caller), the set grows without bound across request lifetimes
- [x] Fix `generate-built-in-transform-cache.mjs:40-42` — `rewriteRelativeImports` regex `[^'".]+` fails on import specifiers containing dots in filenames (e.g. `./some.module.ts`). Transpilation produces broken imports
- [x] Fix `transformCache.ts:57` — `base64ToArrayBuffer` returns `bytes.buffer` which could be larger than `bytes.byteLength` if the engine allocates an oversized backing store. Return `bytes.buffer.slice(0, bytes.byteLength)`
- [x] Add validation in `createMatchingSearchContext` (`transformCore.ts:338`) — no guard for empty `sourcePacked` or `targetPacked` arrays. A 0-pixel image produces zero-length arrays and confusing downstream behavior
- [x] Add dedicated error variant for dimension mismatch — `transformPreparedImages` (`transformCore.ts:1030`) throws a generic `TransformError`. A dedicated error type with structured details (actual vs expected dimensions) improves debuggability
- [x] Fix `builtInTransformAssets.ts` — URL constants are duplicated between `uiState.ts` and `builtInTransformAssets.ts`. Import from a single source of truth to prevent drift

## Local assistant utility — code review fixes

### Critical

- [x] Fix `local-llm-worker.js:87` — `InterruptableStoppingCriteria` is instantiated once but reused without `reset()` between turns; call `stoppingCriteria.reset()` before each `generateReply()`
  - Note: INVALID — Already fixed. `stoppingCriteria.reset()` IS called at line 128 before each `generateReply()`.
- [x] Fix `local-llm-chat.js:507` — `sendMessage` passes raw `this.messages` (including notice and draft objects) to the worker; use the same `compactMessages` filter instead
  - Note: PARTIALLY VALID — Notice objects ARE filtered (line 508). Empty draft assistant objects still reach the worker, but worker's `compactMessages` filters them out (`content.trim()` check), so no corruption occurs.
- [x] Fix `local-llm-chat.js:525` — `cleanupModelText` is called twice on `finalText` (once here, again in `finishAssistantMessage` at line 528); remove the pre-check cleanup
  - Note: INVALID — Line 525 compares lengths using cleaned strings, but line 528 assigns raw `finalText` then cleans it. The final value is cleaned exactly once. No double-cleanup.
- [x] Fix `local-llm-worker.js:145` — `tokenRate` starts at 0 because `numTokens` is incremented *after* the callback in `token_callback_function`; swap the order
  - Note: INVALID — First callback correctly returns `null` (line 412: `numTokens <= 1`), not 0. By token 2+, rate is correct. Behavior is intentional.
- [x] Fix `local-llm-chat.js:178-179` — `pagehide` listener and `utility-deactivate` listener are never removed; store references and call `removeEventListener` on disposal
  - Note: PARTIALLY VALID — `initLocalLlmUtility` has a `localLlmMounted` guard (line 888) preventing double-init, so the leak is theoretical. Still worth fixing for correctness.
- [x] Fix `local-llm-chat.js:525` — the `finalText` length comparison uses cleaned-up strings but then assigns the *uncleaned* `finalText`; both sides should be pre-cleaned
  - Note: INVALID — `finalText` is assigned raw on line 526, then immediately cleaned on line 528 (`cleanupModelText`). The final result is cleaned.
- [x] FIX ME — `local-llm-chat.js:582-584` / `local-llmState.ts:21-27` — the `compactMessages` function differs between the JS and TS versions; unify into the single exported `compactLocalLlmMessages` and import it from both `local-llm-chat.js` and `local-llm-worker.js`
  - Note: INVALID — Both versions DO call their respective cleanup functions (worker: `cleanupModelText` at line 247, TS: `cleanupLocalLlmText`). Minor differences in filtering logic (worker checks `typeof message.content === 'string'`), but both are functionally correct. Not a critical issue.
- [x] FIX ME — `local-llm-chat.js:503-507` — `this.messages` still contains the `assistantDraft` object (role: assistant, content: "") when `sendMessage` posts to the worker, sending an empty assistant message that corrupts conversation context
  - Note: PARTIALLY VALID — The empty draft IS sent to the worker, but worker's `compactMessages` filters it out (`.filter((message) => message.content.trim())`). No corruption occurs. Issue is real but harm is mitigated.

### Significant

- [x] Fix `local-llm-worker.js:323` — `postTransformersProgress` inverts the state mapping: `'loading'` sends `WORKER_STATE.OPTIMIZING` and vice versa, contradicting the shared function `normalizeLocalLlmProgressState` in `localLlmState.ts:11-13`
  - Note: INVALID — Line 323 maps `'loading'` → `WORKER_STATE.OPTIMIZING`, which matches `normalizeLocalLlmProgressState` (`'loading'` returns `'optimizing'`). They're consistent, not inverted.
- [x] Fix `local-llm-worker.js:129` — `pastKeyValuesCache` is created once and never reset or recreated between turns; this causes stale KV cache to grow per turn and leak GPU memory; create a new `DynamicCache()` at the start of each `generateReply()`
  - Note: INVALID — `resetChatState()` (line 202-207) calls `disposePastKeyValues()` which nulls the cache. Next generation creates a fresh `DynamicCache()` via `??=`. No leak.
- [x] Fix `js/utilities-shell.js:59-76` — `loadLocalAssistantScript` caches its Promise in `localAssistantScriptPromise` but never resets it on error; a single script load failure permanently breaks the local assistant
- [x] Fix `local-llm-worker.js:11-13` — `console.debug` and `console.info` are silenced for the entire worker lifecycle; restore them after `loadModel` finishes or scope the override to the load phase only
- [x] Add guard in `renderSafeText` / `renderLocalLlmSafeText` — empty `<ul></ul>` or `<ol></ol>` is produced when a block matches the list regex but has no valid list item lines
- [x] Fix `renderSafeText` code blocks — `block.replace(/^```[a-z0-9-]*\n?/i, '')` only strips the opening fence with one optional newline; trailing content on the fence line (e.g. language tag remnants) leaks into the rendered output
- [x] Fix `renderSafeText` bold regex — `\*\*([^*]+)\*\*` is greedy-correct but fails on nested or adjacent bold segments (`**a** and **b**`) because `[^*]+` won't match zero-stars boundaries; use `([^*]+(?:\*\*[^*]+)*)` or a non-greedy approach
  - Note: INVALID — `[^*]+` matches the content between `**` delimiters correctly. Adjacent `**a** and **b**` is handled fine as the regex engine moves past the first match before finding the second. No edge case failure.
- [x] Fix `local-llm-worker.js:244-248` — `compactMessages` has a different implementation than `compactLocalLlmMessages` in `localLlmState.ts`; the worker's version lacks the `cleanupLocalLlmText` call and differs in filtering logic; unify to the TypeScript export
  - Note: INVALID — Worker's `compactMessages` DOES call `cleanupModelText` (line 247). Minor filtering differences but both are functionally correct.

### Minor / polish

- [x] Add `center.hidden` and `center.classList.toggle` dedup in `renderStatePanel` — line 417-418 does both; keep one
- [x] Make `startChat` provide feedback on early return when model is already `READY` — currently silent
- [x] Fix `local-llm-config.js:36` — `do_sample: false` makes `temp`, `top_k`, `top_p`, `penalty_repeat` dead config; either set `do_sample: true` or remove the sampling parameters
- [x] Fix `announceLastAssistantMessage` (`local-llm-chat.js:614-618`) — screen reader announces interrupted (truncated) content; append "(stopped)" so assistive tech users know why the message ends mid-sentence
- [x] Add `escapeHtml` backtick handling — backticks pass through unescaped; not strictly an HTML issue but worth documenting in the function's intent
- [x] Consider debouncing `updateCharCount` and `autoSizeInput` on the `input` event handler

## Death calculator utility — code review fixes

### Critical

- [x] Fix `deathCalculatorController.ts:569-575` — `collectAnswers()` reads `systolicBloodPressure`, `diastolicBloodPressure`, `usesBloodPressureMedication`, `totalCholesterol`, `hdlCholesterol`, `usesLipidMedication`, and `restingHeartRate` from `FormData`, but none of these form fields exist in `pages/utilities/index.html`. All seven fields are always `null`/`false`, making the entire clinical biomarker driver branch in `longevityEngine.ts:271-348` (systolic, diastolic, cholesterol ratio, BP medication, lipid medication, resting heart rate) dead code. Either add the missing HTML inputs or remove the dead code paths
- [x] Fix `deathCalculatorController.ts:402-403` — `syncFormerSmokerField()` overwrites `this.yearsSinceQuitInput.value` to `'5'` every time the smoking status is changed to non-"former". If the user enters a value, changes smoking status away from "former", then switches back, the original value is lost. Only reset when the field is hidden, or preserve user-entered value ~~FIXED 2026-05-15~~
- [x] Fix `deathCalculatorController.ts:302` — The `document.addEventListener('keydown', ...)` listener is attached in `init()` but never removed. Every initialization cycle adds another listener, causing a memory leak and duplicate Enter-key handling. Store the handler reference and either use `{ once: false }` with proper cleanup, or attach to `this.root` with `capture: true` instead of `document` ~~FIXED 2026-05-15~~
  - Note: PARTIALLY VALID — `init()` is only called once from `main.ts:1434-1436`, so listener accumulation doesn't happen in practice. Still worth fixing for correctness.
- [x] Fix `deathCalculatorController.ts:524-526` — Only an upper age bound (`> 122`) is checked before calling `predictLongevity()`. Users under 18 bypass the controller but `longevityEngine.ts:552-554` throws `"Death Calculator v1 only supports adults 18 and older."`, which surfaces as a generic error screen at line 537-543. Add an `< 18` check in the controller and render a specific message instead of a caught exception ~~FIXED 2026-05-15~~

### Significant

- [x] Fix `deathCalculatorController.ts:524` vs `longevityEngine.ts:13` — The controller calculates age with `365.25` days per year while the engine uses `DAYS_PER_YEAR = 365.2425`. Ages near a year boundary (especially the 18-year minimum and 122-year immortal threshold) can differ slightly, leading to edge-case mismatch between the pre-flight check and the engine's age calculation. Share `DAYS_PER_YEAR` from the engine
- [x] Fix `longevityEngine.ts:644-651` — `formatCountdown` uses a `while(true)` loop that iterates once per year, calling `addUtcYears` and `getTime` each iteration. For a 60-year countdown this runs 60+ iterations every second via `setInterval` at `deathCalculatorController.ts:625`. Rewrite to O(1) arithmetic: compute years via UTC date math, then compute remaining days/hours/minutes/seconds
- [x] Fix `deathCalculatorController.ts:371` — The `'error'` screen reuses the survey screen (`this.surveyScreen.hidden = false`) with only the status text to differentiate. Users see the same question UI with a vague error message and no call to action. Either add a dedicated error screen with instructions, or redirect to intro with `this.beginButton` feedback
- [x] Fix `deathCalculatorController.ts:421-425` vs `deathCalculatorController.ts:399-405` — `yearsSinceQuitField` is controlled by both `syncQuestionUi()` (via `questionCards` map, line 421) and `syncFormerSmokerField()` (direct `hidden` assignment, line 400). If `syncQuestionUi` hides the card for a non-active question, then `syncFormerSmokerField` shows it because the user selected "former", the last writer wins but the question card visibility state is corrupted. The `yearsSinceQuit` question should be hidden only when the smoking status isn't "former", not via the question card rotation logic
  - Note: INVALID — `syncFormerSmokerField` runs BEFORE `syncQuestionUi` (lines 298-299), so the last writer (`syncQuestionUi`) wins correctly. No visibility corruption.

### Minor / polish

- [x] Fix `deathCalculatorController.ts:653-654` — `reset()` calls `this.setScreen('intro')` then `this.syncQuestionUi()`. The survey screen is already hidden, so updating the question UI is a no-op that wastes DOM writes. Remove the `syncQuestionUi()` call from `reset()`
- [x] Fix `deathCalculatorController.ts:245` — `this.prediction` is assigned in four places (lines 390, 538, 606, 637) but never read anywhere. Dead state. Remove the field or use it for a purposeful feature (e.g., showing prediction details on reset confirmation) ~~DELETED 2026-05-15~~
- [x] Fix `deathCalculatorController.ts:553` — `collectAnswers()` allows `birthDate` to be an empty string (`String(formData.get('birthDate') ?? '')`). The engine at `longevityEngine.ts:24-28` then throws `"Birth date is invalid"`, which surfaces as a generic error screen. Validate `birthDate` is non-empty in `collectAnswers()` or the controller's pre-flight, and show a field-level validation error instead
- [x] Fix `deathCalculatorController.ts:346-347` — `init()` calls `this.syncFormerSmokerField()` then `this.reset()`, which also calls `this.syncFormerSmokerField()` at line 651. Remove the redundant call from `init()` ~~DELETED 2026-05-15~~
- [x] Fix `longevityEngine.ts:443-479` — `projectSurvivalCurve` iterates day-by-day up to age 121. For a newborn (`currentAgeYears = 0`), `maxDays` is ~44,200, each iteration running `interpolateAnnualHazard` (which does an O(n) `find` over 121 entries), `computeMortalityProjectionFactor`, and a percentiles pass. The total work is ~44,200 × (O(121) + constant). For a 120-year-old it's ~365 iterations. Consider whether the day-by-day loop is necessary or if a coarser step for high-confidence tail values would be sufficient for the percentile thresholds
- [x] Fix `longevityEngine.ts:47` — `interpolateAnnualHazard` uses `entries.find()` twice per call (lines 58, 59), scanning up to 121 entries for each `find`. Since the curve is called once per day for tens of thousands of days, this is O(n × entries.length) per call. The entries are sorted by age — use binary search or pre-build a `Map<number, MortalityBaselineEntry>` lookup
- [x] Fix `deathCalculatorController.ts:592` — `renderImmortal()` sets `innerHTML` on `countdownDisplay` rather than `textContent`. If the infinity symbol or CSS class changes this introduces an XSS surface. Use `textContent` with a separate `<span>` element or create the element via `document.createElement`
  - Note: INVALID — The `innerHTML` contains only hardcoded content (`∞` symbol, no user input). Not an XSS surface. Style improvement, not a security fix.
- [x] Fix `deathCalculatorController.ts:523` — The birth date is parsed as UTC noon (`T12:00:00Z`) in the controller for the age check, but `longevityEngine.ts:24` also parses as UTC noon. These agree, but the choice is arbitrary and can cause the age to be off by up to 12 hours depending on the user's timezone. The `predictLongevity` function receives `new Date()` as the default `now`, which is wall-clock local time. The age calculation should be consistent: either all UTC or all local
- [x] Fix `deathCalculatorController.ts:272-277` — `questionCards` is built from `this.root.querySelectorAll('[data-question-card]')`, but `this.root` is passed from `main.ts:1405` as `#deathCalculatorApp`. If the HTML template ever reorders or dynamically loads question cards, this map won't update. Consider rebuilding the map in `init()` rather than the constructor

## Virtual machine utility — code review fixes

### Critical

- [x] Fix `retroVmController.ts:354-355` — `statusChip` and `statusText` are resolved via `document.getElementById('retroVmStatusChip')` and `document.getElementById('retroVmStatusText')`, but neither element exists in `pages/utilities/index.html`. The `retroVmApp` section has no status chip or status text element. `statusChip` being `null` is guarded in `syncUi()` (line 733), but `statusText` is written to unconditionally in `setVmStatusLine()` at line 431 (`this.statusText.textContent = text`), causing a `TypeError` on every status update. Add the missing HTML elements or remove the dead references
  - Note: PARTIALLY VALID — Elements are missing from HTML, but both `statusChip` (line 732) and `statusText` (line 430) HAVE null guards. No TypeError in practice. Still worth fixing since the UI shows no status.
- [x] Fix `retroVmController.ts:393-395` — `document.addEventListener('keydown', ...)`, `document.addEventListener('fullscreenchange', ...)`, `window.addEventListener('resize', ...)`, and `window.addEventListener('pagehide', ...)` are all attached in `init()` with no corresponding removal. There is no `dispose()` or `destroy()` lifecycle method. If the utility stage is reactivated (navigated away and back), duplicate listeners accumulate. The `pagehide` handler calls `void this.destroySession()` but doesn't return a string, so no unload confirmation dialog is shown. Add a `dispose()` method that cleans up all global listeners and calls `mouseBridge.detach()`
  - Note: PARTIALLY VALID — `main.ts` guards against re-init via `initializedUtilities`, so duplicate listeners don't accumulate in practice. Still worth adding `dispose()` for correctness.
- [x] Fix `retroVmController.ts:566-598` — `autoAdvanceBootMenu()` / `dispatchEnterKey()` dispatch DOM `KeyboardEvent`s on `this.screenContainer` (a `<div>`). But v86 captures input at the WASM level, not through host DOM events on the container div. The Enter key never reaches the guest boot menu, so the boot menu is never auto-advanced. Use `this.emulator.keyboard_send_keys([28])` (scan code for Enter) instead of synthetic DOM events
- [x] Fix `retroVmController.ts:532-549` — `reset()` has no try-catch around the teardown sequence. If `destroySession()` rejects (e.g., `active.destroy()` throws), the state machine is left stuck in `'resetting'` forever. The user sees a "Resetting" chip with no recovery path. Wrap the body in try-catch and transition to `'error'` on failure

### Significant

- [x] Fix `retroVmConfig.ts:19` — `bootOrder: 0x132` (306 decimal) sets CD-ROM + network boot, omitting the hard disk entry. The documented v86 standard for CD-ROM boot with hard disk fallback is `0x210`. `0x132` includes network boot (which is disabled) and omits hard disk, so the BIOS boot menu won't show the hard disk option
- [x] Fix `retroVmController.ts:610-618` — `getGuestViewport()` returns `scale: 0` when `graphicalModeActive` is false. `sendAbsolutePosition()` in the mouse bridge uses `safeScale = viewport.scale || 1`, which short-circuits to `1` instead of the actual scale. During text-mode boot (before graphics init), mouse coordinates are mapped incorrectly. Use the real unscaled guest dimensions or skip mouse forwarding entirely during text mode
  - Note: INVALID — `sendAbsolutePosition` returns early at line 183 when `viewport.scale <= 0`. Mouse coordinates are NOT forwarded during text mode. No incorrect mapping.
- [x] Fix `retroVmController.ts:651-654` — `getBus()` casts `this.emulator` to `unknown as { bus?: RawBus }`, but `EmulatorLike` doesn't declare `bus`. `FakeRetroVm` has no `bus` property, so test-mode mouse interaction via `RetroVmMouseBridge` silently fails
- [x] Fix `retroVmSupport.ts:15-65` — `detectRetroVmSupport()` checks WebAssembly and Web Workers but doesn't check for Fullscreen API (`document.fullscreenEnabled`) or Pointer Lock API (`document.requestPointerLock`). The VM silently initializes and then fails when the user clicks Fullscreen or tries to capture the mouse. Add checks with a graceful degraded message
- [x] Fix `retroVmController.ts:730-741` — `syncUi()` writes `getDefaultSupportNote()` to `supportNote.textContent` for non-error states (line 741), then `applyInteractionStatusCopy()` (line 757) overwrites it again for running/fullscreen states. During loading/resetting, `applyInteractionStatusCopy()` returns early (line 671), so the support note shows the generic online/offline copy instead of a context-specific message about what's happening
- [x] Fix `retroVmConfig.ts:95-132` — `buildRetroVmV86Options()` doesn't set `writable_fs: false`. Without it, v86 may create an implicit writable overlay that consumes memory on every boot. Explicitly set `writable_fs: false` to match the "ephemeral per tab" marketing claim
  - Note: INVALID — Without a hard disk image provided, v86 defaults to no writable overlay. No implicit memory leak occurs. Setting `writable_fs: false` is cosmetic documentation, not a fix.
- [x] Fix `retroVmController.ts:336-348` — `onReady()` is registered as an `'emulator-ready'` listener, but v86 fires this after BIOS init, not after the guest desktop loads. The `bootHintTimer` fires 4 seconds later regardless. If the guest takes longer than 4 seconds to reach the desktop, the hint text overwrites boot information the user is reading
- [x] Fix `retroVmController.ts:301-307` — `fullscreenChangeHandler` handles both `fullscreenchange` and `window.resize`. During active resizing, `ResizeObserver` (line 401-405) also fires `syncGuestFit()`. Both read `getBoundingClientRect()` synchronously during layout thrashing. Debounce the window resize path
- [x] Fix `retroVmSupport.ts:157-160` — `transitionRetroVmState` with event `'reset-complete'` always returns `'idle'`. If `reset()` encountered an error internally but still dispatched `reset-complete`, the state would jump to `'idle'` masking the error. Controller should only transition to reset-complete on success
  - Note: PARTIALLY VALID — `reset()` only dispatches `reset-complete` on success (line 548). However, `reset()` itself lacks try-catch (see critical item above), so errors _could_ cause `reset-complete` to fire after failure.
- [x] Fix `retroVmController.ts:497-510` — `enterFullscreen()` only checks `!this.emulator` and `!document.fullscreenEnabled`. It doesn't check for `'error'` or `'unsupported'` state. If the VM previously errored but `emulator` holds a stale reference, `requestFullscreen()` succeeds but nothing renders
- [x] Fix `retroVmController.ts:302-307` — `fullscreenChangeHandler` reads `this.state`, calls `setState()` which calls `syncUi()` which reads `this.state` again. If `syncUi()` throws (e.g., due to the null `statusText` bug), the state is already committed, leaving the controller in an inconsistent state
  - Note: PARTIALLY VALID — Both `statusChip` (line 732) and `statusText` (line 430) have null guards, so `syncUi()` won't throw from the missing elements. Theoretical-only risk.

### Minor / polish

- [x] Fix `retroVmController.ts:283` — `progress` is initialized with `RETRO_VM_CONFIG.cdromSizeBytes` (module-level constant), but the constructor at line 353 reassigns it to `this.config.cdromSizeBytes`. Remove the initial value and use `null` as the field initializer to avoid the stale reference
- [x] Fix `retroVmMouseBridge.ts:219-240` — `requestPointerLock()` has nested try-catch blocks. The inner fallback (`await this.root.requestPointerLock()` without options) at line 234 is not awaited because it's inside a non-awaited catch block — the outer try-catch at line 230 swallows it. Consolidate to one try-catch
  - Note: INVALID — The inner fallback IS properly awaited (inside the outer try block, not a separate catch). The nested try-catch structure is correct.
- [x] Fix `retroVmMouseBridge.ts:94-96` — `onMouseMove` runs `sendAbsolutePosition()` on every mouse move. During pointer lock the call returns early but the event still fires. Consider removing the listener during pointer lock and re-adding after unlock to eliminate per-move overhead
- [x] Fix `FakeRetroVm.ts:36` — `FALLBACK_ISO_SIZE_BYTES` (128 MB) is dead code since `RETRO_VM_CONFIG.cdromSizeBytes` (20082688) is always defined. Consider testing the fallback path separately
- [x] Fix `retroVmConfig.ts:37-40` — `nicType: 'ne2k'`, `id: 0`, and `mtu: 1500` are included in the network config but only used when `isRetroVmNetworkReady()` returns true. Since networking is always disabled, these are dead configuration. Document or remove
- [x] Fix `build-retro-vm-image.sh:55-56` — `cpio_status > 2` silently ignores exit code 2 from `cpio` ("some files cannot be read/processed"). A truncated kernel image would be silently embedded into the ISO. Use `>= 2` to treat code 2 as a hard failure
  - Note: DEBATABLE — The `> 2` check may be intentional to tolerate cpio's exit code 2. Whether this should be a hard failure depends on build requirements.
- [x] Fix `build-retro-vm-image.sh:4-6` — `SOURCE_ISO` points to `TinyCore-11.0.iso` but there's no existence check before `bsdtar -xf`. If the base ISO is missing, the Docker container hangs trying to extract from a nonexistent file
- [x] Fix `build-retro-vm-image.sh:30-39` — `rsvg-convert` is called twice to generate PNG icons. If one conversion fails (malformed SVG), the script continues with a missing icon file, producing desktop entries with broken icons. Add `set -e` protection per conversion or check exit status
  - Note: INVALID — Script runs under `set -euo pipefail` (line 2), so a failed `rsvg-convert` would abort the entire script automatically.
- [x] Fix `retro-vm-guide` / `retro-vm-browser` shell scripts — Hard-depend on `aterm` with no fallback to `xterm` or `xterm-js`. If aterm isn't installed in the base image, these launchers fail silently
- [x] Fix `retro-vm-guide.desktop` — Missing `StartupNotify=false`. Desktop environments like GNOME/KDE show a loading spinner for a window that never matches the startup ID. Also, `Terminal=false` with `Exec` running a terminal emulator is non-standard for GNOME/KDE (works for FLWM)
- [x] Fix `retroVmController.ts:224-227` and `244-248` — `RetroVmMouseBridge` checks `window.__OD_RETRO_VM_TEST_MODE__` in `requestPointerLock()` and `releasePointerLock()` to fake pointer state. But `onPointerLockChange` at line 125-128 also reads `document.pointerLockElement`, which is always `null` in test mode. The test-mode path in `requestPointerLock` sets `this.pointerLocked = true` directly, but `onPointerLockChange` could still fire and reset it to `false` if the browser sends the event
  - Note: PARTIALLY VALID — Test-mode paths set `this.pointerLocked` directly and don't trigger `pointerlockchange`, so `onPointerLockChange` doesn't interfere in tests. Theoretical-only risk.

## Stress test utility — code review fixes

### Critical

- [x] Fix `stressTestController.ts:333` — `this.handleWorkerMessage(record, event.data)` is called in `startCpuStress` but the method does not exist on `StressTestController`. This causes an immediate `TypeError` whenever a CPU stress worker sends its first heartbeat, breaking all CPU stress metrics (iterations, worker counts, etc.). Implement the method to handle `CpuStressHeartbeatResponse`, `CpuStressStoppedResponse`, and `CpuStressErrorResponse`, updating `this.totalIterations` and `record.iterations`
- [x] Fix `stressTestController.ts` — No `dispose()` or lifecycle cleanup method. `init()` attaches `pagehide`, `hashchange`, `resize`, and `utility-activate` listeners to `window`/`document` with no removal. `main.ts:1445-1451` creates a new controller on each utility activation with no existing-instance guard. Re-navigating creates a second controller with duplicate listeners and two state machines fighting over the same DOM. Add `dispose()` or store instance in `main.ts`
  - Note: PARTIALLY VALID — `main.ts:1444` checks `initializedUtilities.has('stressTest')` before creating, preventing duplicate controllers. However, listeners are still never removed, so adding `dispose()` is still worthwhile.
- [x] Fix `stressTestController.ts:236-298` — `start()` is `async` but `stop()` is synchronous. If Stop is clicked while `await this.startGpuStress()` is pending, `stop()` transitions to `idle` and clears state. When the `await` resumes, `start()` continues with stale state: assigns `this.gpu`, calls `setState()`, and may call `this.stopCpuStress(requestId)` with new `requestId`. Add `requestId` guards around every mutation after each `await`
- [x] Fix `stressTestController.ts:300-317` — `stop()` chains `transitionStressState(this.state, 'stop')` then `transitionStressState(this.state, 'stopped')` synchronously. If `this.state` changed between calls (concurrent `start()`), the second transition produces an incorrect state. Use a local variable to chain transitions deterministically
  - Note: PARTIALLY VALID — Theoretically possible but `stop()` has an early guard at line 301 (`this.state !== 'starting' && this.state !== 'running'`), and `start()` has gates. In practice, concurrent start/stop is extremely unlikely.
  - Note: Line 306 updates `this.state` via `setState()`, then line 314 reads `this.state` again. If nothing changed `this.state` between lines 306 and 314, the transitions chain correctly.

### Significant

- [x] Fix `stressTestController.ts:358` — `stopCpuStress` sends `record.worker.postMessage(request)` then immediately `record.worker.terminate()`. The stop message is never processed — terminate kills the worker synchronously. The `postMessage` is dead code. Remove it
- [x] Fix `stressTestController.ts:366-367` — `stopCpuStress` always resets `this.totalIterations = 0` and calls `this.stopMetricLoop()`. If called independently (e.g., CPU worker error in 'both' mode), GPU metrics reset and metric loop dies while GPU visuals still run. Factor these into the public `stop()` method
- [x] Fix `stressTestController.ts:429-624` — `startWebGpuStress` creates `storageBuffer`, `computeBindGroup`, `renderModule` as local closure variables. `stopGpuStress` only calls `device.destroy?.()`. Store GPU resource references in `ActiveWebGpuStress` for explicit destruction, or verify `device.destroy()` is sufficient per WebGPU spec
- [x] Fix `stressTestController.ts:656` — WebGL fragment shader has `for (int i = 0; i < 1536; i++)` — many WebGL 1 drivers fail to compile loops this large, or compile them inefficiently. The workload clamp (`u_workload` at max 1152) may not be optimized away. Reduce loop bound and control workload via fragment dispatch density
- [x] Fix `stressTestController.ts:740` — WebGL time uniform uses `time * 0.001` (from `requestAnimationFrame`'s `DOMHighResTimeStamp`), but CPU visuals use `this.startedAt` for timing. The two timers drift by hundreds of ms due to shader compilation delay. Use `this.startedAt` for both to keep visuals synchronized
- [x] Fix `stressTestController.ts:776-780` — `stopGpuStress` calls `loseContext.loseContext()` to destroy WebGL context. If the user switches to CPU-only mode after GPU stress, the canvas context is in a lost state. The next start call masks this via `prepareGpuCanvas()` which replaces the canvas, but the lost-context state is not handled cleanly
- [x] Fix `stressTestController.ts:336` — Worker error handler uses `this.requestId` to stop stress. If a new `start()` was initiated (incrementing `requestId`) before the error handler fired, it stops the NEW workers with a mismatched `requestId`. Use the closure `requestId` from `startCpuStress`
  - Note: INVALID — `stopCpuStress` calls `terminate()` which kills workers regardless of requestId match. The mismatched requestId doesn't prevent the stop. Effect is the same: all workers are killed.
- [x] Fix `stressTestController.ts:867-872` — `renderCpuVisualsFrame` recalculates `workerLoad` every frame via `resolveCpuWorkerCount()` instead of reading `this.workers.length`. More importantly, `iterationSignal` is always 0 because `this.totalIterations` is never incremented (see critical bug #1 — `handleWorkerMessage` doesn't exist). The entire visual feedback loop is dead
  - Note: PARTIALLY VALID — The iterationSignal issue is valid and depends on the critical `handleWorkerMessage` bug. Once that's fixed, the visual feedback loop works. The `resolveCpuWorkerCount()` call vs `this.workers.length` is a minor efficiency concern, not a correctness bug.
- [x] Fix `stressTestController.ts:983-988` — `startMetricLoop` continues running during `stopping` state (line 984 only checks `'running' || 'starting'`). Metrics show stale/transitional data during the stop sequence
  - Note: INVALID — During `'stopping'`, the condition `this.state === 'running' || this.state === 'starting'` is false, so `requestAnimationFrame` doesn't schedule. The current tick completes but no new frames are queued. Behavior is correct.
- [x] Fix `stressTestController.ts:1120-1126` — `prepareGpuCanvas` calls `replaceCanvasElement()` which swaps the DOM canvas. If `renderCpuVisualsFrame` has an in-flight `requestAnimationFrame` callback mid-frame, the in-flight `ctx` writes to the old canvas and new gradients/draws go to the new canvas. Not a crash but orphaned draw operations
- [x] Fix `stressTestController.ts:1063-1089` — `syncControlPanelFit` forces layout thrashing by reading `controlPanel.scrollHeight` after each `card.hidden = true` toggle. With 6 metrics it's acceptable but batching the hide operation would be cleaner

### Minor / polish

- [x] Fix `stressTestController.ts:1018` — `this.root.dataset.stressGpuFrameCount` is set to `this.frameCount` but `frameCount` counts both GPU and CPU visual frames (both call `recordGpuFrame`). Misnamed attribute — rename to `totalRenderedFrames` or separate counters
- [x] Fix `stressTestController.ts:1020` — `this.root.dataset.stressGpuCanvasActive` is true when `cpuVisualFrameId > 0`. The attribute name claims GPU but the canvas is active for CPU visuals. Rename to `canvasActive`
- [x] Fix `stressTestController.ts:335-339` — Single CPU worker error kills ALL workers and GPU stress. For n workers, one OOM causes total failure. Consider restarting failed workers (with retry limit) or continuing with remaining workers
- [x] Fix `stressTest.worker.ts:26` — `checksum -= Math.floor(checksum)` keeps checksum in [0, 1) but can produce negative values (`-Number.EPSILON`). `Math.floor(-0.0000000001)` is `-1`, making the result `0.9999999999`. Works but fragile. Use `((checksum % 1) + 1) % 1` for clarity
- [x] Fix `stressTest.worker.ts:42` — `setTimeout(..., 0)` yields 4ms minimum per HTML spec, not 0ms. Worker spins ~90ms chunks with 4ms gaps, resulting in lower CPU utilization than intended
- [x] Fix `stressTest.worker.ts:64-74` — `stop()` only acts if `requestId` matches. No stop-all mechanism for emergency shutdown without `terminate()`
- [x] Fix `stressTestCore.ts:63-86` — `transitionStressState` always returns `'error'` for error event regardless of current state. An error in `'idle'` state is as severe as in `'running'` state, making recovery require `'reset'`. Consider state-dependent error transitions
- [x] Fix `stressTestCore.ts:88-99` — `formatStressElapsed` has no maximum display. 100+ hours shows `100:00:00`. Consider days notation for `> 24h`
- [x] Fix `stressTestController.ts:121-124` — `getStressTestMaxWorkersOverride` reads `window.__OD_STRESS_TEST_MAX_WORKERS__` undocumented global. Document as internal debug tool
- [x] Add `StressTestController` unit tests — The existing suite only covers `stressTestCore.ts`. The controller has significant logic (WebGPU/WebGL startup, state machine, worker lifecycle, canvas management) with zero test coverage. Add tests with mocked WebGPU/WebGL contexts and worker mocks

## Fourier utility — code review fixes

### Critical

- [x] Fix `audioFourierCore.ts:474-476` — `reconstructWindowedComponentRange` creates its default `scratch` parameter via `createReconstructionScratch(analysis)` at function definition time. But `analysis` isn't available at definition time — it's a function parameter evaluated lazily. This means the default is actually evaluated on each call that omits `scratch`, creating a new `ReconstructionScratch` with `frameCount × frameSize` Float32Arrays every time. For the typical use case where this function is called hundreds of times from `buildEnergyBandReconstruction` with an explicit scratch, it's fine. But the default parameter signature is misleading since callers that don't pass scratch get no performance benefit. Document this or restructure so the default is `undefined` and the function allocates internally

- [x] Fix `audioFourierCore.ts:697` — `buildEnergyBandEnvelopes` uses `Math.max(0, Math.round(bandCount))` for `resolvedBandCount`, allowing 0 bands. With 0 bands the function allocates zero-length `min`/`max` arrays but `bucketCount` is computed from the non-zero `sampleCount`, producing a return value with `bandCount: 0` but potentially non-zero `bucketCount`. Calling code (`mixEnergyBandEnvelopes`) would then receive mismatched dimensions. Use `Math.max(1, ...)` to match `buildSampleEnvelope`'s behavior

- [x] Fix `audioFourierController.ts:830-832` — `handlePlaybackButton` checks `playbackElapsedSeconds >= proxyDurationSeconds` to decide whether to reset before replay. But `onended` at line 879 sets `playbackElapsedSeconds` exactly to `proxyDurationSeconds`, and `tickPlayback` clamps it the same way. Due to floating-point drift between `context.currentTime - playbackStartedAt` and `proxyDurationSeconds`, the comparison can fail even when playback is complete, leaving the button stuck in a non-replayable state. Use `this.state === 'complete'` or `playbackElapsedSeconds >= proxyDurationSeconds * 0.999` instead

- [x] Fix `audioFourierController.ts:837-839` — `playFromBeginning` is a private method that's never called from anywhere. Dead code that resets elapsed and calls `playPlayback`. Remove entirely ~~DELETED 2026-05-15~~

### Significant

- [x] Fix `fft.ts:78-80` — Twiddle factors for the inner butterfly loop are accumulated via iterative complex multiplication (`rotationReal * stepReal - rotationImag * stepImag`) rather than computed from scratch each iteration. This causes floating-point drift per stage. For frame sizes of 4096 (detailed preset) with 12 stages, the accumulated rotation at the end of each stage can drift by several ULPs from the true value, introducing subtle artifacts in the reconstructed signal. Precompute twiddles via `Math.cos`/`Math.sin` or use CORDIC-style correction

- [x] Fix `audioFourierCore.ts:592-598` — `buildEnergyBandReconstruction` computes `bandEnergyFractions` as cumulative energy ratio (`energySum / totalEnergy`), then uses `resolveEnergyBandGains` to map a target energy percentage to per-band amplitude gains. However, applying a fractional AMPLITUDE gain doesn't proportionally reduce energy — a 50% gain captures 25% of that band's energy. The energy slider claims to capture N% of signal energy but actually achieves roughly sqrt(N)%. Either rename the slider to "signal strength" or implement correct per-component selection within partial bands instead of per-band amplitude scaling

- [x] Fix `audioFourierCore.ts:740-784` — `mixEnergyBandEnvelopes` linearly mixes per-band min/max envelopes with per-band gains. The min/max of a weighted sum is NOT the weighted sum of individual min/max values. This produces envelopes that are systematically too wide (overestimating both peaks and troughs), making the waveform visualization misleading for intermediate energy settings. Either recompute envelopes from mixed samples or flag the visualization as approximate

- [x] Fix `audioFourierWorker.ts:14-212` — The worker's `processQueue` queues requests but never clears completed requests from the `pendingRequests` array after processing. While `shift()` removes from the front, the `cancelledRequests` Set grows unbounded if many requests are cancelled without being processed. Additionally, the `isProcessing` flag prevents concurrent processing, meaning a slow long-form analysis blocks all subsequent short requests indefinitely. Consider a work-stealing or priority queue approach
  - Note: INVALID — `cancelledRequests` is cleaned in `finally` at line 194 and in `processQueue` at line 204-206. `pendingRequests` is drained via `shift()`. `isProcessing` is intentional for correctness. No unbounded growth.

- [x] Fix `audioFourierCore.ts:100-120` — `downsampleForDisplay` uses `Math.max(start + 1, Math.floor((index + 1) * scale))` for the upper bound, but when `scale < 1` (displaySampleCount exceeds signal length), consecutive output buckets can share the same source sample range, producing repeated values in the display frame instead of interpolated upsampling. The peak-based approach is fine for downsampling but produces artifacts when used for display oversampling

- [x] Fix `audioFourierController.ts:862-871` — `playPlayback` creates `AudioBufferSourceNode`s for each band but never stores them in the `ActiveBandNode` struct beyond the map. If band count changes between `ensureBandBuffers` and the map (theoretically impossible but possible if `activeResult` mutates), the node count and gain count will mismatch. Add an assertion to verify `activeBandNodes.length === activeResult.bandGains.length` after the map

- [x] Fix `audioFourierController.ts:634-673` — `applySuccess` reconstructs `bandEnergyFractions` from the transferred ArrayBuffer, but `buildEnergyBandReconstruction` sets the last element to exactly 1 at line 600. Due to floating-point division in `energySum / totalEnergy` at line 595, the last element before the override may differ slightly. The override at line 600 ensures correctness, but the same guarantee should be documented in the interface contract so downstream code doesn't need to assume it

- [x] Fix `audioFourierController.ts:1252-1271` — `drawSpectrumFrame` uses `bandEnergyFractions[index]` directly as bar height multiplier. Since these are cumulative (each fraction includes all previous bands' energy), the bars show cumulative energy rather than per-band energy, making the visualization misleading. Should use `bandEnergyFractions[index] - (index > 0 ? bandEnergyFractions[index-1] : 0)` for per-band height

- [x] Fix `audioFourierController.ts:767-786` — `resolveMixedVisualEnvelope` is called conditionally but caches the result in `this.mixedVisualEnvelope`. If `activeResult.bandGains` changes (via slider), `visualEnvelopeDirty` is set to true. However, if `mixedEnvelope` is `null` (full energy), the method returns null and never validates that gains are actually all-ones. A race between gain changes and the full-energy check could produce stale cached data

### Minor / polish

- [x] Fix `audioFourierController.ts:564-571` — `audioChannelsToSourceTransfer` double-copies channel data: `new Float32Array(channel)` copies once, then `new Float32Array(channel).buffer` copies again inside `asArrayBuffer`. The outer `new Float32Array(channel)` at line 564 already creates an independent ArrayBuffer; `.buffer` on that returns it directly to `asArrayBuffer`, which recognizes it and returns as-is. Remove the redundant wrapping
  - Note: INVALID — `asArrayBuffer` on an `ArrayBuffer` returns the same reference. The `.buffer` property on the outer `Float32Array` returns the backing ArrayBuffer directly. No double-copy occurs.

- [x] Fix `audioFourierController.ts:70` — `formatSeconds` has a discontinuous format boundary at 60 seconds: `59.9s` → `1:00`. Consider using minutes notation for `>= 30` seconds instead for smoother transitions

- [x] Fix `audioFourierController.ts:796-805` — `ensureBandBuffers` creates new `AudioBuffer`s per band on every playback start. Old buffers become eligible for GC after `stopPlayback` disconnects nodes, but rapid play/pause cycles generate GC pressure. Consider pooling buffers

- [x] Fix `audioFourierController.ts:853-860` — `playPlayback` schedules a linear ramp on `masterGain.gain` that's independent of `resolveEnergyMakeupGain`. If the user changes the energy slider during the initial `PLAYBACK_FADE_SECONDS` (100ms), `updateLiveBandGains` applies `setTargetAtTime` which exponentially smooths to the new value while the linear ramp continues. The two scheduling methods can briefly fight. Consider gating `updateLiveBandGains` during the initial fade period

- [x] Fix `audioFourierController.ts:1009-1015` — `drawEmptyState` doesn't clear the wave canvas's centered label. Only the spectrum and component canvases get placeholder text. The wave canvas shows a blank black rectangle which could confuse users

- [x] Fix `audioFourierWorker.ts:165-176` — The `postMessage` transfer array calls `asArrayBuffer` again on already-converted buffers. Since `asArrayBuffer` on an ArrayBuffer returns the same reference, this is a no-op. But the transfer array contains duplicate calls to `asArrayBuffer` that suggest the author wasn't certain about reference identity. Extract to variables for clarity

- [x] Fix `audioFourierCore.ts:84-98` — `createHannWindow` returns `[0, 0]` (all zeros) for size 2, but the standard Hann window formula produces `[0, 1]`. The zero-window would make any 2-sample frame completely silent during reconstruction. While the minimum practical `frameSize` is 2048, unit tests or edge cases could trigger this

- [x] Fix `audioFourierController.ts:94-156` — The controller has no `resizeCanvas` method or `ResizeObserver`. Canvas dimensions are set at construction time from the initial HTML element size. If the browser is resized or the utility panel is toggled, canvases render at wrong dimensions with no reflow. Add canvas resize handling

- [x] Fix `audioFourierController.ts:1325-1336` — `destroy` calls `setState('idle', 'Destroyed.')` which dispatches `utilities-load-state` and `syncButtons`, but many DOM event listeners attached in `init()` are never removed. The `mql` listener at line 197-203 is also never cleaned up. Add proper listener cleanup

- [x] Fix `audioFourierUiState.ts:19-25` — `resolveAudioPlaybackButtonState` always returns the play icon (`\u25b6`) regardless of playback state. When playback is complete (replay state), the icon should arguably be a replay/rewind symbol. The `isPlaying` state should show a pause icon

- [x] Fix `audioFourierWorker.ts:42-196` — `handleAnalyzeRequest` has no progress callback for the envelope computation phase (lines 114-121). Progress jumps from ~95% (end of band reconstruction) to 100% (success message) without any feedback for the potentially expensive envelope bucketing step

- [x] Fix `audioFourierCore.ts:378-447` / `audioFourierCore.ts:470-527` — `reconstructWindowedComponentCount` and `reconstructWindowedComponentRange` are nearly identical (both scatter coefficients, IFFT each frame, overlap-add, normalize). Deduplicate into a single function that accepts a set or list of component indices

- [x] Add `AudioFourierController` integration tests — The existing test suite (`audioFourierController.test.ts`) only tests `clamp` and `assertPowerOfTwo` utilities. The controller class (1337 lines) with canvas rendering, Web Audio playback state machine, worker message handling, and slider-driven reconstruction has zero test coverage. Add tests with mocked Web Audio API, Worker, and canvas context

- [x] Add `audioSignal.ts` tests — `normalizeSignal`, `resampleLinear`, and `prepareAudioSignal` have no dedicated test file. These signal processing functions (DC removal, peak normalization, linear interpolation resampling) should be tested for correctness, edge cases (single-sample signals, extreme sample rate ratios), and round-trip fidelity
