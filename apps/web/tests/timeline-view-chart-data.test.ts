// Unit tests for views/timeline/chart-data.ts (06 §4, §9 chart-data row). Pure: no DOM.

import { describe, expect, test } from "bun:test";
import type { HistoryPayload, HistorySeries } from "@pulse/web-data/wire";

import type { ChartData, SeriesSamples } from "../src/client/views/_shared/timeseries/chart-data.js";
import {
  TARGET_LABEL_KEYS,
  chartFractionMap,
  formatChartValue,
  nearestSample,
  sameChartData,
  seriesLabel,
  toChartData,
} from "../src/client/views/_shared/timeseries/chart-data.js";
import type { ClientQueryMeta } from "../src/client/views/_shared/timeseries/query-meta.js";
import { CLIENT_QUERY_META } from "../src/client/views/_shared/timeseries/query-meta.js";
import { browserZone, shiftForEstateZone } from "../src/client/views/_shared/timeseries/tz-shift.js";
import { TIMELINE_NOW_S, makeSeriesHistory } from "./timeline-fixtures.js";

const T0 = TIMELINE_NOW_S;
const UTC_ZONE = browserZone();
const CHICAGO = "America/Chicago";

function series(points: readonly (readonly [number, number | null])[], labels: Record<string, string> = {}): HistorySeries {
  return { labels, points: points.map(([s, v]) => [s * 1000, v] as const) };
}

function payload(seriesList: readonly HistorySeries[], o: { readonly step?: number; readonly fetchedAtS?: number } = {}): HistoryPayload {
  return {
    queryId: "host.cpu.utilization",
    target: { kind: "host", id: "host:web01" },
    range: "1h",
    fetchedAt: new Date((o.fetchedAtS ?? T0) * 1000).toISOString(),
    effectiveStepSeconds: o.step ?? 60,
    unit: "percent",
    stale: false,
    series: seriesList,
  };
}

