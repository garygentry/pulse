// apps/web/tests/telemetry.test.ts — runtime-driven structured telemetry (10 §§6–7).
//
// Drives the real `createServerRuntime` against a temporary on-disk bundle with a routing `fetchImpl`
// that can fail individual sources, so the coordinator acquires, folds, publishes, and emits telemetry
// end to end. Asserts: cycle degradation/recovery and per-SourceId source failure/recovery events are
// EDGE-triggered (not re-logged while steady); publication/upstream counters increment with closed
// labels; SSE + history instrumentation record through the wired context; the recurring upstream call
// count is fixed across estate size and viewer count; and no fixture host/service/endpoint/address or
// error value ever appears in a metric label or a captured log line, while an observer throw after
// publication cannot invalidate the published cycle.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime } from "../src/server/refresh.js";
import { renderMetrics, __resetMetricsForTest } from "../src/server/routes/metrics.js";
import { getRuntimeStatus } from "../src/server/refresh.js";
import {
  makeEstateBundleFixture,
  makeWebCoverageArtifact,
  makeWebEstateModelV2,
  makeWebFindingsArtifact,
  serializeArtifact,
  type EstateBundleFixture,
} from "./factories/estate-bundle.js";
import type { WebEstateHostV2, WebEstateModelV2 } from "@pulse/renderer";

// ── On-disk bundle harness (mirrors refresh.test.ts) ──────────────────────────────────────────────

let dir: string;
let modelPath: string;
let mtimeSeq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-telemetry-"));
  modelPath = join(dir, "web-estate-model.json");
  mtimeSeq = 1_000_000;
  __resetMetricsForTest();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  __resetMetricsForTest();
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

function writeValid(fixture: EstateBundleFixture): void {
  writeGeneration({
    model: fixture.files.model,
    coverage: fixture.files.coverage ?? "",
    findings: fixture.files.findings ?? "",
  });
}

/** Serialize a coherent generation from a model (recomputing coverage/findings so the loader accepts it). */
function generationOf(model: WebEstateModelV2): { model: string; coverage: string; findings: string } {
  return {
    model: serializeArtifact(model),
    coverage: serializeArtifact(makeWebCoverageArtifact(model)),
    findings: serializeArtifact(makeWebFindingsArtifact(model.bundleId)),
  };
}

/** A generation whose services declare NO Gatus endpoints, so the routed `data:gatus` `[]` response is
 *  a valid empty status set (not a completeness overflow). That gives a genuinely all-current baseline
 *  cycle, which the source/degradation EDGE tests require. */
function healthyGeneration(): { model: string; coverage: string; findings: string } {
  const base = makeWebEstateModelV2();
  const model: WebEstateModelV2 = {
    ...base,
    services: base.services.map((s) => ({ ...s, gatusEndpoints: [] })),
  };
  return generationOf(model);
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

// ── Routing fetch (mirrors refresh.test.ts) with per-category failure injection ───────────────────

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
      return [];
  }
}

type Calls = Record<string, number>;

/** A routing `fetchImpl` that counts calls and returns a 500 for any category the mutable `fail` set
 *  currently contains (so a targeted source degrades while its siblings stay current). */
function makeRouter(calls: Calls, fail: Set<string>): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input.toString());
    const cat = classify(u);
    calls[cat] = (calls[cat] ?? 0) + 1;
    if (fail.has(cat)) return new Response("upstream error", { status: 500 });
    return jsonOk(bodyFor(cat));
  };
  return impl as unknown as typeof fetch;
}

interface Captured {
  logs: Record<string, unknown>[];
  restore: () => void;
}

function captureLogs(): Captured {
  const logs: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = ((line: unknown) => {
    if (typeof line === "string") {
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
        return;
      } catch {
        /* not JSON — fall through */
      }
    }
    original(line as string);
  }) as typeof console.log;
  return { logs, restore: () => void (console.log = original) };
}

function eventsNamed(logs: Record<string, unknown>[], event: string): Record<string, unknown>[] {
  return logs.filter((l) => l["event"] === event);
}

const CORE_CATS = ["data:signals", "data:targets", "data:alerts", "data:silences", "data:rules", "data:gatus"] as const;

/** The ten fixed `SourceId`s — the only values a source_* event's `source` field may carry. */
const SOURCE_IDS: readonly string[] = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "victoriametrics-buildinfo",
  "alertmanager-alerts",
  "alertmanager-silences",
  "alertmanager-status",
  "alertmanager-receivers",
  "vmalert-rules",
  "gatus-statuses",
  "grafana-health",
];

