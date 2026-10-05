import { AssistantSession, ASSISTANT_IDLE_TIMEOUT_MS } from '../src/local-assistant/session';
import type { ModelInfo, Runtime } from '../src/local-assistant/types';

const info: ModelInfo = { name: 'Test model', context: 4096, layers: ['deltanet', 'attention'], backend: 'test' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function runtime() {
  return {
    load: vi.fn<Runtime['load']>().mockResolvedValue(info),
    generate: vi.fn<Runtime['generate']>().mockResolvedValue(undefined),
    reset: vi.fn<Runtime['reset']>().mockResolvedValue(undefined),
    dispose: vi.fn<Runtime['dispose']>().mockResolvedValue(undefined)
  };
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

describe('local assistant session lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not borrow optional measurements from an earlier sampled token', async () => {
    const model = runtime();
    model.generate.mockImplementation(async (_messages, _thinking, _signal, update) => {
      update('A', '', { token: { id: 1, piece: 'A' }, generated: 1, pass: 1, contextUsed: 20,
        layerChanges: [{ layer: 0, relativeDelta: 0.5 }],
        lens: [{ layer: 0, candidates: [{ id: 1, piece: 'A', probability: 0.5 }] }] });
      update('AB', '', { token: { id: 2, piece: 'B' }, generated: 2, pass: 2 });
      update('AB', '', { tokensPerSecond: 42 });
    });
    const session = new AssistantSession(() => model);
    await session.activate(); await session.send('Hello');
    expect(session.state.observation).toMatchObject({ pass: 2, generated: 2, tokensPerSecond: 42 });
    expect(session.state.observation.layerChanges).toBeUndefined();
    expect(session.state.observation.lens).toBeUndefined();
    expect(session.state.observation.contextUsed).toBeUndefined();
    await session.destroy();
  });

  it('clears captured inference measurements when reloading while preserving the conversation', async () => {
    const model = runtime();
    model.generate.mockImplementation(async (_messages, _thinking, _signal, update) => {
      update('Answer', '', { token: { id: 8, piece: 'Answer' }, generated: 1, pass: 4,
        layerChanges: [{ layer: 0, relativeDelta: 0.5 }] });
    });
    const session = new AssistantSession(() => model);
    await session.activate(); await session.send('Hello');
    expect(session.state.observation.pass).toBe(4);
    await session.retry();
    expect(session.state.observation).toEqual({});
    expect(session.state.messages.at(-1)?.content).toBe('Answer');
    await session.destroy();
  });

  it('is lazy, defaults thinking on, and requires an explicit chat entrance', async () => {
    const model = runtime();
    const factory = vi.fn(() => model);
    const session = new AssistantSession(factory);
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    expect(factory).not.toHaveBeenCalled();
    expect(session.state.thinking).toBe(true);
    await session.activate();
    expect(session.state).toMatchObject({ phase: 'ready', entered: false });
    session.enterChat();
    expect(session.state.entered).toBe(true);
    unsubscribe();
    const count = listener.mock.calls.length;
    session.setThinking(false);
    await session.send('Hello');
    expect(model.generate).toHaveBeenCalledWith([{ role: 'user', content: 'Hello' }], false, expect.any(AbortSignal), expect.any(Function));
    expect(listener.mock.calls).toHaveLength(count);
    await session.destroy();
  });

  it('aborts a load on deactivation and ignores its late progress and result', async () => {
    const first = runtime();
    const second = runtime();
    const load = deferred<ModelInfo>();
    first.load.mockReturnValue(load.promise);
    const session = new AssistantSession(vi.fn().mockReturnValueOnce(first).mockReturnValue(second));
    const activation = session.activate();
    const [signal, progress] = first.load.mock.calls[0];
    session.deactivate();
    expect(signal.aborted).toBe(true);
    await session.activate();
    progress(999, 999, 'stale');
    load.resolve({ ...info, name: 'Old model' });
    await activation;
    await flush();
    expect(session.state.info?.name).toBe('Test model');
    expect(session.state.status).not.toBe('stale');
    expect(first.dispose).toHaveBeenCalledOnce();
    await session.destroy();
  });

  it('stops generation, ignores stale updates, and serializes the next generation', async () => {
    const model = runtime();
    const generation = deferred<void>();
    model.generate.mockReturnValueOnce(generation.promise);
    const session = new AssistantSession(() => model);
    await session.activate();
    const sending = session.send('First');
    await flush();
    const [, , signal, update] = model.generate.mock.calls[0];
    update('Partial', 'Reasoning', { generated: 1 });
    session.setThinking(false);
    expect(session.state.thinking).toBe(true);
    session.stop();
    expect(signal.aborted).toBe(true);
    session.setThinking(false);
    const next = session.send('Second');
    await flush();
    expect(model.generate).toHaveBeenCalledOnce();
    update('Stale output', '', { generated: 50 });
    generation.resolve();
    await Promise.all([sending, next]);
    expect(model.generate).toHaveBeenCalledTimes(2);
    expect(model.generate.mock.calls[1][1]).toBe(false);
    expect(session.state.messages.some(message => message.content === 'Stale output')).toBe(false);
    await session.destroy();
  });

  it('invalidates token callbacks before synchronous abort listeners run', async () => {
    const model = runtime();
    model.generate.mockImplementation(async (_messages, _thinking, signal, update) => {
      update('Accepted answer', '', { generated: 1 });
      await new Promise<void>(resolve => signal.addEventListener('abort', () => {
        update('Stale abort answer', '', { generated: 99 });
        resolve();
      }));
    });
    const session = new AssistantSession(() => model);
    await session.activate();
    const sending = session.send('Hello');
    await flush();
    session.stop();
    await sending;
    expect(session.state.messages.at(-1)?.content).toBe('Accepted answer');
    expect(session.state.observation.generated).toBe(1);
    await session.destroy();
  });

  it('clears immediately on reset, preserves model, and resets before a queued send', async () => {
    const model = runtime();
    const generation = deferred<void>();
    const order: string[] = [];
    model.generate.mockImplementationOnce(() => generation.promise).mockImplementation(async () => { order.push('generate'); });
    model.reset.mockImplementation(async () => { order.push('reset'); });
    const session = new AssistantSession(() => model);
    await session.activate();
    const first = session.send('Forget this');
    await flush();
    const update = model.generate.mock.calls[0][3];
    const reset = session.reset();
    expect(session.state.messages).toEqual([]);
    expect(session.state.info).toEqual(info);
    update('Late output', 'Late thought', { generated: 4 });
    expect(session.state.messages).toEqual([]);
    const next = session.send('Fresh conversation');
    generation.resolve();
    await Promise.all([first, reset, next]);
    expect(order).toEqual(['reset', 'generate']);
    expect(model.generate.mock.calls[1][0]).toEqual([{ role: 'user', content: 'Fresh conversation' }]);
    expect(model.load).toHaveBeenCalledOnce();
    await session.destroy();
  });

  it('releases after five idle minutes, extends the deadline with activity, and reloads', async () => {
    const first = runtime();
    const second = runtime();
    const session = new AssistantSession(vi.fn().mockReturnValueOnce(first).mockReturnValue(second));
    await session.activate();
    session.deactivate();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_TIMEOUT_MS - 1);
    expect(first.dispose).not.toHaveBeenCalled();
    await session.activate();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_TIMEOUT_MS - 1);
    expect(first.dispose).not.toHaveBeenCalled();
    session.touchActivity();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_TIMEOUT_MS - 1);
    expect(first.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(session.state).toMatchObject({ phase: 'idle', entered: false });
    await session.send('Reload');
    expect(second.load).toHaveBeenCalledOnce();
    expect(second.generate).toHaveBeenCalledOnce();
    await session.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not time out a running generation and cancels it when deactivated', async () => {
    const model = runtime();
    const generation = deferred<void>();
    model.generate.mockReturnValueOnce(generation.promise);
    const session = new AssistantSession(() => model);
    await session.activate();
    const sending = session.send('Long answer');
    await flush();
    await vi.advanceTimersByTimeAsync(ASSISTANT_IDLE_TIMEOUT_MS * 2);
    expect(model.dispose).not.toHaveBeenCalled();
    session.deactivate();
    expect(model.generate.mock.calls[0][2].aborted).toBe(true);
    generation.resolve();
    await sending;
    await session.destroy();
  });

  it('reports unsupported environments and can retry a failed load', async () => {
    const first = runtime();
    const second = runtime();
    const error = new Error('WebGPU unavailable');
    error.name = 'NotSupportedError';
    first.load.mockRejectedValue(error);
    const session = new AssistantSession(vi.fn().mockReturnValueOnce(first).mockReturnValue(second));
    await session.activate();
    expect(session.state).toMatchObject({ phase: 'unsupported', status: 'WebGPU unavailable' });
    expect(first.dispose).toHaveBeenCalledOnce();
    await session.retry();
    expect(session.state.phase).toBe('ready');
    await session.destroy();
  });

  it('recovers from generation failure by resetting without downloading again', async () => {
    const model = runtime();
    model.generate.mockRejectedValueOnce(new Error('Device interrupted'));
    const session = new AssistantSession(() => model);
    await session.activate();
    await session.send('Fail');
    expect(session.state).toMatchObject({ phase: 'error', status: 'Device interrupted' });
    await session.reset();
    await session.send('Try again');
    expect(session.state.phase).toBe('ready');
    expect(model.load).toHaveBeenCalledOnce();
    expect(model.reset).toHaveBeenCalledOnce();
    await session.destroy();
  });

  it('does not launch duplicate generations when sends race behind loading', async () => {
    const model = runtime();
    const load = deferred<ModelInfo>();
    model.load.mockReturnValue(load.promise);
    const session = new AssistantSession(() => model);
    const activation = session.activate();
    const first = session.send('First');
    const second = session.send('Second');
    load.resolve(info);
    await Promise.all([activation, first, second]);
    expect(model.generate).toHaveBeenCalledOnce();
    await session.destroy();
  });

  it('discards a runtime whose reset fails and prevents queued generation on it', async () => {
    const first = runtime();
    const second = runtime();
    const reset = deferred<void>();
    first.reset.mockReturnValue(reset.promise);
    const session = new AssistantSession(vi.fn().mockReturnValueOnce(first).mockReturnValue(second));
    await session.activate();
    const resetting = session.reset();
    const sending = session.send('Queued');
    reset.reject(new Error('Reset failed'));
    await Promise.all([resetting, sending]);
    expect(first.generate).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({ phase: 'error', info: null, status: 'Reset failed' });
    await session.retry();
    expect(session.state.phase).toBe('ready');
    await session.destroy();
  });

  it('destroy prevents late load resurrection and clears all timers', async () => {
    const model = runtime();
    const load = deferred<ModelInfo>();
    model.load.mockReturnValue(load.promise);
    const session = new AssistantSession(() => model);
    const listener = vi.fn();
    session.subscribe(listener);
    const activation = session.activate();
    const destroying = session.destroy();
    const count = listener.mock.calls.length;
    load.resolve(info);
    await Promise.all([activation, destroying]);
    expect(model.load.mock.calls[0][0].aborted).toBe(true);
    expect(listener.mock.calls).toHaveLength(count);
    expect(model.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes immediately even if an aborted native load never acknowledges cancellation', async () => {
    const model = runtime();
    model.load.mockReturnValue(new Promise(() => {}));
    const session = new AssistantSession(() => model);
    void session.activate();
    await session.destroy();
    expect(model.dispose).toHaveBeenCalledOnce();
    expect(model.load.mock.calls[0][0].aborted).toBe(true);
  });

  it('unloads immediately for pagehide and can reactivate with its conversation intact', async () => {
    const first = runtime();
    const second = runtime();
    const generation = deferred<void>();
    first.generate.mockReturnValue(generation.promise);
    const session = new AssistantSession(vi.fn().mockReturnValueOnce(first).mockReturnValue(second));
    await session.activate();
    session.enterChat();
    const sending = session.send('Remember this');
    await flush();
    const [, , signal, update] = first.generate.mock.calls[0];
    update('Saved response', '', {});
    await session.unload();
    expect(signal.aborted).toBe(true);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(session.state).toMatchObject({ phase: 'idle', active: true, entered: false, info: null });
    expect(session.state.messages.at(-1)?.content).toBe('Saved response');
    expect(vi.getTimerCount()).toBe(0);
    await session.activate();
    expect(second.load).toHaveBeenCalledOnce();
    expect(session.state.phase).toBe('ready');
    update('Late old-page output', '', {});
    generation.resolve();
    await sending;
    expect(session.state.messages.at(-1)?.content).toBe('Saved response');
    await session.destroy();
  });
});
