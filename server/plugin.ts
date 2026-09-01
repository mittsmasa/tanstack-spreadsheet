// Vite plugin hosting the whole server side of the spreadsheet:
//   ALL    /api/auth/*                Better Auth (Google sign-in + OAuth server)
//   GET    /.well-known/oauth-*       OAuth discovery, served by the auth handler
//   GET    /api/books                 the signed-in user's books
//   POST   /api/books                 create a book ({name?}) with its first sheet
//   PATCH  /api/books/:id             rename a book ({name})
//   DELETE /api/books/:id             delete a book and everything under it
//   GET    /api/sheets?book=          sheet list for one book
//   POST   /api/sheets                create a sheet ({book, name?})
//   PATCH  /api/sheets/:id            rename a sheet ({name})
//   DELETE /api/sheets/:id            delete a sheet and its data
//   GET    /api/cells?sheet=          cell snapshot for one sheet
//   POST   /api/cells/mutations       batch cell writes (raw "" = delete), body carries `sheet`
//   GET    /api/meta?sheet=           column widths for one sheet
//   POST   /api/meta                  persist column widths, body carries `sheet`
//   GET    /api/stream?book=          SSE: one book's snapshot, then change batches
//   ALL    /mcp                       MCP endpoint (streamable HTTP, stateless)
//
// Everything except /api/auth and the discovery documents requires a signed-in
// user: the browser routes check the session cookie, /mcp checks an OAuth
// bearer token. Both resolve to a Better Auth user id, and every route below
// only ever reaches data owned by that user — a book or sheet belonging to
// somebody else answers 404 rather than 403, so its existence stays private.
//
// Everything lives in one plugin on purpose: the Start server routes run in a
// separate module graph, so splitting the pieces would duplicate the db module
// and silently disconnect the change feed from the SSE subscribers.

import { requireMcpAuth } from "@better-auth/mcp";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";

import { cellId, parseCellId } from "../src/lib/columns";
import { displayValue } from "../src/lib/formula";
import { BASE_URL, MCP_RESOURCE, auth } from "./auth";
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

import type { Book, BookOpError, CellRow, Sheet, SheetOpError } from "./db";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const MAX_RANGE_CELLS = 10_000;

// --- helpers -----------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text === "") return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A required string field of a POST body, or null when absent / not a string. */
function stringField(body: unknown, field: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// --- auth ---------------------------------------------------------------------

const authHandler = toNodeHandler(auth);

/** Discovery documents MCP clients fetch from the origin root. Better Auth's
 * router runs its plugin onRequest hooks before base-path routing, so handing
 * these straight to the auth handler is enough to serve them. */
function isDiscoveryPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/openid-configuration" ||
    pathname.startsWith("/.well-known/oauth-authorization-server") ||
    pathname.startsWith("/.well-known/oauth-protected-resource")
  );
}

