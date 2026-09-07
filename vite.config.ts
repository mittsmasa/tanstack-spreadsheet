import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

import { googleOAuthEmulator } from "./scripts/google-oauth-emulator.ts";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // cloudflare() first so the Start server entry (src/server.ts) runs in workerd
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    // dev only: answers /emulate/google/* in this process, before the Worker sees it
    googleOAuthEmulator(),
    devtools(),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
