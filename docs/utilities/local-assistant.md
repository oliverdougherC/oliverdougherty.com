# LLM Rumen Cannula

Issue [#90](https://github.com/oliverdougherC/oliverdougherty.com/issues/90) adds
`05 // LLM Rumen Cannula` as a new implementation. The retired assistant is not reused.
The conversation is the input/output surface for a Qwen3.5 model observatory.

## Model provenance

| Field | Pinned value |
| --- | --- |
| Model | Qwen3.5-2B, text-only |
| Original model | [Qwen/Qwen3.5-2B](https://huggingface.co/Qwen/Qwen3.5-2B) |
| Inspected upstream configuration revision | `15852e8c16360a2fea060d615a32b45270f8a8fc` |
| GGUF producer | [unsloth/Qwen3.5-2B-GGUF](https://huggingface.co/unsloth/Qwen3.5-2B-GGUF) |
| Immutable GGUF revision | `f6d5376be1edb4d416d56da11e5397a961aca8ae` |
| File | `Qwen3.5-2B-Q4_K_M.gguf` |
| Quantization | Q4_K_M, GGUF v3 |
| Transfer bytes | 1,280,835,840 (1.28 GB / 1.19 GiB) |
| SHA-256 | `aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223` |
| License | Apache-2.0, recorded in the GGUF metadata |

The downloaded file was independently hashed during development. The browser
checks the transfer length and GGUF header; it does not allocate another 1.28 GB
buffer just to run WebCrypto SHA-256. The immutable upstream URL is the prototype's
asset source. **Weights currently download from Hugging Face, not this site's own
hosting.** Moving the exact verified bytes onto a site-controlled large-file host
requires an asset-hosting decision before production release; do not commit model
weights to Git. The GGUF identifies the base model but does not identify its exact
conversion input commit. The configuration revision above is the inspected
upstream snapshot, not a claim about an undocumented conversion commit.

There is one file: no gratuitous splitting and no vision-projector download.
Model metadata/configuration is isolated in `model.ts`, allowing a separately
validated 4B experiment later. There is no visible 4B selector.

## Runtime and observability

The runtime is a pinned, instrumented wllama 3.8.1 build of llama.cpp, vendored under
`utilities-src/local-assistant-runtime/`. Its patch, upstream revisions, licenses,
build command and artifact checksums accompany the runtime. Normal site builds
consume these artifacts and do not require an Emscripten toolchain.

Heavy tensor work runs on WebGPU in the runtime worker. The adapter requests high
performance; the controller verifies the native log confirms all model layers were
offloaded. There is no intentional CPU inference fallback. This build requires
WebGPU and WebAssembly JSPI; it fails closed instead of downloading an uninstrumented
compatibility runtime from a CDN.

The live observation payload contains:

- Actual formatted prompt token IDs/pieces and generated token IDs/pieces.
- Candidate IDs and normalized **post-sampling** weights from the actual sampler.
- Per-block residual RMS measured on the last token of each graph evaluation.
- Actual sequence length, generated token count, prefill time and decode rate.

The graph reduces each block's last residual vector to one mean-square scalar on
the GPU, then reads one compact vector and takes square roots in native code. No
full hidden-state arrays cross into JavaScript. The UI keeps bounded token windows;
layer and token buttons reveal numerical values without decorative activity.
The architecture comes from GGUF metadata (`qwen35.block_count` and
`qwen35.full_attention_interval`): this model has 24 blocks, with full attention
every fourth block and Gated DeltaNet in the others. It is not MoE.

The layer display measures residual magnitude, **not** attention scores, neuron
activity, operator timings or DeltaNet state. Attention matrices, detailed recurrent
state, exact KV bytes and GPU timings are not surfaced. No fake replacements are
shown. Per-token inspection only reads already retained bounded observations;
there is no background tensor dump or competing deep-inspection workload.

Sampling is temperature 0.6, top-k 20, top-p 0.95, min-p 0, with repetition penalty 1.
Thinking defaults on and uses the GGUF Jinja template's `enable_thinking` parameter
for each request. The runtime's actual reasoning field is displayed separately.
Both reasoning and response tokens use the same observability path. There is no artificial output-token limit: generation runs until EOS, Stop, a
physical context limit, or a repeated token loop. Repetition detection examines
exact suffix periods 1–32 with at least 32 tokens and six cycles; output is never rewritten.
Slow is a live 3 tokens/sec mode. It paces the runtime's result pulls, so the worker's
actual decode and telemetry slow together, with no completed-answer playback queue.
Stop/toggle/teardown interrupt the pacing wait immediately; prefill stays unpaced.

## Memory and lifecycle

Only activation imports the controller and starts loading. Visiting the index or
another tool requests no weights. `fetch` uses `cache: 'no-store'`, no credentials,
and no referrer. A counting TransformStream feeds the browser’s native response-to-Blob path, avoiding a retained multi-GB array of chunks. Streaming progress counts received bytes; the pinned file length
is known even if Content-Length is not exposed. Blob input bypasses wllama's model
manager and its persistent cache. The application does not use IndexedDB, OPFS,
Cache Storage or localStorage for model weights or conversations. Browser-managed
Blob backing, paging, network transport and OS caches remain browser/OS behavior;
this is not a guarantee that no bytes ever reach disk.

Adapter buffer limits and coarse system hints choose a conservative initial context,
not an estimate of available VRAM. The supported tiers are 2K, 4K, 8K, 16K, 32K and
64K. Allocation failures dispose the failed worker/device before trying the next
smaller context. Bad model formats and pipeline errors are not repeatedly treated
as allocation failures. The successful context is visible only for the session.

Switching away aborts loading or generation and pauses Snake/rendering. A loaded
model may remain for a short return. Five minutes without interaction or five
minutes away unloads it. Returning after unload enters the loading/Snake flow again.
Page teardown releases the runtime. Reset clears the conversation and native
slot/KV state while retaining the loaded weights. Abort/version guards reject stale
callbacks after cancellation, reset, retry and deactivation.

Starting Snake expands it across the remaining workbench height and width while
keeping loading/Enter chat controls available. Arrow/WASD controls work globally
while playing, without canvas focus. Editable controls, Tab and Escape remain
available; Pause, chat entry, deactivation and destruction release game input.
Resizing translates/scales the existing board without losing the snake or score.
The ready transition never forces the user out of the game.

## UI and rendering

The public name is **LLM Rumen Cannula**; `#local-assistant` remains a stable route.
The presentation follows the other Utilities: one shared title, white surfaces,
thin rules and bold JetBrains Mono for model identity. User messages use ordinary
sentence typography on a restrained, right-aligned surface. The duplicate
in-tool header, disclaimer, slogans, empty-chat suggestions and permanent telemetry
instructions are removed. New chat sits with Thinking and Send. The closed native
switcher says “Switch utility” without repeating the current tool name.

The observatory receives more width and uses readable labels and values. Token IDs appear on selection. One panel follows the active stage: exact prompt
tokenization and processed counts during prefill, then the output stream during
decode. It retains at most 2,048 output tokens in memory and renders only the number
that fits, capped at 1,024 visible tokens. Larger windows reveal IDs, more history,
and all eight candidate weights; laptops retain the essentials. Candidate height
is reserved for 3/5/8 rows so sampling changes do not move other controls.

The layer view charts the **actual residual RMS after every block**, with one
shared, labeled scale and distinct DeltaNet/full-attention encodings. The scale
can grow during a turn but does not shrink with every token. Graph pass numbers
come from the runtime; they are not token counts or invented per-layer timings.
No animated traversal claims to show a layer currently computing. At larger
sizes, each block's numeric value is visible without selecting it. Thinking is collapsed initially and uses a braille state indicator, frozen under reduced motion. Thinking content keeps a restrained rule
rather than a large tinted card. Copy acknowledges success in its existing label.

The outer workbench stays bounded to the viewport. The transcript is the sole
intentional scrolling region. Token windows and candidate/layer summaries remain
bounded. Streamed content renders as DOM text; raw model HTML is never executed.
Markdown supports paragraphs, headings, lists, emphasis, links and fenced code.
MathML renders a bounded common LaTeX subset; unsupported syntax remains visible
as source. This is not full TeX/KaTeX compatibility. No rendering dependencies or
remote scripts were added. Stream announcements occur at state transitions rather
than every token, and manual transcript scrolling is preserved.

## Validation and release gates

Run:

```sh
npm run utilities:check
npm run utilities:build
npm run utilities:browser-check
npm run quality
```

The dedicated browser harness distinguishes mocked UI/lifecycle checks from real
inference. See [browser validation](./local-assistant-validation.md) and [runtime verification](../../utilities-src/local-assistant-runtime/README.md) for measured hardware,
transfer, memory, context and observability-overhead results. Do not infer hardware
or browser coverage from fixture tests. In particular, a discrete-GPU result must
come from an actual discrete GPU. No merge or deployment is part of this prototype.

## Prototype assessment

The real integrated UI completed a fresh 1,280,835,840-byte upstream transfer and
65,536-token allocation on Apple M4 Pro in 24.65 seconds. Byte progress was
monotonic; the largest observed loading/init animation-frame gap was 58.3 ms
across 3,015 frames. Snake stayed selected after readiness. A 36-token non-thinking
response measured 58.8 tok/s and 204.2 ms prefill (short-run startup effects apply). The original `.1` runtime’s 2K-context ABBA
comparison averaged 60.80 tok/s with residual/sampler telemetry and 63.70 tok/s
without it: a 4.55% throughput reduction across six runs in each condition.
The final paired run used no known concurrent GPU tests; use these as single-machine
prototype measurements rather than a cross-hardware benchmark claim.

A 4B follow-up is worth a separate experiment on stronger hardware: the 2B runtime
and bounded observability path work and leave a practical baseline. This is not a
recommendation to expose 4B yet. Repeat identical prompts, memory-allocation tiers
and overhead measurements on Apple Silicon and a discrete GPU before making a
product choice. The present build has no measured discrete-GPU coverage.

The [cold-load trace](./local-assistant-evidence/cold-load.json) records the actual
upstream transfer and response. The performance trace and [initial loading capture](./screenshots/local-assistant-loading.png) belong to the initial prototype. Updated [model-ready/Snake](./screenshots/local-assistant-ready.png) and [desktop chat](./screenshots/local-assistant-chat.png) screenshots show the current v1 interface with the real model. The [800×600 chat](./screenshots/local-assistant-chat-800x600.png) capture records the preceding UI revision. Current seven-viewport browser fixture screenshots are kept separate under `output/`.


## V1 behavior checks

The `.2` runtime verified real Slow pacing at **2.969 tokens/sec**, live on/off
changes, and cancellation during the pacing wait at **0.23 ms**. A native test
completed **1,100 tokens** without a fixed output cap. A separate real in-app
browser run completed **2,037 tokens** with thinking enabled and Slow reporting
3 tokens/sec; see [its recorded UI observations](./local-assistant-evidence/v1-live.json).
These are separate runs from the original throughput benchmark above.

The browser suite checks seven viewport sizes through **3840×2160**, including
fully populated prompt/decode windows, candidate rows and layer bars. It verifies
that larger windows expose more data, every visible token fits, the composer has
one focus boundary, and the expanded Snake board fills the available height.
The shared Switch utility control is checked in every utility for native keyboard
access and a full-size label/caret hit area. Token inspection uses a roving tab
stop and arrow/Home/End keys, preserving focus as the live window rolls forward.
Selections clear at turn and stage boundaries.
