import { Store, createAtom } from "@tanstack/store";

import { cellId, columnLabel, labelToColumnIndex } from "#/lib/columns";

import type {
  CellSelectionRange,
  CellSelectionState,
  ColumnFiltersState,
  ColumnSizingState,
  SortingState,
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

/**
 * Resolves a vertical move in view order (sorted/filtered row model). Absolute
 * row arithmetic would land on rows the current view hides, so the component
 * registers a navigator that walks the table's visible rows instead.
 */
type RowNavigator = (rowNumber: number, dRow: number) => number;
let rowNavigator: RowNavigator | null = null;

export function setRowNavigator(fn: RowNavigator | null) {
  rowNavigator = fn;
}

/** Move the active cell by a delta, collapsing any range selection. */
export function moveActive(dCol: number, dRow: number) {
  const pos = activeCellPos(cellSelectionAtom.get());
  const rowNumber =
    dRow !== 0 && rowNavigator ? rowNavigator(pos.rowNumber, dRow) : pos.rowNumber + dRow;
  setActiveCell(pos.colIndex + dCol, rowNumber);
}

// --- column widths -----------------------------------------------------------
// Owned atom for the table's columnSizing slice, keyed by column label.
// Persisted to the sheet-meta collection by the component (debounced).

export const columnSizingAtom = createAtom<ColumnSizingState>({});

// --- view state (sorting / filtering) ----------------------------------------
// Display-only: these never touch cell data. Persisted to localStorage (not
// the server) so a reload keeps the view; other tabs are unaffected.

export const sortingAtom = createAtom<SortingState>([]);
export const columnFiltersAtom = createAtom<ColumnFiltersState>([]);

export function clearViewState() {
  sortingAtom.set([]);
  columnFiltersAtom.set([]);
}

const VIEW_STATE_KEY = "tanstack-spreadsheet.view";

type PersistedViewState = { sorting: SortingState; columnFilters: ColumnFiltersState };

export function loadPersistedViewState(): PersistedViewState | null {
  try {
    const raw = localStorage.getItem(VIEW_STATE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { sorting, columnFilters } = parsed as Partial<PersistedViewState>;
    return {
      sorting: Array.isArray(sorting) ? sorting : [],
      columnFilters: Array.isArray(columnFilters) ? columnFilters : [],
    };
  } catch {
    return null;
  }
}

export function persistViewState() {
  try {
    const state: PersistedViewState = {
      sorting: sortingAtom.get(),
      columnFilters: columnFiltersAtom.get(),
    };
    if (state.sorting.length === 0 && state.columnFilters.length === 0) {
      localStorage.removeItem(VIEW_STATE_KEY);
    } else {
      localStorage.setItem(VIEW_STATE_KEY, JSON.stringify(state));
    }
  } catch {
    // storage unavailable (private mode etc.) — the view just won't survive reloads
  }
}

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
