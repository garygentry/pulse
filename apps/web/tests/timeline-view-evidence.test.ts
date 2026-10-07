// Unit tests for views/timeline/evidence.ts: attribution, check evidence, no-data spans, the segment
// sweep, partial reasons and the evidence cache (05 §5, 08 §3.3). Pure: no DOM. The check-evidence
// path is exercised through the injectable `reachable` argument, never mock.module (08 §3.3).

import { describe, expect, mock, test } from "bun:test";
import { signal } from "@preact/signals-core";

import type { AlertHistoryLane, EndpointHistoryPayload, HistoryPayload, TargetIdentity } from "@pulse/web-data/wire";
import { createTimeAxis } from "../src/client/views/_shared/timeseries/axis.js";
import type { TimeWindow } from "../src/client/views/_shared/timeseries/axis.js";
import {
  CHECK_GAP_FACTOR,
  CHECK_HISTORY_UNAVAILABLE_TEXT,
  NO_DATA_TEXT,
  PARTIAL_EVIDENCE_TEXT,
  PARTIAL_REASON_TEXT,
  alertsForLane,
  checkEvidenceFor,
  checkHistoryReachable,
  createLaneEvidenceCache,
  deriveLaneSegments,
  domainEvidenceInput,
  laneEvidenceInput,
  noDataSpans,
  partialReasonText,
  problemHostKeys,
  requiredCheckEndpoints,
  segmentAt,
  severityStatus,
} from "../src/client/views/timeline/evidence.js";
import type { CheckEvidence, LaneEvidenceInput, LaneSegment } from "../src/client/views/timeline/evidence.js";
import type { HistoryRegionState } from "../src/client/views/_shared/timeseries/history/client.js";
import { buildLaneTree, targetKey } from "../src/client/views/timeline/model.js";
import type { LaneNode, TargetKey } from "../src/client/views/timeline/model.js";
import {
  TIMELINE_NOW_S,
  makeAlertLane,
  makeEndpointHistory,
  makeHierarchySnapshot,
  makeSeriesHistory,
  makeTimelineIndex,
} from "./timeline-fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALWAYS = (): boolean => true;
const iso = (sec: number): string => new Date(sec * 1000).toISOString();

/** Alert lane with ABSOLUTE epoch-second intervals (the fixture takes offsets from TIMELINE_NOW_S). */
function lane(alertname: string, severity: AlertHistoryLane["severity"], target: TargetIdentity | null, intervals: readonly (readonly [number, number])[]): AlertHistoryLane {
  return makeAlertLane({ alertname, severity, target, intervals: intervals.map(([s, e]) => [s - TIMELINE_NOW_S, e - TIMELINE_NOW_S] as const) });
}

/** Coverage-probe payload from absolute-second points. */
function probe(points: readonly (readonly [number, number | null])[], fetchedAtSec: number, step = 60, seriesCount = 1): HistoryPayload {
  return {
    queryId: "engine.active-series",
    target: null,
    range: "1h",
    fetchedAt: iso(fetchedAtSec),
    effectiveStepSeconds: step,
    unit: "count",
    stale: false,
    series: Array.from({ length: seriesCount }, (_, i) => ({ labels: { instance: `s${i}` }, points: points.map(([t, v]) => [t * 1000, v] as const) })),
  };
}

function serviceNode(endpoints: readonly string[], id = "svc:h/s"): LaneNode {
  return { target: { kind: "service", id }, label: "s", hostName: "h", name: "s", endpoints, queryIds: [], grafanaUrl: null, children: [] };
}

function hostNode(children: readonly LaneNode[], id = "host:h"): LaneNode {
  return { target: { kind: "host", id }, label: "h", hostName: null, name: "h", endpoints: [], queryIds: [], grafanaUrl: null, children };
}

type Row = readonly [number, number, LaneSegment["status"], LaneSegment["cause"], readonly string[]];
function rows(segments: readonly LaneSegment[]): Row[] {
  return segments.map((s) => [s.start, s.end, s.status, s.cause, [...s.alertnames]] as const);
}

function input(o: Partial<LaneEvidenceInput> & { window: TimeWindow }): LaneEvidenceInput {
  return { alerts: [], checks: [], checksNotLoaded: false, noData: [], ...o };
}

function expectTiles(segments: readonly LaneSegment[], w: TimeWindow): void {
  expect(segments.length).toBeGreaterThan(0);
  expect(segments[0]!.start).toBe(w.start);
  expect(segments[segments.length - 1]!.end).toBe(w.end);
  for (let i = 0; i < segments.length; i++) {
    expect(segments[i]!.end).toBeGreaterThan(segments[i]!.start);
    if (i > 0) expect(segments[i]!.start).toBe(segments[i - 1]!.end);
  }
}

