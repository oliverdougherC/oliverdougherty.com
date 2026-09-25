# Stress Test

The utility runs sustained CPU prime searches and an interactive GPU sculpture, separately or together. Start explicitly begins the workload; Stop, leaving the utility, hiding the page, or disposing the controller ends it.

## CPU prime search

Every searched integer is tested in a module worker. The main thread creates
workers, hands each one a range of the number line, and aggregates what comes
back; it runs no search itself, which is what lets the pool be resized at any
moment and lets Stop work by termination alone.

### How many workers run

A browser cannot measure CPU utilisation, and `navigator.hardwareConcurrency` is
a hint rather than a fact: privacy modes round it down to physical cores or cap
it deliberately, and an OS may reserve cores (for example virtualization-based
security), which on multithreaded CPUs leaves simultaneous-multithreading
siblings or whole cores idle (historically Firefox capped the value at 16 via
`dom.maxHardwareConcurrency` until Firefox 139 raised the default to 128; privacy
modes can still report less than the real capability). The pool therefore treats
the report as a starting point and recovers what it missed by measuring
scheduling:

1. **Start at the whole report.** No halving, no core held back for the main
   thread (it stays light instead), and no automatic simultaneous-multithreading
   multiplier — an "always 2×" rule is as much a guess about hardware as the
   report it tries to correct.
2. **Grow while no worker is losing its processor.** Each worker runs a slice whose
   budget is 8ms of wall clock and checks that same clock between segments, so a
   slice that takes 1.5× its budget was demonstrably descheduled while it ran. Once
   per second the page takes that share across the whole pool, and while it stays
   below `CPU_POOL_CONTENTION_SHARE` the pool adds half again as many workers (at
   least two).
3. **Stop when a clear share of slices is being taken off the processor**, which is
   the pool having more workers than the machine can run at once.
4. **Never shrink.** A worker is only ever removed by Stop.

The window that contains a spawn is not judged: it holds the spawn's own
main-thread work and the new workers' boot, either of which would be read as
capacity or as contention.

That share is only trusted at or above the worker count the browser's own report
asked for, because it appears only well past the machine (see the sweep below).
Below the report the report is the authority and the pool grows anyway. That
ordering is the whole reason an under-reporting browser still reaches full load: no
window the pool cannot attribute can stop it short.

**Why not throughput.** Throughput was the previous rule, and it under-loaded the
machine it was given. On a 16-core/32-thread host, growing from 4 to 128 workers
moved the pool's aggregate candidate rate by under +18% — while the
operating-system load of the very same run went from 25% to 100%:

| workers | OS CPU (all logical CPUs) | aggregate candidates/s | candidate rate per worker |
|--------:|--------------------------:|-----------------------:|--------------------------:|
| 4 | 25% | 889 M | 222 M |
| 14 | 56% | 795 M | 57 M |
| 32 | 100% | 1,063 M | 33 M |
| 48 | 100% | 1,106 M | 23 M |
| 128 | 100% | 1,046 M | 8 M |

Aggregate throughput saturates long before the CPUs do, because a bigger pool
buys processors, not a cheaper sieve — memory bandwidth, cache pressure, and a
deeper search frontier eat what the extra threads could have added. Inside a run
the rate also sags 2–6% per second on its own (boost-clock recovery, thermal
state, background load), which is the same size as the differences a
window-to-window rule tries to read. A rule that grows on throughput therefore
stops with most of the machine idle: two runs of the same build on the same host
produced 128 workers in one and 6 in the other, at 100% and 27% load.

**Why not the pool's own scheduling.** Two candidates were built, measured, and one
was thrown away. A compute slice that runs 1.5× its own wall-clock budget was
demonstrably descheduled mid-slice; and `busyMs / (busyMs + idleMs)` — how much of
the wall clock a worker spends sieving rather than waiting to be handed a processor
again — was expected to fall as the pool passed the thread count. Both are measured
per worker, so neither cares what the work costs, how deep the search has gone, or
how far the clocks have sagged. Pinned worker counts, Chromium, 20–22 s runs
averaged over the steady seconds, with the operating-system load read at the same
time:

| workers | OS CPU (all 32 logical CPUs) | page duty cycle | slices descheduled mid-slice |
|--------:|---------------------------:|----------------:|-----------------------------:|
| 4 | 15.8% | 100% | 0% |
| 16 | 53.5% | 100% | 0% |
| 24 | 78.4% | 100% | 0% |
| 32 | 100.0% | 100% | 0% |
| 36 | 100.0% | 100% | 0% |
| 40 | 100.0% | 100% | 0% |
| 48 | 100.0% | 100% | 0% |
| 64 (2× threads) | 100.0% | 100% | 1% |
| 96 (3×) | 100.0% | 100% | **25%** |
| 128 (4×) | 100.0% | 100% | 8% |
| 256 (8×) | 100.0% | 100% | **100%** |

