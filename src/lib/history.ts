// Server-shared, per-client undo/redo. Every user operation runs inside one
// react-db transaction (runOperation) whose mutationFn posts the whole batch
// as a single mutation request tagged with this browser's client id; the
// server records it as one undoable history entry. Undo/redo just call the
// history endpoints — the server applies the inverse and the change comes back
// over the shared SSE stream like any other remote edit, so nothing here
// mutates collections directly and undone changes are never re-recorded.
//
// canUndo/canRedo are per (sheet, client), so the atom refreshes from the
// endpoint responses, on sheet switches, and whenever the active sheet
// receives a cells event (another tab of the same client may have edited).

import { createTransaction } from "@tanstack/react-db";
import { createAtom } from "@tanstack/store";

import { subscribeSheetSync } from "#/db-collections/server-sync";
import { getClientId } from "#/lib/client-id";
import { activeSheetIdAtom, stopEditing } from "#/lib/sheet-store";

import type { Cell } from "#/db-collections/cells";

type HistoryState = { canUndo: boolean; canRedo: boolean };

export const historyAtom = createAtom<HistoryState>({ canUndo: false, canRedo: false });

/** Adopt a server-reported state, unless the user has switched sheets since. */
function applyState(sheet: string, state: HistoryState) {
  if (sheet !== activeSheetIdAtom.get()) return;
  historyAtom.set({ canUndo: state.canUndo === true, canRedo: state.canRedo === true });
}

async function fetchState(sheet: string) {
  try {
    const params = new URLSearchParams({ sheet, client: getClientId() });
    const res = await fetch(`/api/history/state?${params}`);
    if (!res.ok) return;
    applyState(sheet, (await res.json()) as HistoryState);
  } catch {
    // stream keeps working without button state; the next operation refreshes it
  }
}

/**
 * Run one user operation as one undoable history entry. The callback must be
 * synchronous and only mutate the active sheet's cells collection; all its
 * inserts/updates/deletes are grouped into a single transaction and posted as
 * one batch (instead of one request per collection call via the collection's
 * own mutation handlers).
 */
export function runOperation(mutate: () => void) {
  const sheet = activeSheetIdAtom.get();
  const tx = createTransaction<Cell>({
    mutationFn: async ({ transaction }) => {
      const cells = transaction.mutations.map((m) =>
        m.type === "delete"
          ? { id: String(m.key), raw: "" }
          : { id: m.modified.id, raw: m.modified.raw },
      );
      const res = await fetch("/api/cells/mutations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sheet, cells, client: getClientId() }),
      });
      if (!res.ok) throw new Error(`cell mutation failed: ${res.status}`);
      applyState(sheet, (await res.json()) as HistoryState);
    },
  });
  tx.mutate(mutate);
  tx.isPersisted.promise.catch((error: unknown) => {
    // the transaction rolled the optimistic changes back; just surface it
    console.warn("[history] persisting an operation failed:", error);
  });
}

async function applyHistoryOp(direction: "undo" | "redo") {
  stopEditing();
  const sheet = activeSheetIdAtom.get();
  try {
    const res = await fetch(`/api/history/${direction}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sheet, client: getClientId() }),
    });
    if (!res.ok) return;
    applyState(sheet, (await res.json()) as HistoryState);
  } catch {
    // offline etc. — the sheet is simply left as-is
  }
}

// Serialized per tab: a burst of Cmd+Z must undo entries one at a time, not
// race several requests at the same newest entry.
let historyOps: Promise<void> = Promise.resolve();

export function undo() {
  historyOps = historyOps.then(() => applyHistoryOp("undo"));
}

export function redo() {
  historyOps = historyOps.then(() => applyHistoryOp("redo"));
}

if (typeof window !== "undefined") {
  let unwatch: (() => void) | null = null;
  const watch = (sheet: string) => {
    unwatch?.();
    unwatch = subscribeSheetSync(sheet, {
      onSnapshot: () => void fetchState(sheet),
      onCellChanges: () => void fetchState(sheet),
    });
  };
  watch(activeSheetIdAtom.get());
  activeSheetIdAtom.subscribe(() => {
    const sheet = activeSheetIdAtom.get();
    // per-sheet state: blank the buttons until the new sheet's state arrives
    historyAtom.set({ canUndo: false, canRedo: false });
    watch(sheet);
    void fetchState(sheet);
  });
  void fetchState(activeSheetIdAtom.get());
}
