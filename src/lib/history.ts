// Operation-level undo/redo: every user operation pushes a snapshot of the
// whole sheet state (cells, grid size, column widths, selection) right before
// it mutates anything. Undo restores the snapshot by diffing against the
// current state; redo mirrors it. History is per-tab and in-memory only,
// with one undo/redo stack pair per sheet — a snapshot must only ever be
// restored onto the sheet it was taken from, so undo/redo always operate on
// the active sheet's stacks and switching sheets just swaps which pair is
// live (returning to a sheet brings its history back).

import { createAtom } from "@tanstack/store";

import { activeCells, applyCellsDiff } from "#/db-collections/cells";
import { persistWidths } from "#/db-collections/sheet-meta";
import {
  activeSheetIdAtom,
  cellSelectionAtom,
  columnSizingAtom,
  sheetStore,
  stopEditing,
} from "#/lib/sheet-store";

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

type Stacks = { undo: Array<Snapshot>; redo: Array<Snapshot> };

const stacksBySheet = new Map<string, Stacks>();

function activeStacks(): Stacks {
  const sheetId = activeSheetIdAtom.get();
  let stacks = stacksBySheet.get(sheetId);
  if (!stacks) {
    stacks = { undo: [], redo: [] };
    stacksBySheet.set(sheetId, stacks);
  }
  return stacks;
}

export const historyAtom = createAtom({ canUndo: false, canRedo: false });

function syncHistoryAtom() {
  const stacks = activeStacks();
  historyAtom.set({ canUndo: stacks.undo.length > 0, canRedo: stacks.redo.length > 0 });
}

// a sheet switch swaps the live stack pair, so the buttons must re-derive
activeSheetIdAtom.subscribe(syncHistoryAtom);

/** Forget a deleted sheet's history (its snapshots have nowhere to restore to). */
export function dropHistory(sheetId: string) {
  stacksBySheet.delete(sheetId);
  syncHistoryAtom();
}

function captureSnapshot(): Snapshot {
  const { rows, cols } = sheetStore.state;
  return {
    // copy only the cell fields: synced rows can carry internal metadata
    // ($synced/$origin) that must not end up back in storage on restore
    cells: activeCells().toArray.map((c) => ({ id: c.id, raw: c.raw })),
    rows,
    cols,
    widths: { ...columnSizingAtom.get() },
    selection: cellSelectionAtom.get().map((r) => ({ ...r })),
  };
}

function restoreSnapshot(snapshot: Snapshot) {
  stopEditing();
  applyCellsDiff(snapshot.cells);
  sheetStore.setState((s) => ({ ...s, rows: snapshot.rows, cols: snapshot.cols }));
  columnSizingAtom.set({ ...snapshot.widths });
  persistWidths(snapshot.widths, activeSheetIdAtom.get());
  cellSelectionAtom.set(snapshot.selection.map((r) => ({ ...r })));
}

/**
 * Record the current state as an undo step. Call right before a user
 * operation mutates the sheet; a new operation discards the redo stack.
 */
export function recordHistory() {
  const stacks = activeStacks();
  stacks.undo.push(captureSnapshot());
  if (stacks.undo.length > MAX_HISTORY) stacks.undo.shift();
  stacks.redo.length = 0;
  syncHistoryAtom();
}

export function undo() {
  const stacks = activeStacks();
  const snapshot = stacks.undo.pop();
  if (!snapshot) return;
  stacks.redo.push(captureSnapshot());
  restoreSnapshot(snapshot);
  syncHistoryAtom();
}

export function redo() {
  const stacks = activeStacks();
  const snapshot = stacks.redo.pop();
  if (!snapshot) return;
  stacks.undo.push(captureSnapshot());
  restoreSnapshot(snapshot);
  syncHistoryAtom();
}
