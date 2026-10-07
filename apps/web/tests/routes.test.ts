// apps/web/tests/routes.test.ts — the server tier: config parse, the three route handlers, the
// router dispatch (GET-only + error-page HTTP mapping), the refresh loop's per-source isolation, and
// the /metrics family set (02-server-tier.md §3-§6). Handlers are exercised WITHOUT binding the port
// (import.meta.main guard in index.ts) — the prober precedent (08-testing-strategy.md).

import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { loadServerConfig, type ServerConfig } from "../src/server/config.js";
import { ConfigError } from "../src/shared/errors.js";
import { GATUS_STALE_SECONDS_DEFAULT } from "../src/shared/constants.js";
import type { HealthBody, OverviewSnapshot, SourceHealth } from "../src/shared/snapshot.js";
import type { RouteRequest, ServerContext } from "../src/shared/registry.js";

import { healthzRoute } from "../src/server/routes/healthz.js";
import { overviewRoute } from "../src/server/routes/overview.js";
import { metricsRoute, renderMetrics, recordRefresh, __resetMetricsForTest } from "../src/server/routes/metrics.js";
import { ROUTES } from "../src/server/routes/registry.js";
import { dispatch, createFetchHandler } from "../src/server/router.js";
import {
  runRefreshCycle,
  setRuntimeStatus,
  type RuntimeState,
  type RuntimeStatus,
  type ServerRuntime,
} from "../src/server/refresh.js";
import type { SourceResult } from "../src/server/sources/types.js";
import type { StaticAssets } from "../src/server/assets.js";
import { EstateBundleError } from "../src/shared/errors.js";
import { overviewSnapshot } from "./factories.js";

// ── Shared helpers ───────────────────────────────────────────────────────────────────────────────

const ALT_ESTATE = join(import.meta.dir, "fixtures", "alt-estate", "web-estate-model.json");
// A committed, coherent format-v2 bundle (model + coverage + findings siblings) the refresh loop can
// load through the v2 bundle authority (06). The v1 `alt-estate` fixture above is intentionally a
// version rejection under the v2 loader, so it drives only the config-parse tests, not runRefreshCycle.
const V2_BUNDLE_MODEL = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "examples",
  "reference",
  "rendered",
  "web-estate-model.json",
);

/** A full, required env map for a happy config parse. */
function fullEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    PULSE_WEB_ESTATE_MODEL: ALT_ESTATE,
    ...over,
  };
}

function health(over: Partial<SourceHealth> = {}): SourceHealth {
  return { ok: true, lastSuccess: "2026-08-22T12:00:00.000Z", error: null, ...over };
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    sources: { metrics: health(), alerts: health(), checks: health() },
    model: { loaded: true, formatVersion: 1, error: null },
    lastSnapshotAt: Date.parse("2026-08-22T12:00:00.000Z"),
    ...over,
  };
}

/** An in-memory StaticAssets stub (no built dist/client needed for router tests). */
const stubAssets: StaticAssets = {
  get: (p) => (p === "/assets/app.js" ? { body: new ArrayBuffer(3), contentType: "text/javascript" } : undefined),
  shell: () => "<!doctype html><div id=app></div>",
};

