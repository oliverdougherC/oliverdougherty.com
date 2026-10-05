# Instrumented browser runtime

This directory vendors a focused extension of **wllama 3.8.1**, built from commit
`7ed17361caf221a84aa1e80ca85a3d6324f3af85` and its llama.cpp submodule
`46ca246de9bb1c35269722a6240d37d9dfd79cad`. It uses the existing llama.cpp WebGPU
backend, with WebAssembly64/JSPI for control and native sampling. It is a Chromium
prototype build; the application must disable wllama's automatic CDN compatibility
runtime with `setCompat(null)` and reject unsupported browsers before loading.

The checked-in `dist/index.js` and `dist/wllama.wasm` are a matched pair. Do not
replace either with the npm/CDN version independently. `provenance.json` records
the exact source/toolchain revisions and shipped file sizes/SHA-256 digests.

## Build and verify

From the repository root:

```sh
node scripts/build-local-assistant-runtime.mjs
node utilities-src/local-assistant-runtime/verify.mjs
# Optional: repeat the ABBA throughput comparison after the correctness checks.
node utilities-src/local-assistant-runtime/verify.mjs --benchmark
# Verify live Slow/Stop controls and an uncapped 1,100-token generation.
node utilities-src/local-assistant-runtime/verify.mjs --v1
# Validate bounded attention/delta/lens telemetry, live controls, and UTF-8 tokens.
node utilities-src/local-assistant-runtime/verify.mjs --v3 --controls --unicode
```

The build requires Git, Node/npm, Python, CMake, Ninja, curl, and unzip. It downloads
its pinned Emscripten SDK and upstream source under `.codex-tmp/`; it does not
install system software. It applies the two small source patches, regenerates the
binary bridge, builds the WebGPU WASM, bundles JS, typechecks the declarations,
and updates provenance. Existing conflicting source edits are preserved and cause
an explicit error. Optional `LOCAL_ASSISTANT_WLLAMA_SOURCE` and
`LOCAL_ASSISTANT_EMSDK` paths reuse already verified checkouts.

The integration verifier requires installed Chrome and a real WebGPU adapter.
It reads the model from `.codex-tmp/models/Qwen3.5-2B-Q4_K_M.gguf`, or from
`LOCAL_ASSISTANT_MODEL`. It serves only three local artifacts on a temporary
loopback port, checks full GPU offload, real tokenizer output, per-layer values,
token/snapshot alignment, thinking, reset, and disposal during initialization.
It deliberately fails when no hardware WebGPU device is available.

## Native observation contract

Call `loadModel([blob], { observatory: true, n_parallel: 1, ... })`.
The application downloads the Blob with `cache: 'no-store'`; it must not use
`loadModelFromUrl`, `ModelManager`, or `CacheManager`, which can persist weights.
Request `logprobs: true`, `top_logprobs: 8`, `post_sampling_probs: true`,
`return_tokens: true`, and `timings_per_token: true` for streamed completions.

Each relevant stream chunk includes `observatory`:

```ts
{
  prompt_tokens?: Array<{ id: number; piece: string }>;
  token?: { id: number; piece: string };
  candidates?: Array<{ id: number; piece: string; probability: number }>;
  probability_kind?: 'post-sampling' | 'model-softmax';
  layers?: Array<{ layer: number; rms: number }>;
  layer_changes?: Array<{ layer: number; input_rms: number; delta_rms: number; relative_delta: number }>;
  attention?: Array<{
    layer: number; query_position: number; key_count: number; head_count: number;
    entries: Array<{ position: number; weight: number }>; coverage: number;
  }>;
  lens?: Array<{ layer: number; candidates: Array<{ id: number; piece: string; probability: number }> }>;
  layer_backend?: string;
  generated?: number;
  context_used?: number;
  pass?: number;
}
```

