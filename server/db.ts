// Server-side source of truth for spreadsheet data, backed by Cloudflare D1.
//
// The data is three levels deep: a book owns sheets, a sheet owns cells. Only
// `sheets` records which book it belongs to — sheet ids are UUIDs and globally
// unique, so `cells`, `sheet_meta` and `history` stay keyed by sheet id alone.
// Access control walks sheet -> book -> owner (see sheetAccess).
//
// `owner` is a Better Auth user id. Browser requests read it from the session;
// MCP requests read it from the access token's `sub` claim, which is the same
// user id as long as no `pairwiseSecret` is configured on the OAuth provider
// (see server/auth-options.ts — adding one would break this equivalence).
//
// Every committed write is published to the owner's SyncHub Durable Object,
// which fans it out to that owner's open WebSocket subscribers. The publish is
// awaited so a client that sees the HTTP response has already been notified.
//
// The schema lives in migrations/*.sql (applied with `pnpm db:migrate`).

import { env } from "cloudflare:workers";

export type CellRow = { id: string; raw: string };

export type Book = { id: string; name: string };

export type Sheet = { id: string; name: string };

export type CellChange =
  | { type: "insert" | "update"; id: string; raw: string }
  | { type: "delete"; id: string };

export type BookOpError = "invalid-name" | "duplicate-name" | "unknown-book" | "last-book";

export type BookOpResult = { ok: true; book: Book } | { ok: false; error: BookOpError };

export type SheetOpError = "invalid-name" | "duplicate-name" | "unknown-sheet" | "last-sheet";

export type SheetOpResult = { ok: true; sheet: Sheet } | { ok: false; error: SheetOpError };

/**
 * A change notification, exactly as the browser receives it over the
 * WebSocket. Book-scoped events carry the book so SyncHub can deliver them
 * only to subscribers of that book; the book list is per owner and goes to
 * every subscriber of that owner.
 */
export type ServerEvent =
  | { event: "cells"; book: string; data: { sheet: string; changes: Array<CellChange> } }
  | { event: "meta"; book: string; data: { sheet: string; widths: Record<string, number> } }
  | { event: "sheets"; book: string; data: { sheets: Array<Sheet> } }
  | { event: "books"; data: { books: Array<Book> } };

async function publish(owner: string, event: ServerEvent): Promise<void> {
  await env.SYNC_HUB.getByName(owner).publish(event);
}

// --- D1 helpers --------------------------------------------------------------

type Arg = string | number;

function stmt(sql: string, args: ReadonlyArray<Arg> = []): D1PreparedStatement {
  return env.DB.prepare(sql).bind(...args);
}

async function rows<T = Record<string, unknown>>(sql: string, args: ReadonlyArray<Arg> = []) {
  return (await stmt(sql, args).all<T>()).results;
}

/** Run one write and return the number of affected rows. */
async function run(sql: string, args: ReadonlyArray<Arg> = []): Promise<number> {
  return (await stmt(sql, args).run()).meta.changes;
}

/** D1 runs a batch as a single transaction: all statements or none. */
async function batch(statements: ReadonlyArray<{ sql: string; args: ReadonlyArray<Arg> }>) {
  await env.DB.batch(statements.map(({ sql, args }) => stmt(sql, args)));
}

// --- books -------------------------------------------------------------------

