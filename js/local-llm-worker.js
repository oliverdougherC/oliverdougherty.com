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
let lastContextStats = null;
const MAX_PENDING_GENERATE_MESSAGES = 1;
const TOKEN_BATCH_SIZE = 4;
const TOKEN_BATCH_MS = 100;
const MAX_REASONABLE_CONTEXT_LIMIT = 1_000_000;

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
          category: 'generation-not-ready',
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
    const consoleBuffer = restoreConsole();
    if (consoleBuffer && consoleBuffer.length > 0 && !generator) {
      postMessage({
        type: 'console-buffer',
        messages: consoleBuffer.slice(-20)
      });
    }
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

    const packed = compactMessages(messages);
    const conversation = packed.messages;
    const contextStats = packed.contextStats;
    lastContextStats = contextStats;

    if (!conversation.length) {
      postMessage({
        type: 'error',
        generationId,
        status: WORKER_STATE.ERROR,
        category: 'empty-prompt',
        message: 'The prompt is empty after sanitization.',
        detail: 'No usable user message remained after trimming.'
      });
      setState(WORKER_STATE.READY, 'Ready.');
      return;
    }

    if (packed.notice) {
      postMessage({
        type: 'notice',
        generationId,
        notice: packed.notice,
        contextStats
      });
    }

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
        generationId,
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

    setState(WORKER_STATE.THINKING, 'Thinking locally.', { generationId, contextStats });
    postMessage({ type: 'start', generationId, contextStats });
    setState(WORKER_STATE.STREAMING, 'Streaming locally.', { generationId, contextStats });

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
      generationId,
      text: finalText,
      backend: 'webgpu',
      tps: tokenRate(startedAt, numTokens),
      numTokens,
      contextStats
    });
    disposePastKeyValues();
  } catch (error) {
    if (generationId !== activeGeneration) return;

    if (isAbortError(error)) {
      if (flushTimer) clearTimeout(flushTimer);
      disposePastKeyValues();
      setState(WORKER_STATE.READY, 'Generation stopped.', { generationId, contextStats: lastContextStats });
      postMessage({ type: 'interrupted', generationId, contextStats: lastContextStats });
      return;
    }

    const failure = buildGenerationError(error);
    console.error(error);
    setState(WORKER_STATE.ERROR, failure.message, { ...failure, generationId, contextStats: lastContextStats });
    disposePastKeyValues();
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    pendingGenerateCount = Math.max(0, pendingGenerateCount - 1);
  }
}

function interruptGeneration() {
  if (state !== WORKER_STATE.THINKING && state !== WORKER_STATE.STREAMING) return;
  const interruptedGenerationId = activeGeneration;
  activeGeneration += 1;
  stoppingCriteria?.interrupt?.();
  disposePastKeyValues();
  setState(WORKER_STATE.READY, 'Generation stopped.', {
    generationId: interruptedGenerationId,
    contextStats: lastContextStats
  });
  postMessage({
    type: 'interrupted',
    generationId: interruptedGenerationId,
    contextStats: lastContextStats
  });
}

