import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { shallow, useSelector, useStore } from "@tanstack/react-store";
import {
  cellSelectionFeature,
  columnFilteringFeature,
  columnResizingFeature,
  columnSizingFeature,
  createFilteredRowModel,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";

import SheetTabs from "#/components/SheetTabs";
import ThemeToggle from "#/components/ThemeToggle";
import { activeCells, getCellsCollection, setCell } from "#/db-collections/cells";
import { subscribeSheetSync } from "#/db-collections/server-sync";
import { persistWidthsDebounced } from "#/db-collections/sheet-meta";
import { initSheetsSync } from "#/db-collections/sheets";
import { cellId, columnLabel, labelToColumnIndex, parseCellId } from "#/lib/columns";
import { ERROR_VALUE, REF_ERROR_VALUE, displayValue } from "#/lib/formula";
import { historyAtom, redo, runOperation, undo } from "#/lib/history";
import {
  activeCellIdOf,
  activeCellPos,
  activeSheetIdAtom,
  addColumn,
  addRow,
  cellSelectionAtom,
  clearViewState,
  columnFiltersAtom,
  columnSizingAtom,
  ensureFits,
  focusCellIdOf,
  loadPersistedViewState,
  moveActive,
  persistViewState,
  setRowNavigator,
  sheetStore,
  sortingAtom,
  startEditing,
  stopEditing,
} from "#/lib/sheet-store";
import {
  deleteColumns,
  deleteRows,
  insertColumns,
  insertRows,
  moveColumns,
  moveRows,
} from "#/lib/structure";
import { encodeTsv, parseTsv } from "#/lib/tsv";

import type { GetRaw } from "#/lib/formula";
import type {
  CellSelectionDirection,
  CellSelectionState,
  Cell as TableCell,
  ColumnDef,
  FilterFn,
  SortFn,
  Table,
} from "@tanstack/react-table";

type SheetRow = { rowNumber: number };

const features = tableFeatures({
  cellSelectionFeature,
  columnSizingFeature,
  columnResizingFeature,
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
});

type SheetColumnDef = ColumnDef<typeof features, SheetRow>;
type SheetTable = Table<typeof features, SheetRow>;
type SheetCell = TableCell<typeof features, SheetRow, unknown>;

const ROW_HEADER_ID = "__rowHeader";
const HEADER_HEIGHT = 26;
const ROW_HEADER_WIDTH = 48;

// --- sorting / filtering (display-only view state) ---------------------------
// Data columns expose their evaluated display value via accessorFn (numeric
// strings become numbers). Both functions below are passed straight to the
// column defs — v9 needs no registry for directly-passed fns. The built-in
// auto sort inference samples row values and warns on unregistered names, so
// an explicit comparator keeps behavior independent of cell contents.

/** Numbers sort numerically before text; text compares locale-aware. */
function compareCellValues(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a === b ? 0 : a < b ? -1 : 1;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  return String(a).localeCompare(String(b), "ja");
}

const sortFn_cellValues: SortFn<typeof features, SheetRow> = (rowA, rowB, columnId) =>
  compareCellValues(rowA.getValue(columnId), rowB.getValue(columnId));

/** Case-insensitive substring match over the stringified display value. */
const filterFn_cellText: FilterFn<typeof features, SheetRow> = (row, columnId, filterValue) =>
  String(row.getValue(columnId) ?? "")
    .toLowerCase()
    .includes(String(filterValue).toLowerCase());

function cycleSort(colId: string) {
  sortingAtom.set((prev) => {
    const current = prev.find((s) => s.id === colId);
    if (!current) return [{ id: colId, desc: false }];
    if (!current.desc) return [{ id: colId, desc: true }];
    return [];
  });
}

function setColumnFilter(colId: string, value: string) {
  columnFiltersAtom.set((prev) => {
    const rest = prev.filter((f) => f.id !== colId);
    return value === "" ? rest : [...rest, { id: colId, value }];
  });
}

const ARROW_DIRECTIONS: Record<string, CellSelectionDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Contiguous whole-column span covered by the latest range, if any. */
function fullColumnSpan(
  sel: CellSelectionState,
  rows: number,
): { start: number; end: number } | null {
  const last = sel[sel.length - 1];
  if (!last) return null;
  const r1 = Number(last.anchorRowId);
  const r2 = Number(last.focusRowId);
  if (Math.min(r1, r2) !== 1 || Math.max(r1, r2) !== rows) return null;
  const c1 = labelToColumnIndex(last.anchorColumnId);
  const c2 = labelToColumnIndex(last.focusColumnId);
  if (c1 < 0 || c2 < 0) return null;
  return { start: Math.min(c1, c2), end: Math.max(c1, c2) };
}

/** Contiguous whole-row span covered by the latest range, if any. */
function fullRowSpan(sel: CellSelectionState, cols: number): { start: number; end: number } | null {
  const last = sel[sel.length - 1];
  if (!last) return null;
  const c1 = labelToColumnIndex(last.anchorColumnId);
  const c2 = labelToColumnIndex(last.focusColumnId);
  if (Math.min(c1, c2) !== 0 || Math.max(c1, c2) !== cols - 1) return null;
  const r1 = Number(last.anchorRowId);
  const r2 = Number(last.focusRowId);
  if (!Number.isInteger(r1) || !Number.isInteger(r2) || r1 < 1 || r2 < 1) return null;
  return { start: Math.min(r1, r2), end: Math.max(r1, r2) };
}

function selectWholeColumns(start: number, end: number) {
  const { rows } = sheetStore.state;
  cellSelectionAtom.set([
    {
      anchorColumnId: columnLabel(start),
      anchorRowId: "1",
      focusColumnId: columnLabel(end),
      focusRowId: String(rows),
    },
  ]);
}

function selectWholeRows(start: number, end: number) {
  const { cols } = sheetStore.state;
  cellSelectionAtom.set([
    {
      anchorColumnId: "A",
      anchorRowId: String(start),
      focusColumnId: columnLabel(cols - 1),
      focusRowId: String(end),
    },
  ]);
}

/** Header click: plain click selects the column, shift-click extends. */
function clickColumnHeader(colIndex: number, extend: boolean) {
  const { rows } = sheetStore.state;
  if (extend) {
    cellSelectionAtom.set((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      return [
        ...prev.slice(0, -1),
        {
          ...last,
          anchorRowId: "1",
          focusColumnId: columnLabel(colIndex),
          focusRowId: String(rows),
        },
      ];
    });
  } else {
    selectWholeColumns(colIndex, colIndex);
  }
}

function clickRowHeader(rowNumber: number, extend: boolean) {
  const { cols } = sheetStore.state;
  if (extend) {
    cellSelectionAtom.set((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      return [
        ...prev.slice(0, -1),
        {
          ...last,
          anchorColumnId: "A",
          focusColumnId: columnLabel(cols - 1),
          focusRowId: String(rowNumber),
        },
      ];
    });
  } else {
    selectWholeRows(rowNumber, rowNumber);
  }
}

/** Commit one cell value as a single history step; no-op commits record nothing. */
function setCellWithHistory(id: string, value: string) {
  const current = activeCells().get(id)?.raw;
  const unchanged = current === undefined ? value.trim() === "" : current === value;
  if (unchanged) return;
  runOperation(() => setCell(id, value));
}

function CellEditor({ id, initial }: { id: string; initial: string }) {
  const [value, setValue] = useState(initial);
  const committedRef = useRef(false);

  const commit = (dCol: number, dRow: number) => {
    if (committedRef.current) return;
    committedRef.current = true;
    setCellWithHistory(id, value);
    stopEditing();
    if (dCol !== 0 || dRow !== 0) moveActive(dCol, dRow);
  };

  return (
    // 行数に応じて下方向に伸び、編集中だけ下のセルに重なる（1 行なら 26px で現状どおり）。
    // z-[1] は後続行の CellView (relative, z-auto) より手前、sticky ヘッダ (z-10/20/30) より奥
    <textarea
      className="absolute inset-x-0 top-0 z-[1] min-h-full w-full resize-none overflow-hidden border-2 border-[var(--palm)] bg-[var(--surface-strong)] px-1.5 font-mono text-[13px] leading-[22px] text-[var(--sea-ink)] outline-none"
      value={value}
      rows={value.split("\n").length}
      wrap="off"
      autoFocus
      onFocus={(e) => {
        const len = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(len, len);
      }}
      onChange={(e) => setValue(e.target.value)}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => commit(0, 0)}
      onKeyDown={(e) => {
        // IME 変換確定の Enter/Tab/Escape を編集操作として扱わない
        // (Safari は compositionend 直後も keyCode 229 が残ることがある)
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          if (e.altKey || e.shiftKey) {
            // Alt+Enter は既定では改行にならないブラウザがあるため明示的に挿入する。
            // setRangeText 後の state が DOM 値と一致するので再レンダーでカーソルは動かない
            e.preventDefault();
            const el = e.currentTarget;
            el.setRangeText(
              "\n",
              el.selectionStart ?? el.value.length,
              el.selectionEnd ?? el.value.length,
              "end",
            );
            setValue(el.value);
            return;
          }
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
  cell,
  id,
  raw,
  display,
}: {
  cell: SheetCell;
  id: string;
  raw: string | undefined;
  display: string;
}) {
  // subscribe to the selection atom, but derive per-cell facts through the
  // table's memoized bounds so only affected cells re-render
  const sel = useSelector(
    cellSelectionAtom,
    () => ({
      selected: cell.getIsSelected(),
      focused: cell.getIsFocused(),
      ...cell.getSelectionEdges(),
    }),
    { compare: shallow },
  );
  const isEditing = useStore(sheetStore, (s) => s.editing?.cellId === id);
  const seed = useStore(sheetStore, (s) => (s.editing?.cellId === id ? s.editing.seed : null));

  const isError = display === ERROR_VALUE || display === REF_ERROR_VALUE;
  const isNumeric = !isError && display !== "" && !Number.isNaN(Number(display));
  // 複数行の値は 1 行目だけ見せて、続きがあることを ⏎ で示す（行高 26px は維持）
  const newlineIndex = display.indexOf("\n");

  // range outline: paint only the outer edges of the selection
  const edgeShadows: Array<string> = [];
  if (sel.selected && !sel.focused) {
    if (sel.top) edgeShadows.push("inset 0 1px 0 0 var(--palm)");
    if (sel.bottom) edgeShadows.push("inset 0 -1px 0 0 var(--palm)");
    if (sel.left) edgeShadows.push("inset 1px 0 0 0 var(--palm)");
    if (sel.right) edgeShadows.push("inset -1px 0 0 0 var(--palm)");
  }

  return (
    <div
      data-cell-id={id}
      data-selected={sel.selected ? "true" : undefined}
      className={`relative h-full w-full px-1.5 leading-[26px] ${
        isNumeric ? "text-right" : "text-left"
      } ${isError ? "text-red-600 dark:text-red-400" : ""} ${
        sel.focused
          ? "outline outline-2 -outline-offset-1 outline-[var(--palm)] bg-[color-mix(in_srgb,var(--palm)_8%,transparent)]"
          : sel.selected
            ? "bg-[color-mix(in_srgb,var(--palm)_8%,transparent)]"
            : ""
      }`}
      style={edgeShadows.length > 0 ? { boxShadow: edgeShadows.join(", ") } : undefined}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        cell.getSelectionStartHandler()(e);
      }}
      onMouseEnter={(e) => cell.getSelectionExtendHandler()(e)}
      onDoubleClick={() => startEditing(id)}
    >
      <span className="flex items-baseline">
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
          {newlineIndex === -1 ? display : display.slice(0, newlineIndex)}
        </span>
        {newlineIndex !== -1 && (
          // shrink-0 で、1 行目が ellipsis で切り詰められても目印は常に見せる
          <span className="ml-1 shrink-0 text-[10px] text-[var(--sea-ink-soft)]">⏎</span>
        )}
      </span>
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
          // IME 変換確定の Enter/Escape を編集操作として扱わない
          // (Safari は compositionend 直後も keyCode 229 が残ることがある)
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            setCellWithHistory(selected, value);
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValue(raw);
          }
        }}
      />
    </div>
  );
}

