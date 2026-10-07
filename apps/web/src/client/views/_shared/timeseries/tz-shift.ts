// Estate time zone shift for uPlot x values (06 §3, REQ-RANGE-03, D7).
//
// uPlot formats x ticks in the browser's zone and the frozen viz wrapper exposes no tzDate
// (tech-spec §6.1 gap), so the data handed to uPlot is shifted to read as estate wall-clock time.
// The axis, lanes and readouts keep true times. Uses only Intl and Date; never throws.

// ---------------------------------------------------------------------------
// §3.2 Offset computation and caching
// ---------------------------------------------------------------------------

/** Cached formatter per zone; null = unsupported zone (RangeError or non-finite probe). */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

/** Offset of one hour bucket [b × 3600, (b + 1) × 3600). */
type BucketEntry =
  | { readonly kind: "stable"; readonly offset: number }
  | { readonly kind: "transition"; readonly at: number; readonly before: number; readonly after: number };

/** Per-zone bucket cache; cleared when it exceeds BUCKET_CACHE_MAX entries (bounded memory). */
const buckets = new Map<string, Map<number, BucketEntry>>();
const BUCKET_CACHE_MAX = 10_000; // ≈ 14 months of hours per zone

const HOUR_S = 3600;

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const hit = formatters.get(zone);
  if (hit !== undefined) return hit;
  let fmt: Intl.DateTimeFormat | null;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    if (!Number.isFinite(rawOffset(fmt, 0))) fmt = null;
  } catch {
    fmt = null;                                  // RangeError: invalid time zone
  }
  formatters.set(zone, fmt);
  return fmt;
}

/** Wall-clock parts of instant tSec in the formatter's zone, re-read as UTC, minus tSec. */
function rawOffset(fmt: Intl.DateTimeFormat, tSec: number): number {
  let y = NaN, mo = NaN, d = NaN, h = NaN, mi = NaN, s = NaN;
  for (const p of fmt.formatToParts(new Date(tSec * 1000))) {
    const n = Number(p.value);
    if (p.type === "year") y = n;
    else if (p.type === "month") mo = n;
    else if (p.type === "day") d = n;
    else if (p.type === "hour") h = n % 24;      // defensive: some engines emit "24" at midnight
    else if (p.type === "minute") mi = n;
    else if (p.type === "second") s = n;
  }
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - tSec;
}

/**
 * The bucket entry for hour `b`. Equal offsets at both ends → stable; otherwise a binary search over
 * the integer seconds of (b·3600, (b+1)·3600] finds the first instant carrying the new offset, so
 * non-hour transitions (America/St_Johns) stay exact.
 */
function bucketEntry(fmt: Intl.DateTimeFormat, b: number): BucketEntry {
  const start = b * HOUR_S;
  const o0 = rawOffset(fmt, start);
  const o1 = rawOffset(fmt, start + HOUR_S);
  if (o0 === o1) return { kind: "stable", offset: o0 };
  let lo = start;                 // rawOffset(lo) !== o1
  let hi = start + HOUR_S;        // rawOffset(hi) === o1
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (rawOffset(fmt, mid) === o1) hi = mid;
    else lo = mid;
  }
  return { kind: "transition", at: hi, before: o0, after: o1 };
}

// ---------------------------------------------------------------------------
// §3.1 API
// ---------------------------------------------------------------------------

/**
 * UTC offset of `zone` at instant `tMs`, in seconds (east positive: America/Chicago in CDT → −18000).
 * Uses Intl.DateTimeFormat(...).formatToParts, cached per (zone, hour bucket), exact to the second
 * across DST transitions (§3.2). An unsupported zone returns 0 (UTC); see isZoneSupported.
 * Non-finite tMs → 0.
 */
export function zoneOffsetSeconds(tMs: number, zone: string): number {
  if (!Number.isFinite(tMs)) return 0;
  const fmt = formatterFor(zone);
  if (fmt === null) return 0;
  const tSec = Math.floor(tMs / 1000);
  const b = Math.floor(tSec / HOUR_S);
  let zoneBuckets = buckets.get(zone);
  if (zoneBuckets === undefined) {
    zoneBuckets = new Map();
    buckets.set(zone, zoneBuckets);
  }
  let entry = zoneBuckets.get(b);
  if (entry === undefined) {
    let computed: BucketEntry;
    try {
      computed = bucketEntry(fmt, b);
    } catch {
      return 0;                                  // RangeError: instant outside the Date range
    }
    const probe = computed.kind === "stable" ? computed.offset : computed.before + computed.after;
    if (!Number.isFinite(probe)) return 0;
    if (zoneBuckets.size >= BUCKET_CACHE_MAX) zoneBuckets.clear();
    zoneBuckets.set(b, computed);
    entry = computed;
  }
  if (entry.kind === "stable") return entry.offset;
  return tSec < entry.at ? entry.before : entry.after;
}

