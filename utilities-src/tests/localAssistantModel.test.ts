import { describe, expect, it, vi } from 'vitest';
import { allocateContext, architecture, contextTiers } from '../src/local-assistant/model';
import { downloadModel } from '../src/local-assistant/download';

describe('Local Assistant model allocation', () => {
  it('uses limited hints conservatively without excluding high contexts on larger adapters', () => {
    expect(contextTiers(2 ** 28)).toEqual([4096, 2048]);
    expect(contextTiers(2 ** 29, 4)).toEqual([8192, 4096, 2048]);
    expect(contextTiers(2 ** 31)).toEqual([65536, 32768, 16384, 8192, 4096, 2048]);
  });
  it('fully disposes failed allocations before retrying a new runtime', async () => {
    const events: string[] = [];
    let next = 0;
    const result = await allocateContext([8192, 4096, 2048], () => ++next, async (runtime, context) => {
      events.push(`load:${runtime}:${context}`);
      if (context > 2048) throw new Error('GPU buffer allocation failed');
    }, async runtime => { events.push(`dispose:${runtime}`); }, new AbortController().signal);
    expect(result).toEqual({ runtime: 3, context: 2048 });
    expect(events).toEqual(['load:1:8192', 'dispose:1', 'load:2:4096', 'dispose:2', 'load:3:2048']);
  });
  it('does not retry model format or pipeline errors as memory pressure', async () => {
    const create = vi.fn(() => 1), dispose = vi.fn(async () => {});
    await expect(allocateContext([8192, 4096], create, async () => { throw new Error('GGUF unsupported'); }, dispose, new AbortController().signal)).rejects.toThrow('GGUF');
    expect(create).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  it('disposes an allocation that finishes after cancellation', async () => {
    const abort = new AbortController(), dispose = vi.fn(async () => {});
    await expect(allocateContext([4096], () => 1, async () => { abort.abort(); }, dispose, abort.signal)).rejects.toThrow();
    expect(dispose).toHaveBeenCalledWith(1);
  });
  it('derives hybrid blocks from metadata and refuses unverified structures', () => {
    expect(architecture({ 'general.architecture': 'qwen35', 'qwen35.full_attention_interval': '4' }, 8)).toEqual(['deltanet', 'deltanet', 'deltanet', 'attention', 'deltanet', 'deltanet', 'deltanet', 'attention']);
    expect(() => architecture({ 'general.architecture': 'qwen35' }, 24)).toThrow();
    expect(() => architecture({ 'general.architecture': 'qwen35moe' }, 24)).toThrow();
  });
});

describe('ephemeral transfer', () => {
  it('fetches without persistence, reports actual bytes, and rejects truncated files', async () => {
    const data = new Uint8Array([71, 71, 85, 70, 3, 0, 0, 0]);
    const fetch = vi.fn(async () => new Response(data));
    vi.stubGlobal('fetch', fetch);
    try {
      const progress = vi.fn();
      const blob = await downloadModel('/model', 8, new AbortController().signal, progress);
      expect(blob.size).toBe(8);
      expect(fetch.mock.calls[0]).toEqual(['/model', expect.objectContaining({ cache: 'no-store', credentials: 'omit' })]);
      expect(progress).toHaveBeenLastCalledWith(8, 8, 'Initializing WebGPU');
      await expect(downloadModel('/model', 12, new AbortController().signal, progress)).rejects.toThrow('interrupted');
    } finally { vi.unstubAllGlobals(); }
  });
  it('validates a GGUF header split across network chunks without rereading a large Blob', async () => {
    const bytes = new Uint8Array([71, 71, 85, 70, 3, 0, 0, 0]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); }
    }))));
    try { expect((await downloadModel('/model', 8, new AbortController().signal, vi.fn())).size).toBe(8); }
    finally { vi.unstubAllGlobals(); }
  });
  it('aborts and cancels an unfinished transfer without returning a partial model', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(value) { controller = value; }, cancel
    }))));
    const abort = new AbortController();
    try {
      const result = downloadModel('/model', 8, abort.signal, vi.fn());
      controller.enqueue(new Uint8Array([71, 71, 85, 70]));
      abort.abort();
      await expect(result).rejects.toThrow();
      expect(cancel).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects an HTML error document instead of handing it to the model loader', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not GGUF')));
    try { await expect(downloadModel('/model', 8, new AbortController().signal, vi.fn())).rejects.toThrow('format'); }
    finally { vi.unstubAllGlobals(); }
  });
});
