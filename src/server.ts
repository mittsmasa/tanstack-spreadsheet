// Worker entry. /api and /mcp are answered here before anything reaches the
// TanStack Start handler, which serves the app shell and client assets.

import handler from "@tanstack/react-start/server-entry";

import { handleApi } from "../server/api";

export { SyncHub } from "../server/sync-hub";

export default {
  async fetch(request) {
    try {
      const response = await handleApi(request);
      if (response) return response;
    } catch (error) {
      console.error(error);
      return Response.json({ error: String(error) }, { status: 500 });
    }
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
