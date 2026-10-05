import { describe, expect, it, vi } from 'vitest';
import { AssistantRuntime, isRepeatingTokenLoop } from '../src/local-assistant/runtime';
import { AssistantSession } from '../src/local-assistant/session';

describe('Local Assistant repeating output protection', () => {
  it.each([1, 2, 3, 5, 7, 16, 31, 32])('recognizes a sustained cycle of period %i', period => {
    const tokens = Array.from({ length: Math.max(32, period * 6) }, (_, i) => i % period);
    expect(isRepeatingTokenLoop([991, 992, ...tokens])).toBe(true);
  });
  it('allows short deliberate repetitions and similar phrases with changing tokens', () => {
    expect(isRepeatingTokenLoop(Array(16).fill(42))).toBe(false);
    expect(isRepeatingTokenLoop(Array.from({ length: 160 }, (_, i) => i % 8 === 7 ? i : i % 8))).toBe(false);
    expect(isRepeatingTokenLoop(Array.from({ length: 192 }, (_, i) => i))).toBe(false);
  });
  it('requires an uninterrupted repeating suffix', () => {
    const tokens = Array.from({ length: 64 }, (_, i) => i % 3);
    expect(isRepeatingTokenLoop([...tokens, 999])).toBe(false);
  });
});

function readyRuntime(createChatCompletion: (options: any) => Promise<void>) {
  const runtime = new AssistantRuntime();
  const engine = { createChatCompletion, setSlowMode: vi.fn() };
  Object.assign(runtime, { engine, info: { context: 4096 } });
  return { runtime, engine };
}

