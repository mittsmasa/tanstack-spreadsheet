import { useState } from "react";
import { useSelector } from "@tanstack/react-store";

import InlineRename from "#/components/InlineRename";
import { createSheetApi, deleteSheetApi, renameSheetApi } from "#/db-collections/sheets";
import { activeSheetIdAtom, sheetsAtom, switchSheet } from "#/lib/sheet-store";
import { useDeleteConfirm } from "#/lib/use-delete-confirm";

async function handleCreate() {
  const sheet = await createSheetApi();
  if (sheet) switchSheet(sheet.id);
}

export default function SheetTabs() {
  const sheets = useSelector(sheetsAtom);
  const activeId = useSelector(activeSheetIdAtom);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useDeleteConfirm();

  const handleDelete = async (id: string) => {
    setConfirmingId(null);
    const wasActive = id === activeSheetIdAtom.get();
    if (!(await deleteSheetApi(id))) return;
    // the SSE sheets event also triggers this fallback, but switching right
    // away avoids rendering the deleted sheet until the event arrives
    if (wasActive) {
      const remaining = sheetsAtom.get().filter((sheet) => sheet.id !== id);
      if (remaining[0]) switchSheet(remaining[0].id);
    }
  };

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-t border-[var(--line)] bg-[var(--surface-strong)] px-2 py-1">
      {sheets.map((sheet) => {
        const isActive = sheet.id === activeId;
        return (
          <div
            key={sheet.id}
            className={`group flex shrink-0 items-center gap-1 rounded border px-2 py-0.5 text-xs transition ${
              isActive
                ? "border-[var(--palm)] bg-[var(--surface)] font-semibold text-[var(--palm)]"
                : "border-transparent text-[var(--sea-ink-soft)] hover:border-[var(--line)] hover:text-[var(--sea-ink)]"
            }`}
          >
            {renamingId === sheet.id ? (
              <InlineRename
                className="w-24"
                value={sheet.name}
                onCommit={(name) => renameSheetApi(sheet.id, name)}
                onDone={() => setRenamingId(null)}
              />
            ) : (
              <button
                type="button"
                className="max-w-40 overflow-hidden text-ellipsis whitespace-nowrap"
                title={sheet.name}
                onClick={() => switchSheet(sheet.id)}
                onDoubleClick={() => setRenamingId(sheet.id)}
              >
                {sheet.name}
              </button>
            )}
            {sheets.length > 1 &&
              renamingId !== sheet.id &&
              (confirmingId === sheet.id ? (
                <button
                  type="button"
                  data-delete-confirm
                  className="rounded bg-red-600 px-1.5 text-[10px] font-semibold text-white hover:bg-red-500"
                  onClick={() => void handleDelete(sheet.id)}
                >
                  削除?
                </button>
              ) : (
                <button
                  type="button"
                  data-delete-confirm
                  className={`rounded px-0.5 text-[10px] text-[var(--sea-ink-soft)] transition-opacity hover:text-red-600 dark:hover:text-red-400 ${
                    isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                  }`}
                  title={`${sheet.name} を削除`}
                  onClick={() => setConfirmingId(sheet.id)}
                >
                  ✕
                </button>
              ))}
          </div>
        );
      })}
      <button
        type="button"
        className="shrink-0 rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--sea-ink)] transition hover:border-[var(--palm)]"
        title="シートを追加"
        onClick={() => void handleCreate()}
      >
        ＋
      </button>
    </div>
  );
}
