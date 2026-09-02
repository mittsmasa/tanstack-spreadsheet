import { useEffect, useRef, useState } from "react";

import InlineRename from "#/components/InlineRename";
import { useDeleteConfirm } from "#/lib/use-delete-confirm";

import type { BookInfo } from "#/db-collections/server-sync";

export type BookMenuViewProps = {
  books: ReadonlyArray<BookInfo>;
  activeId: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
  /** Persist the new name; false keeps the rename input open and marks it failed. */
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => void;
};

// The header's leftmost slot names the open book rather than the app: the app
// name is not information the user needs mid-edit, and the browser tab already
// carries it. Clicking it opens the list of the user's books.
//
// Pure: open / renaming / delete-confirm state lives here, navigation and the
// book API are the container's (BookMenu) business.
export default function BookMenuView({
  books,
  activeId,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: BookMenuViewProps) {
  const [open, setOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useDeleteConfirm();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutsideClick = (e: MouseEvent) => {
      if (e.target instanceof Node && !container.current?.contains(e.target)) setOpen(false);
    };
    const onEscape = (e: KeyboardEvent) => {
      // let the rename input handle its own Escape first
      if (e.key === "Escape" && renamingId === null) setOpen(false);
    };
    document.addEventListener("mousedown", onOutsideClick);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutsideClick);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open, renamingId]);

  const openBook = (bookId: string) => {
    setOpen(false);
    onOpen(bookId);
  };

  const handleCreate = () => {
    setOpen(false);
    onCreate();
  };

  const handleDelete = (id: string) => {
    setConfirmingId(null);
    onDelete(id);
  };

  const activeName = books.find((book) => book.id === activeId)?.name ?? "";

  return (
    <div className="relative" ref={container}>
      <button
        type="button"
        className="flex max-w-56 items-center gap-1 rounded px-1 py-0.5 text-sm font-bold tracking-tight text-[var(--palm)] transition hover:bg-[var(--surface)]"
        title="ブックを切り替える"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{activeName}</span>
        <span aria-hidden className="text-[10px] text-[var(--sea-ink-soft)]">
          ▾
        </span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-56 rounded border border-[var(--line)] bg-[var(--surface-strong)] py-1 shadow-lg backdrop-blur">
          {books.map((book) => {
            const isActive = book.id === activeId;
            return (
              <div
                key={book.id}
                className={`group flex items-center gap-1 px-2 py-1 text-xs ${
                  isActive ? "font-semibold text-[var(--palm)]" : "text-[var(--sea-ink)]"
                }`}
              >
                <span aria-hidden className="w-3 shrink-0 text-[var(--palm)]">
                  {isActive ? "✓" : ""}
                </span>
                {renamingId === book.id ? (
                  <InlineRename
                    className="min-w-0 flex-1"
                    value={book.name}
                    onCommit={(name) => onRename(book.id, name)}
                    onDone={() => setRenamingId(null)}
                  />
                ) : (
                  <button
                    type="button"
                    className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left hover:underline"
                    title={book.name}
                    onClick={() => openBook(book.id)}
                  >
                    {book.name}
                  </button>
                )}
                {renamingId !== book.id && (
                  <>
                    <button
                      type="button"
                      className="shrink-0 rounded px-0.5 text-[10px] text-[var(--sea-ink-soft)] opacity-0 transition hover:text-[var(--palm)] group-hover:opacity-100"
                      title={`${book.name} の名前を変える`}
                      onClick={() => setRenamingId(book.id)}
                    >
                      ✎
                    </button>
                    {books.length > 1 &&
                      (confirmingId === book.id ? (
                        <button
                          type="button"
                          data-delete-confirm
                          className="shrink-0 rounded bg-red-600 px-1.5 text-[10px] font-semibold text-white hover:bg-red-500"
                          onClick={() => handleDelete(book.id)}
                        >
                          削除?
                        </button>
                      ) : (
                        <button
                          type="button"
                          data-delete-confirm
                          className="shrink-0 rounded px-0.5 text-[10px] text-[var(--sea-ink-soft)] opacity-0 transition hover:text-red-600 group-hover:opacity-100 dark:hover:text-red-400"
                          title={`${book.name} を削除（中のシートも消えます）`}
                          onClick={() => setConfirmingId(book.id)}
                        >
                          ✕
                        </button>
                      ))}
                  </>
                )}
              </div>
            );
          })}
          <div className="mt-1 border-t border-[var(--line)] pt-1">
            <button
              type="button"
              className="w-full px-2 py-1 text-left text-xs text-[var(--sea-ink)] transition hover:text-[var(--palm)]"
              onClick={handleCreate}
            >
              ＋ ブックを追加
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
