// Book CRUD against the dev server + the client-side mirror of the book list.
// There is no react-db collection here — the list is small, changes are rare,
// and the server broadcasts the full list on every change, so an atom fed by
// the shared SSE stream is enough.
//
// fetchBooks is the one call that does not go through the stream: the index
// route needs a book id before it can point the stream anywhere.

import { subscribeBooksList } from "#/db-collections/server-sync";
import { booksAtom } from "#/lib/sheet-store";

import type { BookInfo } from "#/db-collections/server-sync";

/** The signed-in user's books, or null when the request fails (offline, 401). */
export async function fetchBooks(): Promise<Array<BookInfo> | null> {
  try {
    const res = await fetch("/api/books");
    if (!res.ok) return null;
    const body = (await res.json()) as { books?: Array<BookInfo> };
    return body.books ?? [];
  } catch {
    return null;
  }
}

export async function createBookApi(name?: string): Promise<BookInfo | null> {
  try {
    const res = await fetch("/api/books", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(name === undefined ? {} : { name }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { book?: BookInfo };
    return body.book ?? null;
  } catch {
    return null;
  }
}

export async function renameBookApi(id: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/books/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteBookApi(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/books/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok;
  } catch {
    return false;
  }
}

let started = false;

/** Mirror the server's book list into booksAtom (browser only, idempotent).
 * The stream carries the whole list on every change, so another tab creating,
 * renaming or deleting a book shows up here without a refetch. */
export function initBooksSync() {
  if (started || typeof window === "undefined") return;
  started = true;
  subscribeBooksList((books) => booksAtom.set(books));
}
