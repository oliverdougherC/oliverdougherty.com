const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
const TRANSFORMERS_RUNTIMES = [
  {
    name: 'Transformers.js 4.2.0',
    url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0'
  },
  {
    name: 'Transformers.js 3.8.1',
    url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1'
  }
];
const SYSTEM_PROMPT = 'You are a tiny local AI assistant. You run entirely in the visitor\'s browser. Be concise, friendly, and honest about limitations. You can answer general questions. Do not claim to have internet access, private data, or server-side tools. If unsure, say so.';
const GENERATION_DEFAULTS = {
  max_new_tokens: 192,
  temperature: 0.6,
  top_p: 0.9,
  do_sample: true,
  repetition_penalty: 1.1
};

let transformersModule = null;
let selectedRuntime = null;
let generator = null;
let loadPromise = null;
let backend = null;
let activeGeneration = 0;

for (const method of ['debug', 'info', 'warn', 'error']) {
  self.console[method] = () => {};
}

self.addEventListener('message', (event) => {
  const message = event.data || {};

  if (message.type === 'load') {
    loadModel();
    return;
  }

  if (message.type === 'generate') {
    generateReply(message.messages || []);
    return;
  }

  if (message.type === 'dispose') {
    disposeModel(message.clearCache === true);
  }
});

async function loadModel() {
  if (generator) {
    postMessage({ type: 'ready', backend, model: MODEL_ID, runtime: selectedRuntime?.name || '' });
    return;
  }

  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = loadModelInternal()
    .catch((error) => {
      postMessage(buildLoadError(error));
      throw error;
    })
    .finally(() => {
      loadPromise = null;
    });

  try {
    await loadPromise;
  } catch {
    // The UI receives a structured error; keep the worker quiet.
  }
}

async function loadModelInternal() {
  postCapabilities();
  const runtimeFailures = [];

  for (const runtime of TRANSFORMERS_RUNTIMES) {
    selectedRuntime = runtime;
    postMessage({ type: 'status', status: 'runtime-import', runtime: runtime.name });

    try {
      transformersModule = await import(runtime.url);
      configureTransformers(transformersModule);
    } catch (error) {
      runtimeFailures.push({ runtime: runtime.name, category: 'runtime-import', message: normalizeError(error) });
      transformersModule = null;
      selectedRuntime = null;
      continue;
    }

    const result = await tryLoadWithRuntime(runtime, runtimeFailures);
    if (result) return;

    await safeDispose();
    transformersModule = null;
    selectedRuntime = null;
  }

  const finalError = new Error('All local runtime paths failed.');
  finalError.failures = runtimeFailures;
  finalError.category = runtimeFailures.at(-1)?.category || 'unsupported';
  throw finalError;
}

function configureTransformers(module) {
  const { env } = module;
  if (!env) return;

  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
}

async function tryLoadWithRuntime(runtime, runtimeFailures) {
  const { pipeline } = transformersModule;
  const webGpuProbe = await probeWebGpu();

  if (webGpuProbe.available) {
    postMessage({ type: 'status', status: 'loading-webgpu', runtime: runtime.name });

    try {
      generator = await pipeline('text-generation', MODEL_ID, {
        device: 'webgpu',
        dtype: 'q4',
        progress_callback: (progress) => postProgress(progress, 'webgpu', runtime.name)
      });
      backend = 'webgpu';
      postMessage({ type: 'ready', backend, model: MODEL_ID, runtime: runtime.name });
      return true;
    } catch (error) {
      runtimeFailures.push({
        runtime: runtime.name,
        backend: 'webgpu',
        category: 'webgpu-failed',
        message: normalizeError(error)
      });
      await safeDispose();
      postMessage({
        type: 'status',
        status: 'backend-fallback',
        runtime: runtime.name,
        message: 'WebGPU could not initialize this model, so I am trying the local CPU path.'
      });
    }
  } else {
    runtimeFailures.push({
      runtime: runtime.name,
      backend: 'webgpu',
      category: 'webgpu-unavailable',
      message: webGpuProbe.reason
    });
  }

  postMessage({
    type: 'status',
    status: 'loading-wasm',
    runtime: runtime.name,
    message: 'Loading local model with WASM/CPU.'
  });

  try {
    // Omitting `device` intentionally selects Transformers.js' browser WASM/CPU backend.
    generator = await pipeline('text-generation', MODEL_ID, {
      dtype: 'q4',
      progress_callback: (progress) => postProgress(progress, 'wasm', runtime.name)
    });
    backend = 'wasm';
    postMessage({ type: 'ready', backend, model: MODEL_ID, runtime: runtime.name });
    return true;
  } catch (error) {
    runtimeFailures.push({
      runtime: runtime.name,
      backend: 'wasm',
      category: 'wasm-failed',
      message: normalizeError(error)
    });
    return false;
  }
}

async function probeWebGpu() {
  if (!self.navigator?.gpu) {
    return { available: false, reason: 'navigator.gpu is unavailable in this worker.' };
  }

  if (typeof self.navigator.gpu.requestAdapter !== 'function') {
    return { available: true, reason: 'navigator.gpu exists but requestAdapter is unavailable.' };
  }

  try {
    const adapter = await self.navigator.gpu.requestAdapter();
    return adapter
      ? { available: true, reason: 'WebGPU adapter available.' }
      : { available: false, reason: 'WebGPU did not return an adapter.' };
  } catch (error) {
    return { available: false, reason: normalizeError(error) || 'WebGPU adapter request failed.' };
  }
}

