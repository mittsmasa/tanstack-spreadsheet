import { createFileRoute } from "@tanstack/react-router";

import LoginScreen from "#/components/LoginScreen";
import Spreadsheet from "#/components/Spreadsheet";
import { useSession } from "#/lib/auth-client";

export const Route = createFileRoute("/")({
  // cell data lives in localStorage, so render client-side only to avoid
  // hydration mismatches against the empty server-side fallback storage
  ssr: false,
  component: Home,
});

function Home() {
  const { data: session, isPending } = useSession();
  // Hold the blank background until the session is known: mounting the sheet
  // first would start the fetches and the SSE stream that the server rejects
  // with 401 for a signed-out visitor.
  if (isPending) return <div className="h-dvh bg-[var(--bg-base)]" />;
  if (!session) return <LoginScreen />;
  return <Spreadsheet />;
}
