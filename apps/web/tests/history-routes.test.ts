// apps/web/tests/history-routes.test.ts — the four bounded-history routes (05 §§6, 8; 07).
//
// Three layers of evidence:
//   1. A recording HistoryService stub proves each route invokes the correct operation with the
//      exact target/query/range semantics and forwards the request's cancellation signal (AC-1),
//      that every bounded failure code maps to its §8 HTTP status + exact ERROR_MESSAGES text with
//      no leaked detail keys (AC-2/AC-3), and that malformed/repeated/unknown query input is
//      rejected BEFORE any service call while overload carries `Retry-After: 1` (AC-4).
//   2. A REAL `createHistoryService` (with stub VM/Gatus clients and the reference model) proves the
//      real binder/service results — success, QUERY_NOT_APPLICABLE, TARGET_NOT_FOUND,
//      RANGE_UNSUPPORTED — map end-to-end through the handlers (AC-1/AC-2).
//   3. A router-dispatch block proves the routes are wired into the registry and the router's own
//      query guard rejects a repeated key before the handler runs.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  createHistoryService,
  type AlertHistoryRequest,
  type EndpointHistoryRequest,
  type HistoryFailure,
  type HistoryRequest,
  type HistoryService,
} from "@pulse/web-data/history";
import { ERROR_MESSAGES, type ErrorEnvelope } from "@pulse/web-data/wire";
import type { GatusClient, GatusEndpointHistory, VmClient, VmRangeResult } from "@pulse/web-data/sources";
import type { SourceResult } from "@pulse/web-data/sources";
import { createGatusClient } from "@pulse/web-data/sources";
import type { WebEstateModelV2 } from "@pulse/renderer";

import type { RouteDefinition, RouteRequest, ServerContext } from "../src/shared/registry.js";
import type { ServerConfig } from "../src/server/config.js";
import {
  historyAlertsRoute,
  historyChecksRoute,
  historyEstateRoute,
  historyTargetRoute,
} from "../src/server/routes/history.js";
import { createFetchHandler, dispatch } from "../src/server/router.js";
import type { RuntimeStatus, ServerRuntime } from "../src/server/refresh.js";
import type { StaticAssets } from "../src/server/assets.js";

// Reference each route through a bare `RouteDefinition` so its handler param widens from the inferred
// literal `RouteRequest<"/api/…">` to `RouteRequest<string>`, matching the shared `routeReq` helper
// (the same pattern routes.test.ts / representations.test.ts use for direct handler calls).
const estateRoute: RouteDefinition = historyEstateRoute;
const targetRoute: RouteDefinition = historyTargetRoute;
const alertsRoute: RouteDefinition = historyAlertsRoute;
const checksRoute: RouteDefinition = historyChecksRoute;

// ── Recording HistoryService stub ────────────────────────────────────────────────────────────────

type RecordedCall =
  | { readonly op: "query"; readonly request: HistoryRequest }
  | { readonly op: "alertIntervals"; readonly request: AlertHistoryRequest }
  | { readonly op: "endpointHistory"; readonly request: EndpointHistoryRequest };

/** A HistoryService that records each call and returns one fixed result (a failure arm is assignable
 *  to every `HistoryResult<T>`, so a single failure result serves all three operations). */
function recordingHistory(result: { readonly ok: false; readonly error: HistoryFailure }): {
  readonly service: HistoryService;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const service: HistoryService = {
    query: async (request) => {
      calls.push({ op: "query", request });
      return result;
    },
    alertIntervals: async (request) => {
      calls.push({ op: "alertIntervals", request });
      return result;
    },
    endpointHistory: async (request) => {
      calls.push({ op: "endpointHistory", request });
      return result;
    },
    stats: () => ({ active: 0, queued: 0, inFlightKeys: 0, cachedKeys: 0, cachedBytes: 0, waiters: 0 }),
    invalidateModel: () => {},
    close: () => {},
  };
  return { service, calls };
}

