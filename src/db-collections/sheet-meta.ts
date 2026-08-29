// Column widths, persisted per sheet in the dev server's SQLite DB (see
// server/db.ts). Unlike cells there is no react-db collection here — the
// widths document is a single object owned by the columnSizingAtom, so plain
// fetches plus the shared SSE stream (subscribed sheet-scoped by the grid
// component, which remounts per sheet) are enough. The server drops identical
// writes, which is what terminates the persist→SSE→persist echo.

/** Resolves with the persisted column widths (empty during SSR). */
export async function loadPersistedWidths(sheet: string): Promise<Record<string, number>> {
  if (typeof window === "undefined") return {};
  try {
    const res = await fetch(`/api/meta?sheet=${encodeURIComponent(sheet)}`);
    if (!res.ok) return {};
    const body = (await res.json()) as { widths?: Record<string, number> };
    return body.widths ?? {};
  } catch {
    return {};
  }
}

export function persistWidths(widths: Record<string, number>, sheet: string) {
  if (typeof window === "undefined") return;
  void fetch("/api/meta", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sheet, widths }),
  }).catch((error: unknown) => {
    console.warn("[sheet-meta] persisting widths failed:", error);
  });
}

// One timer per sheet, and the sheet is captured at call time: a pending write
// must land on the sheet the resize happened on, even if the user switches
// sheets before the debounce fires.
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced variant for resize drags, which change widths every mousemove. */
export function persistWidthsDebounced(widths: Record<string, number>, sheet: string) {
  clearTimeout(persistTimers.get(sheet));
  persistTimers.set(
    sheet,
    setTimeout(() => persistWidths(widths, sheet), 300),
  );
}
