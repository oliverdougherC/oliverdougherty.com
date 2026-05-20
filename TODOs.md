# Website Code Review TODOs
Generated: Tuesday, May 19, 2026
Updated: Tuesday, May 19, 2026



## Remaining Follow-Ups

- [ ] The Fourier energy-band API still returns a full `bandCount * sampleCount` backing buffer. Temporary allocations were reduced, but eliminating the backing allocation would require a broader worker/controller contract change.
- [ ] The Local Assistant still has duplicated markdown/math rendering logic between the checked-in browser script and the TypeScript testable source. Chat-side compaction duplication was removed, but full consolidation needs a browser-consumable shared build entry.
- [ ] Retro VM and Stress Test controller behavior is still mostly covered indirectly through helper/type tests plus browser checks. Adding jsdom-level controller tests is a larger test-harness task.
- [ ] `npm run utilities:browser-check` still fails on the pre-existing Image Transform assertion that the built-in demo should fetch a precomputed transform asset. This was already present before these fixes and is isolated from the TODO cleanup changes.
- [ ] `npm run format:check` still fails on existing `.playwright-mcp/*.yml` snapshots outside the edited files.