/** A bounded history failure with the exact catalog message (mirrors what the real service emits). */
function failure(code: HistoryFailure["code"], retryAfterSeconds: number | null = null): {
  readonly ok: false;
  readonly error: HistoryFailure;
} {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code], retryAfterSeconds } };
}

/** Build a full ServerContext around a history service (other fields are unused by these handlers). */
function ctxWith(history: HistoryService): ServerContext {
  return {
    estate: null,
    cycle: null,
    history,
    events: {} as ServerContext["events"],
    sources: {} as ServerContext["sources"],
    config: {} as ServerConfig,
    identity: null,
    snapshot: null,
  };
}

/** A compiled `RouteRequest` for a direct handler call: decoded params + a real Request carrying the
 *  query string and cancellation signal the handler forwards. */
function routeReq(
  path: string,
  params: Readonly<Record<string, string>>,
  search = "",
): RouteRequest {
  const request = new Request(`http://web:8080${path}${search}`, { method: "GET" });
  return { request, params, routePattern: path, peerIp: null, disableTimeout() {} };
}

async function jsonBody(res: Response): Promise<ErrorEnvelope> {
  return (await res.json()) as ErrorEnvelope;
}

// ── AC-1: correct operation + exact target/query/range + cancellation ─────────────────────────────

describe("history routes invoke the correct operation (AC-1)", () => {
  test("estate route → query({queryId, target:null}) with the query's default range and the signal", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const req = routeReq("/api/history/estate/:queryId", { queryId: "engine.disk-usage" });
    await estateRoute.handler(req, ctxWith(service));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "query" });
    const request = (calls[0] as { request: HistoryRequest }).request;
    expect(request.queryId).toBe("engine.disk-usage");
    expect(request.target).toBeNull();
    expect(request.range).toBe("6h"); // engine.disk-usage default
    expect(request.signal).toBe(req.request.signal); // the Request's own cancellation signal is forwarded
  });

  test("estate route honours an explicit valid range", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    await estateRoute.handler(
      routeReq("/api/history/estate/:queryId", { queryId: "engine.disk-usage" }, "?range=1h"),
      ctxWith(service),
    );
    expect((calls[0] as { request: HistoryRequest }).request.range).toBe("1h");
  });

  test("target route → query with the exact host drilldown identity", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    await targetRoute.handler(
      routeReq("/api/history/target/:drilldownId/:queryId", {
        drilldownId: "host:harbor-app-02",
        queryId: "host.cpu.utilization",
      }),
      ctxWith(service),
    );
    const request = (calls[0] as { request: HistoryRequest }).request;
    expect(request.queryId).toBe("host.cpu.utilization");
    expect(request.target).toEqual({ kind: "host", id: "host:harbor-app-02" });
    expect(request.range).toBe("1h"); // host.cpu.utilization default
  });

  test("target route derives the service target kind from the query", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    await targetRoute.handler(
      routeReq("/api/history/target/:drilldownId/:queryId", {
        drilldownId: "svc:harbor-web-01/portal-web",
        queryId: "service.deep-health",
      }),
      ctxWith(service),
    );
    expect((calls[0] as { request: HistoryRequest }).request.target).toEqual({
      kind: "service",
      id: "svc:harbor-web-01/portal-web",
    });
  });

  test("target route derives the endpoint target kind from the query", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    await targetRoute.handler(
      routeReq("/api/history/target/:drilldownId/:queryId", {
        drilldownId: "harbor-web-01/portal-web",
        queryId: "endpoint.check.latency",
      }),
      ctxWith(service),
    );
    expect((calls[0] as { request: HistoryRequest }).request.target).toEqual({
      kind: "endpoint",
      id: "harbor-web-01/portal-web",
    });
  });

  test("alerts route → alertIntervals({target:null}) with the default range and the signal", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const req = routeReq("/api/history/alerts", {});
    await alertsRoute.handler(req, ctxWith(service));
    expect(calls[0]).toMatchObject({ op: "alertIntervals" });
    const request = (calls[0] as { request: AlertHistoryRequest }).request;
    expect(request.target).toBeNull();
    expect(request.range).toBe("6h"); // alerts.firing default
    expect(request.signal).toBe(req.request.signal);
  });

  test("checks route → endpointHistory({endpoint}) with the default range and the signal", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const req = routeReq("/api/history/checks/:endpoint", { endpoint: "harbor-web-01/portal-web" });
    await checksRoute.handler(req, ctxWith(service));
    expect(calls[0]).toMatchObject({ op: "endpointHistory" });
    const request = (calls[0] as { request: EndpointHistoryRequest }).request;
    expect(request.endpoint).toBe("harbor-web-01/portal-web");
    expect(request.range).toBe("24h"); // checks default
    expect(request.signal).toBe(req.request.signal);
  });
});

