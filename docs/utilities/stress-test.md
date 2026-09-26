# Stress Test

The utility runs sustained CPU prime searches and an interactive GPU sculpture, separately or together. Start explicitly begins the workload; Stop, leaving the utility, hiding the page, or disposing the controller ends it.

## CPU prime search

Every searched integer is tested in a module worker. The main thread creates the
workers, tells each one which lane of the number line it owns, and aggregates what
comes back; it runs no search itself, allocates no work during the run, and stops the
pool by termination alone.

### How many workers run

One long-lived worker per logical processor the browser will account for. The page
reads the report, validates it, creates exactly that many workers, and changes the
pool by nothing except Stop: no growth, no shrink, no processor held back for the
main thread (the main thread is kept light instead), and no simultaneous-multithreading
multiplier — an "always 2×" rule is a guess about hardware, and a pool that sizes
itself on a measurement is a pool that can stop early.

#### Reading the report in both scopes

`navigator.hardwareConcurrency` is a hint, not a measurement: privacy modes round it
down to physical cores, and fingerprint protection replaces it outright (historically
Firefox capped the value at 16 via `dom.maxHardwareConcurrency` until Firefox 139
raised the default to 128). The value is therefore read in both scopes a static page
can reach — the window, and a dedicated worker — and the pool is sized from the
larger of the two valid reports, because they are the same API asked the same
question. The pool size is whatever a `navigator.hardwareConcurrency` call actually
returned.

This exists because of a measured case. On a 32-thread host (AMD Ryzen 9 7950X,
`Win32_Processor.NumberOfLogicalProcessors = 32`, `os.availableParallelism() = 32`),
the Helium browser (Chromium 154) reported **12, 14 or 16** logical processors in
window scope — varying from launch to launch, consistent with anti-fingerprint
randomisation — while a dedicated worker created by that same browser reported **32**
every time. Reproduced with a fresh temporary profile and with a copy of the real
profile of the user who reported the bug; the browser's own history confirmed the
pages tested. Playwright Chromium, installed Google Chrome and Playwright Firefox all
reported 32 in both scopes.

So the 12 the page started with was not arithmetic in this repository's code, not a
clamp in a test or check script, not the browser-launch harness, and not a stale
bundle: the browser answered a different question in window scope, and the true count
was reachable in worker scope the whole time. Taking the worker's answer is not a
12-to-32 conversion — there is no arithmetic applied to the page's number, no
host-specific table, and no timing heuristic. Both readings are published
(`data-stress-cpu-report-page`, `data-stress-cpu-report-worker`) so which one the pool
used, and what the browser actually said, are visible on the page.

A browser that reduces *both* scopes is a boundary this page cannot cross, and it is
stated rather than patched: a static page in a browser that exposes no OS-query API
cannot know its own runtime is lying about the window scope and the worker scope
alike. Such a browser gets the reduced pool, and the published report shows the
reduced number instead of a plausible one.

The worker-scope count is read by a one-shot report probe: a dedicated module worker
whose entire script posts the number and stops, asked at the same moment as the pool's
first worker, and the first answer wins within a bounded wait
(`CPU_POOL_REPORT_TIMEOUT_MS`, 2 s). The probe exists because this measurement has to
be fast as well as correct. On the browser above, the workload worker *did* report 32 —
but only after the bounded wait had already sized the pool from the window number, so
the page built the reduced pool the user reported while the true count arrived a moment
too late to be used. A worker with nothing to import answers in milliseconds instead.
The probe is not part of the workload: it computes nothing, it is terminated as the plan
is made, and it is never counted as a pool worker (`data-stress-worker-count` counts
workers that were given a lane). A browser that blocks blob workers leaves the probe
silent, and the page then sizes from the workload worker's answer or from the window
scope, as it would anyway.

#### What the plan does, and what it refuses

| Input | Pool | `data-stress-cpu-pool-source` |
|-------|------|-------------------------------|
| page 32, worker 32 | 32 | `report` |
| page 12, worker 32 | 32 | `report` |
| page 24, worker 8 | 24 | `report` |
| any report, `__OD_STRESS_TEST_WORKERS__ = 32` | 32 | `exact` |
| nothing usable | 4 (`CPU_POOL_FALLBACK_WORKERS`) | `fallback` |

A report is used only if it is a positive safe integer at or below
`CPU_POOL_TRUSTED_REPORT_MAX` (4096). A "report" above that is not hardware, and
honouring it literally would mean creating millions of workers, so it is discarded and
the run says it has no usable report. Nothing clamps a legitimate high count to a
historical limit: a browser that honestly reports 128 logical processors gets 128
workers, and one that reports 4 gets 4.