Prompt tokens come from the runtime's actual tokenizer **after** the model's Jinja
template has formatted the request, including control tokens. An initial stream
event returns them before the first prefill graph runs, with actual prompt total
and zero processed tokens. Subsequent `prompt_progress` events report native
prefill work; they do not increment the generated-token count. Candidate IDs and
weights come from the actual native sampler. Top-eight weights are a subset of
the full distribution, so they need not sum to one. The runtime distinguishes
post-sampler weights from pre-sampling model softmax probabilities.

`layers` describes the residual stream after each Qwen3.5 block for the last token
in that forward-pass microbatch. For a generated token, this is the pass that
predicted it; the newly sampled token has not yet been processed. The graph computes
`sqrt(sum(x²) / n_embedding)`.
SQR, SUM, SCALE, CONCAT, and CONT are supported WebGPU operations in this pinned
backend. The reductions run immediately after their blocks so full activation
buffers need not stay alive. `layer_changes` additionally measures the RMS of
the block input and the RMS of `output − input`; `relative_delta` divides the
latter by input RMS (with a 1e-12 denominator floor). It measures the size of the
residual update, not whether the layer improved the answer or caused a token.

All summaries are concatenated into **284 float32 values (1,136 bytes) per pass
for 2B**: 288 bytes for layer magnitudes, 768 bytes for attention, and 80 bytes
for two lens checkpoints. The CPU takes square roots of reduced mean squares,
resolves token pieces, and maps cache rows to logical positions. No full hidden
state, attention matrix, or full vocabulary vector crosses the observation bridge.
The native buffer type is exposed as `layer_backend`; the integration verifier
requires it to be `WebGPU`.

### Attention connections

For each of the six full-attention blocks, an auxiliary GPU branch recomputes
only the last query's dot products using the actual normalized/RoPE query,
cached keys, attention scale, and causal mask. This preserves the original
FlashAttention inference path. Softmax is taken over all keys for each query
head; the eight query-head distributions are averaged arithmetically. The GPU
then selects the largest sixteen entries. Their weights remain from the full
normalized distribution; the subset is **not renormalized**. `coverage` is their
sum, and `key_count` counts actual valid sequence keys.

`query_position` and each returned `position` are zero-based logical sequence
positions, resolved from the actual hybrid KV cache's cell metadata. Physical
cache row indices are never assumed to equal token positions. For the token
being sampled, the query is the preceding processed token. This is a recomputed
attention distribution derived from runtime tensors; small numerical differences
from a fused FlashAttention kernel are possible. It is not a causal-importance
score, and it says nothing about the intervening DeltaNet blocks.

### Intermediate logit lens

Checkpoints follow blocks at one-half and five-sixths of model depth: zero-based
layers **11 and 19** for 2B. Their last-token residual vectors are passed through
the model's actual final RMS norm (including learned weights), then the actual
output projection and scale. A full-vocabulary softmax is computed on GPU and
only the five largest IDs/probabilities are retained. These are **raw logit-lens
probabilities**, not the configured sampler distribution and not an assertion
that an intermediate layer has already decided on a token.

The untuned readout can be diffuse or unintuitive at earlier checkpoints. For
the recorded France prompt, layer 11's leading probability was only 0.92%, over
multilingual fragments; layer 19 assigned 38.37% to ` Paris`, 19.67% to `Paris`,
and 9.02% to `巴黎`. The actual final sampler selected `Paris`. These are the
measured outputs, not a curated or substituted progression.

Lens capture is enabled by default on every observed pass. The internal load
option `observatory_lens: false` can omit these two expensive projection branches
for focused measurements; it does not silently reuse old lens values. The site
keeps full capture enabled in both Fast and Slow modes.

### Alignment and lifecycle

The server captures the small packet alongside the sampled token before queuing
the result. This prevents a later forward pass from replacing the displayed
token's statistics. Every sampled-token result includes its captured packet,
even if a prefill-progress event previously exposed the same pass. A token with
no visible text delta still produces telemetry, including incomplete UTF-8 byte
fragments; native text buffering continues until a complete character exists.
Prefill summaries refer to the final token of each reported microbatch, not every
prompt token. `pass` counts graph evaluations, not generated tokens.

