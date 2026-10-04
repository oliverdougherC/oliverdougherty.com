# Local Assistant browser validation

Build the utility bundle first, then run:

```sh
node scripts/local-assistant-check.js
UTILITIES_BROWSER=firefox node scripts/local-assistant-check.js
UTILITIES_BROWSER=webkit node scripts/local-assistant-check.js
```

`runLocalAssistantChecks(browser, baseUrl)` is also called by the general utilities harness. Add `--ui-fixture` to run only the isolated lifecycle/layout checks during UI iteration. `UTILITIES_CHECK_URL` targets an already-running source/deployment preview; otherwise the command starts the standard static server. Screenshots are written under `output/local-assistant/`.

`--transport` runs just the production no-store cache probe, lazy-loading, unsupported-browser, and failed-download/retry checks. `--cache-only` runs the cache probe alone. `runModelCacheCheck(browser)` is exported for reuse.

The cache probe bundles the production `downloadModel` function and serves an eight-byte valid GGUF header with aggressive `Cache-Control: max-age` headers. An independently cacheable control must produce one HTTP request for two reads, proving caching is enabled. Two model loads and a reload must produce three HTTP requests. No Playwright routing is used, since routing would disable the cache and invalidate this test. WebKit uses a temporary persistent profile because its private contexts disable HTTP caching; that profile is removed afterward. Available local/session storage, Cache API, IndexedDB, and OPFS inventories must remain unchanged. Unavailable storage inspection APIs are reported explicitly. This probe validates transport behavior without downloading or claiming inference on model weights.

The default checks exercise the shipped unsupported-browser and HTTP 503/retry paths without downloading weights. The failed-download case supplies a minimal test-only GPU adapter and JSPI presence shim to reach the HTTP failure; it never allocates a model. Loading cancellation, stale callbacks, navigation, keyboard handling, conversation reset, Markdown/MathML, responsive containment, and reduced-motion layout run against a clearly isolated runtime fixture. The fixture replaces only the controller bundle's runtime import through an esbuild plugin and a Playwright response interception. Production controller, session, Snake, and rendering code run unchanged. The viewport fixture supplies **fixed synthetic observations only to test populated layout**, clearly separate from real-run evidence. It is **not evidence of model inference, WebGPU execution, quality, or speed**.

Screenshots cover the ready welcome and long conversation at 1440×900, 1280×720, 1024×600, and 800×600. The page and panels must remain within the viewport; only the transcript is intended to scroll. Keyboard checks cover Snake focus isolation, Enter to send, and Shift+Enter for a newline. Back/Forward and tool switching exercise load cancellation and ready-model reuse.

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

The real run loads the unmodified production runtime, disables thinking for a short factual prompt, and verifies that an answer is generated. It writes the answer, load/generation wall times, monotonic byte-progress trace, final byte count, load-time animation-frame gaps, and visible observatory readings to `output/local-assistant/real-cold.json` for upstream downloads or `real-fixture.json` for local-fixture downloads. Separate screenshots show Snake during loading, Snake retained after readiness, and the generated response. These readings are actual runtime observations. An unsupported adapter, download failure, model initialization failure, or empty response fails the run. Run it separately from other GPU-heavy model probes to avoid artificial memory pressure.

## Validation recorded for this change

Chromium passed the complete cache, unsupported-browser, HTTP failure/retry, lifecycle, and four-viewport fixture suite. WebKit passed the transport/cache checks using its disposable persistent cache profile and the lifecycle/layout fixture suite; viewport checks wait for dynamic viewport units to settle after resizing. Firefox could not launch on this macOS host: ordinary headless, sandbox-disabled diagnostic, and headed attempts failed before opening an application page with sandbox-helper permission and graphics/IPC errors. Firefox results are unverified, not a pass. The same command remains available on a working Firefox installation. Real GPU/model evidence is recorded separately in the real-run reports.
