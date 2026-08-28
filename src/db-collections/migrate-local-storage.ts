// One-shot import of legacy localStorage data into the server DB.
//
// Before the server-SSoT change, data lived in localStorage under the
// react-db localStorageCollectionOptions format (verified against
// @tanstack/db 0.8.5 source): {"s:<key>": {versionKey: uuid, data: <row>}}.
// When the server is still empty and legacy data exists, push it up once.
// The localStorage keys are left untouched so nothing is lost if this fails.

import type { Snapshot } from "#/db-collections/server-sync";

const LEGACY_CELLS_KEY = "tanstack-spreadsheet.cells";
const LEGACY_META_KEY = "tanstack-spreadsheet.meta";

let attempted = false;

function legacyEntries(storageKey: string): Array<unknown> {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`unexpected legacy format under ${storageKey}`);
  }
  return Object.entries(parsed)
    .filter(([key]) => key.startsWith("s:"))
    .map(([, value]) => (value as { data?: unknown }).data);
}

export async function migrateLocalStorageOnce(snapshot: Snapshot): Promise<void> {
  if (attempted) return;
  attempted = true;
  try {
    if (snapshot.cells.length === 0) {
      const cells = legacyEntries(LEGACY_CELLS_KEY).filter(
        (data): data is { id: string; raw: string } =>
          data !== null &&
          typeof data === "object" &&
          typeof (data as { id?: unknown }).id === "string" &&
          typeof (data as { raw?: unknown }).raw === "string",
      );
      if (cells.length > 0) {
        const res = await fetch("/api/cells/mutations", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cells: cells.map(({ id, raw }) => ({ id, raw })) }),
        });
        if (!res.ok) throw new Error(`cells import failed: ${res.status}`);
        console.info(`[migrate] imported ${cells.length} cells from localStorage`);
      }
    }
    if (Object.keys(snapshot.widths).length === 0) {
      const grid = legacyEntries(LEGACY_META_KEY).find(
        (data): data is { widths: Record<string, number> } =>
          data !== null &&
          typeof data === "object" &&
          typeof (data as { widths?: unknown }).widths === "object" &&
          (data as { widths?: unknown }).widths !== null,
      );
      if (grid && Object.keys(grid.widths).length > 0) {
        const res = await fetch("/api/meta", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ widths: grid.widths }),
        });
        if (!res.ok) throw new Error(`widths import failed: ${res.status}`);
        console.info("[migrate] imported column widths from localStorage");
      }
    }
  } catch (error) {
    console.warn("[migrate] skipped localStorage import:", error);
  }
}
