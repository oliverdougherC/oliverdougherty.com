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
  The bounded list includes the top eight plus the actual sampled token when it
  falls outside that prefix, using its independently measured probability. The
  selected row remains visible at every panel size without claiming a false rank.
- Per-block input RMS and RMS of the change from input to output, with their ratio.
- Sparse last-query attention weights, averaged across heads, for full-attention blocks.
- Intermediate vocabulary readouts using the model's final output normalization and head.
- Actual sequence length, generated token count, prefill time and decode rate.

The graph reduces measurements on the GPU before passing a bounded packet into
JavaScript. Attention retains the strongest keys with their original weights and
actual logical sequence positions; it does not renormalize the retained subset.
The architecture comes from GGUF metadata (`qwen35.block_count` and
`qwen35.full_attention_interval`): this model has 24 blocks, with full attention
every fourth block and Gated DeltaNet in the others. It is not MoE.

Attention describes the **query that predicted the sampled token**. The sampled
token has not yet been processed by that pass. The UI resolves both against the
actual templated prompt and generated token sequence. Head-mean attention is not
causal attribution or a measurement of the DeltaNet recurrent state.

The waterfall uses `RMS(output - input) / RMS(input)` at each block, not residual
magnitude or elapsed compute time. A shared logarithmic color intensity makes
smaller changes visible; exact inspected ratios stay unchanged. Intermediate vocabulary predictions are raw
logit-lens readouts, not trained probes or decisions emitted by individual layers.
Their full-vocabulary softmax probabilities differ from the final panel's
post-sampler weights. Missing measurements remain missing; no animated traversal
or inferred tensor values replace them.

Sampling is temperature 0.6, top-k 20, top-p 0.95, min-p 0, with repetition penalty 1.
Thinking defaults on and uses the GGUF Jinja template's `enable_thinking` parameter
for each request. The runtime's actual reasoning field is displayed separately.
Both reasoning and response tokens use the same observability path. There is no artificial output-token limit: generation runs until EOS, Stop, a
physical context limit, or a repeated token loop. Repetition detection examines
exact suffix periods 1–32 with at least 32 tokens and six cycles; output is never rewritten.
A native `finish_reason: "length"` is surfaced as context exhaustion even when the
stream resolves normally. Partial answer and reasoning text remain visible; the
error action starts a New Chat and resets the existing model without downloading
it again. This is separate from the removed arbitrary output-token limit.
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
keeping loading controls available. The Enter chat control appears only when the
model reaches ready while a Snake game is open. Arrow/WASD controls work globally
while playing, without canvas focus. Editable controls, Tab and Escape remain
available; Pause, chat entry, deactivation and destruction release game input.
Resizing translates/scales the existing board without losing the snake or score.
When the model reaches ready with no Snake game open, the chat enters
automatically and focuses the composer; the ready transition never forces the
user out of an open game.

Worker failure is terminal for its native bridge: pending and future requests
reject, late messages are ignored, and cancellation never waits on a dead worker.
This lets generation settle so Stop, New Chat, and model reload can recover rather
than remaining queued behind unfinished inference. The `.4` native bridge
regression uses the shipped transport and response cleanup with a silent failed
worker; it does not copy their implementation into a standalone reproduction.

## UI and rendering

The public name is **LLM Rumen Cannula**; `#local-assistant` remains a stable route.
The presentation follows the other Utilities: one shared title, white surfaces,
thin rules and bold JetBrains Mono for model identity. User messages use ordinary
sentence typography on a restrained, right-aligned surface. The duplicate
in-tool header, disclaimer, slogans, empty-chat suggestions and permanent telemetry
instructions are removed. New chat sits with Thinking and Send. The closed native
switcher says “Switch utility” without repeating the current tool name.

The observatory links three panels to one captured forward pass. Context attention
connects the query to the strongest measured source positions, with a selector
for the six full-attention layers. A layer-change waterfall retains at most 256
snapshots; hovering previews a pass, selecting pins it, and Live resumes updates.
Keyboard controls and a range input offer the same history inspection. Next Token
shows intermediate word rankings above the final candidate probability bars.

Prompt processing displays actual progress before any decode snapshots exist.
Captures occur before render throttling so fast generation does not skip history
columns. Snapshot history clears for each new turn, reset, or model reload. Context
tokens are shared rather than copied into every snapshot. Larger viewports expose
more history and candidates; laptop layouts keep all three panels visible.

Thinking is collapsed initially and uses a braille state indicator, frozen under
reduced motion. Thinking content keeps a restrained rule rather than a large
tinted card. Copy acknowledges success in its existing label.

