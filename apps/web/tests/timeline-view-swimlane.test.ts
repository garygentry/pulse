// Unit tests for views/timeline/swimlane-pack.ts: severity rows and greedy sub-lane packing
// (05 §6, 08 §3.3). Pure: no DOM.

import { describe, expect, test } from "bun:test";

import type { AlertHistoryLane, HashId, IntervalHistoryPayload } from "@pulse/web-data/wire";
import type { TimeWindow } from "../src/client/views/_shared/timeseries/axis.js";
import { buildLaneTree } from "../src/client/views/timeline/model.js";
import {
  MAX_SUBLANES,
  SWIM_ROW_ORDER,
  UNMATCHED_TARGET_TEXT,
  buildSeverityRows,
  overflowText,
  packSeverityRow,
} from "../src/client/views/timeline/swimlane-pack.js";
import type { SwimInterval } from "../src/client/views/timeline/swimlane-pack.js";
import { TIMELINE_INCIDENT, TIMELINE_NOW_S, makeAlertHistory, makeAlertLane, makeHierarchySnapshot } from "./timeline-fixtures.js";

const DAY = 86_400;
const FULL: TimeWindow = { start: TIMELINE_NOW_S - DAY, end: TIMELINE_NOW_S };

function iv(name: string, start: number, end: number): SwimInterval {
  return {
    laneId: `sha256:${name}` as HashId, alertname: name, severity: "warning", target: null, unmatched: true, start, end,
  };
}

function names(list: readonly SwimInterval[]): string[] {
  return list.map((i) => i.alertname);
}