When neither scope reports anything, the run starts the documented fallback pool of 4
workers and publishes `data-stress-cpu-report = 0` with source `fallback`. A fallback
is never presented as a processor count.

Worker creation can genuinely fail (quota, memory pressure). The workers that did get
created keep computing, `data-stress-cpu-pool-limitation` says how many are running
and why, the summary line reads `CPU · 3 workers (3 of 4 requested)`, and the run is
not described as the pool that was asked for. A pool with no workers is an error: the
run ends in `error` with the failure message, and in combined mode the GPU keeps
running while the CPU workload says it died.

A worker that faults is replaced once at its own lane, so the pool keeps the count it
requested and never exceeds it. Replacement is bounded per run
(`CPU_POOL_MAX_REPLACEMENTS`, 8): a worker script that dies as it loads cannot be
chased with an endless stream of new workers, and when the budget runs out the
shortfall is published rather than hidden.

`window.__OD_STRESS_TEST_WORKERS__ = N` is the exact-count diagnostic hook: it requests
precisely N workers, takes precedence over both reports, may exceed them, and enables
nothing adaptive — there is nothing left for it to enable. A value that is not a usable
processor count is ignored, and the published source says `report` rather than
pretending the hook was honoured. The former
`__OD_STRESS_TEST_MAX_WORKERS__` ceiling is gone with the growth policy it capped.

**Why the pool no longer resizes.** Two adaptive policies were built, measured, and
removed. Growing on aggregate throughput under-loaded the machine it was given: on
this 32-thread host a pool pinned from 4 to 128 workers moved the *aggregate*
candidate rate by under +18% (889 M/s at 4, 1,063 M/s at 32, 1,106 M/s at 48) while
operating-system load went from 25% to 100%, because a bigger pool buys processors,
not a cheaper sieve. A previous design grew on the share of compute slices that were
demonstrably descheduled mid-slice; that share measured 0% up to the thread count, 1%
at twice it, 25% at three times and 100% at eight times, and the duty-cycle alternative
read a flat 100% from 4 workers to 256 — on this browser and OS a worker whose slice ends is handed a processor again immediately, so the queueing the page
wanted to measure never happens. Both rules therefore landed anywhere between 6 and
128 workers on identical runs of the same build, which is the failure the user saw.
Pinned counts measured against the operating system on this host, with the self-pacing
loop that existed then (that sweep ran on an earlier build of this branch, so its
candidate-rate column is not comparable to the loop described below; the load column is
what the point of the table is):

| workers | OS CPU (all 32 logical CPUs) | aggregate candidates/s | candidate rate per worker |
|--------:|--------------------------:|-----------------------:|--------------------------:|
| 4 | 25% | 889 M | 222 M |
| 14 | 56% | 795 M | 57 M |
| 32 | 100% | 1,063 M | 33 M |
| 48 | 100% | 1,106 M | 23 M |
| 128 | 100% | 1,046 M | 8 M |

That table is the reason a count, not a measurement, is the right control: from 32
workers up the machine is fully loaded, and past it the extra workers only cost sieve
throughput. The pool now asks the browser for the count once, at the start, and never
reconsiders — which is also the only behaviour that can be described as "exactly N
workers" and checked by a test.

With the fixed pool and the self-driven worker loop, the same host measured by
`scripts/stress-load-harness.js`: the page driving real workers while the operating
system's own per-logical-processor counters are sampled outside the browser.

| run | window report | worker report | pool | OS CPU (mean of `_Total`) | idle logical CPUs | candidates/s |
|-----|--------------:|--------------:|-----:|--------------------------:|:------------------|-------------:|
| Chromium, CPU-only, nothing modified | 32 | 32 | 32 | 100.0% | none | 2,622 M |
| Chromium, CPU-only, exact request of 32 | 32 | — | 32 (exact) | 100.0% | none | 2,609 M |
| Chromium, CPU-only, window scope mocked to 12 | 12 | 32 | 32 | 100.0% | none | 2,621 M |
| Chromium, combined mode, visuals on | 32 | 32 | 32 | 100.0% | none | 2,551 M |
| The reported browser, CPU-only, nothing modified | 16 | 32 | 32 | 100.0% | none | 2,655 M |
| The reported browser, combined mode, visuals on | 14 | 32 | 32 | 100.0% | none | 2,635 M |
| Installed Google Chrome, combined mode, visuals on | 32 | 32 | 32 | 100.0% | none | 2,632 M |

