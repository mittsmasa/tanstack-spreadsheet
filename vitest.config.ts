// Three test projects, told apart by file name:
//   node       *.test.ts            pure functions and store logic, plain node
//   db         *.db.test.ts         server/db.ts against an in-memory libsql
//   storybook  *.stories.tsx        component stories + play functions in chromium
//
// Deliberately not extending vite.config.ts: that config imports the server
// plugin, which imports server/db.ts, which opens the SQLite file on load.
// Loading it just to run tests would create data/spreadsheet.db as a side
// effect. Only the plugins the browser project needs are listed here.

import path from "node:path";
import { fileURLToPath } from "node:url";

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
        test: {
          name: "db",
          environment: "node",
          include: ["src/**/*.db.test.ts", "server/**/*.db.test.ts"],
          // vitest isolates each test file in a fresh module graph, so every
          // file gets its own empty in-memory database
          env: { LIBSQL_URL: ":memory:" },
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
