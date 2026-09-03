-- Spreadsheet tables. A book owns sheets, a sheet owns cells; sheet ids are
-- UUIDs and globally unique, so cells / sheet_meta / history stay keyed by
-- sheet id alone. `owner` is a Better Auth user id.
CREATE TABLE IF NOT EXISTS books (
  id TEXT NOT NULL PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS books_owner_name ON books (owner, name);
CREATE TABLE IF NOT EXISTS sheets (
  id TEXT NOT NULL PRIMARY KEY,
  book TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS sheets_book_name ON sheets (book, name);
CREATE TABLE IF NOT EXISTS cells (
  sheet TEXT NOT NULL,
  id TEXT NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (sheet, id)
);
CREATE TABLE IF NOT EXISTS sheet_meta (
  sheet TEXT NOT NULL PRIMARY KEY,
  widths TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet TEXT NOT NULL,
  client TEXT NOT NULL,
  ops TEXT NOT NULL,
  undone INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