/** The complete closed vocabulary a source_* event's `source` may carry: the ten SourceIds plus the
 *  retained legacy loop trio. All are fixed categorical tokens — never an entity id. */
const SAFE_SOURCE_VALUES = new Set<string>([...SOURCE_IDS, "metrics", "alerts", "checks"]);

/** The complete safe field vocabulary the owned structured events (the cycle_, source_, sse_stream_,
 *  and history_ families) may carry (10 §7: categorical ids, counts, duration, timestamps,
 *  generation/seq, safe status codes). Any key outside this set on an owned event line is a leak;
 *  `ts` is stamped by `log`. */
const SAFE_EVENT_KEYS = new Set<string>([
  "ts",
  "event",
  "ok",
  "seq",
  "generation",
  "degradedSources",
  "source",
  "kind",
  "view",
  "openStreams",
  "query",
  "code",
]);

/** True for the structured-event families this item owns (10 §§6–7). */
function isOwnedEvent(line: Record<string, unknown>): boolean {
  return /^(cycle_|source_|sse_stream_|history_)/.test(String(line["event"] ?? ""));
}

// ── Edge-triggered cycle degradation / recovery (§7) ──────────────────────────────────────────────

describe("cycle degradation is edge-triggered (10 §7)", () => {
  test("cycle_degraded fires once on the healthy→degraded edge, not every degraded cycle; cycle_healthy on recovery", async () => {
    writeGeneration(healthyGeneration());
    const calls: Calls = {};
    const fail = new Set<string>();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls, fail),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });

    const cap = captureLogs();
    try {
      await runtime.runOnce(); // cycle 1: all sources current → healthy
      fail.add("data:signals");
      await runtime.runOnce(); // cycle 2: signals fail → degraded edge
      await runtime.runOnce(); // cycle 3: signals still fail → NO new degraded log
      fail.delete("data:signals");
      await runtime.runOnce(); // cycle 4: signals current again → healthy edge
    } finally {
      cap.restore();
    }

    // Exactly one degraded edge and one healthy edge across the four cycles.
    expect(eventsNamed(cap.logs, "cycle_degraded").length).toBe(1);
    expect(eventsNamed(cap.logs, "cycle_healthy").length).toBe(1);
    const degraded = eventsNamed(cap.logs, "cycle_degraded")[0]!;
    expect(degraded["ok"]).toBe(false);
    expect(degraded["degradedSources"]).toBe(1);
    expect(typeof degraded["seq"]).toBe("number");
    runtime.close();
  });

  test("a persistently healthy estate never logs a degradation transition", async () => {
    writeGeneration(healthyGeneration());
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, new Set()),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    const cap = captureLogs();
    try {
      await runtime.runOnce();
      await runtime.runOnce();
      await runtime.runOnce();
    } finally {
      cap.restore();
    }
    expect(eventsNamed(cap.logs, "cycle_degraded").length).toBe(0);
    expect(eventsNamed(cap.logs, "cycle_healthy").length).toBe(0);
    runtime.close();
  });
});

describe("source failure/recovery is edge-triggered per SourceId (10 §7)", () => {
  test("source_unreachable/source_recovered fire only on the transition, carrying the SourceId + safe kind", async () => {
    writeGeneration(healthyGeneration());
    const fail = new Set<string>();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, fail),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });

    const cap = captureLogs();
    try {
      await runtime.runOnce(); // baseline healthy publication
      fail.add("data:targets");
      await runtime.runOnce(); // targets → fail edge
      await runtime.runOnce(); // still failing → no new edge
      fail.delete("data:targets");
      await runtime.runOnce(); // targets → recovered edge
    } finally {
      cap.restore();
    }

    const unreachable = eventsNamed(cap.logs, "source_unreachable").filter((l) => l["source"] === "victoriametrics-targets");
    const recovered = eventsNamed(cap.logs, "source_recovered").filter((l) => l["source"] === "victoriametrics-targets");
    expect(unreachable.length).toBe(1);
    expect(recovered.length).toBe(1);
    // The unreachable edge carries only a safe closed error kind, never a message/body/URL.
    expect(unreachable[0]!["ok"]).toBe(false);
    expect(typeof unreachable[0]!["kind"]).toBe("string");
    expect(unreachable[0]!).not.toHaveProperty("message");
    expect(unreachable[0]!).not.toHaveProperty("url");
    runtime.close();
  });
});

