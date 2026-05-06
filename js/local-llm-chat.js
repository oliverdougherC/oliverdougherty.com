import { LOCAL_LLM_CONFIG, WORKER_STATE } from './local-llm-config.js';

const MAX_INPUT_CHARS = LOCAL_LLM_CONFIG.limits.maxInputChars;
const READY_PROMPTS = [
  'Ask a concise question...',
  'Draft a tiny explanation...',
  'Summarize a thought...',
  'Try a local-only brainstorm...'
];

const LOADING_MESSAGES = [
  { threshold: 0, state: 'runtime-loading', text: 'Runs in this browser.' },
  { threshold: 8, state: 'model-downloading', text: 'Downloading a tiny Bonsai.' },
  { threshold: 28, state: 'model-downloading', text: 'Caching the model so the next visit is less dramatic.' },
  { threshold: 52, state: 'model-downloading', text: 'Still local. Still private. Still a little weird.' },
  { threshold: 74, state: 'model-downloading', text: 'Teaching the browser where all the small weights go.' },
  { threshold: 92, state: 'model-loading', text: 'Almost there. Be gentle; it is pocket-sized.' }
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

const LOAD_CONTROL_STATE = {
  loading: { symbol: '\u2026', cls: 'local-llm-load-control--loading', disabled: true },
  ready: { symbol: '\u2713', cls: 'local-llm-load-control--ready', text: 'Ready', disabled: true },
  generating: { symbol: '\u2713', cls: 'local-llm-load-control--ready', text: 'Busy', disabled: true },
  unsupported: { symbol: '\u21AB', cls: 'local-llm-load-control--error', text: 'Retry', disabled: false },
  error: { symbol: '\u21AB', cls: 'local-llm-load-control--error', text: 'Retry', disabled: false },
  idle: { symbol: '\u2193', cls: '', text: 'Load', disabled: false }
};

const LOAD_CONTROL_GROUP = {
  'runtime-loading': 'loading',
  'model-downloading': 'loading',
  'model-loading': 'loading',
  ready: 'ready',
  generating: 'generating',
  unsupported: 'unsupported',
  error: 'error'
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
    this.loadingMessageIndex = -1;
    this._lastAssistantElement = null;

    this.mount();
    this.bindEvents();
    this.renderMessages();
    this.updateStatus('idle', 'Idle.');
    this.showCenterCopy(LOADING_COPY.idle);
  }

  mount() {
    this.root.innerHTML = `
      <div class="local-llm-window">
        <div class="local-llm-transcript" id="localLlmTranscript">
          <div id="localLlmLiveRegion" class="local-llm-live-region" aria-live="polite" aria-atomic="true"></div>
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
              <div class="utility-progress-bar local-llm-progress" role="progressbar" aria-label="Model download progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="localLlmProgressBar">
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
            <span class="local-llm-char-count" id="localLlmCharCount" aria-hidden="true" hidden></span>
            <span class="local-llm-typing" id="localLlmTyping" hidden><span class="local-llm-typing-dot"></span><span class="local-llm-typing-dot"></span><span class="local-llm-typing-dot"></span></span>
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
    this.charCount = this.root.querySelector('#localLlmCharCount');
    this.typingIndicator = this.root.querySelector('#localLlmTyping');
    this.typingTimer = null;
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
      this.updateCharCount();
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        this.sendMessage();
      }
      if (event.key === 'Escape' && this.status !== 'generating') {
        this.input.blur();
      }
    });
    this.diagnosticsPanel.addEventListener('click', (event) => {
      if (event.target.closest('[data-local-llm-retry]')) {
        this.resetChat({ clearCache: false }).then(() => this.startChat()).catch(() => {
          this.updateStatus('error', 'Retry failed. Check network and try again.');
        });
      }
    });
    window.addEventListener('pagehide', () => {
      this.worker?.terminate();
    });
    this.root.addEventListener('utility-deactivate', () => {
      this.resetChat({ clearCache: false });
    });
  }

  startChat() {
    if (this.status === 'ready' || this.status === 'generating' || this.isLoading()) return;

    this.progress = 0;
    this.diagnostics = null;
    this.loadingMessageIndex = -1;
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.showLoadingCopy('runtime-loading');
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
      this.hideCenterPanel();
      this.startPromptCycle();
      this.input.focus({ preventScroll: true });
      return;
    }

    if (message.type === 'status') {
      this.updateStatusFromWorker(message);
      return;
    }

    if (message.type === 'token') {
      this.hideTypingIndicator();
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
    if (this.isLoading(state)) {
      this.showLoadingCopy(state);
    } else if (state === 'error' || state === 'unsupported') {
      this.showCenterCopy(LOADING_COPY[state] || copy);
    } else {
      this.hideCenterPanel();
    }
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

    // Use the state reported by the worker instead of hardcoding 'model-downloading'.
    // This prevents overwriting 'model-loading' with a stale status.
    const state = message.state === WORKER_STATE.MODEL_LOADING
      ? 'model-loading'
      : 'model-downloading';
    this.updateStatus(state, state === 'model-loading' ? 'Preparing model context.' : 'Downloading model.');
    this.showLoadingCopy(state);
    this.updateProgressBar();
  }

  showLoadingCopy(state) {
    const index = this.getLoadingMessageIndex(state);
    const message = LOADING_MESSAGES[index]?.text || LOADING_COPY[state] || 'Working locally.';
    this.loadingMessageIndex = index;
    this.showCenterCopy(message);
  }

  getLoadingMessageIndex(state) {
    let index = 0;
    for (let i = 0; i < LOADING_MESSAGES.length; i += 1) {
      if (this.progress >= LOADING_MESSAGES[i].threshold) index = i;
    }
    return Math.max(index, this.loadingMessageIndex);
  }

  showCenterCopy(text) {
    this.center.classList.remove('local-llm-center--hidden');
    this.loadCopy.textContent = text;
    this.loadCopy.classList.add('local-llm-load-copy--visible');
    this.modelNote.textContent = `${LOCAL_LLM_CONFIG.model.displayName} — runs entirely in this browser.`;
  }

  hideCenterPanel() {
    this.center.classList.add('local-llm-center--hidden');
    this.progressWrap.hidden = true;
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
    this.resetButton.disabled = this.isLoading(status);
    this.progressWrap.hidden = !(this.isLoading(status) || status === 'unsupported');
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
    return status === WORKER_STATE.RUNTIME_LOADING || status === WORKER_STATE.MODEL_DOWNLOADING || status === WORKER_STATE.MODEL_LOADING;
  }

  updateLoadControl() {
    const isLoading = this.isLoading();
    const group = LOAD_CONTROL_GROUP[this.status] || 'idle';
    const appearance = LOAD_CONTROL_STATE[group];

    this.startButton.disabled = appearance.disabled;
    this.startButton.classList.remove('local-llm-load-control--loading', 'local-llm-load-control--ready', 'local-llm-load-control--error');
    if (appearance.cls) this.startButton.classList.add(appearance.cls);

    this.startSymbol.textContent = appearance.symbol;
    this.startText.textContent = isLoading
      ? `${Math.max(0, Math.min(100, this.progress))}%`
      : (appearance.text || '');
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
    this.readyPrompt.classList.remove('local-llm-ready-prompt--enter');
    this.readyPrompt.classList.add('local-llm-ready-prompt--exit');

    // Respect prefers-reduced-motion: update text immediately without animation.
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const delay = reduceMotion ? 0 : 280;

    setTimeout(() => {
      this.readyPrompt.textContent = text;
      this.readyPrompt.classList.remove('local-llm-ready-prompt--exit');
      if (reduceMotion) {
        this.readyPrompt.classList.remove('local-llm-ready-prompt--enter');
      } else {
        this.readyPrompt.classList.add('local-llm-ready-prompt--enter');
      }
    }, delay);
  }

  updatePromptVisibility() {
    this.readyPrompt.hidden = this.input.value.length > 0 || this.status !== 'ready';
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
      if (this.typingIndicator) {
        this.typingIndicator.hidden = false;
      }
    }, 500);
  }

  hideTypingIndicator() {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    if (this.typingIndicator) {
      this.typingIndicator.hidden = true;
    }
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
    this.appendAssistantToken('');
    this.updateStatus('generating', 'Generating locally.');
    this.showTypingAfterDelay();
    this.worker.postMessage({ type: 'generate', messages: this.messages.filter((message) => message.role !== 'notice') });
  }

  appendAssistantToken(token) {
    if (!this.assistantDraft) {
      this.assistantDraft = { role: 'assistant', content: '' };
      this.messages.push(this.assistantDraft);
      this.appendAssistantElement();
    }

    this.assistantDraft.content += token;
    this.updateAssistantElement();
  }

  finishAssistantMessage(finalText) {
    if (this.assistantDraft) {
      // Only replace with finalText if it's non-empty AND longer than streamed content
      if (finalText && finalText.trim().length > this.assistantDraft.content.trim().length) {
        this.assistantDraft.content = finalText;
      }
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
      // Update hidden live region so screen readers announce only the final message
      const liveRegion = this.root.querySelector('#localLlmLiveRegion');
      if (liveRegion && this.messages.length) {
        const last = this.messages.filter((m) => m.role === 'assistant').pop();
        liveRegion.textContent = last ? last.content : '';
      }
    }

    if (this.status !== 'unsupported' && this.status !== 'error') {
      this.hideTypingIndicator();
      this.updateStatus('ready', 'Ready.');
      this.hideCenterPanel();
      this.startPromptCycle();
    }
  }

  finishCancelledGeneration() {
    this.hideTypingIndicator();
    if (this.assistantDraft) {
      this.assistantDraft.content = cleanupModelText(this.assistantDraft.content) || 'Generation stopped.';
      this.assistantDraft = null;
      this.renderMessages();
    }
    this.updateStatus('ready', 'Generation stopped.');
    this.hideCenterPanel();
    this.startPromptCycle();
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
      // Streaming draft needs cleanup here; completed messages were already
      // cleaned in finishAssistantMessage / finishCancelledGeneration.
      const content = renderMarkdown(message === this.assistantDraft
        ? cleanupModelText(message.content)
        : message.content);

      const article = document.createElement('article');
      article.className = `local-llm-message local-llm-message--${message.role}`;
      article.setAttribute('aria-label', role);
      article.innerHTML = `
        <div class="local-llm-message-role">${role}</div>
        <div class="local-llm-message-content">${content}</div>
      `;

      if (message.role === 'assistant') {
        this._lastAssistantElement = article;
      }

      fragment.appendChild(article);
    }

    this.messageList.innerHTML = '';
    this.messageList.appendChild(fragment);

    this.scrollMessagesIfNeeded();
  }

  appendAssistantElement() {
    // Create a new assistant element for the draft without rebuilding the entire list
    const article = document.createElement('article');
    article.className = 'local-llm-message local-llm-message--assistant';
    article.setAttribute('aria-label', 'Local Assistant');
    article.innerHTML = `
      <div class="local-llm-message-role">Local Assistant</div>
      <div class="local-llm-message-content"></div>
    `;
    this.messageList.appendChild(article);
    this._lastAssistantElement = article;
  }

  updateAssistantElement() {
    if (!this._lastAssistantElement || !this.assistantDraft) return;
    const contentDiv = this._lastAssistantElement.querySelector('.local-llm-message-content');
    if (contentDiv) {
      contentDiv.innerHTML = renderMarkdown(this.assistantDraft.content);
    }
    this.scrollMessagesIfNeeded();
  }

  scrollMessagesIfNeeded() {
    // Only auto-scroll if the user is near the bottom; don't interrupt manual reading
    const threshold = 60;
    const diff = this.messageList.scrollHeight - this.messageList.clientHeight - this.messageList.scrollTop;
    if (diff <= threshold) {
      this.messageList.scrollTop = this.messageList.scrollHeight;
    }
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
    this.loadingMessageIndex = -1;
    this.hideDiagnostics();
    this.stopPromptCycle();

    if (this.worker) {
      // Terminate the worker immediately. Previously we posted a 'dispose' message
      // before terminating, but terminate() kills the worker synchronously before
      // the message is processed, so cache deletion in the worker was skipped.
      this.worker.terminate();
      this.worker = null;
    }

    if (clearCache) {
      const cacheCleared = await deleteLocalModelCaches();
      if (!cacheCleared) {
        this.addSystemNotice('Cache deletion failed. The model may reload from cache. Try a hard refresh if issues persist.');
      }
    }
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
    }), 220);
    this.queue(() => this.emit({ type: 'status', state: 'model-loading', message: 'Preparing the GGUF runtime context.' }), 850);
    this.queue(() => this.emit({
      type: 'ready',
      state: 'ready',
      status: 'ready',
      backend: 'mock-wasm',
      model: LOCAL_LLM_CONFIG.model.displayName,
      runtime: 'Mock Wllama'
    }), 1250);
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

    // Detect unordered/ordered lists
    if (/^\s*[-*]\s|^\s*\d+\.\s/.test(block)) {
      const items = block
        .split(/\n/)
        .map((line) => `<li>${line.replace(/^\s*[-*]\s*/, '').replace(/^\s*\d+\.\s*/, '')}</li>`)
        .join('');
      return `<ul>${items}</ul>`;
    }

    const inline = block
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
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
