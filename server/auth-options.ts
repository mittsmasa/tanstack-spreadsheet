// Better Auth options shared by the Worker (auth.ts) and the CLI config
// (auth.cli.ts). Everything except the database goes through here so the
// generated schema matches what the Worker actually runs.

import { mcp } from "@better-auth/mcp";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";

export type AuthEnv = {
  baseURL: string;
  google: { clientId: string; clientSecret: string };
};

/** RFC 8707 resource identifier for the MCP endpoint; issued access tokens are
 * bound to it, and it is published in the protected resource metadata. */
export function mcpResource(baseURL: string): string {
  return `${baseURL}/mcp`;
}

export function authOptions({ baseURL, google }: AuthEnv) {
  return {
    baseURL,
    socialProviders: {
      google: {
        clientId: google.clientId,
        clientSecret: google.clientSecret,
      },
    },
    plugins: [
      // mcp() signs access tokens with the JWT plugin's key and serves /jwks
      jwt(),
      mcp({
        loginPage: "/",
        consentPage: "/consent",
        resource: mcpResource(baseURL),
        // MCP clients have no pre-registered credentials, so they register
        // themselves at /api/auth/oauth2/register before the authorize step.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  } satisfies BetterAuthOptions;
}
