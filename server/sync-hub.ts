// One Durable Object per owner (addressed by Better Auth user id) holding that
// user's live WebSocket subscribers. db.ts publishes every committed write here
// and the hub fans it out; the browser side is src/db-collections/server-sync.ts.
//
// Uses the WebSocket Hibernation API: connections survive the object being
// evicted from memory between messages, so an idle tab costs nothing. The only
// per-connection state — which book the tab is viewing — lives in the socket
// attachment, which hibernation preserves. `ping` frames are answered by the
// runtime without waking the object.
//
// The Worker (server/api.ts) authenticates the request and checks that the
// book belongs to this owner before forwarding the upgrade here.

import { DurableObject } from "cloudflare:workers";

import { getBooks, getCells, getSheets, getWidths } from "./db";

import type { CellRow, ServerEvent } from "./db";

type Attachment = { book: string };

/** Whole-book snapshot sent on (re)connect: the client treats it as a full
 * resync of every per-sheet collection, the sheet list and the book list. */
async function snapshot(owner: string, book: string) {
  const sheets = await getSheets(book);
  const bySheet: Record<string, { cells: Array<CellRow>; widths: Record<string, number> }> = {};
  for (const sheet of sheets) {
    const [cells, widths] = await Promise.all([getCells(sheet.id), getWidths(sheet.id)]);
    bySheet[sheet.id] = { cells, widths };
  }
  return { book, books: await getBooks(owner), sheets, bySheet };
}

export class SyncHub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Accept a pre-authorized upgrade for `?owner=&book=` and send the snapshot. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return Response.json({ error: "expected websocket upgrade" }, { status: 426 });
    }
    const { searchParams } = new URL(request.url);
    const owner = searchParams.get("owner");
    const book = searchParams.get("book");
    if (!owner || !book) return Response.json({ error: "missing owner or book" }, { status: 400 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ book } satisfies Attachment);
    server.send(JSON.stringify({ event: "snapshot", data: await snapshot(owner, book) }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** RPC from db.ts: deliver one event to the matching subscribers. */
  async publish(event: ServerEvent): Promise<void> {
    const message = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      if ("book" in event) {
        const { book } = ws.deserializeAttachment() as Attachment;
        if (book !== event.book) continue;
      }
      try {
        ws.send(message);
      } catch {
        // closing socket; its close event will drop it from getWebSockets()
      }
    }
  }

  // Clients only send `ping`, which the auto-response handles. Anything else
  // is ignored rather than treated as an error so a future client message
  // never tears the connection down.
  async webSocketMessage() {}

  // A peer that vanished without a close frame (dropped connection, killed
  // tab) arrives here with a socket that may already be gone, so closing it
  // is best-effort.
  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "websocket error");
    } catch {}
  }
}