Every run held its 32 workers for its whole duration — the pool dataset was published
once and never changed — had the whole pool live 410–450 ms after Start, and released the
machine on Stop (3.5% CPU measured from four seconds after a Stop clicked mid-run). In
combined mode the visual lane kept its own rate (108 batches/s on the WebGL2 lane, 52/s
on the WebGPU lane, which differ in GPU cost rather than in anything the sieve gives up)
with at most one callback gap in 22 seconds, so the main thread stayed free to accept a
Stop at any moment.

The same harness measured the previous build with its pool pinned to exactly 32 workers,
with identical browser flags: 100.0% load, all 32 processors at 100%, 1,902 M candidates/s
against the 2,622 M above — so the old worker loop was not failing to saturate the
machine once it was given the right count; the sizing was the whole failure. The
self-driven loop adds about 38% more sieve work at that same load, and the reason to
prefer it is not the number but what it
no longer depends on: no main-thread range supply, no message round trip per block, and
no pacing timer of any kind between a worker and its next block.

The published datasets are what make a run auditable:

| Dataset | What it measures |
|---------|------------------|
| `data-stress-cpu-report-page` | `navigator.hardwareConcurrency` in window scope (0 = nothing usable) |
| `data-stress-cpu-report-worker` | the same API as read inside a dedicated worker (0 = no worker answered in time) |
| `data-stress-cpu-report` | the count the pool was sized from |
| `data-stress-cpu-pool-size` | the worker count the run asked for |
| `data-stress-cpu-pool-source` | `exact` / `report` / `fallback` |
| `data-stress-cpu-pool-limitation` | present only when the running pool is short of the request, with the reason |
| `data-stress-cpu-blocks` | blocks of the number line searched across the pool; a stalled lane is one lagging number |
| `data-stress-worker-count` | workers actually running, decremented on every removal |

`scripts/stress-test-check.js` asserts the plan end to end against real workers —
report, pool size, source, the count actually constructed, one activity bar per
worker, and the exact-count hook overriding a mocked report — and
`scripts/stress-load-harness.js` (development only, never shipped) drives that real
page and real workers while sampling operating-system per-logical-CPU counters, with
`--workers=N` for the exact-count hook and `--report=N` to mock the window-scope hint
so an under-reporting browser can be tested on a machine that reports correctly.

Each worker runs an odd-only segmented sieve of Eratosthenes using a reused 32 KiB
marking buffer. Base primes are cached and extended geometrically with a separate
segmented sieve, together with their reciprocals: the hot `low % prime` scan uses
Barrett reduction with a correction loop, which stays exact integer arithmetic
even past the small-integer range, where the native floating remainder operator
costs several times more and would collapse throughput at the 2^31 frontier.
There is no repeated trial division or artificial CPU busy work.

Work is divided by position rather than handed out: lane `i` of a pool of N workers
sieves blocks `i`, `i + N`, `i + 2N` … of a tiling of `2^31` consecutive integers, and
each worker derives the next block itself. Blocks are contiguous and disjoint, so the
ranges the workers report cover a contiguous stretch of the number line with no gaps
and no overlap, nothing has to be bookkept to prove it, two workers can never sieve
the same integer, and a replacement worker resumes the lane its predecessor owned.
Requesting a block that would leave the safe-integer range is a reported failure rather
than a wrap-around. The search starts at 1 (rejected), and the number 2 is counted
exactly once — by the single block that contains it.

A worker computes in a plain loop: sieve a segment, take the next segment, take the
next block when the block is drained. Nothing in that loop waits on the main thread, a
timer, a MessageChannel yield, or the display refresh rate, and it allocates nothing
per iteration; the only thing leaving the worker is a cumulative progress message
throttled to about 250ms per worker. That replaced an 8ms MessageChannel chunk yield
with a main-thread band allocator, which was the design where CPU work could stall on
the page — the review kept it only if it earned its cost, and it did not: a
self-driving worker needs no range replenishment, and one message per worker per
quarter-second keeps the main thread free for Stop and for GPU submission. Run IDs and
worker indices reject messages from a superseded run and from a record already
stopped. Stopping is `terminate()` — a worker is never asked to stop politely and
expected to acknowledge, so no stop path can be ignored, and a worker deep in the
compute loop can be torn down at any moment. Abandoning the ranges a worker had not
reached is expected; the search is a stress workload, not a proof.

The large display is the largest prime any worker actually reported. It is not a
claim that every smaller block has finished: blocks run in parallel and the widest
one is still being searched. "Candidates tested" counts odd sieve candidates plus
2, while the found count reports actual primes; nothing is interpolated or
extrapolated. Each worker bar reports that worker's own cumulative candidates, the
low end of the region it is currently sieving, and how many blocks it has taken. Stop
preserves the result, and a new run resets it. Worker bars and candidate counts are
throughput readings, not OS utilization — a page cannot read utilization counters,
which is exactly why `scripts/stress-load-harness.js` samples them from outside the
browser.

