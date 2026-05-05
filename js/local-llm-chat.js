import { LOCAL_LLM_CONFIG } from './local-llm-config.js';

const MAX_INPUT_CHARS = LOCAL_LLM_CONFIG.limits.maxInputChars;
const READY_PROMPTS = [
  'Ask a concise question...',
  'Draft a tiny explanation...',
  'Summarize a thought...',
  'Try a local-only brainstorm...'
];

const LOADING_COPY = {
  idle: `Runs in this browser with ${LOCAL_LLM_CONFIG.model.displayName}.`,
  'runtime-loading': 'Starting the browser GGUF runtime.',
  'model-downloading': `Downloading ${LOCAL_LLM_CONFIG.model.displayName} (${LOCAL_LLM_CONFIG.model.sizeLabel}).`,
  'model-loading': 'Preparing the local model context.',
  ready: 'Ready. Messages stay in this browser.',
  generating: 'Generating locally.',
  error: 'Local model unavailable.',
  unsupported: 'This browser cannot run the local model.'
};

class LocalLlmUtility {
  constructor(root) {
    this.root = root;
    this.worker = null;
    this.messages = [];
    this.status = 'idle';
    this.progress = 0;
    this.promptTimer = null;
    this.promptIndex = 0;
    this.assistantDraft = null;
    this.diagnostics = null;
    this.lastProgressTotal = 0;

    this.mount();
    this.bindEvents();
    this.renderMessages();
    this.updateStatus('idle', 'Idle.');
    this.showCenterCopy(LOADING_COPY.idle);
  }

  mount() {
    this.root.innerHTML = `
      <div class="local-llm-window">
        <div class="local-llm-transcript" id="localLlmTranscript" aria-live="polite">
          <div class="local-llm-top-cards" role="toolbar" aria-label="Model status and actions">
            <div class="local-llm-top-cards-track">
              <span class="local-llm-card utility-status-chip utility-status-chip--idle" id="localLlmStatusChip">Idle</span>
              <button type="button" class="local-llm-card local-llm-reset" id="localLlmResetBtn" data-cursor="hover">Reset model</button>
            </div>
          </div>
          <div class="local-llm-thread" id="localLlmMessages"></div>
          <div class="local-llm-center" id="localLlmCenter">
            <p class="local-llm-load-copy local-llm-load-copy--visible" id="localLlmLoadCopy"></p>
            <p class="local-llm-model-note" id="localLlmModelNote"></p>
            <div class="local-llm-progress-wrap" id="localLlmProgressWrap" hidden>
              <div class="utility-progress-bar local-llm-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="localLlmProgressBar">
                <span class="utility-progress-fill local-llm-progress-fill"></span>
              </div>
              <span class="local-llm-progress-percent" id="localLlmProgressPercent">0%</span>
            </div>
            <div class="local-llm-diagnostics" id="localLlmDiagnostics" hidden></div>
          </div>
        </div>

        <form class="local-llm-form" id="localLlmForm">
          <button type="button" class="local-llm-load-control" id="localLlmStartBtn" aria-label="Download and start the local model" data-cursor="hover">
            <span class="local-llm-load-control-symbol" aria-hidden="true">↓</span>
            <span class="local-llm-load-control-text">Load</span>
          </button>
          <label class="local-llm-label" for="localLlmInput">Message the local AI</label>
          <div class="local-llm-input-shell">
            <textarea id="localLlmInput" class="local-llm-input" rows="1" maxlength="${MAX_INPUT_CHARS}" placeholder="Load the model first." disabled></textarea>
            <span class="local-llm-ready-prompt" id="localLlmReadyPrompt" aria-hidden="true">Load the model first.</span>
          </div>
          <button class="local-llm-send" type="submit" aria-label="Send message" disabled data-cursor="hover">
            <svg class="local-llm-send-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </form>
      </div>
    `;

    this.startButton = this.root.querySelector('#localLlmStartBtn');
    this.startSymbol = this.root.querySelector('.local-llm-load-control-symbol');
    this.startText = this.root.querySelector('.local-llm-load-control-text');
    this.resetButton = this.root.querySelector('#localLlmResetBtn');
    this.statusChip = this.root.querySelector('#localLlmStatusChip');
    this.progressWrap = this.root.querySelector('#localLlmProgressWrap');
    this.progressBar = this.root.querySelector('#localLlmProgressBar');
    this.progressFill = this.root.querySelector('.local-llm-progress-fill');
    this.progressPercent = this.root.querySelector('#localLlmProgressPercent');
    this.loadCopy = this.root.querySelector('#localLlmLoadCopy');
    this.modelNote = this.root.querySelector('#localLlmModelNote');
    this.center = this.root.querySelector('#localLlmCenter');
    this.diagnosticsPanel = this.root.querySelector('#localLlmDiagnostics');
    this.transcript = this.root.querySelector('#localLlmTranscript');
    this.messageList = this.root.querySelector('#localLlmMessages');
    this.form = this.root.querySelector('#localLlmForm');
    this.input = this.root.querySelector('#localLlmInput');
    this.readyPrompt = this.root.querySelector('#localLlmReadyPrompt');
    this.sendButton = this.root.querySelector('.local-llm-send');
  }

