import '../../css/yahtzee.css';
import { CUBE_VALUES, diceAnimationTracks } from './yahtzeeMotion';
import { ExactEngine, loadRules, type RulesEngine } from './keiriEngine';
import { CATEGORIES, STORAGE_KEY, cryptoDie, freshMatch, freshRivalry, parseRivalry, rollDice, rollHuman, scoreHuman, scoreKeiri, toggleHold, filled, type DieSource, type Rivalry } from './yahtzeeCore';

const PIP_POSITIONS = [[], [5], [1, 9], [1, 5, 9], [1, 3, 7, 9], [1, 3, 5, 7, 9], [1, 3, 4, 6, 7, 9]];

type Progress = { phase: 'download' | 'initializing' | 'ready' | 'failed'; loaded: number; total: number | null };
type Decision = { kind: 'hold'; mask: number } | { kind: 'score'; category: number };
interface ExactLike { load(progress: (value: Progress) => void): Promise<void>; decide(sheet: Rivalry['match']['keiri'], dice: number[], rolls: number): Promise<Decision>; dispose?(): void }
export interface YahtzeeDependencies { rules?: () => Promise<RulesEngine>; exact?: ExactLike; rng?: DieSource; storage?: Pick<Storage, 'getItem' | 'setItem'>; pauseMs?: number }

export class YahtzeeController {
  private state: Rivalry = freshRivalry();
  private rules: RulesEngine | null = null;
  private readonly exact: ExactLike;
  private readonly rng: DieSource;
  private storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
  private active = true;
  private initialized = false;
  private destroyed = false;
  private pageSuspended = false;
  private generation = 0;
  private runningGeneration: number | null = null;
  private waits = new Map<ReturnType<typeof setTimeout>, (valid: boolean) => void>();
  private progress: Progress = { phase: 'download', loaded: 0, total: null };
  private loading: Promise<void> | null = null;
  private error = '';
  private storageUnavailable = false;
  private resetConfirm = false;
  private rolling = false;
  private motionSequence = 0;
  private rollAnimations = new Set<Animation>();
  private rollSurfaces = new Set<HTMLElement>();
  private cubeSides = new Map<HTMLElement, HTMLElement[]>();
  private botFrame: { dice: number[]; held: boolean[]; rolls: number; message: string; category?: number } | null = null;
  private rawRestore: string | null = null;
  private liveText = '';
  private readonly textHook = () => JSON.stringify({ ...this.state, active: this.active, engine: this.progress.phase, rolling: this.rolling, botFrame: this.botFrame });

