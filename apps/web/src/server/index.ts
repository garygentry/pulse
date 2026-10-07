// src/server/index.ts — the process entry.
//
// Built to dist/server/index.js (the image CMD). Mirrors the agent/prober idiom: a `main()` that
// wires the pieces, an `import.meta.main` guard so tests import the router/loop without binding the
// real port, and a `Bun.serve` that begins serving immediately so probes/polls never race the first
// refresh cycle. A ConfigError at startup is fatal (crash-fast + red healthcheck).

import { loadProposalSecret, loadServerConfig } from "./config.js";
import { buildWriteRuntime, type WriteRuntime } from "./mutations/bootstrap.js";
import { createFetchHandler } from "./router.js";
import { createServerRuntime, type ServerRuntime } from "./refresh.js";
import { log } from "./log.js";
import { LISTEN_PORT } from "../shared/constants.js";
import { ConfigError } from "../shared/errors.js";

/**
 * Process entrypoint. Parses the env contract into a {@link ServerConfig} (hard-failing on a missing
 * engine/model var), constructs the shared runtime (source clients + the mutable
 * `ServerContext` holder), starts `Bun.serve` on the fixed {@link LISTEN_PORT} (8080) so requests are
 * served before the first refresh completes, then kicks the 10s refresh loop.
 *
 * In auth mode `proxy-header` it first builds the write runtime (buildWriteRuntime) — the single construction site
 * for every write object — and injects its dispatcher into the router. In auth mode `none` nothing
 * write-related is constructed and the router keeps its M1 default (every non-GET → 405).
 */
export async function main(): Promise<void> {
  let runtime: ServerRuntime;
  let write: WriteRuntime | null = null;
  try {
    const config = loadServerConfig(); // throws ConfigError on a missing required engine/model var
    if (config.identity.mode === "proxy-header") {
      write = await buildWriteRuntime(config, { secret: loadProposalSecret(process.env) });
    }
    // builds source clients (03) + the mutable state holder; the write runtime adds ackStore/onSlowCycle
    runtime = createServerRuntime(config, write?.runtimeDeps ?? {});
    write?.attachRuntime(runtime);
  } catch (err) {
    if (err instanceof ConfigError) {
      log({ event: "server_started", ok: false, error: `${err.code}: ${err.message}`, envVar: err.envVar });
      console.error(`FATAL ${err.code}: ${err.message} (${err.envVar})`);
      process.exit(1); // → failed container healthcheck, never a silent stop
    }
    throw err;
  }

  // Serve immediately — the router reads the CURRENT context each request (snapshot may be null
  // until the first cycle completes; §4.2). The browser only ever reaches this origin (REQ-PKG-05).
  // Production supplies the Bun request services: the direct peer IP (trusted-proxy checks) and the
  // per-request timeout escape used only by `/api/events` (05 §4).
  const handler =
    write === null
      ? createFetchHandler(runtime) // none mode: M1 default dispatchMutation → null → 405
      : createFetchHandler(runtime, undefined, write.dispatcher);
  const server = Bun.serve({
    port: LISTEN_PORT,
    fetch: (request): Promise<Response> =>
      handler(request, {
        peerIp: server.requestIP(request)?.address ?? null,
        disableTimeout: () => server.timeout(request, 0),
      }),
  });
  log({
    event: "server_started",
    ok: true,
    port: LISTEN_PORT,
    version: runtime.getContext(null).snapshot?.appVersion ?? null,
  });

  // Prime the model + one refresh cycle, then loop on REFRESH_INTERVAL_MS. The loop never throws
  // across its boundary (§6.1), so a source failure or a bad model can never kill the process.
  await runtime.start();
}

// Bun runs this file directly as the container CMD (Dockerfile). The guard means importing
// `createFetchHandler` / `createServerRuntime` in a test does NOT start the server (prober idiom).
if (import.meta.main) {
  await main();
}
