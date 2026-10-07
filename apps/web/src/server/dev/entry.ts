// src/server/dev/entry.ts — the dev composition root (the child of scripts/dev.ts).
//
// Composes the PRODUCTION runtime, router, and asset loader with dev-only deps: an injected mock
// fetch, a manifest-re-reading asset loader, the appVersion build-id stamp, and one extra route
// (`/__dev/build-id`). One shell contract, one injection path (CON-07); never imported by
// `src/server/index.ts` and never imports anything under `scripts/**` (REQ-DEV-12; enforced by
// `tests/prod-isolation.test.ts`, spec 01 §6.1 rule 4).

import { loadServerConfig } from "../config.js";
import { createFetchHandler } from "../router.js";
import { createServerRuntime, type ServerRuntime } from "../refresh.js";
import { loadStaticAssets, type StaticAssets } from "../assets.js";
import { log } from "../log.js";
import { ConfigError } from "../../shared/errors.js";
import { WEB_APP_VERSION } from "../../version.js";
import { createMockEngine, MOCK_ENV, type MockEngine } from "./mock-engine.js";
import { MockScenarioError } from "./scenario.js";
import {
  DEV_ENV,
  DEV_BUILD_ID_PATH,
  type DevBuildIdResponse,
  type DevServerListeningEvent,
} from "./protocol.js";

/** Mirrors `DEV_EXIT.usage` from `scripts/dev.ts` (00 §2.1). `src/**` must never import from
 *  `scripts/**` (01 §6.1 rule 4), so the literal is redeclared here. `tests/dev-loop.test.ts` pins
 *  the two to each other through the observed child exit code. */
const EXIT_USAGE = 2;
/** Mirrors `DEV_EXIT.failure`. Matches `index.ts:30` fatality on `ConfigError`. */
const EXIT_FAILURE = 1;

/**
 * Dev composition root. Reads the supervisor-set env, builds the mock engine (fail-fast on an
 * unknown scenario BEFORE any port bind — REQ-MOCK-07), composes the production runtime + router
 * with the mock fetch injected, and serves `/__dev/build-id` in front of the production handler.
 * The `dev_server_listening` line is one JSON log stamped by `log()` so the supervisor and the
 * REQ-DEV-11 smoke test can discover the bound port under `--port 0`.
 */
