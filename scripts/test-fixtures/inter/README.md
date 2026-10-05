# Inter browser-test fixture

`inter-latin-500-normal.woff2` and `LICENSE` come from `@fontsource/inter@5.2.8`.
The Index arrow regression serves this unmodified font through Playwright's
Google Fonts routes so blocked, delayed, and swapped font states are repeatable
without external network access. The swap case activates the deferred stylesheet
and holds the actual font request through the brief font-display block period
before capturing fallback, then verifies Inter
loads after release. This fixture is test-only and is not deployed.
