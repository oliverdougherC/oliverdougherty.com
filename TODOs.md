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
