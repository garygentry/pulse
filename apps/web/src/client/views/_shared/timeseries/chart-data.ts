// Chart data adapter: HistoryPayload → render-ready uPlot data for one view window (06 §4).
// Pure and DOM-free; never throws. Slices by the VIEW, never by the payload's own span, and never
// bridges gaps (06 "Server window constraint").

import type { HistoryPayload } from "@pulse/web-data/wire";
import type { TimeSeriesSeries } from "@/ui";
import type { ClientQueryMeta } from "./query-meta.js";
import type { FractionMap, TimeWindow } from "./axis.js";
import { isZoneSupported, shiftForEstateZone } from "./tz-shift.js";

// ---------------------------------------------------------------------------
// §4.1 Types
// ---------------------------------------------------------------------------

/** True-time samples of one series for readout lookups, including one neighbour either side of the view. */
export interface SeriesSamples {
  /** Ascending true epoch seconds. */ readonly t: readonly number[];
  /** Values aligned with `t`; null = a gap sample. */ readonly v: readonly (number | null)[];
}

/** Render-ready chart data for one HistoryPayload at one view window (tech-spec §3.7). */
export interface ChartData {
  /** uPlot x values: ascending, estate-zone SHIFTED epoch seconds; first/last are the view-edge sentinels. */
  readonly timestamps: readonly number[];
  /** The same x positions in TRUE epoch seconds (index-aligned with `timestamps`). */
  readonly trueTimestamps: readonly number[];
  /** One entry per payload series, aligned to `timestamps`; null where the series has no sample (never bridged). */
  readonly series: readonly TimeSeriesSeries[];
  /** Per-series readout samples (index-aligned with `series`), true time, with edge neighbours (§4.2 step 1). */
  readonly samples: readonly SeriesSamples[];
  /** True when any series has a non-null value inside the view. */
  readonly hasData: boolean;
  /** `payload.effectiveStepSeconds` (for the resolution caption and the nearest-value distance limit). */
  readonly stepSeconds: number;
  /** True when some timestamp differs from its true time (the zone differs from the browser's). */
  readonly shifted: boolean;
  /** True when the zone was not supported by Intl and UTC (offset 0) was used (§3.4). */
  readonly tzFallback: boolean;
}

// ---------------------------------------------------------------------------
// §4.3 Series labels (REQ-SEC-02)
// ---------------------------------------------------------------------------

/** Label keys tried in order for a series' display label (the query's target label). */
export const TARGET_LABEL_KEYS = ["instance", "host", "service", "key", "integration"] as const;

/**
 * Display label for a series: the first non-empty TARGET_LABEL_KEYS value; else a stable
 * "k1=v1, k2=v2" join of all labels sorted by key (excluding "__name__"); else `fallback`.
 * Returned as plain text; callers render it only as a JSX text child.
 */
export function seriesLabel(labels: Readonly<Record<string, string>>, fallback: string): string {
  if (typeof labels !== "object" || labels === null) return fallback;
  for (const key of TARGET_LABEL_KEYS) {
    const v = labels[key];
    if (typeof v === "string" && v !== "") return v;
  }
  const keys = Object.keys(labels)
    .filter((k) => k !== "__name__" && typeof labels[k] === "string")
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) return fallback;
  return keys.map((k) => `${k}=${labels[k]}`).join(", ");
}

// ---------------------------------------------------------------------------
// §4.2 toChartData
// ---------------------------------------------------------------------------