  bindEvents() {
    this.startButton.addEventListener('click', () => this.startChat());
    this.resetButton.addEventListener('click', () => this.resetChat({ clearCache: true }));
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.sendMessage();
    });
    this.input.addEventListener('input', () => {
      this.updatePromptVisibility();
      this.autoSizeInput();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        this.sendMessage();
      }
      if (event.key === 'Escape' && this.status !== 'generating') {
        this.input.blur();
      }
    });
    this.diagnosticsPanel.addEventListener('click', (event) => {
      if (event.target.closest('[data-local-llm-retry]')) {
        this.resetChat({ clearCache: false }).then(() => this.startChat());
      }
    });
    window.addEventListener('pagehide', () => {
      this.worker?.postMessage({ type: 'dispose', clearCache: false });
      this.worker?.terminate();
    });
  }

  startChat() {
    if (this.status === 'ready' || this.status === 'generating' || this.isLoading()) return;

    this.progress = 0;
    this.lastProgressTotal = 0;
    this.diagnostics = null;
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.showCenterCopy(LOADING_COPY['runtime-loading']);
    this.updateProgressBar();
    this.updateStatus('runtime-loading', 'Starting local runtime.');

    try {
      this.worker = this.createWorker();
      this.worker.addEventListener('message', (event) => this.handleWorkerMessage(event.data || {}));
      this.worker.addEventListener('error', () => {
        this.showLoadFailure({
          status: 'error',
          category: 'worker-failed',
          message: 'The browser blocked the local model worker before it could start.',
          detail: 'Module workers need HTTPS, localhost, or a normal static server.',
          likelyFix: 'Open this page from GitHub Pages, HTTPS, or localhost, then retry.'
        });
      });
      this.worker.postMessage({ type: 'load' });
    } catch {
      this.showLoadFailure({
        status: 'unsupported',
        category: 'worker-unavailable',
        message: 'This browser could not create the local model worker.',
        detail: 'The page stayed responsive, but the Worker API was unavailable.',
        likelyFix: 'Try a current desktop browser.'
      });
    }
  }

  createWorker() {
    if (window.__OD_LOCAL_LLM_TEST_MODE__) {
      return new LocalLlmMockWorker(window.__OD_LOCAL_LLM_TEST_MODE__);
    }
    return new Worker(new URL('./local-llm-worker.js', import.meta.url), { type: 'module' });
  }

  handleWorkerMessage(message) {
    if (message.type === 'capabilities') {
      this.diagnostics = message.capabilities || null;
      return;
    }

    if (message.type === 'progress') {
      this.updateProgress(message);
      return;
    }

    if (message.type === 'ready') {
      this.progress = 100;
      this.updateProgressBar();
      this.hideDiagnostics();
      this.assistantDraft = null;
      this.updateStatus('ready', message.message || 'Ready.');
      this.showCenterCopy(LOADING_COPY.ready);
      this.center.classList.add('local-llm-center--hidden');
      this.startPromptCycle();
      this.input.focus({ preventScroll: true });
      return;
    }

    if (message.type === 'status') {
      this.updateStatusFromWorker(message);
      return;
    }

    if (message.type === 'token') {
      this.appendAssistantToken(message.token || '');
      return;
    }

    if (message.type === 'complete') {
      this.finishAssistantMessage(message.text || '');
      return;
    }

    if (message.type === 'cancelled') {
      this.finishCancelledGeneration();
      return;
    }

    if (message.type === 'error') {
      this.showLoadFailure(message);
      this.finishAssistantMessage('');
      return;
    }

    if (message.type === 'disposed') {
      this.updateStatus('idle', 'Chat reset. Start again to reload locally.');
    }
  }

  updateStatusFromWorker(message) {
    const state = message.state || message.status || 'runtime-loading';
    const copy = message.message || LOADING_COPY[state] || 'Working locally.';
    this.updateStatus(state, copy);
    this.showCenterCopy(LOADING_COPY[state] || copy);
    if (state === 'model-loading' && this.progress < 98) {
      this.progress = 98;
      this.updateProgressBar();
    }
  }

  updateProgress(message) {
    const progress = Number.isFinite(message.progress) ? Math.round(message.progress) : null;
    if (progress !== null) {
      this.progress = Math.max(this.progress, Math.min(96, progress));
    } else if (this.progress < 12) {
      this.progress = 12;
    }
    this.lastProgressTotal = Number.isFinite(message.total) ? message.total : this.lastProgressTotal;
    this.updateStatus('model-downloading', 'Downloading model.');
    this.showCenterCopy(LOADING_COPY['model-downloading']);
    this.updateProgressBar();
  }

  showCenterCopy(text) {
    this.center.classList.remove('local-llm-center--hidden');
    this.loadCopy.textContent = text;
    this.loadCopy.classList.add('local-llm-load-copy--visible');
    this.modelNote.textContent = `${LOCAL_LLM_CONFIG.model.displayName} from Hugging Face via ${LOCAL_LLM_CONFIG.runtime.name}; falls back to Bonsai WebGPU when GGUF kernels are unsupported.`;
  }

  updateProgressBar() {
    const value = Math.max(0, Math.min(100, this.progress));
    this.progressBar.setAttribute('aria-valuenow', String(value));
    this.progressFill.style.width = `${value}%`;
    this.progressPercent.textContent = `${value}%`;
    this.updateLoadControl();
  }

  updateStatus(status, label = '') {
    this.status = status;
    this.root.dataset.localLlmStatus = status;
    this.root.dataset.localLlmStatusMessage = label;

    const chipState = status === 'unsupported' ? 'error' : status;
    this.statusChip.textContent = formatStatus(status);
    this.statusChip.className = `local-llm-card utility-status-chip utility-status-chip--${this.isLoading(status) || status === 'generating' ? 'processing' : chipState}`;

    const canSend = status === 'ready';
    this.sendButton.disabled = !canSend;
    this.input.disabled = !canSend;
    this.progressWrap.hidden = !(this.isLoading(status) || status === 'ready' || status === 'unsupported' || status === 'error');
    this.resetButton.textContent = this.isLoading(status)
      ? 'Cancel load'
      : status === 'generating'
        ? 'Stop / reset'
        : 'Reset model';

    if (status === 'ready') {
      this.setReadyPrompt(READY_PROMPTS[this.promptIndex] || 'Say hello...');
    } else if (status === 'unsupported' || status === 'error') {
      this.stopPromptCycle();
      this.input.placeholder = 'The local model is not available here.';
      this.readyPrompt.textContent = 'The local model is not available here.';
    } else if (status === 'idle') {
      this.stopPromptCycle();
      this.input.placeholder = 'Load the model first.';
      this.readyPrompt.textContent = 'Load the model first.';
    } else if (status === 'generating') {
      this.stopPromptCycle();
    }

    this.updatePromptVisibility();
    this.updateLoadControl();
  }

  isLoading(status = this.status) {
    return status === 'runtime-loading' || status === 'model-downloading' || status === 'model-loading';
  }

  updateLoadControl() {
    const isLoading = this.isLoading();
    const isReady = this.status === 'ready' || this.status === 'generating';
    const isFailure = this.status === 'unsupported' || this.status === 'error';

    this.startButton.disabled = isLoading || isReady;
    this.startButton.classList.toggle('local-llm-load-control--loading', isLoading);
    this.startButton.classList.toggle('local-llm-load-control--ready', isReady);
    this.startButton.classList.toggle('local-llm-load-control--error', isFailure);

    if (isLoading) {
      this.startSymbol.textContent = '…';
      this.startText.textContent = `${Math.max(0, Math.min(100, this.progress))}%`;
    } else if (isReady) {
      this.startSymbol.textContent = '✓';
      this.startText.textContent = this.status === 'generating' ? 'Busy' : 'Ready';
    } else if (isFailure) {
      this.startSymbol.textContent = '↻';
      this.startText.textContent = 'Retry';
      this.startButton.disabled = false;
    } else {
      this.startSymbol.textContent = '↓';
      this.startText.textContent = 'Load';
      this.startButton.disabled = false;
    }
  }

  startPromptCycle() {
    this.stopPromptCycle();
    this.promptIndex = 0;
    this.setReadyPrompt(READY_PROMPTS[this.promptIndex] || 'Say hello...');
    this.promptTimer = window.setInterval(() => {
      this.promptIndex = (this.promptIndex + 1) % READY_PROMPTS.length;
      this.setReadyPrompt(READY_PROMPTS[this.promptIndex] || 'Say hello...');
    }, 4200);
  }

  stopPromptCycle() {
    window.clearInterval(this.promptTimer);
    this.promptTimer = null;
  }

  setReadyPrompt(text) {
    this.input.placeholder = text;
    this.readyPrompt.textContent = text;
  }

  updatePromptVisibility() {
    this.readyPrompt.hidden = this.input.value.length > 0 || this.status !== 'ready';
  }

  autoSizeInput() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }

  sendMessage() {
    if (this.status !== 'ready' || !this.worker) return;

    let content = this.input.value.trim();
    if (!content) return;

    if (content.length > MAX_INPUT_CHARS) {
      content = content.slice(0, MAX_INPUT_CHARS);
      this.addSystemNotice(`That was long, so I trimmed it to ${MAX_INPUT_CHARS} characters before sending.`);
    }

    this.center.classList.add('local-llm-center--hidden');
    this.input.value = '';
    this.autoSizeInput();
    this.updatePromptVisibility();
    this.messages.push({ role: 'user', content });
    this.messages = this.trimHistory(this.messages);
    this.assistantDraft = { role: 'assistant', content: '' };
    this.messages.push(this.assistantDraft);
    this.renderMessages();
    this.updateStatus('generating', 'Generating locally.');
    this.worker.postMessage({ type: 'generate', messages: this.messages.filter((message) => message.role !== 'notice') });
  }

  appendAssistantToken(token) {
    if (!this.assistantDraft) {
      this.assistantDraft = { role: 'assistant', content: '' };
      this.messages.push(this.assistantDraft);
    }

    this.assistantDraft.content += token;
    this.renderMessages();
  }

  finishAssistantMessage(finalText) {
    if (this.assistantDraft) {
      if (finalText.trim()) this.assistantDraft.content = finalText;
      this.assistantDraft.content = cleanupModelText(this.assistantDraft.content);
      if (!this.assistantDraft.content.trim() && this.status !== 'error' && this.status !== 'unsupported') {
        this.assistantDraft.content = 'I could not produce a useful answer. Try a shorter prompt.';
      }
      if (!this.assistantDraft.content.trim()) {
        this.messages = this.messages.filter((message) => message !== this.assistantDraft);
      }
      this.assistantDraft = null;
      this.messages = this.trimHistory(this.messages);
      this.renderMessages();
    }

    if (this.status !== 'unsupported' && this.status !== 'error') {
      this.updateStatus('ready', 'Ready.');
      this.startPromptCycle();
    }
  }

  finishCancelledGeneration() {
    if (this.assistantDraft) {
      this.assistantDraft.content = cleanupModelText(this.assistantDraft.content) || 'Generation stopped.';
      this.assistantDraft = null;
      this.renderMessages();
    }
    this.updateStatus('ready', 'Generation stopped.');
    this.startPromptCycle();
  }

  trimHistory(messages) {
    const notices = messages.filter((message) => message.role === 'notice').slice(-2);
    const chat = messages.filter((message) => message.role !== 'notice').slice(-12);
    return [...notices, ...chat];
  }

  renderMessages() {
    this.messageList.innerHTML = this.messages.map((message) => {
      const role = message.role === 'user' ? 'You' : message.role === 'notice' ? 'Note' : 'Local Assistant';
      const content = renderMarkdown(message.role === 'assistant' ? cleanupModelText(message.content) : message.content);

      return `
        <article class="local-llm-message local-llm-message--${message.role}">
          <div class="local-llm-message-role">${role}</div>
          <div class="local-llm-message-content">${content}</div>
        </article>
      `;
    }).join('');

    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  addSystemNotice(content) {
    this.messages.push({ role: 'notice', content });
    this.renderMessages();
  }

  showLoadFailure(message) {
    const fallback = buildFailureCopy(message, this.diagnostics);
    this.updateStatus(message.status || 'error', fallback.message);
    this.showCenterCopy(LOADING_COPY[message.status] || LOADING_COPY.error);
    this.updateProgressBar();
    this.showDiagnostics(fallback);
  }

  showDiagnostics(copy) {
    this.diagnosticsPanel.hidden = false;
    this.diagnosticsPanel.innerHTML = `
      <p class="local-llm-diagnostics-title">${escapeHtml(copy.title)}</p>
      <p>${escapeHtml(copy.detail)}</p>
      <p><strong>Try:</strong> ${escapeHtml(copy.likelyFix)}</p>
      <button type="button" class="local-llm-diagnostics-retry" data-local-llm-retry data-cursor="hover">Retry</button>
    `;
  }

  hideDiagnostics() {
    this.diagnosticsPanel.hidden = true;
    this.diagnosticsPanel.innerHTML = '';
  }

  async resetChat({ clearCache = true } = {}) {
    if (this.status === 'generating') {
      this.worker?.postMessage({ type: 'cancel' });
    }

    this.messages = [];
    this.assistantDraft = null;
    this.renderMessages();
    this.progress = 0;
    this.lastProgressTotal = 0;
    this.hideDiagnostics();
    this.stopPromptCycle();

    if (this.worker) {
      this.worker.postMessage({ type: 'dispose', clearCache });
      this.worker.terminate();
      this.worker = null;
    }

    if (clearCache) await deleteLocalModelCaches();
    this.updateProgressBar();
    this.updateStatus('idle', clearCache ? 'Model cache reset. Start again to reload locally.' : 'Ready to retry local loading.');
    this.showCenterCopy(LOADING_COPY.idle);
  }
}

