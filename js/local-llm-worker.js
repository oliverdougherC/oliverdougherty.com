import { LOCAL_LLM_CONFIG, WORKER_STATE } from './local-llm-config.js';

let wllamaModule = null;
let wllama = null;
let transformersModule = null;
let generator = null;
let stoppingCriteria = null;
let pastKeyValuesCache = null;
let loadPromise = null;
let state = WORKER_STATE.IDLE;
let activeRuntime = 'gguf';
let activeGeneration = 0;
let activeAbortController = null;

installWorkerDocumentBase();

// Suppress noisy worker logs; keep warnings visible for memory pressure / deprecated APIs.
for (const method of ['debug', 'info']) {
  self.console[method] = () => {};
}

self.addEventListener('message', (event) => {
  const message = event.data || {};

  if (message.type === 'load') {
    void loadModel();
    return;
  }

  if (message.type === 'generate') {
    void generateReply(message.messages || []);
    return;
  }

  if (message.type === 'cancel') {
    cancelGeneration();
    return;
  }

  if (message.type === 'dispose') {
    void disposeModel(message.clearCache === true);
  }
});

async function loadModel() {
  if (wllama?.isModelLoaded?.() || generator) {
    postReady();
    return;
  }

  if (loadPromise) {
    await loadPromise;
    return;
  }

  loadPromise = loadModelInternal()
    .catch((error) => {
      const failure = buildLoadError(error);
      setState(failure.status, failure.message, failure);
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
  assertMinimumRuntimeSupport();

  try {
    await loadGgufModel();
  } catch (error) {
    const failure = buildLoadError(error);
    if (shouldTryOnnxFallback(failure)) {
      await safeDisposeGguf();
      await loadOnnxFallback(failure);
      return;
    }
    throw error;
  }
}

async function loadGgufModel() {
  activeRuntime = 'gguf';
  setState(WORKER_STATE.RUNTIME_LOADING, `Loading ${LOCAL_LLM_CONFIG.runtime.name}.`);
  const module = await import(LOCAL_LLM_CONFIG.runtime.moduleUrl);
  wllamaModule = module;

  const { Wllama, LoggerWithoutDebug } = module;
  wllama = new Wllama(LOCAL_LLM_CONFIG.runtime.pathConfig, {
    logger: LoggerWithoutDebug,
    parallelDownloads: 3
  });

  setState(WORKER_STATE.MODEL_DOWNLOADING, `Downloading ${LOCAL_LLM_CONFIG.model.displayName}.`);
  let lastProgress = 0;

  await wllama.loadModelFromHF(LOCAL_LLM_CONFIG.model.repo, LOCAL_LLM_CONFIG.model.file, {
    ...LOCAL_LLM_CONFIG.load.context,
    useCache: LOCAL_LLM_CONFIG.load.useCache,
    progressCallback: ({ loaded, total }) => {
      const progress = total > 0 ? Math.round((loaded / total) * 100) : null;
      if (progress !== null) lastProgress = Math.max(lastProgress, progress);
      postMessage({
        type: 'progress',
        state: WORKER_STATE.MODEL_DOWNLOADING,
        loaded,
        total,
        progress: progress === null ? null : Math.min(96, lastProgress),
        file: LOCAL_LLM_CONFIG.model.file,
        model: LOCAL_LLM_CONFIG.model.displayName
      });
      if (progress !== null && progress >= 100) {
        setState(WORKER_STATE.MODEL_LOADING, 'Preparing the GGUF runtime context.');
      }
    }
  });

  postReady();
}

async function loadOnnxFallback(ggufFailure) {
  const fallback = LOCAL_LLM_CONFIG.fallbackRuntime;
  if (!fallback?.enabled) {
    const error = new Error('No browser fallback runtime is configured.');
    error.category = 'fallback-unavailable';
    throw error;
  }

  activeRuntime = 'onnx';
  setState(
    WORKER_STATE.RUNTIME_LOADING,
    `GGUF load needs PrismML Q1_0 kernels; loading ${fallback.name}.`,
    {
      category: 'gguf-fallback',
      detail: ggufFailure.detail,
      likelyFix: 'Using the WebGPU Bonsai fallback while keeping inference in this browser.'
    }
  );

  const webGpu = await probeWebGpu();
  if (!webGpu.available) {
    const error = new Error(webGpu.reason || 'WebGPU is unavailable for the Bonsai fallback.');
    error.category = 'webgpu-unavailable';
    throw error;
  }

  transformersModule = await import(fallback.moduleUrl);
  configureTransformers(transformersModule);

  const { InterruptableStoppingCriteria, pipeline } = transformersModule;
  stoppingCriteria = new InterruptableStoppingCriteria();

  setState(WORKER_STATE.MODEL_DOWNLOADING, `Downloading ${LOCAL_LLM_CONFIG.model.displayName} WebGPU fallback.`);
  generator = await pipeline('text-generation', fallback.modelId, {
    device: fallback.device,
    dtype: fallback.dtype,
    progress_callback: (progress) => postTransformersProgress(progress, fallback.name)
  });

  setState(WORKER_STATE.MODEL_LOADING, 'Optimizing Bonsai for 1-bit WebGPU execution.');
  const warmupInputs = generator.tokenizer('a');
  await generator.model.generate({ ...warmupInputs, max_new_tokens: 1 });

  postReady();
}

function postReady() {
  if (activeRuntime === 'onnx') {
    const fallback = LOCAL_LLM_CONFIG.fallbackRuntime;
    setState(WORKER_STATE.READY, `${LOCAL_LLM_CONFIG.model.displayName} is ready on WebGPU.`, {
      type: 'ready',
      backend: 'webgpu',
      model: fallback.modelId,
      repo: LOCAL_LLM_CONFIG.model.repo,
      file: fallback.modelId,
      runtime: `${fallback.name} ${fallback.packageVersion}`,
      threads: null,
      metadata: null
    });
    return;
  }

  const metadata = safeCall(() => wllama.getModelMetadata(), null);
  setState(WORKER_STATE.READY, `${LOCAL_LLM_CONFIG.model.displayName} is ready.`, {
    type: 'ready',
    backend: wllama?.isMultithread?.() ? 'wasm-multithread' : 'wasm',
    model: LOCAL_LLM_CONFIG.model.displayName,
    repo: LOCAL_LLM_CONFIG.model.repo,
    file: LOCAL_LLM_CONFIG.model.file,
    runtime: `${LOCAL_LLM_CONFIG.runtime.name} ${LOCAL_LLM_CONFIG.runtime.packageVersion}`,
    threads: safeCall(() => wllama.getNumThreads(), 1),
    metadata
  });
}

async function generateReply(messages) {
  const generationId = ++activeGeneration;

  try {
    await loadModel();
    if (generationId !== activeGeneration) return;
    if (activeRuntime === 'onnx') {
      if (!generator) {
        setState(WORKER_STATE.ERROR, 'Model failed to load; cannot generate.');
        return;
      }
      await generateTransformersReply(messages, generationId);
      return;
    }
    if (!wllama?.isModelLoaded?.()) {
      setState(WORKER_STATE.ERROR, 'Model failed to load; cannot generate.');
      return;
    }

    activeAbortController = new AbortController();
    setState(WORKER_STATE.GENERATING, 'Generating locally.');

    const conversation = compactMessages(messages);
    const options = {
      ...LOCAL_LLM_CONFIG.generation,
      stream: true,
      useCache: true,
      abortSignal: activeAbortController.signal
    };

    const stream = await wllama.createChatCompletion(conversation, options);
    let currentText = '';

    for await (const chunk of stream) {
      if (generationId !== activeGeneration) return;
      const nextText = String(chunk?.currentText || '');
      const token = nextText.startsWith(currentText) ? nextText.slice(currentText.length) : nextText;
      currentText = nextText;
      if (token) postMessage({ type: 'token', token });
    }

    if (generationId !== activeGeneration) return;
    setState(WORKER_STATE.READY, 'Ready.');
    postMessage({ type: 'complete', text: currentText, backend: 'wasm' });
  } catch (error) {
    if (generationId !== activeGeneration) return;

    if (isAbortError(error)) {
      setState(WORKER_STATE.READY, 'Generation stopped.');
      postMessage({ type: 'cancelled' });
      return;
    }

    const failure = buildGenerationError(error);
    setState(WORKER_STATE.ERROR, failure.message, failure);
  } finally {
    if (generationId === activeGeneration) {
      activeAbortController = null;
    }
  }
}

async function generateTransformersReply(messages, generationId) {
  if (!generator) return;

  setState(WORKER_STATE.GENERATING, 'Generating locally on WebGPU.');
  stoppingCriteria?.reset?.();

  const { DynamicCache, InterruptableStoppingCriteria, TextStreamer } = transformersModule;
  stoppingCriteria ??= new InterruptableStoppingCriteria();

  // Reset KV cache between conversations to avoid memory growth and context contamination
  pastKeyValuesCache?.dispose?.();
  pastKeyValuesCache = new DynamicCache();

  let streamedText = '';
  const streamer = new TextStreamer(generator.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (token) => {
      if (generationId !== activeGeneration) return;
      streamedText += token;
      postMessage({ type: 'token', token });
    }
  });

  const output = await generator(compactMessages(messages), {
    max_new_tokens: LOCAL_LLM_CONFIG.generation.max_new_tokens,
    do_sample: true,
    temperature: LOCAL_LLM_CONFIG.generation.sampling.temp,
    top_k: LOCAL_LLM_CONFIG.generation.sampling.top_k,
    top_p: LOCAL_LLM_CONFIG.generation.sampling.top_p,
    repetition_penalty: LOCAL_LLM_CONFIG.generation.sampling.penalty_repeat,
    streamer,
    stopping_criteria: stoppingCriteria,
    past_key_values: pastKeyValuesCache
  });

  if (generationId !== activeGeneration) return;
  const finalText = extractGeneratedText(output, streamedText);
  setState(WORKER_STATE.READY, 'Ready.');
  postMessage({ type: 'complete', text: finalText, backend: 'webgpu' });
}

function cancelGeneration() {
  activeGeneration += 1;
  activeAbortController?.abort();
  stoppingCriteria?.interrupt?.();
  activeAbortController = null;
  // Don't post 'cancelled' here — the generation's catch block handles it,
  // avoiding a duplicate message when the stream throws an AbortError.
  if (wllama?.isModelLoaded?.() || generator) {
    setState(WORKER_STATE.READY, 'Generation stopped.');
  }
}

async function disposeModel(clearCache) {
  activeGeneration += 1;
  activeAbortController?.abort();
  activeAbortController = null;

  await safeDisposeGguf();
  await safeDisposeTransformers();

  wllama = null;
  wllamaModule = null;
  transformersModule = null;
  activeRuntime = 'gguf';
  state = WORKER_STATE.DISPOSED;

  if (clearCache) await deleteLocalModelCaches();
  postMessage({ type: 'disposed', state });
}

function compactMessages(messages) {
  const sanitized = messages
    .filter((message) => message && typeof message.content === 'string' && message.role !== 'notice')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content.slice(0, LOCAL_LLM_CONFIG.limits.maxMessageChars)
    }));

  // Trim complete user/assistant pairs from the start to avoid orphaned messages
  // that confuse chat-template models
  const max = LOCAL_LLM_CONFIG.limits.maxHistoryMessages;
  let chat = sanitized;
  if (sanitized.length > max) {
    const sliced = sanitized.slice(-max);
    // If slice starts with a user message (incomplete pair), drop it
    if (sliced.length > 0 && sliced[0].role === 'user') {
      chat = sliced.slice(1);
    } else {
      chat = sliced;
    }
  }

  return [
    { role: 'system', content: LOCAL_LLM_CONFIG.systemPrompt },
    ...chat
  ];
}

