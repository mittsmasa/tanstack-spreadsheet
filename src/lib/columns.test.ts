import { describe, expect, it } from "vitest";

import { cellId, columnLabel, labelToColumnIndex, parseCellId } from "#/lib/columns";

describe("columnLabel", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [27, "AB"],
    [51, "AZ"],
    [52, "BA"],
    [701, "ZZ"],
    [702, "AAA"],
  ])("maps index %i to %s", (index, label) => {
    expect(columnLabel(index)).toBe(label);
  });
});

describe("labelToColumnIndex", () => {
  it.each([
    ["A", 0],
    ["Z", 25],
    ["AA", 26],
    ["AZ", 51],
    ["BA", 52],
    ["AAA", 702],
  ])("maps %s to %i", (label, index) => {
    expect(labelToColumnIndex(label)).toBe(index);
  });

  it("rejects anything that is not an uppercase letter run", () => {
    expect(labelToColumnIndex("")).toBe(-1);
    expect(labelToColumnIndex("a")).toBe(-1);
    expect(labelToColumnIndex("A1")).toBe(-1);
    expect(labelToColumnIndex("1")).toBe(-1);
  });

  it("is the inverse of columnLabel", () => {
    for (let i = 0; i < 2000; i++) {
      expect(labelToColumnIndex(columnLabel(i))).toBe(i);
    }
  });
});

describe("cellId", () => {
  it("joins a column label and a 1-based row number", () => {
    expect(cellId(0, 1)).toBe("A1");
    expect(cellId(26, 12)).toBe("AA12");
  });
});

describe("parseCellId", () => {
  it("splits a cell id into column index and row number", () => {
    expect(parseCellId("A1")).toEqual({ colIndex: 0, rowNumber: 1 });
    expect(parseCellId("AA12")).toEqual({ colIndex: 26, rowNumber: 12 });
  });

  it.each(["", "A", "1", "1A", "a1", "A0", "A01", "A1B", " A1"])("returns null for %j", (id) => {
    expect(parseCellId(id)).toBeNull();
  });
});
