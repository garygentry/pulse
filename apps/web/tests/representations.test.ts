// apps/web/tests/representations.test.ts — the current-state representation protocol (05 §7).
//
// Exercises the pure negotiation/observation helpers (`acceptsGzip`, `ifNoneMatchMatches`,
// `encodeObservationHeader`), the `cycleJsonResponse` helper (plain/gzip selection, distinct strong
// ETags, bodyless 304, observation/payload-id headers, no reserialization), and the cycle-backed
// current routes (alerts/estate/engine/timeline + the overview cycle/snapshot/NOT_READY ladder).
// Payloads are built with the real package `materializeView`, so bytes/ETags/gzip are genuine.

import { describe, expect, test } from "bun:test";

import { buildCycleCandidate, materializeView } from "@pulse/web-data/cycle";
import type { CycleSourceRecords, CycleState, FoldInputs, MaterializedPayload } from "@pulse/web-data/cycle";
import type {
  AlertmanagerAlert,
  AlertmanagerReceiver,
  AlertmanagerSilence,
  AlertmanagerStatus,
  GatusEndpointState,
  GrafanaHealth,
  MetricSample,
  ScrapeTargetState,
  SourceRecord,
  VmBuildInfo,
  VmalertRuleGroup,
} from "@pulse/web-data/sources";
import {
  CURRENT_MAX_GZIP_BYTES,
  CURRENT_MAX_PLAIN_BYTES,
  validateCycleObservation,
  type CycleObservation,
  type SourceId,
  type SourceObservation,
  type ViewId,
} from "@pulse/web-data/wire";
import type { WebEstateHostV2, WebEstateModelV2, WebEstateServiceV2 } from "@pulse/renderer";

import { makeWebCoverageArtifact, makeWebFindingsArtifact, makeWebEstateModelV2 } from "./factories/estate-bundle.js";

import {
  acceptsGzip,
  encodeObservationHeader,
  ifNoneMatchMatches,
} from "../src/shared/api/observation.js";
import { cycleJsonResponse } from "../src/shared/api/json.js";
import { alertsRoute, estateRoute, engineRoute, timelineRoute } from "../src/server/routes/current.js";
import { overviewRoute } from "../src/server/routes/overview.js";
import type { RouteDefinition, RouteRequest, ServerContext } from "../src/shared/registry.js";
import { overviewSnapshot } from "./factories.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

function sourceObs(): SourceObservation {
  return { state: "current", lastAttemptAt: "2026-09-17T06:00:00.000Z", lastSuccess: "2026-09-17T06:00:00.000Z" };
}

function observation(over: Partial<CycleObservation> = {}): CycleObservation {
  const sources = Object.fromEntries(SOURCE_IDS.map((id) => [id, sourceObs()])) as Record<SourceId, SourceObservation>;
  return {
    generation: "11111111-2222-3333-4444-555555555555",
    seq: 7,
    observedAt: "2026-09-17T06:00:00.000Z",
    appVersion: "test-1.0.0",
    sources,
    ...over,
  };
}

/** A real materialized payload (genuine plain/gzip bytes + distinct SHA-256 ETags). */
async function materialize(value: unknown): Promise<MaterializedPayload<unknown>> {
  const result = await materializeView("overview", null, value, value);
  if (!result.ok) throw new Error(`materializeView failed: ${result.error.kind}`);
  return result.payload;
}

/** A `CycleState` whose five views all reference `payload` (only the served view matters here). */
function cycleWith(payload: MaterializedPayload<unknown>, obs: CycleObservation = observation()): CycleState {
  return {
    observation: obs,
    sources: {} as CycleState["sources"],
    overview: payload,
    alerts: payload,
    estate: payload,
    engine: payload,
    timeline: payload,
  } as unknown as CycleState;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://web:8080/api/alerts", { method: "GET", headers });
}

function routeReq(request: Request, path = "/api/alerts"): RouteRequest {
  return { request, params: {}, routePattern: path, peerIp: null, disableTimeout() {} };
}

function ctxWith(over: Partial<ServerContext>): ServerContext {
  return {
    estate: null, cycle: null, history: {} as ServerContext["history"],
    sources: {} as ServerContext["sources"], config: {} as ServerContext["config"],
    identity: null, snapshot: null, ...over,
  } as ServerContext;
}

