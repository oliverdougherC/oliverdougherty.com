# September 2026 reliability work

This page tracks the issue-by-issue changes from the reviewed baseline `d61a1eaef0747dd6b3738b5a7d9fac0cabe71a58`. Each issue has its own pull request so behavior and regression evidence can be reviewed independently. Issue #50 remains a network-correlated incident investigation; passing code checks does not establish its cause.

| Issue | Pull request | Change and primary evidence |
| --- | --- | --- |
| #40 | [#65](https://github.com/oliverdougherC/oliverdougherty.com/pull/65) | Desktop/mobile data deadlines and in-page retry; real-browser held-header/body checks. |
| #41 | [#61](https://github.com/oliverdougherC/oliverdougherty.com/pull/61) | Visible error, empty and no-JavaScript states; browser fault injection before and after intro. |
| #42 | [#66](https://github.com/oliverdougherC/oliverdougherty.com/pull/66) | Per-stage loading/ready/error state, inert early controls and bounded retry/reload recovery. |
| #43 | [#63](https://github.com/oliverdougherC/oliverdougherty.com/pull/63) | Abortable, bounded image-transform asset loading; pending-header/body, Reset, switch and retry checks. |
| #44 | [#62](https://github.com/oliverdougherC/oliverdougherty.com/pull/62) | No blocking main-thread worker fallback; bounded startup, Cancel and recovery checks. |
| #45 | [#58](https://github.com/oliverdougherC/oliverdougherty.com/pull/58) | Optional startup scripts no longer block page parsing; held-request and held-body browser checks. |
| #46 | [#57](https://github.com/oliverdougherC/oliverdougherty.com/pull/57) | Visible responsive artwork baseline and layout-based character enhancement; held-resource checks. |
| #47 | [#64](https://github.com/oliverdougherC/oliverdougherty.com/pull/64) | Résumé BFCache intro restoration; real persisted exits, blocked-script and no-JavaScript checks. |
| #48 | [#54](https://github.com/oliverdougherC/oliverdougherty.com/pull/54) | Native hard-refresh shortcuts preserved; focused regression. |
| #49 | [#59](https://github.com/oliverdougherC/oliverdougherty.com/pull/59) | Reduced-motion heading stays visible through preference changes; real-browser checks. |
| #50 | [#55](https://github.com/oliverdougherC/oliverdougherty.com/pull/55) | Navigation probe and investigation record. Root cause remains unconfirmed without an affected-network trace. |
| #51 | [#60](https://github.com/oliverdougherC/oliverdougherty.com/pull/60) | Removed unused JPEG speculation; modern-format request checks. |
| #52 | [#56](https://github.com/oliverdougherC/oliverdougherty.com/pull/56) | Gallery destination preserved on mobile redirect; source and packaged routing checks. |

## Integration and release review

- Review the issue PRs individually. #48 and #52 should precede #45 because they change the same startup code or gallery head. The gallery PRs touch different behavior in shared files; retain each regression check when merging them.
- The new browser checks add entries to `scripts/release-check.js`. Merge those entries cumulatively rather than replacing the matrix with one issue's version.
- #40, #49 and #51 edit different areas of `js/gallery.js`; #41 and #52 edit the gallery markup. Keep both the loading recovery behavior and the visible status/redirect baseline when resolving those PRs.
- #42, #43 and #44 edit the utility controller or its browser checks. Preserve the per-stage readiness contract, abortable image preparation, and worker failure recovery together. Rebuild the tracked hashed utility assets after the source merge rather than choosing one PR's generated bundle.
- On a combined temporary worktree of all 13 concrete issue PRs, `npm run quality:full` passed 329 tests; `npm run utilities:build`, `npm run build:deploy`, and `npm run smoke:deploy` passed. The packaged Chromium utility suite passed with #42, #43 and #44 merged. All 24 distinct Chromium/WebKit release scenarios passed on combined commit `bcad475`, run in separate browser batches after the local Firefox process stalled before its first test output. Chromium exercised persisted BFCache restoration; the local WebKit engine did not restore a minimal control page, so that capability remains unverified there. PRs #54–#66 passed their individual Linux CI checks, including Firefox in #66's full browser matrix.
- The #43/#44 controller was also verified in a separate combined transform worktree: 299 unit tests, typecheck, source/deploy smoke, Chromium/WebKit packaged asset fault injection, and the packaged utility browser suite passed. Their two PRs have independent generated bundles; rebuild those bundles from the merged source when both are integrated.
- A green release matrix establishes the source and packaged behavior under its browser fixtures. It does not close #50. The controlled university-Wi-Fi → hotspot → university-Wi-Fi comparison and a failing waterfall, or an honest no-longer-reproducible record, remain necessary before an incident conclusion.
