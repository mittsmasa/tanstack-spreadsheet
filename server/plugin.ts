// Vite plugin hosting the whole server side of the spreadsheet:
//   ALL    /api/auth/*                Better Auth (Google sign-in + OAuth server)
//   GET    /.well-known/oauth-*       OAuth discovery, served by the auth handler
//   GET    /api/cells?sheet=          cell snapshot for one sheet
//   POST   /api/cells/mutations       batch cell writes (raw "" = delete), body carries `sheet`
//   GET    /api/meta?sheet=           column widths for one sheet
//   POST   /api/meta                  persist column widths, body carries `sheet`
//   GET    /api/sheets                sheet list
//   POST   /api/sheets                create a sheet ({name?})
//   PATCH  /api/sheets/:id            rename a sheet ({name})
//   DELETE /api/sheets/:id            delete a sheet and its data
//   GET    /api/stream                SSE: all-sheet snapshot, then change batches
//   ALL    /mcp                       MCP endpoint (streamable HTTP, stateless)
//
// Everything except /api/auth and the discovery documents requires a signed-in
// user: the browser routes check the session cookie, /mcp checks an OAuth
// bearer token.
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
  DEFAULT_SHEET,
  applyCellMutations,
  applyHistory,
  createSheet,
  dbEvents,
  deleteSheet,
  getCells,
  getSheets,
  getWidths,
  historyState,
  renameSheet,
  setWidths,
  sheetExists,
} from "./db";

import type { CellRow, Sheet, SheetOpError } from "./db";
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

/** Reply 401 unless a session cookie identifies a signed-in user. */
async function requireSession(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (session) return true;
  sendJson(res, 401, { error: "unauthorized" });
  return false;
}

// requireMcpAuth speaks Web Request/Response while the MCP transport needs the
// raw Node req/res, so it runs as a gate only: this sentinel status means the
// bearer token checked out and the real handler should take over, and anything
// else is the RFC 9728 challenge to send back verbatim.
const MCP_TOKEN_OK = 204;

const mcpGate = requireMcpAuth(auth, () => new Response(null, { status: MCP_TOKEN_OK }), {
  resource: MCP_RESOURCE,
});

/** Reply with an OAuth challenge unless the request carries a valid MCP token. */
async function requireMcpToken(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  // Token verification reads only the method, URL and headers, so the body is
  // left on the stream for the MCP transport to consume.
  const verdict = await mcpGate(
    new Request(new URL(req.url ?? "/", BASE_URL), {
      method: req.method ?? "GET",
      headers: fromNodeHeaders(req.headers),
    }),
  );
  if (verdict.status === MCP_TOKEN_OK) return true;
  await writeWebResponse(res, verdict);
  return false;
}

/** Sheet id from a POST body's optional `sheet` field. */
function sheetOf(body: unknown): string {
  const sheet = (body as { sheet?: unknown } | null)?.sheet;
  return typeof sheet === "string" ? sheet : DEFAULT_SHEET;
}

/** History-owner client id from a body's optional `client` field. Mutations
 * without one still apply, they just aren't recorded as undoable. */
function clientOf(body: unknown): string | undefined {
  const client = (body as { client?: unknown } | null)?.client;
  return typeof client === "string" && client.trim() !== "" ? client : undefined;
}

const SHEET_OP_STATUS: Record<SheetOpError, number> = {
  "invalid-name": 400,
  "duplicate-name": 409,
  "unknown-sheet": 404,
  "last-sheet": 400,
};

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
 * Resolve a tool's optional `sheet` argument to a sheet id: exact id match
 * first, then exact (unique) name match. Omitted → the first sheet, which is
 * the historical default sheet until someone deletes it.
 */
async function resolveSheet(input: unknown): Promise<{ id: string } | { error: string }> {
  const sheets = await getSheets();
  if (input === undefined) {
    const first = sheets[0];
    return first ? { id: first.id } : { error: "no sheets exist" };
  }
  if (typeof input !== "string" || input.trim() === "") {
    return { error: `invalid sheet: ${String(input)}` };
  }
  const match = sheets.find((s) => s.id === input) ?? sheets.find((s) => s.name === input);
  return match ? { id: match.id } : { error: `unknown sheet: ${input}` };
}

