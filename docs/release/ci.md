# CI validation and runtime budget

Every PR still runs security audits and worker checks, lint/format, TypeScript,
unit tests, production builds, source/deployment smoke checks, local link checks,
and a Chromium smoke against the packaged `dist` candidate. These jobs start
independently. The `Build` check remains the final gate and requires all of them
plus the selected regression matrix to succeed. Only an explicitly empty
selection may skip that matrix. No workflow-level path filter is used.

## Browser coverage

`npm run pr:check` owns an ephemeral server rooted at `dist`. It verifies the
artifact marker and commit, excludes source/authoring files, visits desktop and
mobile routes, follows real navigation, loads gallery images and initializes
three lazy utilities. It fails on unexpected browser errors or missing assets.
It does not generate transforms, analyze songs or run CPU stress workloads.
Results and failure screenshots/traces go to `output/pr`.

`npm run release:check` remains exhaustive by default: all 44 previous checks
plus the three-engine homepage reveal check previously run separately. CI sets
`RELEASE_GROUP` to partition that coverage across six independent runners:

| Group | Coverage |
| --- | --- |
| navigation | Navigation overlay/stability, optional startup, storage, mobile routes |
| home | Homepage stage/reveal in three engines, full Chromium home and résumé lifecycle |
| gallery | Release lifecycle, heading, prefetch, transitions, status, dropdown/data |
| utilities | Full utility workloads, transform preparation, stress and cross-engine pools |
| artifact | Three-engine packaged routes, worker output, missing assets and cache recovery |
| cache | Two actual builds, stale modules/workers and release migration |

Checks remain serial within each runner to avoid competing render/CPU stress
loads. Each group builds its own candidate from the same checkout: building
costs seconds while transferring the entire roughly 580 MB artifact costs more.
The Pages artifact is uploaded only on a main push and deployment waits for
`Build`. The fast job and all groups enforce the candidate commit and server
artifact identity; they never validate the source tree as the deployed site.

## Selection and failure handling

`node scripts/ci-select.js` consumes the GitHub event. PR selection uses the full
merge-base-to-head diff with NUL-delimited paths and rename detection disabled,
so deletions and both sides of renames count. A failed diff fails CI; unfamiliar
paths broaden to all groups. The mapping is deliberately small:

| Changed input | Required groups |
| --- | --- |
| Known documentation only (`docs/`, README, AGENTS, issue/PR templates) | None beyond the always-on checks and packaged smoke |
| Home, résumé, home artwork | navigation, home |
| Gallery and photo data/assets | navigation, gallery, artifact |
| Utilities source/assets, worker, utility shell/styles | navigation, utilities, artifact, cache |
| Shared code/styles/fonts, dependencies, build/config/test infrastructure, unknown paths | All |

The exact allowlists live in `scripts/ci-select.js` and have regression tests.
New paths default to all groups until their dependencies are understood. Job
summaries list each selection/omission and its reason, smoke timings and release
checks sorted by duration. `output/release/results.json` is updated after every
completed check and records planned, omitted and unrun checks. Evidence artifacts
have unique group names and are retained for 14 days, including failed runs.

PRs and beta pushes stop a group's checks at its first failure. Other selected
groups continue independently to collect evidence. Main pushes, nightly runs
(10:17 UTC), and manual **CI → Run workflow** runs select every group and collect
all failures. Nightly/manual runs cannot deploy.

## Rollout and measurement

Before this change, the successful October 2 PR run 37070690459 took about
23 minutes: the serial release step took 19m26s, with another 1m15s for the
homepage reveal. The initial local packaged smoke took about 1.4s; that is only
the browser workload, not a hosted CI duration. The target for documentation-only
PRs is 60–90s excluding queue delays. Feature changes deliberately take longer;
utility workloads remain the heaviest group. Use actual GitHub run/step timings
rather than extrapolating local timings to a hosted-runner speedup.

This rollout retains exhaustive pre-deployment validation, now sharded, while
selection and smoke behavior gain production history. Narrow PR selections can
miss unrelated edge cases until nightly/pre-deployment validation; this is an
explicit coverage tradeoff. After observing representative runs and reliable
selection, consider applying the same selection to main pushes. Long audio
fixtures and recovery assertions have not been weakened or deleted here.

For local diagnosis, build with `npm run utilities:build && npm run build:deploy`,
then run `npm run pr:check` or, for example,
`RELEASE_GROUP=gallery RELEASE_FAIL_FAST=1 npm run release:check`.
Do not launch multiple release groups simultaneously in one checkout: existing
browser scripts share evidence paths. CI isolation provides separate checkouts.
