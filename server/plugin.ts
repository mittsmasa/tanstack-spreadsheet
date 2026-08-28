// Vite plugin hosting the whole server side of the spreadsheet:
//   GET  /api/cells            cell snapshot
//   POST /api/cells/mutations  batch cell writes (raw "" = delete)
//   GET  /api/meta             column widths
//   POST /api/meta             persist column widths
//   GET  /api/stream           SSE: initial snapshot, then change batches
//   ALL  /mcp                  MCP endpoint (streamable HTTP, stateless)
//
// Everything lives in one plugin on purpose: the Start server routes run in a
// separate module graph, so splitting the pieces would duplicate the db module
// and silently disconnect the change feed from the SSE subscribers.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { cellId, parseCellId } from "../src/lib/columns";
import { displayValue } from "../src/lib/formula";
import { applyCellMutations, dbEvents, getCells, getWidths, setWidths } from "./db";

import type { CellRow } from "./db";
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

async function evaluatedCells(): Promise<{
  rawById: Map<string, string>;
  valueOf: (id: string) => string;
}> {
  const rows = await getCells();
  const rawById = new Map(rows.map((row) => [row.id, row.raw]));
  const getRaw = (id: string) => rawById.get(id);
  return {
    rawById,
    valueOf: (id) => displayValue(id, rawById.get(id), getRaw),
  };
}

const TOOLS = [
  {
    name: "get_cell",
    description:
      'Read a single cell by "A1"-style id. Returns the raw input (formulas keep their leading "=") and the evaluated display value. Unset cells return raw: null and value: "".',
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: 'Cell id, e.g. "A1"' } },
      required: ["id"],
    },
  },
  {
    name: "get_range",
    description:
      'Read a rectangular range like "A1:C10" (a single cell id also works). Returns a row-major 2D array of {id, raw, value}.',
    inputSchema: {
      type: "object",
      properties: { range: { type: "string", description: 'Range, e.g. "A1:C10"' } },
      required: ["range"],
    },
  },
  {
    name: "set_cells",
    description:
      'Write cells in one batch. Each entry is {id, raw}; raw is the user-level input (a leading "=" makes it a formula) and an empty string deletes the cell. The whole batch is rejected if any id is invalid. Changes appear live in open browser tabs and are undoable there only for edits made in the UI, not for this tool.',
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
      },
      required: ["cells"],
    },
  },
  {
    name: "get_snapshot",
    description:
      "List every non-empty cell with its raw input and evaluated value. Useful as a full export of the sheet.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "get_cell": {
      const id = typeof args.id === "string" ? args.id.trim().toUpperCase() : "";
      if (!parseCellId(id)) return toolError(`invalid cell id: ${String(args.id)}`);
      const { rawById, valueOf } = await evaluatedCells();
      const raw = rawById.get(id);
      return toolJson({ id, raw: raw ?? null, value: raw === undefined ? "" : valueOf(id) });
    }
    case "get_range": {
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
      const { rawById, valueOf } = await evaluatedCells();
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
      const cells = parseMutationPayload({ cells: args.cells });
      if (!cells) {
        return toolError(
          'invalid cells payload: expected [{id: "A1", raw: "..."}] with valid cell ids',
        );
      }
      const changes = await applyCellMutations(cells);
      return toolJson({ applied: changes.length });
    }
    case "get_snapshot": {
      const { rawById, valueOf } = await evaluatedCells();
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
  const [cells, widths] = await Promise.all([getCells(), getWidths()]);
  sendEvent(res, "snapshot", { cells, widths });

  const onCells = (_sheet: string, changes: unknown) => sendEvent(res, "cells", { changes });
  const onMeta = (_sheet: string, nextWidths: unknown) =>
    sendEvent(res, "meta", { widths: nextWidths });
  dbEvents.on("cells", onCells);
  dbEvents.on("meta", onMeta);
  const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 30_000);
  req.on("close", () => {
    clearInterval(keepAlive);
    dbEvents.off("cells", onCells);
    dbEvents.off("meta", onMeta);
  });
}

// --- plugin ------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = (req.url ?? "").split("?")[0];
  const method = req.method ?? "GET";

  if (url === "/mcp") {
    await handleMcp(req, res);
    return true;
  }
  if (url === "/api/stream" && method === "GET") {
    await handleStream(req, res);
    return true;
  }
  if (url === "/api/cells" && method === "GET") {
    sendJson(res, 200, { cells: await getCells() });
    return true;
  }
  if (url === "/api/cells/mutations" && method === "POST") {
    const body = await readBody(req).catch(() => null);
    const cells = body === null ? null : parseMutationPayload(body);
    if (!cells) {
      sendJson(res, 400, { error: "invalid mutation payload" });
      return true;
    }
    const changes = await applyCellMutations(cells);
    sendJson(res, 200, { applied: changes.length });
    return true;
  }
  if (url === "/api/meta" && method === "GET") {
    sendJson(res, 200, { widths: await getWidths() });
    return true;
  }
  if (url === "/api/meta" && method === "POST") {
    const body = (await readBody(req).catch(() => null)) as { widths?: unknown } | null;
    const widths = body?.widths;
    if (widths === null || typeof widths !== "object" || Array.isArray(widths)) {
      sendJson(res, 400, { error: "invalid widths payload" });
      return true;
    }
    await setWidths(widths as Record<string, number>);
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