The duty cycle is the one that failed: flat at 100% from 4 workers to 256. On this
browser and operating system a worker whose slice ends is handed a processor again
immediately, so the queueing a page would like to measure never happens, and a rule
that stopped on it never stopped at all. It is still measured and published
(`data-stress-cpu-busy`), because it does separate a pool that cannot get integers to
sieve from one that cannot get processors — and `data-stress-cpu-band-wait` is kept
apart from it so the two are never confused.

The mid-slice share is the signal that moves, and it moves steeply: nothing until
well past the thread count, 1% at twice the thread count, then 25% and 100%.
`CPU_POOL_CONTENTION_SHARE = 0.1` sits inside the measured gap between 1% and 25%, so
ordinary scheduling noise cannot stop growth short, and the landing point on this host
is past 64 workers — past the count that fills the machine, with margin, rather than
the exact thread count the page cannot observe.

Oversubscription is cheap, so the pool is grow-only and lands *past* the thread count
rather than hunting for it. On this 32-thread host every pool from 32 to 256 workers
holds 100% operating-system load; what oversubscription costs is sieve throughput,
which peaks around 56–72 workers (2.52 G candidates/s measured) and falls to 2.35 G at
96, 2.20 G at 128 and 1.90 G at 256. So landing between 48 and 108 workers — the range
the automatic policy landed in across the runs recorded above — costs nothing to 5% of
throughput while every one of those pools is fully loaded, whereas stopping one step
short leaves 25–45% of the machine idle, which is the actual product failure. A worker
cannot be removed without abandoning the band of integers it owns, which makes
grow-only the only honest option anyway.

Growth ends at the plan's ceiling, after 24 rounds, or when five consecutive
windows report no progress at all (a stalled pool is not a capacity probe, and an
idle worker has no queueing for the same reason it has no work — so an
evidence-free window is never a reason to grow). The
ceiling is the larger of the browser's report and 128 workers, so the guard is a
runaway limit and never truncates a machine that legitimately reports more; a
"report" above 4096 logical processors is not hardware and is discarded as
unusable, because honouring it literally would mean creating millions of
workers. `data-stress-cpu-reported` publishes the hint the policy was given and
`data-stress-cpu-pool` its verdict: `growing`, then `settled`, `capped`, or
`pinned`. If a worker cannot be created during growth, the run keeps the workers
that did start, growth ends, and `data-stress-cpu-pool-limitation` says why —
the page never keeps quiet and pretends the requested pool is running. An
initial wave that cannot be built fails the start visibly instead of reporting a
workload that is not running.

Every input to that decision is published, because a worker count on its own
cannot be audited and a policy that "converged" is not evidence that the machine
is loaded:

| Dataset | What it measures |
|---------|------------------|
| `data-stress-cpu-reported` | the `hardwareConcurrency` hint the policy was given |
| `data-stress-cpu-pool` | `growing` → `settled` / `capped` / `pinned` |
| `data-stress-cpu-slice-slow` | percent of the last second's compute slices that were descheduled mid-slice — the share the growth rule decides on |
| `data-stress-cpu-pool-windows` | JSON of the recent windows: pool size, work, rate, per-worker rate, slices, mid-slice share, duty cycle, and the decision each produced |
| `data-stress-cpu-busy` | percent of wall time the workers spent sieving rather than waiting to be handed a processor again — audit, not a decision input (it reads 100% on machines that never queue their workers) |
| `data-stress-cpu-band-wait` | percent of wall time spent waiting for the page to hand out integers: a page-side limit, never read as the machine being full |

What the automatic policy does on this host, run end to end against the served page
with real workers (`--report=N` mocks only the browser's hint):

| run | hint | workers | verdict | OS CPU mean/min/max | logical CPUs idle | full pool at |
|-----|-----:|--------:|---------|--------------------:|------------------:|-------------:|
| default | 32 | 108 | settled | 100.0 / 100.0 / 100.0% | none | 7.6 s |
| under-report | 4 | 72 | settled | 100.0 / 100.0 / 100.0% | none | 15.4 s |
| under-report (repeat) | 4 | 108 | settled | 100.0 / 100.0 / 100.0% | none | 17.5 s |
| single processor claimed | 1 | 93 | settled | 99.2 / 91.7 / 100.0% | none | 19.4 s |
| CPU + GPU | 32 | 48 | settled | 100.0 / 100.0 / 100.0% | none | 3.0 s |
| CPU + GPU, visuals on | 32 | 48 | settled | 100.0 / 100.0 / 100.0% | none | 3.4 s |
| Stop pressed under load | 32 | 48 | settled | 100.0 / 100.0 / 100.0% loaded; 3.5% after Stop | none | 3.4 s |
| Firefox | 32 | 48 | settled | 100.0 / 100.0 / 100.0% | none | 3.3 s |
| WebKit | 32 | 128 | **capped** | 96.9 / 93.9 / 99.0% | none | 15.6 s |

WebKit is the honest exception: it grew to the 128-worker ceiling without ever
measuring 10% mid-slice preemption, and its load sat at 96.9% mean with every logical
processor between 94% and 98% — fully occupied on the harness's test (no logical
processor persistently idle, aggregate above 95%), but short of the flat 100% Chromium
and Firefox reach. The combined-mode rows also carry the GPU promise: 120.9 and
120.6 rendered frames per second across the steady seconds with ~50–108 CPU workers
running, so the CPU pool does not starve the GPU lane.

