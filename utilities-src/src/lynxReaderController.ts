import { DEFAULT_PAUSES, normalizedDwells, parseText, ReaderScheduler, sentenceTarget, type ReadingUnit } from './lynxReaderCore';

const DEFAULT_TEXT = `Our refusal to leave the world as we found it does not always produce cathedrals, symphonies, or footprints on the moon. Usually it produces something so small that history doesn't even notice.

Perhaps the most beautiful song ever sung really was sung by a little Grecian girl to her cat. Maybe she sat with it curled against her side, running her fingers through its fur as she quietly made up a melody just for the two of them. The cat purrs beside her as she looks out over the sea, singing to her companion for no reason beyond love. Content with the moment, she thinks nothing of it. Why would she? To make something where there was nothing before is simply in her nature. There was no audience waiting to applaud her, no one nearby to write down the notes, no thought that the song ought to survive the afternoon. For those few minutes, there was only the girl, her cat, and the little pocket of peace they had made for each other.

To the cat, their world was already complete. The girl made it more beautiful anyway. The scale changes, but the instinct does not. Sometimes that instinct makes a song. Sometimes it sends us over the horizon.

So, if you want to build a ship, don't drum up the men to gather wood, divide the work, and give orders. Instead, teach them to dream about whatever could be just over the horizon. The mind will do the rest.`;

export class LynxReaderController {
  private units: ReadingUnit[] = [];
  private dwells: number[] = [];
  private index = 0;
  private wpm = 300;
  private pauses = { ...DEFAULT_PAUSES };
  private wordSize = 88;
  private wheelDelta = 0;
  private playing = false;
  private finished = false;
  private initialized = false;
  private active = true;
  private startedAt = 0;
  private remaining = 1;
  private scheduler = new ReaderScheduler();
  private events = new AbortController();
  private resize?: ResizeObserver;

