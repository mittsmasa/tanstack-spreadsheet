// Single shared WebSocket to the server's /api/stream.
// All per-sheet collections, the sheet list and the book list subscribe here
// so each tab keeps one connection, not one per sheet.
//
// The stream is scoped to one book: the server sends that book's snapshot on
// (re)connect ({book, books, sheets, bySheet}), then incremental change
// batches tagged with their sheet, each as a {event, data} JSON message.
// Switching books therefore means tearing the connection down and opening a
// new one — setStreamBook does that, and the fresh snapshot is what resyncs
// every subscriber.
//
// Unlike EventSource, a WebSocket does not reconnect by itself: a dropped
// connection is reopened with exponential backoff (1s → 10s), and the snapshot
// the server sends on reconnect brings every subscriber back in sync. A ping
// every 30s keeps idle connections from being closed by intermediaries.
//
// The snapshot is cached — and kept up to date by folding every change batch
// into it — so a subscriber that arrives long after the connection opened (a
// sheet switched to for the first time, or a collection restarting after gc)
// still gets the current state, not the state at connect time.

export type CellChange =
  | { type: "insert" | "update"; id: string; raw: string }
  | { type: "delete"; id: string };

export type BookInfo = { id: string; name: string };

export type SheetInfo = { id: string; name: string };

export type SheetData = {
  cells: Array<{ id: string; raw: string }>;
  widths: Record<string, number>;
};

export type SheetSyncSubscriber = {
  onSnapshot?: (data: SheetData) => void;
  onCellChanges?: (changes: Array<CellChange>) => void;
  onWidths?: (widths: Record<string, number>) => void;
};

type Snapshot = {
  book: string;
  books: Array<BookInfo>;
  sheets: Array<SheetInfo>;
  bySheet: Record<string, SheetData>;
};

type ServerMessage =
  | { event: "snapshot"; data: Snapshot }
  | { event: "cells"; data: { sheet: string; changes: Array<CellChange> } }
  | { event: "meta"; data: { sheet: string; widths: Record<string, number> } }
  | { event: "sheets"; data: { sheets: Array<SheetInfo> } }
  | { event: "books"; data: { books: Array<BookInfo> } };

declare global {
  interface Window {
    /** Dev-only handle on the live socket so tests can force a disconnect. */
    __syncWs?: WebSocket;
  }
}

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;
const PING_INTERVAL_MS = 30_000;

const sheetSubscribers = new Map<string, Set<SheetSyncSubscriber>>();
const listSubscribers = new Set<(sheets: Array<SheetInfo>) => void>();
const bookSubscribers = new Set<(books: Array<BookInfo>) => void>();
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let currentBook: string | null = null;
let lastSnapshot: Snapshot | null = null;

/** Sheets absent from the snapshot (deleted, in another book, or ids from
 * stale localStorage) sync as empty rather than erroring. */
function dataFor(sheet: string): SheetData {
  return lastSnapshot?.bySheet[sheet] ?? { cells: [], widths: {} };
}

function cachedData(sheet: string): SheetData {
  if (!lastSnapshot) return { cells: [], widths: {} };
  const existing = lastSnapshot.bySheet[sheet];
  if (existing) return existing;
  const created: SheetData = { cells: [], widths: {} };
  lastSnapshot.bySheet[sheet] = created;
  return created;
}

function foldCellChanges(sheet: string, changes: Array<CellChange>) {
  const data = cachedData(sheet);
  for (const change of changes) {
    if (change.type === "delete") {
      data.cells = data.cells.filter((cell) => cell.id !== change.id);
    } else {
      const existing = data.cells.find((cell) => cell.id === change.id);
      if (existing) existing.raw = change.raw;
      else data.cells.push({ id: change.id, raw: change.raw });
    }
  }
}

function hasSubscribers(): boolean {
  return sheetSubscribers.size > 0 || listSubscribers.size > 0 || bookSubscribers.size > 0;
}

