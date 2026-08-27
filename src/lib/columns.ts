// Single source of truth for column index <-> letter conversions.
// Both the grid headers and the formula reference handling rely on these,
// so multi-letter columns (AA, AB, ...) stay consistent everywhere.

/** 0 -> "A", 25 -> "Z", 26 -> "AA", 27 -> "AB", ... */
export function columnLabel(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

/** "A" -> 0, "Z" -> 25, "AA" -> 26. Returns -1 for invalid labels. */
export function labelToColumnIndex(label: string): number {
  if (!/^[A-Z]+$/.test(label)) return -1;
  let n = 0;
  for (const ch of label) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** colIndex 0-based, rowNumber 1-based -> "A1" style cell id */
export function cellId(colIndex: number, rowNumber: number): string {
  return `${columnLabel(colIndex)}${rowNumber}`;
}

const CELL_ID_RE = /^([A-Z]+)([1-9][0-9]*)$/;

/** "AA12" -> { colIndex: 26, rowNumber: 12 }, or null if not a cell id */
export function parseCellId(id: string): { colIndex: number; rowNumber: number } | null {
  const m = CELL_ID_RE.exec(id);
  if (!m) return null;
  return { colIndex: labelToColumnIndex(m[1]), rowNumber: Number(m[2]) };
}
