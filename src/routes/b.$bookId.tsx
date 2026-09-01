import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import LoginScreen from "#/components/LoginScreen";
import Spreadsheet from "#/components/Spreadsheet";
import { fetchBooks, initBooksSync } from "#/db-collections/books";
import { setStreamBook } from "#/db-collections/server-sync";
import { initSheetsSync } from "#/db-collections/sheets";
import { useSession } from "#/lib/auth-client";
import { booksAtom, setActiveBook } from "#/lib/sheet-store";

export const Route = createFileRoute("/b/$bookId")({
  // cell data is fetched from the dev server after sign-in, so render
  // client-side only to avoid hydration mismatches against an empty shell
  ssr: false,
  component: BookRoute,
});

type Verdict = "ready" | "denied" | "error";

function BookRoute() {
  const { bookId } = Route.useParams();
  const { data: session, isPending } = useSession();
  const [checked, setChecked] = useState<{ bookId: string; verdict: Verdict } | null>(null);
  // a verdict for a different book is a stale one: navigating between books
  // reads as "loading" until the new check lands, without an effect resetting
  // state on the way in
  const state = checked?.bookId === bookId ? checked.verdict : "loading";

  // The book list doubles as the access check: a book owned by somebody else
  // is simply absent from it, the same as one that never existed. Doing this
  // before pointing the stream anywhere also seeds booksAtom, so the header
  // can name the book on the first paint.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      const books = await fetchBooks();
      if (cancelled) return;
      if (books === null) {
        setChecked({ bookId, verdict: "error" });
        return;
      }
      booksAtom.set(books);
      if (!books.some((book) => book.id === bookId)) {
        setChecked({ bookId, verdict: "denied" });
        return;
      }
      setActiveBook(bookId);
      setStreamBook(bookId);
      initBooksSync();
      initSheetsSync();
      setChecked({ bookId, verdict: "ready" });
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId, session]);

  // Hold the blank background until the session is known: mounting the sheet
  // first would start the fetches and the SSE stream that the server rejects
  // with 401 for a signed-out visitor.
  if (isPending) return <div className="h-dvh bg-[var(--bg-base)]" />;
  if (!session) return <LoginScreen />;
  if (state === "loading") return <div className="h-dvh bg-[var(--bg-base)]" />;
  if (state !== "ready") {
    return (
      <Notice
        title={state === "denied" ? "このブックは開けません" : "ブックを読み込めませんでした"}
        detail={
          state === "denied"
            ? "削除されたか、別のアカウントのブックです。"
            : "サーバーに接続できませんでした。"
        }
      />
    );
  }
  // Remount per book: every mount-scoped effect and hook below re-runs against
  // the new book, and no stale subscription can persist one book's state under
  // another's id.
  return <Spreadsheet key={bookId} />;
}

function Notice({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg-base)] px-4">
      <div className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--surface)] px-6 py-7">
        <h1 className="text-sm font-bold tracking-tight text-[var(--palm)]">{title}</h1>
        <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">{detail}</p>
        <Link
          to="/"
          className="mt-5 block w-full rounded border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-center text-sm text-[var(--sea-ink)] transition hover:border-[var(--palm)]"
        >
          自分のブックを開く
        </Link>
      </div>
    </div>
  );
}
