import { LOCAL_LLM_CONFIG, WORKER_STATE } from './local-llm-config.js';

const MAX_INPUT_CHARS = LOCAL_LLM_CONFIG.limits.maxInputChars;
const READY_PROMPTS = [
  'Ask the local model anything...',
  'Draft a short explanation...',
  'Summarize a thought...',
  'Try a browser-only brainstorm...'
];

const STATE_COPY = {
  idle: `Load ${LOCAL_LLM_CONFIG.model.displayName} to start a private browser-only chat.`,
  checking: 'Checking WebGPU support.',
  loading: `Downloading ${LOCAL_LLM_CONFIG.model.displayName}.`,
  optimizing: 'Optimizing the model for WebGPU execution.',
  ready: 'Ready. Messages stay in this browser.',
  thinking: 'Thinking locally.',
  streaming: 'Streaming locally.',
  error: 'Local model unavailable.',
  unsupported: 'This browser cannot run the local WebGPU model.'
};

const LOAD_CONTROL = {
  idle: { text: 'Load', disabled: false },
  checking: { text: 'Check', disabled: true, cls: 'local-llm-load-control--loading' },
  loading: { text: '0%', disabled: true, cls: 'local-llm-load-control--loading' },
  optimizing: { text: 'Tune', disabled: true, cls: 'local-llm-load-control--loading' },
  ready: { text: 'Ready', disabled: true, cls: 'local-llm-load-control--ready' },
  thinking: { text: 'Busy', disabled: true, cls: 'local-llm-load-control--ready' },
  streaming: { text: 'Busy', disabled: true, cls: 'local-llm-load-control--ready' },
  error: { text: 'Retry', disabled: false, cls: 'local-llm-load-control--error' },
  unsupported: { text: 'Retry', disabled: false, cls: 'local-llm-load-control--error' }
};

class LocalLlmUtility {
  constructor(root) {
    this.root = root;
    this.worker = null;
    this.messages = [];
    this.status = WORKER_STATE.IDLE;
    this.progress = 0;
    this.backend = 'webgpu';
    this.modelReady = false;
    this.tps = null;
    this.numTokens = 0;
    this.promptTimer = null;
    this.promptIndex = 0;
    this.assistantDraft = null;
    this.diagnostics = null;
    this.typingTimer = null;
    this._lastAssistantElement = null;
    this._workerMessageHandler = null;
    this._workerErrorHandler = null;

    this.mount();
    this.bindEvents();
    this.renderMessages();
    this.updateStatus(WORKER_STATE.IDLE, STATE_COPY.idle);
    this.renderStatePanel();
  }