function setState(nextState, message, extra = {}) {
  state = nextState;
  postMessage({
    type: extra.type || 'status',
    state,
    status: state,
    message,
    ...extra
  });
}

function postCapabilities() {
  postMessage({
    type: 'capabilities',
    capabilities: {
      secureContext: typeof self.isSecureContext === 'boolean' ? self.isSecureContext : null,
      webAssembly: typeof WebAssembly === 'object',
      wasmMemory64: canCreateMemory64(),
      crossOriginIsolated: Boolean(self.crossOriginIsolated),
      cacheApi: Boolean(self.caches?.open),
      workerGpu: Boolean(self.navigator?.gpu),
      hardwareConcurrency: self.navigator?.hardwareConcurrency ?? null,
      userAgent: self.navigator?.userAgent || ''
    }
  });
}

async function probeWebGpu() {
  if (!self.navigator?.gpu) {
    return { available: false, reason: 'navigator.gpu is unavailable in this worker.' };
  }

  if (typeof self.navigator.gpu.requestAdapter !== 'function') {
    return { available: false, reason: 'navigator.gpu exists but requestAdapter is unavailable.' };
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

function configureTransformers(module) {
  const { env } = module;
  if (!env) return;

  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;
}

function postTransformersProgress(progress, runtimeName) {
  const percent = Number.isFinite(progress?.progress) ? Math.max(0, Math.min(96, progress.progress)) : null;
  postMessage({
    type: 'progress',
    state: normalizeProgressStatus(progress?.status) === 'downloading'
      ? WORKER_STATE.MODEL_DOWNLOADING
      : WORKER_STATE.MODEL_LOADING,
    runtime: runtimeName,
    file: typeof progress?.file === 'string' ? progress.file : LOCAL_LLM_CONFIG.fallbackRuntime.modelId,
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

function assertMinimumRuntimeSupport() {
  if (typeof WebAssembly !== 'object') {
    const error = new Error('WebAssembly is unavailable.');
    error.category = 'wasm-unavailable';
    throw error;
  }
}

function canCreateMemory64() {
  try {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.Memory !== 'function') return false;
    new WebAssembly.Memory({ initial: 1, maximum: 1, index: 'i64' });
    return true;
  } catch {
    return false;
  }
}

function shouldTryOnnxFallback(failure) {
  return Boolean(
    LOCAL_LLM_CONFIG.fallbackRuntime?.enabled &&
      (failure.category === 'model-parse-failed' || failure.category === 'model-runtime-incompatible')
  );
}

async function safeDisposeGguf() {
  if (!wllama) return;

  try {
    await wllama.exit();
  } catch {
    // Best-effort cleanup; the UI can always create a fresh runtime.
  } finally {
    wllama = null;
    wllamaModule = null;
  }
}

async function safeDisposeTransformers() {
  pastKeyValuesCache?.dispose?.();
  pastKeyValuesCache = null;
  stoppingCriteria?.reset?.();
  stoppingCriteria = null;

  if (!generator) return;

  try {
    await generator.dispose();
  } catch {
    // Best-effort cleanup in a reset path.
  } finally {
    generator = null;
  }
}

function extractGeneratedText(output, fallbackText) {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = first?.generated_text;

  if (Array.isArray(generated)) {
    for (let i = generated.length - 1; i >= 0; i--) {
      if (typeof generated[i]?.content === 'string') return generated[i].content;
    }
  }

  if (typeof generated === 'string' && generated.trim()) return generated;
  if (fallbackText.trim()) return fallbackText;
  return fallbackText;
}

function buildLoadError(error) {
  const detail = normalizeError(error);
  const category = categorizeError(error, detail);
  return {
    type: 'error',
    status: category === 'unsupported-browser' || category === 'wasm-unavailable' ? WORKER_STATE.UNSUPPORTED : WORKER_STATE.ERROR,
    category,
    message: category === 'download-failed'
      ? 'The Bonsai GGUF download failed.'
      : category === 'model-runtime-incompatible'
        ? 'The Bonsai GGUF needs a runtime this browser bundle does not include.'
      : category === 'unsupported-browser'
        ? 'This browser cannot run the local GGUF runtime.'
        : 'The local GGUF model could not start.',
    detail,
    likelyFix: likelyFixForCategory(category)
  };
}

function buildGenerationError(error) {
  const detail = normalizeError(error);
  const category = categorizeError(error, detail);
  return {
    type: 'error',
    status: WORKER_STATE.ERROR,
    category,
    message: 'The local model stopped during generation.',
    detail,
    likelyFix: category === 'out-of-memory'
      ? 'Close memory-heavy tabs, reset the model, and try a shorter prompt.'
      : 'Reset the chat and try a shorter prompt.'
  };
}

function categorizeError(error, detail) {
  const source = `${error?.category || ''} ${detail}`.toLowerCase();
  if (/webassembly is unavailable|wasm-unavailable/.test(source)) return 'wasm-unavailable';
  if (/webgpu-unavailable|webgpu is unavailable|navigator\.gpu is unavailable|webgpu did not return/.test(source)) return 'unsupported-browser';
  if (/memory64|memory 64|unsupported memory|safari/.test(source)) return 'unsupported-browser';
  if (/network|fetch|failed to fetch|http|hugging face|xet|download|cors/.test(source)) return 'download-failed';
  if (/out of memory|oom|allocation|arraybuffer|memory access out of bounds/.test(source)) return 'out-of-memory';
  if (/invalid typed array length|file bounds|corrupt|incomplete|invalid ggml type|q1_0|q1_0_g128/.test(source)) return 'model-runtime-incompatible';
  if (/gguf|invalid model|parse|metadata|tensor/.test(source)) return 'model-parse-failed';
  if (/import|module|cdn|jsdelivr/.test(source)) return 'runtime-import';
  return 'runtime-failed';
}

function likelyFixForCategory(category) {
  if (category === 'wasm-unavailable') return 'Use a current desktop browser with WebAssembly enabled.';
  if (category === 'unsupported-browser') return 'Try current Chrome or Edge. Safari may not support the Memory64 requirement used by this GGUF runtime.';
  if (category === 'download-failed') return 'Check network access to Hugging Face/jsDelivr, disable blocking extensions for this page, then retry.';
  if (category === 'out-of-memory') return 'Close memory-heavy tabs and retry. Bonsai is small for GGUF, but it still needs enough browser memory.';
  if (category === 'model-runtime-incompatible') return 'This Bonsai GGUF uses PrismML Q1_0 kernels. The page will try the Bonsai WebGPU fallback when WebGPU is available.';
  if (category === 'model-parse-failed') return 'Retry after clearing the model cache. If it persists, the cached GGUF may be incomplete or unsupported by this browser runtime.';
  if (category === 'runtime-import') return 'Check network access to the Wllama runtime CDN, then retry.';
  return 'Retry in a current desktop browser from HTTPS or localhost.';
}

async function deleteLocalModelCaches() {
  if (!self.caches?.keys || !self.caches?.delete) return false;

  try {
    const cacheNames = await self.caches.keys();
    const targets = cacheNames.filter((name) => /wllama|huggingface|transformers|local-llm/i.test(name));
    await Promise.all(targets.map((name) => self.caches.delete(name)));
    return true;
  } catch {
    return false;
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /abort|cancel/i.test(normalizeError(error));
}

function normalizeError(error) {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.slice(0, 500);
  if (typeof error === 'string') return error.slice(0, 500);
  return 'Unknown error';
}

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function installWorkerDocumentBase() {
  if (typeof self.document !== 'undefined') return;

  const workerUrl = self.location?.href || './local-llm-worker.js';
  Object.defineProperty(self, 'document', {
    configurable: true,
    enumerable: false,
    value: {
      baseURI: workerUrl,
      currentScript: { src: workerUrl }
    }
  });
}
