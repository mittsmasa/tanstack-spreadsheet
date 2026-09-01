import { useEffect, useState } from "react";

// Native confirm/alert dialogs are suppressed in some embedded browsers (they
// once made sheet rows undeletable here), so destructive actions use a
// two-step click instead: ✕ turns into an explicit「削除?」button that reverts
// after a timeout or a click outside it. Both the sheet tabs and the book menu
// use this, and both mark their buttons with data-delete-confirm so a click on
// the confirm button itself does not immediately cancel it.
const DELETE_CONFIRM_MS = 3000;

/**
 * Track which row is awaiting delete confirmation. Returns the pending id and
 * a setter; pass null to cancel.
 */
export function useDeleteConfirm(): [string | null, (id: string | null) => void] {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

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

  return [confirmingId, setConfirmingId];
}
