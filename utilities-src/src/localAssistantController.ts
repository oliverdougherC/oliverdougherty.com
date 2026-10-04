import '../../css/local-assistant.css';
import { AssistantSession } from './local-assistant/session';
import { createAssistantRuntime } from './local-assistant/runtime';
import { SnakeGame } from './local-assistant/snake';
import { renderMarkdown } from './local-assistant/render';
import type { AssistantState, Runtime, Token } from './local-assistant/types';

const MODEL = 'Qwen3.5 · 2B';
const number = (value: number | undefined, suffix = '') => value !== undefined && Number.isFinite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}` : '—';
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
    this.root.innerHTML = `<header class="la-topbar"><div><span class="la-dot" aria-hidden="true"></span><strong>Local Assistant</strong><span class="la-device">ON YOUR DEVICE</span></div><button type="button" data-new>New chat <span aria-hidden="true">↗</span></button></header>
      <div class="la-workspace"><section class="la-conversation" aria-label="Conversation">
        <div class="la-welcome" data-welcome><div class="la-intro"><p class="la-eyebrow">SMALL MODEL. OPEN PROCESS.</p><h2>A small model.<br>A closer look.</h2><p>Prompts are processed in this browser.<br>Model downloads from Hugging Face.</p></div>
          <div class="la-loader"><div class="la-load-heading"><strong data-load-title>Preparing ${MODEL}</strong><span data-percent></span></div><progress aria-label="Model download" data-progress></progress><p data-load-status>Preparing the local model…</p><div class="la-loader-actions"><span class="la-model-spec">Q4_K_M · 1.28 GB download</span><button type="button" data-cancel>Cancel</button><button type="button" data-retry hidden>Retry</button><button type="button" class="la-primary" data-enter hidden>Enter chat <span aria-hidden="true">→</span></button></div></div>
          <div class="la-snake" data-snake><div class="la-snake-label"><span>A LITTLE SOMETHING ON THE SIDE</span><button type="button" data-play>Play Snake ↗</button><span data-score hidden>0</span></div><canvas width="420" height="120" tabindex="0" aria-label="Snake game. Focus to play with arrow keys or W A S D. Space restarts." data-canvas></canvas><p>Click the board, then use arrow keys or WASD. Space to restart.</p></div>
        </div>
        <div class="la-chat" data-chat hidden><div class="la-transcript" data-transcript role="region" aria-label="Chat transcript" tabindex="0"><div class="la-empty"><span class="la-star" aria-hidden="true">✳</span><h2>What’s on your mind?</h2><p>Ask, explore, or make something.</p><div class="la-suggestions"><button type="button" data-prompt="Explain how a language model predicts its next token.">How do you think? ↗</button><button type="button" data-prompt="Write a short poem about a quiet city at dawn.">Make something small ↗</button></div></div></div><button type="button" class="la-latest" data-latest hidden>Jump to latest ↓</button>
        <div class="la-chat-error" data-chat-error hidden><span data-chat-error-text></span><button type="button" data-chat-retry>Retry model</button></div><form class="la-composer" data-form><label class="la-sr" for="localAssistantPrompt">Message Local Assistant</label><textarea id="localAssistantPrompt" data-input rows="2" maxlength="16000" placeholder="Ask something…" autocomplete="off"></textarea><div class="la-composer-tools"><label class="la-thinking"><input type="checkbox" data-thinking><span>Thinking</span></label><span class="la-keyhint">↵ send · ⇧↵ newline</span><button type="button" data-stop hidden>Stop <span aria-hidden="true">■</span></button><button type="submit" class="la-send" data-send aria-label="Send message">↑</button></div></form><p class="la-disclaimer">Local models can make mistakes. Check important answers.</p></div>
      </section><aside class="la-observatory" aria-label="Model observatory"><div class="la-observatory-heading"><p class="la-eyebrow">MODEL OBSERVATORY</p><span data-live>WAITING</span></div><h3>${MODEL}</h3><p class="la-backend" data-backend>Hybrid architecture · WebGPU</p>
      <div class="la-metrics"><div><span>CONTEXT</span><strong data-context>—</strong></div><div><span>TOKENS / SEC</span><strong data-speed>—</strong></div><div><span>GENERATED</span><strong data-generated>—</strong></div><div><span>PREFILL</span><strong data-prefill>—</strong></div></div>
      <section class="la-observe-section"><h4>Token stream <span>LIVE IDS</span></h4><p class="la-token-label">PROMPT <span data-prompt-count></span></p><div class="la-tokens" data-prompt-tokens><span class="la-muted">Send a message to inspect tokens.</span></div><p class="la-token-label">GENERATED <span>LAST 8</span></p><div class="la-tokens" data-tokens><span class="la-muted">Waiting for inference.</span></div><p class="la-token-inspection" data-token-inspection>Choose a token to inspect its ID.</p></section>
      <section class="la-observe-section la-candidates"><h4>Next-token candidates <span>POST-SAMPLING</span></h4><div data-candidates><p class="la-muted">Available when the runtime reports probabilities.</p></div></section>
      <section class="la-observe-section la-layers-section"><h4>Layer map <span data-layer-label>MODEL METADATA</span></h4><div class="la-layers" data-layers></div><p class="la-legend"><span>■ DeltaNet</span><span>□ Attention</span><span data-layer-reading>No live layer readings</span></p></section>
      <p class="la-observe-note">Sampling: temperature 0.6 · top-k 20 · top-p 0.95.<br>Architecture is static. Activity is measured, never simulated.</p></aside></div><p class="la-sr" role="status" aria-live="polite" aria-atomic="true" data-announcement></p>`;
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
    if (target.hasAttribute('data-inspect-token')) { const reading = `ID ${target.dataset.tokenId} · ${JSON.stringify(target.dataset.tokenPiece)}`; this.el('[data-token-inspection]').textContent = reading; this.el('[data-token-inspection]').title = reading; }
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
      this.snake.start(); this.el('[data-canvas]').focus(); target.textContent = 'Resume Snake ↗';
    }
    if (target.hasAttribute('data-copy-code') || target.hasAttribute('data-copy-message')) {
      const source = target.hasAttribute('data-copy-code') ? target.closest('.la-code')?.querySelector('code')?.textContent : this.session.state.messages[Number(target.dataset.copyMessage)]?.content;
      try { await navigator.clipboard.writeText(source ?? ''); this.announce('Copied to clipboard.'); }
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
    this.frame = requestAnimationFrame(() => { const transcript = this.el('[data-transcript]'); transcript.scrollTop = transcript.scrollHeight; this.el('[data-latest]').hidden = true; });
  }
  private render(state: AssistantState): void {
    const chat = state.entered && !!state.info;
    this.el('[data-chat-error]').hidden = state.phase !== 'error';
    this.el('[data-chat-error-text]').textContent = state.status;
    this.root.dataset.phase = state.phase;
    this.el('[data-welcome]').hidden = chat; this.el('[data-chat]').hidden = !chat;
    this.el<HTMLButtonElement>('[data-new]').disabled = !chat;
    this.el('[data-enter]').hidden = state.phase !== 'ready';
    this.el('[data-retry]').hidden = !['error', 'idle'].includes(state.phase);
    this.el('[data-cancel]').hidden = state.phase !== 'loading';
    this.el('[data-load-title]').textContent = state.phase === 'ready' ? 'MODEL READY' : state.phase === 'unsupported' ? 'A browser with WebGPU is needed' : state.phase === 'error' ? 'The model couldn’t start' : state.phase === 'idle' ? 'Your model is paused' : `Preparing ${MODEL}`;
    this.el('[data-load-status]').textContent = state.phase === 'unsupported' ? state.status : state.phase === 'ready' ? 'Your model is ready. Finish your game or enter chat.' : state.status;
    const progress = this.el<HTMLProgressElement>('[data-progress]'); progress.hidden = state.phase !== 'loading';
    if (state.total && state.total > 0) { progress.max = state.total; progress.value = Math.min(state.loaded, state.total); }
    else progress.removeAttribute('value');
    this.el('[data-percent]').textContent = state.phase === 'loading' ? state.total ? `${Math.floor(state.loaded / state.total * 100)}% · ${bytes(state.loaded)} / ${bytes(state.total)}` : state.loaded ? bytes(state.loaded) : '' : '';
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
    if (state.messages.length) transcript.querySelector('.la-empty')?.remove();
    for (const article of transcript.querySelectorAll<HTMLElement>('[data-message-index]')) {
      if (Number(article.dataset.messageIndex) >= state.messages.length) { article.remove(); changed = true; }
    }
    state.messages.forEach((message, index) => {
      let article = transcript.querySelector<HTMLElement>(`[data-message-index="${index}"]`);
      if (!article) {
        article = document.createElement('article'); article.dataset.messageIndex = String(index); article.className = `la-message la-message--${message.role}`;
        const heading = document.createElement('div'); heading.className = 'la-message-heading';
        const role = document.createElement('span'); role.textContent = message.role === 'user' ? 'YOU' : 'LOCAL ASSISTANT'; heading.append(role);
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
      body.classList.toggle('la-muted', placeholder);
      const content = placeholder ? state.phase === 'generating' ? 'Thinking…' : 'No response generated.' : message.content;
      changed = this.updateBody(body, content, message.role === 'user' || placeholder) || changed;
    });
    if (!state.messages.length && !transcript.querySelector('.la-empty')) { const empty = document.createElement('div'); empty.className = 'la-empty'; const title = document.createElement('h2'); title.textContent = 'A fresh conversation.'; const text = document.createElement('p'); text.textContent = 'What would you like to explore?'; empty.append(title, text); transcript.replaceChildren(empty); changed = true; }
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
    this.el('[data-layer-reading]').textContent = reading ? `L${reading.layer + 1} ${kind}: RMS ${number(reading.rms)} · ${number(reading.milliseconds, ' ms')}` : index === undefined ? 'Choose a layer to inspect it.' : `L${index + 1} ${kind}: no live reading`;
    this.el('[data-layer-label]').textContent = readings?.length ? 'LIVE READINGS' : 'MODEL METADATA';
  }
  private collectTokens(state: AssistantState): void {
    if (!state.info || !state.messages.length) {
      this.generatedTokens.length = 0; this.lastToken = undefined; this.lastGenerated = undefined;
      this.el('[data-token-inspection]').textContent = 'Choose a token to inspect its ID.';
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
    this.el('[data-live]').textContent = state.phase === 'generating' ? 'INFERENCE' : state.phase === 'ready' ? 'READY' : state.phase === 'loading' ? 'LOADING' : 'WAITING';
    this.el('[data-backend]').textContent = state.info?.backend ?? 'Hybrid architecture · WebGPU';
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
        if (!chip) { chip = document.createElement('button'); chip.type = 'button'; chip.className = 'la-token'; chip.dataset.inspectToken = ''; chip.append(document.createElement('span'), document.createElement('small')); container.append(chip); }
        chip.dataset.tokenId = String(value.id); chip.dataset.tokenPiece = value.piece;
        chip.setAttribute('aria-label', `Inspect token ${value.id}: ${value.piece}`);
        chip.title = `Token ${value.id}: ${value.piece}`;
        chip.children[0].textContent = value.piece.replace(/\n/g, '↵') || '∅'; chip.children[1].textContent = String(value.id);
      });
    };
    renderTokens('[data-prompt-tokens]', observation.promptTokens?.slice(-8) ?? [], 'Send a message to inspect tokens.');
    renderTokens('[data-tokens]', this.generatedTokens, 'Waiting for inference.');
    this.el('[data-prompt-count]').textContent = observation.promptTokens?.length ? `LAST ${Math.min(8, observation.promptTokens.length)} / ${observation.promptTokens.length}` : '';
    const candidates = this.el('[data-candidates]'); candidates.replaceChildren();
    if (!observation.candidates?.length) { const empty = document.createElement('p'); empty.className = 'la-muted'; empty.textContent = 'Probabilities not reported by this runtime.'; candidates.append(empty); }
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
      if (!metadata.length) { const empty = document.createElement('span'); empty.className = 'la-muted'; empty.textContent = 'Architecture appears after model load.'; layers.append(empty); }
    }
    for (const layer of layers.querySelectorAll<HTMLElement>('[data-inspect-layer]')) {
      const index = Number(layer.dataset.inspectLayer); const measured = observation.layers?.find((value) => value.layer === index);
      layer.title = `Layer ${index + 1} · ${metadata[index]}${measured ? ` · RMS ${number(measured.rms)} · ${number(measured.milliseconds, ' ms')}` : ' · static architecture metadata'}`;
      layer.classList.toggle('has-reading', !!measured && (measured.rms !== undefined || measured.milliseconds !== undefined));
      layer.setAttribute('aria-pressed', String(this.selectedLayer === index));
    }
    this.renderLayerReading(state);
  }
}