function resetChatState() {
  activeGeneration += 1;
  stoppingCriteria?.interrupt?.();
  stoppingCriteria?.reset?.();
  disposePastKeyValues();
  lastContextStats = null;
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
  lastContextStats = null;

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

  const history = sanitized.slice(-LOCAL_LLM_CONFIG.limits.maxHistoryMessages);
  while (history[0]?.role === 'assistant') history.shift();

  const contextLimitTokens = getContextLimitTokens();
  const reservedGenerationTokens = Math.max(
    1,
    Number(LOCAL_LLM_CONFIG.context?.reservedGenerationTokens) || LOCAL_LLM_CONFIG.generation.max_new_tokens
  );
  const reserveSafetyTokens = Math.max(0, Number(LOCAL_LLM_CONFIG.context?.reserveSafetyTokens) || 0);
  const availableInputTokens = Math.max(128, contextLimitTokens - reservedGenerationTokens - reserveSafetyTokens);
  const perMessageOverheadTokens = Math.max(0, Number(LOCAL_LLM_CONFIG.context?.perMessageOverheadTokens) || 0);
  const maxInputTokensPerMessage = Math.max(64, Number(LOCAL_LLM_CONFIG.context?.maxInputTokensPerMessage) || 64);

  const latestUserIndex = findLatestUserIndex(history);
  if (latestUserIndex === -1) {
    return {
      messages: [],
      notice: '',
      contextStats: {
        contextLimitTokens,
        availableInputTokens,
        reservedGenerationTokens,
        reserveSafetyTokens,
        promptTokens: 0,
        includedMessageCount: 0,
        droppedMessageCount: history.length,
        truncatedUserInput: false
      }
    };
  }

  const selectedIndexes = [];
  const selectedSet = new Set();
  let tokenBudgetUsed = 0;
  let truncatedUserInput = false;

  const latestUser = { ...history[latestUserIndex] };
  let latestUserTokens = messageTokenCost(latestUser, perMessageOverheadTokens);
  if (latestUserTokens > maxInputTokensPerMessage) {
    const maxContentTokens = Math.max(16, maxInputTokensPerMessage - perMessageOverheadTokens);
    latestUser.content = trimContentToTokenLimit(latestUser.content, maxContentTokens);
    latestUserTokens = messageTokenCost(latestUser, perMessageOverheadTokens);
    truncatedUserInput = true;
  }

  if (latestUserTokens > availableInputTokens) {
    const maxContentTokens = Math.max(8, availableInputTokens - perMessageOverheadTokens - 8);
    latestUser.content = trimContentToTokenLimit(latestUser.content, maxContentTokens);
    latestUserTokens = messageTokenCost(latestUser, perMessageOverheadTokens);
    truncatedUserInput = true;
  }

  history[latestUserIndex] = latestUser;
  selectedIndexes.push(latestUserIndex);
  selectedSet.add(latestUserIndex);
  tokenBudgetUsed += latestUserTokens;

  for (let index = latestUserIndex - 1; index >= 0; index -= 1) {
    const candidate = history[index];
    const candidateCost = messageTokenCost(candidate, perMessageOverheadTokens);
    if (tokenBudgetUsed + candidateCost > availableInputTokens) continue;
    tokenBudgetUsed += candidateCost;
    selectedIndexes.push(index);
    selectedSet.add(index);
  }

  let droppedMessageCount = 0;
  for (let index = 0; index < history.length; index += 1) {
    if (!selectedSet.has(index)) droppedMessageCount += 1;
  }

  selectedIndexes.sort((left, right) => left - right);
  const packedMessages = selectedIndexes.map((index) => history[index]);

  while (packedMessages[0]?.role === 'assistant') packedMessages.shift();

  let promptTokens = countConversationTokens(packedMessages);
  while (packedMessages.length > 1 && promptTokens > availableInputTokens) {
    let removedCount = 0;
    packedMessages.shift();
    removedCount += 1;
    if (packedMessages[0]?.role === 'assistant') {
      packedMessages.shift();
      removedCount += 1;
    }
    droppedMessageCount += removedCount;
    promptTokens = countConversationTokens(packedMessages);
  }

  if (packedMessages.length === 1 && packedMessages[0]?.role === 'user' && promptTokens > availableInputTokens) {
    const maxContentTokens = Math.max(8, availableInputTokens - perMessageOverheadTokens - 8);
    packedMessages[0].content = trimContentToTokenLimit(packedMessages[0].content, maxContentTokens);
    truncatedUserInput = true;
    promptTokens = countConversationTokens(packedMessages);
    if (promptTokens > availableInputTokens) {
      packedMessages[0].content = cleanupModelText(packedMessages[0].content).slice(-64) || 'Continue.';
      promptTokens = countConversationTokens(packedMessages);
    }
  }

  const contextStats = {
    contextLimitTokens,
    availableInputTokens,
    reservedGenerationTokens,
    reserveSafetyTokens,
    promptTokens,
    includedMessageCount: packedMessages.length,
    droppedMessageCount,
    truncatedUserInput
  };

  let notice = '';
  if (droppedMessageCount > 0 && truncatedUserInput) {
    notice = 'Older chat turns and part of your latest message were trimmed to fit the local context window.';
  } else if (droppedMessageCount > 0) {
    notice = 'Older chat turns were trimmed to fit the local context window.';
  } else if (truncatedUserInput) {
    notice = 'Your latest message was trimmed to fit the local context window.';
  }

  return { messages: packedMessages, notice, contextStats };
}

function findLatestUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index;
  }
  return -1;
}

function getContextLimitTokens() {
  const fallback = Math.max(512, Number(LOCAL_LLM_CONFIG.context?.fallbackContextTokens) || 4096);
  const configLimit = Number(generator?.model?.config?.max_position_embeddings);
  const tokenizerLimit = Number(generator?.tokenizer?.model_max_length);
  const candidateLimits = [configLimit, tokenizerLimit]
    .map((value) => (Number.isFinite(value) ? Math.floor(value) : 0))
    .filter((value) => value > 0 && value < MAX_REASONABLE_CONTEXT_LIMIT);
  if (!candidateLimits.length) return fallback;
  return Math.max(512, Math.min(...candidateLimits));
}

function messageTokenCost(message, perMessageOverheadTokens) {
  return countTextTokens(message.content) + perMessageOverheadTokens;
}

function countConversationTokens(messages) {
  const tokenizer = generator?.tokenizer;
  if (tokenizer && typeof tokenizer.apply_chat_template === 'function') {
    try {
      const tokenized = tokenizer.apply_chat_template(messages, {
        tokenize: true,
        return_tensor: false,
        add_generation_prompt: true
      });
      return countTokenContainer(tokenized);
    } catch (error) {
      console.debug('Local assistant chat-template token counting failed.', error);
    }
  }

  return messages.reduce((sum, message) => sum + messageTokenCost(message, 4), 0) + 4;
}

function countTextTokens(text) {
  const tokenizer = generator?.tokenizer;
  if (tokenizer && typeof tokenizer === 'function') {
    try {
      const encoded = tokenizer(text, { add_special_tokens: false });
      return Math.max(1, countTokenContainer(encoded?.input_ids ?? encoded));
    } catch (error) {
      console.debug('Local assistant token counting fallback engaged.', error);
    }
  }

  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function trimContentToTokenLimit(content, maxTokens) {
  const text = String(content || '').trim();
  if (!text) return '';
  if (maxTokens <= 8) return text.slice(0, Math.max(24, maxTokens * 4)).trim();

  const tokenizer = generator?.tokenizer;
  if (tokenizer && typeof tokenizer === 'function' && typeof tokenizer.decode === 'function') {
    try {
      const encoded = tokenizer(text, { add_special_tokens: false });
      const ids = normalizeTokenIds(encoded?.input_ids ?? encoded);
      if (ids.length <= maxTokens) return text;
      const clipped = ids.slice(ids.length - maxTokens);
      const decoded = tokenizer.decode(clipped, { skip_special_tokens: true });
      const cleaned = cleanupModelText(decoded);
      if (cleaned) return cleaned;
    } catch (error) {
      console.debug('Local assistant token trimming fallback engaged.', error);
    }
  }

  return text.slice(-Math.max(32, maxTokens * 4)).trim();
}

function normalizeTokenIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    if (value.length && Array.isArray(value[0])) return normalizeTokenIds(value[0]);
    return value.filter((item) => Number.isFinite(item)).map((item) => Number(item));
  }
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (typeof value === 'object' && value.data) return normalizeTokenIds(value.data);
  return [];
}

function countTokenContainer(value) {
  if (!value) return 0;
  if (ArrayBuffer.isView(value)) return value.length;
  if (Array.isArray(value)) {
    if (!value.length) return 0;
    if (Array.isArray(value[0])) return value.reduce((sum, item) => sum + countTokenContainer(item), 0);
    return value.length;
  }
  if (typeof value === 'object') {
    if (value.input_ids) return countTokenContainer(value.input_ids);
    if (value.data) return countTokenContainer(value.data);
  }
  return 0;
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
  const buffer = [];
  const bufferedLog = (...args) => {
    buffer.push(args.map((a) => typeof a === 'string' ? a : String(a)).join(' '));
  };
  self.console.debug = bufferedLog;
  self.console.info = bufferedLog;
  return () => {
    self.console.debug = original.debug;
    self.console.info = original.info;
    return buffer;
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