The pool does not always reach the same size, and the recorded spread is 48–108
workers: the one-second window that follows a spawn wave contains that wave's own
scheduling churn, so a window can measure the threshold earlier than the steady state
would. On this host the earliest settlement seen was 41 workers, which is still 1.3×
the thread count and measured 100% load in the pinned sweep above — the policy is
tuned so that even its early landing is a loaded machine, and only its late landing
costs sieve throughput. `scripts/stress-test-check.js` asserts the settlement itself
came from measurement: the last recorded window must carry a mid-slice share at or
above the threshold, so a pool that stopped because it ran out of growth rounds or hit
the ceiling fails that check rather than passing on a plausible-looking count.

Two hooks exist for tests and diagnosis, and they mean different things:
`window.__OD_STRESS_TEST_WORKERS__ = N` requests exactly N workers and does not
grow (the request may exceed the report, which is how a specific count is tested
on any machine), while `window.__OD_STRESS_TEST_MAX_WORKERS__ = N` is a ceiling
on the automatic pool and never asks for workers. `scripts/stress-test-check.js`
runs the automatic policy against real cores on dedicated pages — one claiming a
single logical processor on a many-core host, where the pool must grow far past
that claim before it settles, and one reporting the host's true logical CPU
count — and asserts the final count, the verdict transitions and the number of
workers actually constructed, so a policy that merely stays alive at the
reported count fails. `scripts/stress-load-harness.js` (development only, never
shipped) drives that real page and real workers while sampling operating-system
per-logical-CPU counters, prints the pool's own window trace alongside the preemption
share, duty cycle and band wait it published, and reports the load actually observed;
`--pin=N` holds a specific count still, which is how the sweep above was measured, and
`--report=N` mocks the browser's hint, which is how an under-reporting browser is
tested on a machine that reports correctly.

Each worker runs an odd-only segmented sieve of Eratosthenes using a reused 32 KiB
marking buffer. Base primes are cached and extended geometrically with a separate
segmented sieve, together with their reciprocals: the hot `low % prime` scan uses
Barrett reduction with a correction loop, which stays exact integer arithmetic
even past the small-integer range, where the native floating remainder operator
costs several times more and would collapse throughput at the 2^31 frontier.
There is no repeated trial division or artificial CPU busy work.

Work is divided by position rather than tracked in blocks: the *n*-th worker
created owns the band of `2^31` consecutive integers beginning at `n × 2^31`, and
when it drains that band it asks for the next serial in spawn order. Bands are
contiguous and disjoint, so the ranges the workers report cover a contiguous
stretch of the number line with no gaps and no overlap, and nothing has to be
bookkept to prove it — a worker that starts or stops simply covers or uncovers
its own band. Requesting a band that would leave the safe-integer range is
refused rather than wrapped or truncated. The search starts at 1 (rejected), and
the number 2 is counted exactly once — by the single band that contains it.

A worker yields through a MessageChannel after roughly 8ms of useful computation;
there is no timer sleep and no refresh-rate pacing between chunks. Cumulative
heartbeats are throttled to about 140ms, so the main thread aggregates tens of
messages a second instead of thousands, and diagnostic DOM writes happen in the
throttled metric loop rather than per message. Run IDs and worker indices reject
messages from a superseded run and from a record already stopped; a band request
carries a supply id, so a duplicated or out-of-order request cannot hand out the
same range twice. A worker that drains its band asks again, retries on a
watchdog, and waits instead of spinning while it has no work. Stopping is
`terminate()` — a worker is never asked to stop politely and expected to
acknowledge, so no stop path can be ignored.