/** A minimal ServerRuntime around a fixed context + status (no live loop). */
function fakeRuntime(ctx: Partial<ServerContext>, st: RuntimeStatus): ServerRuntime {
  const context: ServerContext = {
    estate: null,
    cycle: null,
    history: {} as ServerContext["history"],
    events: {} as ServerContext["events"],
    sources: {} as ServerContext["sources"],
    config: {} as ServerConfig,
    identity: null,
    snapshot: null,
    ...ctx,
  };
  return {
    getContext: () => context,
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

/** A minimal compiled `RouteRequest` for a direct handler call (these handlers ignore it). */
function routeReq(path: string): RouteRequest {
  return { request: get(path), params: {}, routePattern: path, peerIp: null, disableTimeout() {} };
}

/** Normalise a route handler's `Response | Promise<Response>` return to a `Response`. */
async function resolved(r: Response | Promise<Response>): Promise<Response> {
  return r;
}

// ── §3 config parsing ──────────────────────────────────────────────────────────────────────────

describe("loadServerConfig (§3)", () => {
  test("raises ConfigError naming each missing required engine URL", () => {
    for (const missing of ["PULSE_VM_URL", "PULSE_ALERTMANAGER_URL", "PULSE_GATUS_URL", "PULSE_VMALERT_URL"]) {
      const env = fullEnv({ [missing]: undefined });
      let thrown: unknown;
      try {
        loadServerConfig(env);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      expect((thrown as ConfigError).envVar).toBe(missing);
      expect((thrown as ConfigError).code).toBe("CONFIG_MISSING_ENV");
      expect((thrown as ConfigError).message).toContain(missing);
    }
  });

  test("an empty/whitespace required engine URL is also a ConfigError", () => {
    expect(() => loadServerConfig(fullEnv({ PULSE_VM_URL: "   " }))).toThrow(ConfigError);
  });

  test("an unset/empty PULSE_WEB_ESTATE_MODEL is null, not a throw (servable error-page mode)", () => {
    expect(loadServerConfig(fullEnv({ PULSE_WEB_ESTATE_MODEL: undefined })).estateModelPath).toBeNull();
    expect(loadServerConfig(fullEnv({ PULSE_WEB_ESTATE_MODEL: "   " })).estateModelPath).toBeNull();
  });

  test("optional vars fall back to documented defaults", () => {
    const cfg = loadServerConfig(fullEnv());
    expect(cfg.estateTz).toBeNull(); // PULSE_ESTATE_TZ unset → UTC marker
    expect(cfg.grafanaUrl).toBeNull(); // PULSE_GRAFANA_URL unset → links disabled
    expect(cfg.gatusStaleSeconds).toBe(GATUS_STALE_SECONDS_DEFAULT); // 300
  });

  test("a valid IANA tz passes through; an invalid one falls back to null", () => {
    expect(loadServerConfig(fullEnv({ PULSE_ESTATE_TZ: "America/Chicago" })).estateTz).toBe("America/Chicago");
    expect(loadServerConfig(fullEnv({ PULSE_ESTATE_TZ: "Not/AZone" })).estateTz).toBeNull();
  });

  test("a non-numeric stale-seconds falls back to the default", () => {
    expect(loadServerConfig(fullEnv({ PULSE_GATUS_STALE_SECONDS: "abc" })).gatusStaleSeconds).toBe(GATUS_STALE_SECONDS_DEFAULT);
    expect(loadServerConfig(fullEnv({ PULSE_GATUS_STALE_SECONDS: "600" })).gatusStaleSeconds).toBe(600);
  });
});

// ── §4.1 route registry — read-only surface ──────────────────────────────────────────────────────

describe("ROUTES registry (§4.1)", () => {
  test("every registered route's method is GET (REQ-SEC-02)", () => {
    expect(ROUTES.length).toBeGreaterThan(0);
    for (const r of ROUTES) expect(r.method).toBe("GET");
  });

  test("the complete M1 registry is present (baseline + required routes, each exactly once)", () => {
    // Extension-seam guard (§6): the required M1 routes are all present exactly once and unique —
    // NOT a brittle historical count. Later views may append more; these must never regress.
    const paths = ROUTES.map((r) => r.path);
    const required = [
      "/healthz",
      "/metrics",
      "/api/overview",
      "/api/alerts",
      "/api/estate",
      "/api/engine",
      "/api/timeline",
      "/api/session",
      "/api/events",
      "/api/history/estate/:queryId",
      "/api/history/target/:drilldownId/:queryId",
      "/api/history/alerts",
      "/api/history/checks/:endpoint",
    ];
    for (const path of required) {
      expect(paths.filter((p) => p === path)).toHaveLength(1);
    }
    // Every pattern is unique (no duplicate registration).
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("the M2 /api/proposals read route is registered exactly once, GET-only, last (REQ-PROP-06)", () => {
    const matches = ROUTES.filter((r) => r.path === "/api/proposals");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.method).toBe("GET");
    expect(ROUTES[ROUTES.length - 1]!.path).toBe("/api/proposals");
  });
});

// ── §5.2 /healthz ────────────────────────────────────────────────────────────────────────────────

describe("GET /healthz (§5.2, REQ-OBS-01)", () => {
  test("status ok when all sources up and model loaded", async () => {
    setRuntimeStatus(status());
    const res = await resolved(healthzRoute.handler(routeReq("/healthz"), {} as ServerContext));
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.estateModel.loaded).toBe(true);
    expect(body.sources.metrics.ok).toBe(true);
  });

  test("status degraded when a single source is unreachable (per-source SourceHealth)", async () => {
    setRuntimeStatus(status({ sources: { metrics: health(), alerts: health({ ok: false, error: "boom" }), checks: health() } }));
    const body = (await (await resolved(healthzRoute.handler(routeReq("/healthz"), {} as ServerContext))).json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.sources.alerts.ok).toBe(false);
    expect(body.sources.alerts.error).toBe("boom");
    expect(body.sources.metrics.ok).toBe(true); // other sources stay live
  });

  test("status degraded when the model is not loaded", async () => {
    setRuntimeStatus(status({ model: { loaded: false, formatVersion: null, error: null } }));
    const body = (await (await resolved(healthzRoute.handler(routeReq("/healthz"), {} as ServerContext))).json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.estateModel.loaded).toBe(false);
  });
});

// ── §5.1 /api/overview ───────────────────────────────────────────────────────────────────────────

describe("GET /api/overview (§5.1)", () => {
  test("503 NOT_READY before the first snapshot", async () => {
    const res = await resolved(overviewRoute.handler(routeReq("/api/overview"), { snapshot: null } as ServerContext));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_READY");
  });

  test("200 with the snapshot once built", async () => {
    const snap = overviewSnapshot();
    const res = await resolved(overviewRoute.handler(routeReq("/api/overview"), { snapshot: snap } as ServerContext));
    expect(res.status).toBe(200);
    expect(((await res.json()) as OverviewSnapshot).estate.name).toBe(snap.estate.name);
  });

  test("503 structured OverviewErrorBody in error-page mode (via the router, §4.4)", async () => {
    const err = new EstateBundleError("missing", "model", "/rendered/web-estate-model.json", "not found — run pulse render");
    const runtime = fakeRuntime({ estate: null, snapshot: null }, status({ model: { loaded: false, formatVersion: null, error: err } }));
    const res = await dispatch(get("/api/overview"), "/api/overview", runtime, stubAssets);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; kind: string; path: string };
    expect(body.kind).toBe("missing");
    expect(body.path).toBe("/rendered/web-estate-model.json");
    expect(body.code).toBe("ESTATE_BUNDLE_MISSING");
  });
});

// ── §7 bundle-error mode must not serve stale cycles (AC1) ──────────────────────────────────────────
//
// The four other current cycle-backed routes go through the SAME router bundle-error branch as
// overview: even with a cycle published in the context, every estate/cycle-backed `/api/*` returns the
// safe bundle 503 (never the retained/stale representation, never a SPA shell). Proven at the dispatch
// level because the handler is never reached — a stand-in `cycle` in the context is deliberately not a
// real materialized cycle, so a 503 (not a throw / 200) witnesses that the router short-circuits first.

describe("current cycle-backed routes in bundle-error mode (§7, AC1)", () => {
  const CYCLE_API_PATHS = ["/api/overview", "/api/alerts", "/api/estate", "/api/engine", "/api/timeline"] as const;

  for (const path of CYCLE_API_PATHS) {
    test(`${path}: safe bundle 503 even with a cycle present (no stale cycle served)`, async () => {
      const err = new EstateBundleError(
        "unparseable",
        "model",
        "/rendered/web-estate-model.json",
        "bad json — run pulse render",
      );
      // A non-null cycle in the context proves the router — not the handler — owns the refusal: if the
      // handler ran, this stand-in cycle would not yield a clean bundle 503.
      const runtime = fakeRuntime(
        { estate: null, snapshot: null, cycle: {} as unknown as ServerContext["cycle"] },
        status({ model: { loaded: false, formatVersion: null, error: err } }),
      );
      const res = await dispatch(get(path), path, runtime, stubAssets);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { code: string; kind: string };
      expect(body.code).toBe("ESTATE_BUNDLE_UNPARSEABLE"); // existing safe bundle code, not NOT_READY
      expect(body.kind).toBe("unparseable");
      expect(res.headers.get("etag")).toBeNull(); // no retained representation validator leaks
      expect(res.headers.get("content-type")).toContain("application/json"); // JSON error, never a SPA shell
    });
  }
});

// ── §4 router dispatch ───────────────────────────────────────────────────────────────────────────

describe("router dispatch (§4)", () => {
  test("a non-GET method is 405 (read-only surface, REQ-SEC-02)", async () => {
    const runtime = fakeRuntime({}, status());
    const res = await dispatch(new Request("http://web:8080/api/overview", { method: "POST" }), "/api/overview", runtime, stubAssets);
    expect(res.status).toBe(405);
  });

  test("error-page mode serves the error HTML on a SPA path, assets still load", async () => {
    const err = new EstateBundleError("unparseable", "model", "/rendered/web-estate-model.json", "bad json");
    const runtime = fakeRuntime({}, status({ model: { loaded: false, formatVersion: null, error: err } }));

    const page = await dispatch(get("/"), "/", runtime, stubAssets);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("/rendered/web-estate-model.json");

    const asset = await dispatch(get("/assets/app.js"), "/assets/app.js", runtime, stubAssets);
    expect(asset.status).toBe(200); // shell JS/CSS still load in error-page mode (§4.4)
  });

  test("an unknown GET path falls back to the SPA shell", async () => {
    const runtime = fakeRuntime({}, status());
    const res = await dispatch(get("/some/deep/route"), "/some/deep/route", runtime, stubAssets);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("id=app");
  });

  test("createFetchHandler records an http-requests metric and returns the route response", async () => {
    __resetMetricsForTest();
    setRuntimeStatus(status());
    const runtime = fakeRuntime({}, status());
    const handler = createFetchHandler(runtime, stubAssets);
    const res = await handler(get("/healthz"));
    expect(res.status).toBe(200);
    const metrics = renderMetrics(status(), Date.parse("2026-08-22T12:00:00.000Z"));
    expect(metrics).toContain('pulse_web_http_requests_total{route="/healthz",status="200"}');
  });
});

// ── §5.3 /metrics ────────────────────────────────────────────────────────────────────────────────

describe("GET /metrics (§5.3, REQ-OBS-03)", () => {
  afterEach(() => __resetMetricsForTest());

  test("emits every pulse_web_* family incl. build_info and source_up", async () => {
    setRuntimeStatus(status());
    const res = await resolved(metricsRoute.handler(routeReq("/metrics"), {} as ServerContext));
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
    const text = await res.text();
    for (const family of [
      "pulse_web_build_info",
      "pulse_web_source_up",
      "pulse_web_snapshot_age_seconds",
      "pulse_web_estate_model_loaded",
      "pulse_web_refresh_total",
      "pulse_web_http_requests_total",
    ]) {
      expect(text).toContain(`# TYPE ${family}`);
    }
    expect(text).toContain('pulse_web_build_info{version=');
  });

  test("source_up reflects per-source reachability; estate_model_loaded reflects the model", () => {
    const text = renderMetrics(
      status({
        sources: { metrics: health(), alerts: health({ ok: false, error: "x" }), checks: health() },
        model: { loaded: true, formatVersion: 1, error: null },
      }),
      Date.parse("2026-08-22T12:00:07.000Z"),
    );
    expect(text).toContain('pulse_web_source_up{source="metrics"} 1');
    expect(text).toContain('pulse_web_source_up{source="alerts"} 0');
    expect(text).toContain('pulse_web_source_up{source="checks"} 1');
    expect(text).toContain("pulse_web_estate_model_loaded 1");
    expect(text).toContain("pulse_web_snapshot_age_seconds 7");
  });

  test("refresh_total increments per source/outcome", () => {
    recordRefresh("metrics", "success");
    recordRefresh("alerts", "failure");
    const text = renderMetrics(status(), Date.now());
    expect(text).toContain('pulse_web_refresh_total{source="metrics",outcome="success"} 1');
    expect(text).toContain('pulse_web_refresh_total{source="alerts",outcome="failure"} 1');
  });

  test("snapshot_age is NaN before the first snapshot", () => {
    const text = renderMetrics(status({ lastSnapshotAt: null }), Date.now());
    expect(text).toContain("pulse_web_snapshot_age_seconds NaN");
  });
});

// ── §6 refresh loop — per-source isolation + non-blocking ────────────────────────────────────────

/** A source client whose single method resolves the given result (optionally after `delayMs`). */
function fakeSource<T>(result: SourceResult<T>, delayMs = 0): () => Promise<SourceResult<T>> {
  return () =>
    delayMs === 0
      ? Promise.resolve(result)
      : new Promise((resolve) => setTimeout(() => resolve(result), delayMs));
}

function makeState(clients: {
  vm: () => Promise<SourceResult<never[]>>;
  am: () => Promise<SourceResult<never[]>>;
  gatus: () => Promise<SourceResult<never[]>>;
}): RuntimeState {
  return {
    config: loadServerConfig(fullEnv({ PULSE_WEB_ESTATE_MODEL: V2_BUNDLE_MODEL })),
    sources: {
      vm: { queryLiveness: clients.vm } as RuntimeState["sources"]["vm"],
      alertmanager: { activeAlerts: clients.am } as RuntimeState["sources"]["alertmanager"],
      gatus: { endpointStatuses: clients.gatus } as RuntimeState["sources"]["gatus"],
    },
    watcher: null,
    estate: null,
    snapshot: null,
    status: {
      sources: { metrics: health({ ok: false, lastSuccess: null }), alerts: health({ ok: false, lastSuccess: null }), checks: health({ ok: false, lastSuccess: null }) },
      model: { loaded: false, formatVersion: null, error: null },
      lastSnapshotAt: null,
    },
  };
}

describe("runRefreshCycle (§6)", () => {
  afterEach(() => __resetMetricsForTest());

  test("isolates a single failing source; others stay live; a snapshot is still built", async () => {
    const state = makeState({
      vm: fakeSource({ ok: true, data: [] }),
      am: fakeSource({ ok: false, error: "alertmanager unreachable" }), // the failing one
      gatus: fakeSource({ ok: true, data: [] }),
    });

    await runRefreshCycle(state); // must not throw

    expect(state.status.sources.alerts.ok).toBe(false);
    expect(state.status.sources.alerts.error).toBe("alertmanager unreachable");
    expect(state.status.sources.metrics.ok).toBe(true); // healthy sources stay live (REQ-LIVE-04)
    expect(state.status.sources.checks.ok).toBe(true);

    // The estate model loaded from the fixture, so a snapshot is built despite the failing source.
    expect(state.estate).not.toBeNull();
    expect(state.snapshot).not.toBeNull();
    expect(state.snapshot?.sources.alerts.ok).toBe(false);
  });

  test("does not block request serving while a cycle is in flight", async () => {
    const state = makeState({
      vm: fakeSource({ ok: true, data: [] }, 50), // slow source keeps the cycle in flight
      am: fakeSource({ ok: true, data: [] }, 50),
      gatus: fakeSource({ ok: true, data: [] }, 50),
    });

    const cyclePromise = runRefreshCycle(state); // in flight (~50ms)

    // A /healthz request during the in-flight cycle resolves immediately from the singleton status.
    setRuntimeStatus(state.status);
    const before = performance.now();
    const res = await resolved(healthzRoute.handler(routeReq("/healthz"), {} as ServerContext));
    const elapsed = performance.now() - before;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(40); // served without waiting for the ~50ms cycle

    await cyclePromise; // let the cycle settle
  });

  test("a source recovering flips ok back to true and clears its error", async () => {
    const state = makeState({
      vm: fakeSource({ ok: true, data: [] }),
      am: fakeSource({ ok: false, error: "down" }),
      gatus: fakeSource({ ok: true, data: [] }),
    });
    await runRefreshCycle(state);
    expect(state.status.sources.alerts.ok).toBe(false);

    // Next cycle: alerts recovers.
    state.sources.alertmanager = { activeAlerts: fakeSource({ ok: true, data: [] }) } as RuntimeState["sources"]["alertmanager"];
    await runRefreshCycle(state);
    expect(state.status.sources.alerts.ok).toBe(true);
    expect(state.status.sources.alerts.error).toBeNull();
  });
});
