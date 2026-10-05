import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeWorkerBridge, Wllama } from '../local-assistant-runtime/dist/index.js';
import { AssistantRuntime } from '../src/local-assistant/runtime';
import { AssistantSession } from '../src/local-assistant/session';
import type { ModelInfo } from '../src/local-assistant/types';

type WorkerMessage = { verb: string; callbackId: number; args: unknown[] };
class SilentWorker {
  static instances: SilentWorker[] = [];
  static acknowledgeInit = true;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: WorkerMessage[] = [];
  throwOnPost = false;
  terminate = vi.fn();
  constructor() { SilentWorker.instances.push(this); }
  postMessage(message: WorkerMessage): void {
    if (this.throwOnPost) throw new DOMException('Channel closed', 'DataCloneError');
    this.sent.push(message);
    if (message.verb === 'module.init' && SilentWorker.acknowledgeInit) {
      queueMicrotask(() => this.onmessage?.({ data: { callbackId: message.callbackId, result: {} } }));
    }
    // Native inference messages deliberately receive no response.
  }
}
const logger = { debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function settles<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native bridge did not settle within 500ms')), 500);
    })]);
  } finally { clearTimeout(timer); }
}
function bridge() {
  return new NativeWorkerBridge({ wasmPath: '/unused.wasm', jsPath: { code: 'var Module = {};' }, compat: true }, 0, true, logger);
}
async function harness(recovered = false) {
  const transport = bridge();
  await transport.moduleInit([]);
  const worker = SilentWorker.instances.at(-1)!;
  const native = new Wllama({ default: '/unused.wasm' }, { logger });
  native.setCompat(null);
  Object.assign(native, { proxy: transport, metadata: { hparams: {}, meta: {} } });
  const original = transport.wllamaAction.bind(transport);
  // Fixture only the native C++ completion handshake. The failed get_result uses
  // the shipped transport, queue, Wllama getResponse, and finally/cancel code.
  const action = vi.spyOn(transport, 'wllamaAction').mockImplementation((name, body) => {
    if (!transport.isTerminated() && name === 'completion') {
      return Promise.resolve({ _name: 'cmpl_res', success: true, req_id: 7 }) as ReturnType<typeof original>;
    }
    if (recovered && !transport.isTerminated() && name === 'get_result') {
      return Promise.resolve({ _name: 'gres_res', success: true, has_more: false, is_error: false,
        data_json: JSON.stringify({ choices: [{ delta: { content: 'Recovered' }, finish_reason: 'stop' }] }) }) as ReturnType<typeof original>;
    }
    return original(name, body);
  });
  return { native, transport, worker, action };
}
function generate(native: Wllama, signal?: AbortSignal) {
  return native.createChatCompletion({ messages: [{ role: 'user', content: 'Hello' }], stream: true, abortSignal: signal, onData: () => {} });
}

