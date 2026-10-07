// packages/web-data/tests/cycle/fold-timeline.test.ts — evidence for the pure timeline
// fold (item 024, 04-cycle-and-current-view-folds.md §11). Self-contained V2 model +
// typed-record builders; no apps/web or fetch dependency. The fold is a pure function of
// `inputs.model`/`inputs.observedAt`, so determinism on repeated calls and independence
// from the (failing) source records IS the zero-source-call / purity evidence. Web-data
// test files are not typechecked, so record fixtures are built loosely and cast.

import { describe, expect, test } from "bun:test";

import { foldTimeline } from "../../src/cycle/fold-timeline.js";
import type { CycleSourceRecords, FoldInputs } from "../../src/cycle/records.js";
import type { SourceRecord } from "../../src/sources/types.js";
import { QUERY_CATALOG, queryIdsForTargetKind } from "../../src/queries/catalog.js";
import { acceptedRangesForQuery } from "../../src/queries/ranges.js";
import { bindCuratedQuery } from "../../src/queries/binding.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

const AT = "2026-01-01T00:00:00.000Z";
const OBSERVED = "2026-01-01T00:00:05.000Z";
const BUNDLE_ID = "sha256:0000000000000000000000000000000000000000000000000000000000000000";

// --- record builders (timeline ignores records; used only to satisfy FoldInputs) --------

function rec<T>(data: T, isOk: boolean): SourceRecord<T> {
  return isOk
    ? { latest: { attemptedAt: AT, result: { ok: true, data } }, lastGood: { at: AT, data } }
    : {
        latest: {
          attemptedAt: AT,
          result: { ok: false, error: { kind: "timeout", message: "bounded timeout", status: null } },
        },
        lastGood: null,
      };
}

function records(isOk = true): CycleSourceRecords {
  const empty = <T>(d: T): SourceRecord<T> => rec(d, isOk);
  return {
    "victoriametrics-signals": empty([]),
    "victoriametrics-targets": empty([]),
    "victoriametrics-buildinfo": empty({}),
    "alertmanager-alerts": empty([]),
    "alertmanager-silences": empty([]),
    "alertmanager-status": empty({}),
    "alertmanager-receivers": empty([]),
    "vmalert-rules": empty([]),
    "gatus-statuses": empty([]),
    "grafana-health": null,
  } as unknown as CycleSourceRecords;
}

// --- model builder ---------------------------------------------------------------------

function prov(): WebEstateModelV2["hosts"][number]["provenance"] {
  return { file: "estate.yml", path: "hosts[0]", line: 1, col: 1 };
}

function managedHost(name: string, instances: readonly string[]): WebEstateModelV2["hosts"][number] {
  return {
    name,
    collectionClass: "managed-linux",
    addresses: ["10.0.0.1"],
    suppressed: null,
    drilldownId: `host:${name}`,
    expectedChurn: false,
    scrapeIntervalClass: null,
    provenance: prov(),
    scrapeTargets: instances.map((instance) => ({ job: "node", instance })),
    artifacts: [],
    detail: { exporterPorts: [9100], cadvisor: false, heartbeat: true, deliveryForm: "compose", commandSignals: [] },
  } as WebEstateModelV2["hosts"][number];
}

function probeHost(name: string): WebEstateModelV2["hosts"][number] {
  return {
    name,
    collectionClass: "probe-only",
    addresses: ["10.0.0.9"],
    suppressed: null,
    drilldownId: `host:${name}`,
    expectedChurn: false,
    scrapeIntervalClass: null,
    provenance: prov(),
    scrapeTargets: [], // no VM instances → host queries inapplicable
    artifacts: [],
    detail: { probe: { kind: "tcp", target: "10.0.0.9:22", expect: null } },
  } as WebEstateModelV2["hosts"][number];
}

interface ServiceOpts {
  readonly name: string;
  readonly host: string;
  readonly deepHealthMetrics?: readonly string[] | null; // null/undefined → no deep health
  readonly backup?: boolean;
  readonly gatusEndpoints?: readonly string[];
}

