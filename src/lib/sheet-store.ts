import { Store, createAtom } from "@tanstack/store";

import { cellId, columnLabel, labelToColumnIndex } from "#/lib/columns";

import type {
  CellSelectionRange,
  CellSelectionState,
  ColumnSizingState,
} from "@tanstack/react-table";

export const INITIAL_COLS = 26;
export const INITIAL_ROWS = 50;

export type EditingState = {
  cellId: string;
  /**
   * Initial input value when editing starts: a typed character replaces the
   * cell content, null means "edit the existing raw value".
   */
  seed: string | null;
};

export type SheetState = {
  editing: EditingState | null;
  cols: number;
  rows: number;
};

export const sheetStore = new Store<SheetState>({
  editing: null,
  cols: INITIAL_COLS,
  rows: INITIAL_ROWS,
});

// --- selection ---------------------------------------------------------------
// The table's cellSelection slice is owned by this atom (v9 external-atom
// ownership), so non-React code (edit commits, structural ops) can read and
// write the selection without a table instance.
// Convention: columnId = column label ("A"), rowId = String(rowNumber).

export function collapsedRange(colIndex: number, rowNumber: number): CellSelectionRange {
  const colId = columnLabel(colIndex);
  const rowId = String(rowNumber);
  return { anchorColumnId: colId, anchorRowId: rowId, focusColumnId: colId, focusRowId: rowId };
}

export const cellSelectionAtom = createAtom<CellSelectionState>([collapsedRange(0, 1)]);

type CellPos = { colIndex: number; rowNumber: number };

function rangeCorner(colId: string, rowId: string): CellPos | null {
  const colIndex = labelToColumnIndex(colId);
  const rowNumber = Number(rowId);
  if (colIndex < 0 || !Number.isInteger(rowNumber) || rowNumber < 1) return null;
  return { colIndex, rowNumber };
}

/** The active cell = anchor of the most recent range (falls back to A1). */
export function activeCellPos(sel: CellSelectionState): CellPos {
  const last = sel[sel.length - 1];
  const pos = last ? rangeCorner(last.anchorColumnId, last.anchorRowId) : null;
  return pos ?? { colIndex: 0, rowNumber: 1 };
}

export function activeCellIdOf(sel: CellSelectionState): string {
  const pos = activeCellPos(sel);
  return cellId(pos.colIndex, pos.rowNumber);
}

/** The moving corner of the most recent range (what auto-scroll follows). */
export function focusCellIdOf(sel: CellSelectionState): string {
  const last = sel[sel.length - 1];
  const pos = last ? rangeCorner(last.focusColumnId, last.focusRowId) : null;
  const resolved = pos ?? { colIndex: 0, rowNumber: 1 };
  return cellId(resolved.colIndex, resolved.rowNumber);
}

/** Collapse the selection to a single cell, clamped to the grid. */
export function setActiveCell(colIndex: number, rowNumber: number) {
  const { cols, rows } = sheetStore.state;
  const c = Math.min(Math.max(colIndex, 0), cols - 1);
  const r = Math.min(Math.max(rowNumber, 1), rows);
  cellSelectionAtom.set([collapsedRange(c, r)]);
}

/** Move the active cell by a delta, collapsing any range selection. */
export function moveActive(dCol: number, dRow: number) {
  const pos = activeCellPos(cellSelectionAtom.get());
  setActiveCell(pos.colIndex + dCol, pos.rowNumber + dRow);
}

// --- column widths -----------------------------------------------------------
// Owned atom for the table's columnSizing slice, keyed by column label.
// Persisted to the sheet-meta collection by the component (debounced).

export const columnSizingAtom = createAtom<ColumnSizingState>({});

// --- editing -----------------------------------------------------------------

export function startEditing(targetCellId: string, seed: string | null = null) {
  sheetStore.setState((s) => ({ ...s, editing: { cellId: targetCellId, seed } }));
}

export function stopEditing() {
  sheetStore.setState((s) => ({ ...s, editing: null }));
}

// --- grid size ---------------------------------------------------------------

export function addRow() {
  sheetStore.setState((s) => ({ ...s, rows: s.rows + 1 }));
}

export function addColumn() {
  sheetStore.setState((s) => ({ ...s, cols: s.cols + 1 }));
}

/** Grow the grid so that the given position fits (used for persisted cells). */
export function ensureFits(colIndex: number, rowNumber: number) {
  sheetStore.setState((s) => ({
    ...s,
    cols: Math.max(s.cols, colIndex + 1),
    rows: Math.max(s.rows, rowNumber),
  }));
}
