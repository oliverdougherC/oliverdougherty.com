# Open Dependabot alerts at PR base 5828f8c (snapshot 2026-10-01)

Source of truth: `gh api --paginate repos/oliverdougherC/oliverdougherty.com/dependabot/alerts?state=open` (raw response preserved in `dependabot-alerts-open-2026-10-01.json`, advisory-description fields stripped; contains no credentials or private configuration).

Totals: 37 alerts = 21 root `package-lock.json` + 16 `utilities-src/vm-src/proxy-worker/package-lock.json`; 21 unique advisories. All alerts are development scope. All 37 are remediated by PR #82; before/after `npm audit` JSON (exit codes 1 -> 0) is in `audits/`.

Re-fetched on 2026-10-01 after branch push: the open-alert set is byte-identical to this snapshot because PR #82 is unmerged, so default-branch lockfiles (and therefore alerts) are unchanged. Default-branch alerts will clear only after merge + rescan.

Note: nanoid (GHSA-28wg-ghj8-5hjv / CVE-2026-67214, GHSA-2v37-7h3g-55p8 / CVE-2026-67213) appears in npm audit output but had no GitHub Dependabot alert; it was fixed in-range via postcss 8.5.28 -> nanoid 3.3.19.
| # | GHSA | CVE | Sev | Package | Manifest | Introduced by | Vulnerable range | Old resolved | New resolved |
|---|---|---|---|---|---|---|---|---|---|
|74|GHSA-w293-vg96-wgc3|CVE-2026-84961|high|undici|root|jsdom|>= 7.24.1, < 7.29.1|7.27.0|7.30.0|
|73|GHSA-w293-vg96-wgc3|CVE-2026-84961|high|undici|worker|wrangler -> miniflare (exact pin)|>= 7.24.1, < 7.29.1|7.24.8|7.30.0|
|72|GHSA-rgj7-g3m4-5g8c|-|high|sharp|worker|wrangler -> miniflare (exact pin)|< 0.35.4|0.34.5|0.35.5|
|71|GHSA-m8rv-5g2x-5cg5|CVE-2026-15157|medium|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.29.0|7.24.8|7.30.0|
|70|GHSA-jr45-8vmc-qm54|CVE-2026-14643|medium|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.29.0|7.24.8|7.30.0|
|69|GHSA-v3r7-h72x-cjcm|CVE-2026-16729|medium|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.29.0|7.24.8|7.30.0|
|68|GHSA-8xcm-r25x-g524|CVE-2026-16728|medium|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.29.0|7.24.8|7.30.0|
|67|GHSA-4cwx-7wf7-3272|CVE-2026-13697|high|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.29.0|7.24.8|7.30.0|
|66|GHSA-f88m-g3jw-g9cj|-|high|sharp|worker|wrangler -> miniflare (exact pin)|< 0.35.0|0.34.5|0.35.5|
|65|GHSA-g8m3-5g58-fq7m|CVE-2026-11525|low|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.28.0|7.24.8|7.30.0|
|64|GHSA-p88m-4jfj-68fv|CVE-2026-9679|medium|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.28.0|7.24.8|7.30.0|
|62|GHSA-hm92-r4w5-c3mj|CVE-2026-6734|high|undici|worker|wrangler -> miniflare (exact pin)|>= 7.23.0, < 7.28.0|7.24.8|7.30.0|
|61|GHSA-35p6-xmwp-9g52|CVE-2026-6733|low|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.28.0|7.24.8|7.30.0|
|60|GHSA-vmh5-mc38-953g|CVE-2026-9697|high|undici|worker|wrangler -> miniflare (exact pin)|>= 7.23.0, < 7.28.0|7.24.8|7.30.0|
|59|GHSA-pr7r-676h-xcf6|CVE-2026-9678|medium|undici|worker|wrangler -> miniflare (exact pin)|>= 7.0.0, < 7.28.0|7.24.8|7.30.0|
|58|GHSA-96hv-2xvq-fx4p|CVE-2026-48779|high|ws|worker|wrangler -> miniflare (exact pin)|>= 8.0.0, < 8.21.0|8.20.1|8.21.0|
|57|GHSA-g7r4-m6w7-qqqr|-|low|esbuild|worker|wrangler (exact pin)|>= 0.27.3, < 0.28.1|0.27.3|0.28.1|
|55|GHSA-82fw-gwwq-j7x9|CVE-2026-84373|medium|vitest|root|direct devDependency|>= 2.1.0, < 4.1.11|4.1.8|4.1.11|
|52|GHSA-rgj7-g3m4-5g8c|-|high|sharp|root|direct devDependency|< 0.35.4|0.33.5|0.35.5|
|51|GHSA-82fw-gwwq-j7x9|CVE-2026-84373|medium|@vitest/mocker|root|vitest|>= 2.1.0, < 4.1.11|4.1.8|4.1.11|
|49|GHSA-fxqj-rqcc-2cmp|CVE-2026-69153|medium|postcss|root|vite|<= 8.5.22|8.5.15|8.5.28|
|46|GHSA-m8rv-5g2x-5cg5|CVE-2026-15157|medium|undici|root|jsdom|>= 7.0.0, < 7.29.0|7.27.0|7.30.0|
|45|GHSA-jr45-8vmc-qm54|CVE-2026-14643|medium|undici|root|jsdom|>= 7.0.0, < 7.29.0|7.27.0|7.30.0|
|44|GHSA-v3r7-h72x-cjcm|CVE-2026-16729|medium|undici|root|jsdom|>= 7.0.0, < 7.29.0|7.27.0|7.30.0|
|43|GHSA-8xcm-r25x-g524|CVE-2026-16728|medium|undici|root|jsdom|>= 7.0.0, < 7.29.0|7.27.0|7.30.0|
|42|GHSA-4cwx-7wf7-3272|CVE-2026-13697|high|undici|root|jsdom|>= 7.0.0, < 7.29.0|7.27.0|7.30.0|
|36|GHSA-r28c-9q8g-f849|CVE-2026-73646|high|postcss|root|vite|<= 8.5.17|8.5.15|8.5.28|
|33|GHSA-f88m-g3jw-g9cj|-|high|sharp|root|direct devDependency|< 0.35.0|0.33.5|0.35.5|
|31|GHSA-g8m3-5g58-fq7m|CVE-2026-11525|low|undici|root|jsdom|>= 7.0.0, < 7.28.0|7.27.0|7.30.0|
|29|GHSA-p88m-4jfj-68fv|CVE-2026-9679|medium|undici|root|jsdom|>= 7.0.0, < 7.28.0|7.27.0|7.30.0|
|28|GHSA-35p6-xmwp-9g52|CVE-2026-6733|low|undici|root|jsdom|>= 7.0.0, < 7.28.0|7.27.0|7.30.0|
|23|GHSA-hm92-r4w5-c3mj|CVE-2026-6734|high|undici|root|jsdom|>= 7.23.0, < 7.28.0|7.27.0|7.30.0|
|20|GHSA-v6wh-96g9-6wx3|CVE-2026-53632|medium|vite|root|direct devDependency|>= 7.0.0, <= 7.3.4|7.3.3|7.3.6|
|19|GHSA-pr7r-676h-xcf6|CVE-2026-9678|medium|undici|root|jsdom|>= 7.0.0, < 7.28.0|7.27.0|7.30.0|
|17|GHSA-vmh5-mc38-953g|CVE-2026-9697|high|undici|root|jsdom|>= 7.23.0, < 7.28.0|7.27.0|7.30.0|
|14|GHSA-fx2h-pf6j-xcff|CVE-2026-53571|high|vite|root|direct devDependency|>= 7.0.0, <= 7.3.4|7.3.3|7.3.6|
|11|GHSA-g7r4-m6w7-qqqr|-|low|esbuild|root|vite|>= 0.27.3, < 0.28.1|0.27.7|0.28.2|
