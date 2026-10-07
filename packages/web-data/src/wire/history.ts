// packages/web-data/src/wire/history.ts — browser-safe target, curated-query, and
// history-response contracts (01-core-definitions.md §§6–7). Item 006 landed
// `TargetIdentity`; item 007 added the `QueryId` catalog union; item 008 adds the §7
// history payload/series/lane/endpoint contracts below. The service-side request/result
// interfaces (`HistoryRequest`, `HistoryService`, …) live in `history/service.ts`
// (item 025), not here — this file exposes only browser-safe wire shapes. Every type
// import is erased under verbatimModuleSyntax, so `/wire` stays runtime-free. No shape
// here contains PromQL, arbitrary upstream objects, raw identity headers, or audit data.

import type { HashId, RangeId, Unit } from "./common.js";

/**
 * Stable rendered target identity used by alert attribution, estate live joins, and
 * history requests. The closed `kind` selects the drilldown namespace and `id` is the
 * exact rendered drilldown identifier (never a display name).
 */
export type TargetIdentity =
  | {
      /** Closed target class. */ readonly kind: "host";
      /** Exact host drilldown id. */ readonly id: string;
    }
  | {
      /** Closed target class. */ readonly kind: "service";
      /** Exact service drilldown id. */ readonly id: string;
    }
  | {
      /** Closed target class. */ readonly kind: "endpoint";
      /** Exact Gatus endpoint id. */ readonly id: string;
    };

/**
 * Closed curated-query catalog id. Every history/timeline capability is keyed by one of
 * these fixed ids; no client-supplied query string is ever accepted. The full catalog
 * definitions (target kind, unit, ranges, step) live in `queries/catalog.ts` (item 019).
 */
export type QueryId =
  | "estate.liveness" | "alerts.firing" | "host.cpu.utilization"
  | "host.memory.utilization" | "host.disk.utilization" | "host.load.1m"
  | "endpoint.check.latency" | "service.deep-health" | "service.backup-age"
  | "engine.ingestion-rate" | "engine.active-series" | "engine.disk-usage"
  | "engine.notification-failures" | "engine.notification-latency";

// ---------------------------------------------------------------------------
// §7 History payloads (curated numeric series)
// ---------------------------------------------------------------------------

/** One attributed numeric series returned by a curated history query. */
export interface HistorySeries {
  /** Allowlisted bounded attribution labels; no raw upstream label bag. */
  readonly labels: Readonly<Record<string, string>>;
  /**
   * Time-ordered points. Each entry is `[timestampMs, value]`: the timestamp is epoch
   * milliseconds and a `null` value is an explicit gap, never coerced to zero.
   */
  readonly points: readonly (readonly [timestampMs: number, value: number | null])[];
}

/** Result body for a curated VictoriaMetrics history query over a bounded range. */
export interface HistoryPayload {
  /** Executed closed catalog id. */ readonly queryId: QueryId;
  /** Validated target, or null for estate-wide history. */ readonly target: TargetIdentity | null;
  /** Requested closed range. */ readonly range: RangeId;
  /** Upstream completion time in UTC ISO-8601. */ readonly fetchedAt: string;
  /** Effective sampling step in seconds. */ readonly effectiveStepSeconds: number;
  /** Catalog display unit of the returned samples. */ readonly unit: Unit;
  /** True when served from an expired-but-allowed retained cache entry. */ readonly stale: boolean;
  /** Complete bounded series in deterministic label order. */ readonly series: readonly HistorySeries[];
}

// ---------------------------------------------------------------------------
// §7 Alert-interval history (vmalert-derived firing lanes)
// ---------------------------------------------------------------------------

/** One coalesced status interval proven by a single upstream source. */
export interface StatusInterval {
  /** Inclusive UTC interval start. */ readonly start: string;
  /** Exclusive UTC interval end. */ readonly end: string;
  /** Closed interval condition. */ readonly state: "firing" | "failed";
  /** Source that proved this interval. */ readonly provenance: "vmalert" | "gatus";
}

/** One attributed firing-alert lane built from the canonical alert-identity tuple. */
export interface AlertHistoryLane {
  /** Stable hash of the normalized lane attribution tuple. */ readonly id: HashId;
  /** Bounded alert name. */ readonly alertname: string;
  /** Normalized display severity. */ readonly severity: "critical" | "warning" | "info" | "unknown";
  /** Attributed rendered target, or null when attribution failed. */ readonly target: TargetIdentity | null;
  /** Whether renderer attribution succeeded. */ readonly attribution: "matched" | "unmatched";
  /**
   * Fixed minimized canonical attribution-label set; each value is the bounded label or
   * null when absent. No other upstream labels are ever exposed on a lane.
   */
  readonly labels: Readonly<Record<"alertname" | "severity" | "host" | "service" | "instance", string | null>>;
  /** Fixed lane source. */ readonly provenance: "vmalert";
  /** Coalesced ordered firing intervals. */ readonly intervals: readonly StatusInterval[];
}

/** Result body for the alert-interval history operation. */
export interface IntervalHistoryPayload {
  /** Fixed operation discriminator. */ readonly operation: "alert-intervals";
  /** Optional target filter applied by the server, or null. */ readonly target: TargetIdentity | null;
  /** Requested closed range. */ readonly range: RangeId;
  /** Upstream completion time in UTC ISO-8601. */ readonly fetchedAt: string;
  /** Effective sampling step in seconds. */ readonly effectiveStepSeconds: number;
  /** Fixed state unit for interval data. */ readonly unit: "state";
  /** True when returned under the specified stale-cache rule. */ readonly stale: boolean;
  /** Complete bounded lanes in deterministic attribution order. */ readonly lanes: readonly AlertHistoryLane[];
}

// ---------------------------------------------------------------------------
// §7 Endpoint history (Gatus check evaluations)
// ---------------------------------------------------------------------------

/** One Gatus endpoint evaluation result. */
export interface EndpointHistoryResult {
  /** Gatus evaluation time in UTC ISO-8601. */ readonly timestamp: string;
  /** Evaluation outcome. */ readonly success: boolean;
  /** Evaluation duration in milliseconds, or null when absent. */ readonly durationMs: number | null;
}

/** Result body for the exact-endpoint Gatus history operation. */
export interface EndpointHistoryPayload {
  /** Fixed operation discriminator. */ readonly operation: "endpoint-history";
  /** Exact pulse endpoint name (`<host>/<service>` or `dns:<domain>`); never the Gatus composite key. */ readonly endpoint: string;
  /** Renderer target attribution, or null when unavailable. */ readonly target: TargetIdentity | null;
  /** Requested closed range. */ readonly range: RangeId;
  /** Upstream completion time in UTC ISO-8601. */ readonly fetchedAt: string;
  /** Step in seconds, or null for irregular Gatus observations. */ readonly effectiveStepSeconds: number | null;
  /** Fixed duration unit. */ readonly unit: "milliseconds";
  /** True when returned under the specified stale-cache rule. */ readonly stale: boolean;
  /** Fixed history source. */ readonly provenance: "gatus";
  /** Complete bounded results in timestamp order. */ readonly results: readonly EndpointHistoryResult[];
  /** Coalesced failed intervals. */ readonly incidents: readonly StatusInterval[];
}
