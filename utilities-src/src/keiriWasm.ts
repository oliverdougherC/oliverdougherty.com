/** The only gameplay boundary: pinned Keiri Rust through a small integer ABI. */
export type Sheet = { scores: (number | null)[]; yahtzeeBonus: number };
export type Totals = { upper: number; upperBonus: number; yahtzeeBonus: number; total: number };
export type Decision = { kind: 'hold'; mask: number } | { kind: 'score'; category: number };
export interface RulesEngine {
  preview(sheet: Sheet, dice: number[]): (number | null)[];
  score(sheet: Sheet, dice: number[], category: number): Sheet;
  totals(sheet: Sheet): Totals;
  validateSheet(sheet: Sheet): boolean;
}
export type LoadProgress = { phase: 'download' | 'initializing' | 'ready' | 'failed'; loaded: number; total: number | null };
interface Abi extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  input_ptr(): number;
  output_ptr(): number;
  error_ptr(): number;
  error_len(): number;
  rules(operation: number, category: number): number;
  table_buffer(length: number): number;
  initialize(): number;
  decide(): number;
}

/** Abort stalled requests, including stalled response bodies, while allowing slow active transfers. */
export async function fetchAsset(url: string, progress?: (loaded: number, total: number | null) => void): Promise<Uint8Array> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const refreshDeadline = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error('Keiri download stalled; please retry')), 120_000);
  };
  refreshDeadline();
  try {
    return await readAsset(await fetch(url, { signal: controller.signal }), (loaded, total) => {
      refreshDeadline();
      progress?.(loaded, total);
    });
  } finally { clearTimeout(timer!); }
}

/** Content-Length describes compressed transfer bytes; stream chunks are decoded. */
export async function readAsset(response: Response, progress?: (loaded: number, total: number | null) => void): Promise<Uint8Array> {
  if (!response.ok) throw new Error(`Keiri asset request failed (${response.status})`);
  const length = Number(response.headers.get('content-length'));
  const encoding = response.headers.get('content-encoding');
  const total = (!encoding || encoding === 'identity') && Number.isSafeInteger(length) && length > 0 ? length : null;
  progress?.(0, total);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (total !== null && bytes.length !== total) throw new Error('Keiri asset download was interrupted');
    progress?.(bytes.length, total);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      // Also avoid claiming a known total if a server returned inconsistent metadata.
      progress?.(loaded, total !== null && loaded <= total ? total : null);
    }
  } finally { reader.releaseLock(); }
  if (total !== null && loaded !== total) throw new Error('Keiri asset download was interrupted');
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export class WasmEngine implements RulesEngine {
  private readonly abi: Abi;
  constructor(instance: WebAssembly.Instance) { this.abi = instance.exports as Abi; }
  static async fromBytes(bytes: Uint8Array): Promise<WasmEngine> {
    const { instance } = await WebAssembly.instantiate(bytes as BufferSource, {});
    return new WasmEngine(instance);
  }
  private check(status: number): void {
    if (status === 0) return;
    throw new Error(new TextDecoder().decode(new Uint8Array(this.abi.memory.buffer, this.abi.error_ptr(), this.abi.error_len())));
  }
  private input(sheet: Sheet, dice?: number[], rolls = 1): void {
    if (!sheet || !Array.isArray(sheet.scores) || sheet.scores.length !== 13 ||
      !Number.isInteger(sheet.yahtzeeBonus) || sheet.yahtzeeBonus < 0 || sheet.yahtzeeBonus > 1200 ||
      sheet.scores.some(score => score !== null && (!Number.isInteger(score) || score < 0 || score > 50))) {
      throw new Error('Invalid score sheet');
    }
    if (dice && (dice.length !== 5 || dice.some(face => !Number.isInteger(face) || face < 1 || face > 6))) throw new Error('Invalid dice');
    if (!Number.isInteger(rolls) || rolls < 1 || rolls > 3) throw new Error('Invalid roll count');
    const input = new Int32Array(this.abi.memory.buffer, this.abi.input_ptr(), 20);
    input.set(sheet.scores.map(score => score === null ? -1 : score));
    input[13] = sheet.yahtzeeBonus;
    input.set(dice ?? [1, 1, 1, 1, 1], 14);
    input[19] = rolls;
  }
  private output(): number[] { return Array.from(new Int32Array(this.abi.memory.buffer, this.abi.output_ptr(), 20)); }
  validateSheet(sheet: Sheet): boolean {
    try { this.input(sheet); this.check(this.abi.rules(0, 0)); return true; } catch { return false; }
  }
  preview(sheet: Sheet, dice: number[]): (number | null)[] {
    this.input(sheet, dice); this.check(this.abi.rules(1, 0));
    return this.output().slice(0, 13).map(value => value === -1 ? null : value);
  }
  score(sheet: Sheet, dice: number[], category: number): Sheet {
    if (!Number.isInteger(category) || category < 0 || category > 12) throw new Error('Invalid category');
    this.input(sheet, dice); this.check(this.abi.rules(2, category));
    const out = this.output();
    return { scores: out.slice(0, 13).map(value => value === -1 ? null : value), yahtzeeBonus: out[13] };
  }
  totals(sheet: Sheet): Totals {
    this.input(sheet); this.check(this.abi.rules(3, 0));
    const [upper, upperBonus, yahtzeeBonus, total] = this.output();
    return { upper, upperBonus, yahtzeeBonus, total };
  }
  initialize(bytes: Uint8Array): void {
    const pointer = this.abi.table_buffer(bytes.length);
    new Uint8Array(this.abi.memory.buffer, pointer, bytes.length).set(bytes);
    this.check(this.abi.initialize());
  }
  decide(sheet: Sheet, dice: number[], rollsUsed: number): Decision {
    this.input(sheet, dice, rollsUsed); this.check(this.abi.decide());
    const [kind, value] = this.output();
    return kind === 0 ? { kind: 'hold', mask: value } : { kind: 'score', category: value };
  }
}
