// Setup for the "db" vitest project: gives every test file a schema-complete
// D1 before its tests run. The migrations array is read in vitest.config.ts
// with readD1Migrations() and handed in as the test-only TEST_MIGRATIONS
// binding, which is why it is not part of the Worker's Env type.

import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

import type { D1Migration } from "@cloudflare/vitest-plugin";

const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: Array<D1Migration> };

await applyD1Migrations(env.DB, TEST_MIGRATIONS);