  mount() {
    this.root.innerHTML = `
      <div class="utility-layout utility-layout--local-llm">
        <div class="utility-view utility-view--minimal">
          <article class="canvas-panel-minimal canvas-panel--local-llm" style="flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 0; border: none; background: transparent;">
            <header class="local-llm-header">
              <div class="local-llm-title-block">
                <div class="local-llm-title-row">
                  <span class="utility-kicker" style="margin-bottom: 0;">Local Assistant</span>
                  <span class="local-llm-card utility-status-chip utility-status-chip--idle" id="localLlmStatusChip" style="margin-left: 0.5rem; padding: 0.22rem 0.55rem; border-radius: var(--radius-full); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: var(--tracking-wide); text-transform: uppercase;">Idle</span>
                </div>
                <div class="local-llm-meta" aria-label="Model runtime details" style="color: var(--color-text-secondary); font-size: 0.78rem;">
                  <span id="localLlmModelName">${escapeHtml(LOCAL_LLM_CONFIG.model.displayName)}</span> •
                  <span id="localLlmBackend">WebGPU</span> •
                  <span><span id="localLlmTps">--</span> tok/s</span>
                </div>
              </div>
              <div class="local-llm-header-actions" style="display: flex; gap: 0.5rem;">
                <button type="button" class="btn-secondary-utility btn-secondary-utility--compact" id="localLlmResetBtn" data-cursor="hover">Reset</button>
              </div>
            </header>

            <div class="local-llm-transcript" id="localLlmTranscript">
              <div id="localLlmLiveRegion" class="local-llm-live-region" aria-live="polite" aria-atomic="true"></div>
              <div class="local-llm-thread" id="localLlmMessages"></div>
              <section class="local-llm-center" id="localLlmCenter" aria-live="polite">
                <p class="local-llm-load-copy" id="localLlmLoadCopy"></p>
                <p class="local-llm-model-note" id="localLlmModelNote"></p>
                <div class="local-llm-progress-wrap" id="localLlmProgressWrap" hidden>
                  <div class="utility-progress-bar-minimal" role="progressbar" aria-label="Model download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="localLlmProgressBar" style="flex: 1;">
                    <span class="local-llm-progress-fill" id="localLlmProgressFill"></span>
                  </div>
                  <span class="local-llm-progress-percent" id="localLlmProgressPercent">0%</span>
                </div>
                <div class="local-llm-diagnostics" id="localLlmDiagnostics" hidden></div>
              </section>
            </div>

            <form class="local-llm-form" id="localLlmForm">
              <button type="button" class="btn-secondary-utility local-llm-load-control" id="localLlmStartBtn" aria-label="Download and start the local model" data-cursor="hover">
                <span class="local-llm-load-control-text">Load</span>
              </button>
              <label class="local-llm-label" for="localLlmInput">Message the local AI</label>
              <div class="local-llm-input-shell">
                <textarea id="localLlmInput" class="control-input local-llm-input" rows="1" maxlength="${MAX_INPUT_CHARS}" placeholder="Load the model first." disabled></textarea>
                <span class="local-llm-ready-prompt" id="localLlmReadyPrompt" aria-hidden="true">Load the model first.</span>
                <span class="local-llm-char-count" id="localLlmCharCount" aria-hidden="true" hidden></span>
                <span class="local-llm-typing" id="localLlmTyping" hidden><span class="local-llm-typing-dot"></span><span class="local-llm-typing-dot"></span><span class="local-llm-typing-dot"></span></span>
              </div>
              <button class="btn-primary-utility local-llm-send" type="submit" aria-label="Send message" disabled data-cursor="hover">
                <span class="local-llm-send-text">Send</span>
              </button>
            </form>
          </article>
        </div>
      </div>
    `;

    this.startButton = this.root.querySelector('#localLlmStartBtn');
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
    this.backendLabel = this.root.querySelector('#localLlmBackend');
    this.tpsLabel = this.root.querySelector('#localLlmTps');
    this.transcript = this.root.querySelector('#localLlmTranscript');
    this.messageList = this.root.querySelector('#localLlmMessages');
    this.form = this.root.querySelector('#localLlmForm');
    this.input = this.root.querySelector('#localLlmInput');
    this.readyPrompt = this.root.querySelector('#localLlmReadyPrompt');
    this.charCount = this.root.querySelector('#localLlmCharCount');
    this.typingIndicator = this.root.querySelector('#localLlmTyping');
    this.sendButton = this.root.querySelector('.local-llm-send');
    this.sendText = this.root.querySelector('.local-llm-send-text');
  }