function service(opts: ServiceOpts): WebEstateModelV2["services"][number] {
  const deep = opts.deepHealthMetrics != null;
  return {
    name: opts.name,
    host: opts.host,
    managed: true,
    deepHealth: deep,
    suppressed: null,
    drilldownId: `svc:${opts.host}/${opts.name}`,
    kind: "service",
    provenance: prov(),
    gatusEndpoints: [...(opts.gatusEndpoints ?? [])],
    artifacts: [],
    deepHealthDetail: deep
      ? {
          endpoint: "https://x/health",
          metrics: [...(opts.deepHealthMetrics ?? [])],
          responseMapping: {},
          alertExpression: "up == 0",
          hostLocal: false,
          credential: null,
        }
      : null,
    backupFreshness: opts.backup
      ? { signal: "backup", threshold: "26h", interval: "24h", hasCommand: false }
      : null,
    alerts: [],
  } as WebEstateModelV2["services"][number];
}

function model(over: Partial<WebEstateModelV2> = {}): WebEstateModelV2 {
  return {
    formatVersion: 2,
    bundleId: BUNDLE_ID,
    estate: {
      name: "home",
      domains: ["example.com"],
      timezone: "America/New_York",
      dnsResolver: null,
      retention: null,
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts: [
      managedHost("hostA", ["10.0.0.1:9100"]),
      managedHost("hostB", ["10.0.0.2:9100", "10.0.0.2:9101"]),
      probeHost("hostD"),
    ],
    services: [
      service({ name: "grafana", host: "hostA", deepHealthMetrics: ["db"], gatusEndpoints: ["hostA/grafana"] }),
      service({ name: "backup", host: "hostB", backup: true, gatusEndpoints: ["hostB/backup"] }),
      service({ name: "plain", host: "hostA", gatusEndpoints: ["dup"] }),
      service({ name: "plain2", host: "hostB", gatusEndpoints: ["dup"] }),
      service({ name: "badhealth", host: "hostB", deepHealthMetrics: ["1bad-metric"] }),
    ],
    channels: [],
    routingOverrides: [],
    suppressions: [],
    ...over,
  };
}

function inputs(over: Partial<FoldInputs> = {}): FoldInputs {
  return { model: model(), coverage: null, findings: null, records: records(), appVersion: "1.2.3", observedAt: OBSERVED, ...over };
}

// ---------------------------------------------------------------------------
// Criterion 1: exact model targets + only applicable ids by kind and relationships
// ---------------------------------------------------------------------------

describe("foldTimeline — targets and applicable ids", () => {
  test("lists exactly the queryable targets, sorted by kind then id", () => {
    const tl = foldTimeline(inputs());
    expect(tl.generatedAt).toBe(OBSERVED); // body materialization time
    expect(tl.targets.map((t) => `${t.target.kind}:${t.target.id}`)).toEqual([
      "host:host:hostA",
      "host:host:hostB",
      "service:svc:hostA/grafana",
      "service:svc:hostA/plain",
      "service:svc:hostB/backup",
      "service:svc:hostB/badhealth",
      "service:svc:hostB/plain2",
      "endpoint:hostA/grafana",
      "endpoint:hostB/backup",
    ]);
    // hostD (no instances) and the ambiguous "dup" endpoint are absent. Services without
    // optional relationship metrics remain queryable through target-scoped estate.liveness.
  });

  test("host targets carry all four host queries with names and unioned ranges", () => {
    const tl = foldTimeline(inputs());
    const hostA = tl.targets.find((t) => t.target.id === "host:hostA")!;
    expect(hostA.name).toBe("hostA");
    expect(hostA.queryIds).toEqual([
      "estate.liveness",
      "host.cpu.utilization",
      "host.memory.utilization",
      "host.disk.utilization",
      "host.load.1m",
    ]);
    // cpu/mem/disk accept up to 7d, load only to 24h → union is all four ranges ascending.
    expect(hostA.ranges).toEqual(["1h", "6h", "24h", "7d"]);
  });

  test("service targets advertise only their declared-relationship query", () => {
    const tl = foldTimeline(inputs());
    const grafana = tl.targets.find((t) => t.target.id === "svc:hostA/grafana")!;
    expect(grafana.name).toBe("hostA/grafana");
    expect(grafana.queryIds).toEqual(["estate.liveness", "service.deep-health"]);
    expect(grafana.ranges).toEqual(["1h", "6h", "24h"]); // deep-health max 24h

    const backup = tl.targets.find((t) => t.target.id === "svc:hostB/backup")!;
    expect(backup.queryIds).toEqual(["estate.liveness", "service.backup-age"]);
    expect(backup.ranges).toEqual(["1h", "6h", "24h", "7d"]); // backup-age max 7d
  });

  test("endpoint targets carry the check-latency query", () => {
    const tl = foldTimeline(inputs());
    const ep = tl.targets.find((t) => t.target.kind === "endpoint" && t.target.id === "hostA/grafana")!;
    expect(ep.name).toBe("hostA/grafana");
    expect(ep.queryIds).toEqual(["endpoint.check.latency"]);
    expect(ep.ranges).toEqual(["1h", "6h", "24h"]);
  });

  test("every advertised id binds ok and every withheld same-kind id binds not-ok", () => {
    const m = model();
    const tl = foldTimeline(inputs({ model: m }));
    for (const t of tl.targets) {
      const applicable = new Set<string>(t.queryIds);
      for (const id of queryIdsForTargetKind(t.target.kind)) {
        const bound = bindCuratedQuery(id, t.target, null, m);
        // Advertised ⇔ binder applicability: never advertise an inapplicable query.
        expect(bound.ok).toBe(applicable.has(id));
      }
      expect(t.queryIds.length).toBeGreaterThan(0); // no empty-query target is listed
    }
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: provenance + stable Gatus endpoint identities
// ---------------------------------------------------------------------------

describe("foldTimeline — history capability metadata", () => {
  test("alert history uses vmalert provenance and alerts.firing ranges", () => {
    const tl = foldTimeline(inputs());
    expect(tl.alertHistory.provenance).toBe("vmalert");
    expect(tl.alertHistory.ranges).toEqual(["1h", "6h", "24h", "7d"]); // alerts.firing max 7d
  });

  test("check history uses gatus provenance and the resolvable endpoint keys in order", () => {
    const tl = foldTimeline(inputs());
    expect(tl.checkHistory.provenance).toBe("gatus");
    // "dup" is declared by two services → ambiguous → excluded; keys are deterministic ascending.
    // The estate domain endpoint (dns:example.com) is included too (amendment 12 §4).
    expect(tl.checkHistory.endpoints).toEqual(["dns:example.com", "hostA/grafana", "hostB/backup"]);
    // The service endpoints exactly match the endpoint targets; domains are not targets.
    expect(tl.checkHistory.endpoints.filter((e) => !e.startsWith("dns:"))).toEqual(
      tl.targets.filter((t) => t.target.kind === "endpoint").map((t) => t.target.id),
    );
  });
});

// ---------------------------------------------------------------------------
// Amendment 12 §4 (REQ-ECR-04): parent links and per-domain DNS endpoints
// ---------------------------------------------------------------------------

describe("foldTimeline — parents and domains", () => {
  test("host parent is null, service parent is its host, endpoint parent is its declaring service", () => {
    const tl = foldTimeline(inputs());
    const by = (id: string) => tl.targets.find((t) => t.target.id === id)!;
    expect(by("host:hostA").parent).toBeNull();
    expect(by("host:hostB").parent).toBeNull();
    expect(by("svc:hostA/grafana").parent).toEqual({ kind: "host", id: "host:hostA" });
    expect(by("svc:hostB/backup").parent).toEqual({ kind: "host", id: "host:hostB" });
    expect(by("hostA/grafana").parent).toEqual({ kind: "service", id: "svc:hostA/grafana" });
    expect(by("hostB/backup").parent).toEqual({ kind: "service", id: "svc:hostB/backup" });
    for (const t of tl.targets) expect("parent" in t).toBe(true);
  });

  test("a service whose host is not declared keeps a null parent and is still listed", () => {
    const m = model();
    const tl = foldTimeline(inputs({
      model: { ...m, services: [...m.services, service({ name: "orphan", host: "ghost" })] },
    }));
    const orphan = tl.targets.find((t) => t.target.id === "svc:ghost/orphan");
    expect(orphan).toBeDefined();
    expect(orphan!.parent).toBeNull();
  });

  test("domains follow model order, deduplicated first-wins, endpoint dns:<domain>", () => {
    const m = model();
    const tl = foldTimeline(inputs({
      model: { ...m, estate: { ...m.estate, domains: ["zeta.example", "alpha.example", "zeta.example", "mid.example"] } },
    }));
    expect(tl.domains).toEqual([
      { domain: "zeta.example", endpoint: "dns:zeta.example" },
      { domain: "alpha.example", endpoint: "dns:alpha.example" },
      { domain: "mid.example", endpoint: "dns:mid.example" },
    ]);
    // Domain endpoints are addressable check history, sorted ascending with service endpoints,
    // and never endpoint targets.
    expect(tl.checkHistory.endpoints).toEqual([
      "dns:alpha.example", "dns:mid.example", "dns:zeta.example", "hostA/grafana", "hostB/backup",
    ]);
    const sorted = [...tl.checkHistory.endpoints].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(tl.checkHistory.endpoints).toEqual(sorted);
    for (const d of tl.domains) {
      expect(tl.targets.some((t) => t.target.id === d.endpoint)).toBe(false);
    }
  });

  test("a dns:<domain> name also declared by a service is not advertised as a domain", () => {
    const m = model();
    const services = m.services.map((s, i) => (i === 0 ? { ...s, gatusEndpoints: [...s.gatusEndpoints, "dns:shadow.example"] } : s));
    const tl = foldTimeline(inputs({
      model: { ...m, services, estate: { ...m.estate, domains: ["shadow.example", "ok.example"] } },
    }));
    expect(tl.domains).toEqual([{ domain: "ok.example", endpoint: "dns:ok.example" }]);
  });

  test("no domains → empty domains and only service endpoints", () => {
    const m = model();
    const tl = foldTimeline(inputs({ model: { ...m, estate: { ...m.estate, domains: [] } } }));
    expect(tl.domains).toEqual([]);
    expect(tl.checkHistory.endpoints).toEqual(["hostA/grafana", "hostB/backup"]);
  });

  test("the payload is deterministic: same input yields an identical body", () => {
    const a = foldTimeline(inputs());
    const b = foldTimeline(inputs());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: derived from QUERY_CATALOG, no second list, deterministic order
// ---------------------------------------------------------------------------

describe("foldTimeline — catalog-derived ordering", () => {
  test("ids follow frozen catalog order and ranges follow ascending duration order", () => {
    const ASCENDING = ["1h", "6h", "24h", "7d"] as const;
    const tl = foldTimeline(inputs());
    for (const t of tl.targets) {
      const catalogOrder = queryIdsForTargetKind(t.target.kind);
      // queryIds is catalogOrder filtered — never reordered, never a hand-maintained list.
      expect(t.queryIds).toEqual(catalogOrder.filter((id) => t.queryIds.includes(id)));
      // ranges are an ascending-order filter of the fixed duration sequence.
      expect(t.ranges).toEqual(ASCENDING.filter((r) => (t.ranges as readonly string[]).includes(r)));
    }
    // The catalog is the single source: alertHistory ranges equal the alerts.firing definition's.
    expect(tl.alertHistory.ranges).toEqual(acceptedRangesForQuery(QUERY_CATALOG["alerts.firing"]));
  });
});

// ---------------------------------------------------------------------------
// Criterion 4: pure — no source/history call; explicit invalid-relationship handling
// ---------------------------------------------------------------------------

describe("foldTimeline — purity and invalid relationships", () => {
  test("output is independent of source records (never reads live state)", () => {
    const withOk = foldTimeline(inputs({ records: records(true) }));
    const withFail = foldTimeline(inputs({ records: records(false) }));
    expect(withOk).toEqual(withFail);
  });

  test("performs zero fetches and is deterministic across repeated calls", () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("timeline fold must not fetch");
    }) as unknown as typeof fetch;
    try {
      const a = foldTimeline(inputs());
      const b = foldTimeline(inputs());
      expect(a).toEqual(b);
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });

  test("removed/invalid relationships are handled explicitly (excluded, not fabricated)", () => {
    const tl = foldTimeline(inputs());
    const ids = tl.targets.map((t) => `${t.target.kind}:${t.target.id}`);
    expect(ids).not.toContain("host:host:hostD"); // probe-only host, no scrape instances
    expect(tl.targets.find((t) => t.target.id === "svc:hostA/plain")?.queryIds).toEqual(["estate.liveness"]);
    expect(tl.targets.find((t) => t.target.id === "svc:hostB/badhealth")?.queryIds).toEqual(["estate.liveness"]);
    expect(tl.checkHistory.endpoints).not.toContain("dup"); // ambiguous endpoint key
  });

  test("an all-empty model yields no targets but stable capability metadata", () => {
    const tl = foldTimeline(inputs({ model: model({ hosts: [], services: [] }) }));
    expect(tl.targets).toEqual([]);
    // No services → no service endpoints; the estate domain check remains addressable.
    expect(tl.checkHistory).toEqual({ endpoints: ["dns:example.com"], provenance: "gatus" });
    expect(tl.domains).toEqual([{ domain: "example.com", endpoint: "dns:example.com" }]);
    expect(tl.alertHistory.provenance).toBe("vmalert");
    expect(tl.alertHistory.ranges).toEqual(["1h", "6h", "24h", "7d"]);
  });
});
