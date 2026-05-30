import { LOCAL_LLM_CONFIG, WORKER_STATE } from './local-llm-config.js';
import { deleteLocalModelCaches as deleteBrowserModelCaches } from './local-llm-cache.js';
import {
  cleanupLocalLlmText as cleanupModelText,
  escapeHtml,
  renderLocalLlmSafeText as renderSafeText
} from './local-llm-rendering.js';
import { LocalLlmMockWorker } from './local-llm-mock-worker.js';

const MAX_INPUT_CHARS = LOCAL_LLM_CONFIG.limits.maxInputChars;
const STATIC_READY_PLACEHOLDER = 'Oh, what to say...';
const READY_SUGGESTIONS = [
  'Perhaps a joke?',
  'Maybe a riddle?',
  'Summarize a topic perchance?',
  'How about a short story?',
  'Maybe something else entirely?'
];
const LAST_READY_SUGGESTION = 'Maybe something else entirely?';
const STATE_COPY = {
  idle: 'Press "Load" to begin',
  checking: 'Checking WebGPU support.',
  loading: `Downloading ${LOCAL_LLM_CONFIG.model.displayName}.`,
  optimizing: 'Optimizing the model for WebGPU execution.',
  ready: 'Ready.',
  thinking: 'Thinking locally.',
  streaming: 'Streaming locally.',
  error: 'Local model unavailable.',
  unsupported: 'This browser cannot run the local WebGPU model.'
};

const LOAD_CONTROL = {
  idle: { text: 'Load', disabled: false, cls: '' },
  checking: { text: '', disabled: true, cls: 'local-llm-load-control--loading' },
  loading: { text: '', disabled: true, cls: 'local-llm-load-control--loading' },
  optimizing: { text: '', disabled: true, cls: 'local-llm-load-control--loading' },
  ready: { text: 'Loaded', disabled: true, cls: 'local-llm-load-control--ready' },
  thinking: { text: 'Busy', disabled: true, cls: 'local-llm-load-control--ready' },
  streaming: { text: 'Busy', disabled: true, cls: 'local-llm-load-control--ready' },
  error: { text: 'Retry', disabled: false, cls: 'local-llm-load-control--error' },
  unsupported: { text: 'Retry', disabled: false, cls: 'local-llm-load-control--error' }
};

const LOAD_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const LOAD_SPINNER_STEP_MS = 90;
const LOAD_SEQUENCE_STEP_MS = 2000;
const LOAD_SEQUENCE_VISIBLE_FLOOR_MS = 1000;
const LOAD_SEQUENCE_FINAL_HOLD_MS = 1800;
const GENERATION_IDLE_TIMEOUT_MS = 30_000;
const STREAM_RENDER_INTERVAL_MS = 90;
const LOAD_SEQUENCE_COPY = [
  'Loading Bonsai 1.7B',
  'Caching model files locally for faster reloads.'
];
const LOAD_PSEUDO_PROGRESS_CAP = 96;
const LOAD_COPY_FADE_MS = 250;
const THINKING_CONTENT_MARKER = '__thinking__';
const STREAMING_CONTENT_MARKER = '__streaming__';
const LOCAL_ASSISTANT_LOAD_SOURCE = 'local-assistant';

function createLocalAssistantPerformanceController(source) {
  if (typeof window.createUtilityPerformanceController === 'function') {
    return window.createUtilityPerformanceController(source);
  }

  let active = false;
  let currentMode = 'settle-background';
  return {
    setActive(nextActive, options = {}) {
      const nextMode = options.mode === 'pause-background' ? 'pause-background' : 'settle-background';
      if (active === Boolean(nextActive) && currentMode === nextMode) return;
      active = Boolean(nextActive);
      currentMode = nextMode;
      window.dispatchEvent(new CustomEvent('utilities-load-state', {
        detail: {
          source,
          active,
          mode: currentMode,
          pauseRendering: currentMode === 'pause-background'
        }
      }));
    },
    cleanup() {
      if (!active) return;
      active = false;
      window.dispatchEvent(new CustomEvent('utilities-load-state', {
        detail: {
          source,
          active: false,
          mode: currentMode,
          pauseRendering: currentMode === 'pause-background'
        }
      }));
    }
  };
}

export class LocalLlmUtility {
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
    this.readySuggestionOrder = buildReadySuggestionOrder();
    this.assistantDraft = null;
    this.diagnostics = null;
    this.typingTimer = null;
    this._showTypingInBubble = false;
    this._lastAssistantElement = null;
    this._workerMessageHandler = null;
    this._workerErrorHandler = null;
    this._pagehideHandler = null;
    this._deactivateHandler = null;
    this._activateHandler = null;
    this._generationTimeoutId = 0;
    this._inputFrameId = 0;
    this._statePanelFrameId = 0;
    this._lastAssistantWasInterrupted = false;
    this._sessionEnded = false;
    this._activeGenerationId = 0;
    this._lastCompletedGenerationId = 0;
    this._lastContextStats = null;
    this._messageElements = new Map();
    this._renderedMessageContent = new Map();
    this._streamRenderTimer = 0;
    this._streamRenderDue = false;
    this._streamShouldStick = false;
    this._loadStateActive = false;
    this._performanceState = createLocalAssistantPerformanceController(LOCAL_ASSISTANT_LOAD_SOURCE);
    this.loadingSequenceTimer = null;
    this.loadingSequenceIndex = 0;
    this.loadingSequenceStartedAt = 0;
    this.loadingProgressFrameId = 0;
    this.pendingReadyMessage = null;
    this.loadSpinnerTimer = null;
    this.loadSpinnerIndex = 0;
    this._currentCopyTarget = '';
    this._copyTimer = null;