describe("toChartData", () => {
  test("REQ-ZOOM-03: converts ms → s and puts sentinels exactly at the view start/end", () => {
    const p = payload([series([[T0 - 120, 1], [T0 - 60, 2]])]);
    const view = { start: T0 - 150, end: T0 };
    const d = toChartData(p, view, UTC_ZONE);
    expect(d.trueTimestamps).toEqual([T0 - 150, T0 - 120, T0 - 60, T0]);
    expect(d.trueTimestamps[0]).toBe(view.start);
    expect(d.trueTimestamps[d.trueTimestamps.length - 1]).toBe(view.end);
    expect(d.series[0]!.data).toEqual([null, 1, 2, null]);
    expect(d.timestamps).toEqual(d.trueTimestamps);
    expect(d.shifted).toBe(false);
    expect(d.hasData).toBe(true);
    expect(d.stepSeconds).toBe(60);
    expect(d.tzFallback).toBe(false);
  });

  test("REQ-ZOOM-03 / REQ-RANGE-03: sentinels are shifted in timestamps, true in trueTimestamps", () => {
    const p = payload([series([[T0 - 60, 5]])]);
    const view = { start: T0 - 3600, end: T0 };
    const d = toChartData(p, view, CHICAGO);
    expect(d.trueTimestamps[0]).toBe(view.start);
    expect(d.trueTimestamps[d.trueTimestamps.length - 1]).toBe(view.end);
    expect(d.timestamps).toEqual(shiftForEstateZone(d.trueTimestamps, CHICAGO));
    expect(d.timestamps[0]).toBe(shiftForEstateZone([view.start], CHICAGO)[0]!);
    expect(d.shifted).toBe(CHICAGO !== UTC_ZONE);
  });

  test("REQ-ZOOM-03: unions two series with null fillers that are never bridged", () => {
    const a = series([[T0 - 180, 1], [T0 - 120, 2], [T0 - 60, 3]], { instance: "a" });
    const b = series([[T0 - 150, 10], [T0 - 60, 30]], { instance: "b" });
    const d = toChartData(payload([a, b]), { start: T0 - 200, end: T0 }, UTC_ZONE);
    expect(d.trueTimestamps).toEqual([T0 - 200, T0 - 180, T0 - 150, T0 - 120, T0 - 60, T0]);
    expect(d.series[0]!.data).toEqual([null, 1, null, 2, 3, null]);
    expect(d.series[1]!.data).toEqual([null, null, 10, null, 30, null]);
    expect(d.series.map((s) => s.label)).toEqual(["a", "b"]);
  });

  test("REQ-ZOOM-03: a real sample at the edge replaces its sentinel value", () => {
    const p = payload([series([[T0 - 120, 1], [T0 - 60, 2], [T0, 3]])]);
    const d = toChartData(p, { start: T0 - 120, end: T0 }, UTC_ZONE);
    expect(d.trueTimestamps).toEqual([T0 - 120, T0 - 60, T0]);
    expect(d.series[0]!.data).toEqual([1, 2, 3]);
  });

  test("REQ-ZOOM-03: outside neighbours appear only in samples, never in timestamps", () => {
    const p = payload([series([[T0 - 300, 1], [T0 - 240, 2], [T0 - 180, 3], [T0 - 120, 4], [T0 - 60, 5]])]);
    const d = toChartData(p, { start: T0 - 250, end: T0 - 100 }, UTC_ZONE);
    expect(d.trueTimestamps).toEqual([T0 - 250, T0 - 240, T0 - 180, T0 - 120, T0 - 100]);
    expect(d.samples[0]!.t).toEqual([T0 - 300, T0 - 240, T0 - 180, T0 - 120, T0 - 60]);
    expect(d.samples[0]!.v).toEqual([1, 2, 3, 4, 5]);
  });

  test("REQ-ZOOM-03: a view past fetchedAt leaves a null tail gap", () => {
    const p = makeSeriesHistory("host.cpu.utilization", "1h");
    const d = toChartData(p, { start: T0 - 600, end: T0 + 600 }, UTC_ZONE);
    expect(d.trueTimestamps[d.trueTimestamps.length - 1]).toBe(T0 + 600);
    expect(d.series[0]!.data[d.series[0]!.data.length - 1]).toBeNull();
    expect(d.hasData).toBe(true);
    // Entirely past fetchedAt: only sentinels, all null, hasData false.
    const past = toChartData(p, { start: T0 + 60, end: T0 + 600 }, UTC_ZONE);
    expect(past.trueTimestamps).toEqual([T0 + 60, T0 + 600]);
    expect(past.series[0]!.data).toEqual([null, null]);
    expect(past.hasData).toBe(false);
  });

  test("REQ-ZOOM-03: a view before the fetched window yields null gaps and hasData false", () => {
    const p = makeSeriesHistory("host.cpu.utilization", "1h");
    const d = toChartData(p, { start: T0 - 86_400, end: T0 - 82_800 }, UTC_ZONE);
    expect(d.trueTimestamps).toEqual([T0 - 86_400, T0 - 82_800]);
    expect(d.series[0]!.data).toEqual([null, null]);
    expect(d.hasData).toBe(false);
    // The readout still sees the first fetched point as the outside neighbour.
    expect(d.samples[0]!.t).toEqual([T0 - 3600]);
  });

  test("REQ-ZOOM-03: null in-view values do not count as data and gaps stay null", () => {
    const p = payload([series([[T0 - 120, null], [T0 - 60, null]])]);
    const d = toChartData(p, { start: T0 - 180, end: T0 }, UTC_ZONE);
    expect(d.series[0]!.data).toEqual([null, null, null, null]);
    expect(d.hasData).toBe(false);
  });

  test("REQ-CHART-03: drops non-finite timestamps, nulls non-finite values and sorts unordered points", () => {
    const raw = { labels: {}, points: [[(T0 - 60) * 1000, 2], [NaN, 9], [(T0 - 120) * 1000, Infinity]] } as unknown as HistorySeries;
    const d = toChartData(payload([raw]), { start: T0 - 180, end: T0 }, UTC_ZONE);
    expect(d.trueTimestamps).toEqual([T0 - 180, T0 - 120, T0 - 60, T0]);
    expect(d.series[0]!.data).toEqual([null, null, 2, null]);
  });

  test("REQ-CHART-03: an empty payload or an invalid view never throws", () => {
    const empty = toChartData(payload([]), { start: T0 - 60, end: T0 }, UTC_ZONE);
    expect(empty.series).toEqual([]);
    expect(empty.hasData).toBe(false);
    expect(empty.trueTimestamps).toEqual([T0 - 60, T0]);
    const p = payload([series([[T0 - 60, 1]])]);
    for (const view of [{ start: T0, end: T0 }, { start: T0, end: T0 - 60 }, { start: NaN, end: T0 }]) {
      const d = toChartData(p, view, UTC_ZONE);
      expect(d.timestamps).toEqual([]);
      expect(d.series).toEqual([]);
      expect(d.hasData).toBe(false);
    }
  });

  test("REQ-CHART-03: the result and every array are frozen", () => {
    const d = toChartData(payload([series([[T0 - 60, 1]])]), { start: T0 - 120, end: T0 }, UTC_ZONE);
    expect(Object.isFrozen(d)).toBe(true);
    expect(Object.isFrozen(d.timestamps)).toBe(true);
    expect(Object.isFrozen(d.trueTimestamps)).toBe(true);
    expect(Object.isFrozen(d.series)).toBe(true);
    expect(Object.isFrozen(d.series[0]!.data)).toBe(true);
    expect(Object.isFrozen(d.samples[0]!.t)).toBe(true);
  });

  test("REQ-SEC-02: an unsupported zone sets tzFallback and plots UTC wall time", () => {
    const p = payload([series([[T0 - 60, 1]])]);
    const d = toChartData(p, { start: T0 - 120, end: T0 }, "Not/A_Zone");
    expect(d.tzFallback).toBe(true);
    expect(toChartData(p, { start: T0 - 120, end: T0 }, CHICAGO).tzFallback).toBe(false);
  });
});

