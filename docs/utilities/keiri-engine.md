# Keiri browser engine

The Yahtzee utility uses the real Rust `ExactTableAgent` with the full
`BuddyBoardGames` anchor table. No gameplay logic or bot heuristic is implemented
in the TypeScript bridge. Gameplay is entirely local after static asset loading.
See [Yahtzee vs. Keiri](yahtzee-keiri.md) for the controller and persistence design.

## Source and table provenance

`utilities-src/keiri/provenance.json` pins Keiri commit
`12d7d1bfde0938e90c5656e80feb44babb6a9f3c` from
[oliverdougherC/Keiri](https://github.com/oliverdougherC/Keiri/tree/12d7d1bfde0938e90c5656e80feb44babb6a9f3c).
The vendored `src/lib.rs` is upstream source with only the checked-in
`wasm-target.patch`: target gates on native filesystem/table-building APIs and
threaded builder types. Rules, state, scoring, table serialization and the exact
solver are unchanged. The reduced dependency manifest contains only the library;
Keiri already has zero dependencies. The adapter also adds no dependencies.
Unused upstream code is removed by release link-time optimization; no browser
runtime filesystem, Playwright, server, random-number or table-building API is
imported into WASM.

The shipped table was copied read-only from the existing production table on
2026-10-03 (America/Los_Angeles). It is the immutable file with SHA-256
`bb8b74b5db24564636e210d5fabe0eb85dab6888ba00f38fb510a2ad140fee65`.
The production release archive `20260913T234143Z-756d07608fa6` has an engine
`src/lib.rs` whose SHA-256 exactly matches the pinned upstream library:
`f71edf48de05c3f4ca49ec8e17a82985bb7f32b190e61bf0f67adc54769e8c53`.
No service or production asset was changed. Independent native and WASM tests
validate the table; all 14 reachable-state layers (0–13 open categories) are
complete. The table was not regenerated as part of this implementation.

Its format is Keiri schema **2**, ruleset id **2** (`BuddyBoardGames`):

| Field | Bytes |
| --- | ---: |
| Magic `KEIRIAT1` | 8 |
| Version, little-endian u32 | 4 |
| Ruleset id | 1 |
| Category indices in `Category::ALL` order | 13 |
| Value count, little-endian u64 | 8 |
| FNV-1a checksum64 over header and values, excluding checksum | 8 |
| 1,572,864 little-endian f64 values | 12,582,912 |

`AnchorValueTable::from_bytes` checks magic, version, ruleset encoding, category
order, value count, exact length and checksum. The adapter additionally requires
BBG and checks `completed_open_layers() == 0..=13`, rejecting checksum-valid
partial tables before creating the exact agent. Unreachable entries may be NaN;
the upstream completeness check validates every reachable anchor state.

## Asset sizes

These are the shipped binary sizes and reproducible cold compression payload
measurements, excluding HTTP headers. Compression measured with Node zlib gzip
level 9 and Brotli quality 11. The deployment was not changed or contacted to
measure a CDN transfer; actual HTTP encoding depends on the static host.

| Asset | Raw bytes | Gzip bytes | Brotli bytes |
| --- | ---: | ---: | ---: |
| `keiri.wasm` | 111,308 | 41,983 | 33,964 |
| `bbg-anchor-v2.bin` | 12,582,954 | 2,490,399 | 2,157,817 |
| Combined cold binary payload | 12,694,262 | 2,532,382 | 2,191,781 |

Vite emits these as hashed static files. Both URLs are declared once in
`keiriEngine.ts` and passed to the worker, avoiding duplicate worker-relative
binary outputs. A warm HTTP cache can reuse the rules WASM for the worker; each
thread still has an independent WASM instance.

## Boundary and loading lifecycle

`loadRules()` only fetches/instantiates the small WASM. It exposes synchronous
`preview`, `score`, `totals` and `validateSheet` calls. The human can roll and score
without waiting for the table. The ABI passes 13 nullable category scores, bonus
**points**, dice and roll count through fixed integer buffers. Rust checks recorded
scores and bonus consistency; TypeScript rejects values that would otherwise be
silently coerced by the integer ABI. Score previews and commits call the upstream
BBG rules. Filled categories are unavailable. BBG Joker behavior is deliberately
upstream behavior: a repeated Yahtzee can earn a bonus, but Joker fixed scores
require the matching upper box to have been filled.

`ExactEngine.load()` starts one module worker and one table fetch. The worker
loads its own WASM instance alongside the table, then initializes and validates
it before reporting `ready`. `decide()` runs `ExactTableAgent::best_decision` off
the UI thread. Keiri sorts dice internally; Rust remaps its hold mask to the
original visible order by matching held face counts. Dice are supplied by the
controller; the engine never generates outcomes.

Progress phases are `download`, `initializing`, `ready`, `failed`. The byte counter
tracks decoded chunks. A known total is shown only for a positive Content-Length
without compression; compressed Content-Length cannot be compared with decoded
chunks, so those responses are honestly indeterminate. Requests abort after two
minutes without response/byte progress; active slow downloads reset the deadline.
404s, interrupted streams, invalid WASM and invalid tables reject initialization.
There is no fallback agent. Repeated load calls share the in-flight promise;
retry creates a fresh worker after failure. Rules loading independently retries
a failed fetch. Disposal terminates the worker and rejects outstanding decisions.
The game controller owns stale-turn invalidation and preserves score sheets on
failure/deactivation.

## Rebuild and refresh

Prerequisites: Rust **1.94.0**, Cargo, Git, Node, and the WASM target. Rust/Cargo
are needed only for engine updates; ordinary site builds consume committed assets.

```sh
rustup target add wasm32-unknown-unknown
npm run keiri:build
```

The build script verifies the patched source hash, reverses the cfg patch in a
temporary directory and verifies the original upstream hash, runs native adapter
validation, builds the WASM library with a locked dependency manifest, and verifies
both asset SHA-256 hashes. Build products stay in `.codex-tmp/keiri-target`.
The build normalizes repository and Rust sysroot paths with `--remap-path-prefix`
to `/keiri` and `/rust`. A fresh independent temporary checkout reproduced the
recorded WASM hash from scratch; the resulting module contains no host username
paths and has no imports. Source line changes can change embedded panic
locations and therefore its hash.

To regenerate the **full** table locally from the pinned source:

```sh
node scripts/build-keiri.mjs --generate-table --write-asset-hashes
```

The native generator calls upstream
`AnchorValueTable::build_limited_with_progress(BuddyBoardGames, 13, ...)`, using
its default dense/threaded builder. Generation is computationally expensive;
this command never contacts or modifies the production service. It prints each
completed layer and verifies all layers before saving. Do not use partial table
checkpoints as shipped assets.

To update upstream deliberately:

1. Fetch and review the new upstream commit, especially rules, schema and exact
   solver changes. Copy its `src/lib.rs`, reapply/update only the target gates,
   and record the new revision, original hash, patched hash and Rust version.
2. Regenerate the table when rules/table schema/solver inputs change, or obtain a
   full table with independently verified source provenance. Preserve the
   category order expected by the game controller.
3. Build with `--write-asset-hashes` after reviewing the source changes. This is an
   explicit provenance refresh, not a way to ignore an unexpected hash mismatch.
4. Run the checks below, remeasure compressed payloads, then rebuild the site so
   Vite hashes and includes the new binary assets. No service deployment is part
   of this update path.

## Verification

```sh
npm run keiri:build
npm run utilities:test -- utilities-src/tests/keiriEngine.test.ts
npm run utilities:check
npm run utilities:build
npm run yahtzee:browser-check
```

The focused TypeScript tests instantiate the actual shipped WASM and table. They
cover BBG scores, bonuses/Jokers, invalid states, original-order hold masks, exact
agent readiness, malformed tables, recovery, HTTP failures, interrupted streams,
compressed progress, inactivity timeout renewal and worker disposal/singleflight.
Native tests independently verify the full table and reject validly checksummed
wrong-ruleset and partial tables. The Rust adapter passes Clippy with warnings
as errors; upstream WASM compilation reports only unused native helper warnings.
The browser suite exercises the packaged worker and binaries rather than a JS
replacement engine. Cross-browser outcome and screenshot evidence belong in the
implementation handoff.
