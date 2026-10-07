// apps/web/tests/performance.test.ts — envelope cardinality + current-route latency method for
// item 058 (04-cycle-and-current-view-folds.md §13, 11-testing-strategy.md §§3, 7, 10).
//
// Drives the real `createServerRuntime` against on-disk bundles with a routing `fetchImpl` that
// counts upstream calls by category, proving:
//   - a tiny estate and the 100-host/300-service envelope estate issue identical fixed recurring
//     core-source cardinality (no per-entity fan-out);
//   - 0 versus 64 viewers (getContext calls) issue identical recurring cardinality — acquisition is
//     scheduler-driven and getContext never fetches (AC2, apps/web half);
//   - warmed current-route dispatch has a monotonic p95 < 250 ms, with printed methodology (AC4).

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime } from "../src/server/refresh.js";
import { alertsRoute, estateRoute, engineRoute, timelineRoute } from "../src/server/routes/current.js";
import { overviewRoute } from "../src/server/routes/overview.js";
import type { RouteDefinition, RouteRequest } from "../src/shared/registry.js";
import {
  makeWebCoverageArtifact,
  makeWebEstateModelV2,
  makeWebFindingsArtifact,
  serializeArtifact,
} from "./factories/estate-bundle.js";
import type { WebEstateHostV2, WebEstateModelV2, WebEstateServiceV2 } from "@pulse/renderer";

// ── on-disk bundle harness ──────────────────────────────────────────────────────────────────────

let dir: string;
let modelPath: string;
let mtimeSeq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-perf-"));
  modelPath = join(dir, "web-estate-model.json");
  mtimeSeq = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeGeneration(members: { model: string; coverage: string; findings: string }): void {
  const t = new Date(mtimeSeq++);
  writeFileSync(modelPath, members.model);
  writeFileSync(join(dir, "web-coverage.json"), members.coverage);
  writeFileSync(join(dir, "web-findings.json"), members.findings);
  for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
    utimesSync(join(dir, name), t, t);
  }
}

function writeModel(model: WebEstateModelV2): void {
  writeGeneration({
    model: serializeArtifact(model),
    coverage: serializeArtifact(makeWebCoverageArtifact(model)),
    findings: serializeArtifact(makeWebFindingsArtifact(model.bundleId)),
  });
}

function fullEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    PULSE_WEB_ESTATE_MODEL: modelPath,
    ...over,
  };
}

// ── routing fetch (counts calls by category; returns minimal valid bodies) ────────────────────────

type Calls = Record<string, number>;

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function classify(u: URL): string {
  const p = u.pathname;
  const s = u.search;
  if (p === "/api/v1/query") return s.includes("label_replace") ? "data:signals" : "legacy:vm";
  if (p === "/api/v1/targets") return "data:targets";
  if (p === "/api/v1/status/buildinfo") return "data:buildinfo";
  if (p === "/api/v1/rules") return "data:rules";
  if (p === "/api/v2/alerts") return s.includes("silenced=true") ? "data:alerts" : "legacy:am";
  if (p === "/api/v2/silences") return "data:silences";
  if (p === "/api/v2/status") return "data:amstatus";
  if (p === "/api/v2/receivers") return "data:receivers";
  if (p === "/api/v1/endpoints/statuses") return s.includes("pageSize") ? "data:gatus" : "legacy:gatus";
  if (p === "/api/health") return "data:grafana";
  return "unknown";
}

function bodyFor(cat: string): unknown {
  switch (cat) {
    case "data:signals":
    case "legacy:vm":
      return { status: "success", data: { resultType: "vector", result: [] } };
    case "data:targets":
      return { status: "success", data: { activeTargets: [] } };
    case "data:buildinfo":
      return { status: "success", data: { version: "1.102.1" } };
    case "data:rules":
      return { status: "success", data: { groups: [] } };
    case "data:amstatus":
      return { versionInfo: { version: "0.27.0" }, cluster: { status: "ready" } };
    case "data:grafana":
      return { database: "ok", version: "11.4.0" };
    default:
      return []; // alerts, silences, receivers, gatus (both tiers)
  }
}