describe("seriesLabel", () => {
  test("REQ-SEC-02: TARGET_LABEL_KEYS are tried in order", () => {
    expect(TARGET_LABEL_KEYS).toEqual(["instance", "host", "service", "key", "integration"]);
    expect(seriesLabel({ host: "web01", instance: "10.0.0.1:9100" }, "value")).toBe("10.0.0.1:9100");
    expect(seriesLabel({ service: "nginx", host: "web01" }, "value")).toBe("web01");
    expect(seriesLabel({ instance: "", integration: "slack" }, "value")).toBe("slack");
  });

  test("REQ-SEC-02: otherwise a sorted k=v join excluding __name__, else the fallback", () => {
    expect(seriesLabel({ zeta: "1", alpha: "<b>x</b>", __name__: "up" }, "value")).toBe("alpha=<b>x</b>, zeta=1");
    expect(seriesLabel({ __name__: "up" }, "value")).toBe("value");
    expect(seriesLabel({}, "value")).toBe("value");
  });

  test("REQ-SEC-02: toChartData de-duplicates labels with ' (2)', ' (3)'", () => {
    const d = toChartData(
      payload([series([[T0 - 60, 1]]), series([[T0 - 60, 2]]), series([[T0 - 60, 3]]), series([[T0 - 60, 4]], { instance: "value (2)" })]),
      { start: T0 - 120, end: T0 },
      UTC_ZONE,
    );
    expect(d.series.map((s) => s.label)).toEqual(["value", "value (2)", "value (3)", "value (2) (2)"]);
  });
});

