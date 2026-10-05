import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Integration verification uses a real GPU and a locally downloaded model.
// It fails instead of silently accepting CPU/SwiftShader execution.
const directory = path.dirname(fileURLToPath(import.meta.url));
const model = process.env.LOCAL_ASSISTANT_MODEL || path.resolve(directory, '../../.codex-tmp/models/Qwen3.5-2B-Q4_K_M.gguf');
const routes = new Map([
  ['/model.gguf', [model, 'application/octet-stream']],
  ['/runtime.js', [path.join(directory, 'dist/index.js'), 'text/javascript']],
  ['/wllama.wasm', [path.join(directory, 'dist/wllama.wasm'), 'application/wasm']],
]);
const logs = [];
const server = createServer((request, response) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Local Assistant runtime verification</title><p>Verifying local WebGPU inference.</p>');
    return;
  }
  const file = routes.get(request.url);
  if (!file) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', file[1]);
  response.setHeader('Content-Length', statSync(file[0]).size);
  createReadStream(file[0]).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await browser.newPage();
  page.on('console', (message) => logs.push(message.text()));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async ({ benchmark, v1, v3, controlsOnly, unicode, sampling, contextLimit }) => {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter || adapter.info.isFallbackAdapter) throw new Error('A hardware WebGPU adapter is required');
    const gpu = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, fallback: adapter.info.isFallbackAdapter };
    const { Wllama } = await import('/runtime.js');
    const model = await (await fetch('/model.gguf', { cache: 'no-store' })).blob();
    const runtime = new Wllama({ default: '/wllama.wasm' });
    runtime.setCompat(null);
    const load = { observatory: true, n_gpu_layers: 99999, n_parallel: 1, n_ctx: 2048, n_batch: 128, n_ubatch: 128, n_threads: 2, seed: 42, reasoning: true, jinja: true, warmup: false };
    await runtime.loadModel([model], load);
    const metadata = runtime.getModelMetadata();
    const tokenization = await runtime.tokenize('Hello, world!');
    const generate = async (maximum, thinking) => {
      const chunks = [];
      await runtime.createChatCompletion({
        messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
        chat_template_kwargs: { enable_thinking: thinking }, temperature: 0.6,
        top_k: 20, top_p: 0.95, min_p: 0, max_tokens: maximum, logprobs: true,
        top_logprobs: 8, post_sampling_probs: true, return_tokens: true,
        timings_per_token: true, stream: true, onData: (chunk) => chunks.push(chunk),
      });
      return chunks;
    };
    const one = await generate(1, false);
    await runtime.resetConversation();
    const several = await generate(8, false);
    await runtime.resetConversation();
    const thinking = await generate(16, true);
    const deep = {};
    if (v3) {
      for (const [name, prompt] of [['short', 'Hi'], ['france', 'What is the capital of France? Answer with just the city name.']]) {
        await runtime.resetConversation();
        const chunks = [];
        await runtime.createChatCompletion({
          messages: [{ role: 'user', content: prompt }], chat_template_kwargs: { enable_thinking: false },
          temperature: 0.6, top_k: 20, top_p: 0.95, min_p: 0, max_tokens: 12,
          logprobs: true, top_logprobs: 8, post_sampling_probs: true,
          return_tokens: true, timings_per_token: true, return_progress: true,
          stream: true, onData: (chunk) => chunks.push(chunk),
        });
        deep[name] = chunks;
      }
    }
    let unicodeResult;
    if (unicode) {
      await runtime.resetConversation();
      runtime.setSlowMode(true);
      const tokens = await runtime.tokenize('👩🏽‍🚀');
      const chunks = [];
      await runtime.createChatCompletion({
        messages: [{ role: 'user', content: 'Output only this exact character sequence, with no explanation: 👩🏽‍🚀' }],
        chat_template_kwargs: { enable_thinking: false }, temperature: 0, max_tokens: 32,
        logprobs: true, top_logprobs: 8, post_sampling_probs: true, return_tokens: true,
        return_progress: true, timings_per_token: true, stream: true,
        onData: (chunk) => chunks.push({ ...chunk, received: performance.now() }),
      });
      unicodeResult = { tokenizer: tokens, chunks };
      runtime.setSlowMode(false);
    }
    const controls = {};
    if (v1 || controlsOnly) {
      const untilStopped = async (target, slow, toggle = false, delayedStop = false) => {
        await runtime.resetConversation();
        runtime.setSlowMode(slow);
        const abort = new AbortController();
        const tokens = [];
        let stoppedAt = 0;
        let prompt;
        try {
          await runtime.createChatCompletion({
            messages: [{ role: 'user', content: 'Explain how rain forms in detail, step by step, for a curious student.' }],
            chat_template_kwargs: { enable_thinking: true }, temperature: 0.6,
            top_k: 20, top_p: 0.95, min_p: 0, max_tokens: -1, ignore_eos: true,
            logprobs: true, top_logprobs: 8, post_sampling_probs: true,
            return_tokens: true, timings_per_token: true, return_progress: true,
            abortSignal: abort.signal, stream: true, onData: (chunk) => {
              if (chunk.prompt_progress && !prompt) prompt = chunk;
              if (!chunk.observatory?.token) return;
              tokens.push({ time: performance.now(), generated: chunk.observatory.generated, pass: chunk.observatory.pass });
              if (toggle && tokens.length === 3) runtime.setSlowMode(false);
              if (toggle && tokens.length === 6) runtime.setSlowMode(true);
              if (delayedStop && tokens.length === 1) setTimeout(() => { stoppedAt = performance.now(); abort.abort(); }, 50);
              if (tokens.length === target) { stoppedAt = performance.now(); abort.abort(); }
            },
          });
        } catch (error) { if (!abort.signal.aborted) throw error; }
        return { tokens, prompt, stopLatencyMs: performance.now() - stoppedAt };
      };
      controls.slow = await untilStopped(8, true);
      controls.toggle = await untilStopped(8, true, true);
      controls.stop = await untilStopped(8, true, false, true);
      if (v1) controls.unlimited = await untilStopped(1100, false);
      runtime.setSlowMode(false);
    }
    await runtime.exit();
    let selectedCandidate;
    if (sampling) {
      const sampler = new Wllama({ default: '/wllama.wasm' });
      sampler.setCompat(null);
      await sampler.loadModel([model], { ...load, n_ctx: 512, seed: undefined });
      for (let seed = 1; seed <= 160 && !selectedCandidate; seed++) {
        await sampler.resetConversation();
        await sampler.createChatCompletion({
          messages: [{ role: 'user', content: 'Give me one surprising word.' }],
          chat_template_kwargs: { enable_thinking: false }, seed, temperature: 5,
          top_k: 20, top_p: 1, min_p: 0, max_tokens: 1, logprobs: true, top_logprobs: 20,
          post_sampling_probs: true, return_tokens: true, timings_per_token: true,
          stream: true, onData: (chunk) => {
            const event = chunk.observatory;
            const native = chunk.choices?.[0]?.logprobs?.content?.[0];
            const distribution = native?.top_probs;
            if (!event?.token || !distribution) return;
            const rank = distribution.findIndex(({ id }) => id === event.token.id) + 1;
            if (rank === 10) selectedCandidate = { seed, temperature: 5, topK: 20, rank,
              token: event.token, candidates: event.candidates, nativeSelectedProbability: native.prob,
              nativeTop20: distribution };
          },
        });
      }
      await sampler.exit();
    }
    let contextBoundary;
    if (contextLimit) {
      const limited = new Wllama({ default: '/wllama.wasm' });
      limited.setCompat(null);
      await limited.loadModel([model], { ...load, n_ctx: 128, n_batch: 64, n_ubatch: 32, ctx_shift: false });
      const chunks = [];
      await limited.createChatCompletion({
        messages: [{ role: 'user', content: 'Count upward, one number per line, starting at one.' }],
        chat_template_kwargs: { enable_thinking: false }, temperature: 0.6, top_k: 20, top_p: 0.95,
        max_tokens: -1, ignore_eos: true, logprobs: true, top_logprobs: 8,
        post_sampling_probs: true, return_tokens: true, timings_per_token: true,
        stream: true, onData: (chunk) => chunks.push(chunk),
      });
      const lastToken = chunks.filter((chunk) => chunk.observatory?.token).at(-1);
      const final = chunks.at(-1);
      const retained = limited.isModelLoaded();
      await limited.resetConversation();
      const recovered = [];
      await limited.createChatCompletion({ messages: [{ role: 'user', content: 'Say hello.' }],
        chat_template_kwargs: { enable_thinking: false }, max_tokens: 8, stream: true,
        timings_per_token: true, onData: (chunk) => recovered.push(chunk) });
      contextBoundary = { requestedContext: 128, context: limited.getLoadedContextInfo().n_ctx, maxTokens: -1, finishReason: final.choices[0].finish_reason,
        generated: final.timings.predicted_n, promptTokens: final.timings.prompt_n,
        contextUsed: lastToken.observatory.context_used, retainedModel: retained,
        resetCacheTokens: recovered.at(-1).timings.cache_n,
        recoveredText: recovered.flatMap(({ choices }) => choices.map(({ delta }) => delta.content || '')).join('') };
      await limited.exit();
    }
    // Exit before the capability/worker initialization await resolves.
    const interrupted = new Wllama({ default: '/wllama.wasm' });
    interrupted.setCompat(null);
    const pending = interrupted.loadModel([model], load).then(() => 'loaded', () => 'cancelled');
    await interrupted.exit();
    const cancelled = await pending;
    const measurements = [];
    if (benchmark) {
      for (const observatory of [true, false, false, true]) {
        const measured = new Wllama({ default: '/wllama.wasm' });
        measured.setCompat(null);
        await measured.loadModel([model], { ...load, observatory });
        for (let repetition = -1; repetition < 3; repetition++) {
          await measured.resetConversation();
          let last;
          await measured.createChatCompletion({
            messages: [{ role: 'user', content: 'Explain how rain forms, step by step, for a curious student.' }],
            chat_template_kwargs: { enable_thinking: true }, temperature: 0.6,
            top_k: 20, top_p: 0.95, min_p: 0, max_tokens: repetition < 0 ? 32 : 128,
            logprobs: observatory, top_logprobs: observatory ? 8 : undefined,
            post_sampling_probs: true, return_tokens: true, timings_per_token: true,
            stream: true, onData: (chunk) => { last = chunk; },
          });
          if (repetition >= 0) measurements.push({ observatory, repetition, ...last.timings });
        }
        await measured.exit();
      }
    }
    return { gpu, metadata: metadata.hparams, tokenization, one, several, thinking, cancelled, measurements, controls, deep, unicodeResult, selectedCandidate, contextBoundary };
  }, { benchmark: process.argv.includes('--benchmark'), v1: process.argv.includes('--v1'), v3: process.argv.includes('--v3'), controlsOnly: process.argv.includes('--controls'), unicode: process.argv.includes('--unicode'), sampling: process.argv.includes('--sampling'), contextLimit: process.argv.includes('--context-limit') });
  assert(logs.some((line) => /offloaded (\d+)\/\1 layers to GPU/.test(line)), 'all layers must be offloaded');
  assert.equal(result.cancelled, 'cancelled', 'exit invalidates pending initialization');
  assert.deepEqual(result.tokenization.map(({ id }) => id), [9419, 11, 1814, 0]);
  const observations = result.several.filter((chunk) => chunk.observatory?.token).map((chunk) => chunk.observatory);
  assert(observations.length > 1);
  assert(result.several[0].observatory.prompt_tokens.some(({ piece }) => piece === '<|im_start|>'));
  assert.equal(result.several[0].prompt_progress.processed, 0, 'tokenization arrives before prefill');
  for (const observation of observations) {
    assert.equal(observation.layer_backend, 'WebGPU', 'reduced statistics stay on the GPU until the small readback');
    assert.equal(observation.layers.length, result.metadata.nLayer);
    assert(observation.layers.every(({ rms }) => Number.isFinite(rms) && rms >= 0));
    assert.equal(observation.probability_kind, 'post-sampling');
    assert(Number.isInteger(observation.token.id));
    assert(observation.candidates.every(({ probability }) => probability >= 0 && probability <= 1));
    assert(observation.candidates.some(({ id }) => id === observation.token.id), 'sampled token remains visible');
    assert(observation.candidates.length <= 9);
  }
  const first = result.one.find((chunk) => chunk.observatory?.token).observatory;
  assert.deepEqual(first.token, observations[0].token);
  assert.deepEqual(first.layers, observations[0].layers, 'token statistics must not drift to a later queued pass');
  assert.equal(result.several.at(-1).timings.cache_n, 0, 'reset clears server prompt cache');
  assert(result.thinking.some((chunk) => chunk.choices.some(({ delta }) => delta.reasoning_content)), 'thinking uses the native chat template');
  let deepSummary;
  if (result.deep.short) {
    const samples = {};
    for (const [name, chunks] of Object.entries(result.deep)) {
      const count = chunks[0].observatory.prompt_tokens.length;
      const snapshots = chunks.filter((chunk) => chunk.observatory?.token).map((chunk) => chunk.observatory);
      for (const sample of snapshots) {
        assert.equal(sample.layers.length, 24);
        assert.equal(sample.layer_changes.length, 24);
        assert.equal(sample.attention.length, 6);
        assert.equal(sample.lens.length, 2);
        for (let i = 0; i < 24; i++) {
          const change = sample.layer_changes[i], rms = sample.layers[i].rms;
          assert(Number.isFinite(change.relative_delta) && change.relative_delta >= 0);
          assert(Math.abs(change.relative_delta - change.delta_rms / Math.max(change.input_rms, 1e-12)) < 1e-4);
          assert(change.delta_rms <= rms + change.input_rms + 1e-4, 'residual change obeys the norm triangle inequality');
          assert(change.delta_rms + 1e-4 >= Math.abs(rms - change.input_rms));
        }
        for (const attention of sample.attention) {
          assert.equal(attention.query_position, count + sample.generated - 2, 'attention belongs to the pass predicting this token');
          assert.equal(attention.key_count, attention.query_position + 1);
          assert.equal(attention.head_count, 8);
          assert(attention.entries.length > 0 && attention.entries.length <= 16);
          assert(attention.coverage > 0 && attention.coverage <= 1.001);
          assert(Math.abs(attention.coverage - attention.entries.reduce((sum, entry) => sum + entry.weight, 0)) < 1e-6);
          assert(attention.entries.every(({ position, weight }) => position >= 0 && position <= attention.query_position && weight > 0 && weight <= 1));
          if (attention.key_count <= 16) assert(Math.abs(attention.coverage - 1) < 1e-4, 'all valid keys retain normalized mass');
        }
        assert.deepEqual(sample.lens.map(({ layer }) => layer), [11, 19]);
        for (const lens of sample.lens) {
          assert.equal(lens.candidates.length, 5);
          assert(lens.candidates.every(({ id, probability }) => Number.isInteger(id) && id >= 0 && id < result.metadata.nVocab && probability > 0 && probability <= 1));
          assert(lens.candidates.reduce((sum, candidate) => sum + candidate.probability, 0) <= 1.001);
          assert(lens.candidates.every((candidate, i) => i === 0 || candidate.probability <= lens.candidates[i - 1].probability));
        }
      }
      samples[name] = { promptTokens: count, output: chunks.flatMap(({ choices }) => choices.map(({ delta }) => delta.content || '')).join(''),
        snapshots: snapshots.slice(0, 5).map(({ generated, token, lens, candidates, attention, layer_backend }) => ({ generated, token, lens, final: candidates, attention, layer_backend })) };
    }
    assert(/paris/i.test(samples.france.output));
    deepSummary = { verified: true, packedReadbackBytes: 1136, samples };
  }
  let controlSummary;
  if (result.controls.slow) {
    const { slow, toggle, stop, unlimited } = result.controls;
    const intervals = slow.tokens.slice(1).map((token, i) => token.time - slow.tokens[i].time);
    const tokensPerSecond = 1000 * intervals.length / intervals.reduce((a, b) => a + b, 0);
    assert(tokensPerSecond > 2.5 && tokensPerSecond < 3.4, 'Slow paces the actual inference pull loop near 3 tokens/sec');
    assert(toggle.tokens[3].time - toggle.tokens[2].time < 220, 'Slow can be disabled during a request');
    assert(toggle.tokens[6].time - toggle.tokens[5].time > 250, 'Slow can be enabled during a request');
    assert(stop.stopLatencyMs < 200, 'Stop interrupts the pacing wait');
    assert.equal(stop.tokens.length, 1, 'Stop does not drain a generated backlog');
    if (unlimited) {
      assert.equal(unlimited.tokens.length, 1100, 'unlimited output passes the retired 1024-token limit');
      assert.equal(unlimited.tokens.at(-1).generated, 1100);
    }
    assert.equal(slow.prompt.prompt_progress.processed, 0);
    assert(!slow.prompt.observatory.generated, 'prefill does not count as a generated token');
    controlSummary = { slowTokensPerSecond: tokensPerSecond, slowIntervalsMs: intervals,
      stopLatencyMs: stop.stopLatencyMs, tokensBeforeStop: stop.tokens.length,
      unlimitedTokens: unlimited?.tokens.length, liveToggle: true, earlyTokenization: true };
  }
  let unicodeSummary;
  if (result.unicodeResult) {
    const { chunks, tokenizer } = result.unicodeResult;
    assert(tokenizer.some(({ piece }) => piece.includes('�')), 'fixture includes byte-fragment tokenizer pieces');
    const observed = chunks.filter((chunk) => chunk.observatory?.token);
    const count = chunks.at(-1).timings.predicted_n;
    assert.deepEqual(observed.map((chunk) => chunk.observatory.generated), Array.from({ length: count }, (_, i) => i + 1), 'every sampled byte fragment is observed');
    const text = chunks.flatMap(({ choices }) => choices.map(({ delta }) => delta.content || '')).join('');
    assert(text.includes('👩🏽‍🚀') && !text.includes('�'), 'normal text buffering preserves Unicode');
    const intervals = observed.slice(1).map((chunk, i) => chunk.received - observed[i].received);
    assert(intervals.every((interval) => interval > 250), 'Slow paces incomplete UTF-8 tokens too');
    unicodeSummary = { output: text, generated: count, observed: observed.length, intervalsMs: intervals };
  }
  if (process.argv.includes('--sampling')) {
    const sampled = result.selectedCandidate;
    assert(sampled, 'find a real rank-10 draw from the actual top-k=20 sampler');
    assert.equal(sampled.rank, 10);
    assert.equal(sampled.candidates.length, 9);
    const chosen = sampled.candidates.find(({ id }) => id === sampled.token.id);
    assert(chosen);
    assert(chosen.probability > 0);
    assert.equal(chosen.probability, sampled.nativeSelectedProbability);
    assert.equal(chosen.probability, sampled.nativeTop20[9].prob);
    assert.deepEqual(sampled.candidates.slice(0, 8).map(({ id }) => id), sampled.nativeTop20.slice(0, 8).map(({ id }) => id));
    assert(sampled.candidates.every((candidate, i) => i === 0 || candidate.probability <= sampled.candidates[i - 1].probability));
  }
  if (process.argv.includes('--context-limit')) {
    const boundary = result.contextBoundary;
    assert.equal(boundary.finishReason, 'length');
    assert.equal(boundary.contextUsed, boundary.context);
    assert.equal(boundary.promptTokens + boundary.generated, boundary.context);
    assert(boundary.context >= boundary.requestedContext);
    assert(boundary.generated > 0 && boundary.generated < boundary.context);
    assert(boundary.retainedModel);
    assert.equal(boundary.resetCacheTokens, 0);
    assert(boundary.recoveredText.length > 0);
  }
  console.log(JSON.stringify({ passed: true, browserVersion: browser.version(), gpu: result.gpu, layers: result.metadata.nLayer, observations: observations.length, reset: true, tokenAlignment: true, cancelledInitialization: true, controls: controlSummary, deep: deepSummary, unicode: unicodeSummary, selectedCandidate: result.selectedCandidate, contextBoundary: result.contextBoundary, measurements: result.measurements }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
