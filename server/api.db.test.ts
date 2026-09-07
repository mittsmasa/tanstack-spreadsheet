// Runs in the "db" vitest project (see db.db.test.ts for the setup). The MCP
// tools are exercised through callTool against a local D1 — the same code
// path /mcp reaches once the OAuth gate has resolved the owner. The gate
// itself is not covered here.

import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TOOLS, callTool } from "./api";
import { createBook, getSheets, sync } from "./db";

import type { Book, Sheet } from "./db";

// --- helpers -----------------------------------------------------------------

const realPublish = sync.publish;

beforeEach(() => {
  sync.publish = async () => {};
});

afterEach(() => {
  sync.publish = realPublish;
});

/** A fresh owner with one book (and its first sheet). */
async function fixture(): Promise<{ owner: string; book: Book; sheet: Sheet }> {
  const owner = randomUUID();
  const result = await createBook(owner);
  if (!result.ok) throw new Error(`createBook failed: ${result.error}`);
  const [sheet] = await getSheets(result.book.id);
  if (!sheet) throw new Error("createBook did not create a first sheet");
  return { owner, book: result.book, sheet };
}

/** Call a tool expecting success; returns its parsed JSON payload. */
async function ok(owner: string, name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(owner, name, args);
  const text = result.content[0]?.text ?? "";
  expect(result.isError, text).toBeUndefined();
  return JSON.parse(text) as Record<string, unknown>;
}