function FormulaBarSlot({ getRaw }: { getRaw: GetRaw }) {
  const selected = useSelector(cellSelectionAtom, activeCellIdOf);
  const raw = getRaw(selected) ?? "";
  return <FormulaBar key={`${selected}:${raw}`} selected={selected} raw={raw} />;
}

const toolbarButtonClass =
  "rounded border border-[var(--line)] bg-[var(--surface)] px-2 py-0.5 text-xs text-[var(--sea-ink)] transition hover:border-[var(--palm)] disabled:cursor-default disabled:opacity-40 disabled:hover:border-[var(--line)]";

function UndoRedoButtons() {
  const { canUndo, canRedo } = useSelector(historyAtom);
  return (
    <>
      <button
        type="button"
        className={toolbarButtonClass}
        disabled={!canUndo}
        onClick={undo}
        title="元に戻す (⌘Z)"
      >
        ↩ 元に戻す
      </button>
      <button
        type="button"
        className={toolbarButtonClass}
        disabled={!canRedo}
        onClick={redo}
        title="やり直す (⌘⇧Z)"
      >
        ↪ やり直す
      </button>
    </>
  );
}

/** Contextual delete buttons, visible while whole rows / columns are selected. */
function StructureToolbar() {
  const sel = useSelector(cellSelectionAtom);
  const cols = useStore(sheetStore, (s) => s.cols);
  const rows = useStore(sheetStore, (s) => s.rows);

  const colSpan = fullColumnSpan(sel, rows);
  const rowSpan = fullRowSpan(sel, cols);

  // No confirm dialog: undo is the safety net for deletes (and native dialogs
  // are suppressed in some embedded browsers, which silently aborted deletes).
  const deleteSelectedColumns = () => {
    if (!colSpan) return;
    const targets = Array.from(
      { length: colSpan.end - colSpan.start + 1 },
      (_, i) => colSpan.start + i,
    );
    if (!deleteColumns(targets)) window.alert("最低 1 列は残す必要があります");
  };

  const deleteSelectedRows = () => {
    if (!rowSpan) return;
    const targets = Array.from(
      { length: rowSpan.end - rowSpan.start + 1 },
      (_, i) => rowSpan.start + i,
    );
    if (!deleteRows(targets)) window.alert("最低 1 行は残す必要があります");
  };

  return (
    <>
      {colSpan && (
        <button
          type="button"
          className={toolbarButtonClass}
          onClick={() => insertColumns(colSpan.start, colSpan.end - colSpan.start + 1)}
        >
          左に {colSpan.end - colSpan.start + 1} 列挿入
        </button>
      )}
      {colSpan && (
        <button type="button" className={toolbarButtonClass} onClick={deleteSelectedColumns}>
          {colSpan.start === colSpan.end
            ? `${columnLabel(colSpan.start)} 列を削除`
            : `${columnLabel(colSpan.start)}〜${columnLabel(colSpan.end)} 列を削除`}
        </button>
      )}
      {rowSpan && (
        <button
          type="button"
          className={toolbarButtonClass}
          onClick={() => insertRows(rowSpan.start, rowSpan.end - rowSpan.start + 1)}
        >
          上に {rowSpan.end - rowSpan.start + 1} 行挿入
        </button>
      )}
      {rowSpan && (
        <button type="button" className={toolbarButtonClass} onClick={deleteSelectedRows}>
          {rowSpan.start === rowSpan.end
            ? `行 ${rowSpan.start} を削除`
            : `行 ${rowSpan.start}〜${rowSpan.end} を削除`}
        </button>
      )}
    </>
  );
}

