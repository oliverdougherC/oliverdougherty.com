const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
const MAX_INPUT_CHARS = 1800;
const MIN_LOADING_STEP_MS = 1900;
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const LOADING_STEPS = [
  { threshold: 0, html: 'Runs locally in your browser' },
  { threshold: 25, html: "Right now, we're downloading a modal, and caching it in your browser" },
  { threshold: 50, html: "Don't worry, I'll delete it when you're done ;)" },
  { threshold: 75, html: 'This is a <em>teensy</em> model, so expect imperfection' },
  { threshold: 100, html: 'Say Hello', ready: true }
];

const CACHED_LOADING_STEPS = [
  { threshold: 0, html: 'Runs locally in your browser' },
  { threshold: 50, html: 'Warming the cached local model' },
  { threshold: 100, html: 'Say Hello', ready: true }
];

// Add your own post-load rotating composer prompts here.
const READY_PROMPTS = [
  'Ask a concise question...',
  'Draft a tiny explanation...',
  'Summarize a thought...',
  'Try a local-only brainstorm...'
];

class LocalLlmUtility {
  constructor(root) {
    this.root = root;
    this.worker = null;
    this.messages = [];
    this.status = 'idle';
    this.loadStarted = false;
    this.progress = 0;
    this.loadingStep = -1;
    this.targetLoadingStep = 0;
    this.loadingStepStartedAt = 0;
    this.loadingStepTimer = null;
    this.centerHideTimer = null;
    this.loadFailureTimer = null;
    this.spinnerTimer = null;
    this.promptTimer = null;
    this.promptIndex = 0;
    this.spinnerIndex = 0;
    this.assistantDraft = null;
    this.downloadProgressSeen = false;
    this.loadStartTime = 0;
    this.cachedLoadMode = false;
    this.diagnostics = null;

    this.mount();
    this.bindEvents();
    this.renderMessages();
    this.updateStatus('idle', 'Idle.');
    this.showCenterIdle();
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
          <div class="local-llm-center" id="localLlmCenter">
            <p class="local-llm-load-copy local-llm-load-copy--visible" id="localLlmLoadCopy">Runs locally in your browser</p>
            <div class="local-llm-progress-wrap" id="localLlmProgressWrap" hidden>
              <div class="utility-progress-bar local-llm-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="localLlmProgressBar">
                <span class="utility-progress-fill local-llm-progress-fill"></span>
              </div>
              <span class="local-llm-progress-percent" id="localLlmProgressPercent">0%</span>
            </div>
            <div class="local-llm-diagnostics" id="localLlmDiagnostics" hidden></div>
          </div>
          <div class="local-llm-thread" id="localLlmMessages"></div>
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
      this.worker?.postMessage({ type: 'dispose', clearCache: true });
      deleteTransformersCaches();
      this.worker?.terminate();
    });
  }

  startChat() {
    if (this.loadStarted && this.status !== 'unsupported' && this.status !== 'error') return;

    this.loadStarted = true;
    this.progress = 0;
    this.downloadProgressSeen = false;
    this.cachedLoadMode = false;
    this.loadStartTime = performance.now();
    this.diagnostics = null;
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.center.classList.remove('local-llm-center--hidden');
    this.center.classList.add('local-llm-center--loading');
    this.updateStatus('loading', 'Loading local model.');
    this.showLoadingStep(0, true);
    this.startSpinner();

    try {
      this.worker = new Worker(new URL('./local-llm-worker.js', import.meta.url), { type: 'module' });
      this.worker.addEventListener('message', (event) => this.handleWorkerMessage(event.data || {}));
      this.worker.addEventListener('error', () => {
        this.showLoadFailure({
          message: 'The browser blocked the local model worker before it could start.',
          detail: 'Module workers need a normal local server, HTTPS, or localhost. Some file-like preview servers block worker module imports.',
          likelyFix: 'Serve this page from localhost or HTTPS, then retry.'
        });
      });
      this.worker.postMessage({ type: 'load' });
    } catch {
      this.showLoadFailure({
        message: 'This browser could not create the local model worker.',
        detail: 'The page stayed responsive, but the worker API was unavailable.',
        likelyFix: 'Try a current desktop browser served from localhost or HTTPS.'
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

    if (message.type === 'status') {
      this.updateStatusFromWorker(message);
      return;
    }

    if (message.type === 'ready') {
      this.progress = 100;
      this.cachedLoadMode = !this.downloadProgressSeen && performance.now() - this.loadStartTime < 4500;
      this.updateProgressBar();
      this.updateStatus('ready', `Ready on ${message.backend === 'webgpu' ? 'WebGPU' : 'WASM/CPU'}.`);
      this.targetLoadingStep = this.getActiveLoadingSteps().length - 1;
      this.queueNextLoadingStep();
      this.startPromptCycle();
      this.input.focus({ preventScroll: true });
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
    if (message.status === 'runtime-import') {
      this.updateStatus('loading', `Loading ${message.runtime || 'Transformers.js'}.`);
    } else if (message.status === 'loading-webgpu') {
      this.updateStatus('loading', 'Loading local model with WebGPU.');
    } else if (message.status === 'loading-wasm') {
      this.updateStatus('loading', message.message || 'Loading local model with WASM/CPU.');
    } else if (message.status === 'backend-fallback') {
      this.updateStatus('loading', message.message || 'Trying another local runtime path.');
    } else if (message.status === 'generating') {
      this.updateStatus('generating', 'Generating locally.');
    }
  }

  updateProgress(message) {
    if (message.status === 'downloading') {
      this.downloadProgressSeen = true;
      this.updateStatus('downloading', 'Downloading model.');
    } else if (this.status !== 'ready') {
      this.updateStatus('loading', 'Loading model.');
    }

    if (Number.isFinite(message.progress)) {
      const capped = message.status === 'downloading' ? 96 : 99;
      this.progress = Math.max(this.progress, Math.min(capped, Math.round(message.progress)));
    } else if (this.progress < 16) {
      this.progress = 16;
    }

    this.updateProgressBar();
    this.syncLoadingCopyToProgress();
  }

  getActiveLoadingSteps() {
    return this.cachedLoadMode ? CACHED_LOADING_STEPS : LOADING_STEPS;
  }

  syncLoadingCopyToProgress() {
    const steps = this.getActiveLoadingSteps();
    let index = 0;

    for (let i = 0; i < steps.length; i += 1) {
      if (this.progress >= steps[i].threshold) index = i;
    }

    this.targetLoadingStep = Math.max(this.targetLoadingStep, index);
    this.queueNextLoadingStep();
  }

  showLoadingStep(nextIndex, immediate = false) {
    const steps = this.getActiveLoadingSteps();
    if (nextIndex === this.loadingStep && !immediate) return;

    const elapsed = performance.now() - this.loadingStepStartedAt;
    window.clearTimeout(this.loadingStepTimer);

    if (!immediate && elapsed < MIN_LOADING_STEP_MS) {
      this.loadingStepTimer = window.setTimeout(() => this.showLoadingStep(nextIndex), MIN_LOADING_STEP_MS - elapsed);
      return;
    }

    this.loadingStep = nextIndex;
    this.loadingStepStartedAt = performance.now();
    this.loadCopy.classList.remove('local-llm-load-copy--visible', 'local-llm-load-copy--hello');

    window.setTimeout(() => {
      const step = steps[Math.min(nextIndex, steps.length - 1)];
      this.loadCopy.innerHTML = step.html;
      this.loadCopy.classList.toggle('local-llm-load-copy--hello', step.ready === true);
      window.requestAnimationFrame(() => {
        this.loadCopy.classList.add('local-llm-load-copy--visible');
      });

      if (step.ready && this.status === 'ready') {
        window.clearTimeout(this.centerHideTimer);
        this.centerHideTimer = window.setTimeout(() => {
          this.center.classList.add('local-llm-center--hidden');
          this.center.classList.remove('local-llm-center--loading');
        }, 2600);
      } else {
        this.queueNextLoadingStep();
      }
    }, 180);
  }

  queueNextLoadingStep() {
    if (this.loadingStep < 0 || this.targetLoadingStep <= this.loadingStep) return;

    const elapsed = performance.now() - this.loadingStepStartedAt;
    const delay = Math.max(MIN_LOADING_STEP_MS - elapsed, 0);
    const nextStep = Math.min(this.loadingStep + 1, this.targetLoadingStep);

    window.clearTimeout(this.loadingStepTimer);
    this.loadingStepTimer = window.setTimeout(() => {
      this.showLoadingStep(nextStep);
    }, delay);
  }

  showCenterIdle() {
    window.clearTimeout(this.centerHideTimer);
    this.hideDiagnostics();
    this.center.classList.remove('local-llm-center--hidden', 'local-llm-center--loading');
    this.progressWrap.hidden = true;
    this.loadCopy.innerHTML = LOADING_STEPS[0].html;
    this.loadCopy.classList.remove('local-llm-load-copy--hello');
    this.loadCopy.classList.add('local-llm-load-copy--visible');
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

    const chipState = status === 'unsupported' ? 'error' : status;
    this.statusChip.textContent = formatStatus(status);
    this.statusChip.className = `local-llm-card utility-status-chip utility-status-chip--${status === 'downloading' || status === 'loading' || status === 'generating' ? 'processing' : chipState}`;

    const isStarting = status === 'loading' || status === 'downloading';
    const canSend = status === 'ready';
    this.sendButton.disabled = !canSend;
    this.input.disabled = !canSend;
    this.progressWrap.hidden = !isStarting && status !== 'ready' && status !== 'unsupported' && status !== 'error';
    this.resetButton.textContent = status === 'generating' ? 'Stop / reset' : 'Reset model';

    if (status === 'ready') {
      this.setReadyPrompt(READY_PROMPTS[this.promptIndex] || 'Say hello...');
    } else if (status === 'unsupported' || status === 'error') {
      this.stopSpinner();
      this.stopPromptCycle();
      this.input.placeholder = 'The local model is not available here.';
      this.readyPrompt.textContent = 'The local model is not available here.';
      this.center.classList.remove('local-llm-center--hidden');
      this.progressWrap.hidden = false;
    } else if (status === 'idle') {
      this.stopSpinner();
      this.stopPromptCycle();
      this.input.placeholder = 'Load the model first.';
      this.readyPrompt.textContent = 'Load the model first.';
    }

    this.updatePromptVisibility();
    this.updateLoadControl();
  }

  updateLoadControl() {
    const isLoading = this.status === 'loading' || this.status === 'downloading';
    const isReady = this.status === 'ready' || this.status === 'generating';
    const isFailure = this.status === 'unsupported' || this.status === 'error';

    this.startButton.disabled = isLoading || isReady;
    this.startButton.classList.toggle('local-llm-load-control--loading', isLoading);
    this.startButton.classList.toggle('local-llm-load-control--ready', isReady);
    this.startButton.classList.toggle('local-llm-load-control--error', isFailure);

    if (isLoading) {
      this.startText.textContent = `${Math.max(0, Math.min(100, this.progress))}%`;
    } else if (isReady) {
      this.startSymbol.textContent = '✓';
      this.startText.textContent = 'Ready';
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

  startSpinner() {
    this.stopSpinner();
    this.spinnerTimer = window.setInterval(() => {
      this.spinnerIndex = (this.spinnerIndex + 1) % BRAILLE_FRAMES.length;
      this.startSymbol.textContent = BRAILLE_FRAMES[this.spinnerIndex];
    }, 95);
  }

  stopSpinner() {
    window.clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
  }

  startPromptCycle() {
    this.stopSpinner();
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

    window.setTimeout(() => {
      this.readyPrompt.textContent = text;
      this.readyPrompt.classList.remove('local-llm-ready-prompt--exit');
      this.readyPrompt.classList.add('local-llm-ready-prompt--enter');
    }, 220);
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
      if (!this.assistantDraft.content.trim()) {
        this.assistantDraft.content = 'I could not produce a useful answer. Try a shorter prompt.';
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

    this.transcript.scrollTop = this.transcript.scrollHeight;
  }

  addSystemNotice(content) {
    this.messages.push({ role: 'notice', content });
    this.renderMessages();
  }

  showLoadFailure(message) {
    const elapsed = performance.now() - this.loadStartTime;
    if ((message.status || 'unsupported') === 'unsupported' && elapsed < MIN_LOADING_STEP_MS) {
      window.clearTimeout(this.loadFailureTimer);
      this.loadFailureTimer = window.setTimeout(() => this.showLoadFailure(message), MIN_LOADING_STEP_MS - elapsed);
      return;
    }

    const fallback = buildFailureCopy(message, this.diagnostics);
    this.updateStatus(message.status || 'unsupported', fallback.message);
    this.loadCopy.textContent = 'Local model unavailable';
    this.loadCopy.classList.remove('local-llm-load-copy--hello');
    this.loadCopy.classList.add('local-llm-load-copy--visible');
    this.updateProgressBar();
    this.showDiagnostics(fallback);
    this.loadStarted = false;
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
    this.messages = [];
    this.assistantDraft = null;
    this.renderMessages();
    this.progress = 0;
    this.loadingStep = -1;
    this.targetLoadingStep = 0;
    this.loadStarted = false;
    this.cachedLoadMode = false;
    this.downloadProgressSeen = false;
    this.showLoadingStep(0, true);
    this.updateProgressBar();
    window.clearTimeout(this.loadFailureTimer);
    this.hideDiagnostics();

    if (this.worker) {
      this.worker.postMessage({ type: 'dispose', clearCache });
      this.worker.terminate();
      this.worker = null;
    }

    if (clearCache) await deleteTransformersCaches();
    this.updateStatus('idle', clearCache ? 'Model cache reset. Start again to reload locally.' : 'Ready to retry local loading.');
    this.showCenterIdle();
  }
}

function buildFailureCopy(message, diagnostics) {
  const rawDetail = message.detail || message.message || 'The browser could not initialize the local model.';
  let likelyFix = message.likelyFix || 'Try a current desktop browser with enough memory, served from localhost or HTTPS.';
  let detail = rawDetail;

  if (diagnostics?.secureContext === false) {
    detail = 'This page is not running in a secure browser context, so WebGPU and some worker features may be blocked.';
    likelyFix = 'Serve it from http://localhost, 127.0.0.1, or HTTPS, then retry.';
  } else if (diagnostics?.workerGpu === false && message.category === 'wasm-failed') {
    detail = 'WebGPU is not available here, and the WASM/CPU fallback could not initialize this model.';
    likelyFix = 'Try Chrome, Edge, or Safari, or use Firefox after enabling a compatible WebGPU/WASM setup.';
  } else if (message.category === 'runtime-import') {
    detail = 'The worker started, but the Transformers.js runtime could not be imported from the pinned CDN.';
    likelyFix = 'Check the local server, network access, and content blockers, then retry.';
  }

  return {
    title: 'Local model could not start',
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

async function deleteTransformersCaches() {
  if (!window.caches?.keys || !window.caches?.delete) return false;

  try {
    const cacheNames = await window.caches.keys();
    const targets = cacheNames.filter((name) => /transformers|huggingface/i.test(name));
    await Promise.all(targets.map((name) => window.caches.delete(name)));
    await window.caches.delete('transformers-cache');
    return true;
  } catch {
    return false;
  }
}

function initLocalLlmUtility() {
  const root = document.getElementById('localLlmUtilityApp');
  if (!root) return;
  new LocalLlmUtility(root);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initLocalLlmUtility, { once: true });
} else {
  initLocalLlmUtility();
}
