import { LOCAL_LLM_CONFIG, WORKER_STATE } from './local-llm-config.js';
import { deleteLocalModelCaches } from './local-llm-cache.js';
import { cleanupLocalLlmText as cleanupModelText } from './local-llm-rendering.js';

let transformersModule = null;
let generator = null;
let stoppingCriteria = null;
let pastKeyValuesCache = null;
let loadPromise = null;
let state = WORKER_STATE.IDLE;
let activeGeneration = 0;
let pendingGenerateCount = 0;
const MAX_PENDING_GENERATE_MESSAGES = 1;
const TOKEN_BATCH_SIZE = 4;
const TOKEN_BATCH_MS = 100;

self.addEventListener('message', (event) => {
  try {
    const message = event.data || {};

    if (message.type === 'load') {
      void loadModel();
      return;
    }

    if (message.type === 'generate') {
      if (state !== WORKER_STATE.READY) {
        postMessage({
          type: 'error',
          status: WORKER_STATE.ERROR,
          category: 'generation-busy',
          message: 'The local model is not ready to generate yet.',
          detail: `Generate was requested while the worker was in the "${state}" state.`
        });
        return;
      }
      if (pendingGenerateCount >= MAX_PENDING_GENERATE_MESSAGES) {
        postMessage({
          type: 'error',
          status: WORKER_STATE.ERROR,
          category: 'generation-busy',
          message: 'The local model is still processing the previous prompt.',
          detail: 'A new generate request arrived while the worker queue was full.'
        });
        return;
      }
      void generateReply(message.messages || []);
      return;
    }

    if (message.type === 'interrupt' || message.type === 'cancel') {
      interruptGeneration();
      return;
    }

    if (message.type === 'reset') {
      resetChatState();
      return;
    }

    if (message.type === 'dispose') {
      void disposeModel(message.clearCache === true);
      return;
    }

    console.debug('Unknown local assistant worker message type:', message.type);
  } catch (error) {
    console.error(error);
    postMessage({
      type: 'error',
      status: WORKER_STATE.ERROR,
      category: 'runtime-failed',
      message: 'The local model worker encountered an unexpected error.',
      detail: normalizeError(error)
    });
  }
});

async function loadModel() {
  if (generator) {
    postReady();
    return;
  }

  if (loadPromise) {
    await loadPromise;
    if (generator) postReady();
    return;
  }

  loadPromise = loadModelInternal().catch((error) => {
      const failure = buildLoadError(error);
      setState(failure.status, failure.message, failure);
    })
    .finally(() => {
      loadPromise = null;
    });

  await loadPromise;
}

async function loadModelInternal() {
  postCapabilities();
  setState(WORKER_STATE.CHECKING, 'Checking WebGPU support.');

  const webGpu = await probeWebGpu();
  if (!webGpu.available) {
    const error = new Error(webGpu.reason || 'WebGPU is unavailable in this browser.');
    error.category = 'webgpu-unavailable';
    throw error;
  }

  transformersModule = await import(LOCAL_LLM_CONFIG.runtime.moduleUrl);
  configureTransformers(transformersModule);

  const { InterruptableStoppingCriteria, pipeline } = transformersModule;
  stoppingCriteria = new InterruptableStoppingCriteria();

  setState(WORKER_STATE.LOADING, `Downloading ${LOCAL_LLM_CONFIG.model.displayName}.`);
  const restoreConsole = suppressConsoleNoise();
  try {
    generator = await pipeline('text-generation', LOCAL_LLM_CONFIG.model.id, {
      device: LOCAL_LLM_CONFIG.runtime.device,
      dtype: LOCAL_LLM_CONFIG.runtime.dtype,
      progress_callback: postTransformersProgress
    });

    setState(WORKER_STATE.OPTIMIZING, 'Optimizing Bonsai for WebGPU execution.');
    const warmupInputs = generator.tokenizer('a');
    await generator.model.generate({ ...warmupInputs, max_new_tokens: 1 });
  } finally {
    restoreConsole();
  }

  postReady();
}

function postReady() {
  setState(WORKER_STATE.READY, `${LOCAL_LLM_CONFIG.model.displayName} is ready on WebGPU.`, {
    type: 'ready',
    backend: 'webgpu',
    model: LOCAL_LLM_CONFIG.model.displayName,
    modelId: LOCAL_LLM_CONFIG.model.id,
    runtime: `${LOCAL_LLM_CONFIG.runtime.name} ${LOCAL_LLM_CONFIG.runtime.packageVersion}`,
    dtype: LOCAL_LLM_CONFIG.runtime.dtype
  });
}

