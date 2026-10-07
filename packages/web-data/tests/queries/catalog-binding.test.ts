// catalog-binding.test.ts — evidence for the curated query catalog, ranges, and binder
// (06-curated-query-catalog.md). Covers: the frozen 14-entry catalog and catalog-derived
// timeline metadata; deterministic binder errors for unknown query/target, wrong kind,
// ambiguity, invalid metric name, malformed input, and unsupported range; pinned
// server-authored PromQL with injection-safe exact-match escaping; and the four fixed
// ranges plus the 598-denominator step reserving the 600-point boundary.
//
// Package test files are not typechecked (no tsconfig includes packages/web-data/tests),
// so model fixtures are built as plain objects and cast, and every closedness/shape claim
// is made at runtime (progress.md, items 005/012).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { ERROR_MESSAGES } from "../../src/wire/common.js";
import {
  QUERY_CATALOG,
  QUERY_IDS,
  isQueryId,
  queryIdsForTargetKind,
  type CuratedQueryDefinition,
} from "../../src/queries/catalog.js";
import {
  RANGE_IDS,
  RANGE_SECONDS,
  acceptedRangesForQuery,
  effectiveStepSeconds,
  parseRange,
} from "../../src/queries/ranges.js";
import { bindCuratedQuery, escapePrometheusLabelValue } from "../../src/queries/binding.js";

// ---------------------------------------------------------------------------
// Model fixtures (minimal WebEstateModelV2 subset used by the binder)
// ---------------------------------------------------------------------------

function hostV2(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "web01",
    collectionClass: "managed-linux",
    addresses: [],
    suppressed: null,
    drilldownId: "host:web01",
    expectedChurn: false,
    scrapeIntervalClass: null,
    provenance: { source: "estate.yaml", line: 1 },
    scrapeTargets: [{ job: "node", instance: "10.0.0.1:9100" }],
    artifacts: [],
    detail: { exporterPorts: [], cadvisor: false, heartbeat: false, deliveryForm: "systemd", commandSignals: [] },
    ...over,
  };
}

function serviceV2(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "grafana",
    host: "web01",
    managed: true,
    deepHealth: false,
    suppressed: null,
    drilldownId: "svc:web01/grafana",
    kind: "http",
    provenance: { source: "estate.yaml", line: 1 },
    gatusEndpoints: [],
    artifacts: [],
    deepHealthDetail: null,
    backupFreshness: null,
    alerts: [],
    ...over,
  };
}

function makeModel(over: { hosts?: unknown[]; services?: unknown[] } = {}): any {
  return {
    formatVersion: 2,
    bundleId: "sha256:test",
    estate: { name: "e", domains: [], timezone: "UTC", dnsResolver: null, retention: null, schemaMajor: 1, deadman: { configured: true, kind: "plain" } },
    hosts: over.hosts ?? [hostV2()],
    services: over.services ?? [serviceV2()],
    channels: [],
    routingOverrides: [],
    suppressions: [],
  };
}

const HOST_TARGET = { kind: "host", id: "host:web01" } as const;
const SERVICE_TARGET = { kind: "service", id: "svc:web01/grafana" } as const;

// ---------------------------------------------------------------------------
// Criterion 1 — catalog has exactly 14 entries; timeline metadata derives from it
// ---------------------------------------------------------------------------