    this.mount();
    this.bindEvents();
    this.renderMessages();
    this.updateStatus(WORKER_STATE.IDLE, STATE_COPY.idle);
    this.renderStatePanel({ immediate: true });
    this.prewarmWorker();
  }

  mount() {
    this.root.innerHTML = `
      <div class="utility-layout utility-layout--local-llm">
        <div class="utility-view utility-view--minimal">
          <article class="canvas-panel-minimal canvas-panel--local-llm" style="flex: 1; display: flex; flex-direction: column; min-height: 0; padding: 0; border: none;">
            <header class="local-llm-header">
              <div class="local-llm-title-block">
                <div class="local-llm-title-row">
                  <span class="utility-kicker" style="margin-bottom: 0;">Local Assistant</span>
                  <span class="local-llm-card utility-status-chip utility-status-chip--idle" id="localLlmStatusChip" aria-live="polite" style="margin-left: 0.5rem; padding: 0.22rem 0.55rem; border-radius: var(--radius-full); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: var(--tracking-wide); text-transform: uppercase;">Idle</span>
                </div>
                <div class="local-llm-meta" aria-label="Model runtime details" style="color: var(--color-text-secondary); font-size: 0.78rem;">
                  <span id="localLlmModelName">${escapeHtml(LOCAL_LLM_CONFIG.model.displayName)}</span>
                  <a href="${escapeHtml(LOCAL_LLM_CONFIG.model.sourceUrl)}" target="_blank" rel="noopener noreferrer">Model card</a>
                  <span id="localLlmBackend">WebGPU</span>
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
                <div class="local-llm-load-copy-wrap">
                  <p class="local-llm-load-copy" id="localLlmLoadCopy"></p>
                </div>
                <p class="local-llm-model-note" id="localLlmModelNote"></p>
                <div class="local-llm-progress-wrap" id="localLlmProgressWrap" aria-live="polite" hidden>
                  <div class="utility-progress-bar-minimal" role="progressbar" aria-label="Model loading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="localLlmProgressBar" style="flex: 1;">
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
                <span class="local-llm-ready-prompt" id="localLlmReadyPrompt" aria-hidden="true" hidden></span>
                <span class="local-llm-char-count" id="localLlmCharCount" aria-hidden="true" hidden></span>
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
    this.input.addEventListener('input', () => this.queueInputChromeUpdate());
    this.input.addEventListener('focus', () => {
      window.setTimeout(() => this.input.scrollIntoView({ block: 'end', behavior: 'smooth' }), 80);
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
    this._pagehideHandler = () => this.endModelSession({ clearMessages: true, updateUi: false, unload: true });
    this._activateHandler = () => {
      if (!this.worker && this.status === WORKER_STATE.IDLE) {
        this.prewarmWorker();
      }
    };
    this._deactivateHandler = () => {
      if (this.status === WORKER_STATE.THINKING || this.status === WORKER_STATE.STREAMING) {
        this.interruptGeneration();
      }
      this.endModelSession({ clearMessages: true, updateUi: true });
    };
    window.addEventListener('pagehide', this._pagehideHandler);
    this.root.addEventListener('utility-activate', this._activateHandler);
    this.root.addEventListener('utility-deactivate', this._deactivateHandler);
  }

  prewarmWorker() {
    try {
      this.ensureWorker();
    } catch (error) {
      console.debug('Local assistant worker prewarm failed.', error);
    }
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
    const workerUrl = new URL('./local-llm-worker.js', import.meta.url);
    workerUrl.search = '';
    return new Worker(workerUrl, { type: 'module' });
  }

  startChat() {
    if (this.status === WORKER_STATE.READY) {
      this.updateStatus(WORKER_STATE.READY, 'Ready. Type a message to use the local model.');
      this.input.focus({ preventScroll: true });
      this.renderStatePanel();
      return;
    }

    if (this.isLoading()) return;

    this._sessionEnded = false;
    this.progress = 0;
    this.tps = null;
    this.numTokens = 0;
    this.diagnostics = null;
    this.setLocalAssistantLoadState(true);
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.updateProgressBar();
    this.startLoadingSequence();
    this.updateStatus(WORKER_STATE.CHECKING, 'Checking WebGPU support.');
    this.renderStatePanel();

    try {
      this.ensureWorker().postMessage({ type: 'load' });
    } catch (error) {
      this.showLoadFailure({
        status: WORKER_STATE.UNSUPPORTED,
        category: 'worker-unavailable',
        message: 'This browser could not create the local model worker.',
        detail: error?.message ?? 'The Worker API was unavailable in this page context.',
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
      this.queueReadyMessage(message);
      return;
    }

    if (message.type === 'status') {
      this.captureGenerationState(message);
      this.captureContextStats(message.contextStats);
      if (!this.isCurrentGenerationMessage(message, { adopt: true })) return;
      if (message.state === WORKER_STATE.THINKING || message.state === WORKER_STATE.STREAMING) {
        this.armGenerationTimeout();
      }
      this.updateStatusFromWorker(message);
      return;
    }

    if (message.type === 'start') {
      this.captureGenerationState(message);
      this.captureContextStats(message.contextStats);
      if (!this.isCurrentGenerationMessage(message, { adopt: true })) return;
      this.armGenerationTimeout();
      this.ensureAssistantDraft();
      this.showTypingAfterDelay();
      return;
    }

    if (message.type === 'notice') {
      this.captureGenerationState(message);
      this.captureContextStats(message.contextStats);
      if (!this.isCurrentGenerationMessage(message, { adopt: true })) return;
      if (typeof message.notice === 'string' && message.notice.trim()) {
        this.addSystemNotice(message.notice.trim());
      }
      return;
    }

    if (message.type === 'token') {
      this.captureContextStats(message.contextStats);
      if (!this.isCurrentGenerationMessage(message)) return;
      if (this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING) return;
      this.armGenerationTimeout();
      this.hideTypingIndicator();
      this.tps = Number.isFinite(message.tps) ? message.tps : this.tps;
      this.numTokens = Number.isFinite(message.numTokens) ? message.numTokens : this.numTokens;
      this.updateTelemetry();
      this.appendAssistantToken(message.token || '');
      return;
    }

    if (message.type === 'complete') {
      this.captureContextStats(message.contextStats);
      if (!this.isCurrentGenerationMessage(message)) return;
      if (this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING && this.status !== WORKER_STATE.READY) return;
      this.clearGenerationTimeout();
      this.tps = Number.isFinite(message.tps) ? message.tps : this.tps;
      this.numTokens = Number.isFinite(message.numTokens) ? message.numTokens : this.numTokens;
      this.updateTelemetry();
      this.finishAssistantMessage(message.text || '', message.generationId);
      return;
    }

    if (message.type === 'interrupted') {
      this.captureContextStats(message.contextStats);
      if (!this.isCurrentGenerationMessage(message)) return;
      if (this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING && this.status !== WORKER_STATE.READY) return;
      this.clearGenerationTimeout();
      this.finishInterruptedGeneration(message.generationId);
      return;
    }

    if (message.type === 'reset') {
      this.clearGenerationTimeout();
      this.hideTypingIndicator();
      this.cancelStreamRender();
      this.setLocalAssistantLoadState(false);
      this.assistantDraft = null;
      this.markGenerationComplete();
      this.captureContextStats(null);
      this.updateStatus(this.modelReady ? WORKER_STATE.READY : WORKER_STATE.IDLE, this.modelReady ? 'Chat reset.' : STATE_COPY.idle);
      this.renderStatePanel();
      return;
    }

    if (message.type === 'error') {
      this.captureContextStats(message.contextStats);
      if (!this.isCurrentGenerationMessage(message, { allowWhenIdle: true })) return;
      this.clearGenerationTimeout();
      this.stopLoadingSequence({ clearPending: true });
      if (this.assistantDraft || this.status === WORKER_STATE.THINKING || this.status === WORKER_STATE.STREAMING) {
        this.showGenerationFailure(message);
      } else {
        this.showLoadFailure(message);
        this.finishAssistantMessage('');
      }
      return;
    }

    if (message.type === 'disposed') {
      this.clearGenerationTimeout();
      this.cancelStreamRender();
      this.setLocalAssistantLoadState(false);
      if (this.assistantDraft) {
        this.messages = this.messages.filter((msg) => msg !== this.assistantDraft);
        this.assistantDraft = null;
      }
      this.worker = null;
      this.modelReady = false;
      this.markGenerationComplete();
      this.captureContextStats(null);
      this.updateStatus(WORKER_STATE.IDLE, 'Model cache reset. Start again to reload locally.');
      this.renderStatePanel();
    }
  }

  captureGenerationState(message) {
    const generationId = Number(message?.generationId);
    if (!Number.isFinite(generationId) || generationId <= 0) return;
    if (!this._activeGenerationId && generationId > this._lastCompletedGenerationId) {
      this._activeGenerationId = generationId;
    }
  }

  isCurrentGenerationMessage(message, { adopt = false, allowWhenIdle = false } = {}) {
    const generationId = Number(message?.generationId);
    if (!Number.isFinite(generationId) || generationId <= 0) return true;
    if (!this._activeGenerationId) {
      if (adopt && generationId > this._lastCompletedGenerationId) {
        this._activeGenerationId = generationId;
        return true;
      }
      return allowWhenIdle;
    }
    return generationId === this._activeGenerationId;
  }

  captureContextStats(stats) {
    this._lastContextStats = stats || null;
    const dataset = this.root.dataset;
    if (!stats || typeof stats !== 'object') {
      delete dataset.localLlmPromptTokens;
      delete dataset.localLlmContextLimitTokens;
      delete dataset.localLlmDroppedMessages;
      delete dataset.localLlmTruncatedInput;
      return;
    }
    dataset.localLlmPromptTokens = String(Number.isFinite(stats.promptTokens) ? stats.promptTokens : 0);
    dataset.localLlmContextLimitTokens = String(Number.isFinite(stats.contextLimitTokens) ? stats.contextLimitTokens : 0);
    dataset.localLlmDroppedMessages = String(Number.isFinite(stats.droppedMessageCount) ? stats.droppedMessageCount : 0);
    dataset.localLlmTruncatedInput = stats.truncatedUserInput ? 'true' : 'false';
  }

  updateProgress(message) {
    const state = message.state === WORKER_STATE.OPTIMIZING ? WORKER_STATE.OPTIMIZING : WORKER_STATE.LOADING;
    this.updateStatus(state, state === WORKER_STATE.OPTIMIZING ? STATE_COPY.optimizing : STATE_COPY.loading);
    this.updateProgressBar();
    this.renderStatePanel();
  }

  updateStatusFromWorker(message) {
    const nextState = message.state || message.status || WORKER_STATE.CHECKING;
    const copy = message.message || STATE_COPY[nextState] || 'Working locally.';
    this.updateStatus(nextState, copy);
    this.renderStatePanel();
  }

  startLoadingSequence() {
    this.stopLoadingSequence({ clearPending: true });
    this.loadingSequenceIndex = 0;
    this.loadingSequenceStartedAt = performance.now();
    this.root.dataset.localLlmLoadingStep = String(this.loadingSequenceIndex);
    this.root.dataset.localLlmLoadingFloorMs = String(LOAD_SEQUENCE_VISIBLE_FLOOR_MS);
    this.startLoadingProgressAnimation();
    this.scheduleLoadingSequenceStep();
  }

  scheduleLoadingSequenceStep() {
    window.clearTimeout(this.loadingSequenceTimer);
    const delayMs = this.loadingSequenceIndex === LOAD_SEQUENCE_COPY.length - 1
      ? LOAD_SEQUENCE_FINAL_HOLD_MS
      : LOAD_SEQUENCE_STEP_MS;
    this.loadingSequenceTimer = window.setTimeout(() => {
      if (!this.loadingSequenceStartedAt) return;

      if (this.loadingSequenceIndex < LOAD_SEQUENCE_COPY.length - 1) {
        this.loadingSequenceIndex += 1;
        this.root.dataset.localLlmLoadingStep = String(this.loadingSequenceIndex);
        this.renderStatePanel();
        this.updateProgressBar();
        this.scheduleLoadingSequenceStep();
        return;
      }

      this.loadingSequenceTimer = null;
      this.flushPendingReadyIfSequenceComplete();
    }, delayMs);
  }

  stopLoadingSequence({ clearPending = false } = {}) {
    window.clearTimeout(this.loadingSequenceTimer);
    this.loadingSequenceTimer = null;
    this.loadingSequenceIndex = 0;
    this.loadingSequenceStartedAt = 0;
    this.stopLoadingProgressAnimation();
    delete this.root.dataset.localLlmLoadingStep;
    delete this.root.dataset.localLlmLoadingFloorMs;
    if (!this.isLoading()) this.stopLoadSpinner();
    if (clearPending) this.pendingReadyMessage = null;
  }

  isLoadingSequenceComplete() {
    if (!this.loadingSequenceStartedAt) return true;
    return performance.now() - this.loadingSequenceStartedAt >= this.getLoadingSequenceDurationMs();
  }

  getLoadingSequenceCopy() {
    return LOAD_SEQUENCE_COPY[Math.max(0, Math.min(LOAD_SEQUENCE_COPY.length - 1, this.loadingSequenceIndex))];
  }

  queueReadyMessage(message) {
    this.pendingReadyMessage = message || {};
    this.flushPendingReadyIfSequenceComplete();
  }

  flushPendingReadyIfSequenceComplete() {
    if (!this.pendingReadyMessage || !this.isLoadingSequenceComplete()) return;
    this.applyReadyMessage(this.pendingReadyMessage);
  }

  applyReadyMessage(message) {
    this.pendingReadyMessage = null;
    this.stopLoadingSequence();
    this.setLocalAssistantLoadState(false);
    clearTimeout(this._copyTimer);
    this._copyTimer = null;
    this._currentCopyTarget = '';
    this.loadCopy.innerHTML = '';
    this.loadCopy.style.opacity = '1';
    this.progress = 100;
    this.backend = message.backend || 'webgpu';
    this.modelReady = true;
    this.hideDiagnostics();
    this.updateStatus(WORKER_STATE.READY, message.message || 'Ready.');
    this.updateProgressBar();
    this.startPromptCycle();
    this.input.focus({ preventScroll: true });
    this.renderStatePanel({ immediate: true });
  }

  updateStatus(status, label = '') {
    this.status = status;
    this.root.dataset.localLlmStatus = status;
    this.root.dataset.localLlmStatusMessage = label;

    const chipState = (this.isLoading(status) || status === WORKER_STATE.THINKING || status === WORKER_STATE.STREAMING)
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
    this.sendButton.setAttribute('aria-label', canStop ? 'Stop message' : 'Send message');
    this.resetButton.disabled = this.isLoading(status);
    this.resetButton.setAttribute('aria-disabled', this.resetButton.disabled ? 'true' : 'false');
    this.progressWrap.hidden = !(this.isLoading(status) || status === WORKER_STATE.UNSUPPORTED);

    if (status === WORKER_STATE.READY) {
      this.setComposerPlaceholder(STATIC_READY_PLACEHOLDER);
    } else if (status === WORKER_STATE.ERROR || status === WORKER_STATE.UNSUPPORTED) {
      this.stopPromptCycle();
      this.setComposerPlaceholder('The local model is not available here.');
    } else if (status === WORKER_STATE.IDLE) {
      this.stopPromptCycle();
      this.setComposerPlaceholder('Load the model first.');
    } else if (status === WORKER_STATE.THINKING || status === WORKER_STATE.STREAMING) {
      this.stopPromptCycle();
    }

    this.updatePromptVisibility();
    this.updateLoadControl();
    this.updateTelemetry();
  }

  isLoading(status = this.status) {
    return status === WORKER_STATE.CHECKING || status === WORKER_STATE.LOADING || status === WORKER_STATE.OPTIMIZING;
  }

  updateLoadControl() {
    const appearance = LOAD_CONTROL[this.status] || LOAD_CONTROL.idle;

    this.startButton.disabled = appearance.disabled;
    this.startButton.setAttribute('aria-disabled', appearance.disabled ? 'true' : 'false');
    this.startButton.classList.remove('local-llm-load-control--loading', 'local-llm-load-control--ready', 'local-llm-load-control--error');
    if (appearance.cls) this.startButton.classList.add(appearance.cls);

    if (this.isLoading()) {
      this.startText.textContent = LOAD_SPINNER_FRAMES[this.loadSpinnerIndex % LOAD_SPINNER_FRAMES.length];
      this.startButton.setAttribute('aria-label', 'Loading the local model');
      this.startLoadSpinner();
    } else {
      this.stopLoadSpinner();
      this.startText.textContent = appearance.text;
      this.startButton.setAttribute('aria-label', this.status === WORKER_STATE.IDLE ? 'Download and start the local model' : appearance.text);
    }
  }

  startLoadSpinner() {
    if (this.loadSpinnerTimer) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this.loadSpinnerTimer = window.setInterval(() => {
      if (!this.isLoading()) {
        this.stopLoadSpinner();
        return;
      }
      this.loadSpinnerIndex = (this.loadSpinnerIndex + 1) % LOAD_SPINNER_FRAMES.length;
      this.startText.textContent = LOAD_SPINNER_FRAMES[this.loadSpinnerIndex];
      this.applyProgressBarValue(this.getDisplayedProgressValue());
    }, LOAD_SPINNER_STEP_MS);
  }

  stopLoadSpinner() {
    window.clearInterval(this.loadSpinnerTimer);
    this.loadSpinnerTimer = null;
    this.loadSpinnerIndex = 0;
  }

  updateTelemetry() {
    this.backendLabel.textContent = this.backend === 'webgpu' ? 'WebGPU' : this.backend;
    this.tpsLabel.textContent = Number.isFinite(this.tps) ? this.tps.toFixed(1) : '--';
  }

  setLocalAssistantLoadState(active) {
    const nextActive = Boolean(active);
    if (this._loadStateActive === nextActive) return;
    this._loadStateActive = nextActive;
    this._performanceState.setActive(nextActive);
  }

  updateProgressBar() {
    const value = this.getDisplayedProgressValue();
    this.applyProgressBarValue(value);
    this.updateLoadControl();
  }

  getLoadingSequenceDurationMs() {
    return (LOAD_SEQUENCE_COPY.length - 1) * LOAD_SEQUENCE_STEP_MS + LOAD_SEQUENCE_FINAL_HOLD_MS;
  }

  getDisplayedProgressValue() {
    if (this.status === WORKER_STATE.READY) return 100;
    if (!this.isLoading() || !this.loadingSequenceStartedAt) {
      return Math.max(0, Math.min(100, this.progress));
    }

    const elapsedRatio = Math.max(
      0,
      Math.min(1, (performance.now() - this.loadingSequenceStartedAt) / this.getLoadingSequenceDurationMs())
    );
    return Math.round(elapsedRatio * LOAD_PSEUDO_PROGRESS_CAP);
  }

  startLoadingProgressAnimation() {
    this.stopLoadingProgressAnimation();
    const tick = () => {
      if (!this.isLoading() || !this.loadingSequenceStartedAt) {
        this.loadingProgressFrameId = 0;
        return;
      }
      this.applyProgressBarValue(this.getDisplayedProgressValue());
      this.loadingProgressFrameId = window.requestAnimationFrame(tick);
    };
    this.loadingProgressFrameId = window.requestAnimationFrame(tick);
  }

  stopLoadingProgressAnimation() {
    if (!this.loadingProgressFrameId) return;
    window.cancelAnimationFrame(this.loadingProgressFrameId);
    this.loadingProgressFrameId = 0;
  }

  applyProgressBarValue(value) {
    value = Math.max(0, Math.min(100, Math.round(value)));
    this.progressBar.setAttribute('aria-valuenow', String(value));
    this.progressBar.setAttribute('aria-valuetext', `${value}%`);
    this.progressFill.style.width = `${value}%`;
    this.progressPercent.textContent = `${value}%`;
  }

  renderStatePanel({ immediate = false } = {}) {
    if (immediate) {
      if (this._statePanelFrameId) {
        window.cancelAnimationFrame(this._statePanelFrameId);
        this._statePanelFrameId = 0;
      }
      this.flushStatePanelRender({ immediate: true });
      return;
    }

    if (this._statePanelFrameId) return;
    this._statePanelFrameId = window.requestAnimationFrame(() => {
      this._statePanelFrameId = 0;
      this.flushStatePanelRender();
    });
  }

  flushStatePanelRender({ immediate = false } = {}) {
    const hasMessages = this.messages.length > 0;
    const shouldShowPanel = !hasMessages || this.isLoading() || this.status === WORKER_STATE.ERROR || this.status === WORKER_STATE.UNSUPPORTED;
    this.transcript.classList.toggle('local-llm-transcript--empty-panel', shouldShowPanel && !hasMessages);
    this.center.hidden = !shouldShowPanel;
    if (!shouldShowPanel) return;

    const isBusyPanel = this.isLoading();
    const copy = this.status === WORKER_STATE.READY && !hasMessages
      ? this.getReadySuggestion()
      : isBusyPanel
        ? this.getLoadingSequenceCopy()
        : STATE_COPY[this.status] || this.root.dataset.localLlmStatusMessage || 'Working locally.';

    this.transitionLoadCopy(copy, { immediate });

    const hideModelNote = this.status === WORKER_STATE.READY || isBusyPanel;
    this.modelNote.hidden = hideModelNote;
    this.modelNote.textContent = hideModelNote
      ? ''
      : `${LOCAL_LLM_CONFIG.model.displayName} (${LOCAL_LLM_CONFIG.model.sizeLabel}) · ${LOCAL_LLM_CONFIG.runtime.name} · private to this browser`;
    this.progressWrap.hidden = !(this.isLoading() || this.status === WORKER_STATE.UNSUPPORTED);
  }

  transitionLoadCopy(nextCopy, { immediate = false } = {}) {
    const safeCopy = renderSafeInlineText(nextCopy);
    if (this._currentCopyTarget === safeCopy) return;
    this._currentCopyTarget = safeCopy;
    clearTimeout(this._copyTimer);

    const apply = () => {
      this.loadCopy.innerHTML = safeCopy;
      requestAnimationFrame(() => {
        this.loadCopy.style.opacity = '1';
      });
    };

    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const canAnimate = !immediate
      && !prefersReducedMotion
      && !this.center.hidden
      && Boolean(this.loadCopy.innerHTML);

    if (!canAnimate) {
      apply();
      return;
    }

    this.loadCopy.style.opacity = '0';
    this._copyTimer = window.setTimeout(() => {
      this._copyTimer = null;
      apply();
    }, LOAD_COPY_FADE_MS);
  }

  startPromptCycle() {
    this.stopPromptCycle();
    this.readySuggestionOrder = buildReadySuggestionOrder();
    this.promptIndex = 0;
    this.renderStatePanel();
    this.promptTimer = window.setInterval(() => {
      this.promptIndex += 1;
      if (this.promptIndex >= this.readySuggestionOrder.length) {
        this.readySuggestionOrder = buildReadySuggestionOrder();
        this.promptIndex = 0;
      }
      this.renderStatePanel();
    }, 5000);
  }

  stopPromptCycle() {
    window.clearInterval(this.promptTimer);
    this.promptTimer = null;
  }

  getReadySuggestion() {
    return this.readySuggestionOrder[this.promptIndex] || LAST_READY_SUGGESTION;
  }

  setComposerPlaceholder(text) {
    this.input.placeholder = text;
    if (this.readyPrompt) this.readyPrompt.textContent = '';
  }

  updatePromptVisibility() {
    if (this.readyPrompt) this.readyPrompt.hidden = true;
  }

  queueInputChromeUpdate() {
    if (this._inputFrameId) return;
    this._inputFrameId = window.requestAnimationFrame(() => {
      this._inputFrameId = 0;
      this.updatePromptVisibility();
      this.autoSizeInput();
      this.updateCharCount();
    });
  }

  autoSizeInput() {
    this.input.style.overflowY = 'hidden';
    this.input.style.height = 'auto';
    const styles = window.getComputedStyle(this.input);
    const borderHeight = this.input.offsetHeight - this.input.clientHeight;
    const minHeight = Number.parseFloat(styles.minHeight) || 0;
    const nextHeight = Math.max(minHeight, this.input.scrollHeight + borderHeight);
    this.input.style.height = `${Math.min(nextHeight, 160)}px`;
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
      this.typingTimer = null;
      this._showTypingInBubble = true;
      this.syncThinkingIndicator();
    }, 350);
  }

  hideTypingIndicator() {
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    this._showTypingInBubble = false;
    this.syncThinkingIndicator();
  }

  syncThinkingIndicator() {
    if (!this._lastAssistantElement || !this.assistantDraft) return;
    const contentDiv = this._lastAssistantElement.querySelector('.local-llm-message-content');
    if (!contentDiv) return;

    const shouldShow = this._showTypingInBubble
      && !this.assistantDraft.content.trim()
      && (this.status === WORKER_STATE.THINKING || this.status === WORKER_STATE.STREAMING);

    if (shouldShow) {
      contentDiv.classList.add('local-llm-message-content--thinking');
      contentDiv.classList.remove('local-llm-message-content--streaming');
      contentDiv.innerHTML = '<span class="local-llm-typing" aria-hidden="true"><span class="local-llm-typing-dot"></span><span class="local-llm-typing-dot"></span><span class="local-llm-typing-dot"></span></span>';
      this._renderedMessageContent.set(this.assistantDraft, THINKING_CONTENT_MARKER);
      return;
    }

    if (this._renderedMessageContent.get(this.assistantDraft) === THINKING_CONTENT_MARKER) {
      contentDiv.classList.remove('local-llm-message-content--thinking');
      contentDiv.classList.remove('local-llm-message-content--streaming');
      contentDiv.innerHTML = renderSafeText(this.assistantDraft.content);
      this._renderedMessageContent.set(this.assistantDraft, this.assistantDraft.content);
    }
  }

  sendMessage() {
    if (this.status !== WORKER_STATE.READY || !this.worker) return;

    let content = this.input.value.trim();
    if (!content) return;

    this.updateStatus(WORKER_STATE.THINKING, 'Thinking locally.');

    if (content.length > MAX_INPUT_CHARS) {
      content = content.slice(0, MAX_INPUT_CHARS);
      this.addSystemNotice(`That was long, so I trimmed it to ${MAX_INPUT_CHARS} characters before sending.`);
    }

    this.tps = null;
    this.numTokens = 0;
    this.setLocalAssistantLoadState(true);
    this.input.value = '';
    this.autoSizeInput();
    this.updatePromptVisibility();
    this.messages.push({ role: 'user', content });
    this.messages = this.trimHistory(this.messages, { notify: true });
    this.assistantDraft = { role: 'assistant', content: '' };
    this.messages.push(this.assistantDraft);
    this.cancelStreamRender();
    this.renderMessages();
    this.renderStatePanel();
    this.showTypingAfterDelay();
    this.armGenerationTimeout();
    this.worker.postMessage({ type: 'generate', messages: this.messages });
  }

  ensureAssistantDraft() {
    if (this.assistantDraft) return;
    this.assistantDraft = { role: 'assistant', content: '' };
    this.messages.push(this.assistantDraft);
    this.renderMessages();
  }

  appendAssistantToken(token) {
    if (!this.assistantDraft || (this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING)) return;
    this.assistantDraft.content += token;
    this.scheduleAssistantStreamRender();
  }

  scheduleAssistantStreamRender() {
    this._streamShouldStick = this.isMessageListNearBottom();
    if (this._streamRenderTimer) {
      this._streamRenderDue = true;
      return;
    }

    this.flushAssistantStreamRender();
    this._streamRenderTimer = window.setTimeout(() => {
      this._streamRenderTimer = 0;
      if (!this._streamRenderDue) return;
      this._streamRenderDue = false;
      this.scheduleAssistantStreamRender();
    }, STREAM_RENDER_INTERVAL_MS);
  }

  cancelStreamRender() {
    window.clearTimeout(this._streamRenderTimer);
    this._streamRenderTimer = 0;
    this._streamRenderDue = false;
    this._streamShouldStick = false;
  }

  flushAssistantStreamRender() {
    if (!this.assistantDraft) return;
    this.updateAssistantElement(this._streamShouldStick || this.isMessageListNearBottom(), { plain: true });
  }

  finishAssistantMessage(finalText, generationId = null) {
    if (this.assistantDraft) {
      const shouldStick = this.isMessageListNearBottom();
      this.cancelStreamRender();
      if (finalText && cleanupModelText(finalText).length >= cleanupModelText(this.assistantDraft.content).length) {
        this.assistantDraft.content = finalText;
      }
      this.assistantDraft.content = cleanupModelText(this.assistantDraft.content);
      if (!this.assistantDraft.content.trim() && this.status !== WORKER_STATE.ERROR && this.status !== WORKER_STATE.UNSUPPORTED) {
        this.assistantDraft.content = 'I could not produce a useful answer. Try a shorter prompt.';
      }
      if (!this.assistantDraft.content.trim()) {
        this.messages = this.messages.filter((message) => message !== this.assistantDraft);
        this._lastAssistantElement?.remove();
      } else {
        this._renderedMessageContent.delete(this.assistantDraft);
        this.updateAssistantElement(shouldStick, { plain: false });
      }
      const trimmed = this.trimHistory(this.messages, { notify: true });
      const didTrim = trimmed.length !== this.messages.length || trimmed.some((message, index) => message !== this.messages[index]);
      this.messages = trimmed;
      this.assistantDraft = null;
      this._lastAssistantWasInterrupted = false;
      if (didTrim) {
        this.renderMessages({ animate: false, stickToBottom: shouldStick });
      } else if (shouldStick) {
        this.scrollMessagesToBottom();
      }
      this.announceLastAssistantMessage();
    }

    if (this.status !== WORKER_STATE.UNSUPPORTED && this.status !== WORKER_STATE.ERROR) {
      this.hideTypingIndicator();
      this.updateStatus(WORKER_STATE.READY, 'Ready.');
      this.setLocalAssistantLoadState(false);
      this.startPromptCycle();
      this.renderStatePanel();
    }
    this.markGenerationComplete(generationId);
  }

  finishInterruptedGeneration(generationId = null) {
    this.hideTypingIndicator();
    if (this.assistantDraft) {
      this.cancelStreamRender();
      this.assistantDraft.content = cleanupModelText(this.assistantDraft.content) || 'Generation stopped.';
      this.assistantDraft = null;
      this._lastAssistantWasInterrupted = true;
      this.renderMessages();
      this.announceLastAssistantMessage();
    }
    this.updateStatus(WORKER_STATE.READY, 'Generation stopped.');
    this.setLocalAssistantLoadState(false);
    this.startPromptCycle();
    this.renderStatePanel();
    this.markGenerationComplete(generationId);
  }

  markGenerationComplete(generationId = null) {
    const parsed = Number(generationId);
    if (Number.isFinite(parsed) && parsed > 0) {
      this._lastCompletedGenerationId = Math.max(this._lastCompletedGenerationId, parsed);
    } else if (this._activeGenerationId > 0) {
      this._lastCompletedGenerationId = Math.max(this._lastCompletedGenerationId, this._activeGenerationId);
    }
    this._activeGenerationId = 0;
  }

  interruptGeneration() {
    if (!this.worker || (this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING)) return;
    this.clearGenerationTimeout();
    this.worker.postMessage({ type: 'interrupt' });
  }

  trimHistory(messages, { notify = false } = {}) {
    const notices = messages.filter((message) => message.role === 'notice').slice(-2);
    const chatMessages = messages.filter((message) => message.role !== 'notice');
    const trimmedCount = Math.max(0, chatMessages.length - LOCAL_LLM_CONFIG.limits.maxHistoryMessages);
    const chat = chatMessages.slice(-LOCAL_LLM_CONFIG.limits.maxHistoryMessages);
    if (notify && trimmedCount > 0 && !notices.some((message) => /Earlier local chat messages/.test(message.content))) {
      notices.push({
        role: 'notice',
        content: `Earlier local chat messages were removed from model context to keep the browser memory budget stable.`
      });
    }
    return [...notices, ...chat];
  }

  _pruneMapsForMessages(messages) {
    const messageSet = new Set(messages);
    for (const [key] of this._messageElements) {
      if (!messageSet.has(key)) this._messageElements.delete(key);
    }
    for (const [key] of this._renderedMessageContent) {
      if (!messageSet.has(key)) this._renderedMessageContent.delete(key);
    }
  }

  renderMessages(options = {}) {
    const animate = options.animate !== false;
    const stickToBottom = options.stickToBottom !== false;
    const liveArticles = new Set();
    this._lastAssistantElement = null;

    // Build a map of existing DOM children keyed by their message object
    const existingChildren = new Map();
    this.messageList.querySelectorAll('article').forEach((article) => {
      const msg = article._localLlmMessage;
      if (msg) existingChildren.set(msg, article);
    });

    for (const message of this.messages) {
      let article = existingChildren.get(message);

      if (!article) {
        article = this.renderMessageElement(message, animate);
      } else {
        // Existing element — check if content changed and update only if needed
        if (this._renderedMessageContent.get(message) !== message.content) {
          this.renderMessageElement(message, animate);
        }
      }

      if (message.role === 'assistant') this._lastAssistantElement = article;
      liveArticles.add(article);
      if (article.parentElement !== this.messageList || this.messageList.lastElementChild !== article) {
        this.messageList.appendChild(article);
      }
    }

    Array.from(this.messageList.children).forEach((child) => {
      if (!liveArticles.has(child)) {
        child.remove();
      }
    });

    // Prune Map entries for messages that are no longer in this.messages
    this._pruneMapsForMessages(this.messages);

    this.scrollMessagesIfNeeded(stickToBottom);
    this.renderStatePanel();
  }

  renderMessageElement(message, animate) {
    const role = message.role === 'user' ? 'You' : message.role === 'notice' ? 'Note' : 'Local Assistant';
    let article = this._messageElements.get(message);

    if (!article) {
      article = document.createElement('article');
      article.className = `local-llm-message local-llm-message--${message.role}`;
      article.setAttribute('aria-label', role);
      article.innerHTML = `
        <div class="local-llm-message-role">${role}</div>
        <div class="local-llm-message-content"></div>
      `;
      this._messageElements.set(message, article);
    }

    article._localLlmMessage = message;

    article.classList.toggle('local-llm-message--static', !animate);

    const isThinkingDraft = message === this.assistantDraft
      && this._showTypingInBubble
      && !message.content.trim()
      && (this.status === WORKER_STATE.THINKING || this.status === WORKER_STATE.STREAMING);

    if (isThinkingDraft) {
      this.syncThinkingIndicator();
    } else if (this._renderedMessageContent.get(message) !== message.content) {
      const contentDiv = article.querySelector('.local-llm-message-content');
      if (contentDiv) {
        contentDiv.classList.remove('local-llm-message-content--thinking', 'local-llm-message-content--streaming');
        contentDiv.innerHTML = renderSafeText(message.content);
      }
      this._renderedMessageContent.set(message, message.content);
    }

    return article;
  }

  updateAssistantElement(stickToBottom = this.isMessageListNearBottom(), { plain = false } = {}) {
    if (!this._lastAssistantElement || !this.assistantDraft) return;
    const contentDiv = this._lastAssistantElement.querySelector('.local-llm-message-content');
    if (!contentDiv) return;

    const currentContent = this.assistantDraft.content;
    const prevRendered = this._renderedMessageContent.get(this.assistantDraft) || '';

    if (plain) {
      if (prevRendered !== STREAMING_CONTENT_MARKER || contentDiv.textContent !== currentContent) {
        contentDiv.classList.remove('local-llm-message-content--thinking');
        contentDiv.classList.add('local-llm-message-content--streaming');
        contentDiv.textContent = currentContent;
        this._renderedMessageContent.set(this.assistantDraft, STREAMING_CONTENT_MARKER);
      }
    } else if (prevRendered !== currentContent) {
      contentDiv.classList.remove('local-llm-message-content--thinking', 'local-llm-message-content--streaming');
      contentDiv.innerHTML = renderSafeText(currentContent);
      this._renderedMessageContent.set(this.assistantDraft, currentContent);
    }
    this.scrollMessagesIfNeeded(stickToBottom);
  }

  isMessageListNearBottom(threshold = 96) {
    const diff = this.messageList.scrollHeight - this.messageList.clientHeight - this.messageList.scrollTop;
    return diff <= threshold;
  }

  scrollMessagesToBottom() {
    this.messageList.scrollTop = this.messageList.scrollHeight;
  }

  scrollMessagesIfNeeded(shouldStick = this.isMessageListNearBottom()) {
    if (shouldStick) {
      this.scrollMessagesToBottom();
    }
  }

  announceLastAssistantMessage() {
    const liveRegion = this.root.querySelector('#localLlmLiveRegion');
    const last = this.messages.filter((message) => message.role === 'assistant').pop();
    if (liveRegion && last) {
      const content = last.content.length > 220 ? `${last.content.slice(0, 217)}...` : last.content;
      liveRegion.textContent = this._lastAssistantWasInterrupted ? `${content} (stopped)` : content;
    }
    this._lastAssistantWasInterrupted = false;
  }

  addSystemNotice(content) {
    this.messages.push({ role: 'notice', content });
    this.renderMessages();
  }

  showLoadFailure(message) {
    this.stopLoadingSequence({ clearPending: true });
    this.cancelStreamRender();
    this.setLocalAssistantLoadState(false);
    const fallback = buildFailureCopy(message, this.diagnostics);
    this.updateStatus(message.status || WORKER_STATE.ERROR, fallback.message);
    this.progress = 0;
    this.updateProgressBar();
    this.showDiagnostics(fallback);
    this.renderStatePanel();
  }

  showGenerationFailure(message) {
    const fallback = buildFailureCopy(message, this.diagnostics);
    fallback.title = /generation-busy|generation-not-ready/.test(message.category || '') ? 'Local model is busy' : 'Local reply failed';
    fallback.detail = message.detail || fallback.detail;
    fallback.likelyFix = message.likelyFix || 'Retry the message. If it happens again, reset the model and reload it.';
    this.hideTypingIndicator();
    this.cancelStreamRender();
    this.setLocalAssistantLoadState(false);
    this.updateStatus(WORKER_STATE.ERROR, message.message || 'Local generation failed.');
    this.showDiagnostics(fallback);
    this.finishAssistantMessage(message.message || 'The local model could not finish this reply.', message.generationId);
  }

  showDiagnostics(copy) {
    this.diagnosticsPanel.hidden = false;
    this.diagnosticsPanel.innerHTML = '';

    const title = document.createElement('p');
    title.className = 'local-llm-diagnostics-title';
    title.textContent = copy.title;
    this.diagnosticsPanel.appendChild(title);

    const detail = document.createElement('p');
    detail.textContent = copy.detail;
    this.diagnosticsPanel.appendChild(detail);

    const fix = document.createElement('p');
    const fixStrong = document.createElement('strong');
    fixStrong.textContent = 'Try: ';
    fix.appendChild(fixStrong);
    fix.appendChild(document.createTextNode(copy.likelyFix));
    this.diagnosticsPanel.appendChild(fix);

    const actions = document.createElement('div');
    actions.className = 'local-llm-diagnostics-actions';

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'local-llm-diagnostics-retry';
    retryBtn.dataset.localLlmRetry = '';
    retryBtn.dataset.cursor = 'hover';
    retryBtn.textContent = 'Retry';
    actions.appendChild(retryBtn);

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'local-llm-diagnostics-retry';
    clearBtn.dataset.localLlmClearCache = '';
    clearBtn.dataset.cursor = 'hover';
    clearBtn.textContent = 'Clear cache';
    actions.appendChild(clearBtn);

    this.diagnosticsPanel.appendChild(actions);
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
      this._messageElements = new Map();
      this._renderedMessageContent = new Map();
      this.cancelStreamRender();
      this.input.value = '';
      this.autoSizeInput();
      this.renderMessages();
    }
    this.tps = null;
    this.numTokens = 0;
    this.cancelStreamRender();
    this.markGenerationComplete();
    this.captureContextStats(null);
    this.hideDiagnostics();
    this.setLocalAssistantLoadState(false);
    this.stopPromptCycle();
    this.stopLoadingSequence({ clearPending: true });
    this.worker?.postMessage({ type: 'reset' });
    this.updateTelemetry();
    this.updateStatus(this.modelReady ? WORKER_STATE.READY : WORKER_STATE.IDLE, this.modelReady ? 'Chat reset.' : STATE_COPY.idle);
    if (this.modelReady) this.startPromptCycle();
    this.renderStatePanel();
  }

  async clearModelCache() {
    this._sessionEnded = false;
    this.terminateWorker({ clearCache: true, delayMs: 400 });
    this.modelReady = false;
    this.messages = [];
    this.assistantDraft = null;
    this.progress = 0;
    this.tps = null;
    this.numTokens = 0;
    this.cancelStreamRender();
    this.setLocalAssistantLoadState(false);
    this.markGenerationComplete();
    this.captureContextStats(null);
    this.hideDiagnostics();
    this.stopPromptCycle();
    this.stopLoadingSequence({ clearPending: true });
    this.renderMessages();
    let cacheCleared = false;
    try {
      cacheCleared = await this.clearBrowserModelCaches();
    } catch (error) {
      console.debug('Local assistant cache reset failed.', error);
    }
    if (!cacheCleared) {
      this.addSystemNotice('Cache deletion failed. The model may reload from cache. Try a hard refresh if issues persist.');
    }
    this.updateProgressBar();
    this.updateStatus(WORKER_STATE.IDLE, 'Model cache reset. Start again to reload locally.');
    this.renderStatePanel();
  }

  dispose() {
    if (this._pagehideHandler) {
      window.removeEventListener('pagehide', this._pagehideHandler);
      this._pagehideHandler = null;
    }
    if (this._deactivateHandler) {
      this.root.removeEventListener('utility-deactivate', this._deactivateHandler);
      this._deactivateHandler = null;
    }
    if (this._activateHandler) {
      this.root.removeEventListener('utility-activate', this._activateHandler);
      this._activateHandler = null;
    }
    if (this.worker) {
      this.clearBrowserModelCaches().catch((error) => {
        console.debug('Local assistant cache cleanup failed during dispose.', error);
      });
      this.terminateWorker({ clearCache: true, delayMs: 400 });
    }
    this.clearGenerationTimeout();
    this.cancelStreamRender();
    this.setLocalAssistantLoadState(false);
    if (this._inputFrameId) {
      window.cancelAnimationFrame(this._inputFrameId);
      this._inputFrameId = 0;
    }
    if (this._statePanelFrameId) {
      window.cancelAnimationFrame(this._statePanelFrameId);
      this._statePanelFrameId = 0;
    }
    if (this._copyTimer) {
      clearTimeout(this._copyTimer);
      this._copyTimer = null;
    }
    if (this.typingTimer) {
      clearTimeout(this.typingTimer);
      this.typingTimer = null;
    }
    this.stopPromptCycle();
    this.stopLoadingSequence({ clearPending: true });
    this.root.dataset.localLlmMounted = 'false';
  }

  endModelSession({ clearMessages = false, updateUi = true, unload = false } = {}) {
    if (this._sessionEnded) return;
    this._sessionEnded = true;
    this.clearBrowserModelCaches().catch((error) => {
      console.debug('Local assistant cache cleanup failed while ending session.', error);
    });
    this.terminateWorker({ clearCache: true, delayMs: unload ? 0 : 400 });
    this.clearGenerationTimeout();
    this.cancelStreamRender();
    this.setLocalAssistantLoadState(false);
    this.modelReady = false;
    this.progress = 0;
    this.tps = null;
    this.numTokens = 0;
    this.markGenerationComplete();
    this.captureContextStats(null);
    this.assistantDraft = null;
    this.pendingReadyMessage = null;
    this.stopPromptCycle();
    this.stopLoadingSequence({ clearPending: true });
    if (clearMessages) {
      this.messages = [];
      this._messageElements = new Map();
      this._renderedMessageContent = new Map();
      this.input.value = '';
      this.renderMessages({ animate: false });
    }
    if (updateUi) {
      this.updateProgressBar();
      this.updateTelemetry();
      this.updateStatus(WORKER_STATE.IDLE, STATE_COPY.idle);
      this.renderStatePanel();
    }
  }

  terminateWorker({ clearCache = false, delayMs = 0 } = {}) {
    const worker = this.worker;
    if (!worker) return;

    if (clearCache) {
      try {
        worker.postMessage({ type: 'dispose', clearCache: true });
      } catch (error) {
        console.debug('Local assistant worker dispose message failed.', error);
      }
    }

    if (this._workerMessageHandler) worker.removeEventListener('message', this._workerMessageHandler);
    if (this._workerErrorHandler) worker.removeEventListener('error', this._workerErrorHandler);
    this._workerMessageHandler = null;
    this._workerErrorHandler = null;
    if (delayMs > 0) {
      window.setTimeout(() => {
        worker.terminate();
        if (this.worker === worker) this.worker = null;
      }, delayMs);
    } else {
      worker.terminate();
      this.worker = null;
    }
  }

  async clearBrowserModelCaches() {
    const cacheCleared = await deleteLocalModelCaches();
    this.root.dataset.localLlmCacheCleared = cacheCleared ? 'true' : 'false';
    return cacheCleared;
  }

  armGenerationTimeout() {
    this.clearGenerationTimeout();
    this._generationTimeoutId = window.setTimeout(() => this.handleGenerationTimeout(), GENERATION_IDLE_TIMEOUT_MS);
  }

  clearGenerationTimeout() {
    if (!this._generationTimeoutId) return;
    window.clearTimeout(this._generationTimeoutId);
    this._generationTimeoutId = 0;
  }

  handleGenerationTimeout() {
    this._generationTimeoutId = 0;
    if (this.status !== WORKER_STATE.THINKING && this.status !== WORKER_STATE.STREAMING) return;

    this.terminateWorker({ clearCache: false });
    this.modelReady = false;
    this.cancelStreamRender();
    this.setLocalAssistantLoadState(false);
    this.showGenerationFailure({
      status: WORKER_STATE.ERROR,
      category: 'generation-timeout',
      message: 'The local model stopped responding before it produced a reply.',
      detail: 'No generation progress arrived for 30 seconds, so the worker was reset.',
      likelyFix: 'Press Retry or Load, then try a shorter prompt.'
    });
  }
}


function buildFailureCopy(message, diagnostics) {
  if (!diagnostics) {
    console.warn('Local LLM diagnostics were unavailable for failure copy.', message);
  }
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

/**
 * Render bold, italic, and inline code from controlled static strings.
 *
 * NOTE: The regex patterns do not handle nested or adjacent emphasis markers
 * correctly (e.g., `***text***` matches as `*<strong>text</strong>*`).
 * This is acceptable because the input is always controlled static strings
 * from the loading copy animation — never user-supplied markdown.
 */
function renderSafeInlineText(text) {
  return escapeHtml(text)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^\*\n]+)\*(?=[\s).,;:!?]|\s*$)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function buildReadySuggestionOrder() {
  const firstSuggestions = READY_SUGGESTIONS.filter((suggestion) => suggestion !== LAST_READY_SUGGESTION);
  for (let index = firstSuggestions.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [firstSuggestions[index], firstSuggestions[swapIndex]] = [firstSuggestions[swapIndex], firstSuggestions[index]];
  }
  return [...firstSuggestions, LAST_READY_SUGGESTION];
}

function formatStatus(status) {
  return String(status || '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

async function deleteLocalModelCaches() {
  return deleteBrowserModelCaches(window.caches, 'Local assistant cache deletion failed.');
}

export function initLocalLlmUtility() {
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
