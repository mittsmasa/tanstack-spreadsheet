// Secrets set with `wrangler secret put` (production) or .dev.vars (local).
// `wrangler types` only emits them when .dev.vars exists, so they are declared
// here as well to keep type-check green on a fresh checkout and in CI.
//
// GOOGLE_OAUTH_EMULATOR_URL exists only in .dev.vars (scripts/dev-vars.sh); it
// is never set in production, so it is undefined there despite the type.
interface Env {
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_OAUTH_EMULATOR_URL: string;
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_OAUTH_EMULATOR_URL: string;
  }
}