function makeRouter(calls: Calls): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input.toString());
    const cat = classify(u);
    calls[cat] = (calls[cat] ?? 0) + 1;
    return jsonOk(bodyFor(cat));
  };
  return impl as unknown as typeof fetch;
}

/** The six fixed core operations that must run once per cycle, independent of size/viewers. */
const CORE_CATS = ["data:signals", "data:targets", "data:alerts", "data:silences", "data:rules", "data:gatus"] as const;

/** The slow-tier operations. They are due on the first cycle (no prior records to reuse), so a single
 *  `runOnce` fires buildinfo/amstatus/receivers exactly once; grafana is unconfigured here → zero. Like
 *  the core tier, none of these fan out per host/service or per viewer. */
const SLOW_CATS = ["data:buildinfo", "data:amstatus", "data:receivers", "data:grafana"] as const;

// ── estate builders ───────────────────────────────────────────────────────────────────────────

/** A genuinely tiny 1-host / 1-service estate. */
function tinyModel(): WebEstateModelV2 {
  const base = makeWebEstateModelV2();
  const host = base.hosts.find((h) => h.collectionClass === "managed-linux") ?? base.hosts[0]!;
  const svc = base.services[0]!;
  // Drop baseline suppressions/overrides — they reference entities not in this reduced estate.
  return { ...base, hosts: [host], services: [{ ...svc, host: host.name }], suppressions: [], routingOverrides: [] };
}

/** The 100-host / 300-service envelope estate. */
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

function coreCounts(calls: Calls): Record<string, number> {
  return Object.fromEntries(CORE_CATS.map((c) => [c, calls[c] ?? 0]));
}

function slowCounts(calls: Calls): Record<string, number> {
  return Object.fromEntries(SLOW_CATS.map((c) => [c, calls[c] ?? 0]));
}

// ── AC2 (apps/web half): fixed recurring cardinality ─────────────────────────────────────────────

