// Runs in the "db" vitest project: LIBSQL_URL is ":memory:" there, and vitest
// isolates this file in its own module graph, so the client below opens a
// database nobody else touches. Tests keep out of each other's way by owning
// distinct users (every id below is a fresh UUID), which is also how the real
// app scopes data.

import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyCellMutations,
  applyHistory,
  bookOwner,
  createBook,
  createSheet,
  dbEvents,
  deleteBook,
  deleteSheet,
  getBooks,
  getCells,
  getSheets,
  getWidths,
  historyState,
  renameBook,
  renameSheet,
  setWidths,
  sheetAccess,
} from "./db";

import type { Book, ServerEvents, Sheet } from "./db";

// --- helpers -----------------------------------------------------------------

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** Record every emission of one server event until the test ends. */
function capture<K extends keyof ServerEvents>(event: K): Array<ServerEvents[K]> {
  const calls: Array<ServerEvents[K]> = [];
  // EventEmitter's listener type is conditional on the event key, which a
  // generic K cannot satisfy directly; the instantiation pins it down.
  const listener = ((...args: ServerEvents[K]) => {
    calls.push(args);
  }) as Parameters<typeof dbEvents.on<K>>[1];
  dbEvents.on(event, listener);
  stops.push(() => dbEvents.off(event, listener));
  return calls;
}

function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  return result as Extract<T, { ok: true }>;
}

/** A fresh owner with one book (and its first sheet). */
async function fixture(): Promise<{ owner: string; book: Book; sheet: Sheet }> {
  const owner = randomUUID();
  const { book } = expectOk(await createBook(owner));
  const [sheet] = await getSheets(book.id);
  if (!sheet) throw new Error("createBook did not create a first sheet");
  return { owner, book, sheet };
}

// --- books -------------------------------------------------------------------

describe("createBook", () => {
  it("auto-names books ブック{N} and gives each one a first sheet", async () => {
    const owner = randomUUID();
    const first = expectOk(await createBook(owner));
    const second = expectOk(await createBook(owner));
    expect(first.book.name).toBe("ブック1");
    expect(second.book.name).toBe("ブック2");
    expect(await getSheets(first.book.id)).toMatchObject([{ name: "シート1" }]);
  });

  it("skips auto-names that are already taken", async () => {
    const owner = randomUUID();
    expectOk(await createBook(owner, "ブック2"));
    // one book exists, so numbering starts at 2 — which is taken
    expect(expectOk(await createBook(owner)).book.name).toBe("ブック3");
  });

  it("trims an explicit name", async () => {
    const owner = randomUUID();
    expect(expectOk(await createBook(owner, "  家計簿  ")).book.name).toBe("家計簿");
  });

  it("rejects an empty name", async () => {
    expect(await createBook(randomUUID(), "   ")).toEqual({ ok: false, error: "invalid-name" });
  });

  it("rejects a duplicate name for the same owner only", async () => {
    const owner = randomUUID();
    expectOk(await createBook(owner, "同名"));
    expect(await createBook(owner, "同名")).toEqual({ ok: false, error: "duplicate-name" });
    expect((await createBook(randomUUID(), "同名")).ok).toBe(true);
  });

  it("lists books in creation order and emits the list", async () => {
    const owner = randomUUID();
    const books = capture("books");
    const a = expectOk(await createBook(owner, "a")).book;
    const b = expectOk(await createBook(owner, "b")).book;
    expect(await getBooks(owner)).toEqual([a, b]);
    expect(books).toEqual([
      [owner, [a]],
      [owner, [a, b]],
    ]);
  });
});

describe("bookOwner / sheetAccess", () => {
  it("resolves ownership, and null for unknown ids", async () => {
    const { owner, book, sheet } = await fixture();
    expect(await bookOwner(book.id)).toBe(owner);
    expect(await bookOwner(randomUUID())).toBeNull();
    expect(await sheetAccess(sheet.id)).toEqual({ book: book.id, owner });
    expect(await sheetAccess(randomUUID())).toBeNull();
  });
});

