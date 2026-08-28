import { createCollection } from "@tanstack/react-db";

import { migrateLocalStorageOnce } from "#/db-collections/migrate-local-storage";
import { subscribeServerSync } from "#/db-collections/server-sync";

export type Cell = {
  /** "A1" style cell id */
  id: string;
  /** raw user input; formulas keep their leading "=" */
  raw: string;
};

async function postMutations(cells: ReadonlyArray<Cell>) {
  const res = await fetch("/api/cells/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cells }),
  });
  if (!res.ok) throw new Error(`cell mutation failed: ${res.status}`);
}

// Server-synced collection: the dev server's SQLite DB is the source of truth.
// Local writes apply optimistically, persist via POST, and every tab receives
// committed changes over the shared SSE stream (which also carries writes made
// through the MCP endpoint). During SSR the collection just starts empty.
export const cellsCollection = createCollection<Cell>({
  id: "cells",
  getKey: (cell) => cell.id,
  sync: {
    sync: ({ begin, write, commit, markReady, truncate }) => {
      if (typeof window === "undefined") {
        markReady();
        return;
      }
      return subscribeServerSync({
        onSnapshot: (snapshot) => {
          begin();
          truncate();
          for (const cell of snapshot.cells) {
            write({ type: "insert", value: { id: cell.id, raw: cell.raw } });
          }
          commit();
          markReady();
          void migrateLocalStorageOnce(snapshot);
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
    postMutations(transaction.mutations.map((m) => ({ id: m.modified.id, raw: m.modified.raw }))),
  onUpdate: ({ transaction }) =>
    postMutations(transaction.mutations.map((m) => ({ id: m.modified.id, raw: m.modified.raw }))),
  onDelete: ({ transaction }) =>
    postMutations(transaction.mutations.map((m) => ({ id: String(m.key), raw: "" }))),
});

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
