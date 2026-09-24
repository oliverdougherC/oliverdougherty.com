# Stress Test

The utility runs sustained CPU prime searches and an interactive GPU sculpture, separately or together. Start explicitly begins the workload; Stop, leaving the utility, hiding the page, or disposing the controller ends it.

## CPU prime search

One module worker is created per browser-reported logical processor, with no fixed
64-worker production cap. Browsers may report fewer logical processors than the
machine has: privacy modes round `hardwareConcurrency` down to physical cores or
deliberately cap it, and an OS may reserve cores (for example virtualization-based
security), which on multithreaded CPUs leaves simultaneous-multithreading
siblings or whole cores idle (historically Firefox capped the value at 16 via
`dom.maxHardwareConcurrency` until Firefox 139 raised the default to 128; privacy
modes can still report less than the real capability). A closed-loop throughput
search recovers that capacity. Its work measure counts executed sieve work —
every marking store, both linear buffer passes per segment, and a flat charge
per base-prime scan — which keeps per-unit CPU cost near-flat across search
frontiers, unlike candidates/s (which decays) or a per-prime scan count (whose
units grow cheaper as the frontier advances and would fake capacity gains).
Exact rate comparability comes from the seed instead: every disposable wave
sieves its own allocator seeded at the production frontier current when that
wave spawns, so probe workers perform exactly the work the permanent workers
are about to perform and no fixed range can fake a throughput gain. Rates must
also be comparable across time, because a candidate wave is always measured
seconds after its baseline: per-worker rate decays as the shared sieve frontier
deepens — steepest in a run's first seconds — so a reference taken from the
best baseline window (as the original probe used) is set at a shallower,
cheaper frontier that a wave which genuinely doubled throughput cannot beat,
and idle capacity gets falsely reverted. Every phase, including the very first
baseline, begins with a settle warmup that discards the steepest startup
windows, and the comparison reference is the mean of only the newest two
baseline windows, temporally adjacent to the candidate; a wave is kept when a
candidate window beats that reference by at least 10% and reverted when two
consecutive candidate windows miss it.

Keeping converts only the workers the measurement can explain: while every
worker owns a hardware thread, aggregate rate scales with the worker count, so
the candidate's rate ratio estimates the machine's measured saturation point,
and keep converts `proven count × ratio` workers into permanent ones. A
doubling wave that strides past capacity is trimmed to the estimate instead of
installed whole.

Doubling alone cannot turn an under-report into the true thread count: it
strides over it (12 → 24 → 48 skips 32 entirely), and a stalled wave that
reverted and stopped used to strand the run below saturation. The search
therefore keeps proven bounds and converges. Waves are kept exponentially
(doubling) while aggregate measured work keeps rising, so a heavily
under-reporting browser reaches capacity in a few waves; a kept wave that
only partially converted proved its trial total overshot capacity and stands
as the upper bound. Once a wave stalls, the failed trial likewise becomes the
upper bound and the search refines by bisecting
between the last grown count and the first stalled one: a kept trial raises the
proven bound, a reverted trial lowers the failed bound, and each trial re-runs
the same baseline/candidate measurement at the current count. The search stops
when the bracket is inside the tolerance (`max(2, 10% of the proven count)`,
because no windowed comparison resolves capacity differences finer than the
keep ratio), or when the 128 total-worker cap is reached. If the very first
wave fails — the browser's own report never grew — the report is trusted and
the search ends after that one wave, exactly as a correctly reported machine
needs. The final worker count therefore sits at measured
saturation (full utilization) and within tolerance of it, instead of a
power-of-two stride away. A browser that over-reports cannot be corrected:
permanent workers cannot be terminated without leaving holes in the production
search coverage, so the search only ever adds capacity. A baseline whose
reference windows show no progress gives no trustworthy comparison: it is treated as a
failed trial and the search stops. Benchmark workers sieve the frontier-seeded
allocator of their own wave, are marked with `data-benchmark="true"` on their
activity bar, and feed only the search's rate measurement: reported primes,
checksums, and production block coverage never see benchmark work, so no keep
or revert decision can leave a hole in the production search. A probe worker
error or partially failed wave ends the search and leaves the permanent
workload running; a partially failed wave rewinds its allocator to the
position marked before the wave, so even a partially spawned permanent
replacement wave returns its blocks and the surviving workers resume the exact
frontier. The search advances on worker heartbeats, never on
timers, and `data-stress-cpu-smt-probe` reports `probing` throughout (including
between refinement waves), then finally `kept` or `reverted` (whether final
capacity grew beyond the reported count). The explicit
`window.__OD_STRESS_TEST_MAX_WORKERS__` override
pins the count and disables the search, keeping the bounded browser checks
deterministic; `scripts/stress-test-check.js` adds dedicated probe-mode pages
that exercise the real spawn/keep/revert chain against real cores: one
simulates a 1-thread under-report (the growth path) and one reports the
machine's true logical CPU count, where an already-saturated machine must
revert the extra wave and end the search at exactly the reported count (the
saturated path). The pages pin the mechanism
itself (probe-state transitions plus worker-spawn counts, so a probe that
reverts without ever spawning a benchmark wave fails), and the release
matrix repeats probe mode on Chromium, Firefox, and WebKit.

