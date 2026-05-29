import { LOCAL_LLM_CONFIG, WORKER_STATE } from './local-llm-config.js';

export class LocalLlmMockWorker extends EventTarget {
  constructor(mode) {
    super();
    this.mode = mode;
    this.disposed = false;
    this.timerIds = [];
    this.activeGenerationId = 0;
  }

  postMessage(message) {
    if (this.disposed) return;
    if (message.type === 'load') this.mockLoad();
    if (message.type === 'generate') this.mockGenerate(message.messages || []);
    if (message.type === 'interrupt' || message.type === 'cancel') {
      this.emit({ type: 'interrupted', generationId: this.activeGenerationId });
      this.clearTimers();
    }
    if (message.type === 'reset') {
      this.clearTimers();
      this.activeGenerationId += 1;
      this.emit({ type: 'reset', state: WORKER_STATE.READY });
    }
    if (message.type === 'dispose') this.emit({ type: 'disposed', state: WORKER_STATE.DISPOSED });
  }

  terminate() {
    this.disposed = true;
    this.clearTimers();
  }

  mockLoad() {
    this.emit({
      type: 'capabilities',
      capabilities: {
        secureContext: true,
        webAssembly: true,
        webGpu: this.mode !== 'unsupported',
        cacheApi: true,
        hardwareConcurrency: 4,
        userAgent: 'mock'
      }
    });

    if (this.mode === 'unsupported') {
      this.queue(() => this.emit({
        type: 'error',
        status: WORKER_STATE.UNSUPPORTED,
        category: 'unsupported-browser',
        message: 'This browser cannot run the local WebGPU model.',
        detail: 'Mocked unavailable WebGPU environment.',
        likelyFix: 'Try current Chrome or Edge with WebGPU enabled.'
      }), 80);
      return;
    }

    this.queue(() => this.emit({ type: 'status', state: WORKER_STATE.CHECKING, message: 'Checking WebGPU support.' }), 20);
    this.queue(() => this.emit({
      type: 'progress',
      state: WORKER_STATE.LOADING,
      loaded: 145000000,
      total: 290000000,
      progress: 50,
      file: LOCAL_LLM_CONFIG.model.id
    }), 220);
    this.queue(() => this.emit({ type: 'status', state: WORKER_STATE.OPTIMIZING, message: 'Optimizing Bonsai for WebGPU execution.' }), 850);
    this.queue(() => this.emit({
      type: 'ready',
      state: WORKER_STATE.READY,
      status: WORKER_STATE.READY,
      backend: 'mock-webgpu',
      model: LOCAL_LLM_CONFIG.model.displayName,
      runtime: 'Mock Transformers.js'
    }), 1250);
  }

  mockGenerate(messages) {
    this.activeGenerationId += 1;
    const generationId = this.activeGenerationId;
    const contextStats = this.buildContextStats(messages);
    if (this.mode === 'long-stream') {
      this.mockLongStreamGenerate(generationId, contextStats);
      return;
    }
    const text = 'This is a mocked Bonsai response from the browser-only assistant.\n\nSolve $x^2 = 16$.\n\n$$\nx = \\pm \\sqrt{16}\n$$';
    this.emit({ type: 'status', generationId, contextStats, state: WORKER_STATE.THINKING, message: 'Thinking locally.' });
    if (contextStats.droppedMessageCount > 0) {
      this.queue(() => this.emit({
        type: 'notice',
        generationId,
        contextStats,
        notice: 'Older chat turns were trimmed to fit the local context window.'
      }), 18);
    }
    this.queue(() => this.emit({ type: 'start', generationId, contextStats }), 20);
    this.queue(() => this.emit({ type: 'status', generationId, contextStats, state: WORKER_STATE.STREAMING, message: 'Streaming locally.' }), 30);
    this.queue(() => this.emit({ type: 'token', generationId, contextStats, token: text.slice(0, 24), tps: 12.3, numTokens: 4 }), 420);
    this.queue(() => this.emit({ type: 'token', generationId, contextStats, token: text.slice(24), tps: 18.7, numTokens: 10 }), 470);
    this.queue(() => {
      this.emit({ type: 'complete', generationId, contextStats, text, backend: 'mock-webgpu', tps: 18.7, numTokens: 10 });
    }, 520);
  }

  mockLongStreamGenerate(generationId, contextStats) {
    const paragraphs = Array.from({ length: 90 }, (_, index) => (
      `Streamed paragraph ${index + 1}: this chunk keeps the local assistant busy while the UI remains responsive.`
    ));
    const finalText = `${paragraphs.join('\n\n')}\n\nFinal markdown: **bold**, \`code\`, and $x^2 = 16$.\n\n$$\nx = \\pm \\sqrt{16}\n$$`;
    const chunkSize = 52;
    const chunks = [];
    for (let index = 0; index < finalText.length; index += chunkSize) {
      chunks.push(finalText.slice(index, index + chunkSize));
    }

    this.emit({ type: 'status', generationId, contextStats, state: WORKER_STATE.THINKING, message: 'Thinking locally.' });
    this.queue(() => this.emit({ type: 'start', generationId, contextStats }), 20);
    this.queue(() => this.emit({ type: 'status', generationId, contextStats, state: WORKER_STATE.STREAMING, message: 'Streaming locally.' }), 30);
    chunks.forEach((chunk, index) => {
      this.queue(() => this.emit({
        type: 'token',
        generationId,
        contextStats,
        token: chunk,
        tps: 44.4,
        numTokens: (index + 1) * 4
      }), 60 + index * 12);
    });
    this.queue(() => {
      this.emit({
        type: 'complete',
        generationId,
        contextStats,
        text: finalText,
        backend: 'mock-webgpu',
        tps: 44.4,
        numTokens: chunks.length * 4
      });
    }, 90 + chunks.length * 12);
  }

  buildContextStats(messages) {
    const chat = messages.filter((message) => message && message.role !== 'notice' && typeof message.content === 'string');
    const maxMessages = LOCAL_LLM_CONFIG.limits.maxHistoryMessages;
    const droppedMessageCount = Math.max(0, chat.length - maxMessages);
    const includedMessageCount = Math.min(maxMessages, chat.length);
    return {
      contextLimitTokens: LOCAL_LLM_CONFIG.context.fallbackContextTokens,
      availableInputTokens: LOCAL_LLM_CONFIG.context.fallbackContextTokens
        - LOCAL_LLM_CONFIG.context.reservedGenerationTokens
        - LOCAL_LLM_CONFIG.context.reserveSafetyTokens,
      reservedGenerationTokens: LOCAL_LLM_CONFIG.context.reservedGenerationTokens,
      reserveSafetyTokens: LOCAL_LLM_CONFIG.context.reserveSafetyTokens,
      promptTokens: Math.max(1, Math.ceil(chat.reduce((sum, item) => sum + item.content.length, 0) / 4)),
      includedMessageCount,
      droppedMessageCount,
      truncatedUserInput: false
    };
  }

  queue(callback, delay) {
    const id = window.setTimeout(() => {
      this.timerIds = this.timerIds.filter((timerId) => timerId !== id);
      if (!this.disposed) callback();
    }, delay);
    this.timerIds.push(id);
  }

  clearTimers() {
    this.timerIds.forEach((id) => window.clearTimeout(id));
    this.timerIds = [];
  }

  emit(detail) {
    this.dispatchEvent(new MessageEvent('message', { data: detail }));
  }
}
