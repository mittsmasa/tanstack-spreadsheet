// Config for `pnpm auth:generate` only. The Better Auth CLI needs a live
// Kysely-compatible database to produce SQL, so it gets an in-memory SQLite
// from node:sqlite; the Worker itself never imports this file.

import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";

import { authOptions } from "./auth-options";

export const auth = betterAuth({
  ...authOptions({
    baseURL: "http://localhost:3210",
    google: { clientId: "cli", clientSecret: "cli" },
  }),
  database: new DatabaseSync(":memory:"),
});
