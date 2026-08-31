// Better Auth instance: Google sign-in for the browser, plus an OAuth 2.1
// authorization server so MCP clients can authorize interactively.
//
// The auth tables live in the same libsql database as the spreadsheet data,
// sharing db.ts's client, so a single file (or a single Turso database) still
// holds everything.

import "./env";

import { mcp } from "@better-auth/mcp";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";

import { client } from "./db";

export const BASE_URL = process.env.BETTER_AUTH_URL ?? "http://localhost:3210";

/** RFC 8707 resource identifier for the MCP endpoint; issued access tokens are
 * bound to it, and it is published in the protected resource metadata. */
export const MCP_RESOURCE = `${BASE_URL}/mcp`;

export const auth = betterAuth({
  baseURL: BASE_URL,
  database: {
    dialect: new LibsqlDialect({ client }),
    type: "sqlite",
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    },
  },
  plugins: [
    // mcp() signs access tokens with the JWT plugin's key and serves /jwks
    jwt(),
    mcp({
      loginPage: "/",
      consentPage: "/consent",
      resource: MCP_RESOURCE,
      // MCP clients have no pre-registered credentials, so they register
      // themselves at /api/auth/oauth2/register before the authorize step.
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
  ],
});
