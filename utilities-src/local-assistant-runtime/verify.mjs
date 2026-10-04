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
  const result = await page.evaluate(async (benchmark) => {
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
    await runtime.exit();
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
    return { gpu, metadata: metadata.hparams, tokenization, one, several, thinking, cancelled, measurements };
  }, process.argv.includes('--benchmark'));
  assert(logs.some((line) => /offloaded (\d+)\/\1 layers to GPU/.test(line)), 'all layers must be offloaded');
  assert.equal(result.cancelled, 'cancelled', 'exit invalidates pending initialization');
  assert.deepEqual(result.tokenization.map(({ id }) => id), [9419, 11, 1814, 0]);
  const observations = result.several.filter((chunk) => chunk.observatory).map((chunk) => chunk.observatory);
  assert(observations.length > 1);
  assert(observations[0].prompt_tokens.some(({ piece }) => piece === '<|im_start|>'));
  for (const observation of observations) {
    assert.equal(observation.layer_backend, 'WebGPU', 'reduced statistics stay on the GPU until the small readback');
    assert.equal(observation.layers.length, result.metadata.nLayer);
    assert(observation.layers.every(({ rms }) => Number.isFinite(rms) && rms >= 0));
    assert.equal(observation.probability_kind, 'post-sampling');
    assert(Number.isInteger(observation.token.id));
    assert(observation.candidates.every(({ probability }) => probability >= 0 && probability <= 1));
  }
  const first = result.one.find((chunk) => chunk.observatory).observatory;
  assert.deepEqual(first.token, observations[0].token);
  assert.deepEqual(first.layers, observations[0].layers, 'token statistics must not drift to a later queued pass');
  assert.equal(result.several.at(-1).timings.cache_n, 0, 'reset clears server prompt cache');
  assert(result.thinking.some((chunk) => chunk.choices.some(({ delta }) => delta.reasoning_content)), 'thinking uses the native chat template');
  console.log(JSON.stringify({ passed: true, browserVersion: browser.version(), gpu: result.gpu, layers: result.metadata.nLayer, observations: observations.length, reset: true, tokenAlignment: true, cancelledInitialization: true, measurements: result.measurements }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