async function writeWebResponse(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

/** The signed-in user's id, or null after replying 401. */
async function requireSession(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (session) return session.user.id;
  sendJson(res, 401, { error: "unauthorized" });
  return null;
}

// requireMcpAuth speaks Web Request/Response while the MCP transport needs the
// raw Node req/res, so it runs as a gate only: this sentinel status means the
// bearer token checked out and the real handler should take over, and anything
// else is the RFC 9728 challenge to send back verbatim. The verified subject
// rides back on a header rather than a closure variable, so concurrent
// requests cannot read each other's identity.
const MCP_TOKEN_OK = 204;
const MCP_SUB_HEADER = "x-mcp-subject";

const mcpGate = requireMcpAuth(
  auth,
  (_request, claims) =>
    new Response(null, {
      status: MCP_TOKEN_OK,
      headers: { [MCP_SUB_HEADER]: typeof claims.sub === "string" ? claims.sub : "" },
    }),
  { resource: MCP_RESOURCE },
);

/** The token subject (a Better Auth user id), or null after replying with an
 * OAuth challenge. */
async function requireMcpToken(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  // Token verification reads only the method, URL and headers, so the body is
  // left on the stream for the MCP transport to consume.
  const verdict = await mcpGate(
    new Request(new URL(req.url ?? "/", BASE_URL), {
      method: req.method ?? "GET",
      headers: fromNodeHeaders(req.headers),
    }),
  );
  if (verdict.status !== MCP_TOKEN_OK) {
    await writeWebResponse(res, verdict);
    return null;
  }
  const subject = verdict.headers.get(MCP_SUB_HEADER);
  if (subject) return subject;
  sendJson(res, 403, { error: "access token carries no subject" });
  return null;
}

// --- request parsing ----------------------------------------------------------

const BOOK_OP_STATUS: Record<BookOpError, number> = {
  "invalid-name": 400,
  "duplicate-name": 409,
  "unknown-book": 404,
  "last-book": 400,
};

const SHEET_OP_STATUS: Record<SheetOpError, number> = {
  "invalid-name": 400,
  "duplicate-name": 409,
  "unknown-sheet": 404,
  "last-sheet": 400,
};

/** History-owner client id from a body's optional `client` field. Mutations
 * without one still apply, they just aren't recorded as undoable. */
function clientOf(body: unknown): string | undefined {
  return stringField(body, "client") ?? undefined;
}

/** Parse and validate a mutation payload; returns null when malformed. */
function parseMutationPayload(body: unknown): Array<CellRow> | null {
  if (body === null || typeof body !== "object") return null;
  const cells = (body as { cells?: unknown }).cells;
  if (!Array.isArray(cells)) return null;
  const parsed: Array<CellRow> = [];
  for (const entry of cells) {
    if (entry === null || typeof entry !== "object") return null;
    const { id, raw } = entry as { id?: unknown; raw?: unknown };
    if (typeof id !== "string" || typeof raw !== "string") return null;
    const normalized = id.trim().toUpperCase();
    if (!parseCellId(normalized)) return null;
    parsed.push({ id: normalized, raw });
  }
  return parsed;
}

// --- MCP ---------------------------------------------------------------------

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function toolJson(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function evaluatedCells(sheet: string): Promise<{
  rawById: Map<string, string>;
  valueOf: (id: string) => string;
}> {
  const rows = await getCells(sheet);
  const rawById = new Map(rows.map((row) => [row.id, row.raw]));
  const getRaw = (id: string) => rawById.get(id);
  return {
    rawById,
    valueOf: (id) => displayValue(id, rawById.get(id), getRaw),
  };
}

/**
 * Resolve a tool's optional `book` argument to one of this user's books: exact
 * id match first, then exact (unique) name match. Omitted → the first book in
 * creation order. Books owned by anyone else are simply not in the candidate
 * list, so they read as unknown.
 */
async function resolveBook(
  owner: string,
  input: unknown,
): Promise<{ id: string } | { error: string }> {
  const books = await getBooks(owner);
  if (input === undefined) {
    const first = books[0];
    return first ? { id: first.id } : { error: "no books exist" };
  }
  if (typeof input !== "string" || input.trim() === "") {
    return { error: `invalid book: ${String(input)}` };
  }
  const match = books.find((b) => b.id === input) ?? books.find((b) => b.name === input);
  return match ? { id: match.id } : { error: `unknown book: ${input}` };
}

/** The same resolution for a sheet, scoped to one already-resolved book. */
async function resolveSheet(
  book: string,
  input: unknown,
): Promise<{ id: string } | { error: string }> {
  const sheets = await getSheets(book);
  if (input === undefined) {
    const first = sheets[0];
    return first ? { id: first.id } : { error: "no sheets exist in this book" };
  }
  if (typeof input !== "string" || input.trim() === "") {
    return { error: `invalid sheet: ${String(input)}` };
  }
  const match = sheets.find((s) => s.id === input) ?? sheets.find((s) => s.name === input);
  return match ? { id: match.id } : { error: `unknown sheet: ${input}` };
}

/** Resolve both levels for the cell tools, which name a sheet inside a book. */
async function resolveTarget(
  owner: string,
  args: Record<string, unknown>,
): Promise<{ book: string; sheet: string } | { error: string }> {
  const book = await resolveBook(owner, args.book);
  if ("error" in book) return book;
  const sheet = await resolveSheet(book.id, args.sheet);
  if ("error" in sheet) return sheet;
  return { book: book.id, sheet: sheet.id };
}

const BOOK_PROPERTY = {
  type: "string",
  description:
    'Book id or book name (see list_books). Omitted: your first book ("ブック1" unless renamed).',
};

const SHEET_PROPERTY = {
  type: "string",
  description:
    'Sheet id or sheet name within the book (see list_sheets). Omitted: the book\'s first sheet ("シート1" unless renamed).',
};

const TOOLS = [
  {
    name: "list_books",
    description:
      "List your books as {id, name} in creation order. A book holds sheets; book ids are stable and names are unique per user.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_book",
    description:
      'Create a new book, along with the one sheet it starts with ("シート1"). Without a name the next free "ブック{N}" is used. Fails if the name is already taken.',
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Book name (must be unique)" } },
    },
  },
  {
    name: "list_sheets",
    description:
      "List one book's sheets as {id, name} in creation order. Sheet ids are stable; names are unique within their book.",
    inputSchema: { type: "object", properties: { book: BOOK_PROPERTY } },
  },
  {
    name: "add_sheet",
    description:
      'Create a new sheet in a book. Without a name the next free "シート{N}" is used. Fails if the name is already taken in that book.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Sheet name (must be unique within the book)" },
        book: BOOK_PROPERTY,
      },
    },
  },
  {
    name: "get_cell",
    description:
      'Read a single cell by "A1"-style id. Returns the raw input (formulas keep their leading "=") and the evaluated display value. Unset cells return raw: null and value: "".',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: 'Cell id, e.g. "A1"' },
        sheet: SHEET_PROPERTY,
        book: BOOK_PROPERTY,
      },
      required: ["id"],
    },
  },
  {
    name: "get_range",
    description:
      'Read a rectangular range like "A1:C10" (a single cell id also works). Returns a row-major 2D array of {id, raw, value}.',
    inputSchema: {
      type: "object",
      properties: {
        range: { type: "string", description: 'Range, e.g. "A1:C10"' },
        sheet: SHEET_PROPERTY,
        book: BOOK_PROPERTY,
      },
      required: ["range"],
    },
  },
  {
    name: "set_cells",
    description:
      'Write cells in one batch. Each entry is {id, raw}; raw is the user-level input (a leading "=" makes it a formula) and an empty string deletes the cell. The whole batch is rejected if any id is invalid. Changes appear live in open browser tabs viewing that book. Undo history is per client: each batch is recorded as one undoable entry owned by the "mcp" client, so browser users cannot undo it (and their undos never revert it).',
    inputSchema: {
      type: "object",
      properties: {
        cells: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: 'Cell id, e.g. "A1"' },
              raw: { type: "string", description: 'New raw content; "" deletes the cell' },
            },
            required: ["id", "raw"],
          },
        },
        sheet: SHEET_PROPERTY,
        book: BOOK_PROPERTY,
      },
      required: ["cells"],
    },
  },
  {
    name: "get_snapshot",
    description:
      "List every non-empty cell of one sheet with its raw input and evaluated value. Useful as a full export of the sheet.",
    inputSchema: {
      type: "object",
      properties: { sheet: SHEET_PROPERTY, book: BOOK_PROPERTY },
    },
  },
];