async function generateReply(messages) {
  pendingGenerateCount += 1;
  const generationId = ++activeGeneration;
  let flushTimer = 0;

  try {
    await loadModel();
    if (generationId !== activeGeneration) return;

    if (!generator) {
      setState(WORKER_STATE.ERROR, 'Model failed to load; cannot generate.');
      return;
    }

    const { DynamicCache, InterruptableStoppingCriteria, TextStreamer } = transformersModule;
    stoppingCriteria ??= new InterruptableStoppingCriteria();
    stoppingCriteria.reset();
    disposePastKeyValues();
    pastKeyValuesCache = new DynamicCache();

    let startedAt = 0;
    let numTokens = 0;
    let streamedText = '';
    let tokenBuffer = '';
    let bufferedTokens = 0;
    const flushTokens = () => {
      if (!tokenBuffer) return;
      const token = tokenBuffer;
      tokenBuffer = '';
      bufferedTokens = 0;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
      postMessage({
        type: 'token',
        token,
        tps: tokenRate(startedAt, numTokens),
        numTokens
      });
    };

    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (token) => {
        if (generationId !== activeGeneration) return;
        streamedText += token;
        tokenBuffer += token;
        bufferedTokens += 1;
        if (bufferedTokens >= TOKEN_BATCH_SIZE) {
          flushTokens();
        } else if (!flushTimer) {
          flushTimer = setTimeout(flushTokens, TOKEN_BATCH_MS);
        }
      },
      token_callback_function: () => {
        startedAt ||= performance.now();
        numTokens += 1;
      }
    });

    setState(WORKER_STATE.THINKING, 'Thinking locally.');
    const conversation = compactMessages(messages);
    postMessage({ type: 'start' });
    setState(WORKER_STATE.STREAMING, 'Streaming locally.');

    const output = await generator(conversation, {
      max_new_tokens: LOCAL_LLM_CONFIG.generation.max_new_tokens,
      do_sample: LOCAL_LLM_CONFIG.generation.do_sample,
      temperature: LOCAL_LLM_CONFIG.generation.sampling.temp,
      top_k: LOCAL_LLM_CONFIG.generation.sampling.top_k,
      top_p: LOCAL_LLM_CONFIG.generation.sampling.top_p,
      repetition_penalty: LOCAL_LLM_CONFIG.generation.sampling.penalty_repeat,
      streamer,
      stopping_criteria: stoppingCriteria,
      past_key_values: pastKeyValuesCache
    });

    if (generationId !== activeGeneration) return;
    flushTokens();
    const finalText = extractGeneratedText(output, streamedText);
    setState(WORKER_STATE.READY, 'Ready.');
    postMessage({
      type: 'complete',
      text: finalText,
      backend: 'webgpu',
      tps: tokenRate(startedAt, numTokens),
      numTokens
    });
    disposePastKeyValues();
  } catch (error) {
    if (generationId !== activeGeneration) return;

    if (isAbortError(error)) {
      if (flushTimer) clearTimeout(flushTimer);
      disposePastKeyValues();
      setState(WORKER_STATE.READY, 'Generation stopped.');
      postMessage({ type: 'interrupted' });
      return;
    }

    const failure = buildGenerationError(error);
    console.error(error);
    setState(WORKER_STATE.ERROR, failure.message, failure);
    disposePastKeyValues();
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    pendingGenerateCount = Math.max(0, pendingGenerateCount - 1);
  }
}

function interruptGeneration() {
  if (state !== WORKER_STATE.THINKING && state !== WORKER_STATE.STREAMING) return;
  activeGeneration += 1;
  stoppingCriteria?.interrupt?.();
  disposePastKeyValues();
  setState(WORKER_STATE.READY, 'Generation stopped.');
  postMessage({ type: 'interrupted' });
}

function resetChatState() {
  activeGeneration += 1;
  stoppingCriteria?.interrupt?.();
  stoppingCriteria?.reset?.();
  disposePastKeyValues();
  postMessage({
    type: 'reset',
    state: generator ? WORKER_STATE.READY : WORKER_STATE.IDLE
  });
}

async function disposeModel(clearCache) {
  activeGeneration += 1;
  stoppingCriteria?.interrupt?.();
  stoppingCriteria?.reset?.();
  disposePastKeyValues();

  if (generator) {
    try {
      await generator.dispose();
    } catch (error) {
      console.debug('Local assistant generator cleanup failed.', error);
    }
  }

  generator = null;
  transformersModule = null;
  stoppingCriteria = null;
  state = WORKER_STATE.DISPOSED;

  if (clearCache) await deleteLocalModelCaches(self.caches, 'Local assistant worker cache deletion failed.');
  postMessage({ type: 'disposed', state });
}

function disposePastKeyValues() {
  pastKeyValuesCache?.dispose?.();
  pastKeyValuesCache = null;
}