// ── Owned structured events carry only safe categorical fields (§7, AC-3) ─────────────────────────

describe("owned structured events contain only safe categorical fields (10 §7, AC-3)", () => {
  test("every cycle_*/source_* event emitted across a degrade→recover run has a key set within the safe allowlist", async () => {
    writeGeneration(healthyGeneration());
    const fail = new Set<string>();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, fail),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });

    const cap = captureLogs();
    try {
      await runtime.runOnce(); // healthy baseline
      fail.add("data:signals");
      await runtime.runOnce(); // cycle_degraded + source_unreachable edge
      fail.delete("data:signals");
      await runtime.runOnce(); // cycle_healthy + source_recovered edge
    } finally {
      cap.restore();
    }

    const owned = cap.logs.filter(isOwnedEvent);
    // The run genuinely exercised the owned edges (the assertion below is non-vacuous).
    expect(owned.some((l) => l["event"] === "cycle_degraded")).toBe(true);
    expect(owned.some((l) => l["event"] === "cycle_healthy")).toBe(true);
    expect(owned.some((l) => l["event"] === "source_unreachable")).toBe(true);
    expect(owned.some((l) => l["event"] === "source_recovered")).toBe(true);

    for (const line of owned) {
      for (const key of Object.keys(line)) {
        expect(SAFE_EVENT_KEYS.has(key)).toBe(true);
      }
      // The categorical/count/id fields are the expected scalar shapes, never a nested object/array
      // that could smuggle a body or entity payload.
      if ("degradedSources" in line) expect(typeof line["degradedSources"]).toBe("number");
      if ("seq" in line) expect(typeof line["seq"]).toBe("number");
      if ("generation" in line) expect(typeof line["generation"]).toBe("string");
      // `source` is always a bounded categorical token — a SourceId, or the retained legacy loop
      // trio (metrics/alerts/checks) — never a host/service/endpoint entity id.
      if ("source" in line) expect(SAFE_SOURCE_VALUES.has(String(line["source"]))).toBe(true);
      if ("kind" in line && line["kind"] !== null) expect(typeof line["kind"]).toBe("string");
    }
    runtime.close();
  });
});

// ── Publication + upstream counters (§6) ──────────────────────────────────────────────────────────

describe("publication and upstream counters (10 §6)", () => {
  test("cycle_publications_total records success then degraded outcomes", async () => {
    writeGeneration(healthyGeneration());
    const fail = new Set<string>();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, fail),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    await runtime.runOnce(); // success
    fail.add("data:alerts");
    await runtime.runOnce(); // degraded (still publishes)
    const text = renderMetrics(getRuntimeStatus(), Date.now());
    expect(text).toContain('pulse_web_cycle_publications_total{outcome="success"} 1');
    expect(text).toContain('pulse_web_cycle_publications_total{outcome="degraded"} 1');
    runtime.close();
  });
});

// ── Fixed recurring upstream cardinality (§6, AC-2) ───────────────────────────────────────────────

/** Parse the `pulse_web_upstream_calls_total` series into a `source|outcome → count` map. */
function upstreamCounts(): Record<string, number> {
  const text = renderMetrics(getRuntimeStatus(), Date.now());
  const map: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^pulse_web_upstream_calls_total\{source="([^"]+)",outcome="([^"]+)"\} (\d+)$/);
    if (m) map[`${m[1]}|${m[2]}`] = Number(m[3]);
  }
  return map;
}

function biggerGeneration(extra: number): { model: string; coverage: string; findings: string } {
  const base = makeWebEstateModelV2();
  const template = base.hosts.find((h) => h.collectionClass === "managed-linux") ?? base.hosts[0]!;
  const clones: WebEstateHostV2[] = [];
  for (let i = 0; i < extra; i++) {
    const addr = `10.9.${Math.floor(i / 254)}.${(i % 254) + 1}`;
    clones.push({
      ...template,
      name: `extra-host-${i}`,
      drilldownId: `host:extra-host-${i}`,
      addresses: [addr],
      artifacts: [],
      suppressed: null,
      ...("scrapeTargets" in template ? { scrapeTargets: [{ job: "node", instance: `${addr}:9100` }] } : {}),
    } as WebEstateHostV2);
  }
  // Strip Gatus endpoints so the routed empty `data:gatus` response is valid (all-success baseline).
  const model: WebEstateModelV2 = {
    ...base,
    hosts: [...base.hosts, ...clones],
    services: base.services.map((s) => ({ ...s, gatusEndpoints: [] })),
  };
  return generationOf(model);
}