// ── AC-2/AC-3: failure code → HTTP status + exact message + no leaked details ─────────────────────

describe("history failure mapping (AC-2/AC-3)", () => {
  const STATUS: Readonly<Record<HistoryFailure["code"], number>> = {
    INVALID_REQUEST: 400,
    QUERY_NOT_FOUND: 404,
    TARGET_NOT_FOUND: 404,
    QUERY_NOT_APPLICABLE: 422,
    RANGE_UNSUPPORTED: 422,
    HISTORY_OVERLOADED: 503,
    SOURCE_UNAVAILABLE: 502,
    SOURCE_TIMEOUT: 504,
    HISTORY_LIMIT_EXCEEDED: 502,
    MODEL_CHANGED: 503,
    HISTORY_CANCELLED: 503,
  };

  for (const [code, status] of Object.entries(STATUS) as [HistoryFailure["code"], number][]) {
    test(`${code} → ${status} with the exact catalog message and only {code,message}`, async () => {
      const { service } = recordingHistory(failure(code));
      const res = await estateRoute.handler(
        routeReq("/api/history/estate/:queryId", { queryId: "engine.disk-usage" }),
        ctxWith(service),
      );
      expect(res.status).toBe(status);
      const body = await jsonBody(res);
      expect(body.code).toBe(code);
      expect(body.message).toBe(ERROR_MESSAGES[code]);
      // Only closed keys: the service strips binder details, so no details/PromQL/identity ever leak.
      expect(Object.keys(body).sort()).toEqual(["code", "message"]);
    });
  }

  test("overload carries Retry-After: 1 and no other leaked context", async () => {
    const { service } = recordingHistory(failure("HISTORY_OVERLOADED", 1));
    const res = await alertsRoute.handler(routeReq("/api/history/alerts", {}), ctxWith(service));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    const body = await jsonBody(res);
    expect(body.code).toBe("HISTORY_OVERLOADED");
    expect(Object.keys(body).sort()).toEqual(["code", "message"]);
  });

  test("a non-overload failure carries no Retry-After header", async () => {
    const { service } = recordingHistory(failure("SOURCE_TIMEOUT"));
    const res = await checksRoute.handler(
      routeReq("/api/history/checks/:endpoint", { endpoint: "harbor-web-01/portal-web" }),
      ctxWith(service),
    );
    expect(res.status).toBe(504);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});

// ── AC-4: malformed/repeated/unknown input rejected before any service allocation ─────────────────

describe("history input validation before allocation (AC-4)", () => {
  const REJECTED_SEARCHES = [
    "?range=5m", // malformed range value
    "?range=", // empty range value
    "?range=1h&range=6h", // repeated key
    "?foo=bar", // unknown key
    "?start=1", // client start rejected
    "?end=2", // client end rejected
    "?step=30", // client step rejected
    "?query=up", // client PromQL rejected
  ];

  for (const search of REJECTED_SEARCHES) {
    test(`estate route rejects ${JSON.stringify(search)} with 400 and no service call`, async () => {
      const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
      const res = await estateRoute.handler(
        routeReq("/api/history/estate/:queryId", { queryId: "engine.disk-usage" }, search),
        ctxWith(service),
      );
      expect(res.status).toBe(400);
      expect((await jsonBody(res)).code).toBe("INVALID_REQUEST");
      expect(calls).toHaveLength(0); // rejected BEFORE any source/history allocation
    });
  }

  test("an unknown query id is QUERY_NOT_FOUND (404) before any service call", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const res = await estateRoute.handler(
      routeReq("/api/history/estate/:queryId", { queryId: "not.a.query" }),
      ctxWith(service),
    );
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).code).toBe("QUERY_NOT_FOUND");
    expect(calls).toHaveLength(0);
  });

  test("target route also rejects an unknown query id before resolving a target", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const res = await targetRoute.handler(
      routeReq("/api/history/target/:drilldownId/:queryId", {
        drilldownId: "host:harbor-app-02",
        queryId: "not.a.query",
      }),
      ctxWith(service),
    );
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).code).toBe("QUERY_NOT_FOUND");
    expect(calls).toHaveLength(0);
  });

  test("checks route rejects an unknown query key before any service call", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const res = await checksRoute.handler(
      routeReq("/api/history/checks/:endpoint", { endpoint: "harbor-web-01/portal-web" }, "?step=1"),
      ctxWith(service),
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

// ── Real HistoryService: end-to-end binder/service result mapping (AC-1/AC-2) ─────────────────────

describe("real HistoryService result mapping", () => {
  const REFERENCE_MODEL = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "..", "..", "examples", "reference", "rendered", "web-estate-model.json"),
      "utf8",
    ),
  ) as WebEstateModelV2;

  const sourceFail: SourceResult<never> = {
    ok: false,
    error: { kind: "transport", message: "unused", status: null },
  };

  const vmRange: SourceResult<VmRangeResult> = {
    ok: true,
    data: { series: [{ metric: { __name__: "series" }, samples: [{ timestampMs: 1000, value: 5 }] }] },
  };
  const vm: VmClient = {
    statusSignals: async () => sourceFail,
    targets: async () => sourceFail,
    buildInfo: async () => sourceFail,
    queryRange: async () => vmRange,
  };

  const gatusHistory: SourceResult<GatusEndpointHistory> = {
    ok: true,
    data: {
      key: "harbor-web-01/portal-web",
      results: [{ timestamp: "2026-09-17T00:00:00.000Z", success: true, durationMs: 12, conditionResults: [] }],
    },
  };
  const gatus: GatusClient = {
    endpointStatuses: async () => sourceFail,
    endpointHistory: async () => gatusHistory,
  };

  const ctx = ctxWith(createHistoryService({ vm, gatus, model: () => REFERENCE_MODEL }));

  test("estate route serves an estate query as a direct payload (200, private/no-cache)", async () => {
    const res = await estateRoute.handler(
      routeReq("/api/history/estate/:queryId", { queryId: "engine.disk-usage" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toBeNull(); // history is not a cycle representation
    const body = (await res.json()) as { queryId: string; range: string };
    expect(body.queryId).toBe("engine.disk-usage");
    expect(body.range).toBe("6h");
  });

  test("a host query on the estate (target-null) route is QUERY_NOT_APPLICABLE (422)", async () => {
    const res = await estateRoute.handler(
      routeReq("/api/history/estate/:queryId", { queryId: "host.cpu.utilization" }),
      ctx,
    );
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).code).toBe("QUERY_NOT_APPLICABLE");
  });

  test("target route resolves a real host drilldown identity (200)", async () => {
    const res = await targetRoute.handler(
      routeReq("/api/history/target/:drilldownId/:queryId", {
        drilldownId: "host:harbor-app-02",
        queryId: "host.cpu.utilization",
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { kind: string; id: string } };
    expect(body.target).toEqual({ kind: "host", id: "host:harbor-app-02" });
  });

  describe("estate.liveness on the target route takes its kind from the captured model", () => {
    const withEstate: ServerContext = {
      ...ctx,
      estate: { model: REFERENCE_MODEL } as NonNullable<ServerContext["estate"]>,
    };

    const liveness = async (drilldownId: string): Promise<Response> =>
      targetRoute.handler(
        routeReq("/api/history/target/:drilldownId/:queryId", { drilldownId, queryId: "estate.liveness" }),
        withEstate,
      );

    test("a service drilldown id resolves as a service target (200)", async () => {
      const res = await liveness("svc:harbor-web-01/portal-web");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { target: { kind: string; id: string } };
      expect(body.target).toEqual({ kind: "service", id: "svc:harbor-web-01/portal-web" });
    });

    test("a host drilldown id resolves as a host target (200)", async () => {
      const res = await liveness("host:harbor-app-02");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { target: { kind: string; id: string } };
      expect(body.target).toEqual({ kind: "host", id: "host:harbor-app-02" });
    });

    test("an id matching neither a host nor a service is TARGET_NOT_FOUND (404)", async () => {
      const res = await liveness("svc:harbor-web-01/does-not-exist");
      expect(res.status).toBe(404);
      expect((await jsonBody(res)).code).toBe("TARGET_NOT_FOUND");
    });
  });

  test("an unknown target drilldown is TARGET_NOT_FOUND (404)", async () => {
    const res = await targetRoute.handler(
      routeReq("/api/history/target/:drilldownId/:queryId", {
        drilldownId: "host:does-not-exist",
        queryId: "host.cpu.utilization",
      }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).code).toBe("TARGET_NOT_FOUND");
  });

  test("a range beyond the query's max is RANGE_UNSUPPORTED (422)", async () => {
    const res = await targetRoute.handler(
      routeReq(
        "/api/history/target/:drilldownId/:queryId",
        { drilldownId: "host:harbor-app-02", queryId: "host.load.1m" },
        "?range=7d",
      ),
      ctx,
    );
    expect(res.status).toBe(422);
    expect((await jsonBody(res)).code).toBe("RANGE_UNSUPPORTED");
  });

  test("alerts route serves interval history (200)", async () => {
    const res = await alertsRoute.handler(routeReq("/api/history/alerts", {}), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { operation: string };
    expect(body.operation).toBe("alert-intervals");
  });

  test("checks route serves an exact endpoint's Gatus history (200)", async () => {
    const res = await checksRoute.handler(
      routeReq("/api/history/checks/:endpoint", { endpoint: "harbor-web-01/portal-web" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoint: string; provenance: string };
    expect(body.endpoint).toBe("harbor-web-01/portal-web");
    expect(body.provenance).toBe("gatus");
  });

  test("an unknown endpoint is TARGET_NOT_FOUND (404)", async () => {
    const res = await checksRoute.handler(
      routeReq("/api/history/checks/:endpoint", { endpoint: "no-such-endpoint" }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).code).toBe("TARGET_NOT_FOUND");
  });
});

// ── Router wiring: the registry dispatches these routes, and the router's query guard fires ───────

describe("router dispatch wiring", () => {
  const stubAssets: StaticAssets = {
    get: () => undefined,
    shell: () => "<!doctype html><div id=app></div>",
  };

  function runtimeWith(history: HistoryService): ServerRuntime {
    const st: RuntimeStatus = {
      sources: {
        metrics: { ok: true, lastSuccess: null, error: null },
        alerts: { ok: true, lastSuccess: null, error: null },
        checks: { ok: true, lastSuccess: null, error: null },
      },
      model: { loaded: true, formatVersion: 2, error: null },
      lastSnapshotAt: null,
    };
    return {
      getContext: () => ctxWith(history),
      identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
      getStatus: () => st,
      runOnce: async () => {},
      start: async () => {},
      close: () => {},
    };
  }

  function get(path: string): Request {
    return new Request(`http://web:8080${path}`, { method: "GET" });
  }

  test("GET /api/history/estate/:queryId is wired to the history handler", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const path = "/api/history/estate/engine.disk-usage";
    const res = await dispatch(get(path), path, runtimeWith(service), stubAssets);
    expect(res.status).toBe(502);
    expect(calls[0]?.op).toBe("query");
  });

  test("the router rejects a repeated range key (400) before the handler runs", async () => {
    const { service, calls } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const path = "/api/history/alerts";
    const res = await dispatch(get(`${path}?range=1h&range=6h`), path, runtimeWith(service), stubAssets);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("an unknown /api/history subpath is JSON 404 API_NOT_FOUND (never a SPA shell)", async () => {
    const { service } = recordingHistory(failure("SOURCE_UNAVAILABLE"));
    const path = "/api/history/nope";
    const res = await dispatch(get(path), path, runtimeWith(service), stubAssets);
    expect(res.status).toBe(404);
    expect((await jsonBody(res)).code).toBe("API_NOT_FOUND");
  });
});

// ── Slash-bearing ids through the full fetch handler (amendment 12 §1, REQ-ECR-01) ──────────────

describe("percent-encoded slash-bearing ids reach the history service through createFetchHandler", () => {
  const MODEL = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "..", "..", "examples", "reference", "rendered", "web-estate-model.json"),
      "utf8",
    ),
  ) as WebEstateModelV2;

  const sourceFail: SourceResult<never> = {
    ok: false,
    error: { kind: "transport", message: "unused", status: null },
  };
  const vm: VmClient = {
    statusSignals: async () => sourceFail,
    targets: async () => sourceFail,
    buildInfo: async () => sourceFail,
    queryRange: async () => ({
      ok: true,
      data: { series: [{ metric: { __name__: "series" }, samples: [{ timestampMs: 1000, value: 1 }] }] },
    }),
  };
  const gatus: GatusClient = {
    endpointStatuses: async () => sourceFail,
    endpointHistory: async () => ({
      ok: true,
      data: {
        key: "harbor-web-01/portal-web",
        results: [{ timestamp: "2026-09-17T00:00:00.000Z", success: true, durationMs: 12, conditionResults: [] }],
      },
    }),
  };
  const history = createHistoryService({ vm, gatus, model: () => MODEL });
  const ctx: ServerContext = {
    ...ctxWith(history),
    estate: { model: MODEL } as NonNullable<ServerContext["estate"]>,
  };
  const status: RuntimeStatus = {
    sources: {
      metrics: { ok: true, lastSuccess: null, error: null },
      alerts: { ok: true, lastSuccess: null, error: null },
      checks: { ok: true, lastSuccess: null, error: null },
    },
    model: { loaded: true, formatVersion: 2, error: null },
    lastSnapshotAt: null,
  };
  const runtime: ServerRuntime = {
    getContext: () => ctx,
    identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
    getStatus: () => status,
    runOnce: async () => {},
    start: async () => {},
    close: () => {},
  };
  const handler = createFetchHandler(runtime, {
    get: () => undefined,
    shell: () => "<!doctype html><div id=app></div>",
  });
  const get = (path: string): Promise<Response> =>
    handler(new Request(`http://web:8080${path}`, { method: "GET" }));

  test("a svc:<host>/<name> target id is not a 400 and reaches the history service (200)", async () => {
    const id = encodeURIComponent("svc:harbor-web-01/portal-web");
    expect(id).toBe("svc%3Aharbor-web-01%2Fportal-web");
    const res = await get(`/api/history/target/${id}/service.deep-health?range=24h`);
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { kind: string; id: string }; queryId: string };
    expect(body.target).toEqual({ kind: "service", id: "svc:harbor-web-01/portal-web" });
    expect(body.queryId).toBe("service.deep-health");
  });

  test("a <host>/<service> Gatus endpoint name is not a 400 on the checks route", async () => {
    const res = await get(`/api/history/checks/${encodeURIComponent("harbor-web-01/portal-web")}?range=24h`);
    expect(res.status).not.toBe(400);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoint: string };
    expect(body.endpoint).toBe("harbor-web-01/portal-web");
  });

  test("a structurally invalid slash id is still a 400 INVALID_REQUEST", async () => {
    const res = await get(`/api/history/target/${encodeURIComponent("svc:harbor-web-01/../x")}/service.deep-health`);
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).code).toBe("INVALID_REQUEST");
  });

  test("the estate route still rejects an encoded slash (400)", async () => {
    const res = await get("/api/history/estate/a%2Fb");
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).code).toBe("INVALID_REQUEST");
  });
});

