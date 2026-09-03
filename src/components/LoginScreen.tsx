import { useState } from "react";

import LoginScreenView from "#/components/LoginScreenView";
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

  return <LoginScreenView error={error} onSignIn={() => void signInWithGoogle()} />;
}
