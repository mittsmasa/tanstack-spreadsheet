// Single shared SSE connection to the dev server's /api/stream.
// All per-sheet collections, the sheet list and the book list subscribe here
// so each tab keeps one EventSource, not one per sheet (browsers cap SSE
// connections per host).
//
// The stream is scoped to one book: the server sends that book's snapshot on
// (re)connect ({book, books, sheets, bySheet}), then incremental change
// batches tagged with their sheet. Switching books therefore means tearing the
// connection down and opening a new one — setStreamBook does that, and the
// fresh snapshot is what resyncs every subscriber.
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

const sheetSubscribers = new Map<string, Set<SheetSyncSubscriber>>();
const listSubscribers = new Set<(sheets: Array<SheetInfo>) => void>();
const bookSubscribers = new Set<(books: Array<BookInfo>) => void>();
let source: EventSource | null = null;
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

function connect(book: string) {
  source = new EventSource(`/api/stream?book=${encodeURIComponent(book)}`);
  source.addEventListener("snapshot", (event) => {
    lastSnapshot = JSON.parse((event as MessageEvent).data) as Snapshot;
    for (const [sheet, subs] of sheetSubscribers) {
      for (const sub of subs) sub.onSnapshot?.(dataFor(sheet));
    }
    for (const sub of listSubscribers) sub(lastSnapshot.sheets);
    for (const sub of bookSubscribers) sub(lastSnapshot.books);
  });
  source.addEventListener("cells", (event) => {
    const { sheet, changes } = JSON.parse((event as MessageEvent).data) as {
      sheet: string;
      changes: Array<CellChange>;
    };
    foldCellChanges(sheet, changes);
    for (const sub of sheetSubscribers.get(sheet) ?? []) sub.onCellChanges?.(changes);
  });
  source.addEventListener("meta", (event) => {
    const { sheet, widths } = JSON.parse((event as MessageEvent).data) as {
      sheet: string;
      widths: Record<string, number>;
    };
    cachedData(sheet).widths = widths;
    for (const sub of sheetSubscribers.get(sheet) ?? []) sub.onWidths?.(widths);
  });
  source.addEventListener("sheets", (event) => {
    const { sheets } = JSON.parse((event as MessageEvent).data) as {
      sheets: Array<SheetInfo>;
    };
    if (lastSnapshot) {
      lastSnapshot.sheets = sheets;
      const alive = new Set(sheets.map((sheet) => sheet.id));
      for (const id of Object.keys(lastSnapshot.bySheet)) {
        if (!alive.has(id)) delete lastSnapshot.bySheet[id];
      }
    }
    for (const sub of listSubscribers) sub(sheets);
  });
  source.addEventListener("books", (event) => {
    const { books } = JSON.parse((event as MessageEvent).data) as { books: Array<BookInfo> };
    if (lastSnapshot) lastSnapshot.books = books;
    for (const sub of bookSubscribers) sub(books);
  });
  // EventSource reconnects on its own; the server then resends a snapshot,
  // which subscribers treat as truncate + rewrite.
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
  source?.close();
  source = null;
  if (sheetSubscribers.size > 0 || listSubscribers.size > 0 || bookSubscribers.size > 0) {
    connect(book);
  }
}

/** Open the connection on the first subscriber, once a book is known. */
function ensureConnected() {
  if (source || currentBook === null) return;
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
