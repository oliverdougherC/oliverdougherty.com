/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservatoryView } from '../src/local-assistant/observatoryView';
import type { ObservatorySnapshot } from '../src/local-assistant/observatory';
let view: ObservatoryView; let host: HTMLElement;
const sample = (step: number): ObservatorySnapshot => ({ step, query: { position: 2, id: 12, piece: 'query' }, sampled: { position: step + 2, id: 99, piece: 'output' }, layerCount: 4,
  attention: [{ layer: 3, queryPosition: 2, keyCount: 3, headCount: 8, coverage: .67, entries: [{ position: 0, weight: .41 }, { position: 1, weight: .19 }, { position: 2, weight: .07 }] }],
  deltas: [{ layer: 0, value: step / 100 }, { layer: 3, value: .4 }],
  lens: [{ layer: 1, candidates: [{ id: 77, piece: 'early', rank: 1 }, { id: 99, piece: 'output', rank: 2 }] }, { layer: 2, candidates: [{ id: 99, piece: 'output', rank: 1 }, { id: 78, piece: 'late', rank: 2 }] }],
  candidates: [{ id: 99, piece: 'output', probability: .6 }, { id: 100, piece: '', probability: .2 }] });
const el = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector)!;
beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), strokeRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  host = document.createElement('div'); document.body.append(host); view = new ObservatoryView(host);
  view.setContext([{ id: 10, piece: 'first source token' }, { id: 11, piece: 'second' }, { id: 12, piece: 'query' }]); view.setLayers(['deltanet', 'deltanet', 'deltanet', 'attention']);
});
afterEach(() => { view.destroy(); document.body.replaceChildren(); vi.restoreAllMocks(); });
describe('linked runtime views', () => {
  it('displays original attention weights and full accessible source identity', () => {
    view.ingest(sample(1)); view.render();
    const edge = el<SVGElement>('[data-key-position="0"]');
    expect(edge.dataset.attentionWeight).toBe('0.41');
    expect(edge.getAttribute('aria-label')).toContain('first source token');
    expect(edge.getAttribute('aria-label')).toContain('token 10');
    expect(el('[data-attention-reading]').textContent).toContain('Shown 67%');
  });
  it('pins attention on keyboard focus and preserves the same focused edge during later samples', () => {
    view.ingest(sample(1)); view.render();
    const edge = el<SVGElement>('[data-key-position="0"]');
    edge.focus();
    expect(host.dataset.pinned).toBe('true');
    view.ingest(sample(2)); view.render();
    expect(document.activeElement).toBe(edge);
    expect(el('[data-key-position="0"]')).toBe(edge);
    expect(host.dataset.selectedStep).toBe('1');
  });
  it('shows actual intermediate words even when they are absent from final candidates', () => {
    view.ingest(sample(1)); view.render();
    expect(el('[data-lens-plot]').textContent).toContain('early');
    expect(el('[data-lens-plot]').textContent).toContain('late');
    expect(el('[data-lens-plot]').textContent).toContain('Final');
    expect(host.querySelectorAll('[data-lens-path-token="99"]')).toHaveLength(2);
    expect(host.querySelector('[data-lens-path-token="77"]')).toBeNull();
  });
  it('pins all panels and the displayed history window until explicit Live, even across eviction', () => {
    view.ingest(sample(1)); view.ingest(sample(2)); view.render();
    const canvas = el<HTMLElement>('[data-delta-waterfall]');
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(host.dataset.selectedStep).toBe('1'); expect(host.dataset.pinned).toBe('true');
    const window = canvas.dataset.steps;
    for (let step = 3; step < 300; step++) view.ingest(sample(step));
    view.render();
    expect(host.dataset.selectedStep).toBe('1'); expect(canvas.dataset.steps).toBe(window);
    expect(el('[data-delta-inspection]').textContent).toContain('0.01');
    el<HTMLElement>('[data-observatory-live]').click();
    expect(host.dataset.selectedStep).toBe('299'); expect(host.dataset.pinned).toBe('false');
  });
  it('navigates the same frozen steps by keyboard, slider and pointer after eviction', () => {
    view.ingest(sample(1)); view.ingest(sample(2)); view.render();
    const canvas = el<HTMLCanvasElement>('[data-delta-waterfall]');
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    for (let step = 3; step <= 300; step++) view.ingest(sample(step));
    view.render();
    canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(host.dataset.selectedStep).toBe('2'); expect(canvas.dataset.steps).toBe('1,2');
    const range = el<HTMLInputElement>('[data-history-step]');
    expect(range.max).toBe('1');
    range.value = '0'; range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.dataset.selectedStep).toBe('1');
    range.value = '1'; range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(host.dataset.selectedStep).toBe('2');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 300, height: 100 } as DOMRect);
    canvas.dispatchEvent(new MouseEvent('click', { clientX: 2, clientY: 10, bubbles: true }));
    expect(host.dataset.selectedStep).toBe('1'); expect(canvas.dataset.steps).toBe('1,2');
  });
  it('clears every view at a turn reset without fabricating unavailable measurements', () => {
    view.ingest(sample(1)); view.render(); view.reset(); view.setProgress(5, 100); view.render();
    expect(host.dataset.historyCount).toBe('0'); expect(el('[data-observation-step]').textContent).toContain('5 / 100');
    expect(host.querySelector('[data-attention-weight]')).toBeNull(); expect(el('[data-candidates]').children).toHaveLength(0);
    expect(el('[data-next-panel]').getAttribute('data-state')).toBe('waiting');
  });
  it('uses three readable compact axis labels while preserving every layer row', () => {
    view.setLayers(Array.from({ length: 24 }, () => 'deltanet'));
    Object.defineProperty(el('[data-delta-waterfall]'), 'clientHeight', { configurable: true, value: 40 });
    view.ingest(sample(1)); view.render();
    const labels = Array.from(el('[data-waterfall-axis]').children).map(node => node.textContent).filter(Boolean);
    expect(labels).toEqual(['1', '12', '24']);
    expect(el('[data-waterfall-axis]').children).toHaveLength(24);
    expect(el('[data-delta-waterfall]').getAttribute('data-layers')).toBe('24');
  });
  it('uses the actual short SVG height and fewer measured words instead of compressing glyphs', () => {
    const plot = el('[data-lens-plot]'); Object.defineProperty(plot, 'clientHeight', { configurable: true, value: 60 });
    const snapshot = sample(1);
    snapshot.lens!.forEach(checkpoint => checkpoint.candidates.push({ id: 105, piece: 'third', rank: 3 }));
    snapshot.candidates!.push({ id: 105, piece: 'third', probability: .1 });
    view.ingest(snapshot); view.render();
    expect(plot.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 320 60');
    expect(plot.querySelectorAll('[data-lens-layer="1"]')).toHaveLength(2);
    expect(plot.querySelector('[data-lens-token="105"]')).toBeNull();
    Object.defineProperty(plot, 'clientHeight', { configurable: true, value: 100 }); view.render();
    expect(plot.querySelectorAll('[data-lens-layer="1"]')).toHaveLength(3);
    expect(plot.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 320 100');
  });
  it('budgets final rows from the actual panel height at the large-density boundary', () => {
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 950 });
    Object.defineProperty(el('[data-next-panel]'), 'clientHeight', { configurable: true, value: 305 });
    view.resize();
    const snapshot = sample(1); snapshot.candidates = Array.from({ length: 8 }, (_, index) => ({ id: 99 + index, piece: `word${index}`, probability: 1 / (index + 2) }));
    view.ingest(snapshot); view.render();
    expect(el('[data-candidates]').children).toHaveLength(3);
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 1800 });
    Object.defineProperty(el('[data-next-panel]'), 'clientHeight', { configurable: true, value: 600 });
    view.resize(); view.render();
    expect(el('[data-candidates]').children).toHaveLength(8);
  });
  it('keeps the sampled candidate visible by ID, including empty decoded tokens', () => {
    const snapshot = sample(1); snapshot.sampled = { id: 104, piece: '' };
    snapshot.candidates = Array.from({ length: 5 }, (_, index) => ({ id: 100 + index, piece: '', probability: (5 - index) / 15 }));
    view.ingest(snapshot); view.render();
    expect(el('[data-candidates]').children).toHaveLength(3);
    expect(el('[data-sampled="true"]').getAttribute('data-candidate-id')).toBe('104');
    expect(el('[data-sampled="true"]').textContent).toContain('#104');
  });
});
