import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { useStore } from "@tanstack/react-store";
import { flexRender, tableFeatures, useTable } from "@tanstack/react-table";

import ThemeToggle from "#/components/ThemeToggle";
import { cellsCollection, setCell } from "#/db-collections/cells";
import { cellId, columnLabel, parseCellId } from "#/lib/columns";
import { ERROR_VALUE, displayValue } from "#/lib/formula";
import {
  addColumn,
  addRow,
  ensureFits,
  selectCell,
  sheetStore,
  startEditing,
  stopEditing,
} from "#/lib/sheet-store";

import type { GetRaw } from "#/lib/formula";
import type { ColumnDef } from "@tanstack/react-table";

type SheetRow = { rowNumber: number };

// core-only table: no sorting/filtering features needed for a spreadsheet grid
const features = tableFeatures({});

type SheetColumnDef = ColumnDef<typeof features, SheetRow>;

function moveSelection(dCol: number, dRow: number) {
  const { selected, cols, rows } = sheetStore.state;
  const pos = parseCellId(selected);
  if (!pos) return;
  const colIndex = Math.min(Math.max(pos.colIndex + dCol, 0), cols - 1);
  const rowNumber = Math.min(Math.max(pos.rowNumber + dRow, 1), rows);
  selectCell(cellId(colIndex, rowNumber));
}

function CellEditor({ id, initial }: { id: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const committedRef = useRef(false);

  const commit = (dCol: number, dRow: number) => {
    if (committedRef.current) return;
    committedRef.current = true;
    setCell(id, value);
    stopEditing();
    if (dCol !== 0 || dRow !== 0) moveSelection(dCol, dRow);
  };

  return (
    <input
      className="absolute inset-0 h-full w-full border-2 border-[var(--palm)] bg-[var(--surface-strong)] px-1.5 font-mono text-[13px] text-[var(--sea-ink)] outline-none"
      value={value}
      autoFocus
      onFocus={(e) => {
        const len = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(len, len);
      }}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => commit(0, 0)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(0, 1);
        } else if (e.key === "Tab") {
          e.preventDefault();
          commit(1, 0);
        } else if (e.key === "Escape") {
          e.preventDefault();
          committedRef.current = true;
          stopEditing();
        }
      }}
    />
  );
}

const CellView = memo(function CellView({
  id,
  raw,
  display,
}: {
  id: string;
  raw: string | undefined;
  display: string;
}) {
  const isSelected = useStore(sheetStore, (s) => s.selected === id);
  const isEditing = useStore(sheetStore, (s) => s.editing?.cellId === id);
  const seed = useStore(sheetStore, (s) => (s.editing?.cellId === id ? s.editing.seed : null));

  const isError = display === ERROR_VALUE;
  const isNumeric = !isError && display !== "" && !Number.isNaN(Number(display));

  return (
    <div
      className={`relative h-full w-full px-1.5 leading-[26px] ${
        isNumeric ? "text-right" : "text-left"
      } ${isError ? "text-red-600 dark:text-red-400" : ""} ${
        isSelected
          ? "outline outline-2 -outline-offset-1 outline-[var(--palm)] bg-[color-mix(in_srgb,var(--palm)_8%,transparent)]"
          : ""
      }`}
      onMouseDown={() => selectCell(id)}
      onDoubleClick={() => startEditing(id)}
    >
      <span className="block overflow-hidden text-ellipsis whitespace-nowrap">{display}</span>
      {isEditing && <CellEditor id={id} initial={seed ?? raw ?? ""} />}
    </div>
  );
});

function FormulaBar({ selected, raw }: { selected: string; raw: string }) {
  const [value, setValue] = useState(raw);

  return (
    <div className="flex items-stretch gap-0 border-b border-[var(--line)] bg-[var(--surface-strong)]">
      <div className="flex w-20 items-center justify-center border-r border-[var(--line)] font-mono text-[13px] font-semibold text-[var(--sea-ink)]">
        {selected}
      </div>
      <div className="flex items-center border-r border-[var(--line)] px-2 font-serif text-[13px] italic text-[var(--sea-ink-soft)]">
        fx
      </div>
      <input
        className="h-9 flex-1 bg-transparent px-2 font-mono text-[13px] text-[var(--sea-ink)] outline-none"
        value={value}
        placeholder="値または =A1*2 のような数式"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setCell(selected, value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValue(raw);
          }
        }}
      />
    </div>
  );
}