describe("recurring source-call cardinality (§3, 04 §13)", () => {
  test("a tiny estate and the 100/300 envelope estate issue identical fixed core cardinality", async () => {
    writeModel(tinyModel());
    const tinyCalls: Calls = {};
    const tiny = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(tinyCalls),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await tiny.runOnce();
    expect(tiny.getContext(null).cycle).not.toBeNull();
    tiny.close();

    writeModel(envelopeModel());
    const bigCalls: Calls = {};
    const big = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(bigCalls),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await big.runOnce();
    expect(big.getContext(null).cycle).not.toBeNull(); // the 100/300 bundle loaded and published
    big.close();

    // eslint-disable-next-line no-console
    console.log(`[perf] cardinality tiny=${JSON.stringify(coreCounts(tinyCalls))} envelope=${JSON.stringify(coreCounts(bigCalls))}`);
    for (const c of CORE_CATS) {
      expect(tinyCalls[c]).toBe(1);
      expect(bigCalls[c]).toBe(tinyCalls[c]); // identical — no per-host/per-service fan-out
    }

    // The slow tier is due on the first cycle and is likewise size-independent: buildinfo/amstatus/
    // receivers fire exactly once and grafana (unconfigured) never fires, for both estates.
    // eslint-disable-next-line no-console
    console.log(`[perf] slow tiny=${JSON.stringify(slowCounts(tinyCalls))} envelope=${JSON.stringify(slowCounts(bigCalls))}`);
    for (const c of SLOW_CATS) {
      const expected = c === "data:grafana" ? 0 : 1;
      expect(tinyCalls[c] ?? 0).toBe(expected);
      expect(bigCalls[c] ?? 0).toBe(tinyCalls[c] ?? 0); // identical slow cardinality regardless of estate size
    }
  });

  test("0 versus 64 viewers issue identical recurring cardinality; getContext never fetches", async () => {
    writeModel(makeWebEstateModelV2());

    // 0 viewers: one cycle, count the core calls.
    const zeroCalls: Calls = {};
    const zero = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(zeroCalls),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await zero.runOnce();
    zero.close();

    // 64 viewers: attach 64 getContext consumers, then run one cycle.
    const manyCalls: Calls = {};
    const many = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(manyCalls),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    for (let i = 0; i < 64; i += 1) many.getContext(null);
    // getContext alone triggers no upstream acquisition — no cycle has run yet.
    const totalBeforeCycle = Object.values(manyCalls).reduce((a, b) => a + b, 0);
    expect(totalBeforeCycle).toBe(0);
    await many.runOnce();
    for (let i = 0; i < 64; i += 1) many.getContext(null);
    many.close();

    // eslint-disable-next-line no-console
    console.log(`[perf] viewers 0=${JSON.stringify(coreCounts(zeroCalls))} 64=${JSON.stringify(coreCounts(manyCalls))}`);
    for (const c of CORE_CATS) {
      expect(zeroCalls[c]).toBe(1);
      expect(manyCalls[c]).toBe(zeroCalls[c]); // viewers do not change recurring source cardinality
    }

    // The slow tier is likewise viewer-independent — attaching 64 getContext consumers changes no
    // recurring source cardinality (acquisition is scheduler-driven, never viewer-driven).
    // eslint-disable-next-line no-console
    console.log(`[perf] slow viewers 0=${JSON.stringify(slowCounts(zeroCalls))} 64=${JSON.stringify(slowCounts(manyCalls))}`);
    for (const c of SLOW_CATS) {
      const expected = c === "data:grafana" ? 0 : 1;
      expect(zeroCalls[c] ?? 0).toBe(expected);
      expect(manyCalls[c] ?? 0).toBe(zeroCalls[c] ?? 0); // identical slow cardinality regardless of viewers
    }
  });
});

// ── AC4: warmed current-route latency (monotonic p95 < 250 ms, printed method) ────────────────────

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://web:8080/api/overview", { method: "GET", headers });
}

function routeReq(request: Request, path: string): RouteRequest {
  return { request, params: {}, routePattern: path, peerIp: null, disableTimeout() {} };
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

describe("warmed current-route latency (11 §§7, 10)", () => {
  test("dispatch p95 across all five current routes is < 250 ms over ≥100 samples", async () => {
    writeModel(makeWebEstateModelV2());
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await runtime.runOnce();
    const ctx = runtime.getContext(null);
    expect(ctx.cycle).not.toBeNull();

    const routes: readonly { route: RouteDefinition; path: string }[] = [
      { route: overviewRoute, path: "/api/overview" },
      { route: alertsRoute, path: "/api/alerts" },
      { route: estateRoute, path: "/api/estate" },
      { route: engineRoute, path: "/api/engine" },
      { route: timelineRoute, path: "/api/timeline" },
    ];

    // Warm-up: dispatch each route a few times (representation bytes are retained, not reserialized).
    for (let w = 0; w < 10; w += 1) {
      for (const { route, path } of routes) await route.handler(routeReq(req(), path), ctx);
    }

    const SAMPLE_COUNT = 200;
    const samples: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const { route, path } = routes[i % routes.length]!;
      const start = performance.now();
      const res = await route.handler(routeReq(req(), path), ctx);
      samples.push(performance.now() - start);
      expect(res.status).toBe(200); // served from the published cycle
    }

    const p = p95(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] method=current-route-dispatch bun=${Bun.version} host=${process.platform}/${process.arch} ` +
        `count=${SAMPLE_COUNT} p95=${p.toFixed(3)}ms`,
    );
    expect(samples.length).toBe(SAMPLE_COUNT);
    expect(p).toBeLessThan(250);
    runtime.close();
  });
});