// ── Gatus composite key end-to-end (amendment 12 §2, REQ-ECR-02) ─────────────────────────────────

describe("check history reaches a Gatus that only answers composite keys", () => {
  const MODEL = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "..", "..", "examples", "reference", "rendered", "web-estate-model.json"),
      "utf8",
    ),
  ) as WebEstateModelV2;

  // The pulse names in the reference model and the keys Gatus 5.13.1 derives for them.
  const SERVICE_NAME = "harbor-web-01/portal-web";
  const DOMAIN_NAME = "dns:aurora.example";
  const KEYS: Readonly<Record<string, string>> = {
    "harbor-web-01_harbor-web-01-portal-web": SERVICE_NAME,
    "_dns:aurora-example": DOMAIN_NAME,
  };

  const requested: string[] = [];
  const gatusFetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const match = /^\/api\/v1\/endpoints\/([^/]+)\/statuses$/.exec(url.pathname);
    const key = match ? decodeURIComponent(match[1]!) : null;
    requested.push(key ?? url.pathname);
    const name = key !== null ? KEYS[key] : undefined;
    if (key === null || name === undefined) return new Response("not found", { status: 404 });
    return Response.json({
      name,
      key,
      results: [
        { success: true, timestamp: "2026-09-25T00:00:00Z", duration: 12_000_000, conditionResults: [] },
        { success: false, timestamp: "2026-09-25T00:01:00Z", duration: 40_000_000, conditionResults: [] },
      ],
    });
  }) as unknown as typeof fetch;

  const sourceFail: SourceResult<never> = { ok: false, error: { kind: "transport", message: "unused", status: null } };
  const vm: VmClient = {
    statusSignals: async () => sourceFail,
    targets: async () => sourceFail,
    buildInfo: async () => sourceFail,
    queryRange: async () => sourceFail,
  };
  const gatus = createGatusClient("http://gatus.invalid:8080", { fetchImpl: gatusFetch });
  const history = createHistoryService({ vm, gatus, model: () => MODEL });
  const ctx: ServerContext = { ...ctxWith(history), estate: { model: MODEL } as NonNullable<ServerContext["estate"]> };
  const status: RuntimeStatus = {
    sources: {
      metrics: { ok: true, lastSuccess: null, error: null },
      alerts: { ok: true, lastSuccess: null, error: null },
      checks: { ok: true, lastSuccess: null, error: null },
    },
    model: { loaded: true, formatVersion: 2, error: null },
    lastSnapshotAt: null,
  };
  const runtime: ServerRuntime = {
    getContext: () => ctx,
    identityConfig: { mode: "none", headerName: "Remote-User", trustedProxies: [] },
    getStatus: () => status,
    runOnce: async () => {},
    start: async () => {},
    close: () => {},
  };
  const handler = createFetchHandler(runtime, { get: () => undefined, shell: () => "<!doctype html>" });
  const get = (path: string): Promise<Response> => handler(new Request(`http://web:8080${path}`, { method: "GET" }));

  test("the fake Gatus rejects the bare pulse name (sanity: name-addressing would 404)", async () => {
    const res = await gatusFetch(`http://gatus.invalid:8080/api/v1/endpoints/${encodeURIComponent(SERVICE_NAME)}/statuses`);
    expect(res.status).toBe(404);
  });

  for (const name of [SERVICE_NAME, DOMAIN_NAME]) {
    test(`GET /api/history/checks/${encodeURIComponent(name)} returns 200 with results keyed by the pulse name`, async () => {
      requested.length = 0;
      const res = await get(`/api/history/checks/${encodeURIComponent(name)}?range=24h`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        endpoint: string;
        target: { kind: string; id: string };
        results: readonly unknown[];
      };
      expect(body.endpoint).toBe(name);
      expect(body.target).toEqual({ kind: "endpoint", id: name });
      expect(body.results).toHaveLength(2);
      expect(requested).toHaveLength(1);
      expect(KEYS[requested[0]!]).toBe(name);
    });
  }
});