describe('Local Assistant native stream adaptation', () => {
  it.each(['answer', 'reasoning'])('reports a normally streamed context limit and preserves partial %s', async kind => {
    let attempt = 0;
    const { runtime } = readyRuntime(async options => {
      attempt++;
      options.onData({ choices: [{ delta: attempt > 1 ? { content: 'Recovered' } : kind === 'answer' ? { content: 'Partial answer' } : { reasoning_content: 'Unfinished reasoning' } }] });
      options.onData({ choices: [{ delta: {}, finish_reason: attempt > 1 ? 'stop' : 'length' }],
        timings: { prompt_ms: 1, predicted_per_second: 10, predicted_n: 4096 } });
    });
    const load = vi.fn(async () => ({ name: 'Test', context: 4096, layers: [] as [], backend: 'Test' }));
    const reset = vi.fn(async () => {});
    const session = new AssistantSession(() => ({ load, generate: runtime.generate.bind(runtime), reset, dispose: async () => {} }));
    try {
      await session.activate(); await session.send('Question');
      expect(session.state.phase).toBe('error');
      expect(session.state.status).toMatch(/context.*full.*new chat/i);
      expect(session.state.observation).toMatchObject({ finishReason: 'length', generated: 4096 });
      expect(session.state.messages.at(-1)).toMatchObject(kind === 'answer' ? { content: 'Partial answer' } : { content: '', reasoning: 'Unfinished reasoning' });
      await session.reset(); await session.send('Fresh question');
      expect(reset).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledOnce();
      expect(session.state.phase).toBe('ready');
      expect(session.state.observation).toMatchObject({ finishReason: 'stop' });
      expect(session.state.messages.at(-1)?.content).toBe('Recovered');
    } finally { await session.destroy(); }
  });
  it('marks thrown context exhaustion with the same recovery signal', async () => {
    const updates = vi.fn();
    const { runtime } = readyRuntime(async options => {
      options.onData({ choices: [{ delta: { reasoning_content: 'Thinking so far' } }] });
      throw new Error('context size exceeded');
    });
    await expect(runtime.generate([{ role: 'user', content: 'Question' }], true, new AbortController().signal, updates)).rejects.toThrow(/context.*full/i);
    expect(updates).toHaveBeenLastCalledWith('', 'Thinking so far', { finishReason: 'length' });
  });

  it('maps measured snapshots without carrying optional telemetry into another token', async () => {
    const updates = vi.fn();
    const { runtime } = readyRuntime(async options => {
      options.onData({ choices: [], observatory: {
        token: { id: 42, piece: 'Paris' }, generated: 1, pass: 8,
        attention: [{ layer: 3, query_position: 19, key_count: 20, head_count: 16,
          entries: [{ position: 4, weight: 0.25 }], coverage: 0.25 }],
        layer_changes: [{ layer: 0, input_rms: 2, delta_rms: 1, relative_delta: 0.5 }],
        lens: [{ layer: 11, candidates: [{ id: 42, piece: 'Paris', probability: 0.125 }] }],
      } });
      options.onData({ choices: [], observatory: { token: { id: 43, piece: '.' }, generated: 2, pass: 9 } });
    });
    await runtime.generate([{ role: 'user', content: 'Capital?' }], false, new AbortController().signal, updates);
    expect(updates.mock.calls[0][2]).toMatchObject({
      attention: [{ layer: 3, queryPosition: 19, keyCount: 20, headCount: 16,
        entries: [{ position: 4, weight: 0.25 }], coverage: 0.25 }],
      layerChanges: [{ layer: 0, inputRms: 2, deltaRms: 1, relativeDelta: 0.5 }],
      lens: [{ layer: 11, candidates: [{ id: 42, piece: 'Paris', probability: 0.125 }] }],
    });
    const merged = { ...updates.mock.calls[0][2], ...updates.mock.calls[1][2] };
    expect(merged.attention).toBeUndefined(); expect(merged.layerChanges).toBeUndefined();
    expect(merged.lens).toBeUndefined(); expect(merged.pass).toBe(9);
  });
  it('requests unlimited output and does not fail at the retired 1024-token limit', async () => {
    const updates = vi.fn();
    const { runtime } = readyRuntime(async options => {
      expect(options.max_tokens).toBe(-1);
      for (let generated = 1; generated <= 1100; generated++) {
        options.onData({ choices: [], observatory: { token: { id: generated, piece: 'x' }, generated } });
      }
      options.onData({ choices: [{ delta: {}, finish_reason: 'stop' }], timings: { prompt_ms: 1, predicted_per_second: 60, predicted_n: 1100 } });
    });
    await expect(runtime.generate([{ role: 'user', content: 'Long answer' }], true, new AbortController().signal, updates)).resolves.toBeUndefined();
    expect(updates).toHaveBeenLastCalledWith('', '', expect.objectContaining({ generated: 1100 }));
  });
  it('reports actual prefill progress before any generated-token count', async () => {
    const updates = vi.fn();
    const { runtime } = readyRuntime(async options => {
      options.onData({ choices: [], prompt_progress: { processed: 0, total: 80, cache: 0, time_ms: 0 }, observatory: { prompt_tokens: [{ id: 7, piece: '<control>' }] } });
      options.onData({ choices: [{ delta: { content: null } }], prompt_progress: { processed: 64, total: 80, cache: 0, time_ms: 20 }, timings: { prompt_ms: 20, predicted_per_second: 0, predicted_n: 0 } });
      options.onData({ choices: [{ delta: { reasoning_content: 'Think' } }], observatory: { token: { id: 42, piece: 'Think' }, generated: 1, pass: 3, layer_backend: 'WebGPU' } });
    });
    await runtime.generate([{ role: 'user', content: 'Question' }], true, new AbortController().signal, updates);
    expect(updates.mock.calls[0][2]).toMatchObject({ stage: 'prefill', promptProcessed: 0, promptTotal: 80 });
    expect(updates.mock.calls[1][2]).toMatchObject({ stage: 'prefill', promptProcessed: 64, promptTotal: 80 });
    expect(updates.mock.calls[0][2]).not.toHaveProperty('generated');
    expect(updates.mock.calls[1][2]).not.toHaveProperty('generated');
    expect(updates.mock.calls[2][2]).toMatchObject({ stage: 'decode', generated: 1, pass: 3, layerBackend: 'WebGPU' });
  });
  it('cancels the native request when a short phrase loops and preserves its text', async () => {
    const updates = vi.fn();
    const { runtime } = readyRuntime(async options => {
      for (let generated = 1; generated < 100; generated++) {
        options.onData({ choices: [{ delta: { content: 'repeat ' } }], observatory: { token: { id: generated % 3, piece: 'repeat ' }, generated } });
        if (options.abortSignal.aborted) throw new DOMException('Cancelled', 'AbortError');
      }
    });
    await expect(runtime.generate([{ role: 'user', content: 'Question' }], false, new AbortController().signal, updates)).rejects.toThrow('repeating token loop');
    expect(updates).toHaveBeenCalledTimes(32);
    expect(updates.mock.calls.at(-1)?.[0]).toBe('repeat '.repeat(32));
  });
  it('forwards live Slow changes directly to the native pull loop', () => {
    const { runtime, engine } = readyRuntime(async () => {});
    runtime.setSlowMode(true);
    runtime.setSlowMode(false);
    expect(engine.setSlowMode.mock.calls).toEqual([[true], [false]]);
  });
});
