import { readFile } from 'node:fs/promises';
import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import { ExactEngine, loadRules } from '../src/keiriEngine';
import { fetchAsset, readAsset, WasmEngine } from '../src/keiriWasm';
import type { Sheet } from '../src/keiriWasm';

const empty = (): Sheet => ({ scores: Array(13).fill(null), yahtzeeBonus: 0 });
let wasmBytes: Uint8Array;
let tableBytes: Uint8Array;
let rules: WasmEngine;
beforeAll(async () => {
  [wasmBytes, tableBytes] = await Promise.all([
    readFile('utilities-src/keiri/assets/keiri.wasm').then(bytes => new Uint8Array(bytes)),
    readFile('utilities-src/keiri/assets/bbg-anchor-v2.bin').then(bytes => new Uint8Array(bytes))
  ]);
  rules = await WasmEngine.fromBytes(wasmBytes);
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the actual shipped Keiri WASM boundary', () => {
  it('requires no external runtime imports', () => {
    expect(WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes as BufferSource))).toEqual([]);
  });
  it('uses BBG score previews, scoring, upper bonus and legal open categories', () => {
    expect(rules.preview(empty(), [2, 3, 4, 5, 6])).toEqual([0, 2, 3, 4, 5, 6, 0, 0, 0, 30, 40, 0, 20]);
    let sheet = empty();
    for (let category = 0; category < 6; category++) sheet = rules.score(sheet, Array(5).fill(category + 1), category);
    expect(rules.totals(sheet)).toEqual({ upper: 105, upperBonus: 35, yahtzeeBonus: 0, total: 140 });
    expect(rules.preview(sheet, [1, 2, 3, 4, 5]).slice(0, 6)).toEqual(Array(6).fill(null));
    expect(() => rules.score(sheet, [1, 2, 3, 4, 5], 0)).toThrow('already filled');
  });
  it('uses BBG Joker scores and repeated Yahtzee bonus points', () => {
    let sheet = rules.score(empty(), [6, 6, 6, 6, 6], 11);
    expect(rules.preview(sheet, [3, 3, 3, 3, 3])[8]).toBe(0);
    sheet = rules.score(sheet, [1, 2, 3, 4, 5], 2);
    const preview = rules.preview(sheet, [3, 3, 3, 3, 3]);
    expect(preview[8]).toBe(25);
    expect(preview[9]).toBe(30);
    expect(preview[10]).toBe(40);
    const scored = rules.score(sheet, [3, 3, 3, 3, 3], 10);
    expect(scored.yahtzeeBonus).toBe(100);
    expect(rules.totals(scored).total).toBe(193);
  });
  it('rejects invalid persisted values and ABI coercion instead of accepting malformed states', () => {
    const impossible = empty(); impossible.scores[1] = 3;
    expect(rules.validateSheet(impossible)).toBe(false);
    expect(rules.validateSheet({ ...empty(), yahtzeeBonus: 100 })).toBe(false);
    expect(rules.validateSheet({ ...empty(), scores: Array(13).fill(undefined) })).toBe(false);
    expect(() => rules.score(empty(), [1, 1, 1, 1, 1], 0.1)).toThrow();
    expect(() => rules.preview(empty(), [1, 1, 1, 1, 1.1])).toThrow();
    expect(() => rules.decide(empty(), [1, 1, 1, 1, 1], 4)).toThrow();
  });
  it('refuses decisions before exact initialization, then returns real exact decisions in visible dice order', () => {
    expect(() => rules.decide(empty(), [6, 2, 6, 3, 6], 2)).toThrow('not ready');
    rules.initialize(tableBytes);
    expect(rules.decide(empty(), [6, 6, 6, 6, 6], 3)).toEqual({ kind: 'score', category: 11 });
    expect(rules.decide(empty(), [6, 2, 6, 3, 6], 2)).toEqual({ kind: 'hold', mask: 21 });
    expect(rules.decide(empty(), [2, 6, 3, 6, 6], 2)).toEqual({ kind: 'hold', mask: 26 });
  }, 30000);
  it('rejects truncated, wrong magic, wrong version, checksum-invalid tables and recovers', async () => {
    const engine = await WasmEngine.fromBytes(wasmBytes);
    const version = tableBytes.slice(); version[8] = 99;
    const magic = tableBytes.slice(); magic[0] ^= 1;
    const checksum = tableBytes.slice(); checksum[500] ^= 1;
    for (const bytes of [tableBytes.slice(0, 8), tableBytes.slice(0, -1), version, magic, checksum]) {
      expect(() => engine.initialize(bytes)).toThrow();
      expect(() => engine.decide(empty(), [1, 1, 1, 1, 1], 1)).toThrow('not ready');
    }
    engine.initialize(tableBytes);
    expect(engine.decide(empty(), [1, 1, 1, 1, 1], 3)).toEqual({ kind: 'score', category: 11 });
  }, 30000);
});