beforeEach(() => {
  SilentWorker.instances = [];
  SilentWorker.acknowledgeInit = true;
  vi.stubGlobal('Worker', SilentWorker);
  vi.stubGlobal('navigator', { userAgent: 'Chrome', hardwareConcurrency: 2, storage: { getDirectory: vi.fn() } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('shipped Local Assistant native bridge terminal failures', () => {
  it('settles getResponse and skips cancellation after an uncaught worker error', async () => {
    const h = await harness();
    const result = generate(h.native);
    const rejected = expect(settles(result)).rejects.toThrow('GPU device lost');
    await flush();
    expect(h.worker.sent.some(({ args }) => args[0] === 'get_result')).toBe(true);
    h.worker.onerror!({ message: 'GPU device lost' });
    expect(h.transport.isTerminated()).toBe(true);
    await rejected;
    expect(h.action.mock.calls.some(([name]) => name === 'cancel')).toBe(false);
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    const sent = h.worker.sent.length;
    await expect(settles(h.native.resetConversation())).rejects.toThrow('GPU device lost');
    await expect(settles(generate(h.native))).rejects.toThrow('GPU device lost');
    expect(h.worker.sent).toHaveLength(sent);
    await settles(h.native.exit());
  });

  it('rejects initialization and future RPCs after an undecodable worker message', async () => {
    SilentWorker.acknowledgeInit = false;
    const transport = bridge();
    const init = expect(settles(transport.moduleInit([]))).rejects.toThrow('message could not be decoded');
    await flush();
    SilentWorker.instances[0].onmessageerror!();
    await init;
    await expect(settles(transport.wllamaStart())).rejects.toThrow('message could not be decoded');
    await settles(transport.wllamaExit());
    expect(transport.resultQueue).toHaveLength(0);
    expect(transport.taskQueue).toHaveLength(0);
  });

  it('treats a failed asynchronous model-file read as terminal', async () => {
    const h = await harness();
    const result = expect(settles(generate(h.native))).rejects.toThrow('File read failed');
    await flush();
    h.transport.fileBlobs.set('bad-model', { slice: () => ({ arrayBuffer: async () => { throw new Error('Unreadable model'); } }) } as unknown as Blob);
    h.worker.onmessage!({ data: { verb: 'fs.read_req', args: ['bad-model', 0, 8] } });
    await result;
    expect(h.transport.fileBlobs.size).toBe(0);
    await expect(settles(h.transport.wllamaDebug())).rejects.toThrow('Unreadable model');
    expect(h.action.mock.calls.some(([name]) => name === 'cancel')).toBe(false);
  });

  it('does not await source-map diagnostics before terminating an aborted runtime', async () => {
    const h = await harness();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const result = expect(settles(generate(h.native))).rejects.toThrow('Native OOM');
    await flush();
    h.worker.onmessage!({ data: { verb: 'signal.abort', args: ['abort', 'Native OOM', 'wasm-function[1234]:0x123abc', null] } });
    await result;
    expect(h.transport.isTerminated()).toBe(true);
    expect(h.action.mock.calls.some(([name]) => name === 'cancel')).toBe(false);
  });

  it('turns a synchronous postMessage failure into a settled RPC error', async () => {
    const h = await harness();
    h.worker.throwOnPost = true;
    await expect(settles(generate(h.native))).rejects.toThrow('communication failed');
    expect(h.transport.isTerminated()).toBe(true);
    expect(h.transport.busy).toBe(false);
    expect(h.transport.resultQueue).toHaveLength(0);
  });

  it('cleans up a blocked worker constructor and rejects subsequent calls', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    vi.stubGlobal('Worker', class { constructor() { throw new Error('Worker blocked'); } });
    const transport = bridge();
    await expect(settles(transport.moduleInit([]))).rejects.toThrow('worker could not start');
    expect(revoke).toHaveBeenCalledOnce();
    expect(transport.isTerminated()).toBe(true);
    await expect(settles(transport.wllamaStart())).rejects.toThrow('worker could not start');
    await settles(transport.wllamaExit());
  });

  it('keeps exit terminal when worker source loading resolves later', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(yes => { resolve = yes; })));
    const transport = new NativeWorkerBridge({ wasmPath: '/unused.wasm', jsPath: '/worker.js', compat: true }, 0, true, logger);
    const init = expect(settles(transport.moduleInit([]))).rejects.toThrow('Runtime disposed');
    await transport.wllamaExit();
    resolve(new Response('var Module = {};'));
    await init;
    expect(SilentWorker.instances).toHaveLength(0);
    await expect(settles(transport.wllamaStart())).rejects.toThrow('Runtime disposed');
  });
});

describe('session recovery through the shipped failed native bridge', () => {
  it('lets Stop, another send, New Chat, and a fresh send all settle', async () => {
    const info: ModelInfo = { name: 'Test Qwen', context: 2048, backend: 'WebGPU', layers: ['attention'] };
    const handles: Awaited<ReturnType<typeof harness>>[] = [];
    const session = new AssistantSession(() => {
      const runtime = new AssistantRuntime();
      vi.spyOn(runtime, 'load').mockImplementation(async () => {
        const h = await harness(handles.length > 0);
        handles.push(h);
        Object.assign(runtime, { engine: h.native, info });
        return info;
      });
      return runtime;
    });
    try {
      await session.activate();
      const first = session.send('First prompt');
      await flush();
      handles[0].worker.onerror!({ message: 'Inference worker failed' });
      session.stop();
      await settles(first);
      await settles(session.send('Still failed but must not hang'));
      expect(session.state.phase).toBe('error');
      await settles(session.reset());
      expect(session.state.messages).toEqual([]);
      await settles(session.send('Recover on a fresh worker'));
      expect(handles).toHaveLength(2);
      expect(session.state.phase).toBe('ready');
      expect(session.state.messages.at(-1)?.content).toBe('Recovered');
      expect(handles[0].worker.terminate).toHaveBeenCalledOnce();
    } finally { await session.destroy(); }
  });
});