async function callTool(
  owner: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "list_books":
      return toolJson({ books: await getBooks(owner) });
    case "add_book": {
      if (args.name !== undefined && typeof args.name !== "string") {
        return toolError(`invalid book name: ${String(args.name)}`);
      }
      const result = await createBook(owner, args.name);
      if (!result.ok) return toolError(`could not create book: ${result.error}`);
      return toolJson({ book: result.book });
    }
    case "list_sheets": {
      const book = await resolveBook(owner, args.book);
      if ("error" in book) return toolError(book.error);
      return toolJson({ book: book.id, sheets: await getSheets(book.id) });
    }
    case "add_sheet": {
      const book = await resolveBook(owner, args.book);
      if ("error" in book) return toolError(book.error);
      if (args.name !== undefined && typeof args.name !== "string") {
        return toolError(`invalid sheet name: ${String(args.name)}`);
      }
      const result = await createSheet(book.id, args.name);
      if (!result.ok) return toolError(`could not create sheet: ${result.error}`);
      return toolJson({ book: book.id, sheet: result.sheet });
    }
    case "get_cell": {
      const target = await resolveTarget(owner, args);
      if ("error" in target) return toolError(target.error);
      const id = typeof args.id === "string" ? args.id.trim().toUpperCase() : "";
      if (!parseCellId(id)) return toolError(`invalid cell id: ${String(args.id)}`);
      const { rawById, valueOf } = await evaluatedCells(target.sheet);
      const raw = rawById.get(id);
      return toolJson({ id, raw: raw ?? null, value: raw === undefined ? "" : valueOf(id) });
    }
    case "get_range": {
      const target = await resolveTarget(owner, args);
      if ("error" in target) return toolError(target.error);
      const input = typeof args.range === "string" ? args.range.trim().toUpperCase() : "";
      const [startId, endId = startId] = input.split(":", 2);
      const start = parseCellId(startId ?? "");
      const end = parseCellId(endId ?? "");
      if (!start || !end) return toolError(`invalid range: ${String(args.range)}`);
      const cols = [Math.min(start.colIndex, end.colIndex), Math.max(start.colIndex, end.colIndex)];
      const rows = [
        Math.min(start.rowNumber, end.rowNumber),
        Math.max(start.rowNumber, end.rowNumber),
      ];
      const size = (cols[1] - cols[0] + 1) * (rows[1] - rows[0] + 1);
      if (size > MAX_RANGE_CELLS) {
        return toolError(`range too large: ${size} cells (max ${MAX_RANGE_CELLS})`);
      }
      const { rawById, valueOf } = await evaluatedCells(target.sheet);
      const grid: Array<Array<{ id: string; raw: string | null; value: string }>> = [];
      for (let r = rows[0]; r <= rows[1]; r++) {
        const row: Array<{ id: string; raw: string | null; value: string }> = [];
        for (let c = cols[0]; c <= cols[1]; c++) {
          const id = cellId(c, r);
          const raw = rawById.get(id);
          row.push({ id, raw: raw ?? null, value: raw === undefined ? "" : valueOf(id) });
        }
        grid.push(row);
      }
      return toolJson({ range: input, rows: grid });
    }
    case "set_cells": {
      const target = await resolveTarget(owner, args);
      if ("error" in target) return toolError(target.error);
      const cells = parseMutationPayload({ cells: args.cells });
      if (!cells) {
        return toolError(
          'invalid cells payload: expected [{id: "A1", raw: "..."}] with valid cell ids',
        );
      }
      const changes = await applyCellMutations(cells, target.sheet, "mcp");
      return toolJson({ applied: changes.length });
    }
    case "get_snapshot": {
      const target = await resolveTarget(owner, args);
      if ("error" in target) return toolError(target.error);
      const { rawById, valueOf } = await evaluatedCells(target.sheet);
      const cells = [...rawById.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([id, raw]) => ({ id, raw, value: valueOf(id) }));
      return toolJson({ cells });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, owner: string) {
  const body = await readBody(req).catch(() => undefined);
  const server = new Server(
    { name: "tanstack-spreadsheet", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTool(owner, request.params.name, request.params.arguments ?? {});
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// --- SSE ---------------------------------------------------------------------

function sendEvent(res: ServerResponse, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * One book's live feed. The stream is scoped to a single book so the opening
 * snapshot stays the size of what the tab actually shows; switching books
 * means reconnecting with a different `book`.
 *
 * The two event families match on different keys: cell / width / sheet-list
 * events carry the book they happened in, while the book-list event carries an
 * owner and no book at all. Matching it on `book` would silently never deliver.
 */
async function handleStream(
  res: ServerResponse,
  req: IncomingMessage,
  owner: string,
  book: string,
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Whole-book snapshot: the EventSource auto-reconnect relies on this resend
  // to resync every per-sheet collection over the single shared stream.
  const sheets = await getSheets(book);
  const bySheet: Record<string, { cells: Array<CellRow>; widths: Record<string, number> }> = {};
  for (const sheet of sheets) {
    const [cells, widths] = await Promise.all([getCells(sheet.id), getWidths(sheet.id)]);
    bySheet[sheet.id] = { cells, widths };
  }
  sendEvent(res, "snapshot", { book, books: await getBooks(owner), sheets, bySheet });

  const onCells = (eventBook: string, sheet: string, changes: unknown) => {
    if (eventBook === book) sendEvent(res, "cells", { sheet, changes });
  };
  const onMeta = (eventBook: string, sheet: string, widths: unknown) => {
    if (eventBook === book) sendEvent(res, "meta", { sheet, widths });
  };
  const onSheets = (eventBook: string, nextSheets: Array<Sheet>) => {
    if (eventBook === book) sendEvent(res, "sheets", { sheets: nextSheets });
  };
  const onBooks = (eventOwner: string, nextBooks: Array<Book>) => {
    if (eventOwner === owner) sendEvent(res, "books", { books: nextBooks });
  };
  dbEvents.on("cells", onCells);
  dbEvents.on("meta", onMeta);
  dbEvents.on("sheets", onSheets);
  dbEvents.on("books", onBooks);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    dbEvents.off("cells", onCells);
    dbEvents.off("meta", onMeta);
    dbEvents.off("sheets", onSheets);
    dbEvents.off("books", onBooks);
  });
}

// --- plugin ------------------------------------------------------------------

/** Reply 404 unless the book exists and belongs to this user; true means the
 * caller may proceed. Someone else's book is indistinguishable from a missing
 * one on purpose. */
async function requireBook(res: ServerResponse, book: string, owner: string): Promise<boolean> {
  if ((await bookOwner(book)) === owner) return true;
  sendJson(res, 404, { error: `unknown book: ${book}` });
  return false;
}

/** The book a sheet belongs to, or null after replying 404 (missing sheet, or
 * one under somebody else's book). */
async function requireSheet(
  res: ServerResponse,
  sheet: string,
  owner: string,
): Promise<string | null> {
  const access = await sheetAccess(sheet);
  if (access && access.owner === owner) return access.book;
  sendJson(res, 404, { error: `unknown sheet: ${sheet}` });
  return null;
}

/** The required `sheet` field of a request, or null after replying 400. */
function requireSheetParam(res: ServerResponse, sheet: string | null): sheet is string {
  if (sheet !== null) return true;
  sendJson(res, 400, { error: "missing sheet" });
  return false;
}

function sendBookOpError(res: ServerResponse, error: BookOpError) {
  sendJson(res, BOOK_OP_STATUS[error], { error });
}

function sendSheetOpError(res: ServerResponse, error: SheetOpError) {
  sendJson(res, SHEET_OP_STATUS[error], { error });
}

async function handleBooks(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (pathname === "/api/books" && method === "GET") {
    sendJson(res, 200, { books: await getBooks(owner) });
    return true;
  }
  if (pathname === "/api/books" && method === "POST") {
    const body = (await readBody(req).catch(() => null)) as { name?: unknown } | null;
    if (body?.name !== undefined && typeof body.name !== "string") {
      sendJson(res, 400, { error: "invalid book name" });
      return true;
    }
    const result = await createBook(owner, body?.name);
    if (!result.ok) sendBookOpError(res, result.error);
    else sendJson(res, 200, { book: result.book });
    return true;
  }
  if (!pathname.startsWith("/api/books/")) return false;
  const id = decodeURIComponent(pathname.slice("/api/books/".length));
  if (method === "PATCH") {
    const body = (await readBody(req).catch(() => null)) as { name?: unknown } | null;
    if (typeof body?.name !== "string") {
      sendJson(res, 400, { error: "invalid book name" });
      return true;
    }
    if (!(await requireBook(res, id, owner))) return true;
    const result = await renameBook(owner, id, body.name);
    if (!result.ok) sendBookOpError(res, result.error);
    else sendJson(res, 200, { book: result.book });
    return true;
  }
  if (method === "DELETE") {
    if (!(await requireBook(res, id, owner))) return true;
    const result = await deleteBook(owner, id);
    if (!result.ok) sendBookOpError(res, result.error);
    else sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

async function handleSheets(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  pathname: string,
  method: string,
  searchParams: URLSearchParams,
): Promise<boolean> {
  if (pathname === "/api/sheets" && method === "GET") {
    const book = searchParams.get("book");
    if (book === null) {
      sendJson(res, 400, { error: "missing book" });
      return true;
    }
    if (!(await requireBook(res, book, owner))) return true;
    sendJson(res, 200, { sheets: await getSheets(book) });
    return true;
  }
  if (pathname === "/api/sheets" && method === "POST") {
    const body = (await readBody(req).catch(() => null)) as {
      book?: unknown;
      name?: unknown;
    } | null;
    const book = stringField(body, "book");
    if (book === null) {
      sendJson(res, 400, { error: "missing book" });
      return true;
    }
    if (body?.name !== undefined && typeof body.name !== "string") {
      sendJson(res, 400, { error: "invalid sheet name" });
      return true;
    }
    if (!(await requireBook(res, book, owner))) return true;
    const result = await createSheet(book, body?.name);
    if (!result.ok) sendSheetOpError(res, result.error);
    else sendJson(res, 200, { sheet: result.sheet });
    return true;
  }
  if (!pathname.startsWith("/api/sheets/")) return false;
  const id = decodeURIComponent(pathname.slice("/api/sheets/".length));
  if (method === "PATCH") {
    const body = (await readBody(req).catch(() => null)) as { name?: unknown } | null;
    if (typeof body?.name !== "string") {
      sendJson(res, 400, { error: "invalid sheet name" });
      return true;
    }
    const book = await requireSheet(res, id, owner);
    if (book === null) return true;
    const result = await renameSheet(book, id, body.name);
    if (!result.ok) sendSheetOpError(res, result.error);
    else sendJson(res, 200, { sheet: result.sheet });
    return true;
  }
  if (method === "DELETE") {
    const book = await requireSheet(res, id, owner);
    if (book === null) return true;
    const result = await deleteSheet(book, id);
    if (!result.ok) sendSheetOpError(res, result.error);
    else sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname, searchParams } = new URL(req.url ?? "", "http://localhost");
  const method = req.method ?? "GET";

  if (pathname.startsWith("/api/auth/") || isDiscoveryPath(pathname)) {
    await authHandler(req, res);
    return true;
  }
  if (pathname === "/mcp") {
    const owner = await requireMcpToken(req, res);
    if (owner !== null) await handleMcp(req, res, owner);
    return true;
  }
  if (!pathname.startsWith("/api/")) return false;
  // Everything below is the signed-in user's own data.
  const owner = await requireSession(req, res);
  if (owner === null) return true;

  if (pathname === "/api/stream" && method === "GET") {
    const book = searchParams.get("book");
    if (book === null) {
      sendJson(res, 400, { error: "missing book" });
      return true;
    }
    if (!(await requireBook(res, book, owner))) return true;
    await handleStream(res, req, owner, book);
    return true;
  }
  if (await handleBooks(req, res, owner, pathname, method)) return true;
  if (await handleSheets(req, res, owner, pathname, method, searchParams)) return true;

  if (pathname === "/api/cells" && method === "GET") {
    const sheet = searchParams.get("sheet");
    if (!requireSheetParam(res, sheet)) return true;
    if ((await requireSheet(res, sheet, owner)) === null) return true;
    sendJson(res, 200, { cells: await getCells(sheet) });
    return true;
  }
  if (pathname === "/api/cells/mutations" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const cells = body === null ? null : parseMutationPayload(body);
    if (!cells) {
      sendJson(res, 400, { error: "invalid mutation payload" });
      return true;
    }
    const sheet = stringField(body, "sheet");
    if (!requireSheetParam(res, sheet)) return true;
    if ((await requireSheet(res, sheet, owner)) === null) return true;
    const client = clientOf(body);
    const changes = await applyCellMutations(cells, sheet, client);
    const state = client === undefined ? {} : await historyState(sheet, client);
    sendJson(res, 200, { applied: changes.length, ...state });
    return true;
  }
  if ((pathname === "/api/history/undo" || pathname === "/api/history/redo") && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const client = clientOf(body);
    if (client === undefined) {
      sendJson(res, 400, { error: "missing client" });
      return true;
    }
    const sheet = stringField(body, "sheet");
    if (!requireSheetParam(res, sheet)) return true;
    if ((await requireSheet(res, sheet, owner)) === null) return true;
    const direction = pathname === "/api/history/undo" ? "undo" : "redo";
    sendJson(res, 200, await applyHistory(sheet, client, direction));
    return true;
  }
  if (pathname === "/api/history/state" && method === "GET") {
    const client = searchParams.get("client");
    if (client === null || client.trim() === "") {
      sendJson(res, 400, { error: "missing client" });
      return true;
    }
    const sheet = searchParams.get("sheet");
    if (!requireSheetParam(res, sheet)) return true;
    if ((await requireSheet(res, sheet, owner)) === null) return true;
    sendJson(res, 200, await historyState(sheet, client));
    return true;
  }
  if (pathname === "/api/meta" && method === "GET") {
    const sheet = searchParams.get("sheet");
    if (!requireSheetParam(res, sheet)) return true;
    if ((await requireSheet(res, sheet, owner)) === null) return true;
    sendJson(res, 200, { widths: await getWidths(sheet) });
    return true;
  }
  if (pathname === "/api/meta" && method === "POST") {
    const body = (await readBody(req).catch(() => null)) as {
      widths?: unknown;
      sheet?: unknown;
    } | null;
    const widths = body?.widths;
    if (widths === null || typeof widths !== "object" || Array.isArray(widths)) {
      sendJson(res, 400, { error: "invalid widths payload" });
      return true;
    }
    const sheet = stringField(body, "sheet");
    if (!requireSheetParam(res, sheet)) return true;
    if ((await requireSheet(res, sheet, owner)) === null) return true;
    await setWidths(widths as Record<string, number>, sheet);
    sendJson(res, 200, { ok: true });
    return true;
  }
  return false;
}

export function spreadsheetServer(): Plugin {
  const middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    handle(req, res)
      .then((handled) => {
        if (!handled) next();
      })
      .catch((error: unknown) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(error) });
        else res.end();
      });
  };
  return {
    name: "spreadsheet-server",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
