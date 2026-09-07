// Vite plugin that serves a Google OAuth emulator (@emulators/google) from the
// dev server's own origin, under /emulate/google/*. Local sign-in then never
// leaves localhost: the Worker sends the browser to the emulator's account
// picker, and exchanges the code against the emulator's token endpoint.
//
// The emulator runs in the Vite (Node) process, not in workerd: @emulators/core
// imports node's fs / http / path directly. The middleware is registered in the
// configureServer pre-hook, which runs before the Cloudflare plugin's Worker
// dispatch (that one is added from its post-hook), so /emulate/* never reaches
// the Worker. `apply: "serve"` keeps all of this out of `vite build`.
//
// The Worker side reads GOOGLE_OAUTH_EMULATOR_URL from .dev.vars (written by
// scripts/dev-vars.sh) and points Better Auth at these routes; see
// server/auth-options.ts. No OAuth client is seeded, so the emulator accepts
// whatever client_id / redirect_uri the Worker sends — local only, nothing to
// keep in sync.

import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { createAdapterRuntime } from "@emulators/core";
import * as google from "@emulators/google";
import type { Connect, Plugin } from "vite";

export const EMULATOR_MOUNT_PATH = "/emulate";

/** Accounts offered by the emulator's picker. Two, so owner isolation can be tried locally. */
export const EMULATOR_USERS = [
  { email: "dev@example.com", name: "Dev User", given_name: "Dev", family_name: "User" },
  { email: "alice@example.com", name: "Alice", given_name: "Alice", family_name: "Example" },
];

export function googleOAuthEmulator(): Plugin {
  return {
    name: "google-oauth-emulator",
    apply: "serve",
    configureServer(server) {
      const runtime = createAdapterRuntime(
        {
          services: {
            google: {
              emulator: google,
              seed: { users: EMULATOR_USERS.map((u) => ({ ...u, email_verified: true })) },
            },
          },
        },
        (mountPath, service) => `${mountPath}/${service}`,
      );

      server.middlewares.use(EMULATOR_MOUNT_PATH, (req, res, next) => {
        void handle(runtime, req, res).catch(next);
      });

      server.config.logger.info(
        `google oauth emulator mounted at ${EMULATOR_MOUNT_PATH}/google (users: ${EMULATOR_USERS.map((u) => u.email).join(", ")})`,
      );
    },
  };
}

type IncomingMessage = Connect.IncomingMessage;
type Runtime = ReturnType<typeof createAdapterRuntime>;

/** Bridges Node's request / response objects to the emulator's fetch-style handler. */
async function handle(runtime: Runtime, req: IncomingMessage, res: ServerResponse) {
  // connect strips the mount path from req.url; the segments below the mount
  // are what the runtime routes on ("google", then the emulator's own path)
  const url = new URL(
    req.originalUrl ?? req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const segments = (req.url ?? "/").split("?")[0]!.split("/").filter(Boolean);

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const request = new Request(url, {
    method: req.method,
    headers: nodeHeaders(req),
    ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
  } as RequestInit);

  const response = await runtime.handle(request, segments, EMULATOR_MOUNT_PATH);

  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    res.setHeader(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length) res.setHeader("set-cookie", cookies);
  res.end(Buffer.from(await response.arrayBuffer()));
}

function nodeHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  return headers;
}
