# LLM Rumen Cannula browser validation

Build the utility bundle first, then run:

```sh
node scripts/local-assistant-check.js
UTILITIES_BROWSER=firefox node scripts/local-assistant-check.js
UTILITIES_BROWSER=webkit node scripts/local-assistant-check.js
```

`runLocalAssistantChecks(browser, baseUrl)` is also called by the general utilities harness. Add `--ui-fixture` to run only the isolated lifecycle/layout checks during UI iteration. `UTILITIES_CHECK_URL` targets an already-running source/deployment preview; otherwise the command starts the standard static server. Screenshots are written under `output/local-assistant/`.

`--transport` runs just the production no-store cache probe, lazy-loading, unsupported-browser, and failed-download/retry checks. `--cache-only` runs the cache probe alone. `runModelCacheCheck(browser)` is exported for reuse.

The cache probe bundles the production `downloadModel` function and serves an eight-byte valid GGUF header with aggressive `Cache-Control: max-age` headers. An independently cacheable control must produce one HTTP request for two reads, proving caching is enabled. Two model loads and a reload must produce three HTTP requests. No Playwright routing is used, since routing would disable the cache and invalidate this test. WebKit uses a temporary persistent profile because its private contexts disable HTTP caching; that profile is removed afterward. Available local/session storage, Cache API, IndexedDB, and OPFS inventories must remain unchanged. Unavailable storage inspection APIs are reported explicitly. This probe validates transport behavior without downloading or claiming inference on model weights.

The default checks exercise the shipped unsupported-browser and HTTP 503/retry paths without downloading weights. The failed-download case supplies a minimal test-only GPU adapter and JSPI presence shim to reach the HTTP failure; it never allocates a model. Loading cancellation, stale callbacks, navigation, keyboard handling, conversation reset, Markdown/MathML, responsive containment, and reduced-motion layout run against a clearly isolated runtime fixture. The fixture replaces only the controller bundle's runtime import through an esbuild plugin and a Playwright response interception. Production controller, session, Snake, and rendering code run unchanged. The viewport fixture supplies **synthetic observations only to test UI behavior and layout**, clearly separate from real-run evidence. It is **not evidence of model inference, WebGPU execution, quality, or speed**.

Screenshots cover loading, expanded Snake, and a fully populated long conversation at 3840×2160, 2560×1440, 1920×1200, 1600×1200, 1920×1080, 1440×900, 1280×720, 1024×600, and 800×600. The page and panels must remain within the viewport; only the transcript is intended to scroll. The fixture supplies prompt tokens once, then 1,024 distinct decoded-token observations with explicit forward-pass identifiers and absolute sequence positions.

The three linked observatory views are tested with synthetic sparse head-mean attention, relative layer deltas, and two intermediate logit-lens checkpoints at zero-based layers 11 and 19. Attention weights deliberately retain less than 100% mass so the test detects accidental renormalization. Query and sampled-token positions differ by one. Waterfall color uses logarithmic intensity with one shared scale across the retained window; numeric inspection must still show the original supplied relative delta, not the color intensity; lens ranks must come from checkpoint ordering rather than final probabilities. The lens must remain above the final candidate bars at every viewport size. Rendered SVG glyph heights are checked after applying the screen transform, with an approximately nine-pixel minimum; compact lens views show the top two measured ranks when there is insufficient height for three readable rows.

Keyboard inspection through the waterfall and history range must pin one shared pass across all three views. Later observations cannot move a pinned selection. Live and Escape resume the latest pass. A pass with missing attention, layer changes, or lens data must show those omissions rather than reuse a prior pass, while independently supplied final probabilities remain visible. A new turn and reset during generation must clear history, selection, and all three views. History is bounded to 256 measured passes, and wider displays expose more of that retained window. These fixture values exist solely inside the intercepted test runtime and never represent real model or GPU measurements.

Thinking and Slow are tested independently: both choices reach the runtime, Thinking is fixed for the current generation, and Slow can change live without restarting inference. Focused composer bounds must keep the input's focus ring clear of Send. Expanded Snake is checked at 800×600, 1440×900, and 3840×2160, where the board must occupy more than 60% of the workspace height. Keyboard checks verify global movement while playing, release on pause or entering chat, and preservation of Tab, selector, and editable keys. Enter sends and Shift+Enter inserts a newline. Back/Forward and tool switching exercise load cancellation and ready-model reuse.

