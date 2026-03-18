Original prompt: PLEASE IMPLEMENT THIS PLAN: fix projectile re-hit behavior, stacked hazard damage, overlay keyboard handling, and spawn-system rescans; add regression tests and rerun game checks.

- 2026-03-13: Reviewed runtime, collision, spawn, and UI input paths; confirmed existing game tests and typecheck were passing before changes.
- 2026-03-13: Reproduced handbook search input bug in browser: typing `wand test` while help overlay is open resulted in `ntet` because overlay key suppression swallowed `w`, `a`, `d`, `s`, and space.
- 2026-03-13: Implemented projectile per-target hit tracking, stacked enemy hazard accumulation, overlay key handling guards for interactive targets, and cached spawn snapshot accounting.
- 2026-03-13: Added regression tests for projectile re-hit prevention, stacked enemy hazard damage, overlay key suppression, and spawn burst caching.
- 2026-03-13: Verification completed with `npm run game:typecheck`, `npm run game:test`, `npm run game:perf -- --url http://127.0.0.1:5174/ --quick`, the develop-web-game Playwright client, and a direct Playwright check confirming handbook search now accepts `wand h asd`.
- TODO: If future balance work introduces intentional multi-hit projectiles, revisit the per-projectile hit memory to support explicit re-hit windows.
