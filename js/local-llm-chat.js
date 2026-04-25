const MODEL_ID = 'onnx-community/Qwen3-0.6B-ONNX';
const MAX_INPUT_CHARS = 1800;
const LOADING_STEPS = [
  { threshold: 0, html: 'Runs locally in your browser' },
  { threshold: 25, html: "Right now, we're downloading a modal, and caching it in your browser" },
  { threshold: 50, html: "Don't worry, I'll delete it when you're done ;)" },
  { threshold: 75, html: 'This is a <em>teensy</em> model, so expect imperfection' },
  { threshold: 100, html: 'Say Hello', ready: true }
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
    this.assistantDraft = null;

    this.mount();
    this.bindEvents();
    this.renderMessages();
    this.updateStatus('idle', 'Idle.');
    this.showCenterIdle();
  }

  mount() {
    this.root.innerHTML = `
      <div class="local-llm-window">
        <header class="local-llm-window-header">
          <div>
            <span class="canvas-eyebrow">Local assistant</span>
            <h3>In-browser chat</h3>
          </div>
          <div class="local-llm-header-actions">
            <span class="utility-status-chip utility-status-chip--idle" id="localLlmStatusChip">Idle</span>
            <button type="button" class="btn-secondary-utility local-llm-reset" id="localLlmResetBtn" data-cursor="hover">Reset</button>
          </div>
        </header>

        <div class="local-llm-transcript" id="localLlmTranscript" aria-live="polite">
          <div class="local-llm-center" id="localLlmCenter">
            <div class="local-llm-center-glow" aria-hidden="true"></div>
            <p class="local-llm-load-copy" id="localLlmLoadCopy">Runs locally in your browser</p>
            <button type="button" class="btn-primary-utility local-llm-start" id="localLlmStartBtn" data-cursor="hover">Start local chat</button>
            <div class="utility-progress-bar local-llm-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="localLlmProgressBar">
              <span class="utility-progress-fill local-llm-progress-fill"></span>
            </div>
            <p class="utility-progress-text local-llm-status-text" id="localLlmStatusText" aria-live="polite">Idle.</p>
            <p class="local-llm-privacy-note">Runs on your machine. No inference server.</p>
          </div>
          <div class="local-llm-thread" id="localLlmMessages"></div>
        </div>

        <form class="local-llm-form" id="localLlmForm">
          <label class="local-llm-label" for="localLlmInput">Message the local AI</label>
          <textarea id="localLlmInput" class="local-llm-input" rows="3" maxlength="${MAX_INPUT_CHARS}" placeholder="Start the local model first." disabled></textarea>
          <div class="local-llm-actions">
            <span class="local-llm-input-hint">Enter sends. Shift+Enter adds a line.</span>
            <button class="btn-primary-utility local-llm-send" type="submit" disabled data-cursor="hover">Send</button>
          </div>
        </form>
      </div>
    `;

    this.startButton = this.root.querySelector('#localLlmStartBtn');
    this.resetButton = this.root.querySelector('#localLlmResetBtn');
    this.statusChip = this.root.querySelector('#localLlmStatusChip');
    this.statusText = this.root.querySelector('#localLlmStatusText');
    this.progressBar = this.root.querySelector('#localLlmProgressBar');
    this.progressFill = this.root.querySelector('.local-llm-progress-fill');
    this.loadCopy = this.root.querySelector('#localLlmLoadCopy');
    this.center = this.root.querySelector('#localLlmCenter');
    this.transcript = this.root.querySelector('#localLlmTranscript');
    this.messageList = this.root.querySelector('#localLlmMessages');
    this.form = this.root.querySelector('#localLlmForm');
    this.input = this.root.querySelector('#localLlmInput');
    this.sendButton = this.root.querySelector('.local-llm-send');
  }

  bindEvents() {
    this.startButton.addEventListener('click', () => this.startChat());
    this.resetButton.addEventListener('click', () => this.resetChat());
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.sendMessage();
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
    window.addEventListener('beforeunload', () => this.worker?.terminate());
  }

  startChat() {
    if (this.loadStarted) return;

    this.loadStarted = true;
    this.startButton.disabled = true;
    this.center.classList.remove('local-llm-center--hidden');
    this.center.classList.add('local-llm-center--loading');
    this.updateStatus('loading', 'Loading local model.');
    this.showLoadingStep(0, true);
    this.worker = new Worker(new URL('./local-llm-worker.js', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event) => this.handleWorkerMessage(event.data || {}));
    this.worker.addEventListener('error', () => {
      this.updateStatus('unsupported', 'This browser could not start the local model worker.');
    });
    this.worker.postMessage({ type: 'load' });
  }

  handleWorkerMessage(message) {
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
      this.updateProgressBar();
      this.updateStatus('ready', `Ready on ${message.backend === 'webgpu' ? 'WebGPU' : 'WASM/CPU'}.`);
      this.targetLoadingStep = 4;
      this.queueNextLoadingStep();
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
      this.updateStatus(message.status || 'error', message.message);
      this.finishAssistantMessage('');
      return;
    }

    if (message.type === 'disposed') {
      this.updateStatus('idle', 'Chat reset. Start again to reload locally.');
    }
  }

  updateStatusFromWorker(message) {
    if (message.status === 'loading-webgpu') {
      this.updateStatus('loading', 'Loading local model with WebGPU.');
    } else if (message.status === 'loading-wasm') {
      this.updateStatus('loading', message.message || 'Loading local model with WASM/CPU.');
    } else if (message.status === 'generating') {
      this.updateStatus('generating', 'Generating locally.');
    }
  }

  updateProgress(message) {
    if (message.status === 'downloading') {
      this.updateStatus('downloading', 'Downloading model.');
    } else if (this.status !== 'ready') {
      this.updateStatus('loading', 'Loading model.');
    }

    if (Number.isFinite(message.progress)) {
      this.progress = Math.max(this.progress, Math.min(96, Math.round(message.progress)));
    } else if (this.progress < 18) {
      this.progress = 18;
    }

    this.updateProgressBar();
    this.syncLoadingCopyToProgress();
  }

  syncLoadingCopyToProgress() {
    let index = 0;

    for (let i = 0; i < LOADING_STEPS.length; i += 1) {
      if (this.progress >= LOADING_STEPS[i].threshold) index = i;
    }

    this.targetLoadingStep = Math.max(this.targetLoadingStep, index);
    this.queueNextLoadingStep();
  }

  showLoadingStep(nextIndex, immediate = false) {
    if (nextIndex === this.loadingStep && !immediate) return;

    const elapsed = performance.now() - this.loadingStepStartedAt;
    const minDuration = 1900;
    window.clearTimeout(this.loadingStepTimer);

    if (!immediate && elapsed < minDuration) {
      this.loadingStepTimer = window.setTimeout(() => this.showLoadingStep(nextIndex), minDuration - elapsed);
      return;
    }

    this.loadingStep = nextIndex;
    this.loadingStepStartedAt = performance.now();
    this.loadCopy.classList.remove('local-llm-load-copy--visible', 'local-llm-load-copy--hello');

    window.setTimeout(() => {
      this.loadCopy.innerHTML = LOADING_STEPS[nextIndex].html;
      this.loadCopy.classList.toggle('local-llm-load-copy--hello', LOADING_STEPS[nextIndex].ready === true);
      window.requestAnimationFrame(() => {
        this.loadCopy.classList.add('local-llm-load-copy--visible');
      });

      if (LOADING_STEPS[nextIndex].ready && this.status === 'ready') {
        window.clearTimeout(this.centerHideTimer);
        this.centerHideTimer = window.setTimeout(() => {
          this.center.classList.add('local-llm-center--hidden');
          this.center.classList.remove('local-llm-center--loading');
        }, 2700);
      } else {
        this.queueNextLoadingStep();
      }
    }, 180);
  }

  queueNextLoadingStep() {
    if (this.loadingStep < 0 || this.targetLoadingStep <= this.loadingStep) return;

    const elapsed = performance.now() - this.loadingStepStartedAt;
    const delay = Math.max(1900 - elapsed, 0);
    const nextStep = Math.min(this.loadingStep + 1, this.targetLoadingStep);

    window.clearTimeout(this.loadingStepTimer);
    this.loadingStepTimer = window.setTimeout(() => {
      this.showLoadingStep(nextStep);
    }, delay);
  }

  showCenterIdle() {
    window.clearTimeout(this.centerHideTimer);
    this.center.classList.remove('local-llm-center--hidden', 'local-llm-center--loading');
    this.startButton.hidden = false;
    this.progressBar.hidden = true;
    this.statusText.hidden = false;
    this.loadCopy.classList.add('local-llm-load-copy--visible');
  }

  updateProgressBar() {
    const value = Math.max(0, Math.min(100, this.progress));
    this.progressBar.setAttribute('aria-valuenow', String(value));
    this.progressFill.style.width = `${value}%`;
  }

  updateStatus(status, label = '') {
    this.status = status;
    this.root.dataset.localLlmStatus = status;

    const readable = label || status.replace(/-/g, ' ');
    const chipState = status === 'unsupported' ? 'error' : status;
    this.statusText.textContent = readable;
    this.statusChip.textContent = status;
    this.statusChip.className = `utility-status-chip utility-status-chip--${status === 'downloading' || status === 'loading' || status === 'generating' ? 'processing' : chipState}`;

    const isStarting = status === 'loading' || status === 'downloading';
    const canSend = status === 'ready';
    this.sendButton.disabled = !canSend;
    this.input.disabled = !canSend;
    this.startButton.hidden = status !== 'idle';
    this.startButton.disabled = this.loadStarted;
    this.progressBar.hidden = !isStarting && status !== 'ready';
    this.resetButton.textContent = status === 'generating' ? 'Stop / Reset' : 'Reset';

    if (status === 'ready') {
      this.input.placeholder = 'Say hello to the tiny local model...';
    } else if (status === 'unsupported') {
      this.input.placeholder = 'This browser cannot run the local model.';
      this.center.classList.remove('local-llm-center--hidden');
      this.startButton.hidden = true;
      this.progressBar.hidden = false;
    } else if (status === 'idle') {
      this.input.placeholder = 'Start the local model first.';
      this.startButton.disabled = false;
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
    }
  }

  trimHistory(messages) {
    const notices = messages.filter((message) => message.role === 'notice').slice(-2);
    const chat = messages.filter((message) => message.role !== 'notice').slice(-12);
    return [...notices, ...chat];
  }

  renderMessages() {
    this.messageList.innerHTML = this.messages.map((message) => {
      const role = message.role === 'user' ? 'You' : message.role === 'notice' ? 'Note' : 'Local AI';
      const content = message.role === 'assistant'
        ? renderMarkdown(cleanupModelText(message.content))
        : escapeHtml(message.content).replace(/\n/g, '<br>');

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

  async resetChat() {
    this.messages = [];
    this.assistantDraft = null;
    this.renderMessages();
    this.progress = 0;
    this.loadingStep = -1;
    this.targetLoadingStep = 0;
    this.loadStarted = false;
    this.showLoadingStep(0, true);
    this.updateProgressBar();

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    await deleteTransformersCache();
    this.updateStatus('idle', 'Chat reset. Start again to reload locally.');
    this.showCenterIdle();
  }
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

async function deleteTransformersCache() {
  if (!window.caches?.delete) return false;

  try {
    return await window.caches.delete('transformers-cache');
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