// ── acceptsGzip (§7 step 2) ────────────────────────────────────────────────────────────────────

describe("acceptsGzip", () => {
  test("admits gzip only when present with q>0; a rejected gzip;q=0 is never matched", () => {
    expect(acceptsGzip(null)).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    expect(acceptsGzip("gzip")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false); // explicit rejection — not substring-matched
    expect(acceptsGzip("gzip;q=0.001")).toBe(true);
    expect(acceptsGzip("br, gzip, deflate")).toBe(true);
    expect(acceptsGzip("identity")).toBe(false);
    expect(acceptsGzip("deflate")).toBe(false);
  });

  test("honours a wildcard only when no explicit gzip element is present", () => {
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("*;q=0")).toBe(false);
    expect(acceptsGzip("gzip;q=0, *")).toBe(false); // explicit gzip rejection wins over the wildcard
    expect(acceptsGzip("gzip;q=0.5, *;q=0")).toBe(true);
  });
});

// ── ifNoneMatchMatches (§7 step 3) ───────────────────────────────────────────────────────────────

describe("ifNoneMatchMatches", () => {
  const etag = "sha256:abc123";
  test("strong list semantics: exact quoted tag or * matches; weak/mismatch does not", () => {
    expect(ifNoneMatchMatches(null, etag)).toBe(false);
    expect(ifNoneMatchMatches(`"${etag}"`, etag)).toBe(true);
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
    expect(ifNoneMatchMatches(`"sha256:other"`, etag)).toBe(false);
    expect(ifNoneMatchMatches(`W/"${etag}"`, etag)).toBe(false); // weak never matches
    expect(ifNoneMatchMatches(`"sha256:x", "${etag}", "sha256:y"`, etag)).toBe(true);
    expect(ifNoneMatchMatches(`W/"${etag}", "sha256:z"`, etag)).toBe(false);
  });
});

// ── encodeObservationHeader (§7 step 4) ──────────────────────────────────────────────────────────

describe("encodeObservationHeader", () => {
  test("encodes a bounded base64url header that decodes to a valid observation", () => {
    const header = encodeObservationHeader(observation());
    expect(header).not.toBeNull();
    expect(header!).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet, no padding
    const decoded = JSON.parse(Buffer.from(header!, "base64url").toString("utf8"));
    expect(validateCycleObservation(decoded)).not.toBeNull(); // round-trips to a valid observation
  });

  test("returns null when the encoded header would exceed 8 KiB (fails safely)", () => {
    expect(encodeObservationHeader(observation({ appVersion: "x".repeat(9000) }))).toBeNull();
  });
});

// ── cycleJsonResponse (§7 steps 5–6) ─────────────────────────────────────────────────────────────

