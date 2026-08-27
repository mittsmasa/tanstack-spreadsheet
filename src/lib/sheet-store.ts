import { Store } from "@tanstack/store";

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
  selected: string;
  editing: EditingState | null;
  cols: number;
  rows: number;
};

export const sheetStore = new Store<SheetState>({
  selected: "A1",
  editing: null,
  cols: INITIAL_COLS,
  rows: INITIAL_ROWS,
});

export function selectCell(id: string) {
  sheetStore.setState((s) => ({ ...s, selected: id, editing: null }));
}

export function startEditing(cellId: string, seed: string | null = null) {
  sheetStore.setState((s) => ({
    ...s,
    selected: cellId,
    editing: { cellId, seed },
  }));
}

export function stopEditing() {
  sheetStore.setState((s) => ({ ...s, editing: null }));
}

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