describe("QUERY_CATALOG", () => {
  const EXPECTED: ReadonlyArray<[string, CuratedQueryDefinition]> = [
    ["estate.liveness", { id: "estate.liveness", targetKind: "estate", unit: "state", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 }],
    ["alerts.firing", { id: "alerts.firing", targetKind: "estate", unit: "state", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 }],
    ["host.cpu.utilization", { id: "host.cpu.utilization", targetKind: "host", unit: "percent", defaultRange: "1h", maxRange: "7d", preferredStepSeconds: 30 }],
    ["host.memory.utilization", { id: "host.memory.utilization", targetKind: "host", unit: "percent", defaultRange: "1h", maxRange: "7d", preferredStepSeconds: 30 }],
    ["host.disk.utilization", { id: "host.disk.utilization", targetKind: "host", unit: "percent", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 }],
    ["host.load.1m", { id: "host.load.1m", targetKind: "host", unit: "scalar", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 }],
    ["endpoint.check.latency", { id: "endpoint.check.latency", targetKind: "endpoint", unit: "milliseconds", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 }],
    ["service.deep-health", { id: "service.deep-health", targetKind: "service", unit: "scalar", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 }],
    ["service.backup-age", { id: "service.backup-age", targetKind: "service", unit: "seconds", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 }],
    ["engine.ingestion-rate", { id: "engine.ingestion-rate", targetKind: "estate", unit: "count", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 }],
    ["engine.active-series", { id: "engine.active-series", targetKind: "estate", unit: "count", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 }],
    ["engine.disk-usage", { id: "engine.disk-usage", targetKind: "estate", unit: "bytes", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 }],
    ["engine.notification-failures", { id: "engine.notification-failures", targetKind: "estate", unit: "count", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 }],
    ["engine.notification-latency", { id: "engine.notification-latency", targetKind: "estate", unit: "seconds", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 }],
  ];

  test("has exactly the 14 specified entries with exact metadata and order", () => {
    expect(QUERY_IDS.length).toBe(14);
    expect<readonly string[]>(QUERY_IDS).toEqual(EXPECTED.map(([id]) => id));
    for (const [id, def] of EXPECTED) {
      expect(QUERY_CATALOG[id as keyof typeof QUERY_CATALOG]).toEqual(def);
    }
  });

  test("QUERY_IDS is derived from the object, not a duplicate literal", () => {
    expect<readonly string[]>(QUERY_IDS).toEqual(Object.keys(QUERY_CATALOG));
  });

  test("every default range does not exceed the max range (valid ordering)", () => {
    for (const id of QUERY_IDS) {
      const def = QUERY_CATALOG[id];
      expect(RANGE_SECONDS[def.defaultRange]).toBeLessThanOrEqual(RANGE_SECONDS[def.maxRange]);
    }
  });

  test("isQueryId narrows only known ids", () => {
    expect(isQueryId("estate.liveness")).toBe(true);
    expect(isQueryId("nope")).toBe(false);
    expect(isQueryId("")).toBe(false);
    expect(isQueryId("toString")).toBe(false); // not a own catalog key
  });

  test("timeline applicable ids derive from the catalog per kind, in catalog order", () => {
    expect(queryIdsForTargetKind("host")).toEqual([
      "estate.liveness",
      "host.cpu.utilization",
      "host.memory.utilization",
      "host.disk.utilization",
      "host.load.1m",
    ]);
    expect(queryIdsForTargetKind("service")).toEqual(["estate.liveness", "service.deep-health", "service.backup-age"]);
    expect(queryIdsForTargetKind("endpoint")).toEqual(["endpoint.check.latency"]);
    // Every applicable id is genuinely of the requested kind (derivation is faithful).
    for (const kind of ["estate", "host", "service", "endpoint"] as const) {
      for (const id of queryIdsForTargetKind(kind)) {
        if (id !== "estate.liveness" || kind === "estate") expect(QUERY_CATALOG[id].targetKind).toBe(kind);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — ranges and the 598-denominator step reserve the 600 boundary
// ---------------------------------------------------------------------------

describe("ranges and point planning", () => {
  test("RANGE_SECONDS is the fixed table and matches the common contract", () => {
    expect(RANGE_SECONDS).toEqual({ "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 });
    expect(RANGE_IDS).toEqual(["1h", "6h", "24h", "7d"]);
  });

  test("effective step is max(preferred, ceil(rangeSeconds/598))", () => {
    expect(effectiveStepSeconds(604800, 60)).toBe(1012); // 7d: ceil(604800/598)=1012
    expect(effectiveStepSeconds(86400, 30)).toBe(145); // 24h: ceil(86400/598)=145
    expect(effectiveStepSeconds(3600, 30)).toBe(30); // 1h: preferred dominates
    expect(effectiveStepSeconds(21600, 60)).toBe(60); // 6h: ceil(21600/598)=37 < 60
  });

  test("no planned response exceeds 600 points including both boundaries", () => {
    for (const id of QUERY_IDS) {
      const def = QUERY_CATALOG[id];
      for (const range of acceptedRangesForQuery(def)) {
        const seconds = RANGE_SECONDS[range];
        const step = effectiveStepSeconds(seconds, def.preferredStepSeconds);
        const points = Math.floor(seconds / step) + 1; // interior + both boundaries
        expect(points).toBeLessThanOrEqual(600);
      }
    }
  });

  test("absent range uses the entry default", () => {
    const def = QUERY_CATALOG["alerts.firing"]; // default 6h
    const r = parseRange(null, def);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.range).toBe("6h");
      expect(r.seconds).toBe(21600);
      expect(r.effectiveStepSeconds).toBe(60);
    }
  });

  test("each of the four ranges is accepted when within max", () => {
    const def = QUERY_CATALOG["alerts.firing"]; // max 7d
    for (const range of RANGE_IDS) {
      const r = parseRange(range, def);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.range).toBe(range);
    }
  });

  test("a known range beyond the max is RANGE_UNSUPPORTED with bounded details", () => {
    const def = QUERY_CATALOG["host.load.1m"]; // max 24h
    const r = parseRange("7d", def);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("RANGE_UNSUPPORTED");
      expect(r.error.message).toBe(ERROR_MESSAGES.RANGE_UNSUPPORTED);
      expect(r.error.details).toEqual({ queryId: "host.load.1m", range: "7d", maxRange: "24h" });
    }
  });

  test("an unknown/malformed range value is INVALID_REQUEST and omits the value", () => {
    const def = QUERY_CATALOG["host.load.1m"];
    for (const bad of ["2h", "", "1H", "7d ", "0"]) {
      const r = parseRange(bad, def);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_REQUEST");
        expect(r.error.message).toBe(ERROR_MESSAGES.INVALID_REQUEST);
        expect(JSON.stringify(r.error)).not.toContain(bad === "" ? " never" : bad);
      }
    }
  });

  test("acceptedRangesForQuery derives from RANGE_SECONDS and the entry max", () => {
    expect(acceptedRangesForQuery(QUERY_CATALOG["estate.liveness"])).toEqual(["1h", "6h", "24h"]);
    expect(acceptedRangesForQuery(QUERY_CATALOG["alerts.firing"])).toEqual(["1h", "6h", "24h", "7d"]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — deterministic binder errors
// ---------------------------------------------------------------------------

describe("bindCuratedQuery error paths", () => {
  const model = makeModel();

  test("unknown query id is QUERY_NOT_FOUND, checked before target lookup", () => {
    const r = bindCuratedQuery("does.not.exist", { kind: "host", id: "host:absent" }, null, model);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("QUERY_NOT_FOUND");
      expect(r.error.message).toBe(ERROR_MESSAGES.QUERY_NOT_FOUND);
    }
  });

  test("malformed/overlong query id is INVALID_REQUEST", () => {
    for (const bad of ["", "bad id", "x".repeat(513)]) {
      const r = bindCuratedQuery(bad, null, null, model);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    }
  });

  test("unknown target is TARGET_NOT_FOUND", () => {
    const r = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:absent" }, null, model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("TARGET_NOT_FOUND");
  });

  test("wrong target kind is QUERY_NOT_APPLICABLE (host query, service target)", () => {
    const r = bindCuratedQuery("host.load.1m", { kind: "service", id: "svc:web01/grafana" }, null, model);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("QUERY_NOT_APPLICABLE");
      expect(r.error.details).toEqual({ queryId: "host.load.1m", targetKind: "host" });
    }
  });

  test("untargeted estate query with a non-null target is QUERY_NOT_APPLICABLE", () => {
    const r = bindCuratedQuery("alerts.firing", HOST_TARGET, null, model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUERY_NOT_APPLICABLE");
  });

  test("host query with a null target is QUERY_NOT_APPLICABLE", () => {
    const r = bindCuratedQuery("host.load.1m", null, null, model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUERY_NOT_APPLICABLE");
  });

  test("malformed target id (control char) is INVALID_REQUEST", () => {
    const r = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:web 01" }, null, model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
  });

  test("ambiguous duplicate identity is a stable failure, never first-wins", () => {
    const dup = makeModel({ hosts: [hostV2({ drilldownId: "host:dup", name: "a" }), hostV2({ drilldownId: "host:dup", name: "b" })] });
    const r1 = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:dup" }, null, dup);
    const r2 = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:dup" }, null, dup);
    expect(r1.ok).toBe(false);
    expect(r2).toEqual(r1); // deterministic
    if (!r1.ok) expect(r1.error.code).toBe("TARGET_NOT_FOUND");
  });

  test("invalid renderer metric name makes deep-health unavailable (QUERY_NOT_APPLICABLE)", () => {
    const bad = makeModel({
      services: [serviceV2({ drilldownId: "svc:web01/bad", name: "bad", deepHealth: true, deepHealthDetail: { endpoint: "/h", metrics: ["not a metric!"], responseMapping: {}, alertExpression: "", hostLocal: true, credential: null } })],
    });
    const r = bindCuratedQuery("service.deep-health", { kind: "service", id: "svc:web01/bad" }, null, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUERY_NOT_APPLICABLE");
  });

  test("service lacking the queried capability is QUERY_NOT_APPLICABLE", () => {
    // grafana has neither deep-health (false) nor backup freshness (null).
    const dh = bindCuratedQuery("service.deep-health", SERVICE_TARGET, null, model);
    const ba = bindCuratedQuery("service.backup-age", SERVICE_TARGET, null, model);
    expect(dh.ok).toBe(false);
    expect(ba.ok).toBe(false);
    if (!dh.ok) expect(dh.error.code).toBe("QUERY_NOT_APPLICABLE");
    if (!ba.ok) expect(ba.error.code).toBe("QUERY_NOT_APPLICABLE");
  });

  test("unsupported range is RANGE_UNSUPPORTED through the binder", () => {
    const r = bindCuratedQuery("host.load.1m", HOST_TARGET, "7d", model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RANGE_UNSUPPORTED");
  });

  test("every error message is the exact catalog text and details are bounded scalars", () => {
    const r = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:absent" }, null, model);
    if (!r.ok) {
      expect(r.error.message).toBe(ERROR_MESSAGES[r.error.code]);
      if (r.error.details) {
        for (const v of Object.values(r.error.details)) {
          expect(["string", "number", "boolean"].includes(typeof v) || v === null).toBe(true);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 2/3 — successful binds resolve relationships and build pinned PromQL
// ---------------------------------------------------------------------------

describe("bindCuratedQuery success and pinned PromQL", () => {
  const model = makeModel({
    hosts: [hostV2()],
    services: [
      serviceV2({ drilldownId: "svc:web01/dh", name: "dh", deepHealth: true, deepHealthDetail: { endpoint: "/h", metrics: ["camera_count"], responseMapping: { camera_count: "$.n" }, alertExpression: "", hostLocal: true, credential: null }, gatusEndpoints: ["web01/dh"] }),
      serviceV2({ drilldownId: "svc:web01/db", name: "db", backupFreshness: { signal: "backup", threshold: "24h", interval: "15m", hasCommand: true } }),
    ],
  });

  test("estate liveness binds with a null target and pinned query", () => {
    const r = bindCuratedQuery("estate.liveness", null, null, model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.target).toBeNull();
      expect(r.query.unit).toBe("state");
      expect(r.query.range).toBe("1h");
      expect(r.query.effectiveStepSeconds).toBe(30);
      expect(r.query.promql).toBe("min(up or pulse_agent_up or pulse_deep_health_up) or vector(0/0)");
    }
  });

  test("estate liveness is target-applicable for canonical host and service identities", () => {
    const host = bindCuratedQuery("estate.liveness", HOST_TARGET, null, model);
    const service = bindCuratedQuery(
      "estate.liveness",
      { kind: "service", id: "svc:web01/dh" },
      null,
      model,
    );
    expect(host.ok).toBe(true);
    expect(service.ok).toBe(true);
    if (host.ok) {
      expect(host.query.target).toEqual(HOST_TARGET);
      expect(host.query.promql).toContain("or vector(0/0)");
    }
    if (service.ok) {
      expect(service.query.target).toEqual({ kind: "service", id: "svc:web01/dh" });
      expect(service.query.promql).toContain('host="web01",service="dh"');
      expect(service.query.promql).toContain("or vector(0/0)");
    }
  });

  test("alerts.firing keeps only the canonical attribution tuple and no fingerprint", () => {
    const r = bindCuratedQuery("alerts.firing", null, null, model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.promql).toBe(
        'sum by (alertname, severity, host, service, instance) (ALERTS{alertstate="firing"})',
      );
      expect(r.query.promql).not.toContain("fingerprint");
    }
  });

  test("host load binds the validated instance label exactly", () => {
    const r = bindCuratedQuery("host.load.1m", HOST_TARGET, null, model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.target).toEqual({ kind: "host", id: "host:web01" });
      expect(r.query.promql).toBe('max(node_load1{instance="10.0.0.1:9100"})');
    }
  });

  test("service deep-health / backup-age bind the fixed metric and service label", () => {
    const dh = bindCuratedQuery("service.deep-health", { kind: "service", id: "svc:web01/dh" }, null, model);
    const ba = bindCuratedQuery("service.backup-age", { kind: "service", id: "svc:web01/db" }, null, model);
    expect(dh.ok).toBe(true);
    expect(ba.ok).toBe(true);
    if (dh.ok) expect(dh.query.promql).toBe('max(pulse_deep_health_up{service="dh"})');
    if (ba.ok) expect(ba.query.promql).toBe('max(pulse_backup_freshness_age_seconds{service="db"})');
  });

  test("endpoint latency selects by the Gatus name label, never the composite key (12 §3)", () => {
    const r = bindCuratedQuery("endpoint.check.latency", { kind: "endpoint", id: "web01/dh" }, null, model);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.promql).toBe('1000 * avg(gatus_results_duration_seconds{name="web01/dh"})');
      expect(r.query.promql).not.toContain("key=");
    }
  });

  test("multi-instance host unions each instance as its own exact-match selector", () => {
    const multi = makeModel({ hosts: [hostV2({ drilldownId: "host:m", scrapeTargets: [{ job: "node", instance: "a:9100" }, { job: "cadvisor", instance: "b:8080" }] })] });
    const r = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:m" }, null, multi);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.query.promql).toBe('max(node_load1{instance="a:9100"} or node_load1{instance="b:8080"})');
    }
  });

  test("all 14 ids build deterministically for their default range", () => {
    const bindAll = () =>
      QUERY_IDS.map((id) => {
        const def = QUERY_CATALOG[id];
        const target =
          def.targetKind === "estate" ? null
          : def.targetKind === "host" ? HOST_TARGET
          : def.targetKind === "service" ? { kind: "service", id: id === "service.backup-age" ? "svc:web01/db" : "svc:web01/dh" } as const
          : { kind: "endpoint", id: "web01/dh" } as const;
        return bindCuratedQuery(id, target, null, model);
      });
    const first = bindAll();
    const second = bindAll();
    expect(second).toEqual(first);
    for (const r of first) expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — escaping keeps injection within one quoted exact label
// ---------------------------------------------------------------------------

describe("escapePrometheusLabelValue and injection safety", () => {
  test("performs exactly the backslash, newline, and quote substitutions", () => {
    expect(escapePrometheusLabelValue("plain")).toBe("plain");
    expect(escapePrometheusLabelValue('a"b')).toBe('a\\"b');
    expect(escapePrometheusLabelValue("a\\b")).toBe("a\\\\b");
    expect(escapePrometheusLabelValue("a\nb")).toBe("a\\nb");
    // Braces, pipes, and regex tokens are not special in a quoted exact-match value.
    expect(escapePrometheusLabelValue("{}|.*+?")).toBe("{}|.*+?");
    // A backslash is escaped before the quote/newline it precedes (order-independent result).
    expect(escapePrometheusLabelValue('\\"')).toBe('\\\\\\"');
  });

  const CORPUS = [
    '"} or up{',
    'x" or node_load1{job="',
    'a\\b',
    "line\nbreak",
    "{__name__=\"secret\"}",
    "pipe|alt",
    ".*regex.*",
    'close"}]',
  ];

  test("injection corpus stays inside one quoted exact-match label with no new selector", () => {
    for (const payload of CORPUS) {
      const model = makeModel({ hosts: [hostV2({ drilldownId: "host:inj", scrapeTargets: [{ job: "node", instance: payload }] })] });
      const r = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:inj" }, null, model);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const promql = r.query.promql;
      // The whole query equals the pinned template with the payload confined to one
      // quoted exact-match label — proving it cannot add a selector or operator even when
      // the payload itself contains metric-like text or quote/brace characters.
      expect(promql).toBe(`max(node_load1{instance="${escapePrometheusLabelValue(payload)}"})`);
      expect(promql.startsWith('max(node_load1{instance="')).toBe(true);
      expect(promql.endsWith('"})')).toBe(true);
      // Every double-quote from the payload is backslash-escaped, so none closes the label
      // early (the only unescaped quotes are the two label delimiters the template adds).
      const inner = promql.slice('max(node_load1{instance="'.length, -'"})'.length);
      expect(inner.match(/(?<!\\)"/g)).toBeNull();
    }
  });

  test("a control-char instance value makes the host query unavailable, not injected", () => {
    const model = makeModel({ hosts: [hostV2({ drilldownId: "host:ctl", scrapeTargets: [{ job: "node", instance: "badinst" }] })] });
    const r = bindCuratedQuery("host.load.1m", { kind: "host", id: "host:ctl" }, null, model);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUERY_NOT_APPLICABLE");
  });
});

// ---------------------------------------------------------------------------
// Verification checklist — no wire/client module contains PromQL or query builders
// ---------------------------------------------------------------------------

describe("wire modules expose no query text", () => {
  const WIRE_DIR = resolve(import.meta.dir, "../../src/wire");
  const PROMQL_MARKERS = ["node_load1", "node_cpu_seconds_total", "ALERTS{", "pulse_deep_health_up", "vm_rows_inserted_total", "gatus_results_duration_seconds"];

  test("no /wire source imports the query builders or embeds PromQL", () => {
    const files = readdirSync(WIRE_DIR).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(resolve(WIRE_DIR, file), "utf8");
      // No import statement pulls a query module into the browser-safe wire graph
      // (a doc-comment mention of a filename is not an import).
      expect(/^\s*import\b[^\n]*\bqueries\//m.test(text)).toBe(false);
      for (const marker of PROMQL_MARKERS) expect(text).not.toContain(marker);
    }
  });
});