function compactMessages(messages) {
  const sanitized = messages
    .filter((message) => message && typeof message.content === 'string' && message.role !== 'notice')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: cleanupModelText(message.content).slice(0, LOCAL_LLM_CONFIG.limits.maxMessageChars)
    }))
    .filter((message) => message.content.trim());

  const chat = sanitized.slice(-LOCAL_LLM_CONFIG.limits.maxHistoryMessages);
  while (chat[0]?.role === 'assistant') chat.shift();

  return chat;
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
      webGpu: Boolean(self.navigator?.gpu),
      cacheApi: Boolean(self.caches?.open),
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

function suppressConsoleNoise() {
  const original = {
    debug: self.console.debug,
    info: self.console.info
  };
  self.console.debug = () => {};
  self.console.info = () => {};
  return () => {
    self.console.debug = original.debug;
    self.console.info = original.info;
  };
}

function postTransformersProgress(progress) {
  const percent = Number.isFinite(progress?.progress)
    ? Math.max(0, Math.min(99, Number(progress.progress)))
    : null;
  const loaded = Number.isFinite(progress?.loaded) ? Number(progress.loaded) : null;
  const total = Number.isFinite(progress?.total) ? Number(progress.total) : null;
  const normalized = normalizeProgressStatus(progress?.status);

  postMessage({
    type: 'progress',
    state: normalized === 'downloading' ? WORKER_STATE.LOADING : WORKER_STATE.OPTIMIZING,
    runtime: LOCAL_LLM_CONFIG.runtime.name,
    file: typeof progress?.file === 'string' ? progress.file : LOCAL_LLM_CONFIG.model.id,
    progress: percent,
    loaded,
    total
  });
}

function normalizeProgressStatus(status) {
  if (status === 'progress' || status === 'download' || status === 'progress_total') return 'downloading';
  if (status === 'ready' || status === 'done' || status === 'loading' || status === 'optimizing') return 'loading';
  return 'downloading';
}

function extractGeneratedText(output, fallbackText) {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = first?.generated_text;

  if (Array.isArray(generated)) {
    for (let i = generated.length - 1; i >= 0; i -= 1) {
      if (typeof generated[i]?.content === 'string') return cleanupModelText(generated[i].content);
    }
  }

  if (typeof generated === 'string' && generated.trim()) return cleanupModelText(generated);
  return cleanupModelText(fallbackText);
}

function buildLoadError(error) {
  const detail = normalizeError(error);
  const category = categorizeError(error, detail);
  return {
    type: 'error',
    status: category === 'unsupported-browser' ? WORKER_STATE.UNSUPPORTED : WORKER_STATE.ERROR,
    category,
    message: category === 'unsupported-browser'
      ? 'This browser cannot run the local WebGPU model.'
      : category === 'download-failed'
        ? 'The Bonsai WebGPU model download failed.'
        : 'The local WebGPU model could not start.',
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
      : 'Stop, reset the chat, and try a shorter prompt.'
  };
}

function categorizeError(error, detail) {
  const source = `${error?.category || ''} ${detail}`.toLowerCase();
  if (/webgpu-unavailable|webgpu is unavailable|navigator\.gpu is unavailable|webgpu did not return|requestadapter/.test(source)) return 'unsupported-browser';
  if (/network|fetch|failed to fetch|http|hugging face|xet|download|cors/.test(source)) return 'download-failed';
  if (/out of memory|oom|allocation|arraybuffer|memory access out of bounds/.test(source)) return 'out-of-memory';
  if (/import|module|cdn|jsdelivr/.test(source)) return 'runtime-import';
  return 'runtime-failed';
}

function likelyFixForCategory(category) {
  if (category === 'unsupported-browser') return 'Use a current Chrome or Edge build with WebGPU enabled. Firefox and Safari support may require browser flags.';
  if (category === 'download-failed') return 'Check network access to Hugging Face and jsDelivr, disable blocking extensions for this page, then retry.';
  if (category === 'out-of-memory') return 'Close memory-heavy tabs and retry. Bonsai is small, but WebGPU still needs enough browser memory.';
  if (category === 'runtime-import') return 'Check network access to the Transformers.js runtime CDN, then retry.';
  return 'Retry in a current desktop browser from HTTPS or localhost.';
}

function tokenRate(startedAt, numTokens) {
  if (!startedAt || numTokens <= 1) return null;
  const elapsed = Math.max(1, performance.now() - startedAt);
  return (numTokens / elapsed) * 1000;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /abort|cancel|interrupt/i.test(normalizeError(error));
}

function normalizeError(error) {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.slice(0, 500);
  if (typeof error === 'string') return error.slice(0, 500);
  return 'Unknown error';
}
