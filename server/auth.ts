// Better Auth instance: Google sign-in for the browser, plus an OAuth 2.1
// authorization server so MCP clients can authorize interactively.
//
// The auth tables live in the same D1 database as the spreadsheet data. Better
// Auth recognises the D1 binding and drives it through its bundled Kysely
// dialect (no transactions — D1 has none). Their schema is generated into
// migrations/0001_auth.sql by `pnpm auth:generate` (see auth.cli.ts).
//
// The instance is created on first use, not at module load: betterAuth()
// starts its async context initialisation immediately, and Workers forbid I/O
// (and random bytes) in the global scope, so a module-level instance would
// fail every request with "Disallowed operation called within global scope".
// The Worker isolate keeps the instance across requests once it exists.

import { env } from "cloudflare:workers";
import { betterAuth } from "better-auth";

import { authOptions, mcpResource } from "./auth-options";

export const BASE_URL: string = env.BETTER_AUTH_URL;

/** RFC 8707 resource identifier for the MCP endpoint. */
export const MCP_RESOURCE = mcpResource(BASE_URL);

function createAuth() {
  return betterAuth({
    ...authOptions({
      baseURL: BASE_URL,
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    }),
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
  });
}

export type Auth = ReturnType<typeof createAuth>;

let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}