function SelectionSummary() {
  const sel = useSelector(cellSelectionAtom);
  const last = sel[sel.length - 1];
  if (!last) return null;
  const c1 = labelToColumnIndex(last.anchorColumnId);
  const c2 = labelToColumnIndex(last.focusColumnId);
  const r1 = Number(last.anchorRowId);
  const r2 = Number(last.focusRowId);
  if (c1 < 0 || c2 < 0 || !Number.isInteger(r1) || !Number.isInteger(r2)) return null;
  const from = cellId(Math.min(c1, c2), Math.min(r1, r2));
  const to = cellId(Math.max(c1, c2), Math.max(r1, r2));
  if (from === to) return <span>{from}</span>;
  const count = (Math.abs(c1 - c2) + 1) * (Math.abs(r1 - r2) + 1);
  return (
    <span>
      {from}:{to}（{count} セル）
    </span>
  );
}

/** Keeps the moving corner of the selection visible past the sticky headers. */
function AutoScrollFollower({ gridRef }: { gridRef: React.RefObject<HTMLDivElement | null> }) {
  const focusId = useSelector(cellSelectionAtom, (sel) => {
    // a header click selects a whole row/column whose focus corner sits at the
    // far edge of the grid — chasing it would fling the viewport away
    const { cols, rows } = sheetStore.state;
    if (fullColumnSpan(sel, rows) || fullRowSpan(sel, cols)) return null;
    return focusCellIdOf(sel);
  });

  useEffect(() => {
    const container = gridRef.current;
    if (!container || focusId === null) return;
    const el = container.querySelector<HTMLElement>(`[data-cell-id="${focusId}"]`);
    if (!el) return;
    const containerRect = container.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    // scrollIntoView would tuck the cell under the sticky header / row-header
    // column, so subtract them from the visible area by hand
    const leftBound = containerRect.left + ROW_HEADER_WIDTH;
    const topBound = containerRect.top + HEADER_HEIGHT;
    const rightBound = containerRect.left + container.clientWidth;
    const bottomBound = containerRect.top + container.clientHeight;
    let dx = 0;
    let dy = 0;
    if (rect.left < leftBound) dx = rect.left - leftBound;
    else if (rect.right > rightBound) dx = rect.right - rightBound;
    if (rect.top < topBound) dy = rect.top - topBound;
    else if (rect.bottom > bottomBound) dy = rect.bottom - bottomBound;
    if (dx !== 0 || dy !== 0) container.scrollBy({ left: dx, top: dy });
  }, [focusId, gridRef]);

  return null;
}