describe("memoisation and structural equality", () => {
  test("REQ-FOLLOW-03: the same (payload, view, zone) returns the identical object", () => {
    const p = makeSeriesHistory("host.cpu.utilization", "1h");
    const view = { start: T0 - 1800, end: T0 };
    const a = toChartData(p, view, UTC_ZONE);
    const b = toChartData(p, { start: T0 - 1800, end: T0 }, UTC_ZONE);
    expect(b).toBe(a);
    expect(b.timestamps).toBe(a.timestamps);
  });

  test("REQ-FOLLOW-03: a changed view or zone gives a new object", () => {
    const p = makeSeriesHistory("host.cpu.utilization", "1h");
    const a = toChartData(p, { start: T0 - 1800, end: T0 }, UTC_ZONE);
    const b = toChartData(p, { start: T0 - 1200, end: T0 }, UTC_ZONE);
    expect(b).not.toBe(a);
    const c = toChartData(p, { start: T0 - 1200, end: T0 }, CHICAGO);
    expect(c).not.toBe(b);
  });

  test("REQ-FOLLOW-03: sameChartData is structural", () => {
    const view = { start: T0 - 1800, end: T0 };
    const a = toChartData(makeSeriesHistory("host.cpu.utilization", "1h"), view, UTC_ZONE);
    const b = toChartData(makeSeriesHistory("host.cpu.utilization", "1h"), view, UTC_ZONE);
    expect(b).not.toBe(a);
    expect(sameChartData(a, b)).toBe(true);
    expect(sameChartData(a, a)).toBe(true);
    expect(sameChartData(null, null)).toBe(true);
    expect(sameChartData(a, null)).toBe(false);
    const gap = toChartData(makeSeriesHistory("host.cpu.utilization", "1h", { gaps: [[-600, -300]] }), view, UTC_ZONE);
    expect(sameChartData(a, gap)).toBe(false);
    const zoomed = toChartData(makeSeriesHistory("host.cpu.utilization", "1h"), { start: T0 - 1200, end: T0 }, UTC_ZONE);
    expect(sameChartData(a, zoomed)).toBe(false);
    expect(sameChartData(a, { ...a, stepSeconds: 120 })).toBe(false);
    expect(sameChartData(a, { ...a, series: [{ ...a.series[0]!, label: "other" }] })).toBe(false);
  });
});

