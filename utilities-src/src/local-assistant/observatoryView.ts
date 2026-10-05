import { deltaIntensity, deltaScale, ObservatoryHistory, strongestAttention, tokenLabel, waterfallColumns, type ObservatorySnapshot, type AttentionReading } from './observatory';
import type { Token } from './types';
const SVG = 'http://www.w3.org/2000/svg';
const format = (value: number, digits = 3) => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';
function svg(doc: Document, tag: string, attributes: Record<string, string | number> = {}, text?: string): SVGElement {
  const element = doc.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}
/** Three linked views of completed runtime passes. There is no simulated motion. */
export class ObservatoryView {
  private readonly history = new ObservatoryHistory();
  private readonly events = new AbortController();
  private readonly doc: Document;
  private observer?: ResizeObserver;
  private context: readonly Token[] = [];
  private readonly generated = new Map<number, Token>();
  private layers: Array<'attention' | 'deltanet'> = [];
  private selectedLayer: number | null = null;
  private inspectedLayer = 0;
  private processed = 0;
  private total = 0;
  private width = 0;
  private height = 0;
  private pinnedWindow: ObservatorySnapshot[] | null = null;
  private attentionSnapshot?: ObservatorySnapshot;
  private attentionLayer: number | null = null;
  private destroyed = false;
  private canvasContext: CanvasRenderingContext2D | null = null;
  constructor(private readonly host: HTMLElement, private readonly options: { onInteraction?: () => void } = {}) {
    this.doc = host.ownerDocument;
    host.classList.add('la-observatory-view'); host.dataset.observatoryView = '';
    host.innerHTML = `<div class="la-observation-toolbar"><span data-observation-step>Awaiting inference</span><button type="button" data-observatory-live aria-pressed="true">Live</button></div>
      <section class="la-observation-panel la-attention-panel" data-attention-panel><h3>Context attention <span data-attention-summary>Last query · head mean</span></h3><div class="la-attention-controls" data-attention-layers role="group" aria-label="Attention layer"></div><div class="la-attention-plot" data-attention-plot></div><p class="la-observation-reading" data-attention-reading>Attention appears after a measured forward pass.</p></section>
      <section class="la-observation-panel la-delta-panel" data-delta-panel><h3>Change by layer <span data-delta-scale>Relative contribution</span></h3><div class="la-waterfall-wrap"><div class="la-waterfall-axis" data-waterfall-axis aria-hidden="true"></div><canvas data-delta-waterfall tabindex="0" role="img" aria-label="Layer change history. Left and right choose a step; up and down inspect a layer; Enter pins, Escape resumes live."></canvas><p class="la-observation-empty" data-delta-empty>Layer change measurements pending.</p></div><div class="la-waterfall-controls"><span data-history-range></span><input type="range" data-history-step min="0" max="0" value="0" aria-label="Select and pin inference step" disabled><span data-delta-inspection>—</span></div></section>
      <section class="la-observation-panel la-next-panel" data-next-panel><h3>Next token <span data-lens-label>Logit lens · rank</span></h3><div class="la-lens-plot" data-lens-plot></div><div class="la-lens-legend" data-lens-legend></div><div data-candidates></div><p class="la-observation-reading" data-candidate-reading>Final probabilities appear after sampling.</p></section>`;
    const listen = (target: EventTarget, type: string, callback: EventListener) => target.addEventListener(type, callback, { signal: this.events.signal });
    listen(this.el('[data-observatory-live]'), 'click', () => { this.interact(); this.resume(); this.render(); });
    listen(this.el('[data-attention-layers]'), 'click', event => {
      const target = (event.target as Element).closest<HTMLButtonElement>('[data-attention-layer]');
      if (!target) return; this.interact(); this.selectedLayer = Number(target.dataset.attentionLayer); this.render();
    });
    listen(this.el('[data-attention-plot]'), 'focusin', event => {
      const target = event.target as HTMLElement;
      if (!target.hasAttribute('data-key-position') || !this.history.selected) return;
      this.interact(); this.pin(this.history.selected); this.render();
      this.el('[data-attention-reading]').textContent = target.getAttribute('aria-label');
    });
    const canvas = this.el<HTMLCanvasElement>('[data-delta-waterfall]');
    this.canvasContext = canvas.getContext('2d');
    listen(canvas, 'pointermove', event => {
      if (this.history.pinned) return;
      const selected = this.hit(event as PointerEvent); if (!selected) return;
      const changed = this.history.preview !== selected.snapshot || this.inspectedLayer !== selected.layer;
      this.history.preview = selected.snapshot; this.inspectedLayer = selected.layer; if (changed) this.render();
    });
    listen(canvas, 'pointerleave', () => { if (!this.history.pinned) { this.history.preview = null; this.render(); } });
    listen(canvas, 'click', event => { const hit = this.hit(event as PointerEvent); if (!hit) return; this.interact(); this.inspectedLayer = hit.layer; this.pin(hit.snapshot); this.render(); });
    listen(canvas, 'keydown', event => this.keydown(event as KeyboardEvent));
    listen(this.el('[data-history-step]'), 'input', () => {
      const snapshot = this.selectableSnapshots()[Number(this.el<HTMLInputElement>('[data-history-step]').value)];
      if (!snapshot) return; this.interact(); this.pin(snapshot); this.render();
    });
    if (typeof ResizeObserver !== 'undefined') { this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); }
    this.resize();
  }
  setContext(tokens: readonly Token[]): void { this.context = tokens; this.attentionSnapshot = undefined; }
  setLayers(layers: Array<'attention' | 'deltanet'>): void { this.layers = layers.slice(); }
  setProgress(processed: number, total?: number): void { this.processed = processed; this.total = total ?? 0; }
  ingest(snapshot: ObservatorySnapshot): void {
    if (this.destroyed) return;
    this.history.ingest(snapshot);
    // Explicit positions are essential: query and sampled output are different tokens.
    if (snapshot.sampled?.position !== undefined) {
      this.generated.set(snapshot.sampled.position, snapshot.sampled);
      if (this.generated.size > 8192) this.generated.delete(this.generated.keys().next().value!);
    }
  }
  render(): void {
    if (this.destroyed) return;
    const selected = this.history.selected;
    this.host.dataset.selectedStep = selected ? String(selected.step) : '';
    this.host.dataset.pinned = String(!!this.history.pinned);
    this.host.dataset.historyCount = String(this.history.snapshots.length);
    this.el('[data-observation-step]').textContent = selected ? `${this.history.pinned ? 'Pinned' : this.history.preview ? 'Inspecting' : 'Step'} ${selected.step}${selected.sampled ? ` · ${tokenLabel(selected.sampled.piece)}` : ''}` : this.total ? `Prompt ${format(this.processed, 0)} / ${format(this.total, 0)}` : 'Awaiting inference';
    const live = this.el<HTMLButtonElement>('[data-observatory-live]'); live.setAttribute('aria-pressed', String(!this.history.pinned && !this.history.preview));
    live.textContent = this.history.pinned || this.history.preview ? 'Resume live ↗' : 'Live';
    this.renderAttention(selected); this.renderWaterfall(selected); this.renderCandidates(selected); this.renderLens(selected);
  }
  resize(): void {
    if (this.destroyed) return;
    const width = this.host.clientWidth || 320; const height = this.host.clientHeight || 350;
    if (width === this.width && height === this.height) return;
    this.width = width; this.height = height; this.attentionSnapshot = undefined;
    this.host.dataset.space = this.height >= 950 ? 'large' : this.height >= 520 ? 'medium' : 'compact';
    this.render();
  }
  reset(): void { this.pinnedWindow = null; this.attentionSnapshot = undefined; this.history.reset(); this.generated.clear(); this.context = []; this.processed = this.total = 0; this.selectedLayer = null; this.inspectedLayer = 0; this.render(); }
  destroy(): void { this.destroyed = true; this.events.abort(); this.observer?.disconnect(); this.history.reset(); this.generated.clear(); }
  private el<T extends HTMLElement = HTMLElement>(selector: string): T { return this.host.querySelector<T>(selector)!; }
  private interact(): void { this.options.onInteraction?.(); }
  private tokenAt(position: number): Token | undefined { return this.generated.get(position) ?? this.context[position]; }
  private resume(): void { this.history.live(); this.pinnedWindow = null; }
  private pin(snapshot: ObservatorySnapshot): void { if (this.pinnedWindow?.includes(snapshot)) { this.history.pin(snapshot); return; } this.pinnedWindow = null; this.history.pin(snapshot); this.pinnedWindow = this.visibleSnapshots().slice(); }
  private selectableSnapshots(): ObservatorySnapshot[] { return this.pinnedWindow ?? this.history.snapshots; }
  private visibleSnapshots(): ObservatorySnapshot[] {
    const snapshots = this.pinnedWindow ?? this.history.snapshots;
    const capacity = waterfallColumns(this.width);
    const selected = this.history.pinned;
    const index = selected ? snapshots.indexOf(selected) : -1;
    // Keep a pinned historical window fixed while newer steps arrive.
    const end = index >= 0 ? Math.max(capacity, index + 1) : snapshots.length;
    return snapshots.slice(Math.max(0, end - capacity), end);
  }
  private hit(event: PointerEvent): { snapshot: ObservatorySnapshot; layer: number } | undefined {
    const box = this.el('[data-delta-waterfall]').getBoundingClientRect(); const visible = this.visibleSnapshots();
    if (!box.width || !box.height || !visible.length) return;
    const index = Math.floor((event.clientX - box.left) / box.width * waterfallColumns(this.width));
    if (index < 0 || index >= visible.length) return;
    const count = this.layerCount();
    return { snapshot: visible[index], layer: Math.max(0, Math.min(count - 1, Math.floor((event.clientY - box.top) / box.height * count))) };
  }
  private keydown(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', ' ', 'Escape'].includes(event.key)) return;
    event.preventDefault(); this.interact();
    const snapshots = this.selectableSnapshots();
    const index = Math.max(0, snapshots.findIndex(value => value === this.history.selected));
    if (event.key === 'Escape') this.resume();
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') this.inspectedLayer = Math.max(0, Math.min(this.layerCount() - 1, this.inspectedLayer + (event.key === 'ArrowUp' ? -1 : 1)));
    else if (event.key === 'Enter' || event.key === ' ') { if (this.history.selected) this.pin(this.history.selected); }
    else {
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? snapshots.length - 1 : Math.max(0, Math.min(snapshots.length - 1, index + (event.key === 'ArrowLeft' ? -1 : 1)));
      if (snapshots[next]) this.pin(snapshots[next]);
    }
    this.render();
  }
  private layerCount(): number { return Math.max(1, this.layers.length, this.history.selected?.layerCount ?? 0, ...this.history.snapshots.flatMap(snapshot => snapshot.deltas?.map(delta => delta.layer + 1) ?? [])); }
  private renderAttention(snapshot?: ObservatorySnapshot): void {
    if (snapshot && snapshot === this.attentionSnapshot && this.selectedLayer === this.attentionLayer) return;
    const controls = this.el('[data-attention-layers]');
    const available = snapshot?.attention ?? [];
    const layerIds = this.layers.flatMap((kind, index) => kind === 'attention' ? [index] : []);
    for (const reading of available) if (!layerIds.includes(reading.layer)) layerIds.push(reading.layer);
    const currentIds = [...controls.children].map(element => (element as HTMLElement).dataset.attentionLayer).join(',');
    if (currentIds !== layerIds.join(',')) {
      controls.replaceChildren();
      for (const layer of layerIds) { const button = this.doc.createElement('button'); button.type = 'button'; button.dataset.attentionLayer = String(layer); button.textContent = `L${layer + 1}`; button.setAttribute('aria-label', `Attention at layer ${layer + 1}`); controls.append(button); }
    }
    if (this.selectedLayer === null && layerIds.length) this.selectedLayer = layerIds.at(-1)!;
    for (const button of controls.querySelectorAll<HTMLButtonElement>('button')) button.setAttribute('aria-pressed', String(Number(button.dataset.attentionLayer) === this.selectedLayer));
    this.attentionSnapshot = snapshot; this.attentionLayer = this.selectedLayer;
    const reading = available.find(value => value.layer === this.selectedLayer);
    const plot = this.el('[data-attention-plot]'); plot.replaceChildren();
    this.el('[data-attention-panel]').dataset.state = reading ? 'available' : 'waiting';
    if (!reading) { const empty = this.doc.createElement('p'); empty.className = 'la-observation-empty'; empty.textContent = this.total && !snapshot ? 'Processing the prompt…' : 'Attention weights not reported for this step.'; plot.append(empty); this.el('[data-attention-reading]').textContent = 'Last-query attention, averaged across heads.'; return; }
    this.drawAttention(plot, reading, snapshot!);
  }
  private drawAttention(plot: HTMLElement, reading: AttentionReading, snapshot: ObservatorySnapshot): void {
    const limit = this.width >= 700 ? 10 : this.width >= 450 ? 8 : 6;
    const entries = strongestAttention(reading, limit);
    const width = Math.max(280, this.width); const height = Math.max(1, plot.clientHeight || 100); const chart = svg(this.doc, 'svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Attention from context position ${reading.queryPosition}, layer ${reading.layer + 1}` });
    const query = snapshot.query?.position === reading.queryPosition ? snapshot.query : this.tokenAt(reading.queryPosition);
    const label = query ? tokenLabel(query.piece) : `#${reading.queryPosition}`;
    chart.append(svg(this.doc, 'text', { x: width / 2, y: 13, 'text-anchor': 'middle', class: 'la-attention-query' }, `${label.slice(0, 22)} · query ${reading.queryPosition}`));
    const peak = Math.max(...entries.map(entry => entry.weight), 0.000001);
    entries.forEach((entry, index) => {
      const x = (index + 0.5) * width / entries.length;
      const weight = entry.weight;
      const path = svg(this.doc, 'path', { d: `M${width / 2},23 C${width / 2},${height * .5} ${x},${height * .4} ${x},${height - 29}`, fill: 'none', stroke: '#7050c0', 'stroke-width': 0.7 + weight / peak * 3.3, 'stroke-opacity': 0.2 + weight / peak * 0.75, 'data-key-position': entry.position, 'data-attention-weight': weight });
      const source = this.tokenAt(entry.position); const piece = source ? tokenLabel(source.piece) : `#${entry.position}`;
      const description = `Position ${entry.position}${source ? ` · token ${source.id} · ${JSON.stringify(source.piece)}` : ''}: ${(weight * 100).toFixed(3)}%`;
      path.setAttribute('tabindex', '0'); path.setAttribute('role', 'img'); path.setAttribute('aria-label', description);
      path.append(svg(this.doc, 'title', {}, description));
      const chars = Math.max(3, Math.floor(width / entries.length / (this.height >= 950 ? 8.5 : 6)) - 2);
      const visiblePiece = piece.length > chars ? piece.slice(0, chars - 1) + '…' : piece;
      chart.append(path, svg(this.doc, 'text', { x, y: height - 17, 'text-anchor': 'middle', class: 'la-attention-key' }, visiblePiece), svg(this.doc, 'text', { x, y: height - 3, 'text-anchor': 'middle', class: 'la-attention-position' }, `${entry.position} · ${format(weight * 100, 1)}%`));
    });
    plot.append(chart);
    this.el('[data-attention-summary]').textContent = `${reading.headCount} heads · L${reading.layer + 1}`;
    const shown = entries.reduce((sum, entry) => sum + entry.weight, 0);
    const coverage = reading.coverage === undefined ? '' : ` · retained ${format(reading.coverage * 100, 1)}%`;
    this.el('[data-attention-reading]').textContent = `Shown ${format(shown * 100, 1)}%${coverage} · ${entries.length}/${reading.keyCount} keys`;
    this.el('[data-attention-reading]').title = 'Displayed weights are original head-mean attention weights, not renormalized. Retained coverage may include additional keys outside this display.';
  }
  private renderWaterfall(selected?: ObservatorySnapshot): void {
    const snapshots = this.visibleSnapshots(); const canvas = this.el<HTMLCanvasElement>('[data-delta-waterfall]');
    const count = this.layerCount(); const scale = deltaScale(this.pinnedWindow ?? this.history.snapshots);
    const hasData = snapshots.some(snapshot => snapshot.deltas?.some(delta => Number.isFinite(delta.value)));
    this.el('[data-delta-panel]').dataset.state = hasData ? 'available' : 'waiting';
    this.el('[data-delta-empty]').hidden = hasData;
    canvas.dataset.steps = snapshots.map(snapshot => snapshot.step).join(','); canvas.dataset.layers = String(count);
    const axis = this.el('[data-waterfall-axis]'); axis.replaceChildren();
    const compactAxis = (canvas.clientHeight || 90) < 70;
    for (let index = 0; index < count; index++) { const item = this.doc.createElement('span');
      const labeled = compactAxis ? index === 0 || index === Math.ceil(count / 2) - 1 || index === count - 1 : index === 0 || (index + 1) % 4 === 0;
      item.textContent = labeled ? String(index + 1) : ''; item.classList.toggle('is-attention', this.layers[index] === 'attention'); axis.append(item); }
    axis.style.setProperty('--row-count', String(count));
    const box = canvas.getBoundingClientRect(); const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.round((box.width || this.width - 22) * ratio); const height = Math.round((box.height || 90) * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = this.canvasContext;
    if (ctx) {
      ctx.fillStyle = '#f6f4f9'; ctx.fillRect(0, 0, width, height);
      const columnWidth = width / waterfallColumns(this.width); const rowHeight = height / count;
      snapshots.forEach((snapshot, column) => {
        for (const delta of snapshot.deltas ?? []) {
          if (!Number.isFinite(delta.value) || delta.value < 0 || delta.layer < 0 || delta.layer >= count) continue;
          const value = deltaIntensity(delta.value, scale);
          ctx.fillStyle = `rgb(${Math.round(247 - value * 135)}, ${Math.round(244 - value * 164)}, ${Math.round(251 - value * 59)})`;
          ctx.fillRect(column * columnWidth, delta.layer * rowHeight, Math.max(1, columnWidth - (columnWidth > 6 ? 1 : 0)), Math.max(1, rowHeight - (rowHeight > 6 ? 1 : 0)));
        }
        if (snapshot.step === selected?.step) { ctx.strokeStyle = '#302044'; ctx.lineWidth = Math.max(1, ratio); ctx.strokeRect(column * columnWidth + 0.5, 0.5, Math.max(1, columnWidth - 1), height - 1); }
      });
    }
    this.el('[data-delta-scale]').textContent = hasData ? `Log intensity · 0–${format(scale)}` : 'Δ / input RMS';
    this.el('[data-delta-scale]').title = 'Relative change = delta RMS / input RMS. Color uses log1p intensity with one shared scale across the retained window; displayed numeric readings remain the original measured ratios.';
    const delta = selected?.deltas?.find(value => value.layer === this.inspectedLayer);
    this.el('[data-delta-inspection]').textContent = selected ? `L${this.inspectedLayer + 1} · ${delta && Number.isFinite(delta.value) ? format(delta.value, 4) : '—'}` : '—';
    canvas.setAttribute('aria-description', selected ? `Step ${selected.step}. Layer ${this.inspectedLayer + 1}, relative change ${delta ? format(delta.value, 4) : 'not measured'}.` : 'No layer change measurements yet.');
    this.el('[data-history-range]').textContent = snapshots.length ? `${snapshots[0].step}–${snapshots.at(-1)!.step}` : 'No steps';
    const selectable = this.selectableSnapshots();
    const range = this.el<HTMLInputElement>('[data-history-step]'); range.disabled = !selectable.length; range.max = String(Math.max(0, selectable.length - 1));
    const selectedIndex = selected ? selectable.indexOf(selected) : -1;
    range.value = String(selectedIndex < 0 ? 0 : selectedIndex); range.setAttribute('aria-valuetext', selected ? `Step ${selected.step}${this.history.pinned ? ', pinned' : ''}` : 'No steps');
  }
  private renderLens(snapshot?: ObservatorySnapshot): void {
    const plot = this.el('[data-lens-plot]'); plot.replaceChildren();
    this.el('[data-lens-legend]').replaceChildren();
    const checkpoints = snapshot?.lens?.filter(checkpoint => checkpoint.candidates.length).slice().sort((a, b) => a.layer - b.layer) ?? [];
    if (!checkpoints.length) { const empty = this.doc.createElement('p'); empty.className = 'la-observation-empty'; empty.textContent = 'Intermediate token ranks pending.'; plot.append(empty); this.el('[data-lens-label]').textContent = 'Logit lens unavailable'; return; }
    this.el('[data-lens-label]').textContent = 'Words across depth';
    const height = Math.max(1, plot.clientHeight || 92); const wordCount = height < 72 ? 2 : 3;
    const columns = checkpoints.map(checkpoint => ({ label: `L${checkpoint.layer + 1}`, layer: checkpoint.layer, candidates: checkpoint.candidates.filter(candidate => Number.isFinite(candidate.rank) && candidate.rank >= 1).slice(0, wordCount) }));
    const final = snapshot?.candidates?.filter(candidate => candidate.id !== undefined).slice(0, wordCount).map((candidate, index) => ({ id: candidate.id!, piece: candidate.piece, rank: index + 1 })) ?? [];
    if (final.length) columns.push({ label: 'Final', layer: -1, candidates: final });
    const width = Math.max(280, this.width); const columnWidth = width / columns.length;
    const rowHeight = (height - 18) / wordCount; const boxHeight = Math.max(10, Math.min(42, rowHeight - 4));
    const graph = svg(this.doc, 'svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Top words at measured logit-lens checkpoints and final sampling distribution' });
    graph.append(svg(this.doc, 'title', {}, 'Intermediate checkpoints project the measured residual through final normalization and the vocabulary head. Final ranks are post-sampling; they use a different distribution. Lines connect only matching token IDs.'));
    const x = (index: number) => columnWidth * (index + 0.5);
    const y = (index: number) => 18 + rowHeight * (index + .5);
    const boxWidth = Math.min(columnWidth - 18, 170);
    columns.forEach((column, columnIndex) => {
      const next = columns[columnIndex + 1];
      if (!next) return;
      column.candidates.forEach((candidate, rankIndex) => {
        const nextRank = next.candidates.findIndex(value => value.id === candidate.id);
        if (nextRank < 0) return;
        graph.append(svg(this.doc, 'path', { d: `M${x(columnIndex) + boxWidth / 2},${y(rankIndex) - 4} C${x(columnIndex) + columnWidth / 2},${y(rankIndex) - 4} ${x(columnIndex + 1) - columnWidth / 2},${y(nextRank) - 4} ${x(columnIndex + 1) - boxWidth / 2},${y(nextRank) - 4}`, fill: 'none', stroke: '#b59bd6', 'stroke-width': 1.7, 'data-lens-path-token': candidate.id }));
      });
    });
    const description: string[] = [];
    columns.forEach((column, columnIndex) => {
      graph.append(svg(this.doc, 'text', { x: x(columnIndex), y: 12, 'text-anchor': 'middle', class: 'la-lens-layer', 'data-lens-checkpoint': column.layer }, column.label));
      column.candidates.forEach((candidate, index) => {
        const label = candidate.piece ? tokenLabel(candidate.piece) : `#${candidate.id}`;
        const maxChars = Math.max(3, Math.floor((boxWidth - 22) / (this.height >= 950 ? 9 : 6.2)));
        const group = svg(this.doc, 'g', { 'data-lens-token': candidate.id, 'data-lens-layer': column.layer, 'data-rank': candidate.rank, 'aria-label': `${column.label}, rank ${candidate.rank}: ${JSON.stringify(candidate.piece)}, token ${candidate.id}` });
        group.append(svg(this.doc, 'title', {}, `${column.label} · rank ${candidate.rank} · token ${candidate.id} · ${JSON.stringify(candidate.piece)}`));
        group.append(svg(this.doc, 'rect', { x: x(columnIndex) - boxWidth / 2, y: y(index) - boxHeight / 2 - 5, width: boxWidth, height: boxHeight, rx: 2, fill: '#f4f0f8' }));
        group.append(svg(this.doc, 'text', { x: x(columnIndex) - boxWidth / 2 + 4, y: y(index) - 2, class: 'la-lens-rank' }, String(candidate.rank)));
        group.append(svg(this.doc, 'text', { x: x(columnIndex) + 4, y: y(index) - 2, 'text-anchor': 'middle', class: 'la-lens-word' }, label.length > maxChars ? label.slice(0, maxChars - 1) + '…' : label));
        graph.append(group); description.push(`${column.label} rank ${candidate.rank}: ${JSON.stringify(candidate.piece)}, ID ${candidate.id}`);
      });
    });
    graph.setAttribute('aria-description', description.join('; '));
    plot.append(graph);
  }
  private renderCandidates(snapshot?: ObservatorySnapshot): void {
    const container = this.el('[data-candidates]');
    const panelHeight = this.el('[data-next-panel]').clientHeight || this.height * .35;
    const large = this.height >= 950;
    const capacity = Math.floor((panelHeight - (large ? 170 : this.height >= 520 ? 110 : 76)) / (large ? 35 : this.height >= 520 ? 23 : 18));
    const limit = capacity >= 8 ? 8 : capacity >= 5 ? 5 : 3;
    container.dataset.candidateBudget = String(limit);
    const valid = snapshot?.candidates?.filter(candidate => Number.isFinite(candidate.probability) && candidate.probability >= 0) ?? [];
    const candidates = valid.slice(0, limit);
    const chosen = valid.find(candidate => snapshot?.sampled && (candidate.id === undefined ? candidate.piece === snapshot.sampled.piece : candidate.id === snapshot.sampled.id));
    if (chosen && !candidates.includes(chosen)) candidates[candidates.length - 1] = chosen;
    container.replaceChildren();
    for (const candidate of candidates) {
      const row = this.doc.createElement('div'); row.className = 'la-candidate'; row.dataset.candidateId = candidate.id === undefined ? '' : String(candidate.id);
      const selected = candidate === chosen; row.dataset.sampled = String(selected);
      const label = this.doc.createElement('span'); label.textContent = `${selected ? '✓ ' : ''}${candidate.piece ? tokenLabel(candidate.piece) : candidate.id === undefined ? '∅' : `#${candidate.id}`}`;
      label.title = `Token ${candidate.id ?? 'ID not reported'} · ${JSON.stringify(candidate.piece)}`;
      const probability = this.doc.createElement('span'); probability.textContent = `${format(candidate.probability * 100, 2)}%`;
      row.style.setProperty('--probability', `${Math.max(0, Math.min(1, candidate.probability)) * 100}%`); row.append(label, probability); container.append(row);
    }
    this.el('[data-next-panel]').dataset.state = candidates.length ? 'available' : 'waiting';
    this.el('[data-candidate-reading]').textContent = candidates.length ? 'Final · post-sampling probabilities' : 'Final probabilities not reported for this step.';
  }
}