/** Per-column sort/filter popover, anchored under the column header. */
function HeaderMenu({ colId }: { colId: string }) {
  const sorting = useSelector(sortingAtom);
  const filters = useSelector(columnFiltersAtom);
  const sortEntry = sorting.find((s) => s.id === colId);
  const filterValue = String(filters.find((f) => f.id === colId)?.value ?? "");
  const sortLabel = sortEntry ? (sortEntry.desc ? "降順 ▼" : "昇順 ▲") : "なし";

  return (
    <div
      data-header-menu
      className="absolute left-0 top-full z-40 flex w-48 flex-col gap-2 rounded border border-[var(--line)] bg-[var(--surface-strong)] p-2 text-left font-sans text-xs font-normal text-[var(--sea-ink)] shadow-lg"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={toolbarButtonClass}
        title="クリックで 昇順 → 降順 → 解除 を巡回"
        onClick={() => cycleSort(colId)}
      >
        ソート: {sortLabel}
      </button>
      <label className="flex flex-col gap-1">
        <span className="text-[var(--sea-ink-soft)]">フィルタ（部分一致）</span>
        <input
          className="rounded border border-[var(--line)] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[13px] outline-none focus:border-[var(--palm)]"
          value={filterValue}
          autoFocus
          onChange={(e) => setColumnFilter(colId, e.target.value)}
        />
      </label>
      <button
        type="button"
        className={toolbarButtonClass}
        disabled={filterValue === ""}
        onClick={() => setColumnFilter(colId, "")}
      >
        フィルタ解除
      </button>
    </div>
  );
}

type DragBlock = { kind: "col" | "row"; start: number; end: number };
type DropIndicator = { kind: "col" | "row"; insert: number };