describe("renameBook", () => {
  it("renames with trimming and emits the list", async () => {
    const { owner, book } = await fixture();
    const books = capture("books");
    expect(await renameBook(owner, book.id, "  新名  ")).toEqual({
      ok: true,
      book: { id: book.id, name: "新名" },
    });
    expect(await getBooks(owner)).toEqual([{ id: book.id, name: "新名" }]);
    expect(books).toHaveLength(1);
  });

  it("allows renaming a book to its current name", async () => {
    const { owner, book } = await fixture();
    expect((await renameBook(owner, book.id, book.name)).ok).toBe(true);
  });

  it("rejects empty, unknown, foreign and duplicate targets", async () => {
    const { owner, book } = await fixture();
    expectOk(await createBook(owner, "other"));
    expect(await renameBook(owner, book.id, " ")).toEqual({ ok: false, error: "invalid-name" });
    expect(await renameBook(owner, randomUUID(), "x")).toEqual({
      ok: false,
      error: "unknown-book",
    });
    expect(await renameBook(randomUUID(), book.id, "x")).toEqual({
      ok: false,
      error: "unknown-book",
    });
    expect(await renameBook(owner, book.id, "other")).toEqual({
      ok: false,
      error: "duplicate-name",
    });
  });
});

describe("deleteBook", () => {
  it("refuses to delete the last book", async () => {
    const { owner, book } = await fixture();
    expect(await deleteBook(owner, book.id)).toEqual({ ok: false, error: "last-book" });
    expect(await getBooks(owner)).toHaveLength(1);
  });

  it("deletes a book with its sheets, cells, widths and history", async () => {
    const { owner, book, sheet } = await fixture();
    const keep = expectOk(await createBook(owner, "keep")).book;
    await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id, "client");
    await setWidths({ A: 120 }, sheet.id);
    const books = capture("books");

    expect(await deleteBook(owner, book.id)).toEqual({ ok: true, book });
    expect(await getBooks(owner)).toEqual([keep]);
    expect(await getSheets(book.id)).toEqual([]);
    expect(await getCells(sheet.id)).toEqual([]);
    expect(await getWidths(sheet.id)).toEqual({});
    expect(await historyState(sheet.id, "client")).toEqual({ canUndo: false, canRedo: false });
    expect(await sheetAccess(sheet.id)).toBeNull();
    expect(books).toEqual([[owner, [keep]]]);
  });

  it("treats unknown and foreign books alike", async () => {
    const { owner, book } = await fixture();
    expect(await deleteBook(owner, randomUUID())).toEqual({ ok: false, error: "unknown-book" });
    expect(await deleteBook(randomUUID(), book.id)).toEqual({ ok: false, error: "unknown-book" });
  });
});

// --- sheets ------------------------------------------------------------------

describe("createSheet", () => {
  it("auto-names sheets シート{N} within the book", async () => {
    const { book } = await fixture();
    expect(expectOk(await createSheet(book.id)).sheet.name).toBe("シート2");
    expect(expectOk(await createSheet(book.id)).sheet.name).toBe("シート3");
  });

  it("scopes name uniqueness to the book", async () => {
    const { owner, book } = await fixture();
    const other = expectOk(await createBook(owner, "other")).book;
    expectOk(await createSheet(book.id, "売上"));
    expect(await createSheet(book.id, "売上")).toEqual({ ok: false, error: "duplicate-name" });
    expect((await createSheet(other.id, "売上")).ok).toBe(true);
    expect(await createSheet(book.id, "  ")).toEqual({ ok: false, error: "invalid-name" });
  });

  it("emits the book's sheet list", async () => {
    const { book, sheet } = await fixture();
    const sheets = capture("sheets");
    const added = expectOk(await createSheet(book.id, "x")).sheet;
    expect(sheets).toEqual([[book.id, [sheet, added]]]);
  });
});

