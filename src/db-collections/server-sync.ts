// Single shared SSE connection to the dev server's /api/stream.
// Both collections (cells, sheet-meta) subscribe here so each tab keeps one
// EventSource, not one per collection (browsers cap SSE connections per host).
//
// The server sends a full snapshot on (re)connect, then incremental change
// batches. The last snapshot is cached so a subscriber that arrives after the
// connection opened still gets its initial state.

export type CellChange =
  | { type: "insert" | "update"; id: string; raw: string }
  | { type: "delete"; id: string };

export type Snapshot = {
  cells: Array<{ id: string; raw: string }>;
  widths: Record<string, number>;
};

export type SyncSubscriber = {
  onSnapshot?: (snapshot: Snapshot) => void;
  onCellChanges?: (changes: Array<CellChange>) => void;
  onWidths?: (widths: Record<string, number>) => void;
};

const subscribers = new Set<SyncSubscriber>();
let source: EventSource | null = null;
let lastSnapshot: Snapshot | null = null;

function connect() {
  source = new EventSource("/api/stream");
  source.addEventListener("snapshot", (event) => {
    lastSnapshot = JSON.parse((event as MessageEvent).data) as Snapshot;
    for (const sub of subscribers) sub.onSnapshot?.(lastSnapshot);
  });
  source.addEventListener("cells", (event) => {
    const { changes } = JSON.parse((event as MessageEvent).data) as {
      changes: Array<CellChange>;
    };
    for (const sub of subscribers) sub.onCellChanges?.(changes);
  });
  source.addEventListener("meta", (event) => {
    const { widths } = JSON.parse((event as MessageEvent).data) as {
      widths: Record<string, number>;
    };
    for (const sub of subscribers) sub.onWidths?.(widths);
  });
  // EventSource reconnects on its own; the server then resends a snapshot,
  // which subscribers treat as truncate + rewrite.
}

/** Browser only — callers must not subscribe during SSR. */
export function subscribeServerSync(subscriber: SyncSubscriber): () => void {
  subscribers.add(subscriber);
  if (!source) connect();
  else if (lastSnapshot) subscriber.onSnapshot?.(lastSnapshot);
  return () => {
    subscribers.delete(subscriber);
  };
}
