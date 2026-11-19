// packages/web-data/src/contract/limits.ts — the single source of truth for every collection maximum and byte
// ceiling in the client API contract, plus the two trim helpers the server folds share. Browser-safe leaf module:
// its only import is ../wire/common.js, so the `/wire` graph can read it by value without growing a cycle.

import {
  CURRENT_MAX_GZIP_BYTES, CURRENT_MAX_PLAIN_BYTES,
  HISTORY_MAX_BODY_BYTES, HISTORY_MAX_LABEL_KEY_BYTES, HISTORY_MAX_LABEL_VALUE_BYTES,
  HISTORY_MAX_LABELS, HISTORY_MAX_POINTS, HISTORY_MAX_SERIES,
} from "../wire/common.js";

/**
 * Every collection maximum and byte ceiling in the contract. This is the only place a cap value is defined, or
 * re-exported for history and body. The overview validator, the folds and the CONTRACT.md `limits` table all
 * read from it.
 */
export const CONTRACT_LIMITS = Object.freeze({
  /** Overview: the server trims; the web validator still rejects over-cap bodies as a same-build guard. */
  overview: Object.freeze({
    /** HostStatus entries. */ hosts: 100,
    /** Services summed across all hosts. */ servicesTotal: 300,
    /** Top-level alert strip, and each host's/service's activeAlerts. */ alerts: 1024,
    /** LiveSignal entries. */ signals: 4096,
    /** Top-level recentChecks (fair-share trim). */ recentChecks: 2048,
    /** Per-target checks arrays. */ targetChecks: 2048,
    /** Addresses per host. */ hostAddresses: 64,
    /** Engine summary problems. */ engineProblems: 16,
    /** UTF-8 byte cap for bounded string fields not listed under messageBytes. */ textBytes: 512,
    /** UTF-8 byte cap for summary/rationale/url/ingressUrl/string signal scalars/nullable string fields. */ messageBytes: 1024,
  } as const),
  /** Alerts: the server trims, keeping sort order. */
  alerts: Object.freeze({
    /** ActiveAlert entries. */ alerts: 1024,
    /** RuleState entries. */ rules: 2048,
    /** ActiveSilence entries. */ silences: 1024,
  } as const),
  /** Estate: the server trims. The nested `estate` model is bounded by `body` only. */
  estate: Object.freeze({
    /** EstateTargetState entries. */ liveTargets: 2048,
    /** findings.value.findings entries. */ findings: 1024,
    /** declaredVersusScraped.value entries. */ declaredVersusScraped: 4096,
  } as const),
  /** Timeline: the server trims. */
  timeline: Object.freeze({
    /** TimelineTarget entries. */ targets: 2048,
    /** TimelineDomain entries. */ domains: 512,
    /** checkHistory.endpoints (equals GATUS_MAX_ENDPOINTS). */ checkEndpoints: 511,
  } as const),
  /** History: existing caps; an over-cap result is REJECTED with HISTORY_LIMIT_EXCEEDED (502), never trimmed. */
  history: Object.freeze({
    /** Series per point query. */ series: HISTORY_MAX_SERIES,
    /** Points per series. */ pointsPerSeries: HISTORY_MAX_POINTS,
    /** Labels per series. */ labels: HISTORY_MAX_LABELS,
    /** Label key bytes. */ labelKeyBytes: HISTORY_MAX_LABEL_KEY_BYTES,
    /** Label value bytes (also lane label values). */ labelValueBytes: HISTORY_MAX_LABEL_VALUE_BYTES,
    /** Lanes per alert-interval result. */ lanes: HISTORY_MAX_SERIES,
    /** Intervals per lane. */ intervalsPerLane: HISTORY_MAX_POINTS,
    /** Endpoint results. */ endpointResults: HISTORY_MAX_POINTS,
    /** Endpoint incidents. */ incidents: HISTORY_MAX_POINTS,
    /** Whole-body plain bytes for history. */ bodyBytes: HISTORY_MAX_BODY_BYTES,
  } as const),
  /** Current views (overview, alerts, estate, timeline): canonical plain and gzip ceilings. */
  body: Object.freeze({
    /** Plain bytes. */ plainBytes: CURRENT_MAX_PLAIN_BYTES,
    /** Gzip bytes. */ gzipBytes: CURRENT_MAX_GZIP_BYTES,
  } as const),
} as const);

/** Type of CONTRACT_LIMITS (literal-typed). */
export type ContractLimits = typeof CONTRACT_LIMITS;
/** Overview limits widened to `number`, for parameters that tests call with small caps. */
export type OverviewLimits = { readonly [K in keyof ContractLimits["overview"]]: number };

/** Shared encoder; TextEncoder is browser-safe and encodes a lone surrogate as U+FFFD (3 bytes). */
const UTF8 = new TextEncoder();

/**
 * Truncate to at most `maxBytes` UTF-8 bytes, cutting at the last complete code point. No marker is appended.
 * Returns `value` unchanged (same reference) when it already fits. A lone surrogate counts as 3 bytes, matching
 * TextEncoder's U+FFFD replacement. Truncation is per code point, not per grapheme cluster.
 *
 * @param value - The string to bound.
 * @param maxBytes - Non-negative integer byte cap.
 * @returns `value` itself when it fits, otherwise its longest prefix of whole code points within the cap.
 * @throws {RangeError} when maxBytes is negative or not an integer
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("truncateUtf8: maxBytes must be a non-negative integer");
  }
  // One UTF-16 unit encodes to at most 3 bytes (a surrogate pair, 2 units, encodes to 4).
  if (value.length * 3 <= maxBytes) return value;
  if (UTF8.encode(value).length <= maxBytes) return value;
  let bytes = 0;
  let end = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    const width = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += ch.length;
  }
  return value.slice(0, end);
}

/**
 * Keep the first `max` items in their existing order. Returns the same array when it already fits; otherwise a
 * new array sharing the element objects. Never mutates `items`.
 *
 * @param items - The list to bound.
 * @param max - Non-negative integer item cap.
 * @returns `items` itself when within the cap, otherwise its first `max` items.
 * @throws {RangeError} when max is negative or not an integer
 */
export function capList<T>(items: readonly T[], max: number): readonly T[] {
  if (!Number.isInteger(max) || max < 0) {
    throw new RangeError("capList: max must be a non-negative integer");
  }
  if (items.length <= max) return items;
  return items.slice(0, max);
}