describe("renameSheet", () => {
  it("renames, and rejects empty / unknown / duplicate", async () => {
    const { book, sheet } = await fixture();
    expectOk(await createSheet(book.id, "taken"));
    expect(await renameSheet(book.id, sheet.id, " 新 ")).toEqual({
      ok: true,
      sheet: { id: sheet.id, name: "新" },
    });
    expect(await renameSheet(book.id, sheet.id, "")).toEqual({ ok: false, error: "invalid-name" });
    expect(await renameSheet(book.id, randomUUID(), "x")).toEqual({
      ok: false,
      error: "unknown-sheet",
    });
    expect(await renameSheet(book.id, sheet.id, "taken")).toEqual({
      ok: false,
      error: "duplicate-name",
    });
  });
});

describe("deleteSheet", () => {
  it("refuses to delete the last sheet", async () => {
    const { book, sheet } = await fixture();
    expect(await deleteSheet(book.id, sheet.id)).toEqual({ ok: false, error: "last-sheet" });
  });

  it("deletes the sheet with its cells, widths and history", async () => {
    const { book, sheet } = await fixture();
    const second = expectOk(await createSheet(book.id)).sheet;
    await applyCellMutations([{ id: "A1", raw: "1" }], second.id, "client");
    await setWidths({ A: 99 }, second.id);
    const sheets = capture("sheets");

    expect(await deleteSheet(book.id, second.id)).toEqual({ ok: true, sheet: second });
    expect(await getSheets(book.id)).toEqual([sheet]);
    expect(await getCells(second.id)).toEqual([]);
    expect(await getWidths(second.id)).toEqual({});
    expect(await historyState(second.id, "client")).toEqual({ canUndo: false, canRedo: false });
    expect(sheets).toEqual([[book.id, [sheet]]]);
  });
});

// --- cells -------------------------------------------------------------------

describe("applyCellMutations", () => {
  it("derives insert / update / delete from the current state", async () => {
    const { sheet } = await fixture();
    expect(await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id)).toEqual([
      { type: "insert", id: "A1", raw: "1" },
    ]);
    expect(await applyCellMutations([{ id: "A1", raw: "2" }], sheet.id)).toEqual([
      { type: "update", id: "A1", raw: "2" },
    ]);
    expect(await applyCellMutations([{ id: "A1", raw: "  " }], sheet.id)).toEqual([
      { type: "delete", id: "A1" },
    ]);
    expect(await getCells(sheet.id)).toEqual([]);
  });

  it("drops no-op writes", async () => {
    const { sheet } = await fixture();
    await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id);
    const cells = capture("cells");
    expect(await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id)).toEqual([]);
    expect(await applyCellMutations([{ id: "B1", raw: "" }], sheet.id)).toEqual([]);
    expect(cells).toEqual([]);
  });

  it("lets the last write win within one batch", async () => {
    const { sheet } = await fixture();
    const changes = await applyCellMutations(
      [
        { id: "A1", raw: "1" },
        { id: "A1", raw: "2" },
      ],
      sheet.id,
    );
    expect(changes).toEqual([{ type: "insert", id: "A1", raw: "2" }]);
    expect(await getCells(sheet.id)).toEqual([{ id: "A1", raw: "2" }]);
  });

  it("emits the committed changes tagged with the book", async () => {
    const { book, sheet } = await fixture();
    const cells = capture("cells");
    await applyCellMutations(
      [
        { id: "A1", raw: "1" },
        { id: "B2", raw: "=A1*2" },
      ],
      sheet.id,
    );
    expect(cells).toEqual([
      [
        book.id,
        sheet.id,
        [
          { type: "insert", id: "A1", raw: "1" },
          { type: "insert", id: "B2", raw: "=A1*2" },
        ],
      ],
    ]);
  });

  it("throws for an unknown sheet", async () => {
    await expect(applyCellMutations([{ id: "A1", raw: "1" }], randomUUID())).rejects.toThrow(
      /unknown sheet/,
    );
  });
});

// --- history -----------------------------------------------------------------