  constructor(private readonly root: HTMLElement, private readonly dependencies: YahtzeeDependencies = {}) {
    this.exact = dependencies.exact ?? new ExactEngine();
    this.rng = dependencies.rng ?? cryptoDie;
  }
  init(): void {
    if (this.initialized || this.destroyed) return;
    this.initialized = true;
    try {
      this.storage = this.dependencies.storage ?? window.localStorage;
      const raw = this.storage.getItem(STORAGE_KEY);
      const restored = parseRivalry(raw);
      // A candidate is not live state until Rust validates its score sheets.
      // Structurally rejected storage leaves a fresh game immediately playable.
      this.rawRestore = restored ? raw : null;
    } catch { this.storageUnavailable = true; }
    this.root.innerHTML = `<div class="yahtzee-record-bar"><span data-record></span><div class="yahtzee-reset"><button type="button" data-reset-game>Reset game</button><span data-reset-question hidden>Clear record?</span><button type="button" data-reset>Reset record</button><button type="button" data-reset-cancel hidden>Cancel</button></div></div>
      <div class="yahtzee-board"><section class="yahtzee-scorecard" aria-label="Match scorecard"><div class="yahtzee-score-heading"><span>KEIRI</span><span data-round>ROUND 01 / 13</span><span>YOU</span></div>
      ${CATEGORIES.map((name, category) => `<div class="yahtzee-score-row" data-row="${category}"><span data-keiri-score="${category}">—</span><span class="yahtzee-category">${name}</span><button type="button" data-score="${category}" aria-label="Score ${name}" disabled>—</button></div>`).join('')}
      <div class="yahtzee-bonus-row"><span data-keiri-upper>0 / 63</span><span>Upper section</span><span data-human-upper>0 / 63</span></div>
      <div class="yahtzee-bonus-row"><span data-keiri-bonus>0 + 0</span><span>Upper + Yahtzee bonus</span><span data-human-bonus>0 + 0</span></div>
      <div class="yahtzee-total-row"><span data-keiri-total>0</span><span>Total</span><span data-human-total>0</span></div></section>
      <section class="yahtzee-play" aria-label="Shared dice"><div class="yahtzee-turn"><span data-turn>YOUR TURN</span><span data-roll-count>ROLL 0 / 3</span></div><div class="yahtzee-dice">${Array.from({ length: 5 }, (_, i) => `<button class="yahtzee-die" type="button" data-die="${i}" aria-pressed="false" aria-label="Die ${i + 1}, not rolled" disabled><span class="yahtzee-ground-shadow" aria-hidden="true"></span><span class="yahtzee-face" aria-hidden="true">${Array.from({ length: 9 }, () => '<span class="yahtzee-pip"></span>').join('')}</span><span class="yahtzee-held" aria-hidden="true"></span></button>`).join('')}</div>
      <div class="yahtzee-result" data-result hidden aria-hidden="true"><strong data-winner></strong><span data-final-totals></span></div><div class="yahtzee-action"><button type="button" class="btn-primary-minimal" data-roll>Roll dice</button><button type="button" class="btn-primary-minimal" data-again hidden>Play again</button></div><p class="yahtzee-status" role="status" aria-live="polite" data-status></p></section></div>
      <div class="yahtzee-engine" data-engine><progress aria-label="Keiri readiness" data-progress></progress><div><span data-engine-label>Downloading Keiri</span><button type="button" data-retry hidden>Retry</button><span data-storage hidden>Progress cannot be saved in this browser.</span></div></div>`;
    // Allocate each fixed cube once, off-DOM. Rolls only attach/detach the same
    // immutable faces; they never rebuild hundreds of pip nodes at input time.
    for (const surface of this.root.querySelectorAll<HTMLElement>('.yahtzee-face')) {
      this.cubeSides.set(surface, CUBE_VALUES.map((value, side) => {
        const panel = document.createElement('span');
        panel.className = 'yahtzee-cube-side';
        panel.dataset.side = String(side);
        panel.dataset.value = String(value);
        panel.innerHTML = Array.from({ length: 9 }, (_, position) =>
          `<span class="yahtzee-cube-pip${PIP_POSITIONS[value].includes(position + 1) ? ' is-visible' : ''}"></span>`).join('');
        const shade = document.createElement('span');
        shade.className = 'yahtzee-face-shade';
        panel.append(shade);
        return panel;
      }));
    }
    const board = this.element('.yahtzee-board');
    const rack = this.element('.yahtzee-play');
    board.prepend(rack);
    rack.querySelector('.yahtzee-turn')!.append(this.element('[data-status]'));
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('utility-deactivate', this.onDeactivate);
    this.root.addEventListener('utility-activate', this.onActivate);
    window.addEventListener('pagehide', this.onPageHide);
    window.addEventListener('pageshow', this.onPageShow);
    this.installTextHook();
    this.render();
    void this.load();
  }
  destroy(): void {
    this.destroyed = true;
    this.onDeactivate();
    this.exact.dispose?.();
    this.cubeSides.clear();
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('utility-deactivate', this.onDeactivate);
    this.root.removeEventListener('utility-activate', this.onActivate);
    window.removeEventListener('pagehide', this.onPageHide);
    window.removeEventListener('pageshow', this.onPageShow);
    const host = window as Window & { render_game_to_text?: () => string };
    if (host.render_game_to_text === this.textHook) delete host.render_game_to_text;
  }
  private onPageHide = (): void => {
    this.pageSuspended = this.active;
    this.onDeactivate();
  };
  private onPageShow = (): void => {
    if (this.pageSuspended) { this.pageSuspended = false; this.onActivate(); }
  };
  private installTextHook(): void {
    (window as Window & { render_game_to_text?: () => string }).render_game_to_text = this.textHook;
  }
  private onDeactivate = (): void => {
    this.active = false;
    this.invalidate();
  };
  private onActivate = (): void => {
    if (this.destroyed) return;
    this.active = true;
    this.installTextHook();
    this.render();
    this.startBot();
  };
  private invalidate(): void {
    this.cancelRollMotion();
    this.generation++;
    this.runningGeneration = null;
    for (const [timer, resolve] of this.waits) { clearTimeout(timer); resolve(false); }
    this.waits.clear();
    this.botFrame = null;
  }
  private cancelRollMotion(): void {
    this.motionSequence++;
    this.rolling = false;
    for (const animation of this.rollAnimations) animation.cancel();
    this.rollAnimations.clear();
    for (const surface of this.rollSurfaces) {
      surface.classList.remove('is-tumbling');
      this.cubeSides.get(surface)?.forEach(side => side.remove());
    }
    this.rollSurfaces.clear();
  }
  private async presentRoll(indices: number[], allowMotion: boolean): Promise<boolean> {
    this.cancelRollMotion();
    const sequence = this.motionSequence;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const surfaces = indices.map(index => this.element(`[data-die="${index}"] .yahtzee-face`));
    const previousFaces = surfaces.map(surface => Number(surface.closest<HTMLElement>('[data-die]')?.dataset.face) || 1);
    const animate = allowMotion && !reduce && surfaces.length > 0 && surfaces.every(surface => typeof surface.animate === 'function');
    const size = animate ? surfaces[0].offsetWidth : 0;
    this.rolling = animate;
    this.render();
    if (!animate) return false;
    const duration = this.state.match.turn === 'keiri' ? 300 : 600;
    const tracks = surfaces.map((surface, index) => diceAnimationTracks(
      previousFaces[index], Number(surface.closest<HTMLElement>('[data-die]')!.dataset.face), indices[index], size
    ));
    // Batch every geometry mutation before starting animations. Avoid alternating
    // append/animate calls that can force a style/layout flush for each die.
    for (const surface of surfaces) {
      surface.append(...this.cubeSides.get(surface)!);
      surface.classList.add('is-tumbling');
      this.rollSurfaces.add(surface);
    }
    const animations = surfaces.flatMap((surface, index) => {
      const options: KeyframeAnimationOptions = { duration: duration + indices[index] * 8, fill: 'both', easing: 'linear' };
      const shadow = surface.parentElement!.querySelector<HTMLElement>('.yahtzee-ground-shadow')!;
      return [
        surface.animate(tracks[index].motion, options),
        ...this.cubeSides.get(surface)!.map((panel, side) =>
          panel.querySelector<HTMLElement>('.yahtzee-face-shade')!.animate(tracks[index].lighting[side], options)),
        shadow.animate(tracks[index].shadow, options)
      ];
    });
    // All tracks use exactly the same native clock, including lighting and contact.
    const startTime = document.timeline?.currentTime;
    if (typeof startTime === 'number') animations.forEach(animation => { animation.startTime = startTime; });
    animations.forEach(animation => this.rollAnimations.add(animation));
    await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
    if (sequence === this.motionSequence && this.active) {
      this.cancelRollMotion();
      this.render();
    }
    return true;
  }
  private current(generation: number): boolean { return this.active && generation === this.generation; }
  private pause(generation: number): Promise<boolean> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.waits.delete(timer); resolve(this.current(generation)); }, this.dependencies.pauseMs ?? 180);
      this.waits.set(timer, resolve);
    });
  }
  private async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.error = '';
    this.progress = { phase: 'download', loaded: 0, total: null };
    if (this.active) this.render();
    this.loading = (async () => {
      try {
        const results = await Promise.allSettled([
          (async () => {
            if (this.rules) return;
            const rules = await (this.dependencies.rules ?? loadRules)();
            if (this.destroyed) return;
            this.rules = rules;
            if (this.rawRestore) {
              const restored = parseRivalry(this.rawRestore, rules);
              this.state = restored ?? freshRivalry();
              if (!restored) this.error = 'Saved game could not be restored. A new match is ready.';
            }
            this.rawRestore = null;
            this.save();
            if (this.active) this.render();
          })(),
          this.exact.load(progress => {
            if (this.destroyed) return;
            this.progress = progress;
            if (progress.phase === 'failed') this.error = 'Keiri could not load. Retry to continue this match.';
            if (this.active) this.render();
          })
        ]);
        if (this.destroyed) return;
        if (results.some(result => result.status === 'rejected')) throw new Error('Keiri loading failed');
        this.progress = { ...this.progress, phase: 'ready' };
      } catch {
        if (this.destroyed) return;
        this.progress = { ...this.progress, phase: 'failed' };
        this.error = 'Keiri could not load. Retry to continue this match.';
      } finally {
        this.loading = null;
        if (this.active) { this.render(); this.startBot(); }
      }
    })();
    return this.loading;
  }
  private save(): void {
    if (this.rawRestore) return;
    // Record and terminal match are one atomic value: recovery never counts twice.
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
    catch { this.storageUnavailable = true; }
  }
  private onClick = (event: Event): void => {
    if (!this.active) return;
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled || !this.root.contains(button)) return;
    if (this.rawRestore && !button.hasAttribute('data-retry')) return;
    if (this.progress.phase !== 'failed') this.error = '';
    if (button.hasAttribute('data-roll')) {
      const indices = this.state.match.held.flatMap((held, index) => held ? [] : [index]);
      this.state = rollHuman(this.state, this.rng);
      this.save();
      void this.presentRoll(indices, event instanceof MouseEvent && event.detail > 0);
      return;
    }
    else if (button.hasAttribute('data-die')) this.state = toggleHold(this.state, Number(button.dataset.die));
    else if (button.hasAttribute('data-score') && this.rules) this.state = scoreHuman(this.state, Number(button.dataset.score), this.rules);
    else if (button.hasAttribute('data-reset-game') || (button.hasAttribute('data-again') && this.state.match.turn === 'complete')) {
      this.invalidate(); this.state = { ...this.state, match: freshMatch() }; this.rawRestore = null; this.error = ''; this.resetConfirm = false;
    } else if (button.hasAttribute('data-reset')) {
      if (this.resetConfirm) { this.state = { ...this.state, record: { human: 0, keiri: 0, ties: 0 } }; this.resetConfirm = false; }
      else this.resetConfirm = true;
    } else if (button.hasAttribute('data-reset-cancel')) this.resetConfirm = false;
    else if (button.hasAttribute('data-retry')) { void this.load(); return; }
    this.save(); this.render(); this.startBot();
  };
  private startBot(): void {
    if (!this.active || !this.rules || this.progress.phase !== 'ready' || this.state.match.turn !== 'keiri' || this.runningGeneration !== null) return;
    const generation = this.generation;
    this.runningGeneration = generation;
    void this.runBot(generation);
  }
  private async runBot(generation: number): Promise<void> {
    try {
      let dice = rollDice([], [], this.rng);
      let rolls = 1;
      let held = Array(5).fill(false) as boolean[];
      while (this.current(generation)) {
        this.botFrame = { dice, held, rolls, message: `Keiri rolled ${dice.join(', ')}.` };
        const animated = await this.presentRoll(held.flatMap((keep, index) => keep ? [] : [index]), true);
        if (!this.current(generation)) return;
        if (!animated && !await this.pause(generation)) return;
        const decision = await this.exact.decide(this.state.match.keiri, dice, rolls);
        if (!this.current(generation)) return;
        if (decision.kind === 'score') {
          if (!this.rules || this.rules.preview(this.state.match.keiri, dice)[decision.category] == null) throw new Error('Illegal Keiri score');
          this.botFrame = { dice, held, rolls, category: decision.category, message: `Keiri scores ${CATEGORIES[decision.category]}.` };
          this.render();
          if (!await this.pause(generation)) return;
          this.state = scoreKeiri(this.state, dice, decision.category, this.rules);
          this.botFrame = null;
          this.save(); this.render();
          return;
        }
        if (rolls >= 3 || !Number.isInteger(decision.mask) || decision.mask < 0 || decision.mask > 31) throw new Error('Illegal Keiri hold');
        held = dice.map((_, index) => Boolean(decision.mask & (1 << index)));
        this.botFrame = { dice, held, rolls, message: held.every(Boolean) ? 'Keiri holds all five dice.' : `Keiri holds ${held.filter(Boolean).length} dice.` };
        this.render();
        if (!await this.pause(generation)) return;
        dice = rollDice(dice, held, this.rng);
        rolls++;
      }
    } catch {
      if (this.current(generation)) {
        this.botFrame = null;
        this.progress = { ...this.progress, phase: 'failed' };
        this.error = 'Keiri could not finish its turn. Retry to continue.';
        this.render();
      }
    } finally {
      if (this.runningGeneration === generation) this.runningGeneration = null;
    }
  }
  private element<T extends HTMLElement = HTMLElement>(selector: string): T { return this.root.querySelector<T>(selector)!; }
  private render(): void {
    const pendingRestore = this.rawRestore !== null;
    const match = this.state.match;
    const frame = this.botFrame;
    const dice = frame?.dice ?? match.dice;
    const held = frame?.held ?? match.held;
    const rolls = frame?.rolls ?? match.rolls;
    const human = !pendingRestore && match.turn === 'human';
    const complete = match.turn === 'complete';
    this.root.dataset.turn = match.turn;
    this.root.dataset.rolling = String(this.rolling);
    this.root.dataset.engineState = this.progress.phase;
    this.root.dataset.rolls = String(rolls);
    this.element('[data-record]').textContent = `KEIRI ${this.state.record.keiri} — ${this.state.record.human} YOU · ${this.state.record.ties} ${this.state.record.ties === 1 ? 'TIE' : 'TIES'}`;
    this.element('[data-round]').textContent = `ROUND ${String(Math.min(13, filled(match.keiri) + 1)).padStart(2, '0')} / 13`;
    this.element('[data-reset-question]').hidden = !this.resetConfirm;
    this.element('[data-reset-cancel]').hidden = !this.resetConfirm;
    this.element('[data-reset]').textContent = this.resetConfirm ? 'Clear' : 'Reset record';
    for (const selector of ['[data-reset]', '[data-reset-game]', '[data-reset-cancel]', '[data-again]']) {
      this.element<HTMLButtonElement>(selector).disabled = pendingRestore;
    }
    this.element('[data-turn]').textContent = pendingRestore ? 'RESTORING GAME' : complete ? 'FINAL SCORE' : human ? 'YOUR TURN' : "KEIRI’S TURN";
    this.element('[data-roll-count]').textContent = complete ? 'MATCH COMPLETE' : `ROLL ${rolls} / 3`;
    const preview = human && rolls && this.rules && !this.rolling ? this.rules.preview(match.human, dice) : [];
    CATEGORIES.forEach((name, category) => {
      this.element(`[data-keiri-score="${category}"]`).textContent = String(match.keiri.scores[category] ?? '—');
      const button = this.element<HTMLButtonElement>(`[data-score="${category}"]`);
      const available = match.human.scores[category] === null && preview[category] != null;
      const value = match.human.scores[category] ?? preview[category] ?? '—';
      button.textContent = String(value);
      button.disabled = !available;
      button.classList.toggle('is-preview', available);
      if (available) button.style.setProperty('--score-strength', String(.035 + Math.min(50, Math.max(0, Number(value))) / 50 * .585));
      else button.style.removeProperty('--score-strength');
      button.setAttribute('aria-label', available ? `Score ${name}: ${value} points` : `${name}: ${value === '—' ? 'not scored' : `${value} points`}`);
      this.element(`[data-row="${category}"]`).classList.toggle('is-keiri-choice', frame?.category === category);
    });
    for (let index = 0; index < 5; index++) {
      const button = this.element<HTMLButtonElement>(`[data-die="${index}"]`);
      button.disabled = !human || !rolls || rolls >= 3 || this.rolling;
      button.setAttribute('aria-pressed', String(held[index]));
      button.setAttribute('aria-label', `Die ${index + 1}, ${dice[index] ?? 'not rolled'}${held[index] ? ', held' : ''}`);
      button.classList.toggle('is-held', held[index]);
      button.dataset.face = String(dice[index] ?? 0);
      const positions = PIP_POSITIONS[dice[index] ?? 0];
      button.querySelectorAll('.yahtzee-pip').forEach((pip, position) => pip.classList.toggle('is-visible', positions.includes(position + 1)));
      button.querySelector('.yahtzee-held')!.textContent = held[index] ? 'HELD' : '';
    }
    const roll = this.element<HTMLButtonElement>('[data-roll]');
    roll.hidden = complete; roll.disabled = !human || rolls >= 3 || this.rolling;
    roll.textContent = this.rolling ? 'Rolling…' : rolls ? 'Reroll dice' : 'Roll dice';
    this.element('[data-again]').hidden = !complete;
    this.element('.yahtzee-dice').hidden = complete;
    this.element('[data-result]').hidden = !complete;
    const totals = this.rules ? { human: this.rules.totals(match.human), keiri: this.rules.totals(match.keiri) } : null;
    if (totals) for (const player of ['human', 'keiri'] as const) {
      this.element(`[data-${player}-total]`).textContent = String(totals[player].total);
      this.element(`[data-${player}-upper]`).textContent = `${totals[player].upper} / 63`;
      this.element(`[data-${player}-bonus]`).textContent = `${totals[player].upperBonus} + ${totals[player].yahtzeeBonus}`;
      this.element(`[data-${player}-bonus]`).setAttribute('title', `Upper bonus: ${totals[player].upperBonus}; Yahtzee bonuses: ${totals[player].yahtzeeBonus}`);
    }
    let status = human ? (rolls === 0 ? 'Roll to begin your turn.' : rolls === 3 ? 'Choose a score to end your turn.' : 'Hold dice, reroll, or choose a score.') : frame?.message ?? 'Waiting for Keiri to be ready.';
    if (complete && totals) {
      const winner = totals.human.total > totals.keiri.total ? 'You win' : totals.human.total < totals.keiri.total ? 'Keiri wins' : 'It’s a tie';
      const finalScores = `${totals.keiri.total} — ${totals.human.total}`;
      this.element('[data-winner]').textContent = winner;
      this.element('[data-final-totals]').textContent = finalScores;
      status = `${winner} · ${finalScores}`;
    }
    if (this.rolling) status = human ? 'Rolling your dice.' : 'Keiri is rolling.';
    if (pendingRestore) status = 'Checking saved game…';
    if (this.error) status = this.error;
    if (status !== this.liveText) { this.liveText = status; this.element('[data-status]').textContent = status; }
    const progress = this.element<HTMLProgressElement>('[data-progress]');
    progress.hidden = this.progress.phase === 'ready';
    if (this.progress.phase === 'download' && this.progress.total && this.progress.total >= this.progress.loaded) { progress.max = this.progress.total; progress.value = this.progress.loaded; }
    else progress.removeAttribute('value');
    const percent = this.progress.total ? ` · ${Math.min(100, Math.floor(100 * this.progress.loaded / this.progress.total))}%` : '';
    this.element('[data-engine-label]').textContent = this.progress.phase === 'ready' ? 'KEIRI READY' : this.progress.phase === 'failed' ? 'KEIRI UNAVAILABLE' : this.progress.phase === 'initializing' ? 'Preparing Keiri' : `Downloading Keiri${percent}`;
    this.element('[data-retry]').hidden = this.progress.phase !== 'failed';
    this.element('[data-storage]').hidden = !this.storageUnavailable;
  }
}
