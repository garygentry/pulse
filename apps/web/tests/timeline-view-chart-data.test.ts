// Unit tests for views/timeline/chart-data.ts (06 §4, §9 chart-data row). Pure: no DOM.

import { describe, expect, test } from "bun:test";
import type { HistoryPayload, HistorySeries } from "@pulse/web-data/wire";

import type { ChartData, SeriesSamples } from "../src/client/views/_shared/timeseries/chart-data.js";
import {
  TARGET_LABEL_KEYS,
  chartFractionMap,
  axisSplits,
  displayScale,
  formatAxisTicks,
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
    expect(formatChartValue(0.25, "percent")).toBe("0.25 %");
    expect(formatChartValue(1.5 * 1024 ** 3, "bytes")).toBe("1.5 GiB");
    expect(formatChartValue(512, "bytes")).toBe("512 B");
    expect(formatChartValue(1010, "bytes")).toBe("1,010 B");
    expect(formatChartValue(2048, "bytes")).toBe("2 KiB");
    expect(formatChartValue(0.0002, "seconds")).toBe("200 µs");
    expect(formatChartValue(0.25, "seconds")).toBe("250 ms");
    expect(formatChartValue(42, "seconds")).toBe("42 s");
    expect(formatChartValue(600, "seconds")).toBe("10 min");
    expect(formatChartValue(10_800, "seconds")).toBe("3 h");
    expect(formatChartValue(250, "milliseconds")).toBe("250 ms");
    expect(formatChartValue(1500, "milliseconds")).toBe("1.5 s");
    expect(formatChartValue(1_234_567, "count")).toBe("1.23M");
    expect(formatChartValue(950, "count")).toBe("950");
    expect(formatChartValue(1.23456, "scalar")).toBe("1.23");
    expect(formatChartValue(1, "state")).toBe("1");
    expect(formatChartValue(0, "bytes")).toBe("0");
  });

  test("REQ-ZOOM-01: non-finite values read 'no value'", () => {
    for (const u of ["count", "bytes", "seconds", "percent", "scalar", "milliseconds", "state"] as const) {
      expect(formatChartValue(NaN, u)).toBe("no value");
      expect(formatChartValue(Infinity, u)).toBe("no value");
    }
  });
});

