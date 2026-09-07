// Better Auth options shared by the Worker (auth.ts) and the CLI config
// (auth.cli.ts). Everything except the database goes through here so the
// generated schema matches what the Worker actually runs.

import { mcp } from "@better-auth/mcp";
import type { BetterAuthOptions } from "better-auth";
import { genericOAuth, jwt } from "better-auth/plugins";

export type AuthEnv = {
  baseURL: string;
  google: {
    clientId: string;
    clientSecret: string;
    /**
     * Base URL of a local Google OAuth emulator (scripts/google-oauth-emulator.ts),
     * e.g. http://localhost:3210/emulate/google. Set only in .dev.vars: when
     * present, Google sign-in is served by the emulator instead of Google.
     */
    emulatorUrl?: string;
  };
};

/** RFC 8707 resource identifier for the MCP endpoint; issued access tokens are
 * bound to it, and it is published in the protected resource metadata. */
export function mcpResource(baseURL: string): string {
  return `${baseURL}/mcp`;
}

export function authOptions({ baseURL, google }: AuthEnv) {
  const emulator = google.emulatorUrl ? googleEmulator(google.emulatorUrl, google) : undefined;
  return {
    baseURL,
    ...(emulator
      ? {}
      : {
          socialProviders: {
            google: {
              clientId: google.clientId,
              clientSecret: google.clientSecret,
            },
          },
        }),
    plugins: [
      ...(emulator ? [emulator] : []),
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

/**
 * The emulator registered under the same provider id as the real Google
 * provider, so the browser keeps calling signIn.social({ provider: "google" })
 * and the callback stays /api/auth/callback/google.
 *
 * The endpoints are spelled out instead of using discoveryUrl on purpose: with
 * discovery, Better Auth verifies the id_token against the advertised JWKS, and
 * the emulator signs with HS256 while publishing an empty key set. Without a
 * JWKS the plugin just decodes the id_token's sub / email — fine for a local
 * fake, never for production.
 */
function googleEmulator(url: string, google: { clientId: string; clientSecret: string }) {
  return genericOAuth({
    config: [
      {
        providerId: "google",
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        authorizationUrl: `${url}/o/oauth2/v2/auth`,
        tokenUrl: `${url}/oauth2/token`,
        userInfoUrl: `${url}/oauth2/v2/userinfo`,
        accountIssuer: url,
        scopes: ["openid", "email", "profile"],
        pkce: true,
      },
    ],
  });
}
