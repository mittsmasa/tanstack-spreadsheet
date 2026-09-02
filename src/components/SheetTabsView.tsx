import { useState } from "react";

import InlineRename from "#/components/InlineRename";
import { useDeleteConfirm } from "#/lib/use-delete-confirm";

import type { SheetInfo } from "#/db-collections/server-sync";

export type SheetTabsViewProps = {
  sheets: ReadonlyArray<SheetInfo>;
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** Persist the new name; false keeps the rename input open and marks it failed. */
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => void;
};

/** The sheet tab bar. Pure: which sheet is being renamed or awaiting delete
 * confirmation lives here, everything else comes in as props. */
export default function SheetTabsView({
  sheets,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: SheetTabsViewProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useDeleteConfirm();

  const handleDelete = (id: string) => {
    setConfirmingId(null);
    onDelete(id);
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
                onCommit={(name) => onRename(sheet.id, name)}
                onDone={() => setRenamingId(null)}
              />
            ) : (
              <button
                type="button"
                className="max-w-40 overflow-hidden text-ellipsis whitespace-nowrap"
                title={sheet.name}
                onClick={() => onSelect(sheet.id)}
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
                  onClick={() => handleDelete(sheet.id)}
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
        onClick={onCreate}
      >
        ＋
      </button>
    </div>
  );
}