describe("chartFractionMap", () => {
  function hand(trueTs: readonly number[], shifted: readonly number[]): ChartData {
    return {
      timestamps: shifted, trueTimestamps: trueTs, series: [], samples: [],
      hasData: false, stepSeconds: 60, shifted: true, tzFallback: false,
    };
  }

  test("REQ-RANGE-03: null for a constant shift", () => {
    expect(chartFractionMap(hand([0, 60, 120], [-18_000, -17_940, -17_880]))).toBeNull();
    const d = toChartData(makeSeriesHistory("host.cpu.utilization", "1h"), { start: T0 - 1800, end: T0 }, CHICAGO);
    expect(chartFractionMap(d)).toBeNull();
    expect(chartFractionMap(hand([], []))).toBeNull();
  });

  test("REQ-RANGE-03: monotone across a DST fold", () => {
    const fall = Date.UTC(2026, 10, 1, 7, 0, 0) / 1000;
    const trueTs: number[] = [];
    for (let t = fall - 7200; t <= fall + 7200; t += 600) trueTs.push(t);
    const map = chartFractionMap(hand(trueTs, shiftForEstateZone(trueTs, CHICAGO)));
    // bun test runs in UTC by default; under UTC the Chicago fall-back is a real fold.
    if (UTC_ZONE === "UTC") expect(map).not.toBeNull();
    // Independent of the process zone: a hand-built half-speed segment, as a fold repair produces.
    const synthetic = chartFractionMap(hand([0, 100, 200, 300], [0, 50, 100, 250]));
    expect(synthetic).not.toBeNull();
    const m = synthetic!;
    expect(m.toFraction(0)).toBe(0);
    expect(m.toFraction(300)).toBe(1);
    expect(m.toFraction(100)).toBeCloseTo(0.2, 9);
    expect(m.toFraction(-50)).toBeCloseTo(-0.2, 9); // slope 1 beyond the ends, unclamped
    let prev = -Infinity;
    for (let t = -50; t <= 350; t += 5) {
      const f = m.toFraction(t);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
    for (let f = 0; f <= 1; f += 0.05) expect(m.toFraction(m.fromFraction(f))).toBeCloseTo(f, 9);
    expect(m.fromFraction(-1)).toBe(0);
    expect(m.fromFraction(2)).toBe(300);
    if (map !== null) {
      let p = -Infinity;
      for (const t of trueTs) {
        const f = map.toFraction(t);
        expect(f).toBeGreaterThan(p);
        p = f;
      }
    }
  });
});

describe("nearestSample", () => {
  const s: SeriesSamples = { t: [100, 160, 220, 280], v: [1, 2, null, 4] };

  test("REQ-ZOOM-01: nearest by distance, ties resolve to the earlier sample", () => {
    expect(nearestSample(s, 100, 60)).toEqual({ t: 100, v: 1 });
    expect(nearestSample(s, 125, 60)).toEqual({ t: 100, v: 1 });
    expect(nearestSample(s, 130, 60)).toEqual({ t: 100, v: 1 }); // tie at 30 s → earlier
    expect(nearestSample(s, 131, 60)).toEqual({ t: 160, v: 2 });
    expect(nearestSample(s, 290, 60)).toEqual({ t: 280, v: 4 });
  });

  test("REQ-ZOOM-01: honours maxDistance and gap samples", () => {
    expect(nearestSample(s, 30, 60)).toBeNull();
    expect(nearestSample(s, 40, 60)).toEqual({ t: 100, v: 1 });
    expect(nearestSample(s, 400, 60)).toBeNull();
    expect(nearestSample(s, 220, 60)).toBeNull(); // nearest is a null gap
    expect(nearestSample({ t: [], v: [] }, 100, 60)).toBeNull();
    expect(nearestSample(s, NaN, 60)).toBeNull();
  });
});

describe("formatChartValue", () => {
  test("REQ-ZOOM-01: covers every ClientQueryMeta unit", () => {
    const units = new Set(Object.values(CLIENT_QUERY_META).map((m) => m.unit));
    const all: ClientQueryMeta["unit"][] = ["count", "bytes", "seconds", "percent", "scalar", "milliseconds", "state"];
    for (const u of units) expect(all).toContain(u);
    expect(formatChartValue(42.14, "percent")).toBe("42.1 %");
    expect(formatChartValue(1.5 * 1024 ** 3, "bytes")).toBe("1.5 GiB");
    expect(formatChartValue(512, "bytes")).toBe("512.0 B");
    expect(formatChartValue(2048, "bytes")).toBe("2.0 KiB");
    expect(formatChartValue(0.25, "seconds")).toBe("250 ms");
    expect(formatChartValue(42, "seconds")).toBe("42.0 s");
    expect(formatChartValue(600, "seconds")).toBe("10.0 min");
    expect(formatChartValue(10_800, "seconds")).toBe("3.0 h");
    expect(formatChartValue(250, "milliseconds")).toBe("250 ms");
    expect(formatChartValue(1500, "milliseconds")).toBe("1.5 s");
    expect(formatChartValue(1_234_567, "count")).toBe("1.2M");
    expect(formatChartValue(950, "count")).toBe("950");
    expect(formatChartValue(1.23456, "scalar")).toBe("1.23");
    expect(formatChartValue(1, "state")).toBe("1");
  });

  test("REQ-ZOOM-01: non-finite values read 'no value'", () => {
    for (const u of ["count", "bytes", "seconds", "percent", "scalar", "milliseconds", "state"] as const) {
      expect(formatChartValue(NaN, u)).toBe("no value");
      expect(formatChartValue(Infinity, u)).toBe("no value");
    }
  });
});