export async function main(): Promise<void> {
  const scenario = nonEmpty(process.env[DEV_ENV.MOCK_SCENARIO]);
  const clockIso = nonEmpty(process.env[DEV_ENV.MOCK_CLOCK]);
  const clientDir = nonEmpty(process.env[DEV_ENV.CLIENT_DIR]);
  const hostname = nonEmpty(process.env[DEV_ENV.HOST]) ?? "127.0.0.1";
  const port = Number.parseInt(nonEmpty(process.env[DEV_ENV.PORT]) ?? "8080", 10);

  if (clientDir === undefined) {
    console.error(`FATAL ${DEV_ENV.CLIENT_DIR} is not set — run through: bun run dev:web`);
    process.exit(EXIT_FAILURE);
  }

  // (1) Mock engine FIRST — an unknown scenario must fail BEFORE any port bind (REQ-MOCK-07).
  //     A rejected scenario surfaces MockScenarioError with .message + .available; we print both
  //     to stderr and exit EXIT_USAGE. Env mode (no scenario) skips this block entirely.
  let mock: MockEngine | null = null;
  if (scenario !== undefined) {
    try {
      const startedAt = clockIso !== undefined ? Date.parse(clockIso) : undefined;
      mock = await createMockEngine({
        scenario,
        ...(startedAt !== undefined && !Number.isNaN(startedAt) ? { startedAt } : {}),
      });
    } catch (err) {
      if (err instanceof MockScenarioError) {
        console.error(err.message);
        if (err.available.length > 0) {
          console.error(`available scenarios: ${err.available.join(", ")}`);
        }
        process.exit(EXIT_USAGE);
      }
      throw err;
    }
  }

  // (2) Config + runtime. MOCK_ENV is merged OVER a COPY of process.env so the operator does not
  //     need to export placeholder engine URLs to run `--mock`, and process.env itself is never
  //     mutated (REQ-MOCK-08). appVersion is called per refresh cycle (CON-08) so a new build
  //     becomes visible on the NEXT snapshot; the reload path in `06-client-store.md` observes it.
  let runtime: ServerRuntime;
  let assets: StaticAssets;
  try {
    const config = loadServerConfig(mock !== null ? { ...process.env, ...MOCK_ENV } : process.env);
    assets = loadStaticAssets(clientDir, { dev: true });
    runtime = createServerRuntime(config, {
      ...(mock !== null ? { fetchImpl: mock.fetchImpl } : {}),
      appVersion: () => `${WEB_APP_VERSION}+${assets.buildId?.() ?? "nobuild"}`,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      log({
        event: "server_started",
        ok: false,
        error: `${err.code}: ${err.message}`,
        envVar: err.envVar,
      });
      console.error(`FATAL ${err.code}: ${err.message} (${err.envVar})`);
      process.exit(EXIT_FAILURE);
    }
    throw err;
  }

  // (3) Serve. `/__dev/build-id` is answered BEFORE delegating to the production handler so it
  //     never enters `ROUTES`, never gets a metrics label, and does not exist in production
  //     (REQ-DEV-12). Shell responses get `cache-control: no-store` per REQ-BUILD-05; hashed
  //     assets keep their immutable caching from `router.ts:103-108`.
  const inner = createFetchHandler(runtime, assets);
  const server = Bun.serve({
    port,
    hostname,
    fetch: async (req: Request): Promise<Response> => {
      const { pathname } = new URL(req.url);
      if (pathname === DEV_BUILD_ID_PATH) {
        const body: DevBuildIdResponse = {
          buildId: assets.buildId?.() ?? null,
          startedAt: STARTED_AT_ISO,
        };
        return new Response(JSON.stringify(body), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      const res = await inner(req);
      return isShell(res, pathname) ? withHeader(res, "cache-control", "no-store") : res;
    },
  });

  // (4) The structured listening line — one JSON line to stdout. `server.port` is the BOUND port
  //     (differs from the requested one under `--port 0`); the supervisor parses this to print
  //     its own listening line and `tests/dev-loop.test.ts` reads it to discover the port.
  const listening: DevServerListeningEvent = {
    event: "dev_server_listening",
    ok: true,
    port: server.port ?? port,
    host: hostname,
    mock: scenario ?? null,
    buildId: assets.buildId?.() ?? null,
  };
  log({ ...listening });

  // (5) SIGTERM → orderly stop → exit(0). The supervisor sends SIGTERM (then SIGKILL after the
  //     grace window) so the port is released before it spawns the replacement (REQ-DEV-13).
  const shutdown = (): void => {
    server.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  // (6) Prime one refresh + start the 10s loop, exactly as `index.ts:47`.
  await runtime.start();
}

/** A shell response: HTML that is not a hashed asset. `/assets/*` keeps its immutable caching. */
export function isShell(res: Response, pathname: string): boolean {
  return (res.headers.get("content-type")?.startsWith("text/html") ?? false)
    && !pathname.startsWith("/assets/");
}

/** Copy a Response with one extra header — a fetch-derived Response can have immutable headers. */
export function withHeader(res: Response, name: string, value: string): Response {
  const headers = new Headers(res.headers);
  headers.set(name, value);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** ISO-8601 UTC stamp of when this dev process started; lets clients detect a restart even when
 *  the buildId is unchanged (spec 00 §2.3). Frozen at module load so `/__dev/build-id` never
 *  computes a fresh timestamp per request. */
const STARTED_AT_ISO = new Date().toISOString();

/** `undefined`/`""`/whitespace → `undefined`; otherwise the trimmed value. */
function nonEmpty(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t === undefined || t === "" ? undefined : t;
}

// Same guard as `index.ts:52` — importing this module in a test must not bind a port.
if (import.meta.main) {
  await main();
}
