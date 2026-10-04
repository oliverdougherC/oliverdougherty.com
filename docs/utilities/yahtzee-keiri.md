# Yahtzee vs. Keiri

`#yahtzee-keiri` is the fourth desktop utility. It runs repeated, browser-local
human versus Keiri matches using the BuddyBoardGames ruleset. The human takes the
first turn in every match. There is no remote match service, account, difficulty
selection, or heuristic fallback.

## UI and architecture

`utilities-src/src/yahtzeeController.ts` populates the shell's empty root once.
The shell owns navigation, route history and lazy utility activation.
`css/yahtzee.css` is scoped to `.utility-shell--yahtzee` and loaded with the
controller. One scorecard aligns Keiri values, category names and human values;
a compact dice rack above it changes ownership with the turn. Dice use drawn pips.
Completed matches replace the rack with the winner, final scores and Play Again.

Open human categories become native score buttons when the small rules module can
calculate a legal preview. Their violet background alpha runs linearly from 0.035
at zero points to 0.62 at 50 points, using the absolute base score. A straight is
therefore visibly stronger than a low upper score. Dotted underlines provide a
non-color action cue. Keiri's open values remain empty until commitment. Held dice
have visible `HELD` text and `aria-pressed`; important status changes use a polite
live region. Keyboard rolls and reduced-motion mode settle immediately.

`yahtzeeCore.ts` owns immutable match transitions, unbiased cryptographic dice,
and persistence validation. Scoring, previews, totals and score-sheet validation
cross the Rust rules boundary; TypeScript does not implement a second rules engine
or bot. Category order is Ones through Sixes, Three of a Kind, Four of a Kind,
Full House, Small Straight, Large Straight, Yahtzee, Chance. Dice remain in display
order; the engine adapter maps exact hold decisions back to that order.

The controller accepts a deterministic die source and engine/storage seams for
tests. Production uses `crypto.getRandomValues` with rejection of the four Uint32
outcomes above the largest multiple of six. Keiri receives dice already rolled by
the controller and cannot choose its random outcomes.

## Persistence and reset behavior

One localStorage value, `od.yahtzee-keiri.v1`, contains:

```text
{
  version: 1,
  record: { human, keiri, ties },
  match: {
    human: { scores: [13 nullable integers], yahtzeeBonus },
    keiri: { scores: [13 nullable integers], yahtzeeBonus },
    turn: "human" | "keiri" | "complete",
    dice: [five faces] | [], held: [five booleans], rolls: 0..3
  }
}
```

`yahtzeeBonus` is points (0, 100, 200…), not a count. Recovery validates version,
integer ranges, die faces, held flags, each Rust score sheet, and the two-player
turn sequence. Human and Keiri sheets have equal filled-category counts on human
turns; the human leads by one on Keiri turns. Terminal matches require both full
sheets. Structurally malformed or obsolete storage is discarded immediately,
so rolls and holds in the fresh game survive delayed rules loading. Only a
structurally valid restore candidate awaits Rust semantic validation. While it is
pending, the UI says “Checking saved game…” and disables game and reset controls;
the candidate is neither displayed as a restored match nor overwritten. Navigation
and loading retries remain available. Once the small rules WASM validates it, the
match resumes exactly or a rejected candidate becomes a fresh rivalry with an
explanation. Neither path waits for the exact table. Blocked or
quota-limited storage allows play and displays that progress cannot save.

Human rolls, holds and score commitments persist immediately. Bot animation frames
are presentation only: the durable state remains the beginning of Keiri's turn
until its category commits. Reload or utility reactivation restarts that canonical
turn safely. A final bot score and its record increment are saved in the same
value. Restoring a completed game never increments the record again.

Play Again and Reset Game replace only the match. Reset Game is available mid-turn,
cancels pending animations and bot callbacks, and records no win, loss or tie for
an unfinished game. Reset Record requires a separate inline confirmation and
replaces only the rivalry counters.

## Loading and lifecycle

Activation starts the small rules module and exact worker/table loading in parallel.
Rolling does not await either, and human scoring waits only for the small rules
module. A human score committed before exact readiness persists and waits for Keiri.
The progress bar uses received byte counts when total length is available, otherwise
an indeterminate native progress element. Download, initialization, ready and failed
states remain distinct. Failure exposes Retry without resetting the match. Both
initialization branches settle before retry is allowed, preventing an old attempt's
callbacks from overwriting a newer attempt. The exact engine runs outside the UI
thread.