/** Tiny seeded PRNG (mulberry32) for the property test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FAILURE = { kind: "unavailable", code: "SOURCE_UNAVAILABLE", retryable: true, retryAfterSeconds: null } as const;

// ---------------------------------------------------------------------------
// Constants, gate, severity
// ---------------------------------------------------------------------------

describe("constants and copy", () => {
  test("CHECK_GAP_FACTOR and text carriers", () => {
    expect(CHECK_GAP_FACTOR).toBe(3);
    expect(PARTIAL_EVIDENCE_TEXT).toBe("partial evidence");
    expect(NO_DATA_TEXT).toBe("no data");
    expect(CHECK_HISTORY_UNAVAILABLE_TEXT).toBe("check history not available");
    expect(PARTIAL_REASON_TEXT).toEqual({
      "not-loaded": "not loaded",
      loading: "loading",
      "evidence-unavailable": "evidence unavailable",
      "coverage-limited": "check history covers only since {t}",
    });
  });

  test("REQ-LANE-04: partialReasonText substitutes {t} for coverage-limited and returns the plain text otherwise", () => {
    const fmt = (s: number): string => `T${s}`;
    expect(partialReasonText({ segments: [], partial: "coverage-limited", coverageSince: 42 }, fmt)).toBe("check history covers only since T42");
    expect(partialReasonText({ segments: [], partial: "not-loaded", coverageSince: null }, fmt)).toBe("not loaded");
    expect(partialReasonText({ segments: [], partial: "loading", coverageSince: null }, fmt)).toBe("loading");
    expect(partialReasonText({ segments: [], partial: "evidence-unavailable", coverageSince: null }, fmt)).toBe("evidence unavailable");
    expect(partialReasonText({ segments: [], partial: null, coverageSince: null }, fmt)).toBeNull();
  });
});

describe("REQ-LANE-06: checkHistoryReachable and requiredCheckEndpoints", () => {
  const snap = makeHierarchySnapshot({ hosts: 3, servicesPerHost: 2 });
  const index = makeTimelineIndex(snap);
  const tree = buildLaneTree(snap, index);
  const allKeys = new Set<TargetKey>(tree.hosts.map((h) => targetKey(h.target)));
  const gate = (key: string): boolean => checkHistoryReachable(key, index);

  test("REQ-ECR-C1: membership in index.checkHistory.endpoints decides, including slash-bearing keys", () => {
    const listed = index.checkHistory.endpoints[0]!;
    expect(listed).toContain("/");
    expect(checkHistoryReachable(listed, index)).toBe(true);
    expect(checkHistoryReachable("host-999/nginx", index)).toBe(false);
    expect(checkHistoryReachable("abc", index)).toBe(false);
    expect(checkHistoryReachable("", index)).toBe(false);
  });

  test("REQ-ECR-C1: a null index is never reachable", () => {
    expect(checkHistoryReachable(index.checkHistory.endpoints[0]!, null)).toBe(false);
    expect(checkHistoryReachable("abc", null)).toBe(false);
  });

  test("REQ-ECR-C1: an index that lists no endpoints makes every key unreachable", () => {
    const bare = makeTimelineIndex(snap, { omitEndpoints: true });
    expect(checkHistoryReachable(index.checkHistory.endpoints[0]!, bare)).toBe(false);
  });

  test("REQ-ECR-C1: requiredCheckEndpoints under the index gate returns the listed endpoints of expanded hosts only", () => {
    expect(requiredCheckEndpoints(tree, new Set(), gate)).toEqual([]);
    expect(requiredCheckEndpoints(tree, allKeys, gate)).toEqual([...index.checkHistory.endpoints]);
    expect(requiredCheckEndpoints(tree, allKeys, () => false)).toEqual([]);
  });

  test("REQ-LANE-06: with reachable = () => true only expanded hosts' endpoints are requested, deduplicated, in tree order", () => {
    expect(requiredCheckEndpoints(tree, new Set(), ALWAYS)).toEqual([]);
    const second = tree.hosts[1]!;
    const expected = second.children.flatMap((c) => c.endpoints);
    expect(expected.length).toBe(2);
    expect(requiredCheckEndpoints(tree, new Set([targetKey(second.target)]), ALWAYS)).toEqual(expected);
    expect(requiredCheckEndpoints(tree, allKeys, ALWAYS)).toEqual(tree.hosts.flatMap((h) => h.children.flatMap((c) => c.endpoints)));
    // Dedup across services sharing an endpoint.
    const dup = { hosts: [hostNode([serviceNode(["x", "y"], "svc:a"), serviceNode(["y", "z"], "svc:b")])], domains: [] };
    expect(requiredCheckEndpoints(dup, new Set<TargetKey>(["host:host:h"]), ALWAYS)).toEqual(["x", "y", "z"]);
  });

  test("REQ-ECR-C3: every domain endpoint is required whenever domains exist (expanded or not), after expanded services, gated by reachable", () => {
    const withDomains = {
      hosts: [hostNode([serviceNode(["x"], "svc:a")])],
      domains: [{ domain: "a.example", endpoint: "dns:a.example" }, { domain: "b.example", endpoint: "dns:b.example" }],
    };
    expect(requiredCheckEndpoints(withDomains, new Set(), ALWAYS)).toEqual(["dns:a.example", "dns:b.example"]);
    expect(requiredCheckEndpoints(withDomains, new Set<TargetKey>(["host:host:h"]), ALWAYS)).toEqual(["x", "dns:a.example", "dns:b.example"]);
    expect(requiredCheckEndpoints(withDomains, new Set(), (k) => k === "dns:b.example")).toEqual(["dns:b.example"]);
    expect(requiredCheckEndpoints(withDomains, new Set(), () => false)).toEqual([]);
  });
});

describe("REQ-LANE-02: severity and attribution", () => {
  test("REQ-LANE-02: severityStatus maps critical→critical, warning→warning, unknown→warning, info→null", () => {
    expect(severityStatus("critical")).toBe("critical");
    expect(severityStatus("warning")).toBe("warning");
    expect(severityStatus("unknown")).toBe("warning");
    expect(severityStatus("info")).toBeNull();
  });

  const snap = makeHierarchySnapshot({ hosts: 2, servicesPerHost: 2 });
  const tree = buildLaneTree(snap, makeTimelineIndex(snap));
  const host = tree.hosts[0]!;
  const svc0 = host.children[0]!;
  const svc1 = host.children[1]!;
  const other = tree.hosts[1]!;
  const hostLane = lane("HostDown", "critical", host.target, [[1000, 2000]]);
  const svcLane0 = lane("NginxDown", "warning", svc0.target, [[1000, 2000]]);
  const svcLane1 = lane("PgSlow", "info", svc1.target, [[1000, 2000]]);
  const unmatched = lane("Orphan", "critical", null, [[1000, 2000]]);
  const otherLane = lane("OtherDown", "critical", other.target, [[1000, 2000]]);
  // Attribution says "unmatched" even though the target is set: never attributed.
  const unmatchedWithTarget: AlertHistoryLane = { ...lane("Weird", "critical", host.target, [[1000, 2000]]), attribution: "unmatched" };
  const lanes = [svcLane0, unmatched, hostLane, otherLane, svcLane1, unmatchedWithTarget];

  test("REQ-LANE-02: collapsed host = own + children, expanded host = own only, service = own, never unmatched", () => {
    expect(alertsForLane(lanes, host, false)).toEqual([hostLane, svcLane0, svcLane1]);
    expect(alertsForLane(lanes, host, true)).toEqual([hostLane]);
    expect(alertsForLane(lanes, svc0, false)).toEqual([svcLane0]);
    expect(alertsForLane(lanes, svc0, true)).toEqual([svcLane0]);
    expect(alertsForLane(lanes, other, false)).toEqual([otherLane]);
    expect(alertsForLane([unmatched], host, false)).toEqual([]);
  });

  test("REQ-LANE-02: null lanes give null", () => {
    expect(alertsForLane(null, host, false)).toBeNull();
  });

  test("REQ-LANE-02: the same inputs return the same array reference", () => {
    expect(alertsForLane(lanes, host, false)).toBe(alertsForLane(lanes, host, false)!);
    expect(alertsForLane(lanes, host, true)).toBe(alertsForLane(lanes, host, true)!);
    expect(alertsForLane(lanes, svc0, false)).toBe(alertsForLane(lanes, svc0, false)!);
    // A new payload array is a new identity.
    expect(alertsForLane([...lanes], host, false)).not.toBe(alertsForLane(lanes, host, false)!);
  });
});

// ---------------------------------------------------------------------------
// checkEvidenceFor / laneEvidenceInput (05 §5.5)
// ---------------------------------------------------------------------------

describe("domainEvidenceInput (09 §3, REQ-ECR-C3)", () => {
  const W = { start: TIMELINE_NOW_S - 3_600, end: TIMELINE_NOW_S };
  const failing = makeEndpointHistory("dns:a.example", { results: Array.from({ length: 60 }, (_, i) => [-3_600 + (i + 1) * 60, i >= 30] as const) });
  const healthy = makeEndpointHistory("dns:b.example");
  const regions = new Map<string, HistoryRegionState<EndpointHistoryPayload>>([
    ["dns:a.example", { phase: "ready", data: failing }],
    ["dns:b.example", { phase: "ready", data: healthy }],
  ]);
  const input = (endpoints: readonly string[], lookup = (e: string) => regions.get(e), reachable: (k: string) => boolean = ALWAYS): LaneEvidenceInput =>
    domainEvidenceInput({ endpoints, lookup, noData: [], window: W, reachable });

  test("REQ-ECR-C3: a domain lane is check evidence only — failed results read critical/check, no alert evidence", () => {
    const i = input(["dns:a.example"]);
    expect(i.alerts).toEqual([]);
    expect(i.checksNotLoaded).toBe(false);
    const r = deriveLaneSegments(i);
    expect(r.segments.some((sg) => sg.status === "critical" && sg.cause === "check")).toBe(true);
    expect(r.segments.every((sg) => sg.alertnames.length === 0)).toBe(true);
    expect(deriveLaneSegments(input(["dns:b.example"])).segments.filter((sg) => sg.start >= W.start + 60).every((sg) => sg.status === "ok")).toBe(true);
  });

  test("REQ-ECR-C3: the header over every domain endpoint takes the worst (critical), and a loading endpoint makes it partial", () => {
    expect(deriveLaneSegments(input(["dns:a.example", "dns:b.example"])).segments.some((sg) => sg.status === "critical")).toBe(true);
    const oneLoading = input(["dns:a.example", "dns:b.example"], (e) => (e === "dns:a.example" ? { phase: "loading", previous: null } : regions.get(e)));
    expect(deriveLaneSegments(oneLoading).partial).toBe("loading");
  });

  test("REQ-ECR-C3: with no ready check the lane is no data over the whole window (never OK); unlisted → evidence-unavailable", () => {
    const none = input(["dns:a.example"], () => undefined);
    expect(none.alerts).toBeNull();
    expect(deriveLaneSegments(none)).toEqual({
      segments: [{ status: "unknown", start: W.start, end: W.end, cause: "no-data", alertnames: [] }],
      partial: "not-loaded",
      coverageSince: null,
    });
    expect(deriveLaneSegments(input(["dns:a.example"], undefined, () => false)).partial).toBe("evidence-unavailable");
  });

  test("REQ-LANE-03: before the first retained check result a healthy domain lane is no data, never OK", () => {
    const recent = makeEndpointHistory("dns:c.example", { results: Array.from({ length: 10 }, (_, i) => [-600 + i * 60, true] as const) });
    const lookup = (e: string): HistoryRegionState<EndpointHistoryPayload> | undefined =>
      e === "dns:c.example" ? { phase: "ready", data: recent } : undefined;
    const i = input(["dns:c.example"], lookup);
    const r = deriveLaneSegments(i);
    const firstResult = TIMELINE_NOW_S - 600;
    expect(r.segments[0]).toMatchObject({ status: "unknown", start: W.start, cause: "no-data" });
    expect(r.segments.filter((sg) => sg.end <= firstResult).every((sg) => sg.status === "unknown")).toBe(true);
    expect(r.segments.some((sg) => sg.start >= firstResult && sg.status === "ok")).toBe(true);
    expect(r.partial).toBe("coverage-limited");
  });

  test("REQ-ECR-C3: in the Domains header, pre-coverage no data never hides another domain's check failure", () => {
    // A: covered from the window start and failing early. B: ready but with no retained results.
    const earlyFail = makeEndpointHistory("dns:a.example", { results: Array.from({ length: 60 }, (_, i) => [-3_600 + i * 60, i >= 10] as const) });
    const empty = makeEndpointHistory("dns:b.example", { results: [] });
    const lookup = (e: string): HistoryRegionState<EndpointHistoryPayload> | undefined =>
      e === "dns:a.example" ? { phase: "ready", data: earlyFail } : e === "dns:b.example" ? { phase: "ready", data: empty } : undefined;
    const r = deriveLaneSegments(input(["dns:a.example", "dns:b.example"], lookup));
    const failing = r.segments.filter((sg) => sg.status === "critical");
    expect(failing.length).toBeGreaterThan(0);
    expect(failing[0]!.start).toBe(W.start);
    // Outside A's failure the header is no data (B has no evidence), never OK.
    expect(r.segments.every((sg) => sg.status !== "ok")).toBe(true);
  });
});

describe("checkEvidenceFor (05 §5.5 table)", () => {
  const P = makeEndpointHistory("e");
  const Q = makeEndpointHistory("e", { results: [[-60, true]] });
  const node = serviceNode(["e"]);
  const one = (region: HistoryRegionState<EndpointHistoryPayload> | undefined, reachable: (k: string) => boolean = ALWAYS): CheckEvidence =>
    checkEvidenceFor(node, () => region, reachable)[0]!;

  test("REQ-LANE-06: unreachable (not listed by the index) → unavailable, whatever the region", () => {
    const svc = serviceNode(["web01/nginx"]);
    expect(checkEvidenceFor(svc, () => ({ phase: "ready", data: P }), (k) => checkHistoryReachable(k, null))).toEqual([{ endpoint: "web01/nginx", state: "unavailable" }]);
    expect(one({ phase: "ready", data: P }, () => false)).toEqual({ endpoint: "e", state: "unavailable" });
  });
  test("region undefined → not-loaded", () => {
    expect(one(undefined)).toEqual({ endpoint: "e", state: "not-loaded" });
  });
  test("idle → not-loaded", () => {
    expect(one({ phase: "idle" })).toEqual({ endpoint: "e", state: "not-loaded" });
  });
  test("loading, previous null → loading", () => {
    expect(one({ phase: "loading", previous: null })).toEqual({ endpoint: "e", state: "loading" });
  });
  test("REQ-FOLLOW-03: loading with previous → ready(previous)", () => {
    expect(one({ phase: "loading", previous: Q })).toEqual({ endpoint: "e", state: "ready", payload: Q });
  });
  test("ready → ready(data)", () => {
    const r = one({ phase: "ready", data: P });
    expect(r).toEqual({ endpoint: "e", state: "ready", payload: P });
    expect(r.state === "ready" && r.payload).toBe(P);
  });
  test("REQ-HISTERR-02: error with previous → ready(previous)", () => {
    expect(one({ phase: "error", failure: FAILURE, previous: Q })).toEqual({ endpoint: "e", state: "ready", payload: Q });
  });
  test("error, previous null → error", () => {
    expect(one({ phase: "error", failure: FAILURE, previous: null })).toEqual({ endpoint: "e", state: "error" });
  });
  test("not-applicable → unavailable", () => {
    expect(one({ phase: "not-applicable", reason: "x" })).toEqual({ endpoint: "e", state: "unavailable" });
  });
  test("one entry per endpoint, in order; hosts have none", () => {
    expect(checkEvidenceFor(serviceNode(["a", "b"]), () => undefined, ALWAYS).map((c) => c.endpoint)).toEqual(["a", "b"]);
    expect(checkEvidenceFor(hostNode([]), () => undefined, ALWAYS)).toEqual([]);
  });
});

describe("REQ-LANE-04: laneEvidenceInput collapse rules (05 §5.6)", () => {
  const W: TimeWindow = { start: 1000, end: 2000 };
  const withEp = serviceNode(["h/s"], "svc:h/s");
  const noEp = serviceNode([], "svc:h/t");
  const host = hostNode([withEp, noEp]);
  const bare = hostNode([noEp], "host:bare");
  const lanes = [lane("A", "warning", host.target, [[1100, 1200]]), lane("B", "critical", withEp.target, [[1300, 1400]])];
  const noData: TimeWindow[] = [];
  const base = { alertLanes: lanes, lookup: () => undefined, noData, window: W, reachable: (): boolean => false };

  test("REQ-LANE-04: collapsed host with a checked child → own + services, checksNotLoaded, partial not-loaded", () => {
    const i = laneEvidenceInput({ ...base, node: host, expanded: false });
    expect(i.alerts).toEqual(lanes);
    expect(i.checks).toEqual([]);
    expect(i.checksNotLoaded).toBe(true);
    expect(i.noData).toBe(noData);
    expect(i.window).toBe(W);
    expect(deriveLaneSegments(i).partial).toBe("not-loaded");
  });
  test("collapsed host with no child endpoints → no partial", () => {
    const i = laneEvidenceInput({ ...base, node: bare, expanded: false });
    expect(i.checksNotLoaded).toBe(false);
    expect(deriveLaneSegments(i).partial).toBeNull();
  });
  test("expanded host → own only, no partial", () => {
    const i = laneEvidenceInput({ ...base, node: host, expanded: true });
    expect(i.alerts).toEqual([lanes[0]!]);
    expect(i.checksNotLoaded).toBe(false);
    expect(deriveLaneSegments(i).partial).toBeNull();
  });
  test("REQ-LANE-06: service with endpoints the index does not list → own alerts, every endpoint unavailable, partial evidence-unavailable", () => {
    const i = laneEvidenceInput({ ...base, node: withEp, expanded: true });
    expect(i.alerts).toEqual([lanes[1]!]);
    expect(i.checks).toEqual([{ endpoint: "h/s", state: "unavailable" }]);
    expect(i.checksNotLoaded).toBe(false);
    expect(deriveLaneSegments(i).partial).toBe("evidence-unavailable");
  });
  test("REQ-ECR-C1: service whose endpoint the index lists → checks read from the lookup, not unavailable", () => {
    const P = makeEndpointHistory("h/s", { results: [[-60, true]] });
    const i = laneEvidenceInput({ ...base, node: withEp, expanded: true, reachable: (k) => k === "h/s", lookup: () => ({ phase: "ready", data: P }) });
    expect(i.checks).toEqual([{ endpoint: "h/s", state: "ready", payload: P }]);
  });
  test("service with no endpoints → no partial", () => {
    const i = laneEvidenceInput({ ...base, node: noEp, expanded: false });
    expect(i.checks).toEqual([]);
    expect(deriveLaneSegments(i).partial).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// noDataSpans (05 §5.7)
// ---------------------------------------------------------------------------

describe("REQ-LANE-03: noDataSpans", () => {
  const W: TimeWindow = { start: 0, end: 1000 };
  const PTS: readonly (readonly [number, number | null])[] = [[100, 1], [160, 1], [220, null], [280, 1], [340, 1], [700, 1], [760, 1]];

  test("REQ-LANE-03: 05 §5.7 example (dataEnd = min(950, 940))", () => {
    expect(noDataSpans(probe(PTS, 950), W, iso(940))).toEqual([
      { start: 0, end: 100 }, { start: 220, end: 280 }, { start: 460, end: 700 }, { start: 880, end: 1000 },
    ]);
  });

  test("REQ-LANE-03: 05 §5.7 example variant (last point at 900 → tail capped at 940)", () => {
    const pts = PTS.map(([t, v]) => [t === 760 ? 900 : t, v] as const);
    expect(noDataSpans(probe(pts, 950), W, iso(940))).toEqual([
      { start: 0, end: 100 }, { start: 220, end: 280 }, { start: 460, end: 700 }, { start: 820, end: 900 }, { start: 940, end: 1000 },
    ]);
  });

  test("REQ-LANE-03: zero series (or no points) → [window]", () => {
    expect(noDataSpans(probe([], 950, 60, 0), W, null)).toEqual([W]);
    expect(noDataSpans(probe([], 950, 60, 1), W, null)).toEqual([W]);
  });

  test("REQ-LANE-03: a window past min(probe.fetchedAt, alertsFetchedAt) yields a trailing no-data span", () => {
    const dense = Array.from({ length: 21 }, (_, i) => [i * 60, 1] as const); // 0 … 1200
    // Probe fetched at 1200 but alerts at 800: nothing after 800 is evidence.
    expect(noDataSpans(probe(dense, 1200), W, iso(800))).toEqual([{ start: 800, end: 1000 }]);
    // Alerts later than the probe: the probe's fetchedAt caps.
    expect(noDataSpans(probe(dense, 900), W, iso(1500))).toEqual([{ start: 900, end: 1000 }]);
    // No alerts payload: probe fetchedAt alone.
    expect(noDataSpans(probe(dense, 950), W, null)).toEqual([{ start: 950, end: 1000 }]);
    // Fully covered.
    expect(noDataSpans(probe(dense, 2000), W, null)).toEqual([]);
    // Unparseable fetchedAt values are ignored.
    const bad: HistoryPayload = { ...probe(dense, 0), fetchedAt: "garbage" };
    expect(noDataSpans(bad, W, "also garbage")).toEqual([]);
  });

  test("REQ-LANE-03: a (paused) window entirely before the first probe point is one no-data span", () => {
    const p = probe([[5000, 1], [5060, 1]], 5100);
    expect(noDataSpans(p, { start: 1000, end: 2000 }, iso(5100))).toEqual([{ start: 1000, end: 2000 }]);
  });

  test("REQ-LANE-03: coverage is the union over series; null points cover nothing; invalid windows give []", () => {
    const multi: HistoryPayload = {
      ...probe([], 1000),
      series: [
        { labels: {}, points: [[500_000, 1], [560_000, 1]] },
        { labels: {}, points: [[0, 1], [60_000, 1], [120_000, null], [Number.NaN, 1]] },
      ],
    };
    expect(noDataSpans(multi, W, null)).toEqual([{ start: 120, end: 500 }, { start: 680, end: 1000 }]);
    expect(noDataSpans(multi, { start: 10, end: 10 }, null)).toEqual([]);
    expect(noDataSpans(multi, { start: Number.NaN, end: 10 }, null)).toEqual([]);
  });

  test("a non-positive step falls back to 60 s", () => {
    expect(noDataSpans(probe([[100, 1]], 1000, 0), W, null)).toEqual([{ start: 0, end: 100 }, { start: 220, end: 1000 }]);
  });

  test("REQ-PERF-05: repeated (payload, alertsFetchedAt, window) returns the same array reference", () => {
    const p = probe(PTS, 950);
    const a = noDataSpans(p, W, iso(940));
    expect(noDataSpans(p, { start: 0, end: 1000 }, iso(940))).toBe(a);
    const b = noDataSpans(p, { start: 0, end: 900 }, iso(940));
    expect(b).not.toBe(a);
    expect(noDataSpans(p, { start: 0, end: 900 }, iso(940))).toBe(b);
    expect(noDataSpans(p, { start: 0, end: 900 }, null)).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// deriveLaneSegments (05 §5.9)
// ---------------------------------------------------------------------------

describe("deriveLaneSegments", () => {
  const W: TimeWindow = { start: 1000, end: 2000 };
  const T: TargetIdentity = { kind: "host", id: "host:h" };
  const EXAMPLE = [
    lane("DiskFilling", "warning", T, [[1100, 1400]]),
    lane("HostDown", "critical", T, [[1300, 1350]]),
    lane("BackupInfo", "info", T, [[1500, 1600]]),
  ];

  test("REQ-LANE-02/03: reproduces the 05 §5.9.4 worked example exactly", () => {
    const r = deriveLaneSegments({ window: W, alerts: EXAMPLE, checks: [], checksNotLoaded: true, noData: [{ start: 1900, end: 2000 }] });
    expect(rows(r.segments)).toEqual([
      [1000, 1100, "ok", "ok", []],
      [1100, 1300, "warning", "alert", ["DiskFilling"]],
      [1300, 1350, "critical", "alert", ["DiskFilling", "HostDown"]],
      [1350, 1400, "warning", "alert", ["DiskFilling"]],
      [1400, 1500, "ok", "ok", []],
      [1500, 1600, "ok", "ok", ["BackupInfo"]],
      [1600, 1900, "ok", "ok", []],
      [1900, 2000, "unknown", "no-data", []],
    ]);
    expect(r.partial).toBe("not-loaded");
    expect(r.coverageSince).toBeNull();
    expect(partialReasonText(r, String)).toBe("not loaded");
  });

  test("REQ-HISTERR-04: alerts: null gives one no-data segment (partial kept)", () => {
    const r = deriveLaneSegments({ window: W, alerts: null, checks: [], checksNotLoaded: true, noData: [] });
    expect(rows(r.segments)).toEqual([[1000, 2000, "unknown", "no-data", []]]);
    expect(r.partial).toBe("not-loaded");
  });

  test("REQ-HISTERR-04: noData: null gives one no-data segment", () => {
    const r = deriveLaneSegments({ window: W, alerts: EXAMPLE, checks: [], checksNotLoaded: false, noData: null });
    expect(rows(r.segments)).toEqual([[1000, 2000, "unknown", "no-data", []]]);
    expect(r.partial).toBeNull();
  });

  test("REQ-LANE-03: no-data overrides a critical alert", () => {
    const r = deriveLaneSegments(input({ window: W, alerts: [lane("X", "critical", T, [[1000, 2000]])], noData: [{ start: 1200, end: 1300 }] }));
    expect(rows(r.segments)).toEqual([
      [1000, 1200, "critical", "alert", ["X"]],
      [1200, 1300, "unknown", "no-data", ["X"]],
      [1300, 2000, "critical", "alert", ["X"]],
    ]);
  });

  test("REQ-LANE-02: info alerts appear in alertnames without changing status; unknown severity reads warning", () => {
    const r = deriveLaneSegments(input({ window: W, alerts: [lane("Info", "info", T, [[1200, 1500]]), lane("Unk", "unknown", T, [[1600, 1700]])] }));
    expect(rows(r.segments)).toEqual([
      [1000, 1200, "ok", "ok", []],
      [1200, 1500, "ok", "ok", ["Info"]],
      [1500, 1600, "ok", "ok", []],
      [1600, 1700, "warning", "alert", ["Unk"]],
      [1700, 2000, "ok", "ok", []],
    ]);
  });

  test("intervals are clipped to the window; unparseable and zero-length intervals are skipped", () => {
    const broken: AlertHistoryLane = {
      ...lane("Broken", "critical", T, []),
      intervals: [
        { start: "nope", end: iso(1500), state: "firing", provenance: "vmalert" },
        { start: iso(1500), end: iso(1500), state: "firing", provenance: "vmalert" },
      ],
    };
    const r = deriveLaneSegments(input({ window: W, alerts: [lane("Edge", "warning", T, [[500, 1100], [1900, 2500]]), broken] }));
    expect(rows(r.segments)).toEqual([
      [1000, 1100, "warning", "alert", ["Edge"]],
      [1100, 1900, "ok", "ok", []],
      [1900, 2000, "warning", "alert", ["Edge"]],
    ]);
  });

  test("an empty or invalid window gives no segments", () => {
    expect(deriveLaneSegments(input({ window: { start: 5, end: 5 } }))).toEqual({ segments: [], partial: null, coverageSince: null });
    expect(deriveLaneSegments(input({ window: { start: 5, end: Number.POSITIVE_INFINITY } })).segments).toEqual([]);
  });

  test("REQ-LANE-02/03: seeded property — segments tile the window with no gaps or overlaps and coalesce", () => {
    const rnd = mulberry32(0x5eed);
    const sev: AlertHistoryLane["severity"][] = ["critical", "warning", "info", "unknown"];
    for (let run = 0; run < 300; run++) {
      const ws = Math.floor(rnd() * 1000);
      const w: TimeWindow = { start: ws, end: ws + 1 + Math.floor(rnd() * 2000) };
      const around = (): number => w.start - 300 + Math.floor(rnd() * (w.end - w.start + 600));
      const pair = (): [number, number] => {
        const a = around();
        const b = around();
        return [Math.min(a, b), Math.max(a, b)];
      };
      const alerts = Array.from({ length: Math.floor(rnd() * 6) }, (_, i) =>
        lane(`A${i % 3}`, sev[Math.floor(rnd() * 4)]!, T, Array.from({ length: 1 + Math.floor(rnd() * 3) }, pair)));
      const noData = Array.from({ length: Math.floor(rnd() * 3) }, () => {
        const [s, e] = pair();
        return { start: s, end: e };
      });
      const checks: CheckEvidence[] = rnd() < 0.5 ? [] : [{
        endpoint: "e",
        state: "ready",
        payload: {
          ...makeEndpointHistory("e", { results: [] }),
          fetchedAt: iso(w.end - Math.floor(rnd() * 100)),
          results: Array.from({ length: Math.floor(rnd() * 20) }, () => ({ timestamp: iso(around()), success: rnd() < 0.7, durationMs: 1 }))
            .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
          incidents: rnd() < 0.3 ? [(() => { const [s, e] = pair(); return { start: iso(s), end: iso(e), state: "failed" as const, provenance: "gatus" as const }; })()] : [],
        },
      }];
      const r = deriveLaneSegments({ window: w, alerts, checks, checksNotLoaded: rnd() < 0.3, noData });
      expectTiles(r.segments, w);
      for (let i = 1; i < r.segments.length; i++) {
        const a = r.segments[i - 1]!;
        const b = r.segments[i]!;
        const same = a.status === b.status && a.cause === b.cause && a.alertnames.join("\u0000") === b.alertnames.join("\u0000");
        expect(same).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Check evidence through the sweep (05 §5.8), gate stubbed with reachable = () => true
// ---------------------------------------------------------------------------

describe("check evidence (reachable = () => true)", () => {
  const N = TIMELINE_NOW_S;
  const W: TimeWindow = { start: N - 3_600, end: N };
  const node = serviceNode(["e"]);
  const evidence = (payload: EndpointHistoryPayload): readonly CheckEvidence[] =>
    checkEvidenceFor(node, () => ({ phase: "ready", data: payload }), ALWAYS);
  const every60 = (from: number, to: number, fail: (off: number) => boolean = () => false): [number, boolean][] => {
    const out: [number, boolean][] = [];
    for (let off = from; off <= to; off += 60) out.push([off, !fail(off)]);
    return out;
  };

  test("REQ-LANE-02: a failed result gives a critical/check segment", () => {
    const p = makeEndpointHistory("e", { results: every60(-3_600, 0, (o) => o === -1_800) });
    const r = deriveLaneSegments(input({ window: W, checks: evidence(p) }));
    expect(rows(r.segments)).toEqual([
      [N - 3_600, N - 1_800, "ok", "ok", []],
      [N - 1_800, N - 1_740, "critical", "check", []],
      [N - 1_740, N, "ok", "ok", []],
    ]);
    expect(r.partial).toBeNull();
  });

  test("a critical alert and a check failure tie → cause alert", () => {
    const p = makeEndpointHistory("e", { results: every60(-3_600, 0, (o) => o === -1_800) });
    const alerts = [lane("X", "critical", node.target, [[N - 1_800, N - 1_740]])];
    const r = deriveLaneSegments(input({ window: W, alerts, checks: evidence(p) }));
    expect(rows(r.segments)[1]).toEqual([N - 1_800, N - 1_740, "critical", "alert", ["X"]]);
  });

  test("REQ-LANE-03: a gap > 3× median spacing gives unknown/no-data when alerts are quiet, the alert status otherwise", () => {
    const p = makeEndpointHistory("e", { results: every60(-3_600, 0).filter(([o]) => o <= -2_040 || o >= -960) });
    const quiet = deriveLaneSegments(input({ window: W, checks: evidence(p) }));
    expect(rows(quiet.segments)).toEqual([
      [N - 3_600, N - 1_980, "ok", "ok", []],
      [N - 1_980, N - 960, "unknown", "no-data", []],
      [N - 960, N, "ok", "ok", []],
    ]);
    const alerts = [lane("W", "warning", node.target, [[N - 1_500, N - 1_200]])];
    const loud = deriveLaneSegments(input({ window: W, alerts, checks: evidence(p) }));
    expect(rows(loud.segments)).toEqual([
      [N - 3_600, N - 1_980, "ok", "ok", []],
      [N - 1_980, N - 1_500, "unknown", "no-data", []],
      [N - 1_500, N - 1_200, "warning", "alert", ["W"]],
      [N - 1_200, N - 960, "unknown", "no-data", []],
      [N - 960, N, "ok", "ok", []],
    ]);
    // Exactly 3× the median is still covered.
    const edge = makeEndpointHistory("e", { results: every60(-3_600, 0).filter(([o]) => o !== -1_800 && o !== -1_740) });
    expect(rows(deriveLaneSegments(input({ window: W, checks: evidence(edge) })).segments)).toEqual([[N - 3_600, N, "ok", "ok", []]]);
  });

  test("REQ-LANE-02: incidents merge as critical, capped at fetchedAt", () => {
    const p = makeEndpointHistory("e", { results: every60(-3_600, 0), incidents: [[-600, -300], [-60, 600]] });
    const r = deriveLaneSegments(input({ window: { start: N - 3_600, end: N + 600 }, checks: evidence(p) }));
    expect(rows(r.segments)).toEqual([
      [N - 3_600, N - 600, "ok", "ok", []],
      [N - 600, N - 300, "critical", "check", []],
      [N - 300, N - 60, "ok", "ok", []],
      [N - 60, N, "critical", "check", []],
      [N, N + 600, "ok", "ok", []],
    ]);
  });

  test("REQ-LANE-04: coverage-limited with coverageSince = first result when it is after the window start", () => {
    const p = makeEndpointHistory("e", { results: every60(-1_200, 0) });
    const r = deriveLaneSegments(input({ window: W, checks: evidence(p) }));
    expect(r.partial).toBe("coverage-limited");
    expect(r.coverageSince).toBe(N - 1_200);
    expect(rows(r.segments)).toEqual([[N - 3_600, N, "ok", "ok", []]]);
    expect(partialReasonText(r, (s) => `@${s - N}`)).toBe("check history covers only since @-1200");
    // First result exactly at the window start: complete evidence.
    const full = makeEndpointHistory("e", { results: every60(-3_600, 0) });
    expect(deriveLaneSegments(input({ window: W, checks: evidence(full) })).partial).toBeNull();
    // No results at all: coverage starts at fetchedAt.
    const empty = makeEndpointHistory("e", { results: [] });
    const e = deriveLaneSegments(input({ window: W, checks: evidence(empty) }));
    expect(e.partial).toBe("coverage-limited");
    expect(e.coverageSince).toBe(N);
  });

  test("REQ-LANE-03: nothing after the payload's fetchedAt reads ok (served-window no-data)", () => {
    const p = makeEndpointHistory("e", { results: every60(-3_600, 0) });
    const w: TimeWindow = { start: N - 3_600, end: N + 900 };
    const coverage = makeSeriesHistory("engine.active-series", "1h");
    const noData = noDataSpans(coverage, w, iso(N));
    expect(noData).toEqual([{ start: N, end: N + 900 }]);
    const r = deriveLaneSegments(input({ window: w, checks: evidence(p), noData }));
    for (const s of r.segments) if (s.end > N) expect([s.status, s.cause]).toEqual(["unknown", "no-data"]);
    expect(segmentAt(r.segments, N + 1)!.status).toBe("unknown");
    expect(segmentAt(r.segments, N - 1)!.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Partial precedence (05 §5.9.3) — decision table
// ---------------------------------------------------------------------------

describe("REQ-LANE-04: partial precedence evidence-unavailable > loading > not-loaded > coverage-limited", () => {
  const N = TIMELINE_NOW_S;
  const W: TimeWindow = { start: N - 3_600, end: N };
  const late: CheckEvidence = { endpoint: "late", state: "ready", payload: makeEndpointHistory("late", { results: [[-600, true], [-300, true]] }) };
  const full: CheckEvidence = {
    endpoint: "full",
    state: "ready",
    payload: makeEndpointHistory("full", { results: Array.from({ length: 61 }, (_, i) => [-3_600 + i * 60, true] as const) }),
  };
  const st = (state: "not-loaded" | "loading" | "unavailable" | "error"): CheckEvidence => ({ endpoint: state, state });
  const cases: readonly (readonly [string, readonly CheckEvidence[], boolean, string | null, number | null])[] = [
    ["nothing → null", [], false, null, null],
    ["full coverage → null", [full], false, null, null],
    ["late ready → coverage-limited", [late], false, "coverage-limited", N - 600],
    ["late + full → coverage-limited (max coveredFrom)", [full, late], false, "coverage-limited", N - 600],
    ["checksNotLoaded → not-loaded", [], true, "not-loaded", null],
    ["not-loaded check → not-loaded", [st("not-loaded")], false, "not-loaded", null],
    ["not-loaded beats coverage-limited", [late, st("not-loaded")], false, "not-loaded", null],
    ["checksNotLoaded beats coverage-limited", [late], true, "not-loaded", null],
    ["loading → loading", [st("loading")], false, "loading", null],
    ["loading beats not-loaded", [st("not-loaded"), st("loading")], true, "loading", null],
    ["loading beats coverage-limited", [late, st("loading")], false, "loading", null],
    ["unavailable → evidence-unavailable", [st("unavailable")], false, "evidence-unavailable", null],
    ["error → evidence-unavailable", [st("error")], false, "evidence-unavailable", null],
    ["evidence-unavailable beats loading", [st("loading"), st("error")], false, "evidence-unavailable", null],
    ["evidence-unavailable beats everything", [late, st("not-loaded"), st("loading"), st("unavailable")], true, "evidence-unavailable", null],
  ];
  for (const [name, checks, checksNotLoaded, partial, since] of cases) {
    test(`REQ-LANE-04: ${name}`, () => {
      const r = deriveLaneSegments(input({ window: W, checks, checksNotLoaded }));
      expect(r.partial).toBe(partial as never);
      expect(r.coverageSince).toBe(since);
      if (partial !== null) expect(partialReasonText(r, () => "t")).toBe(PARTIAL_REASON_TEXT[r.partial!].replace("{t}", "t"));
      // The marker never changes the fill.
      expect(rows(r.segments)).toEqual([[W.start, W.end, "ok", "ok", []]]);
    });
  }
});

// ---------------------------------------------------------------------------
// segmentAt, problemHostKeys
// ---------------------------------------------------------------------------

describe("REQ-ZOOM-01: segmentAt", () => {
  const T: TargetIdentity = { kind: "host", id: "host:h" };
  const segs = deriveLaneSegments(input({
    window: { start: 1000, end: 2000 },
    alerts: [lane("A", "warning", T, [[1200, 1300]]), lane("B", "critical", T, [[1500, 1600]])],
  })).segments;

  test("t = start, interior points, boundaries, t = the window end and outside", () => {
    expect(segs.length).toBe(5);
    expect(segmentAt(segs, 1000)).toBe(segs[0]!);
    expect(segmentAt(segs, 1199.5)).toBe(segs[0]!);
    expect(segmentAt(segs, 1200)).toBe(segs[1]!);
    expect(segmentAt(segs, 1550)).toBe(segs[3]!);
    expect(segmentAt(segs, 1600)).toBe(segs[4]!);
    expect(segmentAt(segs, 2000)).toBe(segs[4]!);
    expect(segmentAt(segs, 999.999)).toBeNull();
    expect(segmentAt(segs, 2000.001)).toBeNull();
    expect(segmentAt(segs, Number.NaN)).toBeNull();
    expect(segmentAt([], 1000)).toBeNull();
  });
});

describe("REQ-LANE-05: problemHostKeys", () => {
  const snap = makeHierarchySnapshot({ hosts: 4, servicesPerHost: 1 });
  const tree = buildLaneTree(snap, makeTimelineIndex(snap));
  const [h0, h1, h2, h3] = tree.hosts;
  const W: TimeWindow = { start: 1000, end: 2000 };
  const lanes = [
    lane("Own", "warning", h0!.target, [[1100, 1200]]),
    lane("Child", "critical", h1!.children[0]!.target, [[1900, 2100]]),
    lane("InfoOnly", "info", h2!.target, [[1100, 1200]]),
    lane("Outside", "critical", h3!.target, [[100, 1000]]),
    lane("Orphan", "critical", null, [[1100, 1200]]),
  ];

  test("REQ-LANE-05: status-changing intervals intersecting the window mark a host (own or child); info and outside do not", () => {
    expect([...problemHostKeys(tree, lanes, W)].sort()).toEqual([targetKey(h0!.target), targetKey(h1!.target)].sort());
    expect(problemHostKeys(tree, [], W).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LaneEvidenceCache (05 §5.12)
// ---------------------------------------------------------------------------

describe("REQ-PERF-05: createLaneEvidenceCache", () => {
  const T: TargetIdentity = { kind: "host", id: "host:h" };
  const W: TimeWindow = { start: 1000, end: 2000 };
  const alerts = [lane("A", "warning", T, [[1200, 1300]])];
  const noData: TimeWindow[] = [{ start: 1900, end: 2000 }];
  const P = makeEndpointHistory("e");
  const checks: CheckEvidence[] = [{ endpoint: "e", state: "ready", payload: P }, { endpoint: "f", state: "loading" }];
  const base: LaneEvidenceInput = { window: W, alerts, checks, checksNotLoaded: false, noData };
  const KEY: TargetKey = "host:host:h";

  function spied() {
    const derive = mock(deriveLaneSegments);
    return { derive, cache: createLaneEvidenceCache(derive) };
  }

  test("REQ-PERF-05: the default cache derives with deriveLaneSegments", () => {
    const cache = createLaneEvidenceCache();
    expect(cache.derive(KEY, base)).toEqual(deriveLaneSegments(base));
  });

  test("REQ-PERF-05: equivalent input returns the cached object without re-deriving", () => {
    const { derive, cache } = spied();
    const first = cache.derive(KEY, base);
    const again = cache.derive(KEY, {
      window: { start: 1000, end: 2000 },
      alerts,
      checks: [{ endpoint: "e", state: "ready", payload: P }, { endpoint: "f", state: "loading" }],
      checksNotLoaded: false,
      noData,
    });
    expect(again).toBe(first);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  const changes: readonly (readonly [string, LaneEvidenceInput])[] = [
    ["alerts reference", { ...base, alerts: [...alerts] }],
    ["alerts null", { ...base, alerts: null }],
    ["noData reference", { ...base, noData: [...noData] }],
    ["noData null", { ...base, noData: null }],
    ["the window start", { ...base, window: { start: 1001, end: 2000 } }],
    ["the window end", { ...base, window: { start: 1000, end: 2001 } }],
    ["checksNotLoaded", { ...base, checksNotLoaded: true }],
    ["checks length", { ...base, checks: checks.slice(0, 1) }],
    ["check endpoint", { ...base, checks: [checks[0]!, { endpoint: "g", state: "loading" }] }],
    ["check state", { ...base, checks: [checks[0]!, { endpoint: "f", state: "error" }] }],
    ["ready payload reference", { ...base, checks: [{ endpoint: "e", state: "ready", payload: { ...P } }, checks[1]!] }],
  ];
  for (const [field, changed] of changes) {
    test(`REQ-PERF-05: a change of ${field} recomputes`, () => {
      const { derive, cache } = spied();
      const first = cache.derive(KEY, base);
      const next = cache.derive(KEY, changed);
      expect(next).not.toBe(first);
      expect(derive).toHaveBeenCalledTimes(2);
      // And the new entry is now the cached one.
      expect(cache.derive(KEY, changed)).toBe(next);
      expect(derive).toHaveBeenCalledTimes(2);
    });
  }

  test("REQ-PERF-05: a cursor move (or pin) never re-derives", () => {
    const { derive, cache } = spied();
    const domain = signal<TimeWindow>(W);
    const axis = createTimeAxis({ domain, initialZoom: null, initialStepSeconds: 60 });
    const render = (): unknown => cache.derive(KEY, { ...base, window: axis.domain.value });
    const first = render();
    for (let t = 1000; t < 2000; t += 50) {
      axis.cursor.value = t;
      expect(render()).toBe(first);
    }
    axis.pinned.value = true;
    expect(render()).toBe(first);
    expect(derive).toHaveBeenCalledTimes(1);
    axis.dispose();
  });

  test("keys are independent and prune drops dead entries", () => {
    const { derive, cache } = spied();
    const a = cache.derive(KEY, base);
    const other: TargetKey = "service:svc:h/s";
    cache.derive(other, base);
    expect(derive).toHaveBeenCalledTimes(2);
    cache.prune(new Set([KEY]));
    expect(cache.derive(KEY, base)).toBe(a);
    cache.derive(other, base);
    expect(derive).toHaveBeenCalledTimes(3);
  });
});
