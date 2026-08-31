// Consent screen for the OAuth authorization server: an MCP client asked for
// access, /oauth2/authorize paused the flow and sent the browser here with the
// signed authorization query. Answering posts that query back to
// /oauth2/consent, which resumes the flow and returns where to go next.

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { useSession } from "#/lib/auth-client";
import LoginScreen from "#/components/LoginScreen";

export const Route = createFileRoute("/consent")({
  ssr: false,
  component: Consent,
});

const buttonClass =
  "rounded border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-sm text-[var(--sea-ink)] transition hover:border-[var(--palm)] disabled:cursor-default disabled:opacity-40";

async function respond(accept: boolean): Promise<string> {
  const response = await fetch("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ accept, oauth_query: window.location.search.replace(/^\?/, "") }),
  });
  const body = (await response.json()) as { url?: string; message?: string };
  if (!body.url) throw new Error(body.message ?? "認可を完了できませんでした");
  return body.url;
}

function Consent() {
  const { data: session, isPending } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client_id");
  const scopes = params.get("scope")?.split(" ").filter(Boolean) ?? [];

  if (isPending) return <div className="h-dvh bg-[var(--bg-base)]" />;
  if (!session) return <LoginScreen />;

  async function answer(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      window.location.href = await respond(accept);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg-base)] px-4">
      <div className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--surface)] px-6 py-7">
        <h1 className="text-sm font-bold tracking-tight text-[var(--palm)]">アクセスを許可する</h1>
        <p className="mt-1 text-xs text-[var(--sea-ink-soft)]">
          {clientId ?? "不明なクライアント"} が {session.user.email} のシートへのアクセスを
          求めています。
        </p>
        {scopes.length > 0 && (
          <ul className="mt-3 space-y-0.5 text-xs text-[var(--sea-ink-soft)]">
            {scopes.map((scope) => (
              <li key={scope}>・{scope}</li>
            ))}
          </ul>
        )}
        <div className="mt-5 flex gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !clientId}
            onClick={() => void answer(true)}
          >
            許可する
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy || !clientId}
            onClick={() => void answer(false)}
          >
            拒否する
          </button>
        </div>
        {error && <p className="mt-3 text-xs text-[var(--sea-ink-soft)]">{error}</p>}
      </div>
    </div>
  );
}