`utility-deactivate` invalidates the controller generation, clears pending timers,
cancels active Web Animations and drops transient frames. Late decision results
cannot score or mutate hidden UI. Download progress is retained internally while
the utility is hidden; activation renders current state and resumes at most one bot
turn. `pagehide`/`pageshow` apply the same protection across back-forward cache
suspension. `destroy()` removes listeners and the test text hook, releases cached
geometry, invalidates work, and ignores later load results.

## Dice motion and lighting

During a roll, unheld dice temporarily become six-sided CSS cubes with opposite
faces summing to seven. Each starts on its previous visible face and lands on the
already-persisted outcome. Held dice stay in place. Human roll/hold/score controls
wait for settlement. Intermediate orientations never enter saved state or consume
additional random outcomes.

`yahtzeeMotion.ts` supplies one restrained pitch tumble (180–360 degrees), with the
shortest yaw adjustment (at most 180 degrees). Release angular momentum is constant
until 55% of the motion; an integrated smooth braking curve then reaches rest
without a velocity or acceleration jump at brake onset. Squared-sine lift and
rebound meet the ground with continuous vertical velocity. Human rolls last
600–632 ms; Keiri rolls last 300–332 ms, with 180 ms hold/score pauses.

The path is compiled once per roll into numeric transform keyframes. These are
path control points, not rendered frames or an FPS cap: native Web Animations
interpolates at the browser's refresh cadence, with no per-frame JavaScript loop.
Immutable six-face geometry and shade overlays are prepared once and reused from
an off-DOM cache. The controller reads sizes before DOM writes, batches geometry
changes, and starts every track on the same document timeline. Landing, Reset
Game, deactivation and destruction cancel all tracks and detach the cube faces.

All six materials are white. Opacity overlays shade the rotated face normals under
one fixed upper-left light. The camera-facing face ends at zero shade for every
numbered outcome, and moving/resting materials share borders and corner radii.
Lighting keyframes are simplified with a maximum alpha interpolation error of
1/1024, reducing startup work while retaining native interpolation.

Each ground shadow is a sibling of its rotating cube. It broadens and fades with
elevation and shifts slightly away from the light along the ground plane, without
inheriting rotation or upward lift. Its endpoint matches the persistent resting
shadow. Blur stays fixed; only transform and opacity animate. Five unheld dice use
40 native tracks: movement, six face shades, and a ground shadow per die.

## Keiri source and static assets