export default function Spreadsheet() {
  const cols = useStore(sheetStore, (s) => s.cols);
  const rows = useStore(sheetStore, (s) => s.rows);
  const selected = useStore(sheetStore, (s) => s.selected);
  const editing = useStore(sheetStore, (s) => s.editing);
  const gridRef = useRef<HTMLDivElement>(null);

  // spread-select like the official demo: a bare from() emits non-congruent
  // rows for the same key when a cell is updated (react-db 0.x)
  const { data: cellRows } = useLiveQuery((q) =>
    q.from({ cell: cellsCollection }).select(({ cell }) => ({ ...cell })),
  );

  const cellMap = useMemo(() => new Map(cellRows.map((c) => [c.id, c.raw])), [cellRows]);
  const getRaw = useCallback<GetRaw>((id) => cellMap.get(id), [cellMap]);

  // Grow the grid so persisted cells (e.g. an added AA column) stay visible
  // after a reload.
  useEffect(() => {
    for (const id of cellMap.keys()) {
      const pos = parseCellId(id);
      if (pos) ensureFits(pos.colIndex, pos.rowNumber);
    }
  }, [cellMap]);

  // Return keyboard focus to the grid when cell editing ends.
  useEffect(() => {
    if (!editing) gridRef.current?.focus();
  }, [editing]);

  const data = useMemo<Array<SheetRow>>(
    () => Array.from({ length: rows }, (_, i) => ({ rowNumber: i + 1 })),
    [rows],
  );

  const columns = useMemo<Array<SheetColumnDef>>(
    () => [
      {
        id: "__rowHeader",
        header: () => "",
        cell: (info) => info.row.original.rowNumber,
      },
      ...Array.from({ length: cols }, (_, c): SheetColumnDef => {
        const label = columnLabel(c);
        return {
          id: label,
          header: () => label,
          cell: (info) => {
            const id = `${label}${info.row.original.rowNumber}`;
            const raw = getRaw(id);
            return <CellView id={id} raw={raw} display={displayValue(id, raw, getRaw)} />;
          },
        };
      }),
    ],
    [cols, getRaw],
  );

  const table = useTable({
    features,
    data,
    columns,
  });

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        moveSelection(0, -1);
        return;
      case "ArrowDown":
        e.preventDefault();
        moveSelection(0, 1);
        return;
      case "ArrowLeft":
        e.preventDefault();
        moveSelection(-1, 0);
        return;
      case "ArrowRight":
        e.preventDefault();
        moveSelection(1, 0);
        return;
      case "Tab":
        e.preventDefault();
        moveSelection(e.shiftKey ? -1 : 1, 0);
        return;
      case "Enter":
      case "F2":
        e.preventDefault();
        startEditing(selected);
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        setCell(selected, "");
        return;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          startEditing(selected, e.key);
        }
    }
  };

  const selectedRaw = getRaw(selected) ?? "";

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg-base)]">
      <header className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5">
        <h1 className="text-sm font-bold tracking-tight text-[var(--palm)]">
          tanstack-spreadsheet
        </h1>
        <div className="flex gap-1.5">
          <button
            type="button"
            className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--sea-ink)] transition hover:border-[var(--palm)]"
            onClick={addRow}
          >
            + 行
          </button>
          <button
            type="button"
            className="rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--sea-ink)] transition hover:border-[var(--palm)]"
            onClick={addColumn}
          >
            + 列
          </button>
        </div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <FormulaBar key={`${selected}:${selectedRaw}`} selected={selected} raw={selectedRaw} />

      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        className="flex-1 overflow-auto outline-none"
      >
        <table className="border-separate border-spacing-0 font-mono text-[13px] tabular-nums text-[var(--sea-ink)]">
          <thead className="sticky top-0 z-20">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header, i) => (
                  <th
                    key={header.id}
                    className={`h-[26px] min-w-[88px] border-b border-r border-[var(--line)] bg-[var(--sand)] px-1.5 text-center text-xs font-semibold text-[var(--sea-ink-soft)] ${
                      i === 0 ? "sticky left-0 z-30 w-12 min-w-12" : ""
                    }`}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id}>
                {row.getAllCells().map((cell, i) => (
                  <td
                    key={cell.id}
                    className={`h-[26px] border-b border-r border-[var(--line)] p-0 ${
                      i === 0
                        ? "sticky left-0 z-10 w-12 min-w-12 bg-[var(--sand)] text-center text-xs font-semibold text-[var(--sea-ink-soft)]"
                        : "bg-[var(--surface)]"
                    }`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <footer className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1 text-xs text-[var(--sea-ink-soft)]">
        <span>
          {cols} 列 × {rows} 行
        </span>
        <span>{cellMap.size} セル入力済み · localStorage にタブ間同期</span>
      </footer>
    </div>
  );
}
