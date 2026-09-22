# Stress Test

The utility runs sustained CPU prime searches and an interactive GPU sculpture, separately or together. Start explicitly begins the workload; Stop, leaving the utility, hiding the page, or disposing the controller ends it.

## CPU prime search

One module worker is created per browser-reported logical processor, with no fixed
64-worker production cap. Browsers may report fewer logical processors than the
machine has: privacy modes round `hardwareConcurrency` down to physical cores or
deliberately cap it, which on multithreaded CPUs leaves simultaneous-multithreading
siblings or whole cores idle (historically Firefox capped the value at 16 via
`dom.maxHardwareConcurrency` until Firefox 139 raised the default to 128; privacy
modes can still report less than the real capability). A closed-loop throughput
probe recovers that capacity. Its work measure counts executed sieve work —
every marking store, both linear buffer passes per segment, and a flat charge
per base-prime scan. One unit costs the same CPU time at any search frontier,
unlike candidates/s (which decays) or a per-prime scan count (whose units grow
cheaper as the frontier advances and would fake capacity gains); production and
disposable-benchmark rates are therefore directly comparable even though they
sieve different ranges. Sieve base extensions and
JIT phase changes make any single measurement window bursty, so the probe keeps
the peak window rate over several baseline windows, spawns a disposable
benchmark wave (doubling workers, capped at 128 total), and keeps it when a
candidate window beats that peak by at least 10%; a few candidate windows all
missing the threshold revert it. Peak-versus-peak comparison lets bursts
influence both sides equally instead of faking or masking a capacity change.
Every kept wave re-baselines and attempts another doubling wave, so a heavily
under-reporting browser keeps growing until a wave fails to grow or the cap is
reached. Benchmark workers sieve a disposable benchmark range from their own
allocator and feed only the probe's rate measurement: reported primes,
checksums, and production block coverage never see benchmark work, so no keep
or revert decision can leave a hole in the production search. A probe worker
error or partially failed wave reverts only the probe wave and leaves the
permanent workload running; a partially failed wave rewinds its allocator to
the position marked before the wave, so even a partially spawned permanent
replacement wave returns its blocks and the surviving workers resume the exact
frontier. The probe advances on worker heartbeats, never on
timers, and `data-stress-cpu-smt-probe` reports `probing`, then finally `kept` or
`reverted` (whether final capacity grew beyond the reported count). The explicit
`window.__OD_STRESS_TEST_MAX_WORKERS__` override
pins the count and disables the probe, keeping the bounded browser checks
deterministic; `scripts/stress-test-check.js` adds a dedicated probe-mode page
that exercises the real spawn/keep/revert chain against real cores, pins the
mechanism itself (probe-state transitions plus worker-spawn counts, so a probe
that reverts without ever spawning a benchmark wave fails), and the release
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
allocator issues disjoint, consecutive blocks of 64 segments; SMT benchmark waves
consume blocks only from a separate disposable allocator, keeping production
coverage contiguous across every probe outcome. Workers prefetch four
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
| `utilities-src/src/stressTestPrimeScheduler.ts` | Consecutive block allocation, bounded prefetch, disposable benchmark allocator |
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
