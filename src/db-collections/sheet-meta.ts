// Column widths, persisted in the dev server's SQLite DB (see server/db.ts).
// Unlike cells there is no react-db collection here — the widths document is a
// single object owned by the columnSizingAtom, so plain fetches plus the shared
// SSE stream (for cross-tab / MCP updates) are enough. The server drops
// identical writes, which is what terminates the persist→SSE→persist echo.

import { subscribeServerSync } from "#/db-collections/server-sync";
import { columnSizingAtom } from "#/lib/sheet-store";

/** Resolves with the persisted column widths (empty during SSR). */
export async function loadPersistedWidths(): Promise<Record<string, number>> {
  if (typeof window === "undefined") return {};
  try {
    const res = await fetch("/api/meta");
    if (!res.ok) return {};
    const body = (await res.json()) as { widths?: Record<string, number> };
    return body.widths ?? {};
  } catch {
    return {};
  }
}

export function persistWidths(widths: Record<string, number>) {
  if (typeof window === "undefined") return;
  void fetch("/api/meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ widths }),
  }).catch((error: unknown) => {
    console.warn("[sheet-meta] persisting widths failed:", error);
  });
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced variant for resize drags, which change widths every mousemove. */
export function persistWidthsDebounced(widths: Record<string, number>) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistWidths(widths), 300);
}

// Follow width changes committed elsewhere (another tab, the MCP endpoint).
// Snapshots also carry widths so a reconnect can't miss changes made while
// the stream was down.
function applyRemoteWidths(widths: Record<string, number>) {
  if (JSON.stringify(columnSizingAtom.get()) !== JSON.stringify(widths)) {
    columnSizingAtom.set(widths);
  }
}

if (typeof window !== "undefined") {
  subscribeServerSync({
    onSnapshot: (snapshot) => applyRemoteWidths(snapshot.widths),
    onWidths: applyRemoteWidths,
  });
}
