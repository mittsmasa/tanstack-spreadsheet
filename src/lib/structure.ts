// Structural operations: deleting and moving whole rows / columns.
//
// Every operation builds a position map (old index -> new index | null for
// deleted) and applies it in one pass: cell ids are re-keyed, formula
// references are rewritten through the same map (deleted refs become #REF!),
// and column widths follow their column. Changes hit the collection as one
// bulk delete + one bulk insert.

import { cellsCollection } from "#/db-collections/cells";
import { persistWidths } from "#/db-collections/sheet-meta";
import { cellId, columnLabel, labelToColumnIndex, parseCellId } from "#/lib/columns";
import { rewriteFormulaRefs } from "#/lib/formula";
import {
  activeCellPos,
  cellSelectionAtom,
  columnSizingAtom,
  setActiveCell,
  sheetStore,
  stopEditing,
} from "#/lib/sheet-store";

import type { Cell } from "#/db-collections/cells";

/** old 0-based index -> new 0-based index, or null when the position is deleted */
type IndexMap = (index: number) => number | null;

const identityMap: IndexMap = (index) => index;

function deletionMap(deleted: ReadonlyArray<number>): IndexMap {
  const set = new Set(deleted);
  return (index) => {
    if (set.has(index)) return null;
    let shift = 0;
    for (const d of set) {
      if (d < index) shift++;
    }
    return index - shift;
  };
}

/**
 * Move the contiguous block [srcStart..srcEnd] so it starts where `dest`
 * ("insert before this original index") points. Returns null for a no-op
 * drop inside the block itself.
 */
function blockMoveMap(srcStart: number, srcEnd: number, dest: number): IndexMap | null {
  if (dest >= srcStart && dest <= srcEnd + 1) return null;
  const size = srcEnd - srcStart + 1;
  const insertAt = dest < srcStart ? dest : dest - size;
  return (index) => {
    if (index >= srcStart && index <= srcEnd) return insertAt + (index - srcStart);
    const removed = index > srcEnd ? index - size : index;
    return removed >= insertAt ? removed + size : removed;
  };
}

function remapCells(mapCol: IndexMap, mapRow: IndexMap) {
  const toDelete: Array<string> = [];
  const toInsert: Array<Cell> = [];
  for (const cell of cellsCollection.toArray) {
    const pos = parseCellId(cell.id);
    if (!pos) continue;
    const newCol = mapCol(pos.colIndex);
    const newRow = mapRow(pos.rowNumber - 1);
    if (newCol === null || newRow === null) {
      toDelete.push(cell.id);
      continue;
    }
    const newId = cellId(newCol, newRow + 1);
    const newRaw = rewriteFormulaRefs(cell.raw, (refId) => {
      const ref = parseCellId(refId);
      if (!ref) return refId;
      const c = mapCol(ref.colIndex);
      const r = mapRow(ref.rowNumber - 1);
      return c === null || r === null ? null : cellId(c, r + 1);
    });
    if (newId !== cell.id || newRaw !== cell.raw) {
      toDelete.push(cell.id);
      toInsert.push({ id: newId, raw: newRaw });
    }
  }
  if (toDelete.length) cellsCollection.delete(toDelete);
  if (toInsert.length) cellsCollection.insert(toInsert);
}

function remapWidths(mapCol: IndexMap) {
  const next: Record<string, number> = {};
  for (const [label, width] of Object.entries(columnSizingAtom.get())) {
    const index = labelToColumnIndex(label);
    if (index < 0) continue;
    const mapped = mapCol(index);
    if (mapped !== null) next[columnLabel(mapped)] = width;
  }
  columnSizingAtom.set(next);
  persistWidths(next);
}

/** How many stored cells sit in the given rows (for delete confirmation). */
export function countCellsInRows(rowNumbers: ReadonlyArray<number>): number {
  const set = new Set(rowNumbers);
  return cellsCollection.toArray.filter((c) => {
    const pos = parseCellId(c.id);
    return pos !== null && set.has(pos.rowNumber);
  }).length;
}

/** How many stored cells sit in the given columns (for delete confirmation). */
export function countCellsInColumns(colIndexes: ReadonlyArray<number>): number {
  const set = new Set(colIndexes);
  return cellsCollection.toArray.filter((c) => {
    const pos = parseCellId(c.id);
    return pos !== null && set.has(pos.colIndex);
  }).length;
}

/** Delete rows (1-based). Refuses to delete every row. */
export function deleteRows(rowNumbers: ReadonlyArray<number>): boolean {
  const { rows } = sheetStore.state;
  const targets = [...new Set(rowNumbers.filter((r) => r >= 1 && r <= rows))];
  if (targets.length === 0 || targets.length >= rows) return false;
  stopEditing();
  remapCells(identityMap, deletionMap(targets.map((r) => r - 1)));
  sheetStore.setState((s) => ({ ...s, rows: s.rows - targets.length }));
  const active = activeCellPos(cellSelectionAtom.get());
  setActiveCell(active.colIndex, Math.min(...targets));
  return true;
}

/** Delete columns (0-based). Refuses to delete every column. */
export function deleteColumns(colIndexes: ReadonlyArray<number>): boolean {
  const { cols } = sheetStore.state;
  const targets = [...new Set(colIndexes.filter((c) => c >= 0 && c < cols))];
  if (targets.length === 0 || targets.length >= cols) return false;
  stopEditing();
  const mapCol = deletionMap(targets);
  remapCells(mapCol, identityMap);
  remapWidths(mapCol);
  sheetStore.setState((s) => ({ ...s, cols: s.cols - targets.length }));
  const active = activeCellPos(cellSelectionAtom.get());
  setActiveCell(Math.min(...targets), active.rowNumber);
  return true;
}

/**
 * Move rows [srcStart..srcEnd] (1-based) to insert before row `destBefore`
 * (1-based, may be rows+1 for "after the last row").
 */
export function moveRows(srcStart: number, srcEnd: number, destBefore: number): boolean {
  const mapRow = blockMoveMap(srcStart - 1, srcEnd - 1, destBefore - 1);
  if (!mapRow) return false;
  stopEditing();
  remapCells(identityMap, mapRow);
  const newStart = mapRow(srcStart - 1);
  if (newStart !== null) {
    const active = activeCellPos(cellSelectionAtom.get());
    setActiveCell(active.colIndex, newStart + 1);
  }
  return true;
}

/**
 * Move columns [srcStart..srcEnd] (0-based) to insert before column
 * `destBefore` (0-based, may be cols for "after the last column").
 */
export function moveColumns(srcStart: number, srcEnd: number, destBefore: number): boolean {
  const mapCol = blockMoveMap(srcStart, srcEnd, destBefore);
  if (!mapCol) return false;
  stopEditing();
  remapCells(mapCol, identityMap);
  remapWidths(mapCol);
  const newStart = mapCol(srcStart);
  if (newStart !== null) {
    const active = activeCellPos(cellSelectionAtom.get());
    setActiveCell(newStart, active.rowNumber);
  }
  return true;
}
