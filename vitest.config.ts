// Three test projects, told apart by file name:
//   node       *.test.ts            pure functions and store logic, plain node
//   db         *.db.test.ts         server/db.ts against D1, inside the Workers runtime
//   storybook  *.stories.tsx        component stories + play functions in chromium
//
// Deliberately not extending vite.config.ts: that config runs the whole app
// through the Cloudflare plugin, which none of these projects need. Only the
// plugins each project needs are listed here.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.ts", "server/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
        },
      },
      {
        extends: true,
        // Runs inside workerd with a local D1. No Durable Object binding: db.ts
        // only reaches SYNC_HUB through `sync.publish`, which the tests replace.
        plugins: [
          cloudflareTest(async () => ({
            miniflare: {
              compatibilityDate: "2026-08-31",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: { DB: "tanstack-spreadsheet-test" },
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(path.join(dirname, "migrations")),
              },
            },
          })),
        ],
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts", "server/**/*.db.test.ts"],
          // applies migrations/*.sql; per-test storage isolation is the
          // plugin's default, so files never see each other's rows
          setupFiles: ["server/test/apply-migrations.ts"],
        },
      },
      {
        extends: true,
        plugins: [
          viteReact(),
          tailwindcss(),
          storybookTest({ configDir: path.join(dirname, ".storybook") }),
        ],
        test: {
          name: "storybook",
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
          // no setupFiles: since Storybook 10.3 the addon applies the preview
          // annotations (decorators, globals) to every story on its own
        },
      },
    ],
  },
});
