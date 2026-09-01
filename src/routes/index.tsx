import { useEffect, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import LoginScreen from "#/components/LoginScreen";
import { createBookApi, fetchBooks } from "#/db-collections/books";
import { useSession } from "#/lib/auth-client";

export const Route = createFileRoute("/")({
  // the redirect below depends on the client-side session, so there is nothing
  // meaningful to render on the server
  ssr: false,
  component: Home,
});

// "/" stays the sign-in screen — Better Auth's mcp plugin points its loginPage
// here, and LoginScreen is what resumes a paused MCP client authorization. For
// a signed-in visitor it is just the doorway to their first book.
function Home() {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void (async () => {
      const books = await fetchBooks();
      if (cancelled) return;
      // a brand-new account owns nothing yet; give it a book to land in
      const target = books === null ? null : (books[0] ?? (await createBookApi()));
      if (cancelled) return;
      if (!target) {
        setFailed(true);
        return;
      }
      void navigate({ to: "/b/$bookId", params: { bookId: target.id }, replace: true });
    })();
    return () => {
      cancelled = true;
    };
  }, [session, navigate]);

  // Hold the blank background until the session is known: mounting the sheet
  // first would start the fetches and the SSE stream that the server rejects
  // with 401 for a signed-out visitor.
  if (isPending) return <div className="h-dvh bg-[var(--bg-base)]" />;
  if (!session) return <LoginScreen />;
  if (failed) {
    return (
      <div className="flex h-dvh items-center justify-center bg-[var(--bg-base)] px-4">
        <div className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--surface)] px-6 py-7">
          <h1 className="text-sm font-bold tracking-tight text-[var(--palm)]">
            ブックを開けませんでした
          </h1>
          <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
            サーバーに接続できませんでした。再読み込みしてください。
          </p>
        </div>
      </div>
    );
  }
  return <div className="h-dvh bg-[var(--bg-base)]" />;
}
