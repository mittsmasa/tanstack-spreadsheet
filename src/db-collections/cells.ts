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
