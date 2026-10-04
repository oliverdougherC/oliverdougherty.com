Original prompt: please implement issue 88 on this branch

Issue: https://github.com/oliverdougherC/oliverdougherty.com/issues/88

## Completed scope

- Implemented 04 // Yahtzee vs. Keiri on `feature/keiri-utility`, preserving the hidden VM and lazy utility initialization.
- Integrated the actual Keiri WASM rules and exact table, pinned to upstream `12d7d1bfde0938e90c5656e80feb44babb6a9f3c`. Engine build provenance, binary hashes and refresh procedure remain in `docs/utilities/keiri-engine.md`.
- Added a shared scorecard and compact top dice rack, point-weighted score previews with non-color action cues, saved matches and rivalry record, recoverable engine loading, keyboard/reduced-motion behavior, and complete match results.
- Reset Game abandons the current match and preserves the record without crediting either player. Reset Record has separate confirmation and preserves the game.
- Dice use pooled six-face geometry, restrained pitch/yaw travel, smoothly braked angular motion, and continuous lift/rebound landing. Human rolls last 600–632 ms; Keiri rolls last 300–332 ms with 180 ms hold/score pauses.
- White faces shade under a fixed upper-left light; ground shadows stay anchored outside the rotating cubes. Native transform/opacity animations interpolate at browser refresh cadence without per-frame JavaScript. All motion cancels safely on reset, navigation and destruction.

## Verification and delivery

- Final motion pass: typecheck and 573 unit tests pass, including a human-roll angular-change bound sampled at 120Hz. This is motion-path evidence, not physical display FPS verification.
- Final verification passed: pinned native engine rebuild/hash checks (three native tests), full packaged Chromium Utilities suite, packaged WebKit game suite, production build, quality, deploy smoke and root dependency audit. Independent reviews found no blockers.
- Final compositor trace: callback median 8.3 ms, DrawFrame interval p95 17.2 ms, no steady layout/paint or long tasks. Physical display FPS remains unmeasured; startup maxima can exceed the 8.33 ms budget.
- Implementation and local verification are complete for the branch PR; no production deployment or merge is part of this delivery.
- `docs/utilities/yahtzee-keiri.md` contains current architecture, persistence, lifecycle, test commands, screenshots and qualified performance evidence. Earlier performance captures remain under `output/yahtzee-motion-perf/`; they must not be represented as measurements of this final pass.
- Firefox remains unverified because the local browser failed before navigation across headless, headed and software-renderer launch attempts. Physical 120FPS screen presentation is also unverified.
- Preview: local port 4198. No production deployment or merge requested.
