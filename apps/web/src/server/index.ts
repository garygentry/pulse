// src/server/index.ts — the process entry.
//
// Built to dist/server/index.js (the image CMD). Mirrors the agent/prober idiom: a `main()` that
// wires the pieces, an `import.meta.main` guard so tests import the router/loop without binding the
// real port, and a `Bun.serve` that begins serving immediately so probes/polls never race the first
// refresh cycle. A ConfigError at startup is fatal (crash-fast + red healthcheck).

import { loadProposalSecret, loadServerConfig } from "./config.js";
import { buildWriteRuntime, type WriteRuntime } from "./mutations/bootstrap.js";
import { buildPushRuntime, type PushRuntime } from "./push/bootstrap.js";
import { createFetchHandler, dispatchMutation } from "./router.js";
import { createServerRuntime, type ServerRuntime } from "./refresh.js";
import { log } from "./log.js";
import { loadStaticAssets, type StaticAssets } from "./assets.js";
import { composeAppVersion } from "./app-version.js";
import { WEB_APP_VERSION } from "../version.js";
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
 *
 * In every auth mode it builds the push runtime (buildPushRuntime), which is inert unless a PULSE_PUSH_APNS_* variable
 * is set, and passes its dispatcher to the router.
 */
export async function main(): Promise<void> {
  let runtime: ServerRuntime;
  let write: WriteRuntime | null = null;
  let push: PushRuntime;
  // The built client bundle, loaded once and shared by the router and the reload key, so a new
  // image (a new release or a rebuild of the same one) always changes `appVersion`.
  const assets: StaticAssets = loadStaticAssets();
  try {
    const config = loadServerConfig(); // throws ConfigError on a missing required engine/model var
    // Every auth mode, after the config parse and before the server runtime. Never rejects.
    push = await buildPushRuntime(config);
    if (config.identity.mode === "proxy-header") {
      write = await buildWriteRuntime(config, { secret: loadProposalSecret(process.env) });
    }
    // builds source clients (03) + the mutable state holder; the write runtime adds ackStore/onSlowCycle
    runtime = createServerRuntime(config, {
      ...(write?.runtimeDeps ?? {}),
      appVersion: () => composeAppVersion(WEB_APP_VERSION, assets.buildId?.()),
    });
    write?.attachRuntime(runtime);
    push.attachRuntime(runtime); // badge source
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
  // None mode passes the M1 default dispatchMutation (null → 405); push answers only its own paths.
  const handler = createFetchHandler(runtime, assets, write === null ? dispatchMutation : write.dispatcher, push.dispatcher);
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