class LocalLlmMockWorker extends EventTarget {
  constructor(mode) {
    super();
    this.mode = mode;
    this.disposed = false;
    this.timerIds = [];
  }

  postMessage(message) {
    if (this.disposed) return;
    if (message.type === 'load') this.mockLoad();
    if (message.type === 'generate') this.mockGenerate();
    if (message.type === 'cancel') this.emit({ type: 'cancelled' });
    if (message.type === 'dispose') this.emit({ type: 'disposed', state: 'disposed' });
  }

  terminate() {
    this.disposed = true;
    this.timerIds.forEach((id) => window.clearTimeout(id));
    this.timerIds = [];
  }

  mockLoad() {
    this.emit({
      type: 'capabilities',
      capabilities: {
        secureContext: true,
        webAssembly: true,
        wasmMemory64: true,
        cacheApi: true,
        crossOriginIsolated: false,
        hardwareConcurrency: 4,
        userAgent: 'mock'
      }
    });

    if (this.mode === 'unsupported') {
      this.queue(() => this.emit({
        type: 'error',
        status: 'unsupported',
        category: 'unsupported-browser',
        message: 'This browser cannot run the local GGUF runtime.',
        detail: 'Mocked unsupported Memory64 environment.',
        likelyFix: 'Try current Chrome or Edge.'
      }), 80);
      return;
    }

    this.queue(() => this.emit({ type: 'status', state: 'runtime-loading', message: 'Starting local runtime.' }), 20);
    this.queue(() => this.emit({
      type: 'progress',
      state: 'model-downloading',
      loaded: 124000000,
      total: 248000000,
      progress: 50,
      file: LOCAL_LLM_CONFIG.model.file
    }), 80);
    this.queue(() => this.emit({ type: 'status', state: 'model-loading', message: 'Preparing the GGUF runtime context.' }), 140);
    this.queue(() => this.emit({
      type: 'ready',
      state: 'ready',
      status: 'ready',
      backend: 'mock-wasm',
      model: LOCAL_LLM_CONFIG.model.displayName,
      runtime: 'Mock Wllama'
    }), 220);
  }

