import { Store, createAtom } from "@tanstack/store";

import { cellId, columnLabel, labelToColumnIndex } from "#/lib/columns";

import type { BookInfo, SheetInfo } from "#/db-collections/server-sync";
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

// --- books and sheets --------------------------------------------------------
// The book comes from the URL (/b/$bookId); activeBookIdAtom mirrors it so
// non-React modules (cells, history, structure) can read it without a hook.
// The book's sheet list mirrors the server via the shared SSE stream, and the
// active sheet is tab-local: remembered per book across reloads, but not
// synced live (another tab switching sheets must not drag this one along).

/** Which sheet this tab last looked at in a given book. */
function activeSheetKey(bookId: string) {
  return `tanstack-spreadsheet.activeSheet:${bookId}`;
}

function loadActiveSheetId(bookId: string): string {
  try {
    return localStorage.getItem(activeSheetKey(bookId)) ?? "";
  } catch {
    return "";
  }
}

export const booksAtom = createAtom<Array<BookInfo>>([]);
export const activeBookIdAtom = createAtom<string>("");
export const sheetsAtom = createAtom<Array<SheetInfo>>([]);
// "" until the book's sheet list arrives (or a remembered id is restored);
// the grid renders nothing while it is empty.
export const activeSheetIdAtom = createAtom<string>("");

// rows/cols are session state (recovered from cells via ensureFits), so a
// sheet keeps its grid size while the tab lives but not across reloads
const gridSizeBySheet = new Map<string, { rows: number; cols: number }>();

/** Reset the per-sheet UI state and adopt the grid size parked for `id`. */
function adoptSheetUiState(id: string) {
  stopEditing();
  cellSelectionAtom.set([collapsedRange(0, 1)]);
  const saved = gridSizeBySheet.get(id);
  sheetStore.setState((s) => ({
    ...s,
    rows: saved?.rows ?? INITIAL_ROWS,
    cols: saved?.cols ?? INITIAL_COLS,
  }));
}

function parkGridSize(sheetId: string) {
  if (sheetId === "") return;
  gridSizeBySheet.set(sheetId, { rows: sheetStore.state.rows, cols: sheetStore.state.cols });
}

/** Switch the active sheet: park this sheet's grid size, reset per-sheet UI
 * state (editing, selection, view), and remount the grid via the atom. */
export function switchSheet(id: string) {
  const current = activeSheetIdAtom.get();
  if (id === current) return;
  parkGridSize(current);
  adoptSheetUiState(id);
  activeSheetIdAtom.set(id);
  try {
    localStorage.setItem(activeSheetKey(activeBookIdAtom.get()), id);
  } catch {
    // storage unavailable — the active sheet just won't survive reloads
  }
}

/**
 * Adopt the book the URL points at. The sheet list for it arrives later over
 * the stream, so the active sheet is restored from what this tab last looked
 * at in that book and left blank when there is nothing remembered; the sheet
 * list mirror corrects it either way.
 */
export function setActiveBook(id: string) {
  if (id === activeBookIdAtom.get()) return;
  parkGridSize(activeSheetIdAtom.get());
  const remembered = loadActiveSheetId(id);
  adoptSheetUiState(remembered);
  activeBookIdAtom.set(id);
  sheetsAtom.set([]);
  activeSheetIdAtom.set(remembered);
}

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

function viewStateKey(sheetId: string) {
  return `tanstack-spreadsheet.view:${sheetId}`;
}

type PersistedViewState = { sorting: SortingState; columnFilters: ColumnFiltersState };

function parseViewState(raw: string | null): PersistedViewState | null {
  if (!raw) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return null;
  const { sorting, columnFilters } = parsed as Partial<PersistedViewState>;
  return {
    sorting: Array.isArray(sorting) ? sorting : [],
    columnFilters: Array.isArray(columnFilters) ? columnFilters : [],
  };
}

export function loadPersistedViewState(sheetId: string): PersistedViewState | null {
  try {
    return parseViewState(localStorage.getItem(viewStateKey(sheetId)));
  } catch {
    return null;
  }
}

export function persistViewState(sheetId: string) {
  try {
    const state: PersistedViewState = {
      sorting: sortingAtom.get(),
      columnFilters: columnFiltersAtom.get(),
    };
    if (state.sorting.length === 0 && state.columnFilters.length === 0) {
      localStorage.removeItem(viewStateKey(sheetId));
    } else {
      localStorage.setItem(viewStateKey(sheetId), JSON.stringify(state));
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