describe('honest streaming downloads', () => {
  it('retries a failed rules download without ever fetching the exact table', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response(wasmBytes as BodyInit));
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadRules()).rejects.toThrow('404');
    const loaded = await loadRules();
    expect(loaded.preview(empty(), [1, 2, 3, 4, 5])[10]).toBe(40);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(call => String(call[0]).endsWith('.wasm'))).toBe(true);
  });
  it('aborts a stalled response and restarts the inactivity deadline on each streamed chunk', async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    vi.stubGlobal('fetch', vi.fn((_url, options) => {
      signal = options.signal;
      const body = new ReadableStream<Uint8Array>({ start(value) {
        controller = value;
        signal.addEventListener('abort', () => controller.error(signal.reason));
      } });
      return Promise.resolve(new Response(body));
    }));
    const download = fetchAsset('/table.bin');
    const rejected = expect(download).rejects.toThrow('stalled');
    await vi.advanceTimersByTimeAsync(119_000);
    expect(signal.aborted).toBe(false);
    controller.enqueue(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(signal.aborted).toBe(true);
  });
  it('reports decoded byte progress only against an uncompressed Content-Length', async () => {
    const progress = vi.fn();
    expect(await readAsset(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '3' } }), progress)).toEqual(new Uint8Array([1, 2, 3]));
    expect(progress).toHaveBeenLastCalledWith(3, 3);
    await readAsset(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-length': '2', 'content-encoding': 'gzip' } }), progress);
    expect(progress).toHaveBeenLastCalledWith(3, null);
  });
  it('fails HTTP errors, short streams and interrupted streams', async () => {
    await expect(readAsset(new Response('', { status: 404 }))).rejects.toThrow('404');
    await expect(readAsset(new Response(new Uint8Array([1]), { headers: { 'content-length': '2' } }))).rejects.toThrow('interrupted');
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error('interrupted')); } });
    await expect(readAsset(new Response(stream))).rejects.toThrow('interrupted');
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  emit(data: unknown): void { this.onmessage?.({ data }); }
}
describe('exact worker lifecycle', () => {
  it('singleflights load, retries failures, retains ready state and rejects pending work on disposal', async () => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    const engine = new ExactEngine();
    await expect(engine.decide(empty(), [1, 2, 3, 4, 5], 1)).rejects.toThrow('not ready');
    const progress = vi.fn();
    const first = engine.load(progress);
    expect(engine.load(progress)).toBe(first);
    expect(FakeWorker.instances).toHaveLength(1);
    FakeWorker.instances[0].emit({ type: 'failed', error: 'checksum mismatch' });
    await expect(first).rejects.toThrow('checksum');
    const retry = engine.load(progress);
    FakeWorker.instances[1].emit({ type: 'progress', progress: { phase: 'ready', loaded: 10, total: 10 } });
    await retry;
    await engine.load(progress);
    expect(FakeWorker.instances).toHaveLength(2);
    const decision = engine.decide(empty(), [1, 2, 3, 4, 5], 1);
    engine.dispose();
    await expect(decision).rejects.toThrow('disposed');
    expect(FakeWorker.instances[1].terminate).toHaveBeenCalledOnce();
  });
});