function SheetGrid({ sheetId }: { sheetId: string }) {
  const cols = useStore(sheetStore, (s) => s.cols);
  const rows = useStore(sheetStore, (s) => s.rows);
  const editing = useStore(sheetStore, (s) => s.editing);
  const gridRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragBlock | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  // stable per sheet, and this component remounts (key={sheetId}) on switch
  const collection = getCellsCollection(sheetId);

  // spread-select like the official demo: a bare from() emits non-congruent
  // rows for the same key when a cell is updated (react-db 0.x)
  const { data: cellRows } = useLiveQuery((q) =>
    q.from({ cell: collection }).select(({ cell }) => ({ ...cell })),
  );

  const cellMap = useMemo(() => new Map(cellRows.map((c) => [c.id, c.raw])), [cellRows]);
  const getRaw = useCallback<GetRaw>((id) => cellMap.get(id), [cellMap]);

  // re-render on width changes so column.getSize() reads fresh values
  useSelector(columnSizingAtom);

  // re-render on view-state changes so getRowModel() reflects sort/filter
  const sorting = useSelector(sortingAtom);
  const columnFilters = useSelector(columnFiltersAtom);
  const viewActive = sorting.length > 0 || columnFilters.length > 0;
  const [menuColId, setMenuColId] = useState<string | null>(null);

  // close the header menu on any click outside it
  useEffect(() => {
    if (menuColId === null) return;
    const close = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-header-menu]")) {
        setMenuColId(null);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuColId]);

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

  // Column widths for this sheet: reset the (module-level) atom, follow the
  // server over the shared SSE stream — the immediate cached snapshot doubles
  // as the initial load — and persist local changes (debounced, since a resize
  // drag updates the atom on every mousemove). Ordering matters: the reset and
  // the snapshot apply happen before the persist subscription exists, so
  // loading a sheet never echoes its own widths back to the server.
  useEffect(() => {
    const apply = (widths: Record<string, number>) => {
      if (JSON.stringify(columnSizingAtom.get()) !== JSON.stringify(widths)) {
        columnSizingAtom.set(widths);
      }
    };
    columnSizingAtom.set({});
    const unsubscribe = subscribeSheetSync(sheetId, {
      onSnapshot: (data) => apply(data.widths),
      onWidths: apply,
    });
    const sub = columnSizingAtom.subscribe((widths) => persistWidthsDebounced(widths, sheetId));
    return () => {
      sub.unsubscribe();
      unsubscribe();
    };
  }, [sheetId]);

  // Sort/filter view for this sheet (localStorage, tab-independent). The atoms
  // are module-level, so set them unconditionally — they still hold the
  // previous sheet's view — before subscribing the persister.
  useEffect(() => {
    const saved = loadPersistedViewState(sheetId);
    sortingAtom.set(saved?.sorting ?? []);
    columnFiltersAtom.set(saved?.columnFilters ?? []);
    const persist = () => persistViewState(sheetId);
    const subs = [sortingAtom.subscribe(persist), columnFiltersAtom.subscribe(persist)];
    return () => {
      for (const sub of subs) sub.unsubscribe();
    };
  }, [sheetId]);

  // cellMap is a dependency on purpose: row identity is what invalidates the
  // memoized sorted/filtered row models, so cell edits re-evaluate the view
  // (accessorFn reads getRaw, which the table cannot track by itself)
  const data = useMemo<Array<SheetRow>>(
    () => Array.from({ length: rows }, (_, i) => ({ rowNumber: i + 1 })),
    // oxlint-disable-next-line react/memo-dependencies, react-hooks/exhaustive-deps
    [rows, cellMap],
  );

  const columns = useMemo<Array<SheetColumnDef>>(
    () => [
      {
        id: ROW_HEADER_ID,
        size: ROW_HEADER_WIDTH,
        enableResizing: false,
        enableCellSelection: false,
        enableSorting: false,
        enableColumnFilter: false,
        header: () => "",
        cell: (info) => info.row.original.rowNumber,
      },
      ...Array.from({ length: cols }, (_, c): SheetColumnDef => {
        const label = columnLabel(c);
        return {
          id: label,
          // evaluated display value for sorting/filtering; numeric-looking
          // values become numbers, empty cells undefined (pushed last)
          accessorFn: (row) => {
            const display = displayValue(
              `${label}${row.rowNumber}`,
              getRaw(`${label}${row.rowNumber}`),
              getRaw,
            );
            if (display === "") return undefined;
            const n = Number(display);
            return Number.isNaN(n) ? display : n;
          },
          sortFn: sortFn_cellValues,
          sortUndefined: "last",
          filterFn: filterFn_cellText,
          size: 88,
          minSize: 48,
          maxSize: 480,
          header: () => label,
          cell: (info) => {
            const id = `${label}${info.row.original.rowNumber}`;
            const raw = getRaw(id);
            return (
              <CellView
                cell={info.cell}
                id={id}
                raw={raw}
                display={displayValue(id, raw, getRaw)}
              />
            );
          },
        };
      }),
    ],
    [cols, getRaw],
  );

  const table: SheetTable = useTable({
    features,
    data,
    columns,
    getRowId: (row) => String(row.rowNumber),
    atoms: {
      cellSelection: cellSelectionAtom,
      columnSizing: columnSizingAtom,
      sorting: sortingAtom,
      columnFilters: columnFiltersAtom,
    },
    autoResetCellSelection: false,
    columnResizeMode: "onChange",
  });

  // Vertical moves after an edit commit must follow the view order, or the
  // active cell walks into rows the current filter hides and the next keystroke
  // edits an invisible cell.
  useEffect(() => {
    setRowNavigator((rowNumber, dRow) => {
      const visible = table.getRowModel().rows;
      const index = visible.findIndex((r) => r.original.rowNumber === rowNumber);
      if (index < 0) return visible[0]?.original.rowNumber ?? rowNumber;
      const next = visible[Math.min(Math.max(index + dRow, 0), visible.length - 1)];
      return next?.original.rowNumber ?? rowNumber;
    });
    return () => setRowNavigator(null);
  }, [table]);

  const clearSelectedCells = () => {
    const leafColumns = table.getAllLeafColumns();
    const modelRows = table.getRowModel().rows;
    const ids: Array<string> = [];
    for (const bounds of table.getCellSelectionBounds()) {
      for (let r = bounds.minRowIndex; r <= bounds.maxRowIndex; r++) {
        const rowNumber = Number(modelRows[r]?.id);
        if (!Number.isInteger(rowNumber)) continue;
        for (let c = bounds.minColumnIndex; c <= bounds.maxColumnIndex; c++) {
          const column = leafColumns[c];
          if (!column || column.id === ROW_HEADER_ID) continue;
          const id = `${column.id}${rowNumber}`;
          if (cellMap.has(id)) ids.push(id);
        }
      }
    }
    if (ids.length === 0) return;
    runOperation(() => {
      for (const id of ids) setCell(id, "");
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const direction = ARROW_DIRECTIONS[e.key];
    if (direction) {
      e.preventDefault();
      if (e.shiftKey) table.extendCellSelection(direction);
      else table.moveCellSelection(direction);
      return;
    }
    switch (e.key) {
      case "Tab":
        e.preventDefault();
        table.moveCellSelection(e.shiftKey ? "left" : "right");
        return;
      case "Enter":
      case "F2":
        e.preventDefault();
        startEditing(activeCellIdOf(cellSelectionAtom.get()));
        return;
      case "Delete":
      case "Backspace":
        e.preventDefault();
        clearSelectedCells();
        return;
      default:
        if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
          e.preventDefault();
          table.selectAllCells();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
        if ((e.metaKey || e.ctrlKey) && (e.key === "y" || e.key === "Y")) {
          e.preventDefault();
          redo();
          return;
        }
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          startEditing(activeCellIdOf(cellSelectionAtom.get()), e.key);
        }
    }
  };

  const handleCopy = (e: React.ClipboardEvent) => {
    if (editing || !e.clipboardData) return;
    // like Excel, copy covers a single rectangle (the first one)
    const bounds = table.getCellSelectionBounds()[0];
    if (!bounds) return;
    const leafColumns = table.getAllLeafColumns();
    const modelRows = table.getRowModel().rows;
    const lines: Array<Array<string>> = [];
    for (let r = bounds.minRowIndex; r <= bounds.maxRowIndex; r++) {
      const rowNumber = Number(modelRows[r]?.id);
      const parts: Array<string> = [];
      for (let c = bounds.minColumnIndex; c <= bounds.maxColumnIndex; c++) {
        const column = leafColumns[c];
        if (!column || column.id === ROW_HEADER_ID) continue;
        parts.push(Number.isInteger(rowNumber) ? (getRaw(`${column.id}${rowNumber}`) ?? "") : "");
      }
      lines.push(parts);
    }
    e.clipboardData.setData("text/plain", encodeTsv(lines));
    e.preventDefault();
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const lines = parseTsv(text);
    // 末尾の改行（Excel コピーの慣例）が生む空行は貼り付け対象にしない
    const last = lines[lines.length - 1];
    if (lines.length > 1 && last?.length === 1 && last[0] === "") lines.pop();
    const origin = activeCellPos(cellSelectionAtom.get());
    let width = 0;
    runOperation(() => {
      lines.forEach((values, i) => {
        width = Math.max(width, values.length);
        values.forEach((value, j) => {
          const colIndex = origin.colIndex + j;
          const rowNumber = origin.rowNumber + i;
          ensureFits(colIndex, rowNumber);
          setCell(cellId(colIndex, rowNumber), value);
        });
      });
    });
    cellSelectionAtom.set([
      {
        anchorColumnId: columnLabel(origin.colIndex),
        anchorRowId: String(origin.rowNumber),
        focusColumnId: columnLabel(origin.colIndex + width - 1),
        focusRowId: String(origin.rowNumber + lines.length - 1),
      },
    ]);
  };

  // --- header drag & drop (move columns / rows) ------------------------------

  const startColumnDrag = (colIndex: number, e: React.DragEvent) => {
    // structural moves are disabled while a sort/filter view is active
    if (viewActive) {
      e.preventDefault();
      return;
    }
    // a resize grab also starts a native drag of the draggable header
    // (stopPropagation on the handle's mousedown cannot suppress it), so
    // cancel the drag while a resize interaction is open
    if (table.atoms.columnResizing?.get().isResizingColumn !== false) {
      e.preventDefault();
      return;
    }
    const span = fullColumnSpan(cellSelectionAtom.get(), sheetStore.state.rows);
    const block =
      span && colIndex >= span.start && colIndex <= span.end
        ? span
        : { start: colIndex, end: colIndex };
    selectWholeColumns(block.start, block.end);
    dragRef.current = { kind: "col", ...block };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  };

  const startRowDrag = (rowNumber: number, e: React.DragEvent) => {
    if (viewActive) {
      e.preventDefault();
      return;
    }
    const span = fullRowSpan(cellSelectionAtom.get(), sheetStore.state.cols);
    const block =
      span && rowNumber >= span.start && rowNumber <= span.end
        ? span
        : { start: rowNumber, end: rowNumber };
    selectWholeRows(block.start, block.end);
    dragRef.current = { kind: "row", ...block };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  };

  const dragOverColumn = (colIndex: number, e: React.DragEvent) => {
    if (dragRef.current?.kind !== "col") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const insert = e.clientX < rect.left + rect.width / 2 ? colIndex : colIndex + 1;
    setDropIndicator((d) =>
      d?.kind === "col" && d.insert === insert ? d : { kind: "col", insert },
    );
  };

  const dragOverRow = (rowNumber: number, e: React.DragEvent) => {
    if (dragRef.current?.kind !== "row") return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const insert = e.clientY < rect.top + rect.height / 2 ? rowNumber : rowNumber + 1;
    setDropIndicator((d) =>
      d?.kind === "row" && d.insert === insert ? d : { kind: "row", insert },
    );
  };

  const endDrag = () => {
    dragRef.current = null;
    setDropIndicator(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const drag = dragRef.current;
    if (drag && dropIndicator && drag.kind === dropIndicator.kind) {
      if (drag.kind === "col") {
        if (moveColumns(drag.start, drag.end, dropIndicator.insert)) {
          const size = drag.end - drag.start + 1;
          const newStart =
            dropIndicator.insert < drag.start ? dropIndicator.insert : dropIndicator.insert - size;
          selectWholeColumns(newStart, newStart + size - 1);
        }
      } else {
        if (moveRows(drag.start, drag.end, dropIndicator.insert)) {
          const size = drag.end - drag.start + 1;
          const newStart =
            dropIndicator.insert < drag.start ? dropIndicator.insert : dropIndicator.insert - size;
          selectWholeRows(newStart, newStart + size - 1);
        }
      }
    }
    endDrag();
  };

  const columnInsert = dropIndicator?.kind === "col" ? dropIndicator.insert : null;
  const rowInsert = dropIndicator?.kind === "row" ? dropIndicator.insert : null;

  const sortDirByCol = new Map(sorting.map((s) => [s.id, s.desc ? "desc" : "asc"] as const));
  const filteredCols = new Set(columnFilters.map((f) => f.id));
  const visibleRows = table.getRowModel().rows;

  /** 2px insertion indicator on the edge a dragged block would land on. */
  const dropIndicatorShadow = (dataColIndex: number, rowNumber: number): string | undefined => {
    const parts: Array<string> = [];
    if (columnInsert !== null) {
      if (columnInsert === dataColIndex) parts.push("inset 2px 0 0 0 var(--palm)");
      else if (dataColIndex === cols - 1 && columnInsert === cols) {
        parts.push("inset -2px 0 0 0 var(--palm)");
      }
    }
    if (rowInsert !== null) {
      if (rowInsert === rowNumber) parts.push("inset 0 2px 0 0 var(--palm)");
      else if (rowNumber === rows && rowInsert === rows + 1) {
        parts.push("inset 0 -2px 0 0 var(--palm)");
      }
    }
    return parts.length > 0 ? parts.join(", ") : undefined;
  };

  return (
    <div className="flex h-dvh flex-col bg-[var(--bg-base)]">
      <header className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1.5">
        <h1 className="text-sm font-bold tracking-tight text-[var(--palm)]">
          tanstack-spreadsheet
        </h1>
        <div className="flex gap-1.5">
          <button type="button" className={toolbarButtonClass} onClick={addRow}>
            + 行
          </button>
          <button type="button" className={toolbarButtonClass} onClick={addColumn}>
            + 列
          </button>
          <UndoRedoButtons />
          {viewActive ? (
            <>
              <span className="text-xs text-[var(--sea-ink-soft)]">
                表示:{" "}
                {[
                  ...sorting.map((s) => `${s.id} ${s.desc ? "▼" : "▲"}`),
                  ...(columnFilters.length > 0 ? [`${columnFilters.length} 列フィルタ`] : []),
                ].join(" · ")}{" "}
                ({visibleRows.length}/{rows} 行)
              </span>
              <button
                type="button"
                className={toolbarButtonClass}
                title="ソートとフィルタを解除して元の並びに戻す"
                onClick={clearViewState}
              >
                解除
              </button>
            </>
          ) : (
            // structural ops are hidden while a view is active: column-id based
            // filter state would go stale across deletes, and insert positions
            // are ambiguous on a reordered view
            <StructureToolbar />
          )}
        </div>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </header>

      <FormulaBarSlot getRaw={getRaw} />
      <AutoScrollFollower gridRef={gridRef} />

      <div
        ref={gridRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onCopy={handleCopy}
        onPaste={handlePaste}
        className="flex-1 select-none overflow-auto outline-none"
      >
        <table
          className="table-fixed border-separate border-spacing-0 font-mono text-[13px] tabular-nums text-[var(--sea-ink)]"
          style={{ width: table.getTotalSize() }}
        >
          <thead className="sticky top-0 z-20">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header, i) => {
                  const isRowHeader = i === 0;
                  const dataColIndex = isRowHeader ? -1 : labelToColumnIndex(header.column.id);
                  return (
                    <th
                      key={header.id}
                      style={{
                        width: header.column.getSize(),
                        boxShadow: isRowHeader ? undefined : dropIndicatorShadow(dataColIndex, 0),
                      }}
                      className={`relative h-[26px] border-b border-r border-[var(--line)] bg-[var(--sand)] p-0 text-center text-xs font-semibold text-[var(--sea-ink-soft)] ${
                        isRowHeader ? "sticky left-0 z-30" : ""
                      }`}
                    >
                      {isRowHeader ? null : (
                        <div
                          className="group flex h-full w-full cursor-pointer items-center justify-center"
                          draggable
                          onClick={(e) => clickColumnHeader(dataColIndex, e.shiftKey)}
                          onDragStart={(e) => startColumnDrag(dataColIndex, e)}
                          onDragOver={(e) => dragOverColumn(dataColIndex, e)}
                          onDrop={handleDrop}
                          onDragEnd={endDrag}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sortDirByCol.get(header.column.id) && (
                            <span className="ml-0.5 text-[10px] text-[var(--palm)]">
                              {sortDirByCol.get(header.column.id) === "asc" ? "▲" : "▼"}
                            </span>
                          )}
                          <button
                            type="button"
                            data-header-menu
                            draggable={false}
                            title="ソート / フィルタ"
                            className={`absolute right-[8px] top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-[10px] transition-colors hover:bg-[color-mix(in_srgb,var(--palm)_18%,transparent)] hover:text-[var(--palm)] ${
                              filteredCols.has(header.column.id)
                                ? "text-[var(--palm)]"
                                : "text-[var(--sea-ink-soft)]"
                            } ${
                              menuColId === header.column.id ||
                              sortDirByCol.has(header.column.id) ||
                              filteredCols.has(header.column.id)
                                ? "opacity-100"
                                : "opacity-0 group-hover:opacity-100"
                            }`}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                              e.stopPropagation();
                              setMenuColId((cur) =>
                                cur === header.column.id ? null : header.column.id,
                              );
                            }}
                          >
                            ▾
                          </button>
                          {header.column.getCanResize() && (
                            <div
                              className={`absolute right-0 top-0 z-10 h-full w-[7px] cursor-col-resize touch-none select-none ${
                                header.column.getIsResizing()
                                  ? "bg-[var(--palm)]"
                                  : "hover:bg-[color-mix(in_srgb,var(--palm)_45%,transparent)]"
                              }`}
                              draggable={false}
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                header.getResizeHandler()(e);
                              }}
                              onTouchStart={header.getResizeHandler()}
                              onClick={(e) => e.stopPropagation()}
                            />
                          )}
                        </div>
                      )}
                      {!isRowHeader && menuColId === header.column.id && (
                        <HeaderMenu colId={header.column.id} />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const rowNumber = row.original.rowNumber;
              return (
                <tr key={row.id}>
                  {row.getAllCells().map((cell, i) => {
                    const isRowHeader = i === 0;
                    const dataColIndex = isRowHeader ? -1 : labelToColumnIndex(cell.column.id);
                    return (
                      <td
                        key={cell.id}
                        style={{ boxShadow: dropIndicatorShadow(dataColIndex, rowNumber) }}
                        className={`h-[26px] border-b border-r border-[var(--line)] p-0 ${
                          isRowHeader
                            ? "sticky left-0 z-10 cursor-pointer bg-[var(--sand)] text-center text-xs font-semibold text-[var(--sea-ink-soft)]"
                            : "bg-[var(--surface)]"
                        }`}
                        {...(isRowHeader
                          ? {
                              draggable: true,
                              onClick: (e: React.MouseEvent) =>
                                clickRowHeader(rowNumber, e.shiftKey),
                              onDragStart: (e: React.DragEvent) => startRowDrag(rowNumber, e),
                              onDragOver: (e: React.DragEvent) => dragOverRow(rowNumber, e),
                              onDrop: handleDrop,
                              onDragEnd: endDrag,
                            }
                          : {})}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {visibleRows.length === 0 && (
          <div className="p-6 text-center text-xs text-[var(--sea-ink-soft)]">
            フィルタに一致する行がありません
          </div>
        )}
      </div>

      <SheetTabs />

      <footer className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1 text-xs text-[var(--sea-ink-soft)]">
        <span>
          {cols} 列 × {rows} 行
        </span>
        <span className="flex items-center gap-3">
          <SelectionSummary />
          <span>{cellMap.size} セル入力済み · サーバー (SQLite) にタブ間同期</span>
        </span>
      </footer>
    </div>
  );
}

export default function Spreadsheet() {
  const sheetId = useSelector(activeSheetIdAtom);

  // sheet list mirror + fallback when the active sheet disappears
  useEffect(() => {
    initSheetsSync();
  }, []);

  // Remount the grid per sheet: every mount-scoped effect and hook (widths,
  // view state, live query) then naturally re-runs against the new sheet, and
  // no stale subscription can persist one sheet's state under another's id.
  return <SheetGrid key={sheetId} sheetId={sheetId} />;
}
