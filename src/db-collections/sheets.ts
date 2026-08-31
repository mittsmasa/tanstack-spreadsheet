// Sheet CRUD against the dev server + the client-side mirror of the sheet
// list. There is no react-db collection here — the list is small, changes are
// rare, and the server broadcasts the full list on every change, so an atom
// fed by the shared SSE stream is enough.

import { subscribeSheetsList } from "#/db-collections/server-sync";
import { activeSheetIdAtom, sheetsAtom, switchSheet } from "#/lib/sheet-store";

import type { SheetInfo } from "#/db-collections/server-sync";

export async function createSheetApi(name?: string): Promise<SheetInfo | null> {
  try {
    const res = await fetch("/api/sheets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name === undefined ? {} : { name }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sheet?: SheetInfo };
    return body.sheet ?? null;
  } catch {
    return null;
  }
}

export async function renameSheetApi(id: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sheets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteSheetApi(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/sheets/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

let started = false;

/** Mirror the server's sheet list into sheetsAtom (browser only, idempotent).
 * When the active sheet disappears — deleted from another tab or via MCP, or a
 * stale id restored from localStorage — falls back to the first sheet. */
export function initSheetsSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  subscribeSheetsList((sheets) => {
    const known = new Set(sheets.map((sheet) => sheet.id));
    sheetsAtom.set(sheets);
    const first = sheets[0];
    if (first && !known.has(activeSheetIdAtom.get())) switchSheet(first.id);
  });
}
