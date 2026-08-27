import { createCollection, localStorageCollectionOptions } from "@tanstack/react-db";

export type Cell = {
  /** "A1" style cell id */
  id: string;
  /** raw user input; formulas keep their leading "=" */
  raw: string;
};

// localStorage collection: persists across reloads and syncs across tabs
// via storage events. Falls back to in-memory storage during SSR.
export const cellsCollection = createCollection(
  localStorageCollectionOptions<Cell>({
    storageKey: "tanstack-spreadsheet.cells",
    getKey: (cell) => cell.id,
  }),
);

/**
 * Diff the collection against a full target state and apply the difference.
 * Cells whose value changed are updated in place — delete + reinsert of the
 * same key can make live-query contributors non-congruent (react-db 0.x).
 * Only `id` and `raw` are ever written, so internal metadata fields picked up
 * from synced rows never leak into storage.
 */
export function applyCellsDiff(target: ReadonlyArray<Cell>) {
  const targetRaw = new Map(target.map((c) => [c.id, c.raw]));
  const currentIds = new Set<string>();
  const toDelete: Array<string> = [];
  const toUpdate: Array<Cell> = [];
  for (const cell of cellsCollection.toArray) {
    currentIds.add(cell.id);
    const raw = targetRaw.get(cell.id);
    if (raw === undefined) toDelete.push(cell.id);
    else if (raw !== cell.raw) toUpdate.push({ id: cell.id, raw });
  }
  const toInsert = target
    .filter((c) => !currentIds.has(c.id))
    .map((c) => ({ id: c.id, raw: c.raw }));
  if (toDelete.length) cellsCollection.delete(toDelete);
  for (const cell of toUpdate) {
    cellsCollection.update(cell.id, (draft) => {
      draft.raw = cell.raw;
    });
  }
  if (toInsert.length) cellsCollection.insert(toInsert);
}

/** Upsert a cell's raw input; an empty string deletes the cell. */
export function setCell(id: string, raw: string) {
  const exists = cellsCollection.has(id);
  if (raw.trim() === "") {
    if (exists) cellsCollection.delete(id);
    return;
  }
  if (exists) {
    cellsCollection.update(id, (draft) => {
      draft.raw = raw;
    });
  } else {
    cellsCollection.insert({ id, raw });
  }
}
