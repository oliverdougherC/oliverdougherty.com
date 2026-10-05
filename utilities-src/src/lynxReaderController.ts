import { normalizedDwells, parseText, ReaderScheduler, type ReadingUnit } from './lynxReaderCore';

const DEFAULT_TEXT = `Our refusal to leave the world as we found it does not always produce cathedrals, symphonies, or footprints on the moon. Usually it produces something so small that history doesn't even notice.

Perhaps the most beautiful song ever sung really was sung by a little Grecian girl to her cat. Maybe she sat with it curled against her side, running her fingers through its fur as she quietly made up a melody just for the two of them. The cat purrs beside her as she looks out over the sea, singing to her companion for no reason beyond love. Content with the moment, she thinks nothing of it. Why would she? To make something where there was nothing before is simply in her nature. There was no audience waiting to applaud her, no one nearby to write down the notes, no thought that the song ought to survive the afternoon. For those few minutes, there was only the girl, her cat, and the little pocket of peace they had made for each other.

To the cat, their world was already complete. The girl made it more beautiful anyway. The scale changes, but the instinct does not. Sometimes that instinct makes a song. Sometimes it sends us over the horizon.

So, if you want to build a ship, don't drum up the men to gather wood, divide the work, and give orders. Instead, teach them to dream about whatever could be just over the horizon. The mind will do the rest.`;

export class LynxReaderController {
  private units: ReadingUnit[] = [];
  private dwells: number[] = [];
  private index = 0;
  private wpm = 300;
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
          <div class="lynx-transport"><button class="btn-secondary-minimal" data-lynx-back aria-label="Back 10 words">← 10</button><button class="btn-primary-minimal" data-lynx-play aria-pressed="false" aria-keyshortcuts="Space">Play</button><button class="btn-secondary-minimal" data-lynx-forward aria-label="Forward 10 words">10 →</button><button class="btn-secondary-minimal" data-lynx-reset>Reset</button></div>
          <div class="lynx-progress"><label class="control-label" for="lynxPosition">Position</label><span data-lynx-position></span><input id="lynxPosition" data-lynx-seek type="range" min="0" max="0" value="0" step="1" aria-label="Reading position"></div>
        </div>
      </div>`;
    this.el<HTMLTextAreaElement>('source').value = DEFAULT_TEXT;
    const on = (target: EventTarget, type: string, handler: EventListener) => target.addEventListener(type, handler, { signal: this.events.signal });
    on(this.el('source'), 'input', () => { this.el<HTMLButtonElement>('read').disabled = !this.el<HTMLTextAreaElement>('source').value.trim(); });
    on(this.el('read'), 'click', () => this.read());
    on(this.el('play'), 'click', () => this.toggle());
    on(this.el('back'), 'click', () => this.seek(this.index - 10));
    on(this.el('forward'), 'click', () => this.seek(this.index + 10));
    on(this.el('reset'), 'click', () => this.seek(0));
    on(this.el('edit'), 'click', () => {
      this.pause();
      this.el('reader').hidden = true;
      this.el('entry').hidden = false;
      this.el('source').focus();
    });
    on(this.el('seek'), 'pointerdown', () => this.pause());
    on(this.el('seek'), 'input', () => this.seek(Number(this.el<HTMLInputElement>('seek').value)));
    on(this.el('wpm'), 'input', () => {
      if (this.playing) this.remaining = Math.max(0, this.remaining - (performance.now() - this.startedAt) / this.dwells[this.index]);
      this.wpm = Number(this.el<HTMLInputElement>('wpm').value);
      this.dwells = normalizedDwells(this.units, this.wpm);
      this.el('speed').textContent = String(this.wpm);
      if (this.playing) this.schedule();
    });
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
    this.dwells = normalizedDwells(this.units, this.wpm);
    this.el('entry').hidden = true;
    this.el('reader').hidden = false;
    this.seek(0);
    this.el('display').focus();
  }

  private key(event: KeyboardEvent) {
    if (!this.active || this.el('reader').hidden || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    // Native controls retain Space activation; the reading stage owns the shortcut.
    if (target.closest('button, a') && event.code === 'Space') return;
    if (!['Space', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
    event.preventDefault();
    if (event.repeat) return;
    if (event.code === 'Space') this.toggle();
    else this.seek(this.index + (event.code === 'ArrowLeft' ? -10 : 10));
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
    // 88px guide-framed focal line or the reading-stage height, whichever
    // binds first, so no word reads as a page title.
    const widthScale = Math.max(0, halfWidth) / Math.max(1, extent);
    const heightScale = Math.max(0, display.clientHeight - 16) / (1.3 * baseFont);
    focus.style.setProperty('--lynx-scale', String(Math.min(88 / baseFont, heightScale, widthScale)));
  }

  destroy() {
    this.scheduler.cancel();
    this.events.abort();
    this.resize?.disconnect();
  }
}
