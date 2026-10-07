// packages/web-data/tests/history/intervals.test.ts — evidence for the §10 history
// normalization algorithms (item 029, 07-history-service.md §§9–12). Unit-tests the pure
// exported functions (`normalizeHistorySeries`, `buildAlertIntervals`, `buildEndpointHistory`)
// directly, then two service-level flows proving the target filter and the endpoint pipeline.
// Package test files are not typechecked, so inputs are constructed as plain objects and mocks
// implement only what the service calls.

import { describe, expect, test } from "bun:test";

import { normalizeHistorySeries } from "../../src/history/points.js";
import { buildAlertIntervals, buildEndpointHistory } from "../../src/history/intervals.js";
import { createHistoryService } from "../../src/history/service.js";
import type { WebEstateModelV2 } from "@pulse/renderer";
import type { HistoryResult } from "../../src/history/service.js";
import type { VmRangeSeries } from "../../src/sources/vm.js";

// --- model factory ---------------------------------------------------------

function prov(): WebEstateModelV2["hosts"][number]["provenance"] {
  return { file: "estate.yml", path: "hosts[0]", line: 1, col: 1 };
}

function host(name: string): WebEstateModelV2["hosts"][number] {
  return {
    name,
    collectionClass: "managed-linux",
    addresses: ["10.0.0.1"],
    suppressed: null,
    drilldownId: `host:${name}`,
    expectedChurn: false,
    scrapeIntervalClass: null,
    provenance: prov(),
    scrapeTargets: [{ job: "node", instance: "10.0.0.1:9100" }],
    artifacts: [],
    detail: { exporterPorts: [9100], cadvisor: false, heartbeat: true, deliveryForm: "compose", commandSignals: [] },
  };
}

function svcEntry(hostName: string, name: string, gatusEndpoints: string[] = []): WebEstateModelV2["services"][number] {
  return {
    name,
    host: hostName,
    managed: true,
    deepHealth: false,
    suppressed: null,
    drilldownId: `svc:${hostName}/${name}`,
    kind: "dashboard",
    provenance: prov(),
    gatusEndpoints,
    artifacts: [],
    deepHealthDetail: null,
    backupFreshness: null,
    alerts: [],
  } as WebEstateModelV2["services"][number];
}