/** The browser-local UTC offset at `tMs`, in seconds, as uPlot sees it: −new Date(tMs).getTimezoneOffset() × 60. */
export function localOffsetSeconds(tMs: number): number {
  if (!Number.isFinite(tMs)) return 0;
  const minutes = new Date(tMs).getTimezoneOffset();
  if (!Number.isFinite(minutes) || minutes === 0) return 0;
  return -minutes * 60;
}

/** True when Intl accepts `zone` and yields a finite offset. False ⇒ offset 0 is used and callers show TZ_FALLBACK_MARKER. */
export function isZoneSupported(zone: string): boolean {
  if (typeof zone !== "string") return false;
  return formatterFor(zone) !== null;
}

let cachedBrowserZone: string | null = null;

/** The browser's resolved IANA zone (Intl.DateTimeFormat().resolvedOptions().timeZone), cached; "UTC" if unavailable. */
export function browserZone(): string {
  if (cachedBrowserZone !== null) return cachedBrowserZone;
  let zone = "UTC";
  try {
    const resolved: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof resolved === "string" && resolved !== "") zone = resolved;
  } catch {
    zone = "UTC";
  }
  cachedBrowserZone = zone;
  return zone;
}

// ---------------------------------------------------------------------------
// §3.3 shiftForEstateZone
// ---------------------------------------------------------------------------

/** A downward jump of the shift delta (a "fold"): shifted times would run backwards. */
interface Fold {
  /** First true instant (s) with the new, smaller delta. */ readonly at: number;
  /** Size of the drop (s), > 0. */ readonly delta: number;
  /** Delta before `at` (s). */ readonly before: number;
}

/** D(t): estate offset minus local offset, with the local offset refined once at the shifted instant. */
function shiftDelta(tSec: number, zone: string): number {
  const oE = zoneOffsetSeconds(tSec * 1000, zone);
  const s1 = tSec + oE - localOffsetSeconds(tSec * 1000);
  return oE - localOffsetSeconds(s1 * 1000);
}

/** First instant in (prev, next] whose delta equals `target` (binary search on seconds). */
function findFoldAt(prev: number, next: number, target: number, zone: string): number {
  let lo = prev;
  let hi = next;
  while (hi - lo > 1) {
    const mid = Math.floor(lo + (hi - lo) / 2);
    if (mid <= lo || mid >= hi) break;
    if (shiftDelta(mid, zone) === target) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * Shift epoch-second timestamps so that uPlot's local-zone tick labels read as estate wall-clock time:
 *   s = t + (offset_estate(t) − offset_local(t))           (tech-spec §3.8)
 * with one refinement of the local offset at the shifted instant, a monotonic repair of DST
 * folds (§3.3), and a strict-ascending guarantee. Returns a NEW array of the same length.
 * The input must be ascending (toChartData guarantees it).
 */
export function shiftForEstateZone(timestampsSec: readonly number[], zone: string): number[] {
  const n = timestampsSec.length;
  if (n === 0) return [];
  // 1. Fast path: same zone as the browser → the delta is identically zero.
  if (isZoneSupported(zone) && zone === browserZone()) return timestampsSec.slice();

  // 2. Deltas.
  const d = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = timestampsSec[i]!;
    d[i] = Number.isFinite(t) ? shiftDelta(t, zone) : 0;
  }

  // 3. Fold detection.
  const folds: Fold[] = [];
  for (let i = 1; i < n; i++) {
    const prevT = timestampsSec[i - 1]!;
    const t = timestampsSec[i]!;
    if (!Number.isFinite(prevT) || !Number.isFinite(t)) continue;
    if (d[i]! < d[i - 1]!) {
      folds.push({ at: findFoldAt(prevT, t, d[i]!, zone), delta: d[i - 1]! - d[i]!, before: d[i - 1]! });
    }
  }

  // 4. Map, 5. strict-ascent guard.
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const t = timestampsSec[i]!;
    let s: number;
    if (!Number.isFinite(t)) {
      s = t;
    } else {
      let fold: Fold | null = null;
      for (const f of folds) {
        if (f.at - f.delta <= t && t < f.at + f.delta) {
          fold = f;
          break;
        }
      }
      s = fold === null
        ? t + d[i]!
        : fold.at - fold.delta + fold.before + (t - (fold.at - fold.delta)) / 2;
    }
    if (i > 0 && s <= out[i - 1]!) s = out[i - 1]! + 0.001;
    out[i] = s;
  }
  return out;
}
