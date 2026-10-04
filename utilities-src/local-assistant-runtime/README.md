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
  layer_backend?: string;
  generated?: number;
  context_used?: number;
  pass?: number;
}
```

Prompt tokens come from the runtime's actual tokenizer **after** the model's Jinja
template has formatted the request, including control tokens. Candidate IDs and
weights come from the actual native sampler. Top-eight weights are a subset of
the full distribution, so they need not sum to one. The runtime distinguishes
post-sampler weights from pre-sampling model softmax probabilities.

`layers` describes the residual stream after each Qwen3.5 block for the last token
in that forward-pass microbatch. For a generated token, this is the pass that
predicted it; the newly sampled token has not yet been processed. The graph computes
`sqrt(sum(x²) / n_embedding)`.
SQR, SUM, SCALE, CONCAT, and CONT are supported WebGPU operations in this pinned
backend. The reductions run immediately after their blocks so full activation
buffers need not stay alive. One final vector is read back: **24 float32 values
(96 bytes) per pass for 2B**. The CPU takes the square root of those reduced
values. No full hidden-state tensor crosses the observation bridge.
The native buffer type is exposed as `layer_backend`; the integration verifier
requires it to be `WebGPU`.

The server captures that small vector alongside the sampled token before queuing
the result. This prevents a later forward pass from replacing the displayed
token's statistics. A token with no visible text delta still produces telemetry.
Prefill summaries refer to the final token of each reported microbatch, not every
prompt token. `pass` counts graph evaluations, not generated tokens.

`context_used` is prompt-token count plus sampled-token count. It is sequence
accounting, not a measured byte count or a claim that the just-sampled token has
already entered the KV cache. RMS is not attention, a recurrent-state measurement,
or a measure of a neuron's importance. This prototype does not expose attention
matrices or DeltaNet state tensors.

Token IDs are exact. Individual BPE pieces can end inside a UTF-8 character;
display strings replace incomplete UTF-8 bytes rather than failing JSON encoding.
The normal text stream is assembled by llama.cpp and retains complete Unicode.

`tokenize(text, { addSpecial?, parseSpecial? })` exposes native tokenization for
bounded inspection. `resetConversation()` cancels readers, erases server-slot
prompt caches, and clears native KV/recurrent memory while preserving weights.
`exit()` invalidates pending initialization, rejects pending worker RPCs, clears
model Blob references, terminates the worker, and revokes its object URL.

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
observed path included per-layer RMS and top-eight sampler telemetry; the baseline
disabled both. Mean decode throughput was **60.80 tokens/s observed versus 63.70
tokens/s baseline**, a **4.55% throughput reduction**. The six-run ranges were
60.44–61.21 and 63.43–64.18 tokens/s respectively. These workstation measurements are illustrative, not a universal
overhead guarantee. They do not cover discrete GPUs or the compatibility runtime.

Qwen3.5-4B uses the same architecture path, and the reduction count follows the
loaded graph. It remains unvalidated: no 4B support is claimed or exposed here.

Upstream references: [wllama 3.8.1](https://github.com/ngxson/wllama/releases/tag/3.8.1),
[WebGPU backend source](https://github.com/ggml-org/llama.cpp/blob/46ca246de9bb1c35269722a6240d37d9dfd79cad/ggml/src/ggml-webgpu/ggml-webgpu.cpp),
[Qwen3.5 graph](https://github.com/ggml-org/llama.cpp/blob/46ca246de9bb1c35269722a6240d37d9dfd79cad/src/models/qwen35.cpp).