function model(over: Partial<WebEstateModelV2> = {}): WebEstateModelV2 {
  return {
    formatVersion: 2,
    bundleId: "sha256:bundle-1",
    estate: {
      name: "home",
      domains: ["example.com"],
      timezone: "America/New_York",
      dnsResolver: null,
      retention: null,
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts: [host("hostA"), host("hostB")],
    services: [svcEntry("hostA", "grafana", ["hostA/grafana"])],
    channels: [],
    routingOverrides: [],
    suppressions: [],
    ...over,
  } as WebEstateModelV2;
}

// --- helpers ---------------------------------------------------------------

const MS = 1_000_000; // base epoch-ms for readable timelines
const STEP = 60; // effective step seconds → 60_000 ms; 2×step gap = 120_000 ms

/** A VmRangeSeries with a label bag and `[timestampMs, value]` samples. */
function series(metric: Record<string, string>, samples: Array<[number, number | null]>): VmRangeSeries {
  return { metric, samples: samples.map(([timestampMs, value]) => ({ timestampMs, value })) };
}

/** Asserts a successful history result and narrows to it (a failure fails loudly, not as `undefined` data). */
function ok<T>(r: HistoryResult<T>): Extract<HistoryResult<T>, { ok: true }> {
  if (!r.ok) throw new Error(`expected an ok history result, got ${r.error.code}`);
  return r;
}

/** Fetched-at ISO for a range end at `MS + offsetMs`. */
function fetchedAt(offsetMs: number): string {
  return new Date(MS + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// §10.1 numeric series normalization
// ---------------------------------------------------------------------------

describe("normalizeHistorySeries (§10.1)", () => {
  test("sorts ascending, dedupes equal timestamps by last-sample, preserves null and zero", () => {
    const r = ok(normalizeHistorySeries(
      [
        series({ __name__: "node_load1", instance: "a" }, [
          [MS + 2000, 2],
          [MS + 1000, 1],
          [MS + 2000, 9], // equal timestamp → last-sample rule wins
          [MS + 3000, null], // explicit gap
          [MS + 4000, 0], // genuine zero is preserved, not treated as missing
        ]),
      ],
      STEP,
    ));
    expect(r.ok).toBe(true);
    const points = r.data[0]!.points;
    expect(points).toEqual([
      [MS + 1000, 1],
      [MS + 2000, 9],
      [MS + 3000, null],
      [MS + 4000, 0],
    ]);
  });

  test("non-finite values become explicit null and non-finite timestamps are dropped", () => {
    const r = ok(normalizeHistorySeries(
      [
        series({ __name__: "m" }, [
          [MS + 1000, Number.NaN],
          [MS + 2000, Number.POSITIVE_INFINITY],
          [Number.NaN, 5], // non-finite timestamp → dropped
          [MS + 3000, 7],
        ]),
      ],
      STEP,
    ));
    const points = r.data[0]!.points;
    expect(points).toEqual([
      [MS + 1000, null],
      [MS + 2000, null],
      [MS + 3000, 7],
    ]);
  });

  test("series are emitted in canonical bounded-label order", () => {
    const r = ok(normalizeHistorySeries(
      [
        series({ __name__: "m", host: "z" }, [[MS, 1]]),
        series({ __name__: "m", host: "a" }, [[MS, 1]]),
      ],
      STEP,
    ));
    const hosts = r.data.map((s) => s.labels.host);
    expect(hosts).toEqual(["a", "z"]);
  });

  test("600 samples pass and 601 reject the whole operation", () => {
    const at600 = normalizeHistorySeries(
      [series({ __name__: "m" }, Array.from({ length: 600 }, (_, i) => [MS + i, i] as [number, number]))],
      STEP,
    );
    expect(at600.ok).toBe(true);
    const at601 = normalizeHistorySeries(
      [series({ __name__: "m" }, Array.from({ length: 601 }, (_, i) => [MS + i, i] as [number, number]))],
      STEP,
    );
    expect(at601.ok).toBe(false);
    if (!at601.ok) expect(at601.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
  });

  test("1024 series pass and 1025 reject the whole operation", () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => series({ __name__: `m${i}` }, [[MS, 1]]));
    expect(normalizeHistorySeries(mk(1024) as never, STEP).ok).toBe(true);
    const over = normalizeHistorySeries(mk(1025) as never, STEP);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
  });
});

// ---------------------------------------------------------------------------
// §10.2 alert-interval lanes
// ---------------------------------------------------------------------------

describe("buildAlertIntervals (§10.2)", () => {
  function laneById(payload: unknown) {
    return (payload as { lanes: Array<Record<string, unknown>> }).lanes;
  }

  test("lane id is a deterministic sha256 of the canonical tuple, not a fingerprint", () => {
    const build = () =>
      ok(buildAlertIntervals(
        [series({ alertname: "HighCpu", severity: "critical", host: "hostA" }, [[MS, 1]])] as never,
        model(),
        "1h",
        fetchedAt(60_000),
        STEP,
      ));
    const a = laneById(build().data)[0]!;
    const b = laneById(build().data)[0]!;
    expect(String(a.id)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.id).toBe(b.id); // reproducible from attribution alone
  });

  test("distinct targets and distinct severities produce distinct lanes", () => {
    const r = ok(buildAlertIntervals(
      [
        series({ alertname: "X", severity: "critical", host: "hostA" }, [[MS, 1]]),
        series({ alertname: "X", severity: "critical", host: "hostB" }, [[MS, 1]]),
        series({ alertname: "X", severity: "warning", host: "hostA" }, [[MS, 1]]),
      ] as never,
      model(),
      "1h",
      fetchedAt(60_000),
      STEP,
    ));
    const lanes = laneById(r.data);
    expect(lanes.length).toBe(3);
    // Two lanes attribute to distinct host targets; overlapping severities stay distinct.
    const targets = lanes.map((l) => (l.target as { id: string } | null)?.id).sort();
    expect(targets).toEqual(["host:hostA", "host:hostA", "host:hostB"]);
    const severities = lanes.map((l) => l.severity).sort();
    expect(severities).toEqual(["critical", "critical", "warning"]);
  });

  test("a host+service tuple attributes to the matched service target", () => {
    // The model declares service `grafana` on `hostA`; the (host,service) tuple resolves to
    // the exact `svc:` drilldown identity with attribution `matched` — the attributed-lane path
    // the host-only and unmatched cases do not exercise.
    const r = ok(buildAlertIntervals(
      [series({ alertname: "SvcDown", severity: "warning", host: "hostA", service: "grafana" }, [[MS, 1]])] as never,
      model(),
      "1h",
      fetchedAt(60_000),
      STEP,
    ));
    const lane = laneById(r.data)[0]!;
    expect(lane.attribution).toBe("matched");
    expect(lane.target).toEqual({ kind: "service", id: "svc:hostA/grafana" });
    expect((lane.labels as Record<string, string | null>).service).toBe("grafana");
  });

  test("overlapping resolved alerts on two targets and two severities stay distinct, stable, attributed, and gap-closed", () => {
    // Three lanes whose firing windows overlap in time and each resolve (a non-firing sample
    // closes the interval): hostA/critical, hostB/critical (distinct target), hostA/warning
    // (distinct severity). Each must remain its own attributed lane with a closed interval, and
    // the lanes must be emitted in stable ascending lane-id order (§10.2 / §12).
    const r = ok(buildAlertIntervals(
      [
        series({ alertname: "X", severity: "critical", host: "hostA" }, [
          [MS, 1],
          [MS + STEP * 1000, 1],
          [MS + STEP * 2000, 0], // resolved at 2 steps
        ]),
        series({ alertname: "X", severity: "critical", host: "hostB" }, [
          [MS + STEP * 1000, 1], // overlaps hostA's window
          [MS + STEP * 2000, 1],
          [MS + STEP * 3000, 0], // resolved at 3 steps
        ]),
        series({ alertname: "X", severity: "warning", host: "hostA" }, [
          [MS, 1], // overlaps the critical hostA window
          [MS + STEP * 1000, 0], // resolved at 1 step
        ]),
      ] as never,
      model(),
      "1h",
      fetchedAt(STEP * 4000),
      STEP,
    ));
    const lanes = laneById(r.data);
    expect(lanes.length).toBe(3);
    // Every lane resolved (closed strictly before range end) and is attributed to a real target.
    const rangeEndMs = MS + STEP * 4000;
    for (const lane of lanes) {
      expect(lane.attribution).toBe("matched");
      expect(lane.target).not.toBeNull();
      const intervals = lane.intervals as Array<{ start: string; end: string }>;
      expect(intervals.length).toBe(1);
      expect(Date.parse(intervals[0]!.end)).toBeLessThan(rangeEndMs); // resolved, not open at range end
    }
    // Distinct target/severity combinations remain distinct lanes.
    const combos = lanes
      .map((l) => `${(l.target as { id: string }).id}|${String(l.severity)}`)
      .sort();
    expect(combos).toEqual(["host:hostA|critical", "host:hostA|warning", "host:hostB|critical"]);
    // Stable ordering by lane id.
    const ids = lanes.map((l) => String(l.id));
    expect([...ids]).toEqual([...ids].sort());
    // The hostA-critical and hostB-critical firing windows genuinely overlap in time.
    const critA = lanes.find((l) => (l.target as { id: string }).id === "host:hostA" && l.severity === "critical")!;
    const critB = lanes.find((l) => (l.target as { id: string }).id === "host:hostB" && l.severity === "critical")!;
    const ivA = (critA.intervals as Array<{ start: string; end: string }>)[0]!;
    const ivB = (critB.intervals as Array<{ start: string; end: string }>)[0]!;
    expect(Date.parse(ivB.start)).toBeLessThan(Date.parse(ivA.end)); // B opens before A closes
  });

  test("a removed/unknown target is unmatched with a null target, retaining the safe tuple", () => {
    const r = ok(buildAlertIntervals(
      [series({ alertname: "X", severity: "warning", host: "ghost" }, [[MS, 1]])] as never,
      model(),
      "1h",
      fetchedAt(60_000),
      STEP,
    ));
    const lane = laneById(r.data)[0]!;
    expect(lane.attribution).toBe("unmatched");
    expect(lane.target).toBeNull();
    expect((lane.labels as Record<string, string | null>).host).toBe("ghost"); // safe tuple retained
  });

  test("a non-firing sample closes a firing interval half-open", () => {
    const r = ok(buildAlertIntervals(
      [series({ alertname: "X", severity: "critical", host: "hostA" }, [
        [MS, 1],
        [MS + STEP * 1000, 1],
        [MS + STEP * 2000, 0], // stops firing
      ])] as never,
      model(),
      "1h",
      fetchedAt(STEP * 3000),
      STEP,
    ));
    const intervals = (laneById(r.data)[0]!.intervals as Array<{ start: string; end: string; state: string; provenance: string }>);
    expect(intervals.length).toBe(1);
    expect(Date.parse(intervals[0]!.start)).toBe(MS);
    expect(Date.parse(intervals[0]!.end)).toBe(MS + STEP * 2000); // closed at the non-firing sample
    expect(intervals[0]!.state).toBe("firing");
    expect(intervals[0]!.provenance).toBe("vmalert");
  });

  test("a gap greater than two steps closes the interval instead of implying continuous firing", () => {
    const r = ok(buildAlertIntervals(
      [series({ alertname: "X", severity: "critical", host: "hostA" }, [
        [MS, 1],
        [MS + STEP * 1000, 1], // contiguous (1 step later)
        [MS + STEP * 4000, 1], // 3-step gap (> 2 steps) → new interval
      ])] as never,
      model(),
      "1h",
      fetchedAt(STEP * 5000),
      STEP,
    ));
    const intervals = laneById(r.data)[0]!.intervals as Array<{ start: string; end: string }>;
    expect(intervals.length).toBe(2);
    // first closes at last contiguous sample + one step, not extended across the gap
    expect(Date.parse(intervals[0]!.start)).toBe(MS);
    expect(Date.parse(intervals[0]!.end)).toBe(MS + STEP * 1000 + STEP * 1000);
    // second opens at the post-gap firing sample and resolves at range end
    expect(Date.parse(intervals[1]!.start)).toBe(MS + STEP * 4000);
    expect(Date.parse(intervals[1]!.end)).toBe(MS + STEP * 5000);
  });

  test("lanes are ordered by lane id and empty (never-firing) tuples are dropped", () => {
    const r = ok(buildAlertIntervals(
      [
        series({ alertname: "A", severity: "info", host: "hostA" }, [[MS, 1]]),
        series({ alertname: "B", severity: "info", host: "hostB" }, [[MS, 1]]),
        series({ alertname: "C", severity: "info", host: "hostA" }, [[MS, 0]]), // never fires → dropped
      ] as never,
      model(),
      "1h",
      fetchedAt(60_000),
      STEP,
    ));
    const ids = laneById(r.data).map((l) => String(l.id));
    expect(ids.length).toBe(2);
    expect([...ids]).toEqual([...ids].sort());
  });

  test("more than 1024 lanes rejects the whole operation", () => {
    const many = Array.from({ length: 1025 }, (_, i) =>
      series({ alertname: `A${i}`, severity: "info", host: "hostA" }, [[MS, 1]]),
    );
    const r = buildAlertIntervals(many as never, model(), "1h", fetchedAt(60_000), STEP);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
  });

  test("more than 600 intervals in one lane rejects the whole operation", () => {
    // Alternate firing/non-firing every step so each firing sample is its own interval.
    const samples: Array<[number, number]> = [];
    for (let i = 0; i < 601; i += 1) {
      samples.push([MS + i * STEP * 2000, 1]);
      samples.push([MS + i * STEP * 2000 + STEP * 1000, 0]);
    }
    const r = buildAlertIntervals(
      [series({ alertname: "X", severity: "critical", host: "hostA" }, samples)] as never,
      model(),
      "7d",
      fetchedAt(0),
      STEP,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
  });
});

// ---------------------------------------------------------------------------
// §10.3 Gatus endpoint history / incidents
// ---------------------------------------------------------------------------

describe("buildEndpointHistory (§10.3)", () => {
  function result(offsetMs: number, success: boolean, durationMs: number | null): unknown {
    return { timestamp: new Date(MS + offsetMs).toISOString(), success, durationMs, conditionResults: [] };
  }

  test("results are sorted/deduped and durationMs null is preserved; attribution retained", () => {
    const target = { kind: "endpoint", id: "hostA/grafana" } as const;
    const r = ok(buildEndpointHistory(
      [
        result(2000, true, null),
        result(1000, false, 12),
        result(2000, false, 34), // equal timestamp → last-sample wins
      ] as never,
      "hostA/grafana",
      target,
      "1h",
      fetchedAt(3000),
    ));
    expect(r.ok).toBe(true);
    expect(r.data.provenance).toBe("gatus");
    expect(r.data.target).toEqual(target);
    const results = r.data.results as Array<{ timestamp: string; success: boolean; durationMs: number | null }>;
    expect(results.map((x) => Date.parse(x.timestamp))).toEqual([MS + 1000, MS + 2000]);
    expect(results[0]!.durationMs).toBe(12);
    expect(results[1]!.success).toBe(false); // deduped to the last sample at MS+2000
  });

  test("consecutive failures coalesce into a failed/gatus incident that closes on success", () => {
    const r = ok(buildEndpointHistory(
      [
        result(0, false, 1),
        result(60_000, false, 1),
        result(120_000, true, 1), // success closes the incident
      ] as never,
      "hostA/grafana",
      { kind: "endpoint", id: "hostA/grafana" } as never,
      "1h",
      fetchedAt(180_000),
    ));
    const incidents = r.data.incidents as Array<{ start: string; end: string; state: string; provenance: string }>;
    expect(incidents.length).toBe(1);
    expect(incidents[0]!.state).toBe("failed");
    expect(incidents[0]!.provenance).toBe("gatus");
    expect(Date.parse(incidents[0]!.start)).toBe(MS);
    expect(Date.parse(incidents[0]!.end)).toBe(MS + 120_000); // closed at the success sample
  });

  test("a gap greater than two derived check steps closes an incident, yielding stable ascending incidents", () => {
    // Regular 60s cadence → derived step (median gap) 60s. Two runs of consecutive failures
    // separated by a 6-step gap (no intervening sample): the first incident must close at the
    // last contiguous failure + one step rather than imply continuous failure across the gap,
    // and the second opens at the post-gap failure and resolves at range end (§10.3).
    const r = ok(buildEndpointHistory(
      [
        result(0, false, 1),
        result(60_000, false, 1),
        result(120_000, false, 1), // end of first failing run
        result(480_000, false, 1), // 6-step gap → new incident
        result(540_000, false, 1),
        result(600_000, false, 1),
      ] as never,
      "hostA/grafana",
      { kind: "endpoint", id: "hostA/grafana" } as never,
      "7d",
      fetchedAt(660_000),
    ));
    const incidents = r.data.incidents as Array<{ start: string; end: string; state: string; provenance: string }>;
    expect(incidents.length).toBe(2);
    // Stable ascending order.
    expect(Date.parse(incidents[0]!.start)).toBeLessThan(Date.parse(incidents[1]!.start));
    // First incident closes at last contiguous failure (120k) + one derived step (60k) = 180k.
    expect(Date.parse(incidents[0]!.start)).toBe(MS);
    expect(Date.parse(incidents[0]!.end)).toBe(MS + 180_000);
    // Second incident opens at the post-gap failure and resolves at range end (660k).
    expect(Date.parse(incidents[1]!.start)).toBe(MS + 480_000);
    expect(Date.parse(incidents[1]!.end)).toBe(MS + 660_000);
    expect(incidents.every((i) => i.state === "failed" && i.provenance === "gatus")).toBe(true);
  });

  test("an unmatched endpoint retains the exact endpoint key and gatus provenance with a null target", () => {
    const r = ok(buildEndpointHistory(
      [result(0, false, 5), result(60_000, true, 6)] as never,
      "ghost/removed",
      null, // no captured model relationship → unmatched
      "1h",
      fetchedAt(120_000),
    ));
    expect(r.ok).toBe(true);
    expect(r.data.endpoint).toBe("ghost/removed"); // exact endpoint attribution retained
    expect(r.data.target).toBeNull();
    expect(r.data.provenance).toBe("gatus");
  });

  test("more than 600 results rejects the whole operation", () => {
    const results = Array.from({ length: 601 }, (_, i) => result(i * 1000, true, 1));
    const r = buildEndpointHistory(results as never, "hostA/grafana", null, "1h", fetchedAt(0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
  });
});

// ---------------------------------------------------------------------------
// service-level composition
// ---------------------------------------------------------------------------

describe("HistoryService composition (§10 through the service)", () => {
  function svc(vmSeries: unknown[], gatusResults: unknown[] = []) {
    const vm = {
      statusSignals: async () => ({ ok: true, data: [] }),
      targets: async () => ({ ok: true, data: [] }),
      buildInfo: async () => ({ ok: true, data: {} }),
      queryRange: async () => ({ ok: true, data: { series: vmSeries } }),
    };
    const gatus = {
      endpointStatuses: async () => ({ ok: true, data: [] }),
      endpointHistory: async () => ({ ok: true, data: { key: "hostA/grafana", results: gatusResults } }),
    };
    return createHistoryService({ vm: vm as never, gatus: gatus as never, model: () => model(), now: () => MS + 300_000 });
  }

  test("a target-scoped alert request keeps only lanes matching that exact target", async () => {
    const service = svc([
      series({ alertname: "X", severity: "critical", host: "hostA" }, [[MS, 1]]),
      series({ alertname: "X", severity: "critical", host: "hostB" }, [[MS, 1]]),
      series({ alertname: "X", severity: "warning", host: "ghost" }, [[MS, 1]]), // unmatched
    ]);
    const r = ok(await service.alertIntervals({ range: "1h", target: { kind: "host", id: "host:hostA" } }));
    expect(r.ok).toBe(true);
    expect(r.data.target).toEqual({ kind: "host", id: "host:hostA" });
    const lanes = r.data.lanes;
    expect(lanes.length).toBe(1);
    expect(lanes[0]!.target!.id).toBe("host:hostA"); // never guesses the unmatched lane
  });

  test("an estate-wide alert request retains unmatched lanes", async () => {
    const service = svc([
      series({ alertname: "X", severity: "critical", host: "hostA" }, [[MS, 1]]),
      series({ alertname: "X", severity: "warning", host: "ghost" }, [[MS, 1]]),
    ]);
    const r = ok(await service.alertIntervals({ range: "1h", target: null }));
    const lanes = r.data.lanes;
    expect(lanes.length).toBe(2);
    expect(lanes.some((l) => l.attribution === "unmatched")).toBe(true);
  });

  test("endpoint history flows through with gatus provenance and coalesced incidents", async () => {
    const service = svc(
      [],
      [
        { timestamp: new Date(MS).toISOString(), success: false, durationMs: 1, conditionResults: [] },
        { timestamp: new Date(MS + 60_000).toISOString(), success: false, durationMs: 1, conditionResults: [] },
        { timestamp: new Date(MS + 120_000).toISOString(), success: true, durationMs: 1, conditionResults: [] },
      ],
    );
    const r = ok(await service.endpointHistory({ endpoint: "hostA/grafana", range: "1h" }));
    expect(r.ok).toBe(true);
    expect(r.data.provenance).toBe("gatus");
    expect(r.data.target).toEqual({ kind: "endpoint", id: "hostA/grafana" });
    expect((r.data.incidents as unknown[]).length).toBe(1);
  });
});