function postCapabilities() {
  postMessage({
    type: 'capabilities',
    capabilities: {
      secureContext: typeof self.isSecureContext === 'boolean' ? self.isSecureContext : null,
      workerGpu: Boolean(self.navigator?.gpu),
      moduleWorker: true,
      cacheApi: Boolean(self.caches?.open),
      crossOriginIsolated: Boolean(self.crossOriginIsolated),
      userAgent: self.navigator?.userAgent || ''
    }
  });
}

function postProgress(progress, attemptedBackend, runtimeName) {
  const percent = Number.isFinite(progress?.progress) ? Math.max(0, Math.min(100, progress.progress)) : null;
  const status = normalizeProgressStatus(progress?.status);

  postMessage({
    type: 'progress',
    backend: attemptedBackend,
    runtime: runtimeName,
    status,
    file: typeof progress?.file === 'string' ? progress.file : '',
    progress: percent,
    loaded: Number.isFinite(progress?.loaded) ? progress.loaded : null,
    total: Number.isFinite(progress?.total) ? progress.total : null
  });
}

function normalizeProgressStatus(status) {
  if (status === 'progress' || status === 'download') return 'downloading';
  if (status === 'ready' || status === 'done') return 'loading';
  if (typeof status === 'string') return status;
  return 'loading';
}

async function generateReply(messages) {
  const generationId = ++activeGeneration;

  try {
    await loadModel();

    if (!generator || generationId !== activeGeneration) return;

    postMessage({ type: 'status', status: 'generating' });

    const { TextStreamer } = await getTransformers();
    let streamedText = '';
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (token) => {
        streamedText += token;
        postMessage({ type: 'token', token });
      }
    });

    const conversation = compactMessages(messages);
    const output = await generator(conversation, {
      ...GENERATION_DEFAULTS,
      streamer
    });

    if (generationId !== activeGeneration) return;

    const finalText = extractGeneratedText(output, streamedText);
    postMessage({ type: 'complete', text: finalText, backend });
  } catch {
    if (generationId === activeGeneration) {
      postMessage({
        type: 'error',
        status: 'error',
        category: 'generation-failed',
        message: 'The local model stopped unexpectedly.',
        detail: 'The worker stayed alive, but generation failed. This can happen with low memory or very long prompts.',
        likelyFix: 'Reset the chat and try a shorter prompt.'
      });
    }
  }
}

async function getTransformers() {
  if (transformersModule) return transformersModule;
  selectedRuntime = TRANSFORMERS_RUNTIMES[0];
  transformersModule = await import(selectedRuntime.url);
  configureTransformers(transformersModule);
  return transformersModule;
}

function compactMessages(messages) {
  const sanitized = messages
    .filter((message) => message && typeof message.content === 'string')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content.slice(0, 2500)
    }));

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...sanitized.slice(-10)
  ];
}

function extractGeneratedText(output, fallbackText) {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = first?.generated_text;

  if (Array.isArray(generated)) {
    const last = generated[generated.length - 1];
    if (typeof last?.content === 'string') return last.content;
  }

  if (fallbackText.trim()) return fallbackText;
  if (typeof generated === 'string') return generated;
  return fallbackText;
}

async function disposeModel(clearCache) {
  activeGeneration += 1;
  await safeDispose();
  backend = null;

  if (clearCache) await deleteTransformersCaches();

  postMessage({ type: 'disposed' });
}

async function safeDispose() {
  if (!generator) return;

  try {
    await generator.dispose();
  } catch {
    // Disposing is best-effort in a worker reset path.
  } finally {
    generator = null;
  }
}

async function deleteTransformersCaches() {
  if (!self.caches?.keys || !self.caches?.delete) return false;

  try {
    const cacheNames = await self.caches.keys();
    const targets = cacheNames.filter((name) => /transformers|huggingface/i.test(name));
    await Promise.all(targets.map((name) => self.caches.delete(name)));
    await self.caches.delete('transformers-cache');
    return true;
  } catch {
    return false;
  }
}

function buildLoadError(error) {
  const failures = Array.isArray(error?.failures) ? error.failures : [];
  const lastFailure = failures.at(-1) || {};
  const category = error?.category || lastFailure.category || 'unsupported';
  const message = category === 'runtime-import'
    ? 'The local AI runtime could not be loaded.'
    : 'Your browser could not run this local model.';

  return {
    type: 'error',
    status: 'unsupported',
    category,
    message,
    detail: summarizeFailures(failures),
    likelyFix: likelyFixForCategory(category, failures)
  };
}

function summarizeFailures(failures) {
  if (!failures.length) {
    return 'Both WebGPU and WASM/CPU failed before the model became ready.';
  }

  return failures
    .slice(-4)
    .map((failure) => {
      const backendLabel = failure.backend ? ` ${failure.backend}` : '';
      return `${failure.runtime || 'Runtime'}${backendLabel}: ${failure.message || failure.category}`;
    })
    .join(' | ');
}

function likelyFixForCategory(category, failures) {
  const hasOnlyNoWebGpu = failures.some((failure) => failure.category === 'webgpu-unavailable')
    && failures.some((failure) => failure.category === 'wasm-failed');

  if (category === 'runtime-import') {
    return 'Check the WebStorm server, CDN/network access, and content blockers, then retry.';
  }

  if (hasOnlyNoWebGpu) {
    return 'Firefox may need WebGPU support enabled, but the page should still try WASM/CPU. If WASM also fails, try a current Chrome, Edge, or Safari build.';
  }

  if (category === 'wasm-failed') {
    return 'Close memory-heavy tabs and retry, or use a browser with WebGPU available.';
  }

  return 'Retry from localhost or HTTPS in a current desktop browser with enough available memory.';
}

function normalizeError(error) {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.slice(0, 220);
  if (typeof error === 'string') return error.slice(0, 220);
  return 'Unknown error';
}