  constructor(private root: HTMLElement) {}
  private el<T extends HTMLElement = HTMLElement>(name: string): T {
    return this.root.querySelector<T>(`[data-lynx-${name}]`)!;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.active = !this.root.closest<HTMLElement>('[data-utility-id]')?.hidden;
    this.root.innerHTML = `
      <div class="lynx-entry" data-lynx-entry>
        <label class="control-label" for="lynxSource">Text to read</label>
        <textarea id="lynxSource" data-lynx-source placeholder="Paste your text here." spellcheck="false"></textarea>
        <div class="lynx-entry-actions"><button class="btn-primary-minimal" data-lynx-read>Read</button></div>
      </div>
      <div class="lynx-reader" data-lynx-reader hidden>
        <div class="lynx-topline"><span data-lynx-status role="status">Paused</span><button class="btn-secondary-minimal" data-lynx-edit>Change Text</button></div>
        <div class="lynx-display" data-lynx-display tabindex="0" aria-label="Reading word" aria-keyshortcuts="Space ArrowLeft ArrowRight">
          <div class="lynx-guide" aria-hidden="true"></div>
          <div class="lynx-word" data-lynx-word role="img" aria-label="">
            <span class="lynx-focus" data-lynx-focus aria-hidden="true"><span class="lynx-before" data-lynx-before></span><span data-lynx-letter></span><span class="lynx-after" data-lynx-after></span></span>
          </div>
        </div>
        <div class="lynx-controls">
          <label class="lynx-speed" for="lynxWpm"><span class="control-label">Target WPM</span><output data-lynx-speed for="lynxWpm">300</output><input id="lynxWpm" data-lynx-wpm type="range" min="100" max="1000" step="25" value="300"></label>
          <div class="lynx-transport"><button class="btn-secondary-minimal" data-lynx-back aria-label="Previous sentence">← Sentence</button><button class="btn-primary-minimal" data-lynx-play aria-pressed="false" aria-keyshortcuts="Space">Play</button><button class="btn-secondary-minimal" data-lynx-forward aria-label="Next sentence">Sentence →</button><button class="btn-secondary-minimal" data-lynx-reset>Reset</button></div>
          <div class="lynx-preferences">
            <label for="lynxComma"><span class="control-label">Comma pause <output data-lynx-comma-value for="lynxComma">+22%</output></span><input id="lynxComma" data-lynx-comma type="range" min="0" max="200" step="1" value="22" aria-describedby="lynxPauseHelp"></label>
            <label for="lynxPeriod"><span class="control-label">Sentence pause <output data-lynx-period-value for="lynxPeriod">+65%</output></span><input id="lynxPeriod" data-lynx-period type="range" min="0" max="200" step="1" value="65" aria-describedby="lynxPauseHelp"></label>
            <label for="lynxFont"><span class="control-label">Word font</span><select id="lynxFont" data-lynx-font class="control-select-minimal"><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select></label>
            <label for="lynxSize"><span class="control-label">Word size <output data-lynx-size-value for="lynxSize">88 px</output></span><input id="lynxSize" data-lynx-size type="range" min="32" max="144" step="4" value="88"></label>
          </div>
          <p class="lynx-hint" id="lynxPauseHelp">Adjust pauses at commas and sentence endings. Target WPM includes pauses.</p>
          <p class="lynx-hint">Space: play / pause · ← / →: sentence · Scroll ↑ / ↓: faster / slower</p>
          <div class="lynx-progress"><label class="control-label" for="lynxPosition">Position</label><span data-lynx-position></span><input id="lynxPosition" data-lynx-seek type="range" min="0" max="0" value="0" step="1" aria-label="Reading position"></div>
        </div>
      </div>`;
    this.el<HTMLTextAreaElement>('source').value = DEFAULT_TEXT;
    const on = (target: EventTarget, type: string, handler: EventListener) => target.addEventListener(type, handler, { signal: this.events.signal });
    on(this.el('source'), 'input', () => { this.el<HTMLButtonElement>('read').disabled = !this.el<HTMLTextAreaElement>('source').value.trim(); });
    on(this.el('read'), 'click', () => this.read());
    on(this.el('play'), 'click', () => this.toggle());
    on(this.el('back'), 'click', () => this.jumpSentence(-1));
    on(this.el('forward'), 'click', () => this.jumpSentence(1));
    on(this.el('reset'), 'click', () => this.seek(0));
    on(this.el('edit'), 'click', () => {
      this.pause();
      this.el('reader').hidden = true;
      this.el('entry').hidden = false;
      this.el('source').focus();
    });
    on(this.el('seek'), 'pointerdown', () => this.pause());
    on(this.el('seek'), 'input', () => this.seek(Number(this.el<HTMLInputElement>('seek').value)));
    on(this.el('wpm'), 'input', () => this.changeWpm(Number(this.el<HTMLInputElement>('wpm').value)));
    for (const [name, boundary] of [['comma', 'clause'], ['period', 'sentence']] as const) {
      on(this.el(name), 'input', () => {
        this.updateTiming(() => { this.pauses[boundary] = Number(this.el<HTMLInputElement>(name).value) / 100; });
        this.el(`${name}-value`).textContent = `+${Math.round(this.pauses[boundary] * 100)}%`;
      });
    }
    on(this.el('font'), 'change', () => {
      const fonts: Record<string, string> = { sans: 'var(--workbench-ui)', serif: 'Georgia, serif', mono: "'JetBrains Mono', monospace" };
      this.el('word').style.fontFamily = fonts[this.el<HTMLSelectElement>('font').value];
      this.fitWord();
    });
    on(this.el('size'), 'input', () => {
      this.wordSize = Number(this.el<HTMLInputElement>('size').value);
      this.el('size-value').textContent = `${this.wordSize} px`;
      this.root.style.setProperty('--lynx-word-size', `${this.wordSize}px`);
      this.fitWord();
    });
    document.addEventListener('wheel', event => this.wheel(event), { passive: false, signal: this.events.signal });
    on(document, 'keydown', event => this.key(event as KeyboardEvent));
    on(this.root, 'utility-deactivate', () => { this.active = false; this.pause(); });
    on(this.root, 'utility-activate', () => { this.active = true; this.fitWord(); });
    on(document, 'visibilitychange', () => { if (document.hidden) this.pause(); });
    on(window, 'pagehide', () => this.pause());
    this.resize = new ResizeObserver(() => this.fitWord());
    this.resize.observe(this.el('display'));
    void document.fonts?.ready.then(() => { if (!this.events.signal.aborted) this.fitWord(); });
  }

  private read() {
    this.pause();
    this.units = parseText(this.el<HTMLTextAreaElement>('source').value);
    if (!this.units.length) {
      this.el<HTMLButtonElement>('read').disabled = true;
      this.el('source').focus();
      return;
    }
    this.dwells = normalizedDwells(this.units, this.wpm, this.pauses);
    this.el('entry').hidden = true;
    this.el('reader').hidden = false;
    this.seek(0);
    this.el('display').focus();
  }

