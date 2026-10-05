/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAssistantController } from '../src/localAssistantController';
import type { Observation, Runtime } from '../src/local-assistant/types';
vi.mock('../src/local-assistant/runtime', () => ({ createAssistantRuntime: vi.fn() }));
const controllers: LocalAssistantController[] = [];
async function setup() {
  let update!: (content: string, reasoning: string, observation: Observation) => void;
  const runtime: Runtime = {
    setSlowMode: vi.fn(),
    async load() { return { name: 'Test', context: 4096, layers: ['deltanet', 'attention'], backend: 'Test' }; },
    async generate(_messages, _thinking, signal, callback) { update = callback; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
    async reset() {}, async dispose() {}
  };
  const root = document.createElement('section'); document.body.append(root);
  const controller = new LocalAssistantController(root, () => runtime); controllers.push(controller); controller.init();
  await vi.advanceTimersByTimeAsync(0);
  const el = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  el('[data-enter]').click();
  el<HTMLTextAreaElement>('[data-input]').value = 'Hello';
  el('[data-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  return { root, el, runtime, rawUpdate: (content: string, observation: Observation) => update(content, '', observation), update: async (content: string, reasoning = '', observation: Observation = {}) => { update(content, reasoning, observation); await vi.advanceTimersByTimeAsync(55); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.destroy(); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.useRealTimers(); });
describe('assistant streaming presentation', () => {
  it('shows only the active token stage with real prompt progress', async () => {
    const { el, update } = await setup();
    await update('', '', { stage: 'prefill', promptTokens: [1, 2, 3, 4].map(id => ({ id, piece: `prompt${id}` })), promptProcessed: 2, promptTotal: 4 });
    expect(el('[data-token-stage]').textContent).toBe('Prompt processing');
    expect(el('[data-token-range]').textContent).toBe('2 / 4');
    expect(el('[data-tokens]').querySelectorAll('.is-pending')).toHaveLength(2);
    await update('Answer', '', { stage: 'decode', token: { id: 9, piece: 'Answer' }, generated: 1 });
    expect(el('[data-token-stage]').textContent).toBe('Output tokens');
    expect(el('[data-tokens]').querySelectorAll('button')).toHaveLength(1);
    expect(el('[data-tokens] button').dataset.tokenId).toBe('9');
  });
  it('keeps Slow live and leaves actual reasoning collapsed with an active indicator', async () => {
    const { el, runtime, update } = await setup();
    const slow = el<HTMLInputElement>('[data-slow]');
    expect(slow.disabled).toBe(false); slow.click();
    expect(runtime.setSlowMode).toHaveBeenLastCalledWith(true);
    await update('', 'Actual reasoning');
    expect(el<HTMLDetailsElement>('details').open).toBe(false);
    expect(el('details').classList.contains('is-thinking')).toBe(true);
    el('[data-stop]').click();
    expect(el('details').classList.contains('is-thinking')).toBe(false);
  });
  it('clears selected inspection when the active token stage changes', async () => {
    const { el, update } = await setup();
    await update('', '', { stage: 'prefill', promptTokens: [{ id: 1, piece: 'prompt' }], promptProcessed: 0, promptTotal: 1 });
    el('[data-tokens] button').click();
    expect(el('[data-token-inspection]').hidden).toBe(false);
    await update('output', '', { stage: 'decode', token: { id: 2, piece: 'output' }, generated: 1 });
    expect(el('[data-token-inspection]').hidden).toBe(true);
  });
  it('retains keyboard focus as a rolling token window evicts its oldest token', async () => {
    const { el, rawUpdate } = await setup();
    for (let i = 1; i <= 8; i++) rawUpdate(`t${i}`, { token: { id: i, piece: `t${i}` }, generated: i });
    await vi.advanceTimersByTimeAsync(55);
    el('[data-tokens] button').focus();
    rawUpdate('t9', { token: { id: 9, piece: 't9' }, generated: 9 });
    await vi.advanceTimersByTimeAsync(55);
    expect((document.activeElement as HTMLElement).dataset.tokenId).toBe('2');
    expect(el('[data-tokens]').querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect((document.activeElement as HTMLElement).dataset.tokenId).toBe('3');
  });
  it('uses the real RMS values for a shared-scale layer chart', async () => {
    const { el, update } = await setup();
    await update('answer', '', { pass: 4, layers: [{ layer: 0, rms: 0.2 }, { layer: 1, rms: 0.4 }] });
    const first = el('[data-inspect-layer="0"] [data-layer-bar]');
    const second = el('[data-inspect-layer="1"] [data-layer-bar]');
    expect(first.dataset.rms).toBe('0.2'); expect(second.dataset.rms).toBe('0.4');
    expect(first.style.transform).toBe('scaleY(0.5)'); expect(second.style.transform).toBe('scaleY(1)');
    expect(el('[data-layer-pass]').textContent).toBe('Pass 4');
  });

  it('keeps Cancel recoverable while stopping hidden-stage rendering', async () => {
    const runtime: Runtime = {
      load: vi.fn(async () => new Promise<never>(() => {})), generate: vi.fn(async () => {}),
      reset: vi.fn(async () => {}), dispose: vi.fn(async () => {})
    };
    const root = document.createElement('section'); document.body.append(root);
    const controller = new LocalAssistantController(root, () => runtime); controllers.push(controller); controller.init();
    root.querySelector<HTMLButtonElement>('[data-cancel]')!.click();
    expect(root.dataset.phase).toBe('idle');
    const retry = root.querySelector<HTMLButtonElement>('[data-retry]')!;
    expect(retry.hidden).toBe(false);
    retry.click(); await vi.advanceTimersByTimeAsync(0);
    expect(runtime.load).toHaveBeenCalledTimes(2);
    root.dispatchEvent(new Event('utility-deactivate'));
    expect(root.dataset.phase).toBe('idle');
    root.dispatchEvent(new Event('utility-activate'));
    expect(root.dataset.phase).toBe('loading');
  });

  it('retains open reasoning, focus and copy control identities during updates', async () => {
    const { el, update } = await setup();
    await update('First answer', 'Reasoning begins');
    const details = el<HTMLDetailsElement>('details'); details.open = true;
    const summary = el('summary'); summary.focus();
    const copy = el('[data-copy-message]');
    await update('First answer continues', 'Reasoning continues');
    expect(el('details')).toBe(details); expect(details.open).toBe(true);
    expect(document.activeElement).toBe(summary); expect(el('[data-copy-message]')).toBe(copy);
    expect(el('.la-message--assistant .la-message-body').textContent).toContain('continues');
  });
  it('replaces prefill placeholder after stop even without a single token', async () => {
    const { el } = await setup();
    expect(el('.la-message--assistant .la-message-body').textContent).toBe('Generating…');
    el('[data-stop]').click();
    expect(el('.la-message--assistant .la-message-body').textContent).toBe('No response generated.');
  });
  it('defers selected output updates until selection is released', async () => {
    const { el, update } = await setup();
    await update('Select this answer.');
    const body = el('.la-message--assistant .la-message-body');
    (document.activeElement as HTMLElement)?.blur();
    const range = document.createRange(); range.selectNodeContents(body);
    document.getSelection()!.addRange(range);
    await update('Select this answer. More text.');
    expect(body.textContent).toBe('Select this answer.');
    document.getSelection()!.removeAllRanges(); document.dispatchEvent(new Event('selectionchange'));
    expect(body.textContent).toContain('More text.');
  });
  it('removes redundant chrome and only shows token details after selection', async () => {
    const { root, el, update } = await setup();
    expect(root.querySelector('.la-topbar, .la-disclaimer, .la-observe-note')).toBeNull();
    expect(el('[data-form]').contains(el('[data-new]'))).toBe(true);
    expect(el('[data-token-inspection]').hidden).toBe(true);
    await update('', 'Actual reasoning');
    expect(el('.la-message--assistant .la-message-body').hidden).toBe(true);
    expect(el('summary').textContent).toBe('Thinking');
    await update('The final answer.', 'Actual reasoning');
    expect(el('.la-message--assistant .la-message-body').hidden).toBe(false);
  });
  it('acknowledges a copy in the existing button without adding another message', async () => {
    const { el, update } = await setup();
    await update('Copy this response.');
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const button = el('[data-copy-message]'); button.click();
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).toHaveBeenCalledWith('Copy this response.');
      expect(button.textContent).toBe('Copied');
      await vi.advanceTimersByTimeAsync(1600);
      expect(button.textContent).toBe('Copy');
    } finally { vi.unstubAllGlobals(); }
  });
  it('keeps keyboard inspection controls stable and displays observed token/layer values', async () => {
    const { el, update } = await setup();
    const observation = { token: { id: 42, piece: 'hello' }, generated: 1, layers: [{ layer: 1, rms: 2.5, milliseconds: 3 }] };
    await update('Hello', '', observation);
    const token = el('[data-tokens] button'); token.focus(); token.click();
    expect(el('[data-token-inspection]').textContent).toContain('42');
    await update('Hello again', '', { token: { id: 43, piece: 'again' }, generated: 2 });
    expect(el('[data-tokens] button')).toBe(token); expect(document.activeElement).toBe(token);
    const layer = el('[data-inspect-layer="1"]'); layer.focus(); layer.click();
    expect(el('[data-layer-reading]').textContent).toContain('RMS 2.5');
    await update('Hello again!', '', { layers: [{ layer: 1, rms: 3.5, milliseconds: 4 }] });
    expect(el('[data-inspect-layer="1"]')).toBe(layer); expect(document.activeElement).toBe(layer);
    expect(el('[data-layer-reading]').textContent).toContain('RMS 3.5');
  });
  it('records every generated token before throttling and deduplicates final timing updates', async () => {
    const { el, rawUpdate } = await setup();
    for (let count = 1; count <= 10; count++) rawUpdate(`Token ${count}`, { token: { id: 100 + count, piece: `token${count}` }, generated: count });
    rawUpdate('Token 10', { token: { id: 110, piece: 'token10' }, generated: 10, tokensPerSecond: 50 });
    await vi.advanceTimersByTimeAsync(55);
    const ids = Array.from(el('[data-tokens]').querySelectorAll<HTMLElement>('button')).map(node => Number(node.dataset.tokenId));
    expect(ids).toEqual([103, 104, 105, 106, 107, 108, 109, 110]);
  });
  it('uses a real token ID for an empty decoded candidate', async () => {
    const { el, update } = await setup();
    await update('Done', '', { token: { id: 248046, piece: '' }, generated: 1, candidates: [{ id: 248045, piece: '', probability: 0.2 }, { id: 248046, piece: '', probability: 0.8 }] });
    expect(el('[data-candidates]').textContent).toContain('✓ #248046');
    expect(el('[data-candidates]').textContent).not.toContain('✓ #248045');
  });
  it('shows the sampled candidate even when outside the top three', async () => {
    const { el, update } = await setup();
    await update('four', '', { token: { id: 4, piece: 'four' }, candidates: [1, 2, 3, 4].map(id => ({ id, piece: ['one', 'two', 'three', 'four'][id - 1], probability: 1 / id })) });
    expect(el('[data-candidates]').textContent).toContain('✓ four');
    expect(el('[data-candidates]').children).toHaveLength(3);
  });
});
