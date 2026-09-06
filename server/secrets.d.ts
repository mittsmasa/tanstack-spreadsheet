// Secrets set with `wrangler secret put` (production) or .dev.vars (local).
// `wrangler types` only emits them when .dev.vars exists, so they are declared
// here as well to keep type-check green on a fresh checkout and in CI.
interface Env {
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
}

declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
  }
}
