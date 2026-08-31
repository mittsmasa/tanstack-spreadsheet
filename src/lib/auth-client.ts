// Better Auth browser client. The auth routes are served from the same origin
// by the vite plugin, so no baseURL is needed.

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { useSession, signIn, signOut } = authClient;

/**
 * The signed OAuth query when this page was reached from /oauth2/authorize
 * (the MCP client authorization flow), or null on a plain visit. Passing it
 * back as `oauth_query` lets the server resume the authorization it paused.
 */
export function pendingOAuthQuery(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("client_id") || !params.has("sig")) return null;
  return params.toString();
}
