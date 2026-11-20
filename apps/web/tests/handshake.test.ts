// apps/web/tests/handshake.test.ts — the `/api/session` contract handshake, the client announcement
// headers and their bounded metric, and the `/healthz` contract field.
//
// The announcement never changes the response: every case compares the body bytes with the
// no-header request. Raw header values must not reach a metric label or a log line. No port is
// bound — `dispatch` (or the route handler) is called directly.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTRACT_VERSION, formatContractVersion } from "@pulse/web-data/contract";

import type { StaticAssets } from "../src/server/assets.js";
import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime, getRuntimeStatus, type ServerRuntime } from "../src/server/refresh.js";
import { dispatch, type RequestServices } from "../src/server/router.js";
import { __resetMetricsForTest, renderMetrics } from "../src/server/routes/metrics.js";
import { sessionRoute } from "../src/server/routes/session.js";
import type { RouteRequest, ServerContext } from "../src/shared/registry.js";

// ── Shared helpers ───────────────────────────────────────────────────────────────────────────────

/** A full required env map (four engine URLs) plus optional overrides. */
function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    ...over,
  };
}

const stubAssets: StaticAssets = {
  get: () => undefined,
  shell: () => "<!doctype html><div id=app></div>",
};

function services(peerIp: string | null): RequestServices {
  return { peerIp, disableTimeout() {} };
}

/** Build a Headers object that may repeat a name (`[name, value]` pairs are appended in order). */
function headersOf(pairs: readonly (readonly [string, string])[]): Headers {
  const h = new Headers();
  for (const [name, value] of pairs) h.append(name, value);
  return h;
}

/** Dispatch `GET /api/session` through the real router. */
async function getSession(
  headers: Headers = new Headers(),
  cfgEnv: Record<string, string | undefined> = env(),
  peerIp: string | null = null,
): Promise<{ res: Response; text: string }> {
  const runtime = createServerRuntime(loadServerConfig(cfgEnv));
  try {
    const req = new Request("http://web:8080/api/session", { method: "GET", headers });
    const res = await dispatch(req, "/api/session", runtime, stubAssets, services(peerIp));
    return { res, text: await res.text() };
  } finally {
    runtime.close();
  }
}

/** The handshake series lines currently rendered by `/metrics`. */
function handshakeSeries(): string[] {
  return renderMetrics(getRuntimeStatus(), Date.now())
    .split("\n")
    .filter((line) => line.startsWith("pulse_web_client_handshakes_total{"));
}

function series(client: string, major: string, outcome: string, count: number): string {
  return `pulse_web_client_handshakes_total{client="${client}",contract_major="${major}",outcome="${outcome}"} ${count}`;
}

afterEach(() => __resetMetricsForTest());

// ── The contract member ──────────────────────────────────────────────────────────────────────────

