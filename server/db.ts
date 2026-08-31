// Server-side source of truth for spreadsheet data, backed by SQLite (libsql).
// Local default is a file DB; set LIBSQL_URL / LIBSQL_AUTH_TOKEN to point at
// Turso instead. The `sheet` column anticipates multi-sheet support — every
// query is already keyed by sheet, with "default" as the only sheet for now.
//
// All writes go through this module in a single node process, so an in-process
// EventEmitter is enough to fan changes out to SSE subscribers. (If the DB is
// ever shared with external writers — e.g. Turso — change detection would need
// polling; see README.)

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createClient } from "@libsql/client";

export const DEFAULT_SHEET = "default";

export type CellRow = { id: string; raw: string };

export type Sheet = { id: string; name: string };

export type CellChange =
  | { type: "insert" | "update"; id: string; raw: string }
  | { type: "delete"; id: string };

export type SheetOpError = "invalid-name" | "duplicate-name" | "unknown-sheet" | "last-sheet";

export type SheetOpResult = { ok: true; sheet: Sheet } | { ok: false; error: SheetOpError };

export type ServerEvents = {
  /** committed cell changes for a sheet */
  cells: [sheet: string, changes: Array<CellChange>];
  /** committed column widths for a sheet */
  meta: [sheet: string, widths: Record<string, number>];
  /** the sheet list after a create / rename / delete */
  sheets: [sheets: Array<Sheet>];
};

export const dbEvents = new EventEmitter<ServerEvents>();

const url = process.env.LIBSQL_URL ?? "file:./data/spreadsheet.db";
if (url.startsWith("file:")) {
  // libsql does not create missing directories for file URLs
  mkdirSync(path.dirname(url.slice("file:".length)), { recursive: true });
}

const client = createClient({
  url,
  authToken: process.env.LIBSQL_AUTH_TOKEN,
});