  bindEvents() {
    this.startButton.addEventListener('click', () => this.startChat());
    this.resetButton.addEventListener('click', () => this.resetChat({ clearMessages: true }));
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (this.status === WORKER_STATE.THINKING || this.status === WORKER_STATE.STREAMING) {
        this.interruptGeneration();
      } else {
        this.sendMessage();
      }
    });
    this.input.addEventListener('input', () => {
      this.updatePromptVisibility();
      this.autoSizeInput();
      this.updateCharCount();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.sendMessage();
      }
      if (event.key === 'Escape' && this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING) {
        this.input.blur();
      }
    });
    this.diagnosticsPanel.addEventListener('click', (event) => {
      if (event.target.closest('[data-local-llm-retry]')) {
        this.startChat();
      }
      if (event.target.closest('[data-local-llm-clear-cache]')) {
        this.clearModelCache();
      }
    });
    window.addEventListener('pagehide', () => {
      this.worker?.terminate();
    });
    this.root.addEventListener('utility-deactivate', () => {
      if (this.status === WORKER_STATE.THINKING || this.status === WORKER_STATE.STREAMING) {
        this.interruptGeneration();
      }
    });
  }

  ensureWorker() {
    if (this.worker) return this.worker;

    this.worker = this.createWorker();
    this._workerMessageHandler = (event) => this.handleWorkerMessage(event.data || {});
    this._workerErrorHandler = () => {
      this.showLoadFailure({
        status: WORKER_STATE.ERROR,
        category: 'worker-failed',
        message: 'The browser blocked the local model worker before it could start.',
        detail: 'Module workers need HTTPS, localhost, or a normal static server.',
        likelyFix: 'Open this page from GitHub Pages, HTTPS, or localhost, then retry.'
      });
    };
    this.worker.addEventListener('message', this._workerMessageHandler);
    this.worker.addEventListener('error', this._workerErrorHandler);
    return this.worker;
  }

  createWorker() {
    if (window.__OD_LOCAL_LLM_TEST_MODE__) {
      return new LocalLlmMockWorker(window.__OD_LOCAL_LLM_TEST_MODE__);
    }
    return new Worker(new URL('./local-llm-worker.js', import.meta.url), { type: 'module' });
  }

  startChat() {
    if (this.status === WORKER_STATE.READY || this.isBusy()) return;

    this.progress = 0;
    this.tps = null;
    this.numTokens = 0;
    this.diagnostics = null;
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.updateProgressBar();
    this.updateStatus(WORKER_STATE.CHECKING, 'Checking WebGPU support.');
    this.renderStatePanel();

    try {
      this.ensureWorker().postMessage({ type: 'load' });
    } catch {
      this.showLoadFailure({
        status: WORKER_STATE.UNSUPPORTED,
        category: 'worker-unavailable',
        message: 'This browser could not create the local model worker.',
        detail: 'The Worker API was unavailable in this page context.',
        likelyFix: 'Try a current desktop browser from HTTPS or localhost.'
      });
    }
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
      this.backend = message.backend || 'webgpu';
      this.modelReady = true;
      this.updateProgressBar();
      this.hideDiagnostics();
      this.updateStatus(WORKER_STATE.READY, message.message || 'Ready.');
      this.startPromptCycle();
      this.input.focus({ preventScroll: true });
      this.renderStatePanel();
      return;
    }

    if (message.type === 'status') {
      this.updateStatusFromWorker(message);
      return;
    }

    if (message.type === 'start') {
      this.ensureAssistantDraft();
      this.showTypingAfterDelay();
      return;
    }

    if (message.type === 'token') {
      this.hideTypingIndicator();
      this.tps = Number.isFinite(message.tps) ? message.tps : this.tps;
      this.numTokens = Number.isFinite(message.numTokens) ? message.numTokens : this.numTokens;
      this.updateTelemetry();
      this.appendAssistantToken(message.token || '');
      return;
    }

    if (message.type === 'complete') {
      this.tps = Number.isFinite(message.tps) ? message.tps : this.tps;
      this.numTokens = Number.isFinite(message.numTokens) ? message.numTokens : this.numTokens;
      this.updateTelemetry();
      this.finishAssistantMessage(message.text || '');
      return;
    }

    if (message.type === 'interrupted') {
      this.finishInterruptedGeneration();
      return;
    }

    if (message.type === 'reset') {
      this.hideTypingIndicator();
      this.assistantDraft = null;
      this.updateStatus(this.modelReady ? WORKER_STATE.READY : WORKER_STATE.IDLE, this.modelReady ? 'Chat reset.' : STATE_COPY.idle);
      this.renderStatePanel();
      return;
    }

    if (message.type === 'error') {
      this.showLoadFailure(message);
      this.finishAssistantMessage('');
      return;
    }

    if (message.type === 'disposed') {
      this.worker = null;
      this.modelReady = false;
      this.updateStatus(WORKER_STATE.IDLE, 'Model cache reset. Start again to reload locally.');
      this.renderStatePanel();
    }
  }

  updateProgress(message) {
    const progress = Number.isFinite(message.progress) ? Math.round(message.progress) : null;
    if (progress !== null) {
      this.progress = Math.max(this.progress, Math.min(99, progress));
    } else if (this.progress < 8) {
      this.progress = 8;
    }

    const state = message.state === WORKER_STATE.OPTIMIZING ? WORKER_STATE.OPTIMIZING : WORKER_STATE.LOADING;
    this.updateStatus(state, state === WORKER_STATE.OPTIMIZING ? STATE_COPY.optimizing : STATE_COPY.loading);
    this.updateProgressBar();
    this.renderStatePanel();
  }

  updateStatusFromWorker(message) {
    const nextState = message.state || message.status || WORKER_STATE.CHECKING;
    const copy = message.message || STATE_COPY[nextState] || 'Working locally.';
    this.updateStatus(nextState, copy);
    if (nextState === WORKER_STATE.OPTIMIZING && this.progress < 99) {
      this.progress = 99;
      this.updateProgressBar();
    }
    this.renderStatePanel();
  }

  updateStatus(status, label = '') {
    this.status = status;
    this.root.dataset.localLlmStatus = status;
    this.root.dataset.localLlmStatusMessage = label;

    const chipState = (this.isBusy(status) || status === WORKER_STATE.THINKING || status === WORKER_STATE.STREAMING)
      ? 'processing'
      : status === WORKER_STATE.UNSUPPORTED
        ? 'error'
        : status;
    this.statusChip.textContent = formatStatus(status);
    this.statusChip.className = `local-llm-card utility-status-chip utility-status-chip--${chipState}`;

    const canType = status === WORKER_STATE.READY;
    const canStop = status === WORKER_STATE.THINKING || status === WORKER_STATE.STREAMING;
    this.input.disabled = !canType;
    this.sendButton.disabled = !(canType || canStop);
    this.sendButton.classList.toggle('local-llm-send--stop', canStop);
    this.sendText.textContent = canStop ? 'Stop' : 'Send';
    this.resetButton.disabled = this.isBusy(status);
    this.progressWrap.hidden = !(this.isBusy(status) || status === WORKER_STATE.UNSUPPORTED);

    if (status === WORKER_STATE.READY) {
      this.setReadyPrompt(READY_PROMPTS[this.promptIndex] || 'Say hello...');
    } else if (status === WORKER_STATE.ERROR || status === WORKER_STATE.UNSUPPORTED) {
      this.stopPromptCycle();
      this.input.placeholder = 'The local model is not available here.';
      this.readyPrompt.textContent = 'The local model is not available here.';
    } else if (status === WORKER_STATE.IDLE) {
      this.stopPromptCycle();
      this.input.placeholder = 'Load the model first.';
      this.readyPrompt.textContent = 'Load the model first.';
    } else if (status === WORKER_STATE.THINKING || status === WORKER_STATE.STREAMING) {
      this.stopPromptCycle();
    }

    this.updatePromptVisibility();
    this.updateLoadControl();
    this.updateTelemetry();
  }

  isBusy(status = this.status) {
    return status === WORKER_STATE.CHECKING || status === WORKER_STATE.LOADING || status === WORKER_STATE.OPTIMIZING;
  }

  updateLoadControl() {
    const appearance = LOAD_CONTROL[this.status] || LOAD_CONTROL.idle;

    this.startButton.disabled = appearance.disabled;
    this.startButton.classList.remove('local-llm-load-control--loading', 'local-llm-load-control--ready', 'local-llm-load-control--error');
    if (appearance.cls) this.startButton.classList.add(appearance.cls);

    this.startText.textContent = this.status === WORKER_STATE.LOADING
      ? `${Math.max(0, Math.min(100, this.progress))}%`
      : appearance.text;
  }

  updateTelemetry() {
    this.backendLabel.textContent = this.backend === 'webgpu' ? 'WebGPU' : this.backend;
    this.tpsLabel.textContent = Number.isFinite(this.tps) ? this.tps.toFixed(1) : '--';
  }

  updateProgressBar() {
    const value = Math.max(0, Math.min(100, this.progress));
    this.progressBar.setAttribute('aria-valuenow', String(value));
    this.progressFill.style.width = `${value}%`;
    this.progressPercent.textContent = `${value}%`;
    this.updateLoadControl();
  }

  renderStatePanel() {
    const hasMessages = this.messages.length > 0;
    const shouldShowPanel = !hasMessages || this.isBusy() || this.status === WORKER_STATE.ERROR || this.status === WORKER_STATE.UNSUPPORTED;
    this.center.hidden = !shouldShowPanel;
    this.center.classList.toggle('local-llm-center--hidden', !shouldShowPanel);
    if (!shouldShowPanel) return;

    const copy = STATE_COPY[this.status] || this.root.dataset.localLlmStatusMessage || 'Working locally.';
    this.loadCopy.textContent = copy;
    this.modelNote.textContent = `${LOCAL_LLM_CONFIG.model.displayName} (${LOCAL_LLM_CONFIG.model.sizeLabel}) · ${LOCAL_LLM_CONFIG.runtime.name} · private to this browser`;
    this.progressWrap.hidden = !(this.isBusy() || this.status === WORKER_STATE.UNSUPPORTED);
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
    this.readyPrompt.hidden = this.input.value.length > 0 || this.status !== WORKER_STATE.READY;
  }

  autoSizeInput() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 160)}px`;
  }

  updateCharCount() {
    const len = this.input.value.length;
    const remaining = MAX_INPUT_CHARS - len;
    if (remaining <= 600) {
      this.charCount.hidden = false;
      this.charCount.textContent = `${remaining}`;
      this.charCount.style.color = remaining <= 100 ? '#ff8888' : '';
    } else {
      this.charCount.hidden = true;
    }
  }

  showTypingAfterDelay() {
    this.hideTypingIndicator();
    this.typingTimer = setTimeout(() => {
      this.typingIndicator.hidden = false;
    }, 350);
  }

  hideTypingIndicator() {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    this.typingIndicator.hidden = true;
  }

  sendMessage() {
    if (this.status !== WORKER_STATE.READY || !this.worker) return;

    let content = this.input.value.trim();
    if (!content) return;

    if (content.length > MAX_INPUT_CHARS) {
      content = content.slice(0, MAX_INPUT_CHARS);
      this.addSystemNotice(`That was long, so I trimmed it to ${MAX_INPUT_CHARS} characters before sending.`);
    }

    this.tps = null;
    this.numTokens = 0;
    this.input.value = '';
    this.autoSizeInput();
    this.updatePromptVisibility();
    this.messages.push({ role: 'user', content });
    this.messages = this.trimHistory(this.messages);
    this.assistantDraft = null;
    this.renderMessages();
    this.ensureAssistantDraft();
    this.updateStatus(WORKER_STATE.THINKING, 'Thinking locally.');
    this.renderStatePanel();
    this.showTypingAfterDelay();
    this.worker.postMessage({ type: 'generate', messages: this.messages.filter((message) => message.role !== 'notice') });
  }

  ensureAssistantDraft() {
    if (this.assistantDraft) return;
    this.assistantDraft = { role: 'assistant', content: '' };
    this.messages.push(this.assistantDraft);
    this.renderMessages();
  }

  appendAssistantToken(token) {
    this.ensureAssistantDraft();
    this.assistantDraft.content += token;
    this.updateAssistantElement();
  }

  finishAssistantMessage(finalText) {
    if (this.assistantDraft) {
      if (finalText && cleanupModelText(finalText).length >= cleanupModelText(this.assistantDraft.content).length) {
        this.assistantDraft.content = finalText;
      }
      this.assistantDraft.content = cleanupModelText(this.assistantDraft.content);
      if (!this.assistantDraft.content.trim() && this.status !== WORKER_STATE.ERROR && this.status !== WORKER_STATE.UNSUPPORTED) {
        this.assistantDraft.content = 'I could not produce a useful answer. Try a shorter prompt.';
      }
      if (!this.assistantDraft.content.trim()) {
        this.messages = this.messages.filter((message) => message !== this.assistantDraft);
      }
      this.assistantDraft = null;
      this.messages = this.trimHistory(this.messages);
      this.renderMessages();
      this.announceLastAssistantMessage();
    }

    if (this.status !== WORKER_STATE.UNSUPPORTED && this.status !== WORKER_STATE.ERROR) {
      this.hideTypingIndicator();
      this.updateStatus(WORKER_STATE.READY, 'Ready.');
      this.startPromptCycle();
      this.renderStatePanel();
    }
  }

  finishInterruptedGeneration() {
    this.hideTypingIndicator();
    if (this.assistantDraft) {
      this.assistantDraft.content = cleanupModelText(this.assistantDraft.content) || 'Generation stopped.';
      this.assistantDraft = null;
      this.renderMessages();
      this.announceLastAssistantMessage();
    }
    this.updateStatus(WORKER_STATE.READY, 'Generation stopped.');
    this.startPromptCycle();
    this.renderStatePanel();
  }

  interruptGeneration() {
    if (!this.worker || (this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING)) return;
    this.worker.postMessage({ type: 'interrupt' });
  }

  trimHistory(messages) {
    const notices = messages.filter((message) => message.role === 'notice').slice(-2);
    const chat = messages.filter((message) => message.role !== 'notice').slice(-LOCAL_LLM_CONFIG.limits.maxHistoryMessages);
    return [...notices, ...chat];
  }

  renderMessages() {
    const fragment = document.createDocumentFragment();
    this._lastAssistantElement = null;

    for (const message of this.messages) {
      const role = message.role === 'user' ? 'You' : message.role === 'notice' ? 'Note' : 'Local Assistant';
      const article = document.createElement('article');
      article.className = `local-llm-message local-llm-message--${message.role}`;
      article.setAttribute('aria-label', role);
      article.innerHTML = `
        <div class="local-llm-message-role">${role}</div>
        <div class="local-llm-message-content">${renderSafeText(message.content)}</div>
      `;

      if (message.role === 'assistant') this._lastAssistantElement = article;
      fragment.appendChild(article);
    }

    this.messageList.innerHTML = '';
    this.messageList.appendChild(fragment);
    this.scrollMessagesIfNeeded();
    this.renderStatePanel();
  }

  updateAssistantElement() {
    if (!this._lastAssistantElement || !this.assistantDraft) return;
    const contentDiv = this._lastAssistantElement.querySelector('.local-llm-message-content');
    if (contentDiv) {
      contentDiv.innerHTML = renderSafeText(this.assistantDraft.content);
    }
    this.scrollMessagesIfNeeded();
  }

  scrollMessagesIfNeeded() {
    const threshold = 96;
    const diff = this.messageList.scrollHeight - this.messageList.clientHeight - this.messageList.scrollTop;
    if (diff <= threshold) {
      this.messageList.scrollTop = this.messageList.scrollHeight;
    }
  }

  announceLastAssistantMessage() {
    const liveRegion = this.root.querySelector('#localLlmLiveRegion');
    const last = this.messages.filter((message) => message.role === 'assistant').pop();
    if (liveRegion && last) liveRegion.textContent = last.content;
  }

  addSystemNotice(content) {
    this.messages.push({ role: 'notice', content });
    this.renderMessages();
  }

  showLoadFailure(message) {
    const fallback = buildFailureCopy(message, this.diagnostics);
    this.updateStatus(message.status || WORKER_STATE.ERROR, fallback.message);
    this.progress = 0;
    this.updateProgressBar();
    this.showDiagnostics(fallback);
    this.renderStatePanel();
  }

  showDiagnostics(copy) {
    this.diagnosticsPanel.hidden = false;
    this.diagnosticsPanel.innerHTML = `
      <p class="local-llm-diagnostics-title">${escapeHtml(copy.title)}</p>
      <p>${escapeHtml(copy.detail)}</p>
      <p><strong>Try:</strong> ${escapeHtml(copy.likelyFix)}</p>
      <div class="local-llm-diagnostics-actions">
        <button type="button" class="local-llm-diagnostics-retry" data-local-llm-retry data-cursor="hover">Retry</button>
        <button type="button" class="local-llm-diagnostics-retry" data-local-llm-clear-cache data-cursor="hover">Clear cache</button>
      </div>
    `;
  }

  hideDiagnostics() {
    this.diagnosticsPanel.hidden = true;
    this.diagnosticsPanel.innerHTML = '';
  }

  resetChat({ clearMessages = true } = {}) {
    if (this.status === WORKER_STATE.THINKING || this.status === WORKER_STATE.STREAMING) {
      this.interruptGeneration();
    }
    if (clearMessages) {
      this.messages = [];
      this.assistantDraft = null;
      this.renderMessages();
    }
    this.tps = null;
    this.numTokens = 0;
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.worker?.postMessage({ type: 'reset' });
    this.updateTelemetry();
    this.updateStatus(this.modelReady ? WORKER_STATE.READY : WORKER_STATE.IDLE, this.modelReady ? 'Chat reset.' : STATE_COPY.idle);
    if (this.modelReady) this.startPromptCycle();
    this.renderStatePanel();
  }

  async clearModelCache() {
    this.worker?.terminate();
    this.worker = null;
    this.modelReady = false;
    this.messages = [];
    this.assistantDraft = null;
    this.progress = 0;
    this.tps = null;
    this.numTokens = 0;
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.renderMessages();
    const cacheCleared = await deleteLocalModelCaches();
    if (!cacheCleared) {
      this.addSystemNotice('Cache deletion failed. The model may reload from cache. Try a hard refresh if issues persist.');
    }
    this.updateProgressBar();
    this.updateStatus(WORKER_STATE.IDLE, 'Model cache reset. Start again to reload locally.');
    this.renderStatePanel();
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
    if (message.type === 'interrupt' || message.type === 'cancel') this.emit({ type: 'interrupted' });
    if (message.type === 'reset') this.emit({ type: 'reset', state: WORKER_STATE.READY });
    if (message.type === 'dispose') this.emit({ type: 'disposed', state: WORKER_STATE.DISPOSED });
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

  mockGenerate() {
    const text = 'This is a mocked Bonsai response from the browser-only assistant.';
    this.emit({ type: 'status', state: WORKER_STATE.THINKING, message: 'Thinking locally.' });
    this.queue(() => this.emit({ type: 'start' }), 20);
    this.queue(() => this.emit({ type: 'status', state: WORKER_STATE.STREAMING, message: 'Streaming locally.' }), 30);
    this.queue(() => this.emit({ type: 'token', token: text.slice(0, 24), tps: 12.3, numTokens: 4 }), 60);
    this.queue(() => this.emit({ type: 'token', token: text.slice(24), tps: 18.7, numTokens: 10 }), 110);
    this.queue(() => this.emit({ type: 'complete', text, backend: 'mock-webgpu', tps: 18.7, numTokens: 10 }), 150);
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
  let likelyFix = message.likelyFix || 'Try a current desktop browser with WebGPU enabled.';
  let detail = message.detail || message.message || 'The browser could not initialize the local model.';

  if (diagnostics?.webGpu === false || category === 'unsupported-browser') {
    detail = 'WebGPU is unavailable in this browser context.';
    likelyFix = 'Use current Chrome or Edge with WebGPU enabled. Firefox and Safari support may require flags.';
  } else if (category === 'download-failed') {
    detail = 'The worker started, but the Bonsai model or Transformers.js runtime could not be downloaded.';
    likelyFix = 'Check network access to Hugging Face and jsDelivr, then retry.';
  } else if (category === 'out-of-memory') {
    detail = 'The browser ran out of memory while loading or generating with the local model.';
    likelyFix = 'Close memory-heavy tabs, reset the model, and try a shorter prompt.';
  }

  return {
    title: category === 'unsupported-browser' ? 'WebGPU not available' : 'Local model could not start',
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

function renderSafeText(markdown) {
  const source = cleanupModelText(markdown);
  if (!source) return '';

  const blocks = source.split(/\n{2,}/).map((rawBlock) => {
    const block = escapeHtml(rawBlock);
    if (/^```/.test(rawBlock.trim())) {
      return `<pre><code>${block.replace(/^```[a-z0-9-]*\n?/i, '').replace(/```$/i, '')}</code></pre>`;
    }

    if (/^\s*[-*]\s/m.test(rawBlock)) {
      const items = block
        .split(/\n/)
        .filter((line) => /^\s*[-*]\s/.test(line))
        .map((line) => `<li>${line.replace(/^\s*[-*]\s*/, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }

    if (/^\s*\d+\.\s/m.test(rawBlock)) {
      const items = block
        .split(/\n/)
        .filter((line) => /^\s*\d+\.\s/.test(line))
        .map((line) => `<li>${line.replace(/^\s*\d+\.\s*/, '')}</li>`)
        .join('');
      return `<ol>${items}</ol>`;
    }

    const inline = block
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
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
  return String(status || '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function deleteLocalModelCaches() {
  if (!window.caches?.keys || !window.caches?.delete) return false;

  try {
    const cacheNames = await window.caches.keys();
    const targets = cacheNames.filter((name) => /huggingface|transformers|local-llm|bonsai/i.test(name));
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
