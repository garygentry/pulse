// apps/web/tests/browser/csp-server.ts — the server process behind tests/browser/csp.test.ts. NOT a
// test file.
//
// Composes the PRODUCTION router and asset loader over a built client directory (argv[2]), the way
// `src/server/index.ts` does in auth mode `proxy-header`, so the write path's dialogs are reachable:
// loadServerConfig → buildWriteRuntime → createServerRuntime → createFetchHandler(…, write.dispatcher).
// The estate is the reference bundle copied to a temp dir with three findings added (same bundleId),
// so the Findings tab renders its Radix Select filters. The engine is the dev loop's in-process mock
// (`degraded-mix`), plus two read endpoints the mock does not serve, so every surface the suite opens
// has data to draw:
//   • Alertmanager `GET /api/v2/silences` — one active silence (the Silences tab's Expire action);
//   • VictoriaMetrics `/api/v1/query_range` — one smooth series (the uPlot charts on Engine and in
//     the Timeline detail).
// It runs as its own process so the write path's module-level providers never leak into the shared
// `bun test` process. Prints `csp-server listening on http://127.0.0.1:<port>` once bound.

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadStaticAssets } from "../../src/server/assets.js";
import { loadProposalSecret, loadServerConfig } from "../../src/server/config.js";
import { createMockEngine, MOCK_ENV } from "../../src/server/dev/mock-engine.js";
import { DEV_DEFAULT_ESTATE_MODEL } from "../../src/server/dev/protocol.js";
import { buildWriteRuntime } from "../../src/server/mutations/bootstrap.js";
import { createServerRuntime } from "../../src/server/refresh.js";
import { createFetchHandler } from "../../src/server/router.js";
import { makeWebFindingsArtifact } from "../factories/estate-bundle.js";

/** The identity header the suite's browser context sends; loopback is the trusted proxy. */
export const CSP_SERVER_IDENTITY_HEADER = "Remote-User" as const;

/** The line the parent waits for; the URL follows it. */
export const CSP_SERVER_LISTENING = "csp-server listening on " as const;

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

async function main(): Promise<void> {
  const clientDir = process.argv[2];
  if (clientDir === undefined) throw new Error("usage: bun csp-server.ts <client-dir>");

  const mock = await createMockEngine({ scenario: "degraded-mix", startedAt: Date.parse("2026-01-01T12:00:00Z") });
  const now = Date.now();
  const silence = {
    id: "csp-silence-1",
    status: { state: "active" },
    updatedAt: new Date(now - 3_600_000).toISOString(),
    comment: "Planned maintenance window",
    createdBy: "csp-suite",
    startsAt: new Date(now - 3_600_000).toISOString(),
    endsAt: new Date(now + 3_600_000).toISOString(),
    matchers: [{ name: "alertname", value: "HostDown", isRegex: false, isEqual: true }],
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.pathname === "/api/v2/silences" && method === "GET") return Response.json([silence]);
    if (url.pathname === "/api/v1/query_range") {
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      const step = Math.max(1, Number(url.searchParams.get("step")));
      const values: [number, string][] = [];
      for (let t = start; t <= end && values.length < 2_000; t += step) {
        values.push([t, String(Math.round(50 + 40 * Math.sin(t / 900)))]);
      }
      return Response.json({ status: "success", data: { resultType: "matrix", result: [{ metric: {}, values }] } });
    }
    return mock.fetchImpl(input, init);
  }) as typeof fetch;

  // The reference bundle, with findings (the Findings tab's filters only render when there are some).
  const estateDir = mkdtempSync(join(tmpdir(), "pulse-csp-estate-"));
  const sourceDir = resolve(REPO_ROOT, DEV_DEFAULT_ESTATE_MODEL, "..");
  for (const name of ["web-estate-model.json", "web-coverage.json"]) copyFileSync(join(sourceDir, name), join(estateDir, name));
  const { bundleId } = JSON.parse(readFileSync(join(sourceDir, "web-findings.json"), "utf8")) as { bundleId: string };
  const findings = makeWebFindingsArtifact(bundleId as Parameters<typeof makeWebFindingsArtifact>[0]);
  writeFileSync(join(estateDir, "web-findings.json"), JSON.stringify(findings));

  const env = {
    ...process.env,
    ...MOCK_ENV,
    PULSE_WEB_ESTATE_MODEL: join(estateDir, "web-estate-model.json"),
    PULSE_WEB_AUTH_MODE: "proxy-header",
    PULSE_WEB_AUTH_HEADER: CSP_SERVER_IDENTITY_HEADER,
    PULSE_WEB_TRUSTED_PROXIES: "127.0.0.1/32",
    PULSE_WEB_DATA_DIR: mkdtempSync(join(tmpdir(), "pulse-csp-data-")),
    PULSE_PROPOSAL_SECRET: "csp-suite-proposal-secret-0123456789abcdef",
  };
  const config = loadServerConfig(env);
  const write = await buildWriteRuntime(config, { secret: loadProposalSecret(env), fetchImpl });
  const runtime = createServerRuntime(config, { ...write.runtimeDeps, fetchImpl });
  write.attachRuntime(runtime);
  const handler = createFetchHandler(runtime, loadStaticAssets(clientDir), write.dispatcher);
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request): Promise<Response> =>
      handler(request, {
        peerIp: server.requestIP(request)?.address ?? null,
        disableTimeout: () => server.timeout(request, 0),
      }),
  });
  await runtime.runOnce(); // publish one cycle before the browser asks for anything
  process.stdout.write(`${CSP_SERVER_LISTENING}http://127.0.0.1:${server.port}\n`);
  process.once("SIGTERM", () => process.exit(0));
}

if (import.meta.main) await main();
