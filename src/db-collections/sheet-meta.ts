import { createCollection, localStorageCollectionOptions } from "@tanstack/react-db";

export type SheetMeta = {
  /** single document collection; the only id is "grid" */
  id: string;
  /** column widths in px, keyed by column label ("A", "B", ...) */
  widths: Record<string, number>;
};

const GRID_ID = "grid";

export const sheetMetaCollection = createCollection(
  localStorageCollectionOptions<SheetMeta>({
    storageKey: "tanstack-spreadsheet.meta",
    getKey: (meta) => meta.id,
  }),
);

/** Resolves with the persisted column widths once the collection has loaded. */
export async function loadPersistedWidths(): Promise<Record<string, number>> {
  const all = await sheetMetaCollection.toArrayWhenReady();
  return all.find((m) => m.id === GRID_ID)?.widths ?? {};
}

export function persistWidths(widths: Record<string, number>) {
  if (sheetMetaCollection.has(GRID_ID)) {
    sheetMetaCollection.update(GRID_ID, (draft) => {
      draft.widths = widths;
    });
  } else {
    sheetMetaCollection.insert({ id: GRID_ID, widths });
  }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced variant for resize drags, which change widths every mousemove. */
export function persistWidthsDebounced(widths: Record<string, number>) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => persistWidths(widths), 300);
}