/** Tiny seeded PRNG (mulberry32) for the property test. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// ---------------------------------------------------------------------------
// Text carriers
// ---------------------------------------------------------------------------

describe("text carriers (05 §6.1)", () => {
  test("REQ-SWIM-03: copy and row order", () => {
    expect(UNMATCHED_TARGET_TEXT).toBe("unmatched target");
    expect(overflowText(2)).toBe("+2 overlapping");
    expect(SWIM_ROW_ORDER).toEqual(["critical", "warning", "info", "unknown"]);
    expect(MAX_SUBLANES).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// packSeverityRow
// ---------------------------------------------------------------------------

describe("packSeverityRow (05 §6.3)", () => {
  test("REQ-SWIM-02: reproduces the 05 §6.3 worked example", () => {
    const a = iv("a", 100, 200);
    const b = iv("b", 120, 150);
    const c = iv("c", 130, 180);
    const d = iv("d", 140, 160);
    const e = iv("e", 145, 190);
    const f = iv("f", 210, 220);
    const input = [f, e, d, c, b, a];
    const lanes = packSeverityRow(input);
    expect(lanes.map((l) => ({ index: l.index, names: names(l.intervals), overflow: l.overflow }))).toEqual([
      { index: 0, names: ["a", "f"], overflow: 0 },
      { index: 1, names: ["b"], overflow: 0 },
      { index: 2, names: ["c"], overflow: 0 },
      { index: 3, names: ["d", "e"], overflow: 1 },
    ]);
    // Input not mutated.
    expect(names(input)).toEqual(["f", "e", "d", "c", "b", "a"]);
  });

  test("REQ-SWIM-02: one empty sub-lane for []", () => {
    expect(packSeverityRow([])).toEqual([{ index: 0, intervals: [], overflow: 0 }]);
  });

  test("REQ-SWIM-02: half-open intervals that touch share a sub-lane", () => {
    const lanes = packSeverityRow([iv("x", 0, 10), iv("y", 10, 20)]);
    expect(lanes.length).toBe(1);
    expect(names(lanes[0]!.intervals)).toEqual(["x", "y"]);
  });

  test("REQ-SWIM-02: never exceeds MAX_SUBLANES and preserves the total interval count (seeded)", () => {
    const rand = mulberry32(0x5eed);
    for (let run = 0; run < 200; run++) {
      const n = Math.floor(rand() * 40);
      const input: SwimInterval[] = [];
      for (let i = 0; i < n; i++) {
        const start = Math.floor(rand() * 1000);
        input.push(iv(`i${i}`, start, start + 1 + Math.floor(rand() * 200)));
      }
      const lanes = packSeverityRow(input);
      expect(lanes.length).toBeGreaterThanOrEqual(1);
      expect(lanes.length).toBeLessThanOrEqual(MAX_SUBLANES);
      expect(lanes.reduce((s, l) => s + l.intervals.length, 0)).toBe(n);
      lanes.forEach((l, index) => {
        expect(l.index).toBe(index);
        // Only the last sub-lane may overflow; non-overflow sub-lanes hold no overlaps.
        if (index < MAX_SUBLANES - 1) expect(l.overflow).toBe(0);
        if (l.overflow === 0) {
          for (let k = 1; k < l.intervals.length; k++) {
            expect(l.intervals[k - 1]!.end).toBeLessThanOrEqual(l.intervals[k]!.start);
          }
        }
      });
    }
  });
});

// ---------------------------------------------------------------------------
// buildSeverityRows
// ---------------------------------------------------------------------------

describe("buildSeverityRows (05 §6.2)", () => {
  const snapshot = makeHierarchySnapshot({ hosts: 3, servicesPerHost: 1 });
  const tree = buildLaneTree(snapshot, null);
  const host1 = { kind: "host", id: "host:host-001" } as const;

  test("REQ-SWIM-01: rows critical, warning, info; unknown only when present", () => {
    const withoutUnknown = makeAlertHistory("24h", [
      makeAlertLane({ alertname: "A", severity: "warning", target: host1, intervals: [[-600, -300]] }),
    ]);
    expect(buildSeverityRows(withoutUnknown, tree, FULL).map((r) => r.severity)).toEqual(["critical", "warning", "info"]);
    const rows = buildSeverityRows(TIMELINE_INCIDENT.alerts, buildLaneTree(TIMELINE_INCIDENT.snapshot, TIMELINE_INCIDENT.index), FULL);
    expect(rows.map((r) => r.severity)).toEqual(["critical", "warning", "info", "unknown"]);
    // Empty rows still carry one empty sub-lane.
    const critical = buildSeverityRows(withoutUnknown, tree, FULL)[0]!;
    expect(critical.subLanes).toEqual([{ index: 0, intervals: [], overflow: 0 }]);
    expect(critical.ordered).toEqual([]);
  });

  test("REQ-SWIM-01: unknown is omitted when its intervals fall outside the window", () => {
    const payload = makeAlertHistory("24h", [
      makeAlertLane({ alertname: "U", severity: "unknown", target: host1, intervals: [[-7_200, -3_600]] }),
    ]);
    const lastHalfHour: TimeWindow = { start: TIMELINE_NOW_S - 1_800, end: TIMELINE_NOW_S };
    expect(buildSeverityRows(payload, tree, lastHalfHour).map((r) => r.severity)).toEqual(["critical", "warning", "info"]);
  });

  test("REQ-SWIM-01: [] only for a payload with no parseable interval", () => {
    expect(buildSeverityRows(makeAlertHistory("24h", []), tree, FULL)).toEqual([]);
    const garbage = makeAlertLane({ alertname: "G", severity: "critical", target: host1, intervals: [[-60, -30]] });
    const bad: AlertHistoryLane = {
      ...garbage,
      intervals: [
        { ...garbage.intervals[0]!, start: "not-a-date" },
        { ...garbage.intervals[0]!, end: "" },
        { ...garbage.intervals[0]!, end: garbage.intervals[0]!.start }, // zero-length
      ],
    };
    expect(buildSeverityRows(makeAlertHistory("24h", [bad]), tree, FULL)).toEqual([]);
    // Parseable intervals entirely outside the window still give rows (with empty sub-lanes).
    const old = makeAlertHistory("24h", [
      makeAlertLane({ alertname: "Old", severity: "critical", target: host1, intervals: [[-80_000, -79_000]] }),
    ]);
    const rows = buildSeverityRows(old, tree, { start: TIMELINE_NOW_S - 600, end: TIMELINE_NOW_S });
    expect(rows.map((r) => r.severity)).toEqual(["critical", "warning", "info"]);
    expect(rows.every((r) => r.ordered.length === 0 && r.subLanes.length === 1)).toBe(true);
  });

  test("REQ-SWIM-03/REQ-LANE-07: zero-length and unparseable intervals are skipped; valid ones kept", () => {
    const lane = makeAlertLane({ alertname: "Mixed", severity: "critical", target: host1, intervals: [[-600, -300], [-200, -200]] });
    const withGarbage: AlertHistoryLane = { ...lane, intervals: [...lane.intervals, { ...lane.intervals[0]!, start: "nope" }] };
    const rows = buildSeverityRows(makeAlertHistory("24h", [withGarbage]), tree, FULL);
    expect(rows[0]!.ordered.length).toBe(1);
    expect(rows[0]!.ordered[0]!.start).toBe(TIMELINE_NOW_S - 600);
  });

  test("REQ-LANE-07/REQ-SWIM-03: unmatched for attribution 'unmatched', a null target, or a target absent from the tree", () => {
    const matched = makeAlertLane({ alertname: "M", severity: "warning", target: host1, intervals: [[-900, -800]] });
    const nullTarget = makeAlertLane({ alertname: "N", severity: "warning", target: null, intervals: [[-800, -700]] });
    const attributedUnmatched: AlertHistoryLane = {
      ...makeAlertLane({ alertname: "U", severity: "warning", target: host1, intervals: [[-700, -600]] }),
      attribution: "unmatched",
    };
    const absent = makeAlertLane({ alertname: "X", severity: "warning", target: { kind: "host", id: "host:gone" }, intervals: [[-600, -500]] });
    const endpoint = makeAlertLane({ alertname: "E", severity: "warning", target: { kind: "endpoint", id: "host-001/nginx" }, intervals: [[-500, -400]] });
    const service = makeAlertLane({ alertname: "S", severity: "warning", target: { kind: "service", id: "svc:host-002/nginx" }, intervals: [[-400, -300]] });
    const payload = makeAlertHistory("24h", [matched, nullTarget, attributedUnmatched, absent, endpoint, service]);

    const byName = (t: typeof tree | null) =>
      Object.fromEntries(buildSeverityRows(payload, t, FULL)[1]!.ordered.map((i) => [i.alertname, i.unmatched]));
    expect(byName(tree)).toEqual({ M: false, N: true, U: true, X: true, E: true, S: false });
    // With no tree yet, only attribution decides.
    expect(byName(null)).toEqual({ M: false, N: true, U: true, X: false, E: false, S: false });
  });

  test("REQ-SWIM-01: intervals keep true (untruncated) bounds and are filtered by window intersection", () => {
    const lane = makeAlertLane({
      alertname: "Span", severity: "critical", target: host1,
      intervals: [[-7_200, -1_800], [-1_000, -900], [-5_000, -3_600], [-3_000, -2_000]],
    });
    const view: TimeWindow = { start: TIMELINE_NOW_S - 3_600, end: TIMELINE_NOW_S - 1_000 };
    const ordered = buildSeverityRows(makeAlertHistory("24h", [lane]), tree, view)[0]!.ordered;
    // [-5000,-3600) ends exactly at view.start (excluded); [-1000,-900) starts at view.end (excluded).
    expect(ordered.map((i) => [i.start - TIMELINE_NOW_S, i.end - TIMELINE_NOW_S])).toEqual([
      [-7_200, -1_800],
      [-3_000, -2_000],
    ]);
    expect(ordered[0]!.laneId).toBe(lane.id);
    expect(ordered[0]!.alertname).toBe("Span");
    expect(ordered[0]!.target).toEqual(host1);
  });

  test("REQ-SWIM-02/REQ-SWIM-04: ordered is sorted by (start, end, laneId) and packs the incident's overlapping criticals", () => {
    const a = makeAlertLane({ alertname: "A", severity: "warning", target: host1, intervals: [[-500, -100]] });
    const b = makeAlertLane({ alertname: "B", severity: "warning", target: host1, intervals: [[-500, -300], [-900, -800]] });
    const c = makeAlertLane({ alertname: "C", severity: "warning", target: host1, intervals: [[-500, -300]] });
    const ordered = buildSeverityRows(makeAlertHistory("24h", [a, b, c]), tree, FULL)[1]!.ordered;
    const lo = b.id < c.id ? "B" : "C";
    const hi = lo === "B" ? "C" : "B";
    expect(names(ordered)).toEqual(["B", lo, hi, "A"]);

    const rows = buildSeverityRows(TIMELINE_INCIDENT.alerts, buildLaneTree(TIMELINE_INCIDENT.snapshot, TIMELINE_INCIDENT.index), FULL);
    const critical = rows[0]!;
    expect(critical.ordered.length).toBe(6);
    expect(critical.subLanes.length).toBe(MAX_SUBLANES);
    expect(critical.subLanes[MAX_SUBLANES - 1]!.overflow).toBe(2);
    expect(critical.subLanes.reduce((s, l) => s + l.intervals.length, 0)).toBe(6);
    // The domain-style warning (null target) is unmatched; info lands in the info row.
    expect(rows[1]!.ordered.find((i) => i.alertname === "DomainExpiring")!.unmatched).toBe(true);
    expect(rows[2]!.ordered.map((i) => i.alertname)).toEqual(["BackupCompleted"]);
    expect(rows[3]!.ordered.map((i) => i.alertname)).toEqual(["UnlabelledAlert"]);
  });

  test("never throws on an out-of-contract severity", () => {
    const lane = makeAlertLane({ alertname: "W", severity: "warning", target: host1, intervals: [[-60, -30]] });
    const weird = { ...lane, severity: "page" } as unknown as AlertHistoryLane;
    const payload: IntervalHistoryPayload = makeAlertHistory("24h", [weird]);
    expect(() => buildSeverityRows(payload, tree, FULL)).not.toThrow();
  });
});
