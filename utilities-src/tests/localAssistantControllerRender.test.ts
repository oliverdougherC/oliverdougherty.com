/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalAssistantController } from '../src/localAssistantController';
import { ObservatoryView } from '../src/local-assistant/observatoryView';
import type { ModelInfo, Observation, Runtime } from '../src/local-assistant/types';
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
  el<HTMLTextAreaElement>('[data-input]').value = 'Hello';
  el('[data-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(0);
  return { root, el, runtime, rawUpdate: (content: string, observation: Observation) => update(content, '', observation), update: async (content: string, reasoning = '', observation: Observation = {}) => { update(content, reasoning, observation); await vi.advanceTimersByTimeAsync(55); } };
}
beforeEach(() => {
  vi.useFakeTimers();
  // Canvas pixels are checked in the browser suite; these tests exercise wiring.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.destroy(); document.getSelection()?.removeAllRanges(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.useRealTimers(); });
describe('assistant streaming presentation', () => {
  it('forwards real prompt progress and captures every pass before rendering is throttled', async () => {
    const capture = vi.spyOn(ObservatoryView.prototype, 'ingest');
    const progress = vi.spyOn(ObservatoryView.prototype, 'setProgress');
    try {
      const { rawUpdate } = await setup();
      const prompt = [{ id: 7, piece: 'question' }, { id: 8, piece: '<answer>' }];
      rawUpdate('', { stage: 'prefill', promptTokens: prompt, promptProcessed: 1, promptTotal: 2 });
      expect(progress).toHaveBeenLastCalledWith(1, 2);
      for (let i = 1; i <= 10; i++) rawUpdate(`Answer ${i}`, {
        stage: 'decode', token: { id: 100 + i, piece: `word${i}` }, generated: i, pass: i + 1, contextUsed: i + 2,
        attention: [{ layer: 1, queryPosition: i, keyCount: i + 1, headCount: 4, entries: [{ position: 0, weight: 0.25 }] }],
        layerChanges: [{ layer: 0, relativeDelta: i / 10 }],
        lens: [{ layer: 0, candidates: [{ id: 101, piece: 'word1', probability: 0.1 }] }],
      });
      rawUpdate('Answer 10', { generated: 10, tokensPerSecond: 50 });
      expect(capture).toHaveBeenCalledTimes(10);
      expect(capture.mock.calls[0][0]).toMatchObject({ step: 2,
        query: { id: 8, piece: '<answer>', position: 1 }, sampled: { id: 101, position: 2 },
        deltas: [{ layer: 0, value: 0.1 }], lens: [{ layer: 0, candidates: [{ id: 101, rank: 1, probability: 0.1 }] }],
      });
      expect(capture.mock.calls[1][0].query).toEqual({ id: 101, piece: 'word1', position: 2 });
    } finally { capture.mockRestore(); progress.mockRestore(); }
  });
  it('does not label an unmeasured callback as a forward pass', async () => {
    const capture = vi.spyOn(ObservatoryView.prototype, 'ingest');
    try {
      const { rawUpdate } = await setup();
      rawUpdate('', { promptTokens: [{ id: 7, piece: 'question' }], stage: 'prefill' });
      rawUpdate('Answer', { token: { id: 9, piece: 'Answer' }, generated: 1, contextUsed: 2 });
      expect(capture).not.toHaveBeenCalled();
      rawUpdate('Answer.', { token: { id: 10, piece: '.' }, generated: 2, contextUsed: 3, pass: 8,
        attention: [{ layer: 1, queryPosition: 1, keyCount: 2, headCount: 4, entries: [{ position: 1, weight: 0.3 }] }] });
      expect(capture.mock.calls[0][0].query).toEqual({ id: 9, piece: 'Answer', position: 1 });
    } finally { capture.mockRestore(); }
  });
  it('clears observation history when starting a new turn', async () => {
    const reset = vi.spyOn(ObservatoryView.prototype, 'reset');
    try {
      const { el, update } = await setup();
      await update('Answer', '', { token: { id: 9, piece: 'Answer' }, generated: 1, pass: 4 });
      el('[data-stop]').click();
      reset.mockClear();
      el<HTMLTextAreaElement>('[data-input]').value = 'Another question';
      el('[data-form]').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(reset).toHaveBeenCalled();
    } finally { reset.mockRestore(); }
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
  it('removes redundant chrome and keeps reasoning separate from the answer', async () => {
    const { root, el, update } = await setup();
    expect(root.querySelector('.la-topbar, .la-disclaimer, .la-observe-note')).toBeNull();
    expect(el('[data-form]').contains(el('[data-new]'))).toBe(true);
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


  it('uses a real token ID for an empty decoded candidate', async () => {
    const { el, update } = await setup();
    await update('Done', '', { token: { id: 248046, piece: '' }, generated: 1, pass: 1, candidates: [{ id: 248045, piece: '', probability: 0.2 }, { id: 248046, piece: '', probability: 0.8 }] });
    expect(el('[data-candidates]').textContent).toContain('✓ #248046');
    expect(el('[data-candidates]').textContent).not.toContain('✓ #248045');
  });
  it('shows the sampled candidate even when outside the top three', async () => {
    const { el, update } = await setup();
    await update('four', '', { token: { id: 4, piece: 'four' }, generated: 1, pass: 1, candidates: [1, 2, 3, 4].map(id => ({ id, piece: ['one', 'two', 'three', 'four'][id - 1], probability: 1 / id })) });
    expect(el('[data-candidates]').textContent).toContain('✓ four');
    expect(el('[data-candidates]').children).toHaveLength(3);
  });
});
describe('assistant entry transitions', () => {
  async function gatedSetup() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runtime: Runtime = {
      load: vi.fn(async (): Promise<ModelInfo> => { await gate; return { name: 'Test', context: 4096, layers: ['deltanet', 'attention'], backend: 'Test' }; }),
      generate: vi.fn(async () => {}), reset: vi.fn(async () => {}), dispose: vi.fn(async () => {})
    };
    const root = document.createElement('section'); document.body.append(root);
    const controller = new LocalAssistantController(root, () => runtime); controllers.push(controller); controller.init();
    await vi.advanceTimersByTimeAsync(0);
    const el = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
    return { el, release };
  }
  it('enters the chat automatically when the model is ready without an open Snake game', async () => {
    const { el, release } = await gatedSetup();
    expect(el('[data-welcome]').hidden).toBe(false);
    expect(el('[data-enter]').hidden).toBe(true);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(el('[data-welcome]').hidden).toBe(true);
    expect(el('[data-chat]').hidden).toBe(false);
    expect(el('[data-enter]').hidden).toBe(true);
    expect(document.activeElement).toBe(el('[data-input]'));
  });
  it('keeps the welcome and shows Enter chat when the model is ready mid-Snake', async () => {
    const { el, release } = await gatedSetup();
    el('[data-play]').click();
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(el('[data-welcome]').hidden).toBe(false);
    expect(el('[data-chat]').hidden).toBe(true);
    expect(el('[data-enter]').hidden).toBe(false);
    expect(el('[data-announcement]').textContent).toContain('Enter chat');
    el('[data-enter]').click();
    expect(el('[data-chat]').hidden).toBe(false);
    expect(el('[data-enter]').hidden).toBe(true);
  });
});