describe("GET /api/session carries the contract handshake", () => {
  test("contract is exactly { major, minor, capabilities } at CONTRACT_VERSION with no capabilities", async () => {
    const { res, text } = await getSession();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = JSON.parse(text) as { contract: Record<string, unknown> };
    expect(body.contract).toEqual({
      major: CONTRACT_VERSION.major,
      minor: CONTRACT_VERSION.minor,
      capabilities: [],
    });
    expect(Object.keys(body.contract).sort()).toEqual(["capabilities", "major", "minor"]);
  });

  test("the existing members are unchanged next to the new one", async () => {
    const { text } = await getSession();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["authMode", "capabilities", "contract", "identity"]);
    expect(body.identity).toBeNull();
    expect(body.authMode).toBe("none");
    expect(body.capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
  });

  test("a caller without credentials gets identity null and the contract in every auth mode", async () => {
    const proxy = env({ PULSE_WEB_AUTH_MODE: "proxy-header", PULSE_WEB_TRUSTED_PROXIES: "192.0.2.0/24" });
    const cases: readonly (readonly [Record<string, string | undefined>, string | null, Headers])[] = [
      [env(), null, new Headers()],
      // Untrusted peer presenting the identity header: resolved deny-by-default upstream.
      [proxy, "198.51.100.9", headersOf([["Remote-User", "alice"]])],
      [proxy, null, new Headers()],
    ];
    for (const [cfgEnv, peer, headers] of cases) {
      const { res, text } = await getSession(headers, cfgEnv, peer);
      expect(res.status).toBe(200);
      const body = JSON.parse(text) as { identity: unknown; contract: { major: number } };
      expect(body.identity).toBeNull();
      expect(body.contract.major).toBe(1);
    }
  });

  test("computed from in-process state only: no read of sources, history, events or cycle", async () => {
    const trap = (name: string): never =>
      new Proxy(
        {},
        {
          get: (_t, prop) => {
            throw new Error(`session handler read ctx.${name}.${String(prop)}`);
          },
        },
      ) as never;
    const ctx = {
      estate: null,
      cycle: trap("cycle"),
      history: trap("history"),
      events: trap("events"),
      sources: trap("sources"),
      config: loadServerConfig(env()),
      identity: null,
      snapshot: null,
    } satisfies Record<keyof ServerContext, unknown> as ServerContext;
    const request: RouteRequest<"/api/session"> = {
      request: new Request("http://web:8080/api/session", {
        headers: headersOf([
          ["X-Pulse-Client", "ios"],
          ["X-Pulse-Contract", "1.0"],
        ]),
      }),
      params: {},
      routePattern: "/api/session",
      peerIp: null,
      disableTimeout() {},
    };
    const res = await sessionRoute.handler(request, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { contract: { major: number } }).contract.major).toBe(1);
    expect(handshakeSeries()).toEqual([series("ios", "1", "compatible", 1)]);
  });
});

// ── Announcement handling ────────────────────────────────────────────────────────────────────────

