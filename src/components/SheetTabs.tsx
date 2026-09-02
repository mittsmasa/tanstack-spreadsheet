import { useSelector } from "@tanstack/react-store";

import SheetTabsView from "#/components/SheetTabsView";
import { createSheetApi, deleteSheetApi, renameSheetApi } from "#/db-collections/sheets";
import { activeSheetIdAtom, sheetsAtom, switchSheet } from "#/lib/sheet-store";

async function handleCreate() {
  const sheet = await createSheetApi();
  if (sheet) switchSheet(sheet.id);
}

async function handleDelete(id: string) {
  const wasActive = id === activeSheetIdAtom.get();
  if (!(await deleteSheetApi(id))) return;
  // the SSE sheets event also triggers this fallback, but switching right
  // away avoids rendering the deleted sheet until the event arrives
  if (wasActive) {
    const remaining = sheetsAtom.get().filter((sheet) => sheet.id !== id);
    if (remaining[0]) switchSheet(remaining[0].id);
  }
}

export default function SheetTabs() {
  const sheets = useSelector(sheetsAtom);
  const activeId = useSelector(activeSheetIdAtom);
  return (
    <SheetTabsView
      sheets={sheets}
      activeId={activeId}
      onSelect={switchSheet}
      onCreate={() => void handleCreate()}
      onRename={renameSheetApi}
      onDelete={(id) => void handleDelete(id)}
    />
  );
}
