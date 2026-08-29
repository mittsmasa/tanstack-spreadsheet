import { useEffect, useState } from "react";
import { useSelector } from "@tanstack/react-store";

import { createSheetApi, deleteSheetApi, renameSheetApi } from "#/db-collections/sheets";
import { activeSheetIdAtom, sheetsAtom, switchSheet } from "#/lib/sheet-store";

import type { SheetInfo } from "#/db-collections/server-sync";

// Native confirm/alert dialogs are suppressed in some embedded browsers (they
// once made sheet rows undeletable here), so destructive actions use a
// two-step click instead: ✕ turns into an explicit「削除?」button that
// reverts after a timeout or an outside click.
const DELETE_CONFIRM_MS = 3000;

async function handleCreate() {
  const sheet = await createSheetApi();
  if (sheet) switchSheet(sheet.id);
}

function RenameInput({ sheet, onDone }: { sheet: SheetInfo; onDone: () => void }) {
  const [value, setValue] = useState(sheet.name);
  const [failed, setFailed] = useState(false);

  const commit = async () => {
    const trimmed = value.trim();
    if (trimmed === sheet.name) {
      onDone();
      return;
    }
    if (trimmed !== "" && (await renameSheetApi(sheet.id, trimmed))) onDone();
    // duplicate or empty name: keep the input open and mark it so the user
    // can fix the name or leave via Escape
    else setFailed(true);
  };

  return (
    <input
      className={`w-24 rounded border bg-[var(--surface)] px-1 py-0.5 text-xs text-[var(--sea-ink)] outline-none ${
        failed ? "border-red-500" : "border-[var(--palm)]"
      }`}
      value={value}
      autoFocus
      title={failed ? "この名前は使えません（空・重複）" : undefined}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        setFailed(false);
        setValue(e.target.value);
      }}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        // IME 変換確定の Enter/Escape を編集操作として扱わない
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          void commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDone();
        }
      }}
    />
  );
}

export default function SheetTabs() {
  const sheets = useSelector(sheetsAtom);
  const activeId = useSelector(activeSheetIdAtom);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  // revert the「削除?」state after a timeout or a click anywhere outside it
  useEffect(() => {
    if (confirmingId === null) return;
    const timer = setTimeout(() => setConfirmingId(null), DELETE_CONFIRM_MS);
    const onOutsideClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-delete-confirm]")) {
        setConfirmingId(null);
      }
    };
    document.addEventListener("mousedown", onOutsideClick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", onOutsideClick);
    };
  }, [confirmingId]);

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
              <RenameInput sheet={sheet} onDone={() => setRenamingId(null)} />
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