describe("cycleJsonResponse", () => {
  test("200 plain: exact retained bytes, strong ETag, and all shared headers", async () => {
    const payload = await materialize({ n: 1, s: "plain" });
    const cycle = cycleWith(payload);
    const res = cycleJsonResponse({ request: req(), cycle, payload });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("etag")).toBe(`"${payload.plain.etag}"`);
    expect(res.headers.get("x-pulse-payload-id")).toBe(payload.identity);
    expect(res.headers.get("x-pulse-observation")).toBe(encodeObservationHeader(cycle.observation));
    // Exact retained bytes — no reserialization.
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(payload.plain.bytes));
  });

  test("200 gzip: retained gzip bytes, Content-Encoding gzip, and the DISTINCT gzip ETag", async () => {
    const payload = await materialize({ n: 2, s: "gzip".repeat(200) });
    const res = cycleJsonResponse({ request: req({ "accept-encoding": "gzip" }), cycle: cycleWith(payload), payload });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("etag")).toBe(`"${payload.gzip.etag}"`);
    expect(payload.gzip.etag).not.toBe(payload.plain.etag); // plain/gzip validators differ
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(payload.gzip.bytes));
  });

  test("gzip;q=0 serves plain bytes with the plain ETag (no Content-Encoding)", async () => {
    const payload = await materialize({ n: 3 });
    const res = cycleJsonResponse({ request: req({ "accept-encoding": "gzip;q=0" }), cycle: cycleWith(payload), payload });
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("etag")).toBe(`"${payload.plain.etag}"`);
  });

  test("matching strong validator → bodyless 304 carrying ETag + observation + payload-id", async () => {
    const payload = await materialize({ n: 4 });
    const cycle = cycleWith(payload);
    const res = cycleJsonResponse({
      request: req({ "if-none-match": `"${payload.plain.etag}"` }),
      cycle,
      payload,
    });
    expect(res.status).toBe(304);
    expect((await res.arrayBuffer()).byteLength).toBe(0); // bodyless
    expect(res.headers.get("etag")).toBe(`"${payload.plain.etag}"`);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("x-pulse-observation")).toBe(encodeObservationHeader(cycle.observation));
    expect(res.headers.get("x-pulse-payload-id")).toBe(payload.identity);
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("a weak validator does not match → 200", async () => {
    const payload = await materialize({ n: 5 });
    const res = cycleJsonResponse({
      request: req({ "if-none-match": `W/"${payload.plain.etag}"` }),
      cycle: cycleWith(payload),
      payload,
    });
    expect(res.status).toBe(200);
  });

  test("a plain ETag cannot validate the gzip representation (encoding-scoped 304)", async () => {
    const payload = await materialize({ n: 6, s: "z".repeat(300) });
    // Request gzip but present the PLAIN validator — the selected (gzip) ETag differs → 200, not 304.
    const res = cycleJsonResponse({
      request: req({ "accept-encoding": "gzip", "if-none-match": `"${payload.plain.etag}"` }),
      cycle: cycleWith(payload),
      payload,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
  });

  test("observation advances on a 304 even though bytes are retained", async () => {
    const payload = await materialize({ n: 7 });
    const advanced = observation({ seq: 42, observedAt: "2026-09-17T07:00:00.000Z" });
    const res = cycleJsonResponse({
      request: req({ "if-none-match": `"${payload.plain.etag}"` }),
      cycle: cycleWith(payload, advanced),
      payload,
    });
    expect(res.status).toBe(304);
    const decoded = JSON.parse(Buffer.from(res.headers.get("x-pulse-observation")!, "base64url").toString("utf8"));
    expect(decoded.seq).toBe(42); // observation is outside representation identity
  });

  test("a multi-tag If-None-Match list containing the selected ETag → bodyless 304 (AC3 multiple)", async () => {
    const payload = await materialize({ n: 8 });
    const res = cycleJsonResponse({
      request: req({ "if-none-match": `"sha256:aaa", "${payload.plain.etag}", "sha256:zzz"` }),
      cycle: cycleWith(payload),
      payload,
    });
    expect(res.status).toBe(304);
    expect((await res.arrayBuffer()).byteLength).toBe(0);
    expect(res.headers.get("etag")).toBe(`"${payload.plain.etag}"`);
  });

  test("a multi-tag list with a weak match among strong non-matches → 200 (weak never validates)", async () => {
    const payload = await materialize({ n: 9 });
    const res = cycleJsonResponse({
      request: req({ "if-none-match": `"sha256:aaa", W/"${payload.plain.etag}"` }),
      cycle: cycleWith(payload),
      payload,
    });
    expect(res.status).toBe(200);
  });

  test("invalid construction fails safely: an unencodable observation → 500 INTERNAL_ERROR, no bytes/validators leaked (AC4)", async () => {
    const payload = await materialize({ n: 10, s: "content" });
    // An oversized observation cannot be encoded within OBSERVATION_HEADER_MAX_BYTES (8 KiB), so the
    // helper must fail safely rather than emit a malformed/oversized header or the retained bytes.
    const cycle = cycleWith(payload, observation({ appVersion: "x".repeat(9000) }));
    const res = cycleJsonResponse({ request: req(), cycle, payload });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("An unexpected server error occurred."); // exact ERROR_MESSAGES text, no prose
    // No representation validator/observation/payload-id is leaked on the fail-safe path.
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("x-pulse-observation")).toBeNull();
    expect(res.headers.get("x-pulse-payload-id")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  test("even with a matching validator, an unencodable observation fails safe (500, not a 304)", async () => {
    const payload = await materialize({ n: 11 });
    const res = cycleJsonResponse({
      request: req({ "if-none-match": `"${payload.plain.etag}"` }), // would 304 if the header encoded
      cycle: cycleWith(payload, observation({ appVersion: "x".repeat(9000) })),
      payload,
    });
    expect(res.status).toBe(500); // the safe failure precedes 304 selection
    expect(((await res.json()) as { code: string }).code).toBe("INTERNAL_ERROR");
  });
});

// ── cycle-backed current routes (§7) ─────────────────────────────────────────────────────────────

describe("current routes", () => {
  const routes: readonly { name: string; route: RouteDefinition; path: string }[] = [
    { name: "alerts", route: alertsRoute, path: "/api/alerts" },
    { name: "estate", route: estateRoute, path: "/api/estate" },
    { name: "engine", route: engineRoute, path: "/api/engine" },
    { name: "timeline", route: timelineRoute, path: "/api/timeline" },
  ];

  for (const { name, route, path } of routes) {
    test(`${name}: 503 NOT_READY before the first cycle`, async () => {
      const res = await route.handler(routeReq(req(), path), ctxWith({ cycle: null }));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("NOT_READY");
    });

    test(`${name}: serves the retained representation when a cycle is published`, async () => {
      const payload = await materialize({ view: name });
      const res = await route.handler(routeReq(req(), path), ctxWith({ cycle: cycleWith(payload) }));
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe(`"${payload.plain.etag}"`);
      expect(res.headers.get("x-pulse-payload-id")).toBe(payload.identity);
    });
  }
});

describe("overview route cycle/snapshot/NOT_READY ladder", () => {
  test("serves the cycle overview representation when a cycle is published", async () => {
    const payload = await materialize({ view: "overview" });
    const res = await overviewRoute.handler(routeReq(req(), "/api/overview"), ctxWith({ cycle: cycleWith(payload) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${payload.plain.etag}"`);
  });

  test("transitional: 200 legacy snapshot when no cycle is published yet", async () => {
    const snap = overviewSnapshot();
    const res = await overviewRoute.handler(routeReq(req(), "/api/overview"), ctxWith({ cycle: null, snapshot: snap }));
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull(); // legacy path has no cycle ETag
  });

  test("503 NOT_READY when neither a cycle nor a snapshot exists", async () => {
    const res = await overviewRoute.handler(routeReq(req(), "/api/overview"), ctxWith({ cycle: null, snapshot: null }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_READY");
  });
});

// ── envelope body budgets: every current route ≤5 MiB plain and ≤1 MiB gzip (04 §13, 05 §7) ────────
//
// Item 058 AC3, route level: publish a cycle from a 100-host / 300-service estate and dispatch each of
// the five current routes, asserting the SERVED response body is within budget (the server fails rather
// than truncating — an over-budget view would have made buildCycleCandidate return a payload-limit
// failure). The estate view embeds the full model verbatim, so it is the stress case.

function rec<T>(data: T, at = "2026-09-17T00:00:00.000Z"): SourceRecord<T> {
  return { latest: { attemptedAt: at, result: { ok: true, data } }, lastGood: { at, data } };
}

/** A deterministic 100-host / 300-service model cloned from the coherent apps/web factory baseline. */
function envelopeModel(): WebEstateModelV2 {
  const base = makeWebEstateModelV2();
  const hostTemplate = base.hosts.find((h) => h.collectionClass === "managed-linux") ?? base.hosts[0]!;
  const svcTemplate = base.services.find((s) => !s.deepHealth) ?? base.services[0]!;
  const hosts: WebEstateHostV2[] = [];
  const services: WebEstateServiceV2[] = [];
  for (let i = 0; i < 100; i += 1) {
    const name = `host-${String(i).padStart(3, "0")}`;
    const addr = `10.${Math.floor(i / 254)}.${i % 254}.10`;
    hosts.push({
      ...hostTemplate,
      name,
      drilldownId: `host:${name}`,
      addresses: [addr],
      artifacts: [],
      suppressed: null,
      scrapeTargets: [{ job: "node", instance: `${addr}:9100` }],
    } as WebEstateHostV2);
    for (let k = 0; k < 3; k += 1) {
      const sname = `svc-${String(i).padStart(3, "0")}-${k}`;
      services.push({
        ...svcTemplate,
        name: sname,
        host: name,
        drilldownId: `svc:${name}/${sname}`,
        gatusEndpoints: [`${name}/${sname}`],
        artifacts: [],
        suppressed: null,
        backupFreshness: null,
      } as WebEstateServiceV2);
    }
  }
  // Drop baseline suppressions/overrides — they reference entities not in this synthetic estate.
  return { ...base, hosts, services, suppressions: [], routingOverrides: [] };
}

function envelopeInputs(): FoldInputs {
  const model = envelopeModel();
  const records: CycleSourceRecords = {
    "victoriametrics-signals": rec<readonly MetricSample[]>([]),
    "victoriametrics-targets": rec<readonly ScrapeTargetState[]>([]),
    "victoriametrics-buildinfo": rec<VmBuildInfo>({ version: "1.102.1", startedAt: null }),
    "alertmanager-alerts": rec<readonly AlertmanagerAlert[]>([]),
    "alertmanager-silences": rec<readonly AlertmanagerSilence[]>([]),
    "alertmanager-status": rec<AlertmanagerStatus>({ version: "0.27.0", uptime: null, cluster: { status: "ready", peerCount: null } }),
    "alertmanager-receivers": rec<readonly AlertmanagerReceiver[]>([]),
    "vmalert-rules": rec<readonly VmalertRuleGroup[]>([]),
    "gatus-statuses": rec<readonly GatusEndpointState[]>([]),
    "grafana-health": rec<GrafanaHealth>({ database: "ok", version: "11.4.0" }),
  };
  return {
    model,
    coverage: makeWebCoverageArtifact(model),
    findings: makeWebFindingsArtifact(model.bundleId),
    records,
    appVersion: "test-1.0.0",
    observedAt: "2026-09-17T06:00:00.000Z",
  };
}

describe("current-route body budgets (envelope)", () => {
  const routeByView: Record<Exclude<ViewId, "overview">, RouteDefinition> = {
    alerts: alertsRoute,
    estate: estateRoute,
    engine: engineRoute,
    timeline: timelineRoute,
  };
  const pathByView: Record<ViewId, string> = {
    overview: "/api/overview",
    alerts: "/api/alerts",
    estate: "/api/estate",
    engine: "/api/engine",
    timeline: "/api/timeline",
  };

  test("every current route serves ≤5 MiB plain and ≤1 MiB gzip for a 100-host/300-service estate", async () => {
    const built = await buildCycleCandidate(null, observation(), envelopeInputs());
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(`envelope cycle failed: ${built.error.kind}/${built.error.view}`);
    const cycle = built.cycle;

    for (const view of ["overview", "alerts", "estate", "engine", "timeline"] as const) {
      const payload = cycle[view];
      // eslint-disable-next-line no-console
      console.log(`[repr] view=${view} plain=${payload.plain.bytes.byteLength}B gzip=${payload.gzip.bytes.byteLength}B`);
      expect(payload.plain.bytes.byteLength).toBeLessThanOrEqual(CURRENT_MAX_PLAIN_BYTES);
      expect(payload.gzip.bytes.byteLength).toBeLessThanOrEqual(CURRENT_MAX_GZIP_BYTES);

      const route = view === "overview" ? overviewRoute : routeByView[view];
      // Plain response serves the exact retained plain bytes (within the 5 MiB budget).
      const plainRes = await route.handler(routeReq(req(), pathByView[view]), ctxWith({ cycle }));
      expect(plainRes.status).toBe(200);
      const plainBody = new Uint8Array(await plainRes.arrayBuffer());
      expect(plainBody.byteLength).toBe(payload.plain.bytes.byteLength);
      expect(plainBody.byteLength).toBeLessThanOrEqual(CURRENT_MAX_PLAIN_BYTES);

      // Gzip response serves the exact retained gzip bytes (within the 1 MiB budget).
      const gzipRes = await route.handler(routeReq(req({ "accept-encoding": "gzip" }), pathByView[view]), ctxWith({ cycle }));
      expect(gzipRes.headers.get("content-encoding")).toBe("gzip");
      const gzipBody = new Uint8Array(await gzipRes.arrayBuffer());
      expect(gzipBody.byteLength).toBe(payload.gzip.bytes.byteLength);
      expect(gzipBody.byteLength).toBeLessThanOrEqual(CURRENT_MAX_GZIP_BYTES);
    }
  });
});
