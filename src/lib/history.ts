// Operation-level undo/redo: every user operation pushes a snapshot of the
// whole sheet state (cells, grid size, column widths, selection) right before
// it mutates anything. Undo restores the snapshot by diffing against the
// current state; redo mirrors it. History is per-tab and in-memory only.

import { createAtom } from "@tanstack/store";

import { cellsCollection } from "#/db-collections/cells";
import { persistWidths } from "#/db-collections/sheet-meta";
import { cellSelectionAtom, columnSizingAtom, sheetStore, stopEditing } from "#/lib/sheet-store";

import type { Cell } from "#/db-collections/cells";
import type { CellSelectionState, ColumnSizingState } from "@tanstack/react-table";

const MAX_HISTORY = 100;

type Snapshot = {
  cells: Array<Cell>;
  rows: number;
  cols: number;
  widths: ColumnSizingState;
  selection: CellSelectionState;
};

const undoStack: Array<Snapshot> = [];
const redoStack: Array<Snapshot> = [];

export const historyAtom = createAtom({ canUndo: false, canRedo: false });

function syncHistoryAtom() {
  historyAtom.set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
}

function captureSnapshot(): Snapshot {
  const { rows, cols } = sheetStore.state;
  return {
    cells: cellsCollection.toArray.map((c) => ({ ...c })),
    rows,
    cols,
    widths: { ...columnSizingAtom.get() },
    selection: cellSelectionAtom.get().map((r) => ({ ...r })),
  };
}

/**
 * Apply a snapshot's cells as a diff. Cells that only changed value are
 * updated in place — delete + reinsert of the same key can make the live
 * query's contributors non-congruent (react-db 0.x).
 */
function restoreCells(cells: Array<Cell>) {
  const target = new Map(cells.map((c) => [c.id, c.raw]));
  const currentIds = new Set<string>();
  const toDelete: Array<string> = [];
  const toUpdate: Array<Cell> = [];
  for (const cell of cellsCollection.toArray) {
    currentIds.add(cell.id);
    const raw = target.get(cell.id);
    if (raw === undefined) toDelete.push(cell.id);
    else if (raw !== cell.raw) toUpdate.push({ id: cell.id, raw });
  }
  const toInsert = cells.filter((c) => !currentIds.has(c.id)).map((c) => ({ ...c }));
  if (toDelete.length) cellsCollection.delete(toDelete);
  for (const cell of toUpdate) {
    cellsCollection.update(cell.id, (draft) => {
      draft.raw = cell.raw;
    });
  }
  if (toInsert.length) cellsCollection.insert(toInsert);
}

function restoreSnapshot(snapshot: Snapshot) {
  stopEditing();
  restoreCells(snapshot.cells);
  sheetStore.setState((s) => ({ ...s, rows: snapshot.rows, cols: snapshot.cols }));
  columnSizingAtom.set({ ...snapshot.widths });
  persistWidths(snapshot.widths);
  cellSelectionAtom.set(snapshot.selection.map((r) => ({ ...r })));
}

/**
 * Record the current state as an undo step. Call right before a user
 * operation mutates the sheet; a new operation discards the redo stack.
 */
export function recordHistory() {
  undoStack.push(captureSnapshot());
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  syncHistoryAtom();
}

export function undo() {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  redoStack.push(captureSnapshot());
  restoreSnapshot(snapshot);
  syncHistoryAtom();
}

export function redo() {
  const snapshot = redoStack.pop();
  if (!snapshot) return;
  undoStack.push(captureSnapshot());
  restoreSnapshot(snapshot);
  syncHistoryAtom();
}