/** Call a tool expecting an error; returns its message. */
async function fail(owner: string, name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(owner, name, args);
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

function cells(entries: Record<string, string>) {
  return Object.entries(entries).map(([id, raw]) => ({ id, raw }));
}

// --- tool list ---------------------------------------------------------------

it("lists every tool", () => {
  expect(TOOLS.map((tool) => tool.name)).toEqual([
    "list_books",
    "add_book",
    "list_sheets",
    "add_sheet",
    "get_cell",
    "get_range",
    "set_cells",
    "get_snapshot",
    "set_range",
    "clear_range",
    "find_cells",
    "get_dimensions",
    "rename_book",
    "delete_book",
    "rename_sheet",
    "delete_sheet",
  ]);
});

// --- get_range (regression for the parseRange extraction) --------------------

describe("get_range", () => {
  it("accepts corners in any order and echoes the input range", async () => {
    const { owner } = await fixture();
    await ok(owner, "set_cells", { cells: cells({ A1: "1", B2: "=A1+1" }) });
    expect(await ok(owner, "get_range", { range: "b2:a1" })).toEqual({
      range: "B2:A1",
      rows: [
        [
          { id: "A1", raw: "1", value: "1" },
          { id: "B1", raw: null, value: "" },
        ],
        [
          { id: "A2", raw: null, value: "" },
          { id: "B2", raw: "=A1+1", value: "2" },
        ],
      ],
    });
  });

  it("rejects malformed and oversized ranges", async () => {
    const { owner } = await fixture();
    expect(await fail(owner, "get_range", { range: "A0:B2" })).toContain("invalid range");
    expect(await fail(owner, "get_range", { range: "A1:ZZ10000" })).toContain("range too large");
  });
});

// --- set_range ---------------------------------------------------------------

describe("set_range", () => {
  it("writes a row-major block from the start cell", async () => {
    const { owner } = await fixture();
    expect(
      await ok(owner, "set_range", {
        start: "b2",
        rows: [
          ["name", "qty"],
          ["apple", 3],
          ["pear", null],
        ],
      }),
    ).toEqual({ range: "B2:C4", applied: 5 });
    const { rows } = await ok(owner, "get_range", { range: "B2:C4" });
    expect(rows).toEqual([
      [
        { id: "B2", raw: "name", value: "name" },
        { id: "C2", raw: "qty", value: "qty" },
      ],
      [
        { id: "B3", raw: "apple", value: "apple" },
        { id: "C3", raw: "3", value: "3" },
      ],
      [
        { id: "B4", raw: "pear", value: "pear" },
        { id: "C4", raw: null, value: "" },
      ],
    ]);
  });

  it("deletes with empty strings and tolerates ragged rows", async () => {
    const { owner } = await fixture();
    await ok(owner, "set_range", { start: "A1", rows: [["a", "b", "c"], ["d"]] });
    expect(await ok(owner, "set_range", { start: "A1", rows: [["", "B"], [""]] })).toEqual({
      range: "A1:B2",
      applied: 3,
    });
    expect(await ok(owner, "get_snapshot")).toEqual({
      cells: [
        { id: "B1", raw: "B", value: "B" },
        { id: "C1", raw: "c", value: "c" },
      ],
    });
  });

  it("rejects a bad start cell, a malformed grid, and too many cells", async () => {
    const { owner } = await fixture();
    expect(await fail(owner, "set_range", { start: "1A", rows: [["x"]] })).toContain(
      "invalid start cell",
    );
    expect(await fail(owner, "set_range", { start: "A1", rows: [{ A1: "x" }] })).toContain(
      "invalid rows payload",
    );
    expect(await fail(owner, "set_range", { start: "A1", rows: [["x", true]] })).toContain(
      "invalid rows payload",
    );
    const rows = Array.from({ length: 101 }, () => Array.from({ length: 100 }, () => "x"));
    expect(await fail(owner, "set_range", { start: "A1", rows })).toContain("too many cells");
    expect(await ok(owner, "get_dimensions")).toMatchObject({ cellCount: 0 });
  });
});

// --- clear_range -------------------------------------------------------------

describe("clear_range", () => {
  it("deletes only the cells inside the range", async () => {
    const { owner } = await fixture();
    await ok(owner, "set_range", {
      start: "A1",
      rows: [
        ["1", "2", "3"],
        ["4", "5", "6"],
        ["7", "8", "9"],
      ],
    });
    await ok(owner, "set_cells", { cells: cells({ D5: "x" }) });
    expect(await ok(owner, "clear_range", { range: "a1:b2" })).toEqual({
      range: "A1:B2",
      cleared: 4,
    });
    const { cells: remaining } = await ok(owner, "get_snapshot");
    expect((remaining as Array<{ id: string }>).map((c) => c.id)).toEqual([
      "A3",
      "B3",
      "C1",
      "C2",
      "C3",
      "D5",
    ]);
  });

  it("is a no-op on an empty range and guards the size", async () => {
    const { owner } = await fixture();
    expect(await ok(owner, "clear_range", { range: "A1:C3" })).toEqual({
      range: "A1:C3",
      cleared: 0,
    });
    expect(await fail(owner, "clear_range", { range: "A1:ZZ10000" })).toContain("range too large");
  });
});

// --- find_cells --------------------------------------------------------------

describe("find_cells", () => {
  async function seeded() {
    const { owner } = await fixture();
    await ok(owner, "set_cells", {
      cells: cells({
        A1: "Apple",
        B1: "banana",
        C1: "10",
        D1: "=C1*2",
        B2: "APPLE",
        E1: "=1/0",
        A10: "apple pie",
      }),
    });
    return owner;
  }

  it("matches raw and evaluated values, case-insensitively, in row-major order", async () => {
    const owner = await seeded();
    expect(await ok(owner, "find_cells", { query: "apple" })).toEqual({
      total: 3,
      truncated: false,
      matches: [
        { id: "A1", raw: "Apple", value: "Apple" },
        { id: "B2", raw: "APPLE", value: "APPLE" },
        { id: "A10", raw: "apple pie", value: "apple pie" },
      ],
    });
    // "20" only exists as D1's evaluated value
    expect(await ok(owner, "find_cells", { query: "20" })).toMatchObject({
      matches: [{ id: "D1", raw: "=C1*2", value: "20" }],
    });
  });

  it("honours caseSensitive, regex and limit", async () => {
    const owner = await seeded();
    expect(await ok(owner, "find_cells", { query: "apple", caseSensitive: true })).toMatchObject({
      matches: [{ id: "A10" }],
    });
    expect(await ok(owner, "find_cells", { query: "^ban", regex: true })).toMatchObject({
      matches: [{ id: "B1" }],
    });
    expect(await ok(owner, "find_cells", { query: "apple", limit: 1 })).toEqual({
      total: 3,
      truncated: true,
      matches: [{ id: "A1", raw: "Apple", value: "Apple" }],
    });
  });

  it("finds broken formulas by their error value instead of failing", async () => {
    const owner = await seeded();
    expect(await ok(owner, "find_cells", { query: "#ERROR" })).toMatchObject({
      total: 1,
      matches: [{ id: "E1", raw: "=1/0", value: "#ERROR" }],
    });
  });

  it("rejects an empty query, a broken regex and a bad limit", async () => {
    const owner = await seeded();
    expect(await fail(owner, "find_cells", { query: "" })).toContain("query must be");
    expect(await fail(owner, "find_cells", { query: "(", regex: true })).toContain("invalid regex");
    expect(await fail(owner, "find_cells", { query: "a", limit: 0 })).toContain("invalid limit");
  });
});

// --- get_dimensions ----------------------------------------------------------

describe("get_dimensions", () => {
  it("reports an empty sheet as having no range", async () => {
    const { owner } = await fixture();
    expect(await ok(owner, "get_dimensions")).toEqual({
      cellCount: 0,
      rows: 0,
      columns: 0,
      range: null,
    });
  });

  it("bounds the used extent from A1", async () => {
    const { owner } = await fixture();
    await ok(owner, "set_cells", { cells: cells({ B3: "x", D2: "y" }) });
    expect(await ok(owner, "get_dimensions")).toEqual({
      cellCount: 2,
      rows: 3,
      columns: 4,
      range: "A1:D3",
    });
  });
});

// --- books -------------------------------------------------------------------

describe("rename_book / delete_book", () => {
  it("renames by id or name and refuses duplicates", async () => {
    const { owner, book } = await fixture();
    expect(await ok(owner, "rename_book", { book: book.id, name: "家計簿" })).toEqual({
      book: { id: book.id, name: "家計簿" },
    });
    await ok(owner, "add_book", { name: "予算" });
    expect(await fail(owner, "rename_book", { book: "家計簿", name: "予算" })).toContain(
      "duplicate-name",
    );
    expect(await ok(owner, "list_books")).toMatchObject({
      books: [{ name: "家計簿" }, { name: "予算" }],
    });
  });

  it("requires an explicit book and rejects unknown ones", async () => {
    const { owner } = await fixture();
    expect(await fail(owner, "rename_book", { name: "x" })).toContain("book is required");
    expect(await fail(owner, "delete_book", {})).toContain("book is required");
    expect(await fail(owner, "delete_book", { book: "nope" })).toContain("unknown book");
  });

  it("deletes a book but never the last one", async () => {
    const { owner, book } = await fixture();
    const { book: second } = (await ok(owner, "add_book", { name: "予算" })) as { book: Book };
    expect(await ok(owner, "delete_book", { book: "予算" })).toEqual({ deleted: second });
    expect(await ok(owner, "list_books")).toEqual({ books: [book] });
    expect(await fail(owner, "delete_book", { book: book.id })).toContain("last-book");
  });

  it("cannot reach another user's book", async () => {
    const { owner } = await fixture();
    const other = await fixture();
    expect(await fail(owner, "delete_book", { book: other.book.id })).toContain("unknown book");
    expect(await ok(other.owner, "list_books")).toEqual({ books: [other.book] });
  });
});

// --- sheets ------------------------------------------------------------------

describe("rename_sheet / delete_sheet", () => {
  it("renames within the book and refuses duplicates", async () => {
    const { owner, book, sheet } = await fixture();
    expect(await ok(owner, "rename_sheet", { sheet: sheet.id, name: "集計" })).toEqual({
      book: book.id,
      sheet: { id: sheet.id, name: "集計" },
    });
    await ok(owner, "add_sheet", { name: "元データ" });
    expect(await fail(owner, "rename_sheet", { sheet: "集計", name: "元データ" })).toContain(
      "duplicate-name",
    );
  });

  it("requires an explicit sheet", async () => {
    const { owner } = await fixture();
    expect(await fail(owner, "rename_sheet", { name: "x" })).toContain("sheet is required");
    expect(await fail(owner, "delete_sheet", {})).toContain("sheet is required");
    expect(await fail(owner, "delete_sheet", { sheet: "nope" })).toContain("unknown sheet");
  });

  it("deletes a sheet and its cells, but never the last one", async () => {
    const { owner, book, sheet } = await fixture();
    const { sheet: second } = (await ok(owner, "add_sheet", { name: "一時" })) as { sheet: Sheet };
    await ok(owner, "set_cells", { sheet: "一時", cells: cells({ A1: "gone" }) });
    expect(await ok(owner, "delete_sheet", { sheet: "一時" })).toEqual({
      book: book.id,
      deleted: second,
    });
    expect(await ok(owner, "list_sheets")).toEqual({ book: book.id, sheets: [sheet] });
    expect(await fail(owner, "delete_sheet", { sheet: sheet.id })).toContain("last-sheet");
  });
});
