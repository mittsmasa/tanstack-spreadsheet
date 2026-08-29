import { createCollection } from "@tanstack/react-db";

import { migrateLocalStorageOnce } from "#/db-collections/migrate-local-storage";
import { subscribeSheetSync } from "#/db-collections/server-sync";
import { DEFAULT_SHEET_ID, activeSheetIdAtom } from "#/lib/sheet-store";

export type Cell = {
  /** "A1" style cell id */
  id: string;
  /** raw user input; formulas keep their leading "=" */
  raw: string;
};

async function postMutations(sheet: string, cells: ReadonlyArray<Cell>) {
  const res = await fetch("/api/cells/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheet, cells }),
  });
  if (!res.ok) throw new Error(`cell mutation failed: ${res.status}`);
}

// Server-synced collection, one per sheet: the dev server's SQLite DB is the
// source of truth. Local writes apply optimistically, persist via POST, and
// every tab receives committed changes over the shared SSE stream (which also
// carries writes made through the MCP endpoint). During SSR the collection
// just starts empty.
function createCellsCollection(sheetId: string) {
  return createCollection<Cell>({
    id: `cells:${sheetId}`,
    getKey: (cell) => cell.id,
    sync: {
      sync: ({ begin, write, commit, markReady, truncate }) => {
        if (typeof window === "undefined") {
          markReady();
          return;
        }
        return subscribeSheetSync(sheetId, {
          onSnapshot: (data) => {
            begin();
            truncate();
            for (const cell of data.cells) {
              write({ type: "insert", value: { id: cell.id, raw: cell.raw } });
            }
            commit();
            markReady();
            if (sheetId === DEFAULT_SHEET_ID) void migrateLocalStorageOnce(data);
          },
          onCellChanges: (changes) => {
            begin();
            for (const change of changes) {
              if (change.type === "delete") write({ type: "delete", key: change.id });
              else write({ type: change.type, value: { id: change.id, raw: change.raw } });
            }
            commit();
          },
        });
      },
    },
    onInsert: ({ transaction }) =>
      postMutations(
        sheetId,
        transaction.mutations.map((m) => ({ id: m.modified.id, raw: m.modified.raw })),
      ),
    onUpdate: ({ transaction }) =>
      postMutations(
        sheetId,
        transaction.mutations.map((m) => ({ id: m.modified.id, raw: m.modified.raw })),
      ),
    onDelete: ({ transaction }) =>
      postMutations(
        sheetId,
        transaction.mutations.map((m) => ({ id: String(m.key), raw: "" })),
      ),
  });
}

// Registry of per-sheet collections. Entries are kept for the tab's lifetime;
// a collection whose subscribers all left (a sheet switched away from) cleans
// itself up after gcTime and restarts sync — from the shared per-sheet
// snapshot cache — on the next subscribe.
const registry = new Map<string, ReturnType<typeof createCellsCollection>>();

export function getCellsCollection(sheetId: string) {
  let collection = registry.get(sheetId);
  if (!collection) {
    collection = createCellsCollection(sheetId);
    registry.set(sheetId, collection);
  }
  return collection;
}

/** The active sheet's collection — what edits, history and structure ops target. */
export function activeCells() {
  return getCellsCollection(activeSheetIdAtom.get());
}

/**
 * Diff the active sheet's collection against a full target state and apply the
 * difference. Cells whose value changed are updated in place — delete +
 * reinsert of the same key can make live-query contributors non-congruent
 * (react-db 0.x). Only `id` and `raw` are ever written, so internal metadata
 * fields picked up from synced rows never leak into storage.
 */
export function applyCellsDiff(target: ReadonlyArray<Cell>) {
  const collection = activeCells();
  const targetRaw = new Map(target.map((c) => [c.id, c.raw]));
  const currentIds = new Set<string>();
  const toDelete: Array<string> = [];
  const toUpdate: Array<Cell> = [];
  for (const cell of collection.toArray) {
    currentIds.add(cell.id);
    const raw = targetRaw.get(cell.id);
    if (raw === undefined) toDelete.push(cell.id);
    else if (raw !== cell.raw) toUpdate.push({ id: cell.id, raw });
  }
  const toInsert = target
    .filter((c) => !currentIds.has(c.id))
    .map((c) => ({ id: c.id, raw: c.raw }));
  if (toDelete.length) collection.delete(toDelete);
  for (const cell of toUpdate) {
    collection.update(cell.id, (draft) => {
      draft.raw = cell.raw;
    });
  }
  if (toInsert.length) collection.insert(toInsert);
}

/** Upsert a cell's raw input on the active sheet; an empty string deletes it. */
export function setCell(id: string, raw: string) {
  const collection = activeCells();
  const exists = collection.has(id);
  if (raw.trim() === "") {
    if (exists) collection.delete(id);
    return;
  }
  if (exists) {
    collection.update(id, (draft) => {
      draft.raw = raw;
    });
  } else {
    collection.insert({ id, raw });
  }
}