describe("client announcement: counted in bounded labels, never changes the response", () => {
  const LONG_NAME = "a".repeat(33);
  const OVERSIZE = "x".repeat(4096);

  const rows: readonly {
    readonly name: string;
    readonly headers: readonly (readonly [string, string])[];
    readonly labels: readonly [string, string, string];
  }[] = [
    { name: "no headers", headers: [], labels: ["none", "none", "not_announced"] },
    {
      name: "ios at 1.0",
      headers: [["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "1.0"]],
      labels: ["ios", "1", "compatible"],
    },
    {
      name: "ios needing a newer minor",
      headers: [["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "1.3"]],
      labels: ["ios", "1", "server_too_old"],
    },
    {
      name: "ios-widget on the next major",
      headers: [["X-Pulse-Client", "ios-widget"], ["X-Pulse-Contract", "2.0"]],
      labels: ["ios-widget", "2", "server_too_old"],
    },
    {
      name: "ios on an older major",
      headers: [["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "0.4"]],
      labels: ["ios", "0", "client_too_old"],
    },
    {
      name: "an unknown client far ahead",
      headers: [["X-Pulse-Client", "my-tool"], ["X-Pulse-Contract", "9.0"]],
      labels: ["other", "other", "server_too_old"],
    },
    {
      name: "client without a contract header",
      headers: [["X-Pulse-Client", "ios"]],
      labels: ["ios", "none", "not_announced"],
    },
    {
      name: "client with a malformed contract header",
      headers: [["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "v1"]],
      labels: ["ios", "none", "not_announced"],
    },
    {
      name: "a client name outside the grammar",
      headers: [["X-Pulse-Client", "Bad Name!"], ["X-Pulse-Contract", "1.0"]],
      labels: ["none", "1", "compatible"],
    },
    {
      name: "a 33-character client name",
      headers: [["X-Pulse-Client", LONG_NAME], ["X-Pulse-Contract", "1.0"]],
      labels: ["none", "1", "compatible"],
    },
    {
      name: "a repeated client header",
      headers: [["X-Pulse-Client", "ios"], ["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "1.0"]],
      labels: ["none", "1", "compatible"],
    },
    {
      name: "a repeated contract header",
      headers: [["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "1.0"], ["X-Pulse-Contract", "1.0"]],
      labels: ["ios", "none", "not_announced"],
    },
    {
      name: "oversize values in both headers",
      headers: [["X-Pulse-Client", OVERSIZE], ["X-Pulse-Contract", OVERSIZE]],
      labels: ["none", "none", "not_announced"],
    },
  ];

  for (const row of rows) {
    test(`${row.name} → 200, identical body, one ${row.labels.join("/")} series`, async () => {
      const baseline = await getSession();
      __resetMetricsForTest();

      const { res, text } = await getSession(headersOf(row.headers));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(text).toBe(baseline.text);
      expect(handshakeSeries()).toEqual([series(...row.labels, 1)]);
    });
  }

  test("every session request is counted, including the web client's own", async () => {
    await getSession();
    await getSession(headersOf([["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "1.0"]]));
    await getSession(headersOf([["X-Pulse-Client", "ios"], ["X-Pulse-Contract", "1.0"]]));
    expect(handshakeSeries()).toEqual([
      series("none", "none", "not_announced", 1),
      series("ios", "1", "compatible", 2),
    ]);
  });

  test("raw announcement values reach neither the metrics text nor a log line", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const { res } = await getSession(
        headersOf([["X-Pulse-Client", "LEAK-MARKER-x"], ["X-Pulse-Contract", "LEAK.9"]]),
      );
      expect(res.status).toBe(200);
      const metrics = renderMetrics(getRuntimeStatus(), Date.now());
      expect(metrics).not.toContain("LEAK");
      expect(handshakeSeries()).toEqual([series("none", "none", "not_announced", 1)]);
      const logged = JSON.stringify([...logSpy.mock.calls, ...errSpy.mock.calls]);
      expect(logged).not.toContain("LEAK");
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// ── Bundle-error mode and /healthz ───────────────────────────────────────────────────────────────

describe("handshake in bundle-error mode, and the /healthz contract field", () => {
  let dir: string;
  let runtime: ServerRuntime | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-web-handshake-"));
    runtime = null;
  });

  afterEach(() => {
    runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function get(rt: ServerRuntime, path: string): Promise<Response> {
    const req = new Request(`http://web:8080${path}`);
    return dispatch(req, path, rt, stubAssets);
  }

  /** Every upstream is unreachable; the handshake must not depend on any of them. */
  const unreachable = (async () => new Response("upstream unreachable", { status: 502 })) as unknown as typeof fetch;

  test("normal mode: /healthz reports CONTRACT_VERSION", async () => {
    const rt = createServerRuntime(loadServerConfig(env()));
    runtime = rt;
    const res = await get(rt, "/healthz");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { contract?: string }).contract).toBe(formatContractVersion(CONTRACT_VERSION));
  });

  test("bundle-error mode: /api/session still serves the contract while /api/overview is 503", async () => {
    const modelPath = join(dir, "web-estate-model.json");
    writeFileSync(modelPath, "{ not json");
    writeFileSync(join(dir, "web-coverage.json"), "");
    writeFileSync(join(dir, "web-findings.json"), "");
    const rt = createServerRuntime(loadServerConfig(env({ PULSE_WEB_ESTATE_MODEL: modelPath })), {
      fetchImpl: unreachable,
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    runtime = rt;
    await rt.runOnce();

    const overview = await get(rt, "/api/overview");
    expect(overview.status).toBe(503);
    expect(String(((await overview.json()) as { code: unknown }).code)).toMatch(/^ESTATE_BUNDLE_/);

    const session = await get(rt, "/api/session");
    expect(session.status).toBe(200);
    const body = (await session.json()) as { contract: { major: number; minor: number; capabilities: string[] } };
    expect(body.contract).toEqual({ major: CONTRACT_VERSION.major, minor: CONTRACT_VERSION.minor, capabilities: [] });

    const health = await get(rt, "/healthz");
    expect(health.status).toBe(200);
    expect(((await health.json()) as { contract?: string }).contract).toBe(formatContractVersion(CONTRACT_VERSION));
  });
});
