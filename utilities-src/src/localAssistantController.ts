import '../../css/local-assistant.css';
import { AssistantSession } from './local-assistant/session';
import { createAssistantRuntime } from './local-assistant/runtime';
import { SnakeGame } from './local-assistant/snake';
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
  private layerMetadata = '';
  private selectedLayer: number | null = null;
  private frame = 0;
  private copyFeedback: { button: HTMLButtonElement; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly generatedTokens: Token[] = [];
  private lastToken?: Token;
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
        <h2>Qwen3.5<span>2B</span></h2>
        <div class="la-loader"><div class="la-load-heading"><strong data-load-title>Loading model</strong><span data-percent></span></div>
          <progress aria-label="Model download" data-progress></progress><p data-load-status>Preparing local inference…</p>
          <div class="la-loader-actions"><span class="la-model-spec">Weights from Hugging Face</span><button type="button" data-cancel>Cancel</button><button type="button" data-retry hidden>Retry</button><button type="button" class="la-primary" data-enter hidden>Enter chat ↗</button></div>
        </div>
        <div class="la-snake" data-snake><div class="la-snake-label"><button type="button" data-play>Play Snake ↗</button><span data-score hidden>0</span></div><canvas width="420" height="120" tabindex="0" aria-label="Snake game. Arrow keys or WASD to move; Space to restart." data-canvas></canvas><p>Arrow keys / WASD · Space to restart</p></div>
      </div>
      <div class="la-chat" data-chat hidden>
        <div class="la-transcript-wrap"><div class="la-transcript" data-transcript role="region" aria-label="Chat transcript" tabindex="0"></div><button type="button" class="la-latest" data-latest hidden>Latest ↓</button></div>
        <div class="la-chat-error" data-chat-error hidden><span data-chat-error-text></span><button type="button" data-chat-retry>Reload model</button></div>
        <form class="la-composer" data-form><label class="la-sr" for="localAssistantPrompt">Message Local Assistant</label><textarea id="localAssistantPrompt" data-input rows="1" maxlength="16000" placeholder="Message…" aria-description="Enter to send. Shift+Enter for a new line." autocomplete="off"></textarea><div class="la-composer-tools"><label class="la-thinking"><input type="checkbox" data-thinking><span>Thinking</span></label><button type="button" data-new>New chat</button><button type="button" class="la-primary" data-stop hidden>Stop</button><button type="submit" class="la-primary" data-send>Send ↗</button></div></form>
      </div>
      </section><aside class="la-observatory" aria-label="Model observatory" hidden>
        <h2>Qwen3.5 <span>2B</span></h2>
        <div class="la-metrics"><div><span>Context</span><strong data-context>—</strong></div><div><span>Tokens / s</span><strong data-speed>—</strong></div><div><span>Generated</span><strong data-generated>—</strong></div><div><span>Prompt time</span><strong data-prefill>—</strong></div></div>
        <section class="la-observe-section"><h3>Tokens <span class="la-window-label">Latest 8</span></h3><div class="la-token-row"><span class="la-token-label">Prompt</span><div class="la-tokens" data-prompt-tokens aria-label="Prompt tokens"></div></div><div class="la-token-row"><span class="la-token-label">Output</span><div class="la-tokens" data-tokens aria-label="Generated tokens"></div></div><p class="la-token-inspection" data-token-inspection hidden></p></section>
        <section class="la-observe-section la-candidates"><h3 aria-description="Post-sampling probabilities. Temperature 0.6, top-k 20, top-p 0.95.">Next token</h3><div data-candidates></div></section>
        <section class="la-observe-section la-layers-section"><h3>Layers</h3><div class="la-layers" data-layers></div><div class="la-layer-footer"><p class="la-legend"><span>■ DeltaNet</span><span>□ Attention</span></p><p data-layer-reading hidden></p></div></section>
      </aside></div><p class="la-sr" role="status" aria-live="polite" aria-atomic="true" data-announcement></p>`;
    const signal = this.events.signal;
    const listen = (target: EventTarget, type: string, callback: EventListener) => target.addEventListener(type, callback, { signal });
    listen(this.root, 'click', (event) => { void this.click(event); });
    listen(this.el('[data-form]'), 'submit', (event) => { event.preventDefault(); this.send(); });
    listen(this.el('[data-input]'), 'keydown', (event) => {
      const key = event as KeyboardEvent;
      if (key.key === 'Enter' && !key.shiftKey && !key.isComposing) { event.preventDefault(); this.send(); }
    });
    listen(this.el('[data-input]'), 'input', () => { this.session.touchActivity(); this.updateSend(); });
    listen(this.el('[data-canvas]'), 'keydown', () => this.session.touchActivity());
    listen(this.el('[data-canvas]'), 'snake-reset', () => this.announce('Snake restarted to fit the resized board.'));
    listen(this.el('[data-thinking]'), 'change', () => this.session.setThinking(this.el<HTMLInputElement>('[data-thinking]').checked));
    listen(this.el('[data-transcript]'), 'scroll', () => {
      if (this.session.state.active) this.session.touchActivity();
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
      this.collectTokens(state);
      this.root.dataset.phase = state.phase;
      if (!state.active) {
        if (this.renderTimer) clearTimeout(this.renderTimer);
        this.renderTimer = null; cancelAnimationFrame(this.frame);
        return;
      }
      if (state.phase === 'generating' && this.renderedPhase === 'generating') {
        this.renderTimer ??= setTimeout(() => { this.renderTimer = null; this.render(this.session.state); }, 50);
      } else { if (this.renderTimer) clearTimeout(this.renderTimer); this.renderTimer = null; this.render(state); }
    });
    void this.session.activate();
  }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    if (this.copyFeedback) clearTimeout(this.copyFeedback.timer);
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
    if (target.hasAttribute('data-inspect-token')) { this.el('[data-token-inspection]').hidden = false; const reading = `ID ${target.dataset.tokenId} · ${JSON.stringify(target.dataset.tokenPiece)}`; this.el('[data-token-inspection]').textContent = reading; this.el('[data-token-inspection]').title = reading; }
    if (target.hasAttribute('data-inspect-layer')) { this.selectedLayer = Number(target.dataset.inspectLayer); this.renderLayerReading(this.session.state); }
    if (target.hasAttribute('data-enter')) { this.snake?.stop(); this.session.enterChat(); this.el('[data-input]').focus(); }
    if (target.hasAttribute('data-retry') || target.hasAttribute('data-chat-retry')) { if (!this.session.state.active) void this.session.activate(); else void this.session.retry(); }
    if (target.hasAttribute('data-cancel')) void this.session.unload();
    if (target.hasAttribute('data-stop')) this.session.stop();
    if (target.hasAttribute('data-new')) { this.generatedTokens.length = 0; this.lastToken = undefined; this.lastGenerated = undefined; await this.session.reset(); this.stickToBottom = true; this.el('[data-input]').focus(); }
    if (target.hasAttribute('data-latest')) { this.stickToBottom = true; this.scrollToBottom(); }
    if (target.hasAttribute('data-prompt')) { this.el<HTMLTextAreaElement>('[data-input]').value = target.dataset.prompt!; this.send(); }
    if (target.hasAttribute('data-play')) {
      this.snake ??= new SnakeGame(this.el<HTMLCanvasElement>('[data-canvas]'), (score) => { this.el('[data-score]').textContent = String(score); });
      this.el('[data-snake]').classList.add('is-playing'); this.el('[data-score]').hidden = false;
      this.snake.start(); this.el('[data-canvas]').focus(); target.textContent = 'Snake ↗';
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
    this.generatedTokens.length = 0; this.lastToken = undefined; this.lastGenerated = undefined;
    void this.session.send(text);
  }
  private updateSend(): void {
    this.el<HTMLButtonElement>('[data-send]').disabled = this.session.state.phase !== 'ready' || !this.el<HTMLTextAreaElement>('[data-input]').value.trim();
  }
  private scrollToBottom(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => { if (!this.stickToBottom) return; const transcript = this.el('[data-transcript]'); transcript.scrollTop = transcript.scrollHeight; this.el('[data-latest]').hidden = true; });
  }
  private render(state: AssistantState): void {
    const chat = state.entered && !!state.info;
    this.el('[data-chat-error]').hidden = state.phase !== 'error';
    this.el('[data-chat-error-text]').textContent = state.status;
    this.root.dataset.phase = state.phase;
    this.root.classList.toggle('is-chat', chat);
    this.el('[data-welcome]').hidden = chat; this.el('[data-chat]').hidden = !chat;
    this.el('.la-observatory').hidden = !chat;
    this.el<HTMLButtonElement>('[data-new]').disabled = !chat;
    this.el('[data-enter]').hidden = state.phase !== 'ready';
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
    this.el<HTMLInputElement>('[data-thinking]').disabled = state.phase === 'generating';
    this.updateSend();
    this.renderedPhase = state.phase;
    this.renderMessages(state);
    this.renderObservation(state);
    const announcement = state.phase === 'generating' ? 'Generating response.' : state.phase === 'ready' && state.messages.length ? state.status === 'Generation stopped.' ? 'Generation stopped.' : 'Response complete.' : state.phase === 'ready' ? 'Model ready. Choose Enter chat when you are ready.' : state.phase === 'loading' ? 'Loading the local model.' : state.status;
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
      if (message.reasoning) {
        let details = article.querySelector('details');
        if (!details) { details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Thinking'; const body = document.createElement('div'); body.className = 'la-reasoning'; details.append(summary, body); article.insertBefore(details, article.querySelector('.la-message-body')); }
        changed = this.updateBody(details.querySelector<HTMLElement>('.la-reasoning')!, message.reasoning, false) || changed;
      }
      const body = article.querySelector<HTMLElement>('.la-message-body')!;
      const placeholder = !message.content && message.role === 'assistant';
      body.hidden = placeholder && !!message.reasoning;
      body.classList.toggle('la-muted', placeholder);
      const content = placeholder ? state.phase === 'generating' ? 'Generating…' : 'No response generated.' : message.content;
      changed = this.updateBody(body, content, message.role === 'user' || placeholder) || changed;
    });
    if (!state.messages.length && transcript.childElementCount) { transcript.replaceChildren(); changed = true; }
    if (changed && this.stickToBottom) this.scrollToBottom();
    else if (changed) transcript.scrollTop = previousScroll;
  }
  private updateBody(body: HTMLElement, content: string, plain: boolean): boolean {
    if (body.dataset.source === content) return false;
    const selection = document.getSelection();
    if (body.contains(document.activeElement) || selection && !selection.isCollapsed && (body.contains(selection.anchorNode) || body.contains(selection.focusNode))) return false;
    body.dataset.source = content;
    if (plain) body.textContent = content; else body.replaceChildren(renderMarkdown(content));
    return true;
  }
  private renderLayerReading(state: AssistantState): void {
    for (const layer of this.root.querySelectorAll<HTMLElement>('[data-inspect-layer]')) layer.setAttribute('aria-pressed', String(this.selectedLayer === Number(layer.dataset.inspectLayer)));
    const readings = state.observation.layers;
    const reading = this.selectedLayer === null ? readings?.slice().reverse().find((layer) => layer.rms !== undefined || layer.milliseconds !== undefined) : readings?.find((layer) => layer.layer === this.selectedLayer);
    const index = this.selectedLayer ?? reading?.layer;
    const kind = index === undefined ? '' : state.info?.layers[index] ?? '';
    const label = index === undefined ? '' : reading ? `${index + 1}` : `${index + 1} · ${kind === 'attention' ? 'Attention' : 'DeltaNet'}`;
    const values = reading ? [reading.rms === undefined ? '' : `RMS ${number(reading.rms, '', 3)}`, reading.milliseconds === undefined ? '' : number(reading.milliseconds, ' ms')].filter(Boolean).join(' · ') : '';
    this.el('[data-layer-reading]').textContent = [label, values].filter(Boolean).join(' · ');
    this.el('[data-layer-reading]').hidden = !label;

  }
  private collectTokens(state: AssistantState): void {
    if (!state.info || !state.messages.length) {
      this.generatedTokens.length = 0; this.lastToken = undefined; this.lastGenerated = undefined;
      this.el('[data-token-inspection]').textContent = '';
      this.el('[data-token-inspection]').hidden = true;
      this.el('[data-token-inspection]').removeAttribute('title');
      return;
    }
    const { token, generated } = state.observation;
    if (!token) return;
    // Record every runtime callback before the presentation throttle. Final timing
    // updates may repeat the final token with a new object but the same token count.
    const fresh = generated !== undefined ? generated !== this.lastGenerated : token !== this.lastToken;
    if (!fresh) return;
    this.generatedTokens.push(token);
    if (this.generatedTokens.length > 8) this.generatedTokens.shift();
    this.lastToken = token; this.lastGenerated = generated;
  }
  private renderObservation(state: AssistantState): void {
    const observation = state.observation;
    this.el('[data-context]').textContent = `${number(observation.contextUsed)}${state.info ? ` / ${state.info.context.toLocaleString()}` : ''}`;
    this.el('[data-speed]').textContent = number(observation.tokensPerSecond);
    this.el('[data-generated]').textContent = number(observation.generated);
    this.el('[data-prefill]').textContent = number(observation.promptMs, ' ms');
    const token = observation.token;
    const renderTokens = (selector: string, tokens: Token[], empty: string) => {
      const container = this.el(selector);
      if (!tokens.length) { if (!container.querySelector('.la-muted')) { const span = document.createElement('span'); span.className = 'la-muted'; span.textContent = empty; container.replaceChildren(span); } return; }
      container.querySelector('.la-muted')?.remove();
      while (container.children.length > tokens.length) container.lastElementChild?.remove();
      tokens.forEach((value, index) => {
        let chip = container.children[index] as HTMLButtonElement | undefined;
        if (!chip) { chip = document.createElement('button'); chip.type = 'button'; chip.className = 'la-token'; chip.dataset.inspectToken = ''; chip.append(document.createElement('span')); container.append(chip); }
        chip.dataset.tokenId = String(value.id); chip.dataset.tokenPiece = value.piece;
        chip.setAttribute('aria-label', `Inspect token ${value.id}: ${value.piece}`);
        chip.title = `Token ${value.id}: ${value.piece}`;
        chip.children[0].textContent = value.piece.replace(/\n/g, '↵') || '∅';
      });
    };
    renderTokens('[data-prompt-tokens]', observation.promptTokens?.slice(-8) ?? [], '—');
    renderTokens('[data-tokens]', this.generatedTokens, '—');
    const candidates = this.el('[data-candidates]'); candidates.replaceChildren();
    if (!observation.candidates?.length) { const empty = document.createElement('p'); empty.className = 'la-muted'; empty.textContent = '—'; candidates.append(empty); }
    const visibleCandidates = observation.candidates?.slice(0, 3) ?? [];
    const selected = observation.candidates?.find((candidate) => token && (candidate.id !== undefined ? candidate.id === token.id : candidate.piece === token.piece));
    if (selected && !visibleCandidates.includes(selected)) visibleCandidates[2] = selected;
    for (const candidate of visibleCandidates) { const row = document.createElement('div'); row.className = 'la-candidate'; const chosen = !!token && (candidate.id !== undefined ? candidate.id === token.id : candidate.piece === token.piece); const name = document.createElement('span'); name.textContent = `${chosen ? '✓ ' : ''}${candidate.piece || (candidate.id === undefined ? '∅' : `#${candidate.id}`)}`; name.title = candidate.id === undefined ? candidate.piece : `${candidate.piece} · ID ${candidate.id}`; const probability = document.createElement('span'); probability.textContent = number(candidate.probability * 100, '%'); row.style.setProperty('--probability', `${Math.max(0, Math.min(1, candidate.probability)) * 100}%`); row.append(name, probability); candidates.append(row); }
    const layers = this.el('[data-layers]');
    const metadata = state.info?.layers ?? [];
    const metadataKey = metadata.join(',');
    if (metadataKey !== this.layerMetadata || !layers.children.length) {
      this.layerMetadata = metadataKey; layers.replaceChildren();
      for (let index = 0; index < metadata.length; index++) { const layer = document.createElement('button'); layer.type = 'button'; layer.className = `la-layer la-layer--${metadata[index]}`; layer.dataset.inspectLayer = String(index); layer.textContent = String(index + 1); layer.setAttribute('aria-label', `Inspect layer ${index + 1}, ${metadata[index]}`); layers.append(layer); }
      if (!metadata.length) { const empty = document.createElement('span'); empty.className = 'la-muted'; empty.textContent = '—'; layers.append(empty); }
    }
    for (const layer of layers.querySelectorAll<HTMLElement>('[data-inspect-layer]')) {
      const index = Number(layer.dataset.inspectLayer); const measured = observation.layers?.find((value) => value.layer === index);
      layer.title = `Layer ${index + 1} · ${metadata[index]}${measured?.rms === undefined ? '' : ` · RMS ${number(measured.rms, '', 3)}`}${measured?.milliseconds === undefined ? '' : ` · ${number(measured.milliseconds, ' ms')}`}`;
      layer.classList.toggle('has-reading', !!measured && (measured.rms !== undefined || measured.milliseconds !== undefined));
      layer.setAttribute('aria-pressed', String(this.selectedLayer === index));
    }
    this.renderLayerReading(state);
  }
}
