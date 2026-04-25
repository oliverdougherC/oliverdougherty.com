const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const SYSTEM_PROMPT = 'You are a tiny local AI assistant. You run entirely in the visitor\'s browser. Be concise, friendly, and honest about limitations. You can answer general questions. Do not claim to have internet access, private data, or server-side tools. If unsure, say so.';
const GENERATION_DEFAULTS = {
  max_new_tokens: 192,
  temperature: 0.6,
  top_p: 0.9,
  do_sample: true,
  repetition_penalty: 1.1
};

let transformersModule = null;
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

async function getTransformers() {
  if (!transformersModule) {
    transformersModule = await import(TRANSFORMERS_CDN);
    const { env } = transformersModule;
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.useBrowserCache = true;
  }

  return transformersModule;
}

async function loadModel() {
  if (generator) {
    postMessage({ type: 'ready', backend, model: MODEL_ID });
    return;
  }

  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = loadModelInternal()
    .catch((error) => {
      postMessage({
        type: 'error',
        status: 'unsupported',
        message: 'This browser could not load the local model. Try a recent Chrome, Edge, or Safari build with enough available memory.'
      });
      throw error;
    })
    .finally(() => {
      loadPromise = null;
    });

  try {
    await loadPromise;
  } catch {
    // The UI receives the friendly error above; avoid noisy worker logging.
  }
}

async function loadModelInternal() {
  const { pipeline } = await getTransformers();
  const supportsWebGpu = Boolean(self.navigator?.gpu);

  postMessage({ type: 'status', status: supportsWebGpu ? 'loading-webgpu' : 'loading-wasm' });

  if (supportsWebGpu) {
    try {
      generator = await pipeline('text-generation', MODEL_ID, {
        device: 'webgpu',
        dtype: 'q4',
        progress_callback: (progress) => postProgress(progress, 'webgpu')
      });
      backend = 'webgpu';
      postMessage({ type: 'ready', backend, model: MODEL_ID });
      return;
    } catch {
      await safeDispose();
      postMessage({
        type: 'status',
        status: 'loading-wasm',
        message: 'WebGPU was unavailable for this model, so I am trying the local CPU path.'
      });
    }
  }

  try {
    // Omitting `device` intentionally selects Transformers.js' browser WASM/CPU backend.
    generator = await pipeline('text-generation', MODEL_ID, {
      dtype: 'q4',
      progress_callback: (progress) => postProgress(progress, 'wasm')
    });
    backend = 'wasm';
    postMessage({ type: 'ready', backend, model: MODEL_ID });
  } catch (error) {
    await safeDispose();
    postMessage({
      type: 'error',
      status: 'unsupported',
      message: 'Your browser could not run this local model. A newer browser, WebGPU support, or more available memory may be needed.'
    });
    throw error;
  }
}

function postProgress(progress, attemptedBackend) {
  const percent = Number.isFinite(progress?.progress) ? Math.max(0, Math.min(100, progress.progress)) : null;
  const status = normalizeProgressStatus(progress?.status);

  postMessage({
    type: 'progress',
    backend: attemptedBackend,
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
        message: 'The local model stopped unexpectedly. Reset the chat and try a shorter prompt.'
      });
    }
  }
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

  if (clearCache && self.caches?.delete) {
    try {
      await self.caches.delete('transformers-cache');
    } catch {
      // Cache deletion is best-effort and should never break the host page.
    }
  }

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