  mockGenerate() {
    const text = 'This is a mocked Bonsai response from the browser-only assistant.';
    this.emit({ type: 'status', state: 'generating', message: 'Generating locally.' });
    this.queue(() => this.emit({ type: 'token', token: text.slice(0, 24) }), 20);
    this.queue(() => this.emit({ type: 'token', token: text.slice(24) }), 60);
    this.queue(() => this.emit({ type: 'complete', text, backend: 'mock-wasm' }), 90);
  }

  queue(callback, delay) {
    const id = window.setTimeout(() => {
      if (!this.disposed) callback();
    }, delay);
    this.timerIds.push(id);
  }

  emit(detail) {
    this.dispatchEvent(new MessageEvent('message', { data: detail }));
  }
}

function buildFailureCopy(message, diagnostics) {
  const category = message.category || 'runtime-failed';
  let likelyFix = message.likelyFix || 'Try a current desktop browser with enough memory.';
  let detail = message.detail || message.message || 'The browser could not initialize the local model.';

  if (diagnostics?.webAssembly === false) {
    detail = 'WebAssembly is unavailable in this browser context.';
    likelyFix = 'Use a current desktop browser with WebAssembly enabled.';
  } else if (diagnostics?.wasmMemory64 === false && category === 'unsupported-browser') {
    detail = 'The GGUF runtime needs WASM Memory64, which this browser does not expose.';
    likelyFix = 'Try current Chrome or Edge. Safari support is limited for this runtime.';
  } else if (category === 'download-failed') {
    detail = 'The worker started, but the Bonsai model or Wllama runtime could not be downloaded.';
    likelyFix = 'Check network access to Hugging Face and jsDelivr, then retry.';
  } else if (category === 'out-of-memory') {
    detail = 'The browser ran out of memory while loading or generating with the local model.';
    likelyFix = 'Close memory-heavy tabs, reset the model, and try a shorter prompt.';
  }

  return {
    title: category === 'unsupported-browser' ? 'Browser not supported' : 'Local model could not start',
    message: message.message || 'This browser could not load the local model.',
    detail,
    likelyFix
  };
}

