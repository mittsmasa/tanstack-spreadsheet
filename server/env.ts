// Loads .env into process.env for the server side.
//
// Vite only exposes .env to client code via import.meta.env; the plugin
// middleware runs in plain Node, so the auth secrets would otherwise be
// missing. Imported for its side effect before any module that reads
// process.env, because ESM evaluates imports in order.

import { existsSync } from "node:fs";

if (existsSync(".env")) process.loadEnvFile(".env");