const ready = client
  .batch(
    [
      `CREATE TABLE IF NOT EXISTS cells (
      sheet TEXT NOT NULL DEFAULT 'default',
      id TEXT NOT NULL,
      raw TEXT NOT NULL,
      PRIMARY KEY (sheet, id)
    )`,
      `CREATE TABLE IF NOT EXISTS sheet_meta (
      sheet TEXT NOT NULL PRIMARY KEY,
      widths TEXT NOT NULL DEFAULT '{}'
    )`,
      `CREATE TABLE IF NOT EXISTS sheets (
      id TEXT NOT NULL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    )`,
      `CREATE TABLE IF NOT EXISTS history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet TEXT NOT NULL,
      client TEXT NOT NULL,
      ops TEXT NOT NULL,
      undone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    ],
    "write",
  )
  .then(() =>
    // An empty sheets table means a fresh or pre-multi-sheet DB (deleting the
    // last sheet is refused, so it can never become empty afterwards). Existing
    // cell data already lives under sheet 'default', so seeding it as "シート1"
    // adopts that data without any migration.
    client.execute(
      `INSERT INTO sheets (id, name)
       SELECT '${DEFAULT_SHEET}', 'シート1'
       WHERE NOT EXISTS (SELECT 1 FROM sheets)`,
    ),
  );

export async function getSheets(): Promise<Array<Sheet>> {
  await ready;
  const result = await client.execute("SELECT id, name FROM sheets ORDER BY rowid");
  return result.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}

export async function sheetExists(sheet: string): Promise<boolean> {
  await ready;
  const result = await client.execute({
    sql: "SELECT 1 FROM sheets WHERE id = ?",
    args: [sheet],
  });
  return result.rows.length > 0;
}

async function emitSheets() {
  dbEvents.emit("sheets", await getSheets());
}

/**
 * Create a sheet. Without a name, picks the first free "シート{N}". An explicit
 * name must be non-empty and unique (the UNIQUE constraint is checked up front
 * so callers can map the failure to a proper error instead of a raw SQL error).
 */
export async function createSheet(name?: string): Promise<SheetOpResult> {
  await ready;
  const sheets = await getSheets();
  const names = new Set(sheets.map((s) => s.name));
  let resolved: string;
  if (name === undefined) {
    let n = sheets.length + 1;
    while (names.has(`シート${n}`)) n++;
    resolved = `シート${n}`;
  } else {
    resolved = name.trim();
    if (resolved === "") return { ok: false, error: "invalid-name" };
    if (names.has(resolved)) return { ok: false, error: "duplicate-name" };
  }
  const sheet: Sheet = { id: randomUUID(), name: resolved };
  await client.execute({
    sql: "INSERT INTO sheets (id, name) VALUES (?, ?)",
    args: [sheet.id, sheet.name],
  });
  await emitSheets();
  return { ok: true, sheet };
}

export async function renameSheet(id: string, name: string): Promise<SheetOpResult> {
  await ready;
  const resolved = name.trim();
  if (resolved === "") return { ok: false, error: "invalid-name" };
  const sheets = await getSheets();
  const target = sheets.find((s) => s.id === id);
  if (!target) return { ok: false, error: "unknown-sheet" };
  if (sheets.some((s) => s.id !== id && s.name === resolved)) {
    return { ok: false, error: "duplicate-name" };
  }
  await client.execute({
    sql: "UPDATE sheets SET name = ? WHERE id = ?",
    args: [resolved, id],
  });
  await emitSheets();
  return { ok: true, sheet: { id, name: resolved } };
}

/**
 * Delete a sheet and its data. The "keep at least one sheet" guard runs inside
 * a single conditional DELETE so concurrent deletes (two tabs at once) cannot
 * race the count check and empty the table.
 */
export async function deleteSheet(id: string): Promise<SheetOpResult> {
  await ready;
  const sheets = await getSheets();
  const target = sheets.find((s) => s.id === id);
  if (!target) return { ok: false, error: "unknown-sheet" };
  const result = await client.execute({
    sql: "DELETE FROM sheets WHERE id = ? AND (SELECT COUNT(*) FROM sheets) > 1",
    args: [id],
  });
  if (result.rowsAffected === 0) return { ok: false, error: "last-sheet" };
  await client.batch(
    [
      { sql: "DELETE FROM cells WHERE sheet = ?", args: [id] },
      { sql: "DELETE FROM sheet_meta WHERE sheet = ?", args: [id] },
      { sql: "DELETE FROM history WHERE sheet = ?", args: [id] },
    ],
    "write",
  );
  await emitSheets();
  return { ok: true, sheet: target };
}

export async function getCells(sheet = DEFAULT_SHEET): Promise<Array<CellRow>> {
  await ready;
  const result = await client.execute({
    sql: "SELECT id, raw FROM cells WHERE sheet = ?",
    args: [sheet],
  });
  return result.rows.map((row) => ({ id: String(row.id), raw: String(row.raw) }));
}

/**
 * Apply a batch of cell writes. An empty (or whitespace-only) raw deletes the
 * cell — the same semantics as setCell in the UI. The change type is derived
 * from the current DB state so subscribers never see a delete+insert of the
 * same key (the react-db live-query congruence pitfall). No-op writes are
 * dropped from the emitted batch.
 *
 * With `recordFor`, the applied batch is also written to the history table as
 * one undoable entry owned by that client (undo/redo application itself passes
 * no recordFor, which is what keeps undos out of the history).
 */
export async function applyCellMutations(
  cells: ReadonlyArray<CellRow>,
  sheet = DEFAULT_SHEET,
  recordFor?: string,
): Promise<Array<CellChange>> {
  await ready;
  if (!(await sheetExists(sheet))) throw new Error(`unknown sheet: ${sheet}`);
  const existing = new Map<string, string>();
  const current = await client.execute({
    sql: "SELECT id, raw FROM cells WHERE sheet = ?",
    args: [sheet],
  });
  for (const row of current.rows) existing.set(String(row.id), String(row.raw));

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
    await client.batch(statements, "write");
    if (recordFor !== undefined) await recordHistoryEntry(sheet, recordFor, ops);
    dbEvents.emit("cells", sheet, changes);
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

async function recordHistoryEntry(sheet: string, client_: string, ops: Array<HistoryOp>) {
  await client.batch(
    [
      {
        sql: "DELETE FROM history WHERE sheet = ? AND client = ? AND undone = 1",
        args: [sheet, client_],
      },
      {
        sql: "INSERT INTO history (sheet, client, ops, undone, created_at) VALUES (?, ?, ?, 0, ?)",
        args: [sheet, client_, JSON.stringify(ops), new Date().toISOString()],
      },
      {
        sql: `DELETE FROM history WHERE sheet = ? AND seq NOT IN (
                SELECT seq FROM history WHERE sheet = ? ORDER BY seq DESC LIMIT ${MAX_HISTORY_PER_SHEET}
              )`,
        args: [sheet, sheet],
      },
    ],
    "write",
  );
}

export type HistoryState = { canUndo: boolean; canRedo: boolean };

export async function historyState(sheet: string, client_: string): Promise<HistoryState> {
  await ready;
  const result = await client.execute({
    sql: `SELECT
            EXISTS(SELECT 1 FROM history WHERE sheet = ? AND client = ? AND undone = 0) AS canUndo,
            EXISTS(SELECT 1 FROM history WHERE sheet = ? AND client = ? AND undone = 1) AS canRedo`,
    args: [sheet, client_, sheet, client_],
  });
  const row = result.rows[0];
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
  client_: string,
  direction: "undo" | "redo",
): Promise<{ applied: number } & HistoryState> {
  await ready;
  const entry = await client.execute(
    direction === "undo"
      ? {
          sql: "SELECT seq, ops FROM history WHERE sheet = ? AND client = ? AND undone = 0 ORDER BY seq DESC LIMIT 1",
          args: [sheet, client_],
        }
      : {
          sql: "SELECT seq, ops FROM history WHERE sheet = ? AND client = ? AND undone = 1 ORDER BY seq ASC LIMIT 1",
          args: [sheet, client_],
        },
  );
  const row = entry.rows[0];
  if (!row) return { applied: 0, ...(await historyState(sheet, client_)) };
  const ops = JSON.parse(String(row.ops)) as Array<HistoryOp>;

  const current = await client.execute({
    sql: "SELECT id, raw FROM cells WHERE sheet = ?",
    args: [sheet],
  });
  const currentRaw = new Map(current.rows.map((r) => [String(r.id), String(r.raw)]));

  const writes: Array<CellRow> = [];
  for (const op of ops) {
    const expected = direction === "undo" ? op.after : op.before;
    const target = direction === "undo" ? op.before : op.after;
    if ((currentRaw.get(op.id) ?? "") === expected) writes.push({ id: op.id, raw: target });
  }
  const changes = await applyCellMutations(writes, sheet);
  await client.execute({
    sql: "UPDATE history SET undone = ? WHERE seq = ?",
    args: [direction === "undo" ? 1 : 0, Number(row.seq)],
  });
  return { applied: changes.length, ...(await historyState(sheet, client_)) };
}

export async function getWidths(sheet = DEFAULT_SHEET): Promise<Record<string, number>> {
  await ready;
  const result = await client.execute({
    sql: "SELECT widths FROM sheet_meta WHERE sheet = ?",
    args: [sheet],
  });
  const raw = result.rows[0]?.widths;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Persist column widths. Identical writes are dropped, which also breaks the
 * client echo loop (atom subscribe → persist → SSE → atom set → persist…). */
export async function setWidths(
  widths: Record<string, number>,
  sheet = DEFAULT_SHEET,
): Promise<void> {
  if (!(await sheetExists(sheet))) throw new Error(`unknown sheet: ${sheet}`);
  const current = await getWidths(sheet);
  const next = JSON.stringify(widths);
  if (JSON.stringify(current) === next) return;
  await client.execute({
    sql: `INSERT INTO sheet_meta (sheet, widths) VALUES (?, ?)
          ON CONFLICT(sheet) DO UPDATE SET widths = excluded.widths`,
    args: [sheet, next],
  });
  dbEvents.emit("meta", sheet, widths);
}
