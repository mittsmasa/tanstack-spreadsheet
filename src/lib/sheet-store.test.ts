// The store is module-level state, so every test starts from the same reset.
// No DOM here: localStorage is absent in node and every access is wrapped in
// try/catch in the store, which is exactly the "storage unavailable" path.

import { beforeEach, describe, expect, it } from "vitest";

import {
  INITIAL_COLS,
  INITIAL_ROWS,
  activeBookIdAtom,
  activeCellIdOf,
  activeCellPos,
  activeSheetIdAtom,
  addColumn,
  addRow,
  cellSelectionAtom,
  clearViewState,
  collapsedRange,
  columnFiltersAtom,
  ensureFits,
  focusCellIdOf,
  loadPersistedViewState,
  moveActive,
  persistViewState,
  setActiveBook,
  setActiveCell,
  setRowNavigator,
  sheetStore,
  sheetsAtom,
  sortingAtom,
  startEditing,
  stopEditing,
  switchSheet,
} from "#/lib/sheet-store";

beforeEach(() => {
  sheetStore.setState(() => ({ editing: null, cols: INITIAL_COLS, rows: INITIAL_ROWS }));
  cellSelectionAtom.set([collapsedRange(0, 1)]);
  setRowNavigator(null);
  clearViewState();
});

describe("collapsedRange", () => {
  it("builds a single-cell range keyed by column label and row number", () => {
    expect(collapsedRange(2, 5)).toEqual({
      anchorColumnId: "C",
      anchorRowId: "5",
      focusColumnId: "C",
      focusRowId: "5",
    });
  });
});

describe("active cell helpers", () => {
  it("reads the anchor of the most recent range", () => {
    const sel = [
      collapsedRange(0, 1),
      { anchorColumnId: "B", anchorRowId: "3", focusColumnId: "D", focusRowId: "7" },
    ];
    expect(activeCellPos(sel)).toEqual({ colIndex: 1, rowNumber: 3 });
    expect(activeCellIdOf(sel)).toBe("B3");
    expect(focusCellIdOf(sel)).toBe("D7");
  });

  it("falls back to A1 for an empty or malformed selection", () => {
    expect(activeCellIdOf([])).toBe("A1");
    expect(focusCellIdOf([])).toBe("A1");
    const bad = [{ anchorColumnId: "?", anchorRowId: "0", focusColumnId: "?", focusRowId: "x" }];
    expect(activeCellIdOf(bad)).toBe("A1");
    expect(focusCellIdOf(bad)).toBe("A1");
  });
});

describe("setActiveCell", () => {
  it("collapses the selection to one cell", () => {
    setActiveCell(3, 4);
    expect(cellSelectionAtom.get()).toEqual([collapsedRange(3, 4)]);
  });

  it("clamps to the grid", () => {
    setActiveCell(-5, 0);
    expect(activeCellIdOf(cellSelectionAtom.get())).toBe("A1");
    setActiveCell(1000, 1000);
    expect(activeCellPos(cellSelectionAtom.get())).toEqual({
      colIndex: INITIAL_COLS - 1,
      rowNumber: INITIAL_ROWS,
    });
  });
});

describe("moveActive", () => {
  it("moves by row and column deltas", () => {
    moveActive(1, 1);
    expect(activeCellIdOf(cellSelectionAtom.get())).toBe("B2");
    moveActive(-1, 0);
    expect(activeCellIdOf(cellSelectionAtom.get())).toBe("A2");
  });

  it("routes vertical moves through the registered row navigator", () => {
    setRowNavigator((rowNumber, dRow) => rowNumber + 10 * dRow);
    moveActive(0, 1);
    expect(activeCellIdOf(cellSelectionAtom.get())).toBe("A11");
    // horizontal moves never consult the navigator
    moveActive(1, 0);
    expect(activeCellIdOf(cellSelectionAtom.get())).toBe("B11");
  });
});

describe("grid size", () => {
  it("grows one row / column at a time", () => {
    addRow();
    addColumn();
    expect(sheetStore.state).toMatchObject({ rows: INITIAL_ROWS + 1, cols: INITIAL_COLS + 1 });
  });

  it("ensureFits only ever grows", () => {
    ensureFits(30, 60);
    expect(sheetStore.state).toMatchObject({ cols: 31, rows: 60 });
    ensureFits(0, 1);
    expect(sheetStore.state).toMatchObject({ cols: 31, rows: 60 });
  });
});

describe("editing", () => {
  it("starts with an optional seed and stops", () => {
    startEditing("B2", "x");
    expect(sheetStore.state.editing).toEqual({ cellId: "B2", seed: "x" });
    startEditing("C3");
    expect(sheetStore.state.editing).toEqual({ cellId: "C3", seed: null });
    stopEditing();
    expect(sheetStore.state.editing).toBeNull();
  });
});

describe("switchSheet", () => {
  it("parks the grid size per sheet and restores it on return", () => {
    switchSheet("s1");
    addRow();
    addColumn();
    switchSheet("s2");
    expect(sheetStore.state).toMatchObject({ rows: INITIAL_ROWS, cols: INITIAL_COLS });
    switchSheet("s1");
    expect(sheetStore.state).toMatchObject({ rows: INITIAL_ROWS + 1, cols: INITIAL_COLS + 1 });
    expect(activeSheetIdAtom.get()).toBe("s1");
  });

  it("resets editing and selection", () => {
    switchSheet("s3");
    startEditing("B2");
    setActiveCell(3, 3);
    switchSheet("s4");
    expect(sheetStore.state.editing).toBeNull();
    expect(cellSelectionAtom.get()).toEqual([collapsedRange(0, 1)]);
  });

  it("is a no-op for the current sheet", () => {
    switchSheet("s5");
    startEditing("A1");
    switchSheet("s5");
    expect(sheetStore.state.editing).toEqual({ cellId: "A1", seed: null });
  });
});

describe("setActiveBook", () => {
  it("adopts the book and blanks the sheet list until the stream fills it", () => {
    switchSheet("s6");
    sheetsAtom.set([{ id: "s6", name: "シート1" }]);
    setActiveBook("book-a");
    expect(activeBookIdAtom.get()).toBe("book-a");
    expect(sheetsAtom.get()).toEqual([]);
    // nothing remembered for this book (no localStorage in node)
    expect(activeSheetIdAtom.get()).toBe("");
  });
});

describe("view state persistence without storage", () => {
  it("loads null and persists silently", () => {
    sortingAtom.set([{ id: "A", desc: true }]);
    columnFiltersAtom.set([{ id: "B", value: "x" }]);
    expect(() => persistViewState("s7")).not.toThrow();
    expect(loadPersistedViewState("s7")).toBeNull();
    clearViewState();
    expect(sortingAtom.get()).toEqual([]);
    expect(columnFiltersAtom.get()).toEqual([]);
  });
});