The summary's `candidates/s` reading is a moving average intended for comparing
CPU throughput across machines: actual cumulative candidates tested divided by
the actual elapsed time over the trailing 5,000 ms window, with the window edge
linearly interpolated between the two actual samples that bracket it. Because
progress is throttled to about 250ms, a single-tick delta would report delivery
jitter instead of throughput; the fixed interpolated window keeps the window length
constant and lets a stalled CPU decay out of the average smoothly. Nothing is
reported until the measured span reaches 1,000ms, and worker startup leaves the window
once a run is 5 seconds old. The integer is also exposed as
`data-stress-candidates-per-second` for automated comparison. It measures
delivered actual work in the browser, so thermals, browser scheduling and
competing applications affect it like any whole-machine benchmark. Actual
throughput naturally falls as the consecutive search moves to ranges where
segments are marked by more base primes, so cross-machine comparisons read the
average at equal elapsed time within a run rather than at an arbitrary moment.

### Local performance check

Run `node scripts/stress-prime-bench.js` from the repository root. This compares the
previous production trial-division algorithm with the current sieve over 1–10,000,000
in the same Node/V8 realm. Both must produce 664,579 primes and largest prime 9,999,991.
Each sieve sample starts with an empty base-prime cache. Three warmed samples are
recorded in `output/stress-bench/prime-comparison.json`. The measured local medians
were approximately 419ms versus 10.5ms (40×), single-thread algorithm time only; worker
startup, browser messaging and whole-machine utilization are excluded.