/** First index with t[i] ≥ x (t ascending). */
function lowerBound(t: readonly number[], x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with t[i] > x (t ascending). */
function upperBound(t: readonly number[], x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (t[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One series in true seconds, ascending, non-finite timestamps dropped, non-finite values → null. */
function seriesPoints(points: unknown): { readonly t: number[]; readonly v: (number | null)[] } {
  const pairs: [number, number | null][] = [];
  if (Array.isArray(points)) {
    for (const p of points as readonly unknown[]) {
      if (!Array.isArray(p)) continue;
      const tMs: unknown = p[0];
      const raw: unknown = p[1];
      if (typeof tMs !== "number" || !Number.isFinite(tMs)) continue;
      pairs.push([tMs / 1000, typeof raw === "number" && Number.isFinite(raw) ? raw : null]);
    }
  }
  let ascending = true;
  for (let i = 1; i < pairs.length; i++) {
    if (pairs[i]![0] < pairs[i - 1]![0]) {
      ascending = false;
      break;
    }
  }
  if (!ascending) pairs.sort((a, b) => a[0] - b[0]);
  return { t: pairs.map((p) => p[0]), v: pairs.map((p) => p[1]) };
}

const EMPTY_NUMBERS: readonly number[] = Object.freeze([]);
const EMPTY_SERIES: readonly TimeSeriesSeries[] = Object.freeze([]);
const EMPTY_SAMPLES: readonly SeriesSamples[] = Object.freeze([]);

function computeChartData(payload: HistoryPayload, view: TimeWindow, zone: string): ChartData {
  const stepSeconds = typeof payload.effectiveStepSeconds === "number" ? payload.effectiveStepSeconds : NaN;
  const tzFallback = !isZoneSupported(zone);
  if (!Number.isFinite(view.start) || !Number.isFinite(view.end) || view.end <= view.start) {
    return Object.freeze({
      timestamps: EMPTY_NUMBERS, trueTimestamps: EMPTY_NUMBERS, series: EMPTY_SERIES, samples: EMPTY_SAMPLES,
      hasData: false, stepSeconds, shifted: false, tzFallback,
    });
  }
  const rawSeries: readonly unknown[] = Array.isArray(payload.series) ? payload.series : [];

  // 1. Per series: ms → s, slice to the view, readout samples with one neighbour either side.
  const sliced = rawSeries.map((s) => {
    const rec = (typeof s === "object" && s !== null ? s : {}) as { labels?: unknown; points?: unknown };
    const { t, v } = seriesPoints(rec.points);
    const lo = lowerBound(t, view.start);
    const hi = upperBound(t, view.end);
    const from = Math.max(lo - 1, 0);
    const to = Math.min(hi + 1, t.length);
    const samples: SeriesSamples = Object.freeze({
      t: Object.freeze(t.slice(from, to)),
      v: Object.freeze(v.slice(from, to)),
    });
    const labels = (typeof rec.labels === "object" && rec.labels !== null ? rec.labels : {}) as Readonly<Record<string, string>>;
    return { t, v, lo, hi: Math.max(lo, hi), samples, labels };
  });

  // 2. Union of in-view timestamps plus the view-edge sentinels.
  const all: number[] = [view.start, view.end];
  for (const s of sliced) for (let i = s.lo; i < s.hi; i++) all.push(s.t[i]!);
  all.sort((a, b) => a - b);
  const union: number[] = [];
  for (const x of all) if (union.length === 0 || union[union.length - 1] !== x) union.push(x);

  // 3–5. Align with null fillers (never bridged); unique labels.
  let hasData = false;
  const seen = new Set<string>();
  const series: TimeSeriesSeries[] = sliced.map((s) => {
    const data = new Array<number | null>(union.length).fill(null);
    let j = 0;
    for (let i = s.lo; i < s.hi; i++) {
      const x = s.t[i]!;
      while (j < union.length && union[j]! < x) j++;
      if (j < union.length && union[j] === x) {
        data[j] = s.v[i]!;
        if (s.v[i] !== null) hasData = true;
      }
    }
    const base = seriesLabel(s.labels, "value");
    let label = base;
    for (let k = 2; seen.has(label); k++) label = `${base} (${k})`;
    seen.add(label);
    return Object.freeze({ label, data: Object.freeze(data) });
  });

  // 7. Shift last.
  const shiftedTs = shiftForEstateZone(union, zone);
  const shifted = shiftedTs.some((s, i) => s !== union[i]);

  // 8. Freeze.
  return Object.freeze({
    timestamps: Object.freeze(shiftedTs),
    trueTimestamps: Object.freeze(union),
    series: Object.freeze(series),
    samples: Object.freeze(sliced.map((s) => s.samples)),
    hasData,
    stepSeconds,
    shifted,
    tzFallback,
  });
}

// ---------------------------------------------------------------------------
// §4.4 Memoisation (REQ-FOLLOW-03, REQ-PERF-05)
// ---------------------------------------------------------------------------

const memo = new WeakMap<HistoryPayload, {
  readonly start: number; readonly end: number; readonly zone: string; readonly data: ChartData;
}>();

/**
 * Convert a history payload to chart data for the visible window (tech-spec §3.7 "Chart data adapter").
 * Pure and memoised (§4.4): identical inputs return the identical ChartData object, and therefore
 * identical array identities, so TimeSeriesChart does not rebuild uPlot.
 *
 * @param payload - A ready (or previous) HistoryPayload; points are [timestampMs, value | null].
 *                  It covers the server's latest window [fetchedAt − range, fetchedAt], which may not
 *                  match `view` (the "Server window constraint").
 * @param view - The axis's visible window (epoch seconds).
 * @param zone - The estate IANA zone (clock.timezone).
 * @returns ChartData. An invalid view (non-finite or end ≤ start) returns empty timestamps/series, which the
 *          wrapper renders as an empty chart.
 */
export function toChartData(payload: HistoryPayload, view: TimeWindow, zone: string): ChartData {
  const cacheable = typeof payload === "object" && payload !== null;
  if (cacheable) {
    const hit = memo.get(payload);
    if (hit !== undefined && hit.start === view.start && hit.end === view.end && hit.zone === zone) return hit.data;
  }
  const data = computeChartData(cacheable ? payload : ({ series: [] } as unknown as HistoryPayload), view, zone);
  if (cacheable) memo.set(payload, { start: view.start, end: view.end, zone, data });
  return data;
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** Structural equality of two ChartData values (arrays compared element-wise; O(n)). */
export function sameChartData(a: ChartData | null, b: ChartData | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (
    a.hasData !== b.hasData || !Object.is(a.stepSeconds, b.stepSeconds) ||
    a.shifted !== b.shifted || a.tzFallback !== b.tzFallback
  ) return false;
  if (!sameArray(a.timestamps, b.timestamps) || !sameArray(a.trueTimestamps, b.trueTimestamps)) return false;
  if (a.series.length !== b.series.length || a.samples.length !== b.samples.length) return false;
  for (let i = 0; i < a.series.length; i++) {
    const x = a.series[i]!;
    const y = b.series[i]!;
    if (x.label !== y.label || x.status !== y.status || !sameArray(x.data, y.data)) return false;
  }
  for (let i = 0; i < a.samples.length; i++) {
    if (!sameArray(a.samples[i]!.t, b.samples[i]!.t) || !sameArray(a.samples[i]!.v, b.samples[i]!.v)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// §4.5 Chart fraction map (DST alignment)
// ---------------------------------------------------------------------------

/**
 * The overlay mapping for a chart whose shift is not constant across the view (§3.3 limits).
 * Returns null when every (timestamps[i] − trueTimestamps[i]) is equal within 1e-6 s. That is the
 * common case, and there the axis's linear mapping is exact.
 * Otherwise returns a piecewise-linear map through the (trueTimestamps[i], timestamps[i]) pairs:
 *   toFraction(t)   = (interp(t) − s0) / (sN − s0)      binary search on trueTimestamps; slope 1 beyond the ends
 *   fromFraction(f) = interp⁻¹(s0 + clamp(f, 0, 1) × (sN − s0))   binary search on timestamps
 */
export function chartFractionMap(data: ChartData): FractionMap | null {
  const tt = data.trueTimestamps;
  const ts = data.timestamps;
  const n = Math.min(tt.length, ts.length);
  if (n < 2) return null;
  const d0 = ts[0]! - tt[0]!;
  let constant = true;
  for (let i = 1; i < n; i++) {
    if (Math.abs(ts[i]! - tt[i]! - d0) > 1e-6) {
      constant = false;
      break;
    }
  }
  if (constant) return null;
  const s0 = ts[0]!;
  const sN = ts[n - 1]!;
  const t0 = tt[0]!;
  const tN = tt[n - 1]!;
  const span = sN - s0;
  if (!(span > 0)) return null;

  const interp = (t: number): number => {
    if (t <= t0) return s0 + (t - t0);
    if (t >= tN) return sN + (t - tN);
    const i = Math.min(Math.max(upperBound(tt, t) - 1, 0), n - 2);
    const a = tt[i]!;
    const b = tt[i + 1]!;
    return b === a ? ts[i]! : ts[i]! + ((t - a) * (ts[i + 1]! - ts[i]!)) / (b - a);
  };
  const inverse = (s: number): number => {
    if (s <= s0) return t0;
    if (s >= sN) return tN;
    const j = Math.min(Math.max(upperBound(ts, s) - 1, 0), n - 2);
    const a = ts[j]!;
    const b = ts[j + 1]!;
    return b === a ? tt[j]! : tt[j]! + ((s - a) * (tt[j + 1]! - tt[j]!)) / (b - a);
  };
  return {
    toFraction: (t: number): number => (interp(t) - s0) / span,
    fromFraction: (f: number): number => {
      const c = Number.isFinite(f) ? Math.min(Math.max(f, 0), 1) : 0;
      return inverse(s0 + c * span);
    },
  };
}

// ---------------------------------------------------------------------------
// §4.6 Nearest value and value formatting (REQ-ZOOM-01)
// ---------------------------------------------------------------------------

/**
 * Nearest sample to `t` within `maxDistance` seconds, by binary search on `samples.t` (O(log n)).
 * Ties resolve to the earlier sample. Returns null when there is no sample within `maxDistance`,
 * or when the nearest sample's value is null (a gap).
 */
export function nearestSample(samples: SeriesSamples, t: number, maxDistance: number): { readonly t: number; readonly v: number } | null {
  if (!Number.isFinite(t) || !(maxDistance >= 0)) return null;
  const ts = samples.t;
  if (ts.length === 0) return null;
  const i = lowerBound(ts, t);
  let best = -1;
  if (i > 0) best = i - 1;
  if (i < ts.length && (best < 0 || ts[i]! - t < t - ts[best]!)) best = i;
  const bt = ts[best]!;
  if (Math.abs(bt - t) > maxDistance) return null;
  const v = samples.v[best];
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return { t: bt, v };
}

const NO_VALUE = "no value";
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

// ---------------------------------------------------------------------------
// Display scales: one unit-selection rule shared by the y axis and the readout
// ---------------------------------------------------------------------------

/** One display scale: values are divided by `div` and printed with `suffix`. */
export interface DisplayScale {
  /** Divisor from the query's base unit to the display unit. */ readonly div: number;
  /** Text after the number, e.g. " GiB", "K", " ms". */ readonly suffix: string;
  /** The display unit's own "round" step multipliers (time units step by 1/2/5/10/15/30). */ readonly kind: "decimal" | "sexagesimal" | "hours";
}

/** Decimal magnitude suffixes for counts and plain values, largest first. These are the letters
 *  Intl's en-US compact notation uses (B = billion); a count axis never shares a chart with bytes,
 *  whose units are always spelled B/KiB/MiB/… with a space. */
const COUNT_SCALES: readonly DisplayScale[] = [
  { div: 1e12, suffix: "T", kind: "decimal" },
  { div: 1e9, suffix: "B", kind: "decimal" },
  { div: 1e6, suffix: "M", kind: "decimal" },
  { div: 1e3, suffix: "K", kind: "decimal" },
];

/** The time unit for a magnitude in seconds: µs below 1 ms, ms below 1 s, s below 120 s, min below
 *  2 h, then h. */
function secondsScale(mag: number): DisplayScale {
  if (mag > 0 && mag < 1e-3) return { div: 1e-6, suffix: " µs", kind: "decimal" };
  if (mag > 0 && mag < 1) return { div: 1e-3, suffix: " ms", kind: "decimal" };
  if (mag < 120) return { div: 1, suffix: " s", kind: "sexagesimal" };
  if (mag < 7200) return { div: 60, suffix: " min", kind: "sexagesimal" };
  return { div: 3600, suffix: " h", kind: "hours" };
}

/**
 * The display scale for a magnitude (a value's absolute size, or an axis's largest tick). The
 * readout ({@link formatChartValue}) and the axis ({@link formatAxisTicks}, {@link axisSplits}) both
 * pick their unit here, so they never disagree on thresholds.
 *   bytes        → B/KiB/MiB/GiB/TiB/PiB (binary, switching at 1024)
 *   seconds      → µs/ms/s/min/h (see secondsScale)
 *   milliseconds → as seconds
 *   percent      → " %"
 *   count/scalar/state → K/M/B/T (B = billion) from 1000
 */
export function displayScale(mag: number, unit: ClientQueryMeta["unit"]): DisplayScale {
  const m = Number.isFinite(mag) ? Math.abs(mag) : 0;
  switch (unit) {
    case "percent":
      return { div: 1, suffix: " %", kind: "decimal" };
    case "bytes": {
      let u = 0;
      while (u < BYTE_UNITS.length - 1 && m >= 1024 ** (u + 1)) u++;
      return { div: 1024 ** u, suffix: ` ${BYTE_UNITS[u]}`, kind: "decimal" };
    }
    case "seconds":
      return secondsScale(m);
    case "milliseconds": {
      const s = secondsScale(m / 1000);
      return { ...s, div: s.div * 1000 };
    }
    default:
      return COUNT_SCALES.find((s) => m >= s.div) ?? { div: 1, suffix: "", kind: "decimal" };
  }
}

/** Readout precision: three significant digits, trailing zeros trimmed. */
const SIG_3 = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 });

/** Print "0" (never "-0") for anything that formats as zero. */
function noNegativeZero(text: string): string {
  return /^-0(\.0*)?(E0)?$/.test(text) ? text.slice(1) : text;
}

/**
 * Format a chart value with its unit for readouts (en-US, deterministic). The unit comes from
 * {@link displayScale}, the same rule the y axis uses, and the number has three significant digits:
 *   percent      → "42.1 %", "0.25 %"
 *   bytes        → "1.5 GiB", "1,010 B" (binary units)
 *   seconds      → "200 µs", "250 ms", "42 s", "10 min", "3 h"
 *   milliseconds → as seconds ("250 ms", "1.5 s")
 *   count/scalar/state → "950", "1.23", "1.23M"
 * Zero is "0" with no unit. Non-finite v → "no value".
 */
export function formatChartValue(v: number, unit: ClientQueryMeta["unit"]): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return NO_VALUE;
  if (v === 0) return "0";
  const scale = displayScale(v, unit);
  return `${noNegativeZero(SIG_3.format(v / scale.div))}${scale.suffix}`;
}

// ---------------------------------------------------------------------------
// Y-axis ticks
// ---------------------------------------------------------------------------

/** Upper bound on the tick budget a caller may ask for (keeps axisSplits' loop small). */
const MAX_AXIS_TICKS = 50;

/** Round step multipliers per decade, by display-unit kind. */
const DECIMAL_STEPS = [1, 2, 2.5, 5] as const;
/** Seconds and minutes step on clock-friendly values; below 1 and from 60 up they go decimal. */
const SEXAGESIMAL_STEPS = [1, 2, 5, 10, 15, 30] as const;
/** Hours step by 1/2/3/6/12/24, then decimal days-in-hours. */
const HOUR_STEPS = [1, 2, 3, 6, 12, 24, 48, 72, 120, 168] as const;

/** Candidate steps in display units, ascending, covering fractions to very large spans. */
function candidateSteps(kind: DisplayScale["kind"], span: number): number[] {
  const out: number[] = [];
  const lo = Math.floor(Math.log10(span > 0 ? span : 1)) - 3;
  const hi = lo + 7;
  for (let e = lo; e <= hi; e++) for (const m of DECIMAL_STEPS) out.push(m * 10 ** e);
  if (kind !== "decimal") {
    // Below 1 unit stay decimal; from 1 unit up use the clock-friendly steps, then decimal beyond.
    const clock = kind === "hours" ? HOUR_STEPS : SEXAGESIMAL_STEPS;
    const top = clock[clock.length - 1]!;
    return [...out.filter((s) => s < 1), ...clock, ...out.filter((s) => s > top * 2)].sort((a, b) => a - b);
  }
  return out;
}

/**
 * Y-axis tick positions that are round in the axis's display unit (so labels never need rounding
 * away from their gridline): GiB ticks step by 0.1/0.2/0.25/0.5/1… GiB, minute ticks by
 * 1/2/5/10/15/30 min, hour ticks by 1/2/3/6/12 h, percent and counts by 1/2/2.5/5 × 10ⁿ.
 * The display unit is {@link displayScale} of the larger end of the range. The step is the
 * smallest candidate giving at most `maxTicks` ticks (capped at 50). Pure and bounded: a span below
 * float resolution at its magnitude (a flat series near 1e17, values past 2^53) returns
 * `[min, max]`; degenerate input returns [] or [min].
 *
 * @param min - Scale minimum (base unit).
 * @param max - Scale maximum (base unit).
 * @param unit - The query's display unit.
 * @param maxTicks - Most ticks that fit (≥ 2).
 * @returns Ascending tick values in the base unit, within [min, max].
 */
export function axisSplits(min: number, max: number, unit: ClientQueryMeta["unit"], maxTicks: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  if (max === min) return [min];
  const scale = displayScale(Math.max(Math.abs(min), Math.abs(max)), unit);
  const lo = min / scale.div;
  const hi = max / scale.div;
  const span = hi - lo;
  const limit = Math.max(2, Math.min(MAX_AXIS_TICKS, Math.floor(maxTicks) || 2));
  // A span below float resolution at this magnitude (a flat series near 1e17, values past 2^53)
  // cannot be stepped: integer multiples of a step stop being distinct. Show the two ends.
  if (!Number.isFinite(span) || span <= Math.max(Math.abs(lo), Math.abs(hi)) * 1e-9) return [min, max];
  const count = (st: number): number => Math.floor(hi / st + 1e-9) - Math.ceil(lo / st - 1e-9) + 1;
  const steps = candidateSteps(scale.kind, span).filter((st) => Number.isFinite(st) && st > 0);
  const step = steps.find((st) => {
    const n = count(st);
    return Number.isFinite(n) && n <= limit;
  });
  if (step === undefined) return [min, max];
  const out: number[] = [];
  const first = Math.ceil(lo / step - 1e-9);
  // Hard cap: never more than `limit` iterations, and stop if k stops changing in float.
  for (let k = first, i = 0; i < limit && k * step <= hi + step * 1e-9; k++, i++) {
    if (k + 1 === k) break;
    // Rebuild from the integer multiple so float drift never reaches the label formatter.
    const tick = Number((k * step).toPrecision(12)) * scale.div;
    if (Number.isFinite(tick)) out.push(tick);
  }
  return out.length > 0 ? out : [min, max];
  return out;
}

/** True when `x` is an integer up to floating-point noise. */
function nearInteger(x: number): boolean {
  return Math.abs(x - Math.round(x)) <= 1e-6 * Math.max(1, Math.abs(x));
}

/** Most fraction digits a plain axis label may use. */
const AXIS_MAX_DECIMALS = 15;

/**
 * Y-axis tick labels for one axis, in the same units as the readout ({@link displayScale}):
 * `6 GiB`, `1.5M`, `30 min`, `250 ms`, `99.5 %`. Every tick shares the scale of the largest tick, and
 * labels print exactly as many decimals as the tick step needs (ticks from {@link axisSplits} are
 * round, so nothing is rounded away from its gridline). Zero prints "0" with no unit; a non-finite
 * tick prints an empty label. Labels are always distinct for distinct ticks: magnitudes below 0.001
 * of a unit use scientific notation with enough digits, never a unit suffix glued to an exponent.
 * Pure; never throws.
 *
 * @param splits - Tick values for the axis.
 * @param unit - The query's display unit.
 * @returns One label per split, index for index.
 */
export function formatAxisTicks(splits: readonly number[], unit: ClientQueryMeta["unit"]): string[] {
  const finite = splits.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (finite.length === 0) return splits.map(() => "");
  const maxAbs = finite.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const scale = displayScale(maxAbs, unit);
  const scaled = [...new Set(finite.map((v) => v / scale.div))].sort((a, b) => a - b);
  let step = Number.POSITIVE_INFINITY;
  for (let i = 1; i < scaled.length; i++) step = Math.min(step, scaled[i]! - scaled[i - 1]!);
  const top = maxAbs / scale.div;
  const distinct = (f: Intl.NumberFormat): boolean =>
    new Set(scaled.map((v) => (v === 0 ? "0" : noNegativeZero(f.format(v))))).size === scaled.length;

  let fmt: Intl.NumberFormat;
  let suffix = scale.suffix;
  if (top > 0 && top < 1e-3) {
    // Scientific, with enough significant digits to separate the closest ticks; no unit letter
    // after an exponent (a count axis would otherwise print "1E-9B").
    let digits = Number.isFinite(step) && step > 0 ? Math.max(0, Math.ceil(Math.log10(top / step))) : 2;
    fmt = new Intl.NumberFormat("en-US", { notation: "scientific", maximumFractionDigits: Math.min(20, digits) });
    while (!distinct(fmt) && digits < 20) fmt = new Intl.NumberFormat("en-US", { notation: "scientific", maximumFractionDigits: ++digits });
    if (unit !== "bytes" && unit !== "percent" && unit !== "seconds" && unit !== "milliseconds") suffix = "";
  } else {
    // A single tick has no step: three significant digits of it.
    let decimals = Number.isFinite(step) ? 0 : Math.max(0, 2 - Math.floor(Math.log10(top || 1)));
    while (Number.isFinite(step) && decimals < AXIS_MAX_DECIMALS && !nearInteger(step * 10 ** decimals)) decimals++;
    fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals });
    while (!distinct(fmt) && decimals < AXIS_MAX_DECIMALS) fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: ++decimals });
  }
  return splits.map((v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return "";
    const text = noNegativeZero(fmt.format(v / scale.div));
    return v === 0 || text === "0" ? "0" : `${text}${suffix}`;
  });
}