The outer workbench stays bounded to the viewport. The transcript is the sole
intentional scrolling region. Observation history and candidate/layer summaries remain
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
upstream transfer and response. The performance trace and [initial loading capture](./screenshots/local-assistant-loading.png) belong to the initial prototype. Updated [model-ready/Snake](./screenshots/local-assistant-ready.png) and [desktop chat](./screenshots/local-assistant-chat.png) screenshots show real-model runs; the desktop chat capture shows the current linked observatory. The [800×600 chat](./screenshots/local-assistant-chat-800x600.png) capture records the preceding UI revision. Current nine-viewport browser fixture screenshots are kept separate under `output/`.


## Deeper observability measurements

The `.3` runtime adds six head-mean attention summaries, 24 layer-change ratios,
and two raw logit-lens checkpoints (after blocks 12 and 20). A bounded 1,136-byte
GPU readback supplies each pass; full hidden vectors and attention matrices do
not cross into JavaScript. The matched JS/WASM artifacts and patch hashes are
recorded in runtime provenance.

On the same Apple M4 Pro, a fresh ABBA comparison measured **38.49 tokens/sec**
with all measurements versus **62.04 tokens/sec** without observation/logprobs,
a **37.97% throughput reduction**. Full capture stays enabled in normal and Slow
modes so the three panels always inspect the same measured pass. This is the
current richer path's cost, not the original 4.55% figure above.
The [real-model browser integration record](./local-assistant-evidence/observatory-depth.json)
checks all six attention layers, 24 change readings, both checkpoints, and pin/Live
selection with the production runtime and a locally served, hash-verified GGUF.

A factual France-capital probe shows the limits and usefulness of the untrained
lens: block 12 emits diffuse multilingual fragments, while block 20 favors
` Paris` (38.37%), `Paris` (19.67%), and `巴黎` (9.02%); final sampling chooses
Paris. These are intermediate decoder projections, not evidence of semantic
concepts at specific layers or a literal record of model reasoning.

## V1 behavior checks

The `.2` runtime verified real Slow pacing at **2.969 tokens/sec**, live on/off
changes, and cancellation during the pacing wait at **0.23 ms**. A native test
completed **1,100 tokens** without a fixed output cap. A separate real in-app
browser run completed **2,037 tokens** with thinking enabled and Slow reporting
3 tokens/sec; see [its recorded UI observations](./local-assistant-evidence/v1-live.json).
These are separate runs from the original throughput benchmark above.

The browser suite checks nine viewport sizes through **3840×2160**, including
populated attention, layer-change and vocabulary-readout fixtures. It checks
shared history selection, live resumption, clearing between turns, compact layout,
one composer focus boundary, and the expanded Snake board. The shared Switch
utility control is checked in every utility for native keyboard access and a
full-size label/caret hit area. Synthetic fixture measurements are not evidence
of real model instrumentation; native verification is recorded separately.

## PR review validation

The review fixes merge current `main` while retaining its SVG Index arrow and
the full utility switcher. The medium CodeQL finding
[`actions/missing-workflow-permissions` (#11)](https://github.com/oliverdougherC/oliverdougherty.com/security/code-scanning/11)
was a missing explicit token policy in the existing deployment workflow, not a
confirmed model-runtime vulnerability. The workflow now grants only
`contents: read`; Cloudflare deployment continues to use its existing dedicated
secret. This follows GitHub's [workflow permissions semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions).
No deployment was performed to validate this change.

The `.4` regression run verified eight failure/recovery cases against the shipped
bridge, plus a real GPU rank-10 draw (`What`, token 3710, probability
0.0424240343272686) retained alongside the top eight. A native probe requesting
128 context tokens received the backend's rounded 256-token allocation, reported
that actual capacity, and completed with `finish_reason: "length"` at 24 prompt
plus 232 generated tokens using `max_tokens: -1`. Reset kept the weights loaded,
cleared the cache, and generated a fresh response. See `verification.json.v4` for
the original distribution and measured termination/recovery record. The `.3`
throughput benchmark was not rerun because the inference graph is unchanged.

The PR-specific CodeQL alert
[`js/shell-command-injection-from-environment` (#16)](https://github.com/oliverdougherC/oliverdougherty.com/security/code-scanning/16)
pointed at the build helper's inline shell wrapper. The SDK path was already a
quoted positional argument, so review did not find the reported interpolation
path. The wrapper now runs a fixed, checked-in shell script instead of `bash -c`.
Regression tests prove that shell syntax in SDK paths and tool arguments remains
literal, and a missing SDK prevents the tool from launching. The native rebuild
was repeated through this helper; no new runtime behavior is introduced.