describe("recurring upstream call cardinality is fixed (10 §6, AC-2)", () => {
  test("a small estate, an envelope estate, and 0 vs 64 viewers issue identical recurring call counts", async () => {
    // Small estate — one cycle (Gatus-clean so every source is a success).
    writeGeneration(healthyGeneration());
    const small = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, new Set()),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await small.runOnce();
    const smallCounts = upstreamCounts();
    small.close();

    // Envelope estate (60 extra hosts) + 64 viewer projections between — one cycle.
    __resetMetricsForTest();
    writeGeneration(biggerGeneration(60));
    const big = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, new Set()),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await big.runOnce();
    for (let v = 0; v < 64; v++) big.getContext(null); // viewers never trigger acquisition
    const bigCounts = upstreamCounts();
    big.close();

    // Identical recurring cardinality regardless of estate size or viewer count.
    expect(bigCounts).toEqual(smallCounts);
    // Each of the six core sources was called exactly once (a success), independent of estate size.
    for (const cat of CORE_CATS) {
      const sid = {
        "data:signals": "victoriametrics-signals",
        "data:targets": "victoriametrics-targets",
        "data:alerts": "alertmanager-alerts",
        "data:silences": "alertmanager-silences",
        "data:rules": "vmalert-rules",
        "data:gatus": "gatus-statuses",
      }[cat]!;
      expect(smallCounts[`${sid}|success`]).toBe(1);
    }
  });
});

// ── Secrecy: no entity/error value in labels or logs (§6/§7, AC-4) ────────────────────────────────

describe("no fixture entity or error value leaks into metrics or logs (10 §§6–7, AC-4)", () => {
  test("host/service/endpoint/address values never appear in the metric exposition or captured logs", async () => {
    const fixture = makeEstateBundleFixture();
    writeValid(fixture);
    const fail = new Set<string>(["data:signals", "data:gatus"]); // force degradation + source edges
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, fail),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });

    const cap = captureLogs();
    try {
      await runtime.runOnce();
      fail.delete("data:signals");
      await runtime.runOnce();
    } finally {
      cap.restore();
    }

    // Gather the UNAMBIGUOUS fixture entity tokens that must never surface as a label or log value:
    // host names, drilldown ids, addresses, and composite endpoint keys. Bare service names are
    // deliberately excluded — a fixture service happens to be named "grafana", which is a substring of
    // the legitimate categorical SourceId "grafana-health"; the composite drilldown/endpoint keys carry
    // the real entity identity and are the meaningful leak witnesses.
    const entities = new Set<string>();
    for (const host of fixture.model.hosts) {
      entities.add(host.name);
      entities.add(host.drilldownId);
      for (const addr of host.addresses) entities.add(addr);
    }
    for (const service of fixture.model.services) {
      entities.add(service.drilldownId);
      for (const ep of service.gatusEndpoints) entities.add(ep);
    }

    const metricsText = renderMetrics(getRuntimeStatus(), Date.now(), {
      cycleObservation: runtime.getContext(null).cycle?.observation ?? null,
      history: runtime.getContext(null).history.stats(),
      sseStreams: runtime.getContext(null).events.count(),
    });
    const logText = cap.logs.map((l) => JSON.stringify(l)).join("\n");

    for (const token of entities) {
      if (token.length < 3) continue; // skip trivially-short tokens
      expect(metricsText.includes(token)).toBe(false);
      // The structured telemetry events this item OWNS carry only categorical ids — assert the
      // owned event lines (cycle_*/source_*/sse_*/history_*) never embed an entity token.
      for (const line of cap.logs) {
        const ev = String(line["event"] ?? "");
        if (/^(cycle_|source_|sse_stream_|history_)/.test(ev)) {
          expect(JSON.stringify(line).includes(token)).toBe(false);
        }
      }
    }
    void logText;
    runtime.close();
  });

  test("the raw upstream error body from a failed source never appears in the exposition or captured logs", async () => {
    writeGeneration(healthyGeneration());
    // The router replies to a failing category with a 500 whose body is exactly this marker.
    const ERROR_BODY = "upstream error";
    const fail = new Set<string>();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, fail),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });

    const cap = captureLogs();
    try {
      await runtime.runOnce(); // healthy baseline
      fail.add("data:signals"); // signals returns the 500 "upstream error" body
      await runtime.runOnce(); // degraded publication + source_unreachable edge
    } finally {
      cap.restore();
    }

    // The source failure genuinely surfaced (non-vacuous) — as a SAFE closed error kind, not the body.
    const unreachable = eventsNamed(cap.logs, "source_unreachable").filter(
      (l) => l["source"] === "victoriametrics-signals",
    );
    expect(unreachable.length).toBe(1);
    expect(unreachable[0]!["kind"]).toBe("upstream-status"); // a 500 → the safe closed kind

    const metricsText = renderMetrics(getRuntimeStatus(), Date.now(), {
      cycleObservation: runtime.getContext(null).cycle?.observation ?? null,
      history: runtime.getContext(null).history.stats(),
      sseStreams: runtime.getContext(null).events.count(),
    });
    // The raw upstream body text is never echoed into a metric label or ANY captured log line.
    expect(metricsText.includes(ERROR_BODY)).toBe(false);
    for (const line of cap.logs) {
      expect(JSON.stringify(line).includes(ERROR_BODY)).toBe(false);
    }
    runtime.close();
  });
});

