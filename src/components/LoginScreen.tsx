import { useState } from "react";

import { pendingOAuthQuery, signIn } from "#/lib/auth-client";

export default function LoginScreen() {
  const [error, setError] = useState<string | null>(null);

  async function signInWithGoogle() {
    setError(null);
    const oauthQuery = pendingOAuthQuery();
    const result = await signIn.social({
      provider: "google",
      callbackURL: "/",
      // resumes a paused MCP client authorization, if that is why we are here
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    });
    if (result.error) setError(result.error.message ?? "ログインに失敗しました");
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg-base)] px-4">
      <div className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--surface)] px-6 py-7">
        <h1 className="text-sm font-bold tracking-tight text-[var(--palm)]">
          tanstack-spreadsheet
        </h1>
        <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">ログインしてシートを開く</p>
        <button
          type="button"
          onClick={() => void signInWithGoogle()}
          className="mt-5 w-full rounded border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)] transition hover:border-[var(--palm)]"
        >
          Google でログイン
        </button>
        {error && <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">{error}</p>}
      </div>
    </div>
  );
}
