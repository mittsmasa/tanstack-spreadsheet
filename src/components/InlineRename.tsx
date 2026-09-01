import { useState } from "react";

/**
 * The rename input used by both the sheet tabs and the book menu: commit on
 * Enter or blur, cancel on Escape, and stay open with a red border when the
 * server refuses the name (empty or already taken) so the user can fix it
 * rather than losing what they typed.
 */
export default function InlineRename({
  value: initial,
  onCommit,
  onDone,
  className = "",
}: {
  value: string;
  /** Persist the new name; false keeps the input open and marks it failed. */
  onCommit: (name: string) => Promise<boolean>;
  onDone: () => void;
  className?: string;
}) {
  const [value, setValue] = useState(initial);
  const [failed, setFailed] = useState(false);

  const commit = async () => {
    const trimmed = value.trim();
    if (trimmed === initial) {
      onDone();
      return;
    }
    if (trimmed !== "" && (await onCommit(trimmed))) onDone();
    else setFailed(true);
  };

  return (
    <input
      className={`rounded border bg-[var(--surface)] px-1 py-0.5 text-xs text-[var(--sea-ink)] outline-none ${
        failed ? "border-red-500" : "border-[var(--palm)]"
      } ${className}`}
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