The upstream engine is pinned to
[`12d7d1bfde0938e90c5656e80feb44babb6a9f3c`](https://github.com/oliverdougherC/Keiri/tree/12d7d1bfde0938e90c5656e80feb44babb6a9f3c).
The shipped `utilities-src/keiri/assets/keiri.wasm` runs upstream rules and
`ExactTableAgent`; `utilities-src/keiri/assets/bbg-anchor-v2.bin` contains the full
1,572,864-value table (schema 2, BuddyBoardGames rules ID 2). Vite emits both as
separate static assets; the table is never embedded in JavaScript or generated in
the browser. The worker validates the table before reporting readiness and returns
errors rather than substituting a weaker agent.

[Keiri engine integration](keiri-engine.md) is the authoritative engine update
procedure. It documents the reproducible source/build relationship, table
provenance and validation, binary hashes and sizes, and WASM/table refresh commands.
The game controller has no engine-generation responsibility.

## Verification

Run from the repository root:

```sh
npm run keiri:build
npm run utilities:check
npm run utilities:build
npm run build:deploy
STATIC_ROOT=dist REQUIRE_DEPLOY_ARTIFACT=1 npm run utilities:browser-check
STATIC_ROOT=dist REQUIRE_DEPLOY_ARTIFACT=1 UTILITIES_BROWSER=webkit npm run yahtzee:browser-check
npm run quality
```

These browser commands start a local server for the packaged `dist/` site. The
release plan runs the focused Yahtzee suite in a separate bounded process for
each browser. Its Chromium legacy Utilities process sets `UTILITIES_SKIP_YAHTZEE=1`
to avoid duplicating game coverage inside the existing five-minute guard; direct
`utilities:browser-check` still includes the game by default.
The core tests cover deterministic complete
matches, legal turn limits, hold preservation, terminal record accounting,
unbiased dice and invalid recovery. Controller/polish tests cover loading and
retry, legal previews, saved progress, unavailable storage, utility switches,
back-forward cache suspension, stale decisions, both resets, roll cancellation,
held-die exclusion, keyboard input and reduced motion. Rust/adapter tests exercise
the actual shipped WASM, rules, table and Joker semantics.

Motion/lighting tests cover every start/end orientation, opposite-face pairing,
continuous velocity, white endpoints, world-light orientation, bounded lighting
approximation, anchored shadows, cached geometry reuse, and less than eight
degrees of combined angular change per 120Hz sample for human rolls. This angular
bound limits visual strobing; it does not measure display frame delivery.

The browser harness can inspect `window.render_game_to_text()`. It returns the
canonical envelope plus `active`, `engine` and an optional transient `botFrame`.
The root exposes `data-turn`, `data-rolls` and `data-engine-state`; controls expose
`data-roll`, `data-die`, `data-score`, `data-retry`, `data-again`, and `data-reset`.
These are observation seams rather than production state mutation APIs. Browser
coverage includes complete/offline play, warm table caching, corrupt/interrupted
loading and retry, reload, route history, keyboard controls, reset races, actual
native motion tracks, material continuity, and layout at 1440×900, 1280×720,
1024×600 and 800×600.

### Final-pass evidence — 2026-10-04

Type checking and all 579 unit tests pass for the current implementation. The pinned
engine rebuild (three native tests and matching binary hashes), production builds,
quality checks, deploy smoke checks, and packaged WebKit game suite pass. The full
packaged Chromium Utilities suite also passes. An independent
review found no blockers in the game, engine boundary, lifecycle or final motion.

Firefox could not launch on this macOS host: headless, headed and software-renderer
attempts failed before navigation with sandbox-extension/framebuffer errors.
Local Firefox runtime coverage remains unverified; this is not a known game incompatibility.
No OS security settings or existing browser profiles were changed.

Representative screenshots:

- [1440×900 playing board](screenshots/yahtzee-1440x900.png)
- [800×600 playing board](screenshots/yahtzee-800x600.png)
- [800×600 completed match](screenshots/yahtzee-result-800x600.png)
- [800×600 rolling dice](screenshots/yahtzee-rolling-800x600.png)

### High-refresh measurement

Run `npm run yahtzee:motion-perf` against the local 4198 preview, setting
`YAHTZEE_PERF_LABEL` to identify the capture and `YAHTZEE_PERF_URL` to select another
local preview. The probe retains raw CDP traces, layer reasons and summaries under
`output/yahtzee-motion-perf/`. It does not force a frame interval. Compare startup
work against the 8.33 ms 120Hz budget separately from steady animation; inspect
compositing failures, style/layout/paint, long tasks and frame cadence.

The final `final-motion` capture recorded a median 8.3ms callback interval and
compositor DrawFrame p95 17.20ms (previous lighting pass: 25.81ms). There was no
steady-motion layout or paint and no long task. Roll-start work was 6.74ms median,
10.46ms maximum; occasional startup overruns exceed the 8.33ms 120Hz budget.
Steady style work was approximately 0.32ms per update. These are instrumented
renderer measurements, not physical screen presentation.

The trace's shade diagnostics decode to Chromium's `kAnimationHasNoVisibleChange`,
not an unsupported transform/opacity failure. The exact-version definition is in
[Chromium 145's compositor animation header](https://chromium.googlesource.com/chromium/src/+/145.0.7632.6/third_party/blink/renderer/core/animation/compositor_animations.h).

The probe's callback sampler and browser polling themselves wake the main thread.
Callback timing and compositor DrawFrame events do not establish physical display
presentation or a measured FPS gain. Physical 120FPS is unverified. A high-refresh
callback cadence must not be reported as a guaranteed screen frame rate; see
[MDN's requestAnimationFrame documentation](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame)
and [Chrome's compositor animation guidance](https://web.dev/articles/animations-and-performance).