The large display is the largest prime any worker actually reported. It is not a
claim that every smaller band has finished: bands run in parallel and the widest
one is still being searched. "Candidates tested" counts odd sieve candidates plus
2, while the found count reports actual primes; nothing is interpolated or
extrapolated. Each worker bar reports that worker's own cumulative candidates and
the low end of the region it is currently sieving. Stop preserves the result, and
a new run resets it. Worker bars and candidate counts are throughput readings, not
OS utilization — a page cannot read utilization counters, which is exactly why
`scripts/stress-load-harness.js` samples them from outside the browser.

The summary's `candidates/s` reading is a moving average intended for comparing
CPU throughput across machines: actual cumulative candidates tested divided by
the actual elapsed time over the trailing 5,000 ms window, with the window edge
linearly interpolated between the two actual samples that bracket it. Because
heartbeats are throttled to about 140ms, a single-tick delta would report
delivery jitter instead of throughput; the fixed interpolated window keeps the
window length constant and lets a stalled CPU decay out of the average smoothly.
Nothing is reported until the measured span reaches 1,000ms, and worker startup
leaves the window once a run is 5 seconds old. The integer is also exposed as
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

The worker pool inherits the same limits. It grows while its workers keep their
processors, so it reaches full load by arriving at a pool that saturates the machine,
not by computing the machine's thread count: on the host measured above it lands past
the logical CPU count, which is the intended landing point and costs no measurable
load. Two things it cannot do, both from the same platform gap — a page has no
utilization reading for its own machine:

- A measured share of descheduled slices has two causes, and the pool cannot tell
  them apart: it has more workers than processors, or something *else* is using the
  processors and taking them mid-slice. A heavily loaded host, an aggressive
  scheduler, or a container with a CPU quota can therefore stop the pool at the
  reported count and leave it under-loaded. That is why the share is only trusted at
  or above the reported count: below it the pool ignores the measurement and grows
  anyway, which is what protects the case that matters — a browser that reports too
  few processors.
- A browser that over-reports logical processors cannot be corrected either. A
  worker already searching cannot be removed without abandoning the band of integers
  it covers, so the pool only ever grows, and an over-report leaves it oversized
  (measured cost of the 128-worker ceiling on a 32-thread host: about 12% of sieve
  throughput, none of the load).

The published datasets above are what make both cases diagnosable from the page: a
pool that stopped early shows a high mid-slice share at a small worker count in
`data-stress-cpu-pool-windows`, and `data-stress-cpu-band-wait` high against a
`data-stress-cpu-busy` of 100% means the page, not the machine, was the limit.

## Implementation

| File | Responsibility |
|------|----------------|
| `utilities-src/src/stressTestController.ts` | Session lifecycle, UI, pool sizing and spawning, worker aggregation, interaction |
| `utilities-src/src/stressTest.worker.ts` | Sustained CPU work, band requests, heartbeat scheduling |
| `utilities-src/src/stressTestPrimes.ts` | Reusable segmented sieve and cached base primes |
| `utilities-src/src/stressTestPrimeRanges.ts` | Disjoint, contiguous band tiling of the number line per worker |
| `utilities-src/src/stressTestWorkerTypes.ts` | Worker messages |
| `utilities-src/src/stressTestGpu.ts` | GPU backends, adaptive scaling, resource lifecycle |
| `utilities-src/src/stressTestGpuShaders.ts` | Shared scene design in WGSL and GLSL; compute shader |
| `utilities-src/src/stressTestCore.ts` | Mode/state helpers, pool plan, measured growth rule |
| `pages/utilities/index.html`, `css/utilities.css` | Workbench display and responsive layout |

Run `npm run utilities:check`, `npm run utilities:build`, and `node scripts/stress-test-check.js` (Chrome by default; override with `STRESS_BROWSER_CHANNEL`) after changing these files. `npm run serve` rebuilds the utilities and verifies the bundle graph before serving, so a preview never runs stale code. Test shader compilation and stop/restart on actual browser GPU backends; mocks alone cannot validate shaders or hardware load. Whole-machine load is measured outside the page with `node scripts/stress-load-harness.js --mode=cpu` (development only; it samples operating-system counters while driving the real page).

Browser capability references: [reported logical processors](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency) and [GPU adapter selection](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter).

The legacy `data-stress-total-rendered-frames` diagnostic counts all render callbacks in a run, including GPU batch completions. It is not a count of displayed frames. The visible rate and gap counters use only the current source phase.

Detected software GL adapters (including SwiftShader) use a 512-pixel dimension ceiling and one shader pass per batch. This keeps sustained real shader work from starving the shared CPU/compositor and Stop control. Hardware adapters retain the existing adaptive supersampling and pass limits.

WebGL 1 yields through a timer between completed batches instead of a self-posting MessageChannel. Software GL gets a 16ms scheduling gap so compositor/input tasks can run; hardware WebGL 2 retains its fenced queue and 1ms completion polling. Stop cancels scheduled work.