## PR review regressions

The UI fixture also exercises the normalized context-exhaustion boundary. It streams a partial answer and reasoning, emits `finishReason: 'length'`, and rejects with the context-full error that the production adapter exposes. Both partial outputs must remain visible. The recovery action must say **New chat**, reset the loaded runtime without another load or disposal, clear the exhausted conversation, focus the composer, and successfully send a fresh prompt. Adapter unit tests separately verify native streamed-finish handling; this browser fixture does not substitute for those tests.

A second fixture supplies a bounded nine-entry candidate packet: the native top eight plus an actual sampled token at rank ten with probability `0.02`. At three-, five-, and eight-row display budgets, the sample must appear exactly once with its original **2%** probability, alongside the highest-ranked remaining candidates. The top candidate must retain its original probability too. The sampled tail token must not be invented as one of the Final column's top three ranks, even when it genuinely appears in an intermediate lens checkpoint. These values are explicitly synthetic UI regression data, not native inference measurements. Both PR-review regressions passed in Chromium and WebKit against the isolated review worktree. Screenshots under `output/local-assistant/` show the context-full state with expanded reasoning, the successful recovered conversation, and the sampled tail token at all three display budgets.

## Opt-in real model run

This run downloads approximately 1.28 GB unless a local fixture is provided. It requires a hardware WebGPU adapter, WebAssembly JSPI, and a browser that supports the native runtime.

```sh
LOCAL_ASSISTANT_MODEL=.codex-tmp/models/Qwen3.5-2B-Q4_K_M.gguf \
  node scripts/local-assistant-check.js --real
```

`LOCAL_ASSISTANT_MODEL` must be the exact pinned GGUF; the harness checks its byte count and SHA-256 before serving it. The file stays outside the shipped app. A temporary local HTTP server streams it to the browser and Playwright redirects the model request to that server. It does not read the entire model into Node memory or persist model bytes in browser storage. Without this variable, the real run fetches the pinned upstream model normally.

Optional settings:

- `LOCAL_ASSISTANT_CHANNEL=chrome` uses installed Chrome instead of Playwright Chromium.
- `LOCAL_ASSISTANT_HEADED=1` shows the browser.
- `LOCAL_ASSISTANT_REAL_TIMEOUT_MS=900000` sets the load/generation timeout.

The real run loads the unmodified production runtime, disables thinking for a short factual prompt, and verifies that an answer is generated. It writes the answer, load/generation wall times, monotonic byte-progress trace, final byte count, load-time animation-frame gaps, and visible observatory readings to `output/local-assistant/real-cold.json` for upstream downloads or `real-fixture.json` for local-fixture downloads. Separate screenshots show Snake during loading, Snake retained after readiness, and the generated response. The real run also requires six populated attention blocks with finite measured weights, all 24 layer-delta rows, both intermediate lens checkpoints at layers 11 and 19, and populated final candidate bars. It exercises shared history pinning and Live after generation. The response and a separately pinned history screenshot include all three panels; the report records the validated measurements. These readings are actual runtime observations. An unsupported adapter, download failure, model initialization failure, or empty response fails the run. Run it separately from other GPU-heavy model probes to avoid artificial memory pressure.

## Validation recorded for this change

The nine-viewport UI fixture suite passed in Chromium and WebKit, with the final logarithmic-intensity and compact-label build rechecked in WebKit, including linked history selection, missing-data handling, new-turn/reset clearing, automatic chat entry, Snake, and containment within each observatory panel. The earlier production transport/cache, unsupported-browser, and HTTP failure/retry checks also passed in both browsers. WebKit uses a disposable persistent profile for the HTTP-cache probe; viewport checks wait for dynamic viewport units to settle after resizing. Firefox could not launch on this macOS host: ordinary headless, sandbox-disabled diagnostic, and headed attempts failed before opening an application page with sandbox-helper permission and graphics/IPC errors. Firefox results are unverified, not a pass. The same command remains available on a working Firefox installation. The real Chromium probe also passed with the SHA-256-verified local pinned GGUF: six attention blocks, all 24 delta rows, lens checkpoints 11 and 19, and 27 measured passes with successful pin/Live inspection. The actual measurements and response are recorded in `output/local-assistant/real-fixture.json`, with response and pinned-history screenshots beside it. This real run uses the production GPU runtime; the synthetic UI fixture is not inference evidence.
