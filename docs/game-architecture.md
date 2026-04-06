# Game architecture

## Source-of-truth boundary

- `game-src/` is the editable game project.
- `pages/game/` is the generated, shipped build output.
- `config/vite.game.mts` points Vite at `game-src/` and emits into `pages/game/`.
- `config/vitest.game.mts` and `config/tsconfig.game.json` define the game test/typecheck surface.

## Commands

```bash
npm run game:dev
npm run game:typecheck
npm run game:test
npm run game:check
npm run game:build
npm run smoke
```

## Code layout

- `game-src/src/main.ts`: top-level bootstrapping, DOM wiring, settings UI, loop integration, and test hooks.
- `game-src/src/core/`: fixed-step loop, world state, and progression/runtime coordination primitives.
- `game-src/src/systems/`: gameplay systems updated each tick.
- `game-src/src/render/`: renderer, lighting, biome composition, atlases, and shaders.
- `game-src/src/runtime/`: runtime option parsing, settings persistence, and restart/input policy helpers.
- `game-src/src/data/`: authored gameplay data tables and handbook content.
- `game-src/tests/`: regression and behavior tests for runtime systems, data integrity, and rendering-adjacent logic.

## Runtime data map

These paths actively drive runtime gameplay:

- `src/core/world.ts`
- `src/systems/runtimeSystem.ts`
- `src/systems/spawnSystem.ts`
- `src/systems/levelSystem.ts`
- `src/systems/collisionSystem.ts`
- `src/systems/autoAttackSystem.ts`
- `src/data/director.ts`
- `src/data/enemies.ts`
- `src/data/weapons.ts`
- `src/data/catalysts.ts`
- `src/data/evolutions.ts`
- `src/data/events.ts`

These paths are legacy/test-oriented rather than part of the live runtime loop:

- `src/data/waves.ts`
- `src/systems/spawnPlanner.ts`

Notes:

- Live enemy spawning is controlled by `spawnSystem` + `director` + `enemies`, not `waves.ts`.
- `src/core/progression.ts` is runtime-critical because `world.ts` uses its level thresholds.
- `src/core/metaProgression.ts` stays behind the `forestArcana.meta.enabled.v1` storage gate until it is intentionally reintroduced into the run loop.

If `waves.ts` or `spawnPlanner.ts` become live gameplay dependencies again, update this document and add integration coverage so runtime/test data paths do not drift apart.

## Maintenance notes

- Favor mechanical cleanup over gameplay rewrites unless the task explicitly calls for behavior changes.
- Because `main.ts` coordinates a large amount of DOM/runtime glue, keep refactors incremental and verification-heavy.
- Rebuild `pages/game/` after source changes; do not patch the generated bundles directly.
- For deploy readiness, pair `npm run game:check` with `npm run smoke` so the shipped game page is validated, not just the source project.