function handleMessage(message: ServerMessage) {
  switch (message.event) {
    case "snapshot": {
      lastSnapshot = message.data;
      for (const [sheet, subs] of sheetSubscribers) {
        for (const sub of subs) sub.onSnapshot?.(dataFor(sheet));
      }
      for (const sub of listSubscribers) sub(lastSnapshot.sheets);
      for (const sub of bookSubscribers) sub(lastSnapshot.books);
      return;
    }
    case "cells": {
      const { sheet, changes } = message.data;
      foldCellChanges(sheet, changes);
      for (const sub of sheetSubscribers.get(sheet) ?? []) sub.onCellChanges?.(changes);
      return;
    }
    case "meta": {
      const { sheet, widths } = message.data;
      cachedData(sheet).widths = widths;
      for (const sub of sheetSubscribers.get(sheet) ?? []) sub.onWidths?.(widths);
      return;
    }
    case "sheets": {
      const { sheets } = message.data;
      if (lastSnapshot) {
        lastSnapshot.sheets = sheets;
        const alive = new Set(sheets.map((sheet) => sheet.id));
        for (const id of Object.keys(lastSnapshot.bySheet)) {
          if (!alive.has(id)) delete lastSnapshot.bySheet[id];
        }
      }
      for (const sub of listSubscribers) sub(sheets);
      return;
    }
    case "books": {
      const { books } = message.data;
      if (lastSnapshot) lastSnapshot.books = books;
      for (const sub of bookSubscribers) sub(books);
      return;
    }
  }
}

function scheduleReconnect(book: string) {
  if (reconnectTimer !== null) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (socket === null && currentBook === book && hasSubscribers()) connect(book);
  }, delay);
}

function connect(book: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(
    `${protocol}//${window.location.host}/api/stream?book=${encodeURIComponent(book)}`,
  );
  socket = ws;
  // oxlint-disable-next-line no-underscore-dangle -- test hook, see Window above
  if (import.meta.env.DEV) window.__syncWs = ws;
  let ping: ReturnType<typeof setInterval> | null = null;

  ws.addEventListener("open", () => {
    reconnectDelay = RECONNECT_MIN_MS;
    ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, PING_INTERVAL_MS);
  });
  ws.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "string" || event.data === "pong") return;
    handleMessage(JSON.parse(event.data) as ServerMessage);
  });
  // The close event follows every error, so a dropped connection always lands
  // here. A socket we replaced or closed on purpose (setStreamBook) is no
  // longer the current one and must not reconnect.
  ws.addEventListener("close", () => {
    if (ping !== null) clearInterval(ping);
    if (socket !== ws) return;
    socket = null;
    scheduleReconnect(book);
  });
}

function disconnect() {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const ws = socket;
  socket = null;
  ws?.close();
}

/**
 * Point the stream at a book (browser only). Called by the book route as the
 * URL changes; subscribers need no coordination because the reconnect ends in
 * a snapshot, which they already handle as a full resync. The cached snapshot
 * is dropped first so nothing reads the previous book's data in the gap.
 */
export function setStreamBook(book: string) {
  if (typeof window === "undefined" || book === currentBook) return;
  currentBook = book;
  lastSnapshot = null;
  disconnect();
  if (hasSubscribers()) connect(book);
}

/** Open the connection on the first subscriber, once a book is known. */
function ensureConnected() {
  if (socket || currentBook === null) return;
  connect(currentBook);
}

/** Browser only — callers must not subscribe during SSR. */
export function subscribeSheetSync(sheet: string, subscriber: SheetSyncSubscriber): () => void {
  let subs = sheetSubscribers.get(sheet);
  if (!subs) {
    subs = new Set();
    sheetSubscribers.set(sheet, subs);
  }
  subs.add(subscriber);
  ensureConnected();
  if (lastSnapshot) subscriber.onSnapshot?.(dataFor(sheet));
  return () => {
    subs.delete(subscriber);
    if (subs.size === 0) sheetSubscribers.delete(sheet);
  };
}

/** Browser only — callers must not subscribe during SSR. */
export function subscribeSheetsList(subscriber: (sheets: Array<SheetInfo>) => void): () => void {
  listSubscribers.add(subscriber);
  ensureConnected();
  if (lastSnapshot) subscriber(lastSnapshot.sheets);
  return () => {
    listSubscribers.delete(subscriber);
  };
}

/** Browser only — callers must not subscribe during SSR. */
export function subscribeBooksList(subscriber: (books: Array<BookInfo>) => void): () => void {
  bookSubscribers.add(subscriber);
  ensureConnected();
  if (lastSnapshot) subscriber(lastSnapshot.books);
  return () => {
    bookSubscribers.delete(subscriber);
  };
}
