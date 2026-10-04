import { fetchAsset, WasmEngine } from './keiriWasm';
import type { Decision, LoadProgress, RulesEngine, Sheet } from './keiriWasm';
export type { Decision, LoadProgress, RulesEngine, Sheet, Totals } from './keiriWasm';

const wasmUrl = new URL('../keiri/assets/keiri.wasm', import.meta.url).href;
const tableUrl = new URL('../keiri/assets/bbg-anchor-v2.bin', import.meta.url).href;

let rulesPromise: Promise<RulesEngine> | null = null;
/** The small rules WASM loads independently; no table or worker readiness dependency. */
export function loadRules(): Promise<RulesEngine> {
  if (!rulesPromise) {
    rulesPromise = fetchAsset(wasmUrl).then(bytes => WasmEngine.fromBytes(bytes)).catch(error => {
      rulesPromise = null;
      throw error;
    });
  }
  return rulesPromise;
}

type PendingDecision = { resolve(value: Decision): void; reject(reason: Error): void };
export class ExactEngine {
  private worker: Worker | null = null;
  private promise: Promise<void> | null = null;
  private resolveLoad: (() => void) | null = null;
  private rejectLoad: ((reason: Error) => void) | null = null;
  private progress: LoadProgress = { phase: 'download', loaded: 0, total: null };
  private listener: ((progress: LoadProgress) => void) | null = null;
  private requests = new Map<number, PendingDecision>();
  private nextId = 1;

  load(onProgress: (progress: LoadProgress) => void): Promise<void> {
    this.listener = onProgress;
    onProgress(this.progress);
    if (this.progress.phase === 'ready') return Promise.resolve();
    if (this.promise) return this.promise;
    this.update({ phase: 'download', loaded: 0, total: null });
    this.promise = new Promise<void>((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject; });
    const promise = this.promise;
    try {
      const worker = new Worker(new URL('./keiri.worker.ts', import.meta.url), { type: 'module' });
      this.worker = worker;
      worker.onmessage = event => {
        if (worker !== this.worker) return;
        const message = event.data;
        if (message.type === 'failed') { this.fail(new Error(message.error)); return; }
        if (message.type === 'progress') {
          this.update(message.progress);
          if (message.progress.phase === 'ready') {
            this.resolveLoad?.(); this.resolveLoad = null; this.rejectLoad = null;
          }
        } else if (message.type === 'decision') {
          const pending = this.requests.get(message.id);
          if (!pending) return;
          this.requests.delete(message.id);
          if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.decision);
        }
      };
      worker.onerror = event => { if (worker === this.worker) this.fail(new Error(event.message || 'Keiri worker failed')); };
      worker.onmessageerror = () => { if (worker === this.worker) this.fail(new Error('Keiri worker response could not be read')); };
      worker.postMessage({ type: 'load', wasmUrl, tableUrl });
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  }
  decide(sheet: Sheet, dice: number[], rollsUsed: number): Promise<Decision> {
    if (this.progress.phase !== 'ready' || !this.worker) return Promise.reject(new Error('Exact Keiri is not ready'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      try { this.worker!.postMessage({ type: 'decide', id, sheet, dice, rollsUsed }); }
      catch (error) { this.requests.delete(id); reject(error); }
    });
  }
  dispose(): void { this.fail(new Error('Keiri engine disposed')); this.listener = null; }
  private update(progress: LoadProgress): void {
    this.progress = progress;
    this.listener?.(progress);
  }
  private fail(error: Error): void {
    this.worker?.terminate(); this.worker = null;
    this.promise = null;
    this.update({ ...this.progress, phase: 'failed' });
    this.rejectLoad?.(error); this.rejectLoad = null; this.resolveLoad = null;
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
  }
}