describe("y-axis ticks (#15 unit-aware axis)", () => {
  const GiB = 1024 ** 3;
  /** Labels for uPlot's scale range [min, max] with a tick budget, as the chart computes them. */
  const axis = (min: number, max: number, unit: ClientQueryMeta["unit"], maxTicks = 6) =>
    formatAxisTicks(axisSplits(min, max, unit, maxTicks), unit);

  test("ticks are round in the display unit, so labels sit exactly on their gridlines", () => {
    expect(axis(5.2e9, 6.6e9, "bytes")).toEqual(["5 GiB", "5.2 GiB", "5.4 GiB", "5.6 GiB", "5.8 GiB", "6 GiB"]);
    expect(axis(0, 6.6e9, "bytes")).toEqual(["0", "2 GiB", "4 GiB", "6 GiB"]);
    expect(axis(0, 6000, "seconds")).toEqual(["0", "30 min", "60 min", "90 min"]);
    expect(axis(0, 20_000, "seconds")).toEqual(["0", "1 h", "2 h", "3 h", "4 h", "5 h"]);
    expect(axis(0, 0.62, "seconds")).toEqual(["0", "200 ms", "400 ms", "600 ms"]);
    expect(axis(0, 0.0004, "seconds")).toEqual(["0", "100 µs", "200 µs", "300 µs", "400 µs"]);
    expect(axis(0, 1500, "milliseconds")).toEqual(["0", "0.5 s", "1 s", "1.5 s"]);
    expect(axis(99.4, 100, "percent")).toEqual(["99.4 %", "99.6 %", "99.8 %", "100 %"]);
    expect(axis(30_000, 52_000, "count")).toEqual(["30K", "35K", "40K", "45K", "50K"]);
    expect(axis(0, 1.2e6, "count")).toEqual(["0", "0.25M", "0.5M", "0.75M", "1M"]);
    expect(axis(0, 0.022, "count")).toEqual(["0", "0.005", "0.01", "0.015", "0.02"]);
    expect(axis(-5, 5, "count")).toEqual(["-4", "-2", "0", "2", "4"]);
    // Every tick is an exact multiple of the step in display units.
    for (const [min, max, unit] of [[5.2e9, 6.6e9, "bytes"], [0, 6000, "seconds"], [99.4, 100, "percent"]] as const) {
      const sp = axisSplits(min, max, unit, 6);
      const div = displayScale(Math.max(Math.abs(min), Math.abs(max)), unit).div;
      const step = (sp[1]! - sp[0]!) / div;
      for (const t of sp) expect(Math.abs(t / div / step - Math.round(t / div / step))).toBeLessThan(1e-9);
    }
  });

  test("minutes and hours step on clock values (1/2/5/10/15/30 min, 1/2/3/6/12 h)", () => {
    const minuteSteps = new Set<number>();
    const hourSteps = new Set<number>();
    for (let max = 150; max < 7200; max *= 1.37) {
      const sp = axisSplits(0, max, "seconds", 5);
      if (sp.length > 1) minuteSteps.add((sp[1]! - sp[0]!) / 60);
    }
    for (let max = 7200; max < 200_000; max *= 1.37) {
      const sp = axisSplits(0, max, "seconds", 5);
      if (sp.length > 1) hourSteps.add((sp[1]! - sp[0]!) / 3600);
    }
    for (const st of minuteSteps) expect([0.5, 1, 2, 5, 10, 15, 30]).toContain(st);
    for (const st of hourSteps) expect([0.5, 1, 2, 3, 6, 12, 24, 48]).toContain(st);
  });

  test("respects the tick budget and degenerate ranges", () => {
    expect(axisSplits(0, 6.6e9, "bytes", 3).length).toBeLessThanOrEqual(3);
    expect(axisSplits(0, 1, "percent", 12).length).toBeLessThanOrEqual(12);
    expect(axisSplits(5, 5, "count", 6)).toEqual([5]);
    expect(axisSplits(5, 4, "count", 6)).toEqual([]);
    expect(axisSplits(NaN, 4, "count", 6)).toEqual([]);
  });

  test("the axis and the readout pick the same unit (shared displayScale thresholds)", () => {
    expect(formatChartValue(0.0002, "seconds")).toBe("200 µs");
    expect(axis(0, 0.0004, "seconds")).toContain("200 µs");
    expect(formatChartValue(0.25, "percent")).toBe("0.25 %");
    expect(formatAxisTicks([0, 0.25, 0.5], "percent")).toEqual(["0", "0.25 %", "0.5 %"]);
    expect(formatChartValue(6 * GiB, "bytes")).toBe("6 GiB");
    expect(formatAxisTicks([0, 6 * GiB], "bytes")).toEqual(["0", "6 GiB"]);
    expect(formatChartValue(1.5e6, "count")).toBe("1.5M");
    expect(formatAxisTicks([0, 1.5e6], "count")[1]).toBe("1.5M");
    expect(formatChartValue(1800, "seconds")).toBe("30 min");
    expect(formatAxisTicks([0, 1800, 3600], "seconds")).toEqual(["0", "30 min", "60 min"]);
  });

  test("labels print the step exactly: no rounding away from round ticks", () => {
    expect(formatAxisTicks([99.5, 99.75, 100], "percent")).toEqual(["99.5 %", "99.75 %", "100 %"]);
    expect(formatAxisTicks([0, 0.5 * GiB, GiB, 1.5 * GiB], "bytes")).toEqual(["0", "0.5 GiB", "1 GiB", "1.5 GiB"]);
    expect(formatAxisTicks([0.1 + 0.2, 0.6, 0.9], "scalar")).toEqual(["0.3", "0.6", "0.9"]);
  });

  test("edge cases: zero has no unit, -0, negatives, NaN/Infinity, empty", () => {
    expect(formatAxisTicks([0], "count")).toEqual(["0"]);
    expect(formatAxisTicks([0], "bytes")).toEqual(["0"]);
    expect(formatAxisTicks([0, 0.0001, 0.0002], "seconds")).toEqual(["0", "100 µs", "200 µs"]);
    expect(formatAxisTicks([-0, 1], "count")).toEqual(["0", "1"]);
    expect(formatAxisTicks([-1e-12, 1], "count")).toEqual(["0", "1"]);
    expect(formatAxisTicks([-1, -0.5, 0, 0.5, 1], "count")).toEqual(["-1", "-0.5", "0", "0.5", "1"]);
    expect(formatAxisTicks([-2 * GiB, 0, 2 * GiB], "bytes")).toEqual(["-2 GiB", "0", "2 GiB"]);
    expect(formatAxisTicks([NaN, 0, 1, Infinity, -Infinity], "scalar")).toEqual(["", "0", "1", "", ""]);
    expect(formatAxisTicks([NaN, NaN], "bytes")).toEqual(["", ""]);
    expect(formatAxisTicks([], "count")).toEqual([]);
    expect(formatAxisTicks([2 ** 50], "bytes")).toEqual(["1 PiB"]);
    expect(formatAxisTicks([0, 5e15, 1e16], "count")).toEqual(["0", "5,000T", "10,000T"]);
  });

  test("labels stay distinct: tiny magnitudes and tiny steps on a large offset", () => {
    for (const [ticks, unit] of [
      [[1.0000001, 1.0000002, 1.0000003], "count"],
      [[1.0000001e9, 1.0000002e9, 1.0000003e9], "count"],
      [[0, 2e-10, 4e-10], "count"],
      [[1e-9, 1.1e-9, 1.2e-9], "scalar"],
      [[3, 3.000001, 3.000002], "percent"],
    ] as const) {
      const labels = formatAxisTicks(ticks, unit);
      expect(new Set(labels).size).toBe(ticks.length);
      expect(labels.join(" ")).not.toMatch(/NaN|-0\b/);
    }
    expect(formatAxisTicks([1.0000001, 1.0000002, 1.0000003], "count")).toEqual(["1.0000001", "1.0000002", "1.0000003"]);
    // Scientific labels never glue a magnitude letter after the exponent ("1E-9B").
    const sci = formatAxisTicks([0, 2e-10, 4e-10], "count");
    expect(sci).toEqual(["0", "2E-10", "4E-10"]);
    // On a count axis "B" means billion (Intl's compact letter); byte axes always spell " B"/" KiB" with a space.
    expect(formatAxisTicks([0, 2e9], "count")).toEqual(["0", "2B"]);
    expect(formatAxisTicks([0, 512], "bytes")).toEqual(["0", "512 B"]);
  });

  test("labels for real chart ranges stay short enough for the default axis width", () => {
    for (const [min, max, unit] of [[5.2e9, 6.6e9, "bytes"], [0, 1e7, "count"], [0, 0.5, "seconds"], [0, 6000, "seconds"]] as const) {
      for (const label of axis(min, max, unit)) expect(label.length).toBeLessThanOrEqual(9);
    }
  });
});
