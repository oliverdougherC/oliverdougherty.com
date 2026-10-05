/** Presentation budgets depend on space, never fabricated inference data. */
export const TOKEN_HISTORY_LIMIT = 2048;
export function observationBudget(height: number) {
  return {
    candidates: height >= 1200 ? 8 : height >= 850 ? 5 : 3,
    chartHeight: Math.round(Math.min(360, Math.max(72, height * 0.17))),
    expanded: height >= 850,
    rowHeight: height >= 850 ? 40 : 28,
  };
}
export function tokenCapacity(width: number, height: number, rowHeight: number): { columns: number; count: number } {
  if (!width || !height) return { columns: 8, count: 8 };
  const columns = Math.max(4, Math.min(32, Math.floor(width / 52)));
  const rows = Math.max(1, Math.floor(height / rowHeight));
  return { columns, count: Math.min(1024, columns * rows) };
}
export function promptWindow(total: number, processed: number, capacity: number): number {
  return Math.max(0, Math.min(total - capacity, processed - Math.floor(capacity * 0.7)));
}

/** Keep whitespace tokens visible; inspection retains the exact original piece. */
export function tokenLabel(piece: string): string {
  const visible = piece.replace(/\r/g, '␍').replace(/\n/g, '↵').replace(/\t/g, '⇥');
  return (piece.trim() ? visible : visible.replace(/ /g, '·')) || '∅';
}
