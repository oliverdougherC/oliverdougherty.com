import { fetchAsset, WasmEngine } from './keiriWasm';
import type { Sheet } from './keiriWasm';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let engine: WasmEngine | null = null;
let loading: Promise<void> | null = null;
scope.onmessage = (event: MessageEvent<{ type: 'load' | 'decide'; id: number; wasmUrl: string; tableUrl: string; sheet: Sheet; dice: number[]; rollsUsed: number }>) => {
  const message = event.data;
  if (message.type === 'load') {
    if (loading) return;
    loading = (async () => {
      let loaded = 0;
      let total: number | null = null;
      try {
        const [wasm, bytes] = await Promise.all([
          fetchAsset(message.wasmUrl).then(bytes => WasmEngine.fromBytes(bytes)),
          fetchAsset(message.tableUrl, (count, size) => {
            loaded = count; total = size;
            scope.postMessage({ type: 'progress', progress: { phase: 'download', loaded, total } });
          })
        ]);
        scope.postMessage({ type: 'progress', progress: { phase: 'initializing', loaded, total } });
        wasm.initialize(bytes);
        engine = wasm;
        scope.postMessage({ type: 'progress', progress: { phase: 'ready', loaded, total } });
      } catch (error) {
        engine = null;
        scope.postMessage({ type: 'failed', error: error instanceof Error ? error.message : String(error), progress: { phase: 'failed', loaded, total } });
      }
    })();
    return;
  }
  try {
    if (!engine) throw new Error('Exact Keiri is not ready');
    scope.postMessage({ type: 'decision', id: message.id, decision: engine.decide(message.sheet, message.dice, message.rollsUsed) });
  } catch (error) {
    scope.postMessage({ type: 'decision', id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
