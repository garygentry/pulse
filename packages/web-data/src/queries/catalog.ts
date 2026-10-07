// packages/web-data/src/queries/catalog.ts — the frozen M1 curated-query catalog
// (06-curated-query-catalog.md §2). `QUERY_CATALOG` is the single authoritative source
// for every catalog id's target kind, display unit, default/max range, and preferred
// step; timeline metadata (applicable ids/ranges) is derived from this object, never a
// second hand-maintained list. This module holds metadata only — no PromQL — so the
// browser-facing timeline fold can consume it without ever importing a query builder.

import type { RangeId, TargetKind, Unit } from "../wire/common.js";
import type { QueryId } from "../wire/history.js";

/** Frozen metadata for one curated history query id (06 §2). */
export interface CuratedQueryDefinition {
  /** Stable closed catalog id. */ readonly id: QueryId;
  /** Only target class accepted by the binder. */ readonly targetKind: TargetKind;
  /** Display unit of returned samples. */ readonly unit: Unit;
  /** Range selected when the request omits one. */ readonly defaultRange: RangeId;
  /** Largest accepted range. */ readonly maxRange: RangeId;
  /** Preferred VM sampling step in seconds. */ readonly preferredStepSeconds: number;
}

/**
 * The exact 14 M1 curated queries (06 §2). Construction is exhaustive over `QueryId`: a
 * missing or extra key fails typecheck. Every downstream applicable-id/range list is
 * derived from this object so a second source can never drift.
 */
export const QUERY_CATALOG: Readonly<Record<QueryId, CuratedQueryDefinition>> = {
  "estate.liveness": { id: "estate.liveness", targetKind: "estate", unit: "state", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 },
  "alerts.firing": { id: "alerts.firing", targetKind: "estate", unit: "state", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 },
  "host.cpu.utilization": { id: "host.cpu.utilization", targetKind: "host", unit: "percent", defaultRange: "1h", maxRange: "7d", preferredStepSeconds: 30 },
  "host.memory.utilization": { id: "host.memory.utilization", targetKind: "host", unit: "percent", defaultRange: "1h", maxRange: "7d", preferredStepSeconds: 30 },
  "host.disk.utilization": { id: "host.disk.utilization", targetKind: "host", unit: "percent", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 },
  "host.load.1m": { id: "host.load.1m", targetKind: "host", unit: "scalar", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 },
  "endpoint.check.latency": { id: "endpoint.check.latency", targetKind: "endpoint", unit: "milliseconds", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 },
  "service.deep-health": { id: "service.deep-health", targetKind: "service", unit: "scalar", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 },
  "service.backup-age": { id: "service.backup-age", targetKind: "service", unit: "seconds", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 },
  "engine.ingestion-rate": { id: "engine.ingestion-rate", targetKind: "estate", unit: "count", defaultRange: "1h", maxRange: "24h", preferredStepSeconds: 30 },
  "engine.active-series": { id: "engine.active-series", targetKind: "estate", unit: "count", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 },
  "engine.disk-usage": { id: "engine.disk-usage", targetKind: "estate", unit: "bytes", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 },
  "engine.notification-failures": { id: "engine.notification-failures", targetKind: "estate", unit: "count", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 },
  "engine.notification-latency": { id: "engine.notification-latency", targetKind: "estate", unit: "seconds", defaultRange: "6h", maxRange: "7d", preferredStepSeconds: 60 },
};

/** Catalog ids in frozen §2 order, derived from `QUERY_CATALOG` (never a duplicate list). */
export const QUERY_IDS: readonly QueryId[] = Object.keys(QUERY_CATALOG) as QueryId[];

/** Whether `value` is a known catalog id, narrowing to the closed `QueryId` union. */
export function isQueryId(value: string): value is QueryId {
  return Object.prototype.hasOwnProperty.call(QUERY_CATALOG, value);
}

/**
 * The catalog ids applicable to a target of the given kind, in frozen catalog order,
 * derived from `QUERY_CATALOG` (06 §2, §4). Timeline metadata uses this rather than a
 * second hand-maintained mapping.
 */
export function queryIdsForTargetKind(kind: TargetKind): readonly QueryId[] {
  return QUERY_IDS.filter((id) =>
    QUERY_CATALOG[id].targetKind === kind ||
    (id === "estate.liveness" && (kind === "host" || kind === "service")),
  );
}