export async function getBooks(owner: string): Promise<Array<Book>> {
  const result = await rows("SELECT id, name FROM books WHERE owner = ? ORDER BY rowid", [owner]);
  return result.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

/** The book's owner, or null when no such book exists. Callers compare this
 * against the requesting user and answer 404 on a mismatch. */
export async function bookOwner(id: string): Promise<string | null> {
  const row = (await rows("SELECT owner FROM books WHERE id = ?", [id]))[0];
  return row === undefined ? null : String(row.owner);
}

/** The book and owner a sheet belongs to, or null when no such sheet exists. */
export async function sheetAccess(sheet: string): Promise<{ book: string; owner: string } | null> {
  const row = (
    await rows(
      `SELECT sheets.book AS book, books.owner AS owner
       FROM sheets JOIN books ON books.id = sheets.book
       WHERE sheets.id = ?`,
      [sheet],
    )
  )[0];
  return row === undefined ? null : { book: String(row.book), owner: String(row.owner) };
}

async function publishBooks(owner: string) {
  await publish(owner, { event: "books", data: { books: await getBooks(owner) } });
}

/** Pick the first free "{prefix}{N}" among names already taken. */
function autoName(prefix: string, taken: ReadonlySet<string>, start: number): string {
  let n = start;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Create a book for an owner, along with the one sheet it starts with (a book
 * with no sheets has no valid UI state). Without a name, picks the first free
 * "ブック{N}" for that owner. Names are unique per owner, checked up front so
 * callers get a proper error instead of a raw constraint failure.
 */
export async function createBook(owner: string, name?: string): Promise<BookOpResult> {
  const books = await getBooks(owner);
  const names = new Set(books.map((b) => b.name));
  let resolved: string;
  if (name === undefined) {
    resolved = autoName("ブック", names, books.length + 1);
  } else {
    resolved = name.trim();
    if (resolved === "") return { ok: false, error: "invalid-name" };
    if (names.has(resolved)) return { ok: false, error: "duplicate-name" };
  }
  const book: Book = { id: crypto.randomUUID(), name: resolved };
  await batch([
    {
      sql: "INSERT INTO books (id, owner, name) VALUES (?, ?, ?)",
      args: [book.id, owner, book.name],
    },
    {
      sql: "INSERT INTO sheets (id, book, name) VALUES (?, ?, ?)",
      args: [crypto.randomUUID(), book.id, "シート1"],
    },
  ]);
  await publishBooks(owner);
  return { ok: true, book };
}

export async function renameBook(owner: string, id: string, name: string): Promise<BookOpResult> {
  const resolved = name.trim();
  if (resolved === "") return { ok: false, error: "invalid-name" };
  const books = await getBooks(owner);
  const target = books.find((b) => b.id === id);
  if (!target) return { ok: false, error: "unknown-book" };
  if (books.some((b) => b.id !== id && b.name === resolved)) {
    return { ok: false, error: "duplicate-name" };
  }
  await run("UPDATE books SET name = ? WHERE id = ?", [resolved, id]);
  await publishBooks(owner);
  return { ok: true, book: { id, name: resolved } };
}

/**
 * Delete a book and everything under it. The "keep at least one book" guard
 * runs inside a single conditional DELETE so concurrent deletes (two tabs at
 * once) cannot race the count check and leave the owner with none. The child
 * rows are removed before the sheets they are selected through.
 */
export async function deleteBook(owner: string, id: string): Promise<BookOpResult> {
  const books = await getBooks(owner);
  const target = books.find((b) => b.id === id);
  if (!target) return { ok: false, error: "unknown-book" };
  const changes = await run(
    "DELETE FROM books WHERE id = ? AND (SELECT COUNT(*) FROM books WHERE owner = ?) > 1",
    [id, owner],
  );
  if (changes === 0) return { ok: false, error: "last-book" };
  const ofBook = "SELECT id FROM sheets WHERE book = ?";
  await batch([
    { sql: `DELETE FROM cells WHERE sheet IN (${ofBook})`, args: [id] },
    { sql: `DELETE FROM sheet_meta WHERE sheet IN (${ofBook})`, args: [id] },
    { sql: `DELETE FROM history WHERE sheet IN (${ofBook})`, args: [id] },
    { sql: "DELETE FROM sheets WHERE book = ?", args: [id] },
  ]);
  await publishBooks(owner);
  return { ok: true, book: target };
}

// --- sheets ------------------------------------------------------------------

export async function getSheets(book: string): Promise<Array<Sheet>> {
  const result = await rows("SELECT id, name FROM sheets WHERE book = ? ORDER BY rowid", [book]);
  return result.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

/** The sheet list is book-scoped, but SyncHub instances are per owner, so the
 * owner is looked up here. A book that vanished meanwhile has nobody to tell. */
async function publishSheets(book: string) {
  const owner = await bookOwner(book);
  if (owner === null) return;
  await publish(owner, { event: "sheets", book, data: { sheets: await getSheets(book) } });
}

/**
 * Create a sheet in a book. Without a name, picks the first free "シート{N}"
 * within that book. Names are unique per book.
 */
export async function createSheet(book: string, name?: string): Promise<SheetOpResult> {
  const sheets = await getSheets(book);
  const names = new Set(sheets.map((s) => s.name));
  let resolved: string;
  if (name === undefined) {
    resolved = autoName("シート", names, sheets.length + 1);
  } else {
    resolved = name.trim();
    if (resolved === "") return { ok: false, error: "invalid-name" };
    if (names.has(resolved)) return { ok: false, error: "duplicate-name" };
  }
  const sheet: Sheet = { id: crypto.randomUUID(), name: resolved };
  await run("INSERT INTO sheets (id, book, name) VALUES (?, ?, ?)", [sheet.id, book, sheet.name]);
  await publishSheets(book);
  return { ok: true, sheet };
}

export async function renameSheet(book: string, id: string, name: string): Promise<SheetOpResult> {
  const resolved = name.trim();
  if (resolved === "") return { ok: false, error: "invalid-name" };
  const sheets = await getSheets(book);
  const target = sheets.find((s) => s.id === id);
  if (!target) return { ok: false, error: "unknown-sheet" };
  if (sheets.some((s) => s.id !== id && s.name === resolved)) {
    return { ok: false, error: "duplicate-name" };
  }
  await run("UPDATE sheets SET name = ? WHERE id = ?", [resolved, id]);
  await publishSheets(book);
  return { ok: true, sheet: { id, name: resolved } };
}

/**
 * Delete a sheet and its data. The "keep at least one sheet" guard runs inside
 * a single conditional DELETE so concurrent deletes (two tabs at once) cannot
 * race the count check and empty the book.
 */
export async function deleteSheet(book: string, id: string): Promise<SheetOpResult> {
  const sheets = await getSheets(book);
  const target = sheets.find((s) => s.id === id);
  if (!target) return { ok: false, error: "unknown-sheet" };
  const changes = await run(
    "DELETE FROM sheets WHERE id = ? AND (SELECT COUNT(*) FROM sheets WHERE book = ?) > 1",
    [id, book],
  );
  if (changes === 0) return { ok: false, error: "last-sheet" };
  await batch([
    { sql: "DELETE FROM cells WHERE sheet = ?", args: [id] },
    { sql: "DELETE FROM sheet_meta WHERE sheet = ?", args: [id] },
    { sql: "DELETE FROM history WHERE sheet = ?", args: [id] },
  ]);
  await publishSheets(book);
  return { ok: true, sheet: target };
}

// --- cells -------------------------------------------------------------------

export async function getCells(sheet: string): Promise<Array<CellRow>> {
  const result = await rows("SELECT id, raw FROM cells WHERE sheet = ?", [sheet]);
  return result.map((row) => ({ id: String(row.id), raw: String(row.raw) }));
}

/**
 * Apply a batch of cell writes. An empty (or whitespace-only) raw deletes the
 * cell — the same semantics as setCell in the UI. The change type is derived
 * from the current DB state so subscribers never see a delete+insert of the
 * same key (the react-db live-query congruence pitfall). No-op writes are
 * dropped from the published batch.
 *
 * With `recordFor`, the applied batch is also written to the history table as
 * one undoable entry owned by that client (undo/redo application itself passes
 * no recordFor, which is what keeps undos out of the history).
 */
export async function applyCellMutations(
  cells: ReadonlyArray<CellRow>,
  sheet: string,
  recordFor?: string,
): Promise<Array<CellChange>> {
  const access = await sheetAccess(sheet);
  if (!access) throw new Error(`unknown sheet: ${sheet}`);
  const existing = new Map<string, string>();
  for (const row of await getCells(sheet)) existing.set(row.id, row.raw);

  const statements: Array<{ sql: string; args: Array<string> }> = [];
  const changes: Array<CellChange> = [];
  const ops: Array<HistoryOp> = [];
  // last write wins within a single batch
  const latest = new Map<string, string>();
  for (const cell of cells) latest.set(cell.id, cell.raw);

  for (const [id, raw] of latest) {
    const prev = existing.get(id);
    if (raw.trim() === "") {
      if (prev === undefined) continue;
      statements.push({ sql: "DELETE FROM cells WHERE sheet = ? AND id = ?", args: [sheet, id] });
      changes.push({ type: "delete", id });
      ops.push({ id, before: prev, after: "" });
    } else if (prev === undefined) {
      statements.push({
        sql: "INSERT INTO cells (sheet, id, raw) VALUES (?, ?, ?)",
        args: [sheet, id, raw],
      });
      changes.push({ type: "insert", id, raw });
      ops.push({ id, before: "", after: raw });
    } else if (prev !== raw) {
      statements.push({
        sql: "UPDATE cells SET raw = ? WHERE sheet = ? AND id = ?",
        args: [raw, sheet, id],
      });
      changes.push({ type: "update", id, raw });
      ops.push({ id, before: prev, after: raw });
    }
  }

  if (statements.length > 0) {
    await batch(statements);
    if (recordFor !== undefined) await recordHistoryEntry(sheet, recordFor, ops);
    await publish(access.owner, { event: "cells", book: access.book, data: { sheet, changes } });
  }
  return changes;
}

// --- history -----------------------------------------------------------------
// Per-client undo/redo, one shared log per sheet. An entry stores before/after
// per cell ("" = absent), so undo applies the befores and redo the afters.
// Stack semantics via the `undone` flag: a client's undone entries always form
// a contiguous suffix of its history because recording a new entry clears them
// (the standard "new edit discards redo"), so undo = newest not-undone entry
// and redo = oldest undone entry.

/** One cell's transition inside a history entry; "" means "cell absent". */
type HistoryOp = { id: string; before: string; after: string };

const MAX_HISTORY_PER_SHEET = 200;

async function recordHistoryEntry(sheet: string, client: string, ops: Array<HistoryOp>) {
  await batch([
    {
      sql: "DELETE FROM history WHERE sheet = ? AND client = ? AND undone = 1",
      args: [sheet, client],
    },
    {
      sql: "INSERT INTO history (sheet, client, ops, undone, created_at) VALUES (?, ?, ?, 0, ?)",
      args: [sheet, client, JSON.stringify(ops), new Date().toISOString()],
    },
    {
      sql: `DELETE FROM history WHERE sheet = ? AND seq NOT IN (
              SELECT seq FROM history WHERE sheet = ? ORDER BY seq DESC LIMIT ${MAX_HISTORY_PER_SHEET}
            )`,
      args: [sheet, sheet],
    },
  ]);
}

export type HistoryState = { canUndo: boolean; canRedo: boolean };

export async function historyState(sheet: string, client: string): Promise<HistoryState> {
  const row = (
    await rows(
      `SELECT
         EXISTS(SELECT 1 FROM history WHERE sheet = ? AND client = ? AND undone = 0) AS canUndo,
         EXISTS(SELECT 1 FROM history WHERE sheet = ? AND client = ? AND undone = 1) AS canRedo`,
      [sheet, client, sheet, client],
    )
  )[0];
  return { canUndo: Number(row?.canUndo) === 1, canRedo: Number(row?.canRedo) === 1 };
}

/**
 * Undo (direction "undo") or redo ("redo") the client's nearest entry.
 * Conflict rule, per cell: only restore a cell whose current value still
 * matches what this entry left it as (undo checks `after`, redo checks
 * `before`); cells overwritten by someone else since are skipped. The entry
 * flips regardless, so a fully-conflicted entry just applies nothing.
 */
export async function applyHistory(
  sheet: string,
  client: string,
  direction: "undo" | "redo",
): Promise<{ applied: number } & HistoryState> {
  const row = (
    await rows(
      direction === "undo"
        ? "SELECT seq, ops FROM history WHERE sheet = ? AND client = ? AND undone = 0 ORDER BY seq DESC LIMIT 1"
        : "SELECT seq, ops FROM history WHERE sheet = ? AND client = ? AND undone = 1 ORDER BY seq ASC LIMIT 1",
      [sheet, client],
    )
  )[0];
  if (!row) return { applied: 0, ...(await historyState(sheet, client)) };
  const ops = JSON.parse(String(row.ops)) as Array<HistoryOp>;

  const currentRaw = new Map((await getCells(sheet)).map((r) => [r.id, r.raw]));

  const writes: Array<CellRow> = [];
  for (const op of ops) {
    const expected = direction === "undo" ? op.after : op.before;
    const target = direction === "undo" ? op.before : op.after;
    if ((currentRaw.get(op.id) ?? "") === expected) writes.push({ id: op.id, raw: target });
  }
  const changes = await applyCellMutations(writes, sheet);
  await run("UPDATE history SET undone = ? WHERE seq = ?", [
    direction === "undo" ? 1 : 0,
    Number(row.seq),
  ]);
  return { applied: changes.length, ...(await historyState(sheet, client)) };
}

// --- column widths -----------------------------------------------------------

export async function getWidths(sheet: string): Promise<Record<string, number>> {
  const raw = (await rows("SELECT widths FROM sheet_meta WHERE sheet = ?", [sheet]))[0]?.widths;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Persist column widths. Identical writes are dropped, which also breaks the
 * client echo loop (atom subscribe → persist → WebSocket → atom set → persist…). */
export async function setWidths(widths: Record<string, number>, sheet: string): Promise<void> {
  const access = await sheetAccess(sheet);
  if (!access) throw new Error(`unknown sheet: ${sheet}`);
  const current = await getWidths(sheet);
  const next = JSON.stringify(widths);
  if (JSON.stringify(current) === next) return;
  await run(
    `INSERT INTO sheet_meta (sheet, widths) VALUES (?, ?)
     ON CONFLICT(sheet) DO UPDATE SET widths = excluded.widths`,
    [sheet, next],
  );
  await publish(access.owner, { event: "meta", book: access.book, data: { sheet, widths } });
}
