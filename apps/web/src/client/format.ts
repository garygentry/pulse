// src/client/format.ts — estate-timezone absolute-time formatting (REQ-LIVE-02).
//
// Every absolute time in the UI is rendered in the estate timezone carried by the snapshot
// (`OverviewSnapshot.estate.timezone`/`.tzFallback`), NOT the browser locale (charter invariant 10).
// The server validates `PULSE_ESTATE_TZ` at startup and substitutes `"UTC"` + `tzFallback: true` on
// failure; the client only formats. When `tzFallback`, callers MUST surface `TZ_FALLBACK_MARKER` so an
// operator never mistakes UTC for local (§3.1 rule 4).

import type { OverviewSnapshot } from "../shared/snapshot.js";

/** The explicit "showing UTC" marker surfaced whenever `EstateClock.tzFallback` (REQ-LIVE-02). The
 *  staleness indicator (§3.1) renders it alongside the absolute time so UTC is never silent. */
export const TZ_FALLBACK_MARKER = "TZ not configured — showing UTC" as const;

/** A bound clock for one estate timezone. Constructed per snapshot from `snapshot.estate`. */
export interface EstateClock {
  /** The IANA zone in use (e.g. `"America/Chicago"`, or `"UTC"` when `tzFallback`). */
  readonly timezone: string;
  /** True when `PULSE_ESTATE_TZ` was unset/invalid and UTC is the fallback (REQ-LIVE-02). Callers that
   *  show absolute time MUST surface `TZ_FALLBACK_MARKER` (§3.1). */
  readonly tzFallback: boolean;
  /** Format an ISO-8601 UTC instant as an absolute estate-TZ time, e.g. `"2026-08-22 14:03:22 CDT"`.
   *  An unparseable input yields the literal `"—"` (defensive; snapshot times are always valid). */
  format(isoUtc: string): string;
  /** A short relative duration for display ALONGSIDE an absolute time, e.g. `"3m ago"`, `"12s ago"`.
   *  Never used as the sole representation of a time (REQ-LIVE-02).
   *  @param nowMs - reference epoch ms; defaults to `Date.now()`. */
  relative(isoUtc: string, nowMs?: number): string;
  /** Convenience combiner: `"<absolute> (<relative>)"` — the staleness indicator's primary string. */
  absoluteWithRelative(isoUtc: string, nowMs?: number): string;
}

const DTF_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
  hour12: false,
};

/** Assemble a stable `"YYYY-MM-DD HH:MM:SS TZ"` string from `Intl` parts — locale-independent so the
 *  test asserts the same shape regardless of the runner's default locale. */
function formatParts(fmt: Intl.DateTimeFormat, isoUtc: string): string {
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = fmt.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const time = `${get("hour")}:${get("minute")}:${get("second")}`;
  const zone = get("timeZoneName");
  return `${day} ${time} ${zone}`.trim();
}

/** Coarse relative buckets; future instants (clock skew) render `"just now"`. */
function formatRelative(isoUtc: string, nowMs: number): string {
  const then = new Date(isoUtc).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = nowMs - then;
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Build an `EstateClock` from a snapshot's estate block.
 *  @param estate - `snapshot.estate` (`{ name; timezone; tzFallback }`). */
export function createEstateClock(estate: OverviewSnapshot["estate"]): EstateClock {
  let timezone = estate.timezone;
  let tzFallback = estate.tzFallback;
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat(undefined, { ...DTF_OPTIONS, timeZone: timezone });
  } catch {
    // Belt-and-braces: the server already validated + substituted UTC, so this is unreachable in
    // practice, but an invalid zone must never crash the client — fall back to UTC + mark it.
    timezone = "UTC";
    tzFallback = true;
    fmt = new Intl.DateTimeFormat(undefined, { ...DTF_OPTIONS, timeZone: "UTC" });
  }

  return {
    timezone,
    tzFallback,
    format: (isoUtc: string) => formatParts(fmt, isoUtc),
    relative: (isoUtc: string, nowMs: number = Date.now()) => formatRelative(isoUtc, nowMs),
    absoluteWithRelative: (isoUtc: string, nowMs: number = Date.now()) =>
      `${formatParts(fmt, isoUtc)} (${formatRelative(isoUtc, nowMs)})`,
  };
}