function cleanupModelText(text) {
  return String(text || '')
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<think[\s\S]*$/gi, '')
    .replace(/<\/?(?:s|pad|bos|eos|endoftext|im_start|im_end|\|im_start\||\|im_end\|)>/gi, '')
    .replace(/<\|[^|]+?\|>/g, '')
    .trim();
}

function renderMarkdown(markdown) {
  const escaped = escapeHtml(markdown);
  const blocks = escaped.split(/\n{2,}/).map((block) => {
    if (/^```/.test(block)) {
      return `<pre><code>${block.replace(/^```[a-z0-9-]*\n?/i, '').replace(/```$/i, '')}</code></pre>`;
    }

    const inline = block
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/\n/g, '<br>');

    return `<p>${inline}</p>`;
  });

  return blocks.join('');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatStatus(status) {
  return status
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function deleteLocalModelCaches() {
  if (!window.caches?.keys || !window.caches?.delete) return false;

  try {
    const cacheNames = await window.caches.keys();
    const targets = cacheNames.filter((name) => /wllama|huggingface|transformers|local-llm/i.test(name));
    await Promise.all(targets.map((name) => window.caches.delete(name)));
    return true;
  } catch {
    return false;
  }
}

function initLocalLlmUtility() {
  const root = document.getElementById('localLlmUtilityApp');
  if (!root || root.dataset.localLlmMounted === 'true') return;
  root.dataset.localLlmMounted = 'true';
  new LocalLlmUtility(root);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLocalLlmUtility, { once: true });
} else {
  initLocalLlmUtility();
}
