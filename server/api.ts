// The whole HTTP API of the spreadsheet, answered before the Start handler:
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
//   POST   /api/history/undo|redo     apply the client's nearest history entry
//   GET    /api/history/state         canUndo / canRedo for a client on a sheet
//   GET    /api/meta?sheet=           column widths for one sheet
//   POST   /api/meta                  persist column widths, body carries `sheet`
//   GET    /api/stream?book=          WebSocket: one book's snapshot, then change batches
//   ALL    /mcp                       MCP endpoint (streamable HTTP, stateless)
//
// Everything except /api/auth and the discovery documents requires a signed-in
// user: the browser routes check the session cookie, /mcp checks an OAuth
// bearer token. Both resolve to a Better Auth user id, and every route below
// only ever reaches data owned by that user — a book or sheet belonging to
// somebody else answers 404 rather than 403, so its existence stays private.
//
// handleApi returns null for anything it does not own so the Worker entry can
// fall through to the Start handler.

import { requireMcpAuth } from "@better-auth/mcp";
import { env } from "cloudflare:workers";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { cellId, parseCellId } from "../src/lib/columns";
import { displayValue } from "../src/lib/formula";
import { MCP_RESOURCE, getAuth } from "./auth";
import {
  applyCellMutations,
  applyHistory,
  bookOwner,
  createBook,
  createSheet,
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

import type { BookOpError, CellRow, SheetOpError } from "./db";

const MAX_RANGE_CELLS = 10_000;

// --- helpers -----------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** The JSON body, or null when absent or malformed. */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** A required string field of a POST body, or null when absent / not a string. */
function stringField(body: unknown, field: string): string | null {
  const value = (body as Record<string, unknown> | null)?.[field];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// --- auth ---------------------------------------------------------------------

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

/** The signed-in user's id, or null when there is no valid session. */
async function sessionOwner(request: Request): Promise<string | null> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  return session ? session.user.id : null;
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

/** One stateless MCP exchange: a fresh server + transport per request. */
async function handleMcp(request: Request, owner: string): Promise<Response> {
  const server = new Server(
    { name: "tanstack-spreadsheet", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (mcpRequest) => {
    try {
      return await callTool(owner, mcpRequest.params.name, mcpRequest.params.arguments ?? {});
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}

// requireMcpAuth verifies the bearer token against the JWT plugin's keys and
// answers with the RFC 9728 challenge itself when it is missing or invalid.
// Built on first use for the same reason getAuth() is (see auth.ts).
let mcpEndpoint: ((request: Request) => Promise<Response>) | undefined;

function getMcpEndpoint() {
  mcpEndpoint ??= requireMcpAuth(
    getAuth(),
    (request, claims) =>
      typeof claims.sub === "string"
        ? handleMcp(request, claims.sub)
        : json(403, { error: "access token carries no subject" }),
    { resource: MCP_RESOURCE },
  );
  return mcpEndpoint;
}

// --- routes ------------------------------------------------------------------

/** 404 unless the book exists and belongs to this user; null means the caller
 * may proceed. Someone else's book is indistinguishable from a missing one on
 * purpose. */
async function bookGuard(book: string, owner: string): Promise<Response | null> {
  if ((await bookOwner(book)) === owner) return null;
  return json(404, { error: `unknown book: ${book}` });
}

/** The book a sheet belongs to, or a 404 response (missing sheet, or one under
 * somebody else's book). */
async function sheetGuard(sheet: string, owner: string): Promise<{ book: string } | Response> {
  const access = await sheetAccess(sheet);
  if (access && access.owner === owner) return { book: access.book };
  return json(404, { error: `unknown sheet: ${sheet}` });
}

function bookOpResponse(result: Awaited<ReturnType<typeof createBook>>): Response {
  return result.ok
    ? json(200, { book: result.book })
    : json(BOOK_OP_STATUS[result.error], { error: result.error });
}

function sheetOpResponse(result: Awaited<ReturnType<typeof createSheet>>): Response {
  return result.ok
    ? json(200, { sheet: result.sheet })
    : json(SHEET_OP_STATUS[result.error], { error: result.error });
}

async function handleBooks(
  request: Request,
  owner: string,
  pathname: string,
): Promise<Response | null> {
  const method = request.method;
  if (pathname === "/api/books" && method === "GET") {
    return json(200, { books: await getBooks(owner) });
  }
  if (pathname === "/api/books" && method === "POST") {
    const body = (await readBody(request)) as { name?: unknown } | null;
    if (body?.name !== undefined && typeof body.name !== "string") {
      return json(400, { error: "invalid book name" });
    }
    return bookOpResponse(await createBook(owner, body?.name));
  }
  if (!pathname.startsWith("/api/books/")) return null;
  const id = decodeURIComponent(pathname.slice("/api/books/".length));
  if (method === "PATCH") {
    const body = (await readBody(request)) as { name?: unknown } | null;
    if (typeof body?.name !== "string") return json(400, { error: "invalid book name" });
    return (await bookGuard(id, owner)) ?? bookOpResponse(await renameBook(owner, id, body.name));
  }
  if (method === "DELETE") {
    const denied = await bookGuard(id, owner);
    if (denied) return denied;
    const result = await deleteBook(owner, id);
    return result.ok ? json(200, { ok: true }) : bookOpResponse(result);
  }
  return null;
}

async function handleSheets(
  request: Request,
  owner: string,
  pathname: string,
  searchParams: URLSearchParams,
): Promise<Response | null> {
  const method = request.method;
  if (pathname === "/api/sheets" && method === "GET") {
    const book = searchParams.get("book");
    if (book === null) return json(400, { error: "missing book" });
    return (await bookGuard(book, owner)) ?? json(200, { sheets: await getSheets(book) });
  }
  if (pathname === "/api/sheets" && method === "POST") {
    const body = (await readBody(request)) as { book?: unknown; name?: unknown } | null;
    const book = stringField(body, "book");
    if (book === null) return json(400, { error: "missing book" });
    if (body?.name !== undefined && typeof body.name !== "string") {
      return json(400, { error: "invalid sheet name" });
    }
    return (await bookGuard(book, owner)) ?? sheetOpResponse(await createSheet(book, body?.name));
  }
  if (!pathname.startsWith("/api/sheets/")) return null;
  const id = decodeURIComponent(pathname.slice("/api/sheets/".length));
  if (method === "PATCH") {
    const body = (await readBody(request)) as { name?: unknown } | null;
    if (typeof body?.name !== "string") return json(400, { error: "invalid sheet name" });
    const access = await sheetGuard(id, owner);
    if (access instanceof Response) return access;
    return sheetOpResponse(await renameSheet(access.book, id, body.name));
  }
  if (method === "DELETE") {
    const access = await sheetGuard(id, owner);
    if (access instanceof Response) return access;
    const result = await deleteSheet(access.book, id);
    return result.ok ? json(200, { ok: true }) : sheetOpResponse(result);
  }
  return null;
}

/** Hand the upgrade to the owner's SyncHub, which accepts the socket and
 * sends the book snapshot. Ownership was already checked by the caller. */
function openStream(request: Request, owner: string, book: string): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return Promise.resolve(json(426, { error: "expected websocket upgrade" }));
  }
  const target = new URL(request.url);
  target.search = "";
  target.searchParams.set("owner", owner);
  target.searchParams.set("book", book);
  return env.SYNC_HUB.getByName(owner).fetch(new Request(target, request));
}

/**
 * Answer the request if it belongs to the API, otherwise return null so the
 * Worker entry falls through to the Start handler.
 */
export async function handleApi(request: Request): Promise<Response | null> {
  const { pathname, searchParams } = new URL(request.url);
  const method = request.method;

  if (pathname.startsWith("/api/auth/") || isDiscoveryPath(pathname)) {
    return getAuth().handler(request);
  }
  if (pathname === "/mcp") return getMcpEndpoint()(request);
  if (!pathname.startsWith("/api/")) return null;

  // Everything below is the signed-in user's own data.
  const owner = await sessionOwner(request);
  if (owner === null) return json(401, { error: "unauthorized" });

  if (pathname === "/api/stream" && method === "GET") {
    const book = searchParams.get("book");
    if (book === null) return json(400, { error: "missing book" });
    return (await bookGuard(book, owner)) ?? openStream(request, owner, book);
  }
  const books = await handleBooks(request, owner, pathname);
  if (books) return books;
  const sheets = await handleSheets(request, owner, pathname, searchParams);
  if (sheets) return sheets;

  if (pathname === "/api/cells" && method === "GET") {
    const sheet = searchParams.get("sheet");
    if (sheet === null) return json(400, { error: "missing sheet" });
    const access = await sheetGuard(sheet, owner);
    if (access instanceof Response) return access;
    return json(200, { cells: await getCells(sheet) });
  }
  if (pathname === "/api/cells/mutations" && method === "POST") {
    const body = await readBody(request);
    const cells = body === null ? null : parseMutationPayload(body);
    if (!cells) return json(400, { error: "invalid mutation payload" });
    const sheet = stringField(body, "sheet");
    if (sheet === null) return json(400, { error: "missing sheet" });
    const access = await sheetGuard(sheet, owner);
    if (access instanceof Response) return access;
    const client = clientOf(body);
    const changes = await applyCellMutations(cells, sheet, client);
    const state = client === undefined ? {} : await historyState(sheet, client);
    return json(200, { applied: changes.length, ...state });
  }
  if ((pathname === "/api/history/undo" || pathname === "/api/history/redo") && method === "POST") {
    const body = await readBody(request);
    const client = clientOf(body);
    if (client === undefined) return json(400, { error: "missing client" });
    const sheet = stringField(body, "sheet");
    if (sheet === null) return json(400, { error: "missing sheet" });
    const access = await sheetGuard(sheet, owner);
    if (access instanceof Response) return access;
    const direction = pathname === "/api/history/undo" ? "undo" : "redo";
    return json(200, await applyHistory(sheet, client, direction));
  }
  if (pathname === "/api/history/state" && method === "GET") {
    const client = searchParams.get("client");
    if (client === null || client.trim() === "") return json(400, { error: "missing client" });
    const sheet = searchParams.get("sheet");
    if (sheet === null) return json(400, { error: "missing sheet" });
    const access = await sheetGuard(sheet, owner);
    if (access instanceof Response) return access;
    return json(200, await historyState(sheet, client));
  }
  if (pathname === "/api/meta" && method === "GET") {
    const sheet = searchParams.get("sheet");
    if (sheet === null) return json(400, { error: "missing sheet" });
    const access = await sheetGuard(sheet, owner);
    if (access instanceof Response) return access;
    return json(200, { widths: await getWidths(sheet) });
  }
  if (pathname === "/api/meta" && method === "POST") {
    const body = (await readBody(request)) as { widths?: unknown; sheet?: unknown } | null;
    const widths = body?.widths;
    if (widths === null || typeof widths !== "object" || Array.isArray(widths)) {
      return json(400, { error: "invalid widths payload" });
    }
    const sheet = stringField(body, "sheet");
    if (sheet === null) return json(400, { error: "missing sheet" });
    const access = await sheetGuard(sheet, owner);
    if (access instanceof Response) return access;
    await setWidths(widths as Record<string, number>, sheet);
    return json(200, { ok: true });
  }
  return null;
}
