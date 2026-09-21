# Release validation

`npm run utilities:build` generates content-hashed entries, lazy controllers and workers. The source checkout uses a generated `utilities-app.js` preview loader; `npm run build:deploy` rewrites deployment HTML to the matching immutable entry and replaces that preview loader with a migration-only recovery endpoint. Stable pre-hash controller URLs likewise offer an explicit reload action; they do not run a mismatched controller against cached old markup. Regression fixtures preserve the actual reviewed beta HTML and entry bundle (`c7a5075962bc75e8de4630b0352e710cdf3b61df`) and test both cold-entry and cached-entry returning visitors. Classic scripts and styles receive content-derived query versions in deployed HTML, including gallery, mobile and homepage changes. Immutable module URLs are kept exact to avoid duplicate module identities. The retained VM's public WASM names stay unchanged. An already-open page that loses a lazy module receives a visible Reload tools action. Pages opened before this recovery behavior was introduced cannot retroactively gain it.

Run `npm ci`, `npm run lint`, `npm run format:check`, `npm run utilities:check`, `npm run utilities:build`, `npm run smoke:source`, `npm run check-links`, `npm run build:deploy`, `npm run smoke:deploy`, and `CHECK_LINKS_ROOT=dist npm run check-links`. `npm run smoke` requires both source and deployment output; missing `dist` or `CNAME` is an error.

Install the pinned browsers with `npx playwright install --with-deps chromium firefox webkit`, then run `npm run release:check`. Source previews revalidate with `Cache-Control: no-cache`. Release acceptance uses a cacheable artifact server (`public, max-age=600`) so BFCache can be exercised; it never uses `no-store`, which would exclude the page. These are test-server settings, not changes to production configuration. The runner owns a server rooted at `dist`, checks its release marker, verifies that authoring files are not served, collects independent failures, bounds each check, and always shuts down its server. Logs, screenshots and JSON results are in `output/release` and `output/playwright`. Set `RELEASE_BROWSERS=chromium,webkit` only for an explicitly reported partial local run; CI requires all three engines.

Chromium runs the existing home, navigation, mobile, gallery, utilities and stress checks. Firefox and WebKit run navigation, gallery lifecycle and packaged route/utility checks. The two-release cache check rebuilds actual worker/controller/entry graphs, preserves a returning visitor's old cache, removes old origin files and tests explicit reload recovery. Forced resource failures are isolated from ordinary acceptance, where unexpected console errors, page exceptions and missing responses fail the check.

Stress browser tests override reported hardware concurrency to two without changing the product's all-reported-core policy. Bundled Chromium uses SwiftShader for deterministic WebGL checks. Detected software adapters have a 512-pixel/one-pass budget so they cannot starve the compositor; hardware keeps its full adaptive policy. These results are not physical GPU validation. `STRESS_BROWSER_CHANNEL=chrome` selects an installed Chrome for an optional hardware run. Device loss, startup races and delayed GPU completion are covered deterministically in unit/integration tests. Report unavailable WebGPU or unavailable browser engines explicitly; never count them as successful hardware/browser checks.

CI uploads the validated Pages artifact only after release acceptance succeeds. The main-only deployment job consumes that artifact without rebuilding it. Production settings remain unchanged.

## Retained and retired assets

Project animation HTML/CSS/JS and old generators remain authoring references as documented in `docs/home-projects.md`; the deploy copier excludes their assets and runtimes. Gallery originals/variants/metadata, Nighthawks credits, font licenses and retained VM assets remain available. Blog/archive applications remain retired. `404.html` serves the custom error page with explicit navigation; it does not silently redirect unknown URLs to Home.

## Human release and rollback

1. Confirm the PR candidate contains current main, all required CI checks are green, and the release report has no unresolved blockers.
2. Review screenshots and any explicitly unverified physical GPU/browser cases. Merge PR #30 when satisfied.
3. Confirm the main workflow's validated artifact deploys successfully. Check Home, mobile Gallery, Resume and each public utility; verify a returning browser session can recover from an old lazy asset.
4. If regression occurs, revert the release merge through a new PR and let the same validation/deployment gate rebuild the last working sources. Do not force-reset shared history or bypass the artifact gate.

Audio analysis is independent of playback-device unlock. A pending `AudioContext.resume()` cannot block decoding/worker analysis; playback still requires the browser to make audio output available. A deterministic pending-resume regression covers headless/browser-policy behavior.