The algorithm follows the standard [cache-sized segmented sieve approach](https://github.com/kimwalisch/primesieve/blob/master/doc/ALGORITHMS.md), without adding a dependency.

## Presentation

The output uses the same white/paper surface and violet accents as the workbench.
The CPU result is right-aligned, black, weight-800 JetBrains Mono. Its right edge
stays fixed as digits change; container dimensions and digit count determine a
large font size that still fits short windows. CPU-only mode gives it the output
width. Combined mode puts the GPU scene on the left and the prime result on the
right, separated by a fine rule. Worker bars are actual activity readings rather
than decorative light trails. No explanatory tooltips are added.

## GPU scene and workload

The GPU renders a lit, raymarched lattice in violet and graphite on a light background. The scene geometry, raymarching, adaptive load and compute workload are preserved across the WGSL and GLSL palette changes. Move the pointer over the scene to orbit it. Reduced-motion preferences freeze automatic motion while the workload continues.

There is no intensity selector. Start always runs the sustained-load pipeline.
The engine requests a high-performance adapter and tries WebGPU, WebGL2, then WebGL1.
A browser chooses the adapter; this does not enumerate or load every installed GPU.
Backend setup failures use a fresh canvas before attempting another context type.

WebGPU combines rendering with storage-buffer compute, with distinct invocations
owning distinct entries. It starts at 1,024 workgroups and maintains up to two batches
in flight, replenishing directly from actual queue-completion callbacks without a
refresh-rate or completion-to-timer gap. Batch sizing adapts from completed queue
latency to keep work continuous and bounded. This is scheduling feedback, not a GPU
utilization measurement. Memory, dispatch sizes and work in flight remain bounded
by device limits and workload limits. While a GPU backend is starting or rendering,
it owns the canvas backing store exclusively: the controller's resize observer and
window-resize handler never write its dimensions, and the backend only resizes after
its queued batches drain. Ownership returns to the controller on stop, fallback, or
failure.

WebGL2 similarly keeps up to two asynchronously fenced batches in flight. WebGL1
has no asynchronous fence: it completes a batch with `finish()` and schedules the
next through MessageChannel, avoiding a refresh-rate cap or nested-timer delay.
Reduced motion freezes the sculpture's movement without reducing the compute load.
Stopping, hiding, navigating away, loss, errors and cancellation release resources
and prevent further submissions. Device loss or an async error that arrives before
the factory hands back its handle aborts that startup instead of being installed
and reported as running: GPU-only mode ends in an honest error state with the
failure message, and combined mode keeps the CPU workers running with the failure
reported in the status line. No CPU busy loop supplements GPU-only mode.

Adapter and workload information appears in the scene footer. The six readings below it report elapsed time, active CPU workers, GPU backend, render-callback rate, callback gaps, and tested CPU candidates. The rate card is labeled by its actual source: `GPU batches/s` while a GPU backend is installed, `Visual callbacks/s` for the CPU visual frames. The `Gaps >34 ms` card counts callback gaps over that explicit threshold, independently of display refresh rate. Rate and gap samples restart when the source switches between GPU and CPU visuals; rates use callbacks per second since that source began, with a one-second minimum sampling window. These are not measurements of dropped display presentations, and neither rate nor gaps is a GPU benchmark, utilization, or power measurement. Worker bars, primes, and candidate counts remain tied to actual worker messages.

## Limits

A browser cannot guarantee 100% CPU utilization, select every installed GPU, or set/read GPU board power. A 600 W draw on a particular card must be verified with external hardware monitoring on that machine. Thermal throttling, browser scheduling, power settings, and competing applications affect results. This tool does not change GPU power limits or overclock settings.

The worker pool inherits the same limits, and the ones that matter here are about the
count rather than the work:

- The pool is only as large as the browser admits. A browser that reduces
  `navigator.hardwareConcurrency` in *both* window and worker scope yields the reduced
  pool, because a static page cannot query the operating system and no arithmetic
  correction is applied to a wrong number. The measured Helium case is fixed — the
  true count is available in worker scope, so the pool gets 32 there — but this is a
  statement about reading the same API in a scope that answers truthfully, not about
  overcoming a browser that hides the count everywhere.
- Over-reporting is equally uncorrected, and now deliberately so: a browser that
  claims more logical processors than exist gets that many workers, which costs sieve
  throughput (about 12% at four times the thread count on the host above) and no load. The
  page does not second-guess the report in either direction.
- A pool cannot be observed to be loaded from inside the page. Worker counts,
  candidates per second and per-lane block counts show that N workers are computing and
  how fast; whether the operating system handed all N of them a processor is only
  visible outside the browser, which is what `scripts/stress-load-harness.js` measures.
- Nothing here changes what the browser's own process limits do to a worker: a browser
  or extension that throttles background tabs, or an OS scheduler that gives the
  browser's process fewer processors than it claims, produces a running pool on a
  partially loaded machine. The harness's per-logical-CPU readings are how that is
  told apart from the pool being too small.

## Implementation

| File | Responsibility |
|------|----------------|
| `utilities-src/src/stressTestController.ts` | Session lifecycle, UI, pool reports and spawning, worker aggregation and replacement, interaction |
| `utilities-src/src/stressTest.worker.ts` | Sustained self-driven CPU work, throttled progress reporting |
| `utilities-src/src/stressTestPrimes.ts` | Reusable segmented sieve and cached base primes |
| `utilities-src/src/stressTestPrimeRanges.ts` | Disjoint, contiguous block tiling of the number line, strided per lane |
| `utilities-src/src/stressTestWorkerTypes.ts` | Worker messages |
| `utilities-src/src/stressTestGpu.ts` | GPU backends, adaptive scaling, resource lifecycle |
| `utilities-src/src/stressTestGpuShaders.ts` | Shared scene design in WGSL and GLSL; compute shader |
| `utilities-src/src/stressTestCore.ts` | Mode/state helpers, report validation, fixed pool plan |
| `pages/utilities/index.html`, `css/utilities.css` | Workbench display and responsive layout |

Run `npm run utilities:check`, `npm run utilities:build`, and `node scripts/stress-test-check.js` (Chrome by default; override with `STRESS_BROWSER_CHANNEL`) after changing these files. `npm run serve` rebuilds the utilities and verifies the bundle graph before serving, so a preview never runs stale code. Test shader compilation and stop/restart on actual browser GPU backends; mocks alone cannot validate shaders or hardware load. Whole-machine load is measured outside the page with `node scripts/stress-load-harness.js --mode=cpu` (development only; it samples operating-system counters while driving the real page), and `node scripts/stress-report-trace.js` (development only) prints what the browser reports for logical processors in page and worker scope, which is how the reduced-report case above was identified.

Browser capability references: [reported logical processors](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency) and [GPU adapter selection](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter).

The legacy `data-stress-total-rendered-frames` diagnostic counts all render callbacks in a run, including GPU batch completions. It is not a count of displayed frames. The visible rate and gap counters use only the current source phase.

Detected software GL adapters (including SwiftShader) use a 512-pixel dimension ceiling and one shader pass per batch. This keeps sustained real shader work from starving the shared CPU/compositor and Stop control. Hardware adapters retain the existing adaptive supersampling and pass limits.

WebGL 1 yields through a timer between completed batches instead of a self-posting MessageChannel. Software GL gets a 16ms scheduling gap so compositor/input tasks can run; hardware WebGL 2 retains its fenced queue and 1ms completion polling. Stop cancels scheduled work.