Each worker runs an odd-only segmented sieve of Eratosthenes using a reused 32 KiB
marking buffer. Base primes are cached and extended geometrically with a separate
segmented sieve, together with their reciprocals: the hot `low % prime` scan uses
Barrett reduction with a correction loop, which stays exact integer arithmetic
even past the small-integer range, where the native floating remainder operator
costs several times more and would collapse throughput at the 2^31 frontier.
The sieve's work counter charges every executed marking store, both linear
buffer passes per segment, and every executed base-prime scan. There is no
repeated trial division or artificial CPU busy work.
The search starts at 1 (rejected); prime 2 is included exactly once. A main-thread
allocator issues disjoint, consecutive blocks of 64 segments; SMT benchmark
waves consume blocks only from their own disposable allocator seeded at the
production frontier, keeping production coverage contiguous across every probe
outcome. Workers prefetch four
blocks and request a refill with two or fewer left, so fast cores receive more useful
work without exhausting their queues during the communication round trip. No
SharedArrayBuffer or cross-origin isolation is required by this static site.

Workers yield through MessageChannel after approximately 8ms of useful computation;
there is no timer sleep between chunks. Cumulative heartbeats are throttled to about
140ms. Supply IDs, run IDs, worker IDs and block bounds reject duplicate, stale and
out-of-order messages. Main-thread work is bounded by worker/refill counts, not by
searched integers; diagnostic DOM updates occur in the throttled metric loop.

The large display is the largest actual prime reported. It is not a claim that every
smaller block has completed yet. Candidates tested counts odd sieve candidates plus
2, while the found count reports actual primes; there are no fabricated/interpolated
results. Stop preserves the result, and a new run resets it. Allocation stops at the
safe-integer boundary. Worker bars report relative completed candidate throughput,
not OS utilization.

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

## Implementation

| File | Responsibility |
|------|----------------|
| `utilities-src/src/stressTestController.ts` | Session lifecycle, UI, counters, worker aggregation, interaction |
| `utilities-src/src/stressTest.worker.ts` | Sustained CPU work and heartbeat scheduling |
| `utilities-src/src/stressTestPrimes.ts` | Reusable segmented sieve and cached base primes |
| `utilities-src/src/stressTestPrimeScheduler.ts` | Consecutive block allocation, bounded prefetch, disposable benchmark allocator seeded at the production frontier |
| `utilities-src/src/stressTestWorkerTypes.ts` | Worker messages |
| `utilities-src/src/stressTestGpu.ts` | GPU backends, adaptive scaling, resource lifecycle |
| `utilities-src/src/stressTestGpuShaders.ts` | Shared scene design in WGSL and GLSL; compute shader |
| `utilities-src/src/stressTestCore.ts` | Mode/state helpers and worker count |
| `pages/utilities/index.html`, `css/utilities.css` | Workbench display and responsive layout |

Run `npm run utilities:check`, `npm run utilities:build`, and `node scripts/stress-test-check.js` (Chrome by default; override with `STRESS_BROWSER_CHANNEL`) after changing these files. Test shader compilation and stop/restart on actual browser GPU backends; mocks alone cannot validate shaders or hardware load.

Browser capability references: [reported logical processors](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/hardwareConcurrency) and [GPU adapter selection](https://developer.mozilla.org/en-US/docs/Web/API/GPU/requestAdapter).

The legacy `data-stress-total-rendered-frames` diagnostic counts all render callbacks in a run, including GPU batch completions. It is not a count of displayed frames. The visible rate and gap counters use only the current source phase.

Detected software GL adapters (including SwiftShader) use a 512-pixel dimension ceiling and one shader pass per batch. This keeps sustained real shader work from starving the shared CPU/compositor and Stop control. Hardware adapters retain the existing adaptive supersampling and pass limits.

WebGL 1 yields through a timer between completed batches instead of a self-posting MessageChannel. Software GL gets a 16ms scheduling gap so compositor/input tasks can run; hardware WebGL 2 retains its fenced queue and 1ms completion polling. Stop cancels scheduled work.