describe("history", () => {
  it("records nothing without a client", async () => {
    const { sheet } = await fixture();
    await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id);
    expect(await historyState(sheet.id, "anyone")).toEqual({ canUndo: false, canRedo: false });
    expect(await applyHistory(sheet.id, "anyone", "undo")).toEqual({
      applied: 0,
      canUndo: false,
      canRedo: false,
    });
  });

  it("undoes and redoes one entry per operation", async () => {
    const { sheet } = await fixture();
    await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id, "c");
    await applyCellMutations(
      [
        { id: "A1", raw: "2" },
        { id: "B1", raw: "x" },
      ],
      sheet.id,
      "c",
    );
    expect(await historyState(sheet.id, "c")).toEqual({ canUndo: true, canRedo: false });

    expect(await applyHistory(sheet.id, "c", "undo")).toEqual({
      applied: 2,
      canUndo: true,
      canRedo: true,
    });
    expect(await getCells(sheet.id)).toEqual([{ id: "A1", raw: "1" }]);

    expect(await applyHistory(sheet.id, "c", "undo")).toEqual({
      applied: 1,
      canUndo: false,
      canRedo: true,
    });
    expect(await getCells(sheet.id)).toEqual([]);

    expect(await applyHistory(sheet.id, "c", "redo")).toEqual({
      applied: 1,
      canUndo: true,
      canRedo: true,
    });
    expect(await getCells(sheet.id)).toEqual([{ id: "A1", raw: "1" }]);
  });

  it("discards the redo stack on a new edit", async () => {
    const { sheet } = await fixture();
    await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id, "c");
    await applyHistory(sheet.id, "c", "undo");
    expect(await historyState(sheet.id, "c")).toEqual({ canUndo: false, canRedo: true });
    await applyCellMutations([{ id: "A1", raw: "9" }], sheet.id, "c");
    expect(await historyState(sheet.id, "c")).toEqual({ canUndo: true, canRedo: false });
  });

  it("skips cells somebody else changed since, but still flips the entry", async () => {
    const { sheet } = await fixture();
    await applyCellMutations(
      [
        { id: "A1", raw: "1" },
        { id: "B1", raw: "1" },
      ],
      sheet.id,
      "c",
    );
    // another client overwrites A1
    await applyCellMutations([{ id: "A1", raw: "other" }], sheet.id, "someone-else");

    expect(await applyHistory(sheet.id, "c", "undo")).toEqual({
      applied: 1,
      canUndo: false,
      canRedo: true,
    });
    expect(await getCells(sheet.id)).toEqual([{ id: "A1", raw: "other" }]);
  });

  it("keeps histories per client", async () => {
    const { sheet } = await fixture();
    await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id, "a");
    expect(await historyState(sheet.id, "b")).toEqual({ canUndo: false, canRedo: false });
    expect((await applyHistory(sheet.id, "b", "undo")).applied).toBe(0);
    expect(await getCells(sheet.id)).toEqual([{ id: "A1", raw: "1" }]);
  });

  it("does not record undo applications as new entries", async () => {
    const { sheet } = await fixture();
    const cells = capture("cells");
    await applyCellMutations([{ id: "A1", raw: "1" }], sheet.id, "c");
    await applyHistory(sheet.id, "c", "undo");
    // the undo itself still broadcasts its cell change...
    expect(cells).toHaveLength(2);
    // ...but the only entry is the original one, now sitting in the redo stack
    expect(await historyState(sheet.id, "c")).toEqual({ canUndo: false, canRedo: true });
  });
});

// --- column widths -----------------------------------------------------------

describe("widths", () => {
  it("defaults to an empty object", async () => {
    const { sheet } = await fixture();
    expect(await getWidths(sheet.id)).toEqual({});
  });

  it("persists, emits, and drops identical writes", async () => {
    const { book, sheet } = await fixture();
    const meta = capture("meta");
    await setWidths({ A: 120, C: 64 }, sheet.id);
    await setWidths({ A: 120, C: 64 }, sheet.id);
    expect(await getWidths(sheet.id)).toEqual({ A: 120, C: 64 });
    expect(meta).toEqual([[book.id, sheet.id, { A: 120, C: 64 }]]);
    await setWidths({ A: 121, C: 64 }, sheet.id);
    expect(meta).toHaveLength(2);
  });

  it("throws for an unknown sheet", async () => {
    await expect(setWidths({ A: 1 }, randomUUID())).rejects.toThrow(/unknown sheet/);
  });
});