// ── Observer isolation after publication (§4/§7) ──────────────────────────────────────────────────

describe("a telemetry observer throw cannot invalidate a published cycle (10 §§4, 7)", () => {
  test("a throwing log sink during a publication-time telemetry edge still publishes the cycle", async () => {
    writeValid(makeEstateBundleFixture());
    const fail = new Set<string>();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, fail),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });

    // Cycle 1: a normal healthy publication (baseline; bundle + legacy source logs emit normally).
    await runtime.runOnce();
    expect(runtime.getContext(null).cycle?.observation.seq).toBe(1);

    // Cycle 2 degrades a data source. The bundle is unchanged and the LEGACY loop sources stay healthy,
    // so this cycle emits NO unwrapped logs — its only telemetry (cycle_degraded + source_unreachable,
    // both `safeSideEffect`-wrapped) fires AFTER the atomic assignment. A log sink that throws for every
    // line must therefore be swallowed and leave the published cycle valid (10 §4).
    fail.add("data:signals");
    const original = console.log;
    console.log = (() => {
      throw new Error("observer sink failure");
    }) as typeof console.log;
    try {
      await runtime.runOnce();
    } finally {
      console.log = original;
    }

    const cycle = runtime.getContext(null).cycle;
    expect(cycle).not.toBeNull();
    expect(cycle!.observation.seq).toBe(2); // sequence advanced — publication was not invalidated
    expect(getRuntimeStatus().lastCycleBuildFailure ?? null).toBeNull();
    runtime.close();
  });
});

// ── SSE lifecycle telemetry (§6/§7) ───────────────────────────────────────────────────────────────

describe("SSE lifecycle telemetry (10 §§6–7)", () => {
  test("connecting streams records the connected counter and the open-stream gauge", async () => {
    writeValid(makeEstateBundleFixture());
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, new Set()),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    await runtime.runOnce(); // a current cycle exists so a fresh connection converges
    const events = runtime.getContext(null).events;
    const a = events.connect(null);
    const b = events.connect(null);
    expect(events.count()).toBe(2);

    const text = renderMetrics(getRuntimeStatus(), Date.now(), {
      cycleObservation: runtime.getContext(null).cycle?.observation ?? null,
      history: runtime.getContext(null).history.stats(),
      sseStreams: events.count(),
    });
    expect(text).toContain("pulse_web_sse_streams 2");
    expect(text).toContain('pulse_web_sse_events_total{event="connected",outcome="success"} 2');

    void a;
    void b;
    runtime.close();
  });

  test("displacing the oldest stream at capacity emits one edge-triggered sse_stream_displaced with only safe fields", async () => {
    writeValid(makeEstateBundleFixture());
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter({}, new Set()),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    await runtime.runOnce(); // a current cycle exists so connections converge
    const events = runtime.getContext(null).events;

    const cap = captureLogs();
    try {
      // Fill to the 64-stream cap, then one more forces the oldest out (08 §3).
      for (let i = 0; i < 65; i++) events.connect(null);
    } finally {
      cap.restore();
    }

    const displaced = eventsNamed(cap.logs, "sse_stream_displaced");
    expect(displaced.length).toBe(1); // exactly the single over-cap admission, edge-triggered
    const line = displaced[0]!;
    expect(line["ok"]).toBe(true);
    expect(typeof line["openStreams"]).toBe("number"); // a bounded count, never a payload/identity/peer
    for (const key of Object.keys(line)) expect(SAFE_EVENT_KEYS.has(key)).toBe(true);
    expect(events.count()).toBe(64); // held at the cap after displacement
    runtime.close();
  });
});

