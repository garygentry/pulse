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
const FIXED_1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const MAX_2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const INT_0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

function formatSeconds(v: number): string {
  const a = Math.abs(v);
  if (a < 1) return `${INT_0.format(v * 1000)} ms`;
  if (a < 120) return `${FIXED_1.format(v)} s`;
  if (a < 7200) return `${FIXED_1.format(v / 60)} min`;
  return `${FIXED_1.format(v / 3600)} h`;
}

function formatBytes(v: number): string {
  let x = v;
  let u = 0;
  while (Math.abs(x) >= 1024 && u < BYTE_UNITS.length - 1) {
    x /= 1024;
    u++;
  }
  return `${FIXED_1.format(x)} ${BYTE_UNITS[u]}`;
}

/**
 * Format a chart value with its unit for readouts and captions (en-US for deterministic output).
 *   percent      → "42.1 %"          (1 decimal)
 *   bytes        → "1.5 GiB"         (binary units B/KiB/MiB/GiB/TiB, 1 decimal)
 *   seconds      → < 1 → "{ms} ms"; < 120 → "{s:1} s"; < 7200 → "{min:1} min"; else "{h:1} h"
 *   milliseconds → < 1000 → "{ms:0} ms"; else seconds as above
 *   count        → compact notation, 1 decimal ("1.2M", "950")
 *   scalar       → up to 2 decimals
 *   state        → up to 2 decimals
 * Non-finite v → "no value".
 */
export function formatChartValue(v: number, unit: ClientQueryMeta["unit"]): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return NO_VALUE;
  switch (unit) {
    case "percent": return `${FIXED_1.format(v)} %`;
    case "bytes": return formatBytes(v);
    case "seconds": return formatSeconds(v);
    case "milliseconds": return Math.abs(v) < 1000 ? `${INT_0.format(v)} ms` : formatSeconds(v / 1000);
    case "count": return COMPACT.format(v);
    default: return MAX_2.format(v);
  }
}