`context_used` is prompt-token count plus sampled-token count. It is sequence
accounting, not a measured byte count or a claim that the just-sampled token has
already entered the KV cache. RMS is not attention, a recurrent-state measurement,
or a measure of a neuron's importance. This prototype does not expose DeltaNet
state tensors or a complete attention matrix.

Token IDs are exact. Individual BPE pieces can end inside a UTF-8 character;
display strings replace incomplete UTF-8 bytes rather than failing JSON encoding.
The normal text stream is assembled by llama.cpp and retains complete Unicode.

`tokenize(text, { addSpecial?, parseSpecial? })` exposes native tokenization for
bounded inspection. `resetConversation()` cancels readers, erases server-slot
prompt caches, and clears native KV/recurrent memory while preserving weights.
`exit()` invalidates pending initialization, rejects pending worker RPCs, clears
model Blob references, terminates the worker, and revokes its object URL.

`setSlowMode(true)` applies immediately to the active request. It paces requests
to the native `get_result` action at approximately three decoded tokens per second.
That action advances one native inference-loop iteration; while the host awaits
the next pull, the worker does not run ahead generating hidden text. Existing
native result buffering is bounded, and no token-playback queue is introduced.
Prefill remains unpaced. Stop, disposal, and switching Slow off interrupt the
wait immediately. RMS, sampler values, and visible text arrive together from
the same native token result. This is inference backpressure, not a visual timer.

The application sends `max_tokens: -1`: generation ends at a model stop token,
explicit Stop, genuine context exhaustion, or a detected repeating-token loop.
There is no separate 1,024-token response limit. Physical context remains finite
and context shifting stays disabled.

Set `observatory: false` and omit logprobs to measure the minimal path using the
same weights, sampler, runtime, and GPU. This skips all additional reduction nodes
and telemetry. It is not a separate CPU backend.

## Verified hardware and limits

`verification.json` records the 2026-10-04 Apple M4 Pro measurements. Headed Chrome
reported the Apple `metal-3` hardware adapter, with `isFallbackAdapter: false`;
llama.cpp logged **25/25 layers offloaded to GPU**. At 2K context, actual runtime
logs reported 1211.05 MiB model buffers, 24 MiB KV buffers, and 19.27 MiB recurrent
state buffers. These are runtime allocation reports, not an exact-VRAM estimate.

The comparison used an ABBA load order, one 32-token warmup per load, and three
128-token runs per load, resetting the context between runs. All twelve runs
used the same prompt, seed, sampler, 2K context, and two WASM host threads. The
observed .3 path included layer RMS/change, head-mean attention, both lens
checkpoints, and top-eight sampler telemetry; the baseline disabled all
observation branches and logprobs. Mean decode throughput was **38.49 tokens/s
observed versus 62.04 tokens/s baseline**, a **37.97% throughput reduction**.
The six-run ranges were 38.06–38.84 and 60.74–62.87 tokens/s respectively. This
cost is substantial, especially the additional output projections, and is
accepted for the educational observatory. Full telemetry remains enabled rather
than displaying stale or fabricated intermediate values. Earlier .1/.2 results
remain explicitly versioned in the verification record. These workstation measurements are illustrative, not a universal
overhead guarantee. They do not cover discrete GPUs or the compatibility runtime.

Qwen3.5-4B uses the same architecture path, and the reduction count follows the
loaded graph. It remains unvalidated: no 4B support is claimed or exposed here.

Upstream references: [wllama 3.8.1](https://github.com/ngxson/wllama/releases/tag/3.8.1),
[WebGPU backend source](https://github.com/ggml-org/llama.cpp/blob/46ca246de9bb1c35269722a6240d37d9dfd79cad/ggml/src/ggml-webgpu/ggml-webgpu.cpp),
[Qwen3.5 graph](https://github.com/ggml-org/llama.cpp/blob/46ca246de9bb1c35269722a6240d37d9dfd79cad/src/models/qwen35.cpp).