const SHEET_PROPERTY = {
  type: "string",
  description:
    'Sheet id or sheet name (see list_sheets). Omitted: the first sheet ("シート1" unless renamed).',
};

const TOOLS = [
  {
    name: "get_cell",
    description:
      'Read a single cell by "A1"-style id. Returns the raw input (formulas keep their leading "=") and the evaluated display value. Unset cells return raw: null and value: "".',
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: 'Cell id, e.g. "A1"' },
        sheet: SHEET_PROPERTY,
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
      },
      required: ["range"],
    },
  },
  {
    name: "set_cells",
    description:
      'Write cells in one batch. Each entry is {id, raw}; raw is the user-level input (a leading "=" makes it a formula) and an empty string deletes the cell. The whole batch is rejected if any id is invalid. Changes appear live in open browser tabs. Undo history is per client: each batch is recorded as one undoable entry owned by the "mcp" client, so browser users cannot undo it (and their undos never revert it).',
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
      },
      required: ["cells"],
    },
  },
  {
    name: "get_snapshot",
    description:
      "List every non-empty cell of one sheet with its raw input and evaluated value. Useful as a full export of the sheet.",
    inputSchema: { type: "object", properties: { sheet: SHEET_PROPERTY } },
  },
  {
    name: "list_sheets",
    description:
      "List all sheets as {id, name} in creation order. Sheet ids are stable; names are unique and user-editable.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_sheet",
    description:
      'Create a new sheet. Without a name the next free "シート{N}" is used. Fails if the name is already taken.',
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Sheet name (must be unique)" } },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "list_sheets":
      return toolJson({ sheets: await getSheets() });
    case "add_sheet": {
      if (args.name !== undefined && typeof args.name !== "string") {
        return toolError(`invalid sheet name: ${String(args.name)}`);
      }
      const result = await createSheet(args.name);
      if (!result.ok) return toolError(`could not create sheet: ${result.error}`);
      return toolJson({ sheet: result.sheet });
    }
    case "get_cell": {
      const sheet = await resolveSheet(args.sheet);
      if ("error" in sheet) return toolError(sheet.error);
      const id = typeof args.id === "string" ? args.id.trim().toUpperCase() : "";
      if (!parseCellId(id)) return toolError(`invalid cell id: ${String(args.id)}`);
      const { rawById, valueOf } = await evaluatedCells(sheet.id);
      const raw = rawById.get(id);
      return toolJson({ id, raw: raw ?? null, value: raw === undefined ? "" : valueOf(id) });
    }
    case "get_range": {
      const sheet = await resolveSheet(args.sheet);
      if ("error" in sheet) return toolError(sheet.error);
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
      const { rawById, valueOf } = await evaluatedCells(sheet.id);
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
      const sheet = await resolveSheet(args.sheet);
      if ("error" in sheet) return toolError(sheet.error);
      const cells = parseMutationPayload({ cells: args.cells });
      if (!cells) {
        return toolError(
          'invalid cells payload: expected [{id: "A1", raw: "..."}] with valid cell ids',
        );
      }
      const changes = await applyCellMutations(cells, sheet.id, "mcp");
      return toolJson({ applied: changes.length });
    }
    case "get_snapshot": {
      const sheet = await resolveSheet(args.sheet);
      if ("error" in sheet) return toolError(sheet.error);
      const { rawById, valueOf } = await evaluatedCells(sheet.id);
      const cells = [...rawById.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([id, raw]) => ({ id, raw, value: valueOf(id) }));
      return toolJson({ cells });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const body = await readBody(req).catch(() => undefined);
  const server = new Server(
    { name: "tanstack-spreadsheet", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callTool(request.params.name, request.params.arguments ?? {});
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

async function handleStream(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Whole-DB snapshot: the EventSource auto-reconnect relies on this resend to
  // resync every per-sheet collection over the single shared stream.
  const sheets = await getSheets();
  const bySheet: Record<string, { cells: Array<CellRow>; widths: Record<string, number> }> = {};
  for (const sheet of sheets) {
    const [cells, widths] = await Promise.all([getCells(sheet.id), getWidths(sheet.id)]);
    bySheet[sheet.id] = { cells, widths };
  }
  sendEvent(res, "snapshot", { sheets, bySheet });

  const onCells = (sheet: string, changes: unknown) => sendEvent(res, "cells", { sheet, changes });
  const onMeta = (sheet: string, nextWidths: unknown) =>
    sendEvent(res, "meta", { sheet, widths: nextWidths });
  const onSheets = (nextSheets: Array<Sheet>) => sendEvent(res, "sheets", { sheets: nextSheets });
  dbEvents.on("cells", onCells);
  dbEvents.on("meta", onMeta);
  dbEvents.on("sheets", onSheets);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    dbEvents.off("cells", onCells);
    dbEvents.off("meta", onMeta);
    dbEvents.off("sheets", onSheets);
  });
}

// --- plugin ------------------------------------------------------------------

/** Reply 404 unless the sheet exists; true means the caller may proceed. */
async function requireSheet(res: ServerResponse, sheet: string): Promise<boolean> {
  if (await sheetExists(sheet)) return true;
  sendJson(res, 404, { error: `unknown sheet: ${sheet}` });
  return false;
}

function sendSheetOpError(res: ServerResponse, error: SheetOpError) {
  sendJson(res, SHEET_OP_STATUS[error], { error });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const { pathname, searchParams } = new URL(req.url ?? "", "http://localhost");
  const method = req.method ?? "GET";

  if (pathname.startsWith("/api/auth/") || isDiscoveryPath(pathname)) {
    await authHandler(req, res);
    return true;
  }
  if (pathname === "/mcp") {
    if (await requireMcpToken(req, res)) await handleMcp(req, res);
    return true;
  }
  // Everything below is the signed-in user's own data.
  if (pathname.startsWith("/api/") && !(await requireSession(req, res))) return true;
  if (pathname === "/api/stream" && method === "GET") {
    await handleStream(req, res);
    return true;
  }
  if (pathname === "/api/cells" && method === "GET") {
    const sheet = searchParams.get("sheet") ?? DEFAULT_SHEET;
    if (!(await requireSheet(res, sheet))) return true;
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
    const sheet = sheetOf(body);
    if (!(await requireSheet(res, sheet))) return true;
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
    const sheet = sheetOf(body);
    if (!(await requireSheet(res, sheet))) return true;
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
    const sheet = searchParams.get("sheet") ?? DEFAULT_SHEET;
    if (!(await requireSheet(res, sheet))) return true;
    sendJson(res, 200, await historyState(sheet, client));
    return true;
  }
  if (pathname === "/api/meta" && method === "GET") {
    const sheet = searchParams.get("sheet") ?? DEFAULT_SHEET;
    if (!(await requireSheet(res, sheet))) return true;
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
    const sheet = sheetOf(body);
    if (!(await requireSheet(res, sheet))) return true;
    await setWidths(widths as Record<string, number>, sheet);
    sendJson(res, 200, { ok: true });
    return true;
  }
  if (pathname === "/api/sheets" && method === "GET") {
    sendJson(res, 200, { sheets: await getSheets() });
    return true;
  }
  if (pathname === "/api/sheets" && method === "POST") {
    const body = (await readBody(req).catch(() => null)) as { name?: unknown } | null;
    if (body?.name !== undefined && typeof body.name !== "string") {
      sendJson(res, 400, { error: "invalid sheet name" });
      return true;
    }
    const result = await createSheet(body?.name);
    if (!result.ok) sendSheetOpError(res, result.error);
    else sendJson(res, 200, { sheet: result.sheet });
    return true;
  }
  if (pathname.startsWith("/api/sheets/")) {
    const id = decodeURIComponent(pathname.slice("/api/sheets/".length));
    if (method === "PATCH") {
      const body = (await readBody(req).catch(() => null)) as { name?: unknown } | null;
      if (typeof body?.name !== "string") {
        sendJson(res, 400, { error: "invalid sheet name" });
        return true;
      }
      const result = await renameSheet(id, body.name);
      if (!result.ok) sendSheetOpError(res, result.error);
      else sendJson(res, 200, { sheet: result.sheet });
      return true;
    }
    if (method === "DELETE") {
      const result = await deleteSheet(id);
      if (!result.ok) sendSheetOpError(res, result.error);
      else sendJson(res, 200, { ok: true });
      return true;
    }
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
