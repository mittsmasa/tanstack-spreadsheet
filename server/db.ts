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
import { mkdirSync } from "node:fs";
import path from "node:path";

import { createClient } from "@libsql/client";

export const DEFAULT_SHEET = "default";

export type CellRow = { id: string; raw: string };

export type CellChange =
  | { type: "insert" | "update"; id: string; raw: string }
  | { type: "delete"; id: string };

export type ServerEvents = {
  /** committed cell changes for a sheet */
  cells: [sheet: string, changes: Array<CellChange>];
  /** committed column widths for a sheet */
  meta: [sheet: string, widths: Record<string, number>];
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

const ready = client.batch(
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
  ],
  "write",
);

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
 */
export async function applyCellMutations(
  cells: ReadonlyArray<CellRow>,
  sheet = DEFAULT_SHEET,
): Promise<Array<CellChange>> {
  await ready;
  const existing = new Map<string, string>();
  const current = await client.execute({
    sql: "SELECT id, raw FROM cells WHERE sheet = ?",
    args: [sheet],
  });
  for (const row of current.rows) existing.set(String(row.id), String(row.raw));

  const statements: Array<{ sql: string; args: Array<string> }> = [];
  const changes: Array<CellChange> = [];
  // last write wins within a single batch
  const latest = new Map<string, string>();
  for (const cell of cells) latest.set(cell.id, cell.raw);

  for (const [id, raw] of latest) {
    const prev = existing.get(id);
    if (raw.trim() === "") {
      if (prev === undefined) continue;
      statements.push({ sql: "DELETE FROM cells WHERE sheet = ? AND id = ?", args: [sheet, id] });
      changes.push({ type: "delete", id });
    } else if (prev === undefined) {
      statements.push({
        sql: "INSERT INTO cells (sheet, id, raw) VALUES (?, ?, ?)",
        args: [sheet, id, raw],
      });
      changes.push({ type: "insert", id, raw });
    } else if (prev !== raw) {
      statements.push({
        sql: "UPDATE cells SET raw = ? WHERE sheet = ? AND id = ?",
        args: [raw, sheet, id],
      });
      changes.push({ type: "update", id, raw });
    }
  }

  if (statements.length > 0) {
    await client.batch(statements, "write");
    dbEvents.emit("cells", sheet, changes);
  }
  return changes;
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
