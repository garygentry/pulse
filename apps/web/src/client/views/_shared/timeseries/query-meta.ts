// Client mirror of the curated-catalog fields /engine and /timeline need (05 §2, 00 §5.2/§6.1).
// Type-only wire imports: nothing here imports the server-side query catalog at runtime (REQ-SEC-01).
// The values are drift-tested against QUERY_CATALOG in tests/timeline-view-query-meta-drift.test.ts.

import type { QueryId, RangeId } from "@pulse/web-data/wire";

/** Client mirror of the curated-catalog fields the views need (drift-tested against QUERY_CATALOG). */
export interface ClientQueryMeta {
  /** Default range used by /engine trends. */ readonly defaultRange: RangeId;
  /** Largest accepted range; larger selections render "not available at this range". */ readonly maxRange: RangeId;
  /** Display unit for axis/readout formatting. */
  readonly unit: "count" | "bytes" | "seconds" | "percent" | "scalar" | "milliseconds" | "state";
}

/** Only the ids this feature requests (drift-tested against QUERY_CATALOG). */
export const CLIENT_QUERY_META: Readonly<Partial<Record<QueryId, ClientQueryMeta>>> = {
  "engine.ingestion-rate": { defaultRange: "1h", maxRange: "24h", unit: "count" },
  "engine.active-series": { defaultRange: "6h", maxRange: "7d", unit: "count" },
  "engine.disk-usage": { defaultRange: "6h", maxRange: "7d", unit: "bytes" },
  "engine.notification-failures": { defaultRange: "6h", maxRange: "7d", unit: "count" },
  "engine.notification-latency": { defaultRange: "6h", maxRange: "7d", unit: "seconds" },
  "host.cpu.utilization": { defaultRange: "1h", maxRange: "7d", unit: "percent" },
  "host.memory.utilization": { defaultRange: "1h", maxRange: "7d", unit: "percent" },
  "host.disk.utilization": { defaultRange: "6h", maxRange: "7d", unit: "percent" },
  "host.load.1m": { defaultRange: "1h", maxRange: "24h", unit: "scalar" },
  "endpoint.check.latency": { defaultRange: "1h", maxRange: "24h", unit: "milliseconds" },
};

/** Range lengths in seconds (mirror of packages/web-data/src/queries/ranges.ts; drift-tested). */
export const RANGE_SECONDS: Readonly<Record<RangeId, number>> = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 };

/** Timeline ranges in selector order (REQ-RANGE-01). */
export const TIMELINE_RANGES: readonly RangeId[] = ["1h", "6h", "24h", "7d"];

/** Default and kiosk range (REQ-RANGE-01). */
export const DEFAULT_RANGE: RangeId = "24h";

/** The five /engine trend queries in display order (REQ-CAP-02). */
export const ENGINE_TREND_QUERIES = [
  "engine.ingestion-rate", "engine.active-series", "engine.disk-usage",
  "engine.notification-failures", "engine.notification-latency",
] as const satisfies readonly QueryId[];

/** Host capacity chart queries in display order (REQ-CHART-02); intersected with the lane's queryIds. */
export const HOST_CHART_QUERIES = [
  "host.cpu.utilization", "host.memory.utilization", "host.disk.utilization", "host.load.1m",
] as const satisfies readonly QueryId[];

/** Service latency chart query (REQ-CHART-02). */
export const SERVICE_CHART_QUERY = "endpoint.check.latency" satisfies QueryId;

/** Estate-scoped coverage probe query (D3, REQ-LANE-03). */
export const COVERAGE_QUERY = "engine.active-series" satisfies QueryId;

/** Preferred VM step of the `alerts.firing` query that backs /api/history/alerts (mirror; drift-tested). (additive) */
export const ALERT_HISTORY_PREFERRED_STEP_S = 60;

/** Point-budget denominator used by the data tier's effective-step formula (mirror of ranges.ts; drift-tested). (additive) */
export const STEP_POINT_DENOMINATOR = 598;

/**
 * The effective resolution, in seconds, of the timeline's lane and swimlane data for a range.
 * Mirrors the data tier's `effectiveStepSeconds(RANGE_SECONDS[range], 60)` for `alerts.firing`.
 * Used for the URL zoom-width check (05 §4.3) and as the axis's initial `stepSeconds` (06).
 *
 * Values: 1h → 60, 6h → 60, 24h → 145, 7d → 1012.
 *
 * @param range - A timeline range id.
 * @returns The step in whole seconds (always ≥ 60).
 */
export function timelineStepSeconds(range: RangeId): number {
  return Math.max(ALERT_HISTORY_PREFERRED_STEP_S, Math.ceil(RANGE_SECONDS[range] / STEP_POINT_DENOMINATOR));
}

/**
 * True when `range` is longer than the query's accepted `maxRange`. Callers render
 * "Not available at this range (max {maxRange})" and issue NO request when this is true (REQ-RANGE-02).
 *
 * A query id that is absent from CLIENT_QUERY_META returns true. The client cannot prove the range is
 * accepted, so it never sends a request that might be rejected.
 *
 * Complexity O(1). Never throws.
 *
 * @param queryId - A curated query id.
 * @param range - The selected range.
 * @returns Whether the selection is outside the query's accepted ranges.
 */
export function rangeExceedsMax(queryId: QueryId, range: RangeId): boolean {
  const meta = CLIENT_QUERY_META[queryId];
  if (meta === undefined) return true;
  return RANGE_SECONDS[range] > RANGE_SECONDS[meta.maxRange];
}