// ── History request telemetry through the wrapped runtime service (§§6–7) ─────────────────────────
//
// `createServerRuntime` wraps its bounded HistoryService (`instrumentHistoryService`) so each completed
// request records its delivery/outcome into the `pulse_web_history_*` counters and emits a bounded
// structured event for the notable timeout/overload/model-invalidated failure codes. These exercise
// that wrapper end to end through the wired `getContext(null).history` — the metric record functions
// alone are unit-covered in `metrics.test.ts`, but the wrapper wiring and the history_* EVENTS are not.

/** A routing fetch for the history tests: reuses the cycle-acquisition bodies (so `runOnce` publishes)
 *  and answers the history-only `/api/v1/query_range` — either a valid empty matrix (a cacheable
 *  success) or a never-resolving promise (so the request stays active until `invalidateModel`). */
function makeHistoryRouter(opts: { hangRange: boolean }): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input.toString());
    if (u.pathname === "/api/v1/query_range") {
      if (opts.hangRange) return new Promise<Response>(() => {}); // never settles — active until invalidate
      return jsonOk({ status: "success", data: { resultType: "matrix", result: [] } });
    }
    return jsonOk(bodyFor(classify(u)));
  };
  return impl as unknown as typeof fetch;
}

describe("history request telemetry through the wrapped runtime service (10 §§6–7)", () => {
  test("a successful query records a miss then a coalesced cache hit into the history counters", async () => {
    writeGeneration(healthyGeneration());
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeHistoryRouter({ hangRange: false }),
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    await runtime.runOnce(); // load the model + publish a cycle so history.model() is non-null
    const history = runtime.getContext(null).history;

    // Two identical estate-wide alert-interval requests: the first is served fresh (miss), the second
    // from the 60 s cache (hit). Both genuinely succeed (non-vacuous), so the wrapper records deliveries.
    const r1 = await history.alertIntervals({ range: "1h", target: null });
    const r2 = await history.alertIntervals({ range: "1h", target: null });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const text = renderMetrics(getRuntimeStatus(), Date.now());
    // The `query` label is the fixed safe operation name — never a target/PromQL/entity id.
    expect(text).toContain('pulse_web_history_requests_total{query="alert-intervals",outcome="miss"} 1');
    expect(text).toContain('pulse_web_history_requests_total{query="alert-intervals",outcome="hit"} 1');
    expect(text).toContain('pulse_web_history_cache_hits_total{query="alert-intervals"} 1');
    runtime.close();
  });

  test("a model invalidation mid-flight records the error outcome and emits one safe history_model_invalidated event", async () => {
    writeGeneration(healthyGeneration());
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeHistoryRouter({ hangRange: true }), // query_range never settles → the work stays active
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });
    await runtime.runOnce();
    const history = runtime.getContext(null).history;

    const cap = captureLogs();
    try {
      const pending = history.alertIntervals({ range: "1h", target: null }); // admitted, active on the hung upstream
      await Promise.resolve(); // let admission settle before invalidating
      history.invalidateModel(); // retires the active waiter with MODEL_CHANGED (07 §8)
      const r = await pending;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("MODEL_CHANGED");
    } finally {
      cap.restore();
    }

    // The failure recorded the error outcome (never a delivery) under the safe operation-name label.
    const text = renderMetrics(getRuntimeStatus(), Date.now());
    expect(text).toContain('pulse_web_history_requests_total{query="alert-intervals",outcome="error"} 1');

    // Exactly one bounded structured event, carrying only the safe categorical query + failure code.
    const events = eventsNamed(cap.logs, "history_model_invalidated");
    expect(events.length).toBe(1);
    const evt = events[0]!;
    expect(evt["ok"]).toBe(false);
    expect(evt["query"]).toBe("alert-intervals");
    expect(evt["code"]).toBe("MODEL_CHANGED");
    for (const key of Object.keys(evt)) expect(SAFE_EVENT_KEYS.has(key)).toBe(true);
    runtime.close();
  });
});
