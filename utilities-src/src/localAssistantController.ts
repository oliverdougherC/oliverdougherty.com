import '../../css/local-assistant.css';
import { AssistantSession } from './local-assistant/session';
import { createAssistantRuntime } from './local-assistant/runtime';
import { SnakeGame } from './local-assistant/snake';
import { ObservatoryView } from './local-assistant/observatoryView';
import { renderMarkdown } from './local-assistant/render';
import type { AssistantState, Runtime, Token } from './local-assistant/types';

const number = (value: number | undefined, suffix = '', precision = 1) => value !== undefined && Number.isFinite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: precision })}${suffix}` : '—';
const bytes = (value: number) => `${(value / 1e9).toFixed(2)} GB`;
export class LocalAssistantController {
  private readonly session: AssistantSession;
  private readonly events = new AbortController();
  private unsubscribe?: () => void;
  private snake?: SnakeGame;
  private initialized = false;
  private destroyed = false;
  private stickToBottom = true;
  private lastAnnouncement = '';
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private renderedPhase = '';
  private frame = 0;
  private resizeFrame = 0;
  private resizeObserver?: ResizeObserver;
  private gameRunning = false;
  private observatory?: ObservatoryView;
  private promptTokens?: Token[];
  private contextTokens: Token[] = [];
  private copyFeedback: { button: HTMLButtonElement; timer: ReturnType<typeof setTimeout> } | null = null;
  private lastGenerated?: number;
  constructor(private readonly root: HTMLElement, runtimeFactory: () => Runtime = createAssistantRuntime) {
    this.session = new AssistantSession(runtimeFactory);
  }
  init(): void {
    if (this.initialized || this.destroyed) return;
    this.initialized = true;
    this.root.classList.add('local-assistant');
    this.root.innerHTML = `<div class="la-workspace"><section class="la-conversation" aria-label="Conversation">
      <div class="la-welcome" data-welcome>
        <h2>Qwen3.5 <span>2B</span></h2>
        <div class="la-loader"><div class="la-load-heading"><strong data-load-title>Loading model</strong><span data-percent></span></div>
          <progress aria-label="Model download" data-progress></progress><p data-load-status>Preparing local inference…</p>
          <div class="la-loader-actions"><span class="la-model-spec">Weights from Hugging Face</span><button type="button" data-cancel>Cancel</button><button type="button" data-retry hidden>Retry</button><button type="button" class="la-primary" data-enter hidden>Enter chat ↗</button></div>
        </div>
        <div class="la-snake" data-snake><div class="la-snake-label"><button type="button" data-play>Play Snake ↗</button><span data-score hidden>0</span></div><canvas width="420" height="120" tabindex="0" aria-label="Snake game. Arrow keys or WASD to move; Space to restart." data-canvas></canvas></div>
      </div>
      <div class="la-chat" data-chat hidden>
        <div class="la-transcript-wrap"><div class="la-transcript" data-transcript role="region" aria-label="Chat transcript" tabindex="0"></div><button type="button" class="la-latest" data-latest hidden>Latest ↓</button></div>
        <div class="la-chat-error" data-chat-error hidden><span data-chat-error-text></span><button type="button" data-chat-retry>Reload model</button></div>
        <form class="la-composer" data-form><label class="la-sr" for="localAssistantPrompt">Message LLM Rumen Cannula</label><textarea id="localAssistantPrompt" data-input rows="1" maxlength="16000" placeholder="Message…" aria-description="Enter to send. Shift+Enter for a new line." autocomplete="off"></textarea><div class="la-composer-tools"><div class="la-mode-controls"><label class="la-thinking"><input type="checkbox" data-thinking><span>Thinking</span></label><label class="la-thinking"><input type="checkbox" data-slow aria-description="Pace inference near three tokens per second"><span>Slow</span></label></div><button type="button" data-new>New chat</button><button type="button" class="la-primary" data-stop hidden>Stop</button><button type="submit" class="la-primary" data-send>Send ↗</button></div></form>
      </div>
      </section><aside class="la-observatory" aria-label="Model observatory" hidden>
        <h2>Qwen3.5 <span>2B</span></h2>
        <div class="la-metrics"><div><span>Context</span><strong data-context>—</strong></div><div><span>Avg. tokens / s</span><strong data-speed>—</strong></div><div><span>Generated</span><strong data-generated>—</strong></div><div><span>Prompt time</span><strong data-prefill>—</strong></div></div>
        <div class="la-observatory-panels" data-observatory-panels></div>
      </aside></div><p class="la-sr" role="status" aria-live="polite" aria-atomic="true" data-announcement></p>`;
    const signal = this.events.signal;
    const listen = (target: EventTarget, type: string, callback: EventListener) => target.addEventListener(type, callback, { signal });
    listen(this.root, 'click', (event) => { void this.click(event); });
    this.observatory = new ObservatoryView(this.el('[data-observatory-panels]'), { onInteraction: () => this.session.touchActivity() });
    listen(this.el('[data-form]'), 'submit', (event) => { event.preventDefault(); this.send(); });
    listen(this.el('[data-input]'), 'keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Enter' && !key.shiftKey && !key.isComposing) { event.preventDefault(); this.send(); }
    });
    listen(this.el('[data-input]'), 'input', () => { this.session.touchActivity(); this.updateSend(); });
    listen(document, 'keydown', () => { if (this.gameRunning && this.session.state.active && !this.session.state.entered) this.session.touchActivity(); });
    listen(this.el('[data-thinking]'), 'change', () => this.session.setThinking(this.el<HTMLInputElement>('[data-thinking]').checked));
    listen(this.el('[data-slow]'), 'change', () => this.session.setSlow(this.el<HTMLInputElement>('[data-slow]').checked));
    listen(this.el('[data-transcript]'), 'wheel', () => this.pauseAutoScroll());
    listen(this.el('[data-transcript]'), 'pointerdown', () => this.pauseAutoScroll());
    listen(this.el('[data-transcript]'), 'keydown', event => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Enter'].includes((event as KeyboardEvent).key)) this.pauseAutoScroll();
    });
    listen(this.el('[data-transcript]'), 'scroll', () => {
      if (this.session.state.active) this.session.touchActivity();
      if (this.frame) return; // Ignore geometry changes while an intentional follow is pending.
      const transcript = this.el('[data-transcript]');
      this.stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
      if (!this.stickToBottom) cancelAnimationFrame(this.frame);
      this.el('[data-latest]').hidden = this.stickToBottom;
    });
    listen(this.root, 'utility-deactivate', () => { this.snake?.stop(); this.session.deactivate(); });
    listen(this.root, 'utility-activate', () => { void this.session.activate(); });
    listen(window, 'pagehide', () => { this.snake?.stop(); this.session.deactivate(); void this.session.unload(); });
    listen(window, 'pageshow', (event) => { if ((event as PageTransitionEvent).persisted && this.root.closest('[hidden]') === null) void this.session.activate(); });
    listen(document, 'selectionchange', () => { if (this.session.state.active) this.renderMessages(this.session.state); });
    listen(this.root, 'focusout', () => queueMicrotask(() => { if (!this.destroyed && this.session.state.active) this.renderMessages(this.session.state); }));
    this.unsubscribe = this.session.subscribe((state) => {
      this.collectObservation(state);
      this.root.dataset.phase = state.phase;
      if (!state.active) {
        if (this.renderTimer) clearTimeout(this.renderTimer);
        this.renderTimer = null; cancelAnimationFrame(this.frame); this.frame = 0;
        return;
      }
      if (state.phase === 'generating' && this.renderedPhase === 'generating') {
        this.renderTimer ??= setTimeout(() => { this.renderTimer = null; this.render(this.session.state); }, 50);
      } else { if (this.renderTimer) clearTimeout(this.renderTimer); this.renderTimer = null; this.render(state); }
    });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = requestAnimationFrame(() => { if (this.session.state.active) { this.measureObservatory(); this.renderObservation(this.session.state); } });
      });
      this.resizeObserver.observe(this.root);
      this.resizeObserver.observe(this.el('[data-observatory-panels]'));
    }
    void this.session.activate();
  }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.copyFeedback) clearTimeout(this.copyFeedback.timer);
    this.resizeObserver?.disconnect(); cancelAnimationFrame(this.resizeFrame);
    this.observatory?.destroy();
    this.events.abort(); this.unsubscribe?.(); cancelAnimationFrame(this.frame); this.snake?.destroy();
    await this.session.destroy();
  }
  private el<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private announce(text: string): void {
    if (text === this.lastAnnouncement) return;
    this.lastAnnouncement = text; this.el('[data-announcement]').textContent = text;
  }
  private async click(event: Event): Promise<void> {
    const target = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!target) return;
    this.session.touchActivity();
    if (target.hasAttribute('data-enter')) { this.gameRunning = false; this.snake?.stop(); this.session.enterChat(); this.el('[data-input]').focus(); }
    if (target.hasAttribute('data-retry') || target.hasAttribute('data-chat-retry')) { if (!this.session.state.active) void this.session.activate(); else void this.session.retry(); }
    if (target.hasAttribute('data-cancel')) void this.session.unload();
    if (target.hasAttribute('data-stop')) this.session.stop();
    if (target.hasAttribute('data-new')) { this.resetObservation(); await this.session.reset(); this.stickToBottom = true; this.el('[data-input]').focus(); }
    if (target.hasAttribute('data-latest')) { this.stickToBottom = true; this.scrollToBottom(); }
    if (target.hasAttribute('data-prompt')) { this.el<HTMLTextAreaElement>('[data-input]').value = target.dataset.prompt!; this.send(); }
    if (target.hasAttribute('data-play')) {
      this.snake ??= new SnakeGame(this.el<HTMLCanvasElement>('[data-canvas]'), (score) => { this.el('[data-score]').textContent = String(score); });
      this.el('[data-welcome]').classList.add('is-playing');
      this.el('[data-snake]').classList.add('is-playing'); this.el('[data-score]').hidden = false;
      this.gameRunning = !this.gameRunning;
      if (this.gameRunning) this.snake.start(); else this.snake.stop();
      target.textContent = this.gameRunning ? 'Pause' : 'Resume';
    }
    if (target.hasAttribute('data-copy-code') || target.hasAttribute('data-copy-message')) {
      const source = target.hasAttribute('data-copy-code') ? target.closest('.la-code')?.querySelector('code')?.textContent : this.session.state.messages[Number(target.dataset.copyMessage)]?.content;
      try {
        await navigator.clipboard.writeText(source ?? '');
        if (this.destroyed) return;
        if (this.copyFeedback) { clearTimeout(this.copyFeedback.timer); this.copyFeedback.button.textContent = 'Copy'; }
        target.textContent = 'Copied';
        this.copyFeedback = { button: target, timer: setTimeout(() => { target.textContent = 'Copy'; this.copyFeedback = null; }, 1600) };
        this.announce('Copied to clipboard.');
      }
      catch { this.announce('Copy unavailable. Select the text to copy it.'); }
    }
  }
  private send(): void {
    const input = this.el<HTMLTextAreaElement>('[data-input]');
    if (!input.value.trim() || this.session.state.phase !== 'ready') return;
    const text = input.value; input.value = ''; this.stickToBottom = true;
    this.resetObservation();
    void this.session.send(text);
  }
  private updateSend(): void {
    this.el<HTMLButtonElement>('[data-send]').disabled = this.session.state.phase !== 'ready' || !this.el<HTMLTextAreaElement>('[data-input]').value.trim();
  }
  private pauseAutoScroll(): void {
    this.stickToBottom = false;
    cancelAnimationFrame(this.frame); this.frame = 0;
  }
  private scrollToBottom(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => { this.frame = 0; if (!this.stickToBottom) return; const transcript = this.el('[data-transcript]'); transcript.scrollTop = transcript.scrollHeight; this.el('[data-latest]').hidden = true; });
  }
  private render(state: AssistantState): void {
    // Ready auto-enters chat unless the Snake game is open (playing, paused, or game over); then the button appears.
    if (state.phase === 'ready' && state.active && !state.entered && !this.el('[data-snake]').classList.contains('is-playing')) { this.session.enterChat(); this.el<HTMLTextAreaElement>('[data-input]').focus(); return; }
    const chat = state.entered && !!state.info;
    const errorChanged = this.el('[data-chat-error]').hidden !== (state.phase !== 'error');
    this.el('[data-chat-error]').hidden = state.phase !== 'error';
    this.el('[data-chat-error-text]').textContent = state.status;
    this.root.dataset.phase = state.phase;
    this.root.classList.toggle('is-chat', chat);
    this.el('[data-welcome]').hidden = chat; this.el('[data-chat]').hidden = !chat;
    this.el('.la-observatory').hidden = !chat;
    if (this.gameRunning && state.active && !chat) this.snake?.start(); else this.snake?.stop();
    if (!this.gameRunning && this.el('[data-snake]').classList.contains('is-playing')) this.el('[data-play]').textContent = 'Resume';
    this.el<HTMLButtonElement>('[data-new]').disabled = !chat;
    this.el('[data-enter]').hidden = state.phase !== 'ready' || state.entered;
    this.el('[data-retry]').hidden = !['error', 'idle'].includes(state.phase);
    this.el('[data-cancel]').hidden = state.phase !== 'loading';
    this.el('[data-load-title]').textContent = state.phase === 'ready' ? 'Ready' : state.phase === 'unsupported' ? 'A browser with WebGPU is needed' : state.phase === 'error' ? 'The model couldn’t start' : state.phase === 'idle' ? 'Paused' : /allocating|initializing/i.test(state.status) ? 'Initializing' : 'Downloading';
    this.el('[data-load-status]').textContent = state.phase === 'unsupported' ? state.status : state.phase === 'ready' ? '' : state.status;
    this.el('[data-load-status]').hidden = !['error', 'unsupported'].includes(state.phase);
    const progress = this.el<HTMLProgressElement>('[data-progress]'); progress.hidden = state.phase !== 'loading';
    if (state.total && state.total > 0) { progress.max = state.total; progress.value = Math.min(state.loaded, state.total); }
    else progress.removeAttribute('value');
    this.el('[data-percent]').textContent = state.phase === 'loading' ? state.total ? `${bytes(state.loaded)} / ${bytes(state.total)}` : state.loaded ? bytes(state.loaded) : '' : '';
    this.el('[data-stop]').hidden = state.phase !== 'generating'; this.el('[data-send]').hidden = state.phase === 'generating';
    this.el<HTMLInputElement>('[data-thinking]').checked = state.thinking;
    this.el<HTMLInputElement>('[data-slow]').checked = state.slow;
    this.el<HTMLInputElement>('[data-thinking]').disabled = state.phase === 'generating';
    this.updateSend();
    this.renderedPhase = state.phase;
    this.renderMessages(state);
    this.measureObservatory();
    this.renderObservation(state);
    if (errorChanged && this.stickToBottom) this.scrollToBottom();
    const announcement = state.phase === 'generating' ? 'Generating response.' : state.phase === 'ready' && state.messages.length ? state.status === 'Generation stopped.' ? 'Generation stopped.' : 'Response complete.' : state.phase === 'ready' ? state.entered ? 'Model ready.' : 'Model ready. Choose Enter chat when you are ready.' : state.phase === 'loading' ? 'Loading the local model.' : state.status;
    this.announce(announcement);
  }
  private renderMessages(state: AssistantState): void {
    if (!this.initialized || this.destroyed) return;
    const transcript = this.el('[data-transcript]');
    const previousScroll = transcript.scrollTop;
    let changed = false;
    for (const article of transcript.querySelectorAll<HTMLElement>('[data-message-index]')) {
      if (Number(article.dataset.messageIndex) >= state.messages.length) { article.remove(); changed = true; }
    }
    state.messages.forEach((message, index) => {
      let article = transcript.querySelector<HTMLElement>(`[data-message-index="${index}"]`);
      if (!article) {
        article = document.createElement('article'); article.dataset.messageIndex = String(index); article.className = `la-message la-message--${message.role}`;
        const heading = document.createElement('div'); heading.className = 'la-message-heading';
        const role = document.createElement('span'); role.textContent = message.role === 'user' ? 'You' : 'Qwen'; heading.append(role);
        if (message.role === 'assistant') { const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy'; copy.dataset.copyMessage = String(index); copy.setAttribute('aria-label', 'Copy assistant response'); heading.append(copy); }
        article.append(heading);
        const body = document.createElement('div'); body.className = 'la-message-body'; article.append(body);
        transcript.append(article); changed = true;
      }
      const copy = article.querySelector<HTMLButtonElement>('[data-copy-message]'); if (copy) copy.hidden = !message.content;
      const isThinking = message.role === 'assistant' && index === state.messages.length - 1 && state.phase === 'generating' && state.thinking && !message.content;
      if (message.reasoning || isThinking) {
        let details = article.querySelector('details');
        if (!details) { details = document.createElement('details'); const summary = document.createElement('summary'); summary.innerHTML = '<span class="la-braille" aria-hidden="true"></span><span>Thinking</span>'; const body = document.createElement('div'); body.className = 'la-reasoning'; details.append(summary, body); article.insertBefore(details, article.querySelector('.la-message-body')); }
        details.classList.toggle('is-thinking', isThinking);
        changed = this.updateBody(details.querySelector<HTMLElement>('.la-reasoning')!, message.reasoning ?? '', false) || changed;
      }
      const thinkingDetails = article.querySelector('details');
      if (thinkingDetails) { thinkingDetails.classList.toggle('is-thinking', isThinking); thinkingDetails.hidden = !message.reasoning && !isThinking; }
      const body = article.querySelector<HTMLElement>('.la-message-body')!;
      const placeholder = !message.content && message.role === 'assistant';
      body.hidden = placeholder && (!!message.reasoning || isThinking);
      body.classList.toggle('la-muted', placeholder);
      const content = placeholder ? state.phase === 'generating' ? 'Generating…' : 'No response generated.' : message.content;
      changed = this.updateBody(body, content, message.role === 'user' || placeholder) || changed;
    });
    if (!state.messages.length && transcript.childElementCount) { transcript.replaceChildren(); changed = true; }
    if (changed && this.stickToBottom) this.scrollToBottom();
    else if (changed) { transcript.scrollTop = previousScroll; this.el('[data-latest]').hidden = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48; }
  }
  private updateBody(body: HTMLElement, content: string, plain: boolean): boolean {
    if (body.dataset.source === content) return false;
    const selection = document.getSelection();
    if (body.contains(document.activeElement) || selection && !selection.isCollapsed && (body.contains(selection.anchorNode) || body.contains(selection.focusNode))) return false;
    body.dataset.source = content;
    if (plain) body.textContent = content; else body.replaceChildren(renderMarkdown(content));
    return true;
  }
  private resetObservation(): void {
    this.lastGenerated = undefined; this.promptTokens = undefined; this.contextTokens = [];
    this.observatory?.reset();
  }
  private collectObservation(state: AssistantState): void {
    if (!state.info || !state.messages.length) { this.resetObservation(); return; }
    this.observatory?.setLayers(state.info.layers);
    const observation = state.observation;
    if (observation.promptTokens && observation.promptTokens !== this.promptTokens) {
      this.promptTokens = observation.promptTokens;
      this.contextTokens = observation.promptTokens.slice();
      this.observatory?.setContext(this.contextTokens);
    }
    if (observation.stage === 'prefill') this.observatory?.setProgress(observation.promptProcessed ?? 0, observation.promptTotal);
    const { token, generated, pass } = observation;
    if (!token) return;
    const position = observation.contextUsed === undefined ? undefined : observation.contextUsed - 1;
    if (position !== undefined && Number.isInteger(position) && position >= 0 && position < state.info.context) this.contextTokens[position] = token;
    if (generated === undefined || pass === undefined || generated === this.lastGenerated) return;
    this.lastGenerated = generated;
    const queryPosition = observation.attention?.[0]?.queryPosition;
    const queryToken = queryPosition === undefined ? undefined : this.contextTokens[queryPosition];
    // Capture every native token before presentation throttling; timing-only updates
    // do not add columns or replace the measurements tied to that sampled token.
    this.observatory?.ingest({
      step: pass,
      sampled: { ...token, position },
      query: queryToken && queryPosition !== undefined ? { ...queryToken, position: queryPosition } : undefined,
      attention: observation.attention,
      deltas: observation.layerChanges?.map(reading => ({ layer: reading.layer, value: reading.relativeDelta })),
      lens: observation.lens?.map(checkpoint => ({ layer: checkpoint.layer,
        candidates: checkpoint.candidates.filter(candidate => candidate.id !== undefined).map((candidate, index) => ({
          id: candidate.id!, piece: candidate.piece, probability: candidate.probability, rank: index + 1,
        })),
      })),
      candidates: observation.candidates,
      layerCount: state.info.layers.length,
    });
  }
  private measureObservatory(): void { this.observatory?.resize(); }
  private renderObservation(state: AssistantState): void {
    const observation = state.observation;
    this.el('[data-context]').textContent = `${number(observation.contextUsed)}${state.info ? ` / ${state.info.context.toLocaleString()}` : ''}`;
    this.el('[data-speed]').textContent = number(observation.tokensPerSecond);
    this.el('[data-generated]').textContent = number(observation.generated);
    this.el('[data-prefill]').textContent = number(observation.promptMs, ' ms');
    this.observatory?.render();
  }
}