  private key(event: KeyboardEvent) {
    if (!this.active || this.el('reader').hidden || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('textarea, input:not([type="range"]), [contenteditable]:not([contenteditable="false"])')) return;
    if (!['Space', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (event.code === 'Space') this.toggle();
    else this.jumpSentence(event.code === 'ArrowLeft' ? -1 : 1);
  }

  private jumpSentence(direction: -1 | 1) {
    this.seek(sentenceTarget(this.units, this.index, direction));
  }

  private updateTiming(update: () => void) {
    if (this.playing) this.remaining = Math.max(0, this.remaining - (performance.now() - this.startedAt) / this.dwells[this.index]);
    update();
    this.dwells = normalizedDwells(this.units, this.wpm, this.pauses);
    if (this.playing) this.schedule();
  }

  private changeWpm(value: number) {
    this.updateTiming(() => { this.wpm = Math.max(100, Math.min(1000, value)); });
    this.el<HTMLInputElement>('wpm').value = String(this.wpm);
    this.el('speed').textContent = String(this.wpm);
  }

  private wheel(event: WheelEvent) {
    if (!this.active || this.el('reader').hidden || event.defaultPrevented || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.root.clientHeight : 1);
    if (Math.sign(delta) !== Math.sign(this.wheelDelta)) this.wheelDelta = 0;
    this.wheelDelta += delta;
    if (Math.abs(this.wheelDelta) < 40) return;
    this.changeWpm(this.wpm + (this.wheelDelta < 0 ? 25 : -25));
    this.wheelDelta = 0;
  }

  private toggle() {
    if (this.playing) { this.pause(); return; }
    if (!this.active || !this.units.length) return;
    if (this.finished) this.index = 0;
    this.finished = false;
    this.playing = true;
    this.remaining = 1;
    this.render();
    this.schedule();
  }

  private schedule() {
    this.startedAt = performance.now();
    this.scheduler.schedule(this.dwells[this.index] * this.remaining, () => {
      if (!this.playing || !this.active) return;
      if (this.index === this.units.length - 1) {
        this.finished = true;
        this.pause();
        return;
      }
      this.index += 1;
      this.remaining = 1;
      this.render();
      this.schedule();
    });
  }

  private pause() {
    this.scheduler.cancel();
    this.playing = false;
    if (this.initialized) this.render();
  }

  private seek(index: number) {
    this.scheduler.cancel();
    this.playing = false;
    this.finished = false;
    this.index = Math.max(0, Math.min(this.units.length - 1, index));
    this.render();
  }

  private render() {
    this.el('play').textContent = this.playing ? 'Pause' : this.finished ? 'Replay' : 'Play';
    this.el('play').setAttribute('aria-pressed', String(this.playing));
    const state = this.playing ? 'Reading' : this.finished ? 'Finished' : 'Paused';
    if (this.el('status').textContent !== state) this.el('status').textContent = state;
    const unit = this.units[this.index];
    if (!unit) return;
    this.el('word').setAttribute('aria-label', unit.text);
    this.el('before').textContent = unit.before;
    this.el('letter').textContent = unit.focus;
    this.el('after').textContent = unit.after;
    const position = `${this.index + 1} / ${this.units.length}`;
    this.el('position').textContent = position;
    const seek = this.el<HTMLInputElement>('seek');
    seek.max = String(this.units.length - 1);
    seek.value = String(this.index);
    seek.setAttribute('aria-valuetext', `Word ${this.index + 1} of ${this.units.length}`);
    this.fitWord();
  }

  private fitWord() {
    if (!this.units.length || this.el('reader').hidden || !this.active) return;
    const focus = this.el('focus');
    focus.style.setProperty('--lynx-scale', '1');
    const display = this.el('display');
    const baseFont = parseFloat(getComputedStyle(this.el('word')).fontSize) || 64;
    const halfWidth = display.clientWidth / 2 - 24;
    const extent = Math.max(this.el('before').offsetWidth, this.el('after').offsetWidth) + this.el('letter').offsetWidth / 2;
    // Fit is bidirectional: long tokens shrink, short tokens grow up to the
    // chosen word size or the reading-stage height, whichever
    // binds first, so no word reads as a page title.
    const widthScale = Math.max(0, halfWidth) / Math.max(1, extent);
    const heightScale = Math.max(0, display.clientHeight - 16) / (1.3 * baseFont);
    focus.style.setProperty('--lynx-scale', String(Math.min(this.wordSize / baseFont, heightScale, widthScale)));
  }

  destroy() {
    this.scheduler.cancel();
    this.events.abort();
    this.resize?.disconnect();
  }
}
