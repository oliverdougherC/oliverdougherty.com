/** Keep whitespace tokens visible; inspection retains the exact original piece. */
export function tokenLabel(piece: string): string {
  const visible = piece.replace(/\r/g, '␍').replace(/\n/g, '↵').replace(/\t/g, '⇥');
  return (piece.trim() ? visible : visible.replace(/ /g, '·')) || '∅';
}

/** A snapshot describes one completed forward pass, never an interpolated frame. */
export interface AttentionEntry { position: number; weight: number }
export interface AttentionReading {
  layer: number;
  queryPosition: number;
  keyCount: number;
  headCount: number;
  entries: AttentionEntry[];
  /** Sum of retained attention weights; absent means coverage was not reported. */
  coverage?: number;
}
export interface LensCandidate { id: number; piece: string; rank: number; probability?: number }
export interface LensCheckpoint { layer: number; candidates: LensCandidate[] }
export interface ObservatorySnapshot {
  step: number;
  query?: { position: number; id: number; piece: string };
  sampled?: { id: number; piece: string; position?: number };
  attention?: AttentionReading[];
  deltas?: Array<{ layer: number; value: number }>;
  lens?: LensCheckpoint[];
  candidates?: Array<{ id?: number; piece: string; probability: number }>;
  layerCount?: number;
}
export const SNAPSHOT_HISTORY_LIMIT = 256;

/** Preserve exact samples; replace a repeated pass rather than inventing a step. */
export class ObservatoryHistory {
  readonly snapshots: ObservatorySnapshot[] = [];
  pinned: ObservatorySnapshot | null = null;
  preview: ObservatorySnapshot | null = null;
  ingest(snapshot: ObservatorySnapshot): void {
    if (!Number.isFinite(snapshot.step)) return;
    const index = this.snapshots.findIndex(value => value.step === snapshot.step);
    if (index >= 0) this.snapshots[index] = snapshot;
    else { this.snapshots.push(snapshot); if (this.snapshots.length > SNAPSHOT_HISTORY_LIMIT) this.snapshots.shift(); }
  }
  get selected(): ObservatorySnapshot | undefined { return this.pinned ?? this.preview ?? this.snapshots.at(-1); }
  pin(snapshot: ObservatorySnapshot): void { this.pinned = snapshot; this.preview = null; }
  live(): void { this.pinned = null; this.preview = null; }
  reset(): void { this.snapshots.length = 0; this.live(); }
}
export function waterfallColumns(width: number): number { return Math.max(16, Math.min(SNAPSHOT_HISTORY_LIMIT, Math.floor(Math.max(0, width - 22) / 5))); }
export function strongestAttention(reading: AttentionReading, count: number): AttentionEntry[] {
  return reading.entries.filter(entry => Number.isFinite(entry.weight) && entry.weight >= 0 && Number.isInteger(entry.position) && entry.position >= 0)
    .sort((a, b) => b.weight - a.weight).slice(0, count).sort((a, b) => a.position - b.position);
}
/** Dataset-wide scale within retained history; zero and missing remain distinct. */
export function deltaScale(snapshots: ObservatorySnapshot[]): number {
  return Math.max(0, ...snapshots.flatMap(snapshot => snapshot.deltas?.map(delta => Number.isFinite(delta.value) ? Math.max(0, delta.value) : 0) ?? []));
}

/** Shared monotonic color transform exposes small deltas without per-layer scaling. */
export function deltaIntensity(value: number, scale: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(scale) || value <= 0 || scale <= 0) return 0;
  return Math.log1p(99 * Math.min(1, value / scale)) / Math.log(100);
}
