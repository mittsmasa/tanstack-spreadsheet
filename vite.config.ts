import { defineConfig } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { spreadsheetServer } from "./server/plugin";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // spreadsheetServer first so /api and /mcp are handled before Start's catch-all
  plugins: [spreadsheetServer(), devtools(), tailwindcss(), tanstackStart(), viteReact()],
});

export default config;
