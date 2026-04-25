Original prompt: Final polish on the Oliver Dougherty landing animation and fix the bundled game when served statically in Firefox/WebStorm.

Updates:
- Found `pages/game/index.html` referenced stale hashed JS/CSS assets that no longer exist in `pages/game/assets`.
- Animation polish target: tighten the optical gap between R and T, then add deliberate letter-boundary construction guides.
- Rebuilt game bundle and changed automatic renderer selection to prefer WebGL on Firefox when renderer settings are otherwise on auto.
- Verified game boot in real Firefox headless and gameplay in the Playwright game client with WebGL.

Remaining notes:
- No known blockers. Run final lint/smoke after the landing screenshot pass.
