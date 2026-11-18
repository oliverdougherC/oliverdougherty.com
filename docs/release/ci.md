# CI validation and runtime budget

CI splits into three tiers so routine PR feedback is fast and predictable
(target: the required checks finish in roughly 2–4 minutes excluding queue
delay) while the complete cross-browser suite still gates releases.

**Fast required validation** (every PR and push): security audits and worker
checks, lint/format, TypeScript, unit tests, production builds, source and
deployment smoke checks, local link checks, and a Chromium smoke (`pr:check`)
against the packaged `dist` candidate. These jobs start independently and none
of them installs browsers via apt: browser jobs run inside the official
version-matched `mcr.microsoft.com/playwright:v1.58.2-noble` image, which ships
all three engines and their OS dependencies. Bump the image tag together with
the pinned `playwright` dependency.

**Targeted PR regressions**: `node scripts/ci-select.js` maps changed paths to
release groups as before, then converts the selection into PR *lanes*. Each
Chromium suite runs exactly once, partitioned into parallel lanes sized so no
lane dominates the wall clock (`home`, `gallery`, `utilities-shell`,
`utilities-workloads`, `utilities-games`, `packaged-routes`), the navigation
lane keeps all three engines (it is the shared surface every selection needs),
and an always-on `cross-engine-sweep` lane runs the Firefox/WebKit packaged
route and link-arrow checks — a PR's only cross-engine evidence, and the same
evidence a documentation-only PR gets for free. `createPrPlan()` in
`scripts/release-check.js` is the single registry: it fails closed if a
Chromium suite is missing, duplicated, or renamed out of a lane, so lanes can
never silently lose coverage.

**Full regression suite** (main pushes, nightly at 10:17 UTC, manual
`CI → Run workflow`, and any unsupported event): all six release groups across
Chromium, Firefox and WebKit, exactly as before. This is explicit release
validation; PRs intentionally do not wait for Firefox/WebKit depth on
individual features — that arrives with the nightly and the main-push suite.

## Gates and deployment

`Build` remains the stable required check for branch protection: it requires
the fast jobs and the complete regression matrix (groups on main, lanes on
PRs), judged by `scripts/ci-gate.js`. Malformed, missing, or inconsistent
selection outputs fail the gate; so do cancelled or unexpectedly skipped
dependencies.

Main-branch deployment waits for `Build (deploy gate)` instead, which covers
the fast jobs and the packaged smoke but deliberately does not await the
independent, slow regression matrix — a stalled cross-browser lane cannot block
shipping docs or a home tweak. The deploy gate is still fail-closed: a
regression job that is cancelled, pending, or skipped despite selected lanes
blocks deployment; only unfinished (`in_progress`) or failed matrices do not,
and failures still turn `Build` red on the same commit. Nightly/manual runs
never deploy.

## Selection and failure handling

PR selection uses the full merge-base-to-head diff with NUL-delimited paths and
rename detection disabled, so deletions and both sides of renames count. A
failed diff fails CI; unfamiliar paths broaden to all groups (which on a PR maps
to every lane). The path mapping is deliberately small:

| Changed input | Required groups | PR lanes |
| --- | --- | --- |
| Known documentation only (`docs/`, README, AGENTS, issue/PR templates) | None beyond the always-on checks and packaged smoke | None (no regression job) |
| Home, résumé, home artwork | navigation, home | navigation, home, sweep |
| Gallery and photo data/assets | navigation, gallery, artifact | navigation, gallery, packaged-routes, sweep |
| Utilities source/assets, worker, utility shell/styles | navigation, utilities, artifact, cache | navigation, all utility lanes, packaged-routes, sweep |
| Shared code/styles/fonts, dependencies, build/config/test infrastructure, unknown paths | All | All |

Lanes are derived from the groups by `prLanesForGroups()`, which resolves each
lane's actual check list, so the table can never drift from what runs. Job
summaries list each selection/omission and its reason; `output/release/results.json`
is updated after every completed check and records planned, omitted and unrun
checks (including the lane profile and requested browsers). Evidence artifacts
have unique lane/group names and are retained for 14 days, including failed
runs.

PRs and beta pushes stop a lane at its first failure (`RELEASE_FAIL_FAST=1`);
other selected lanes continue independently to collect evidence. Main pushes,
nightly, and manual runs collect all failures.

`scripts/release-check.js` supports three modes, all validated against one
packaged `dist` candidate with commit- and server-marker checks:

- `RELEASE_LANE=<lane> RELEASE_PROFILE=pr` — one targeted PR lane.
- `RELEASE_LANE=<group> RELEASE_PROFILE=full` — one release group, all browsers
  (what main/nightly shard across runners).
- no lane variables — the historical interface: `RELEASE_BROWSERS` and
  `RELEASE_GROUP` filters for local full-suite work.

## Rollout and measurement

Before this change, a representative PR with selected regressions (run
44253876691) took 26 minutes end to end; the six regression jobs spent roughly
90 combined minutes of runner time, of which 19–20 minutes per job went to
`apt-get install-deps` alone, and one main push (run 44354571095) failed purely
because apt crossed its 25-minute cap. Per-check Chromium totals were
navigation ~32s, home ~102s, gallery ~138s, utilities ~429s, artifact ~43s,
cache ~49s — the old per-group runners duplicated browsers that a single lane
can host. After: PR lanes are bounded near 5 minutes of checks
(`utilities-shell` alone is the largest single suite at ~170s), the required
fast jobs stay ~1 minute, and no browser job touches apt at all. Measured here
as GitHub run/step timings on hosted runners, not local extrapolation.

Narrow PR selections can still miss unrelated cross-engine edge cases until
nightly/main validation; this is an explicit coverage tradeoff, backed by the
always-on sweep and the fail-closed lane registry. Long audio fixtures and
recovery assertions have not been weakened or deleted.

For local diagnosis, build with `npm run utilities:build && npm run build:deploy`,
then run `npm run pr:check` or, for example,
`RELEASE_LANE=gallery RELEASE_PROFILE=pr RELEASE_FAIL_FAST=1 npm run release:check`.
Do not launch multiple lanes simultaneously in one checkout: existing browser
scripts share evidence paths. CI isolation provides separate checkouts.
