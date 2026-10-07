// packages/web-data/src/wire/engine.ts — authoritative browser-safe engine wire
// contracts (01-core-definitions.md §§6 and 9). Always emits the six fixed engine
// components in display order with explicit health/availability, VM scrape jobs,
// vmalert rule groups, notification/capacity projections, publication-cycle health,
// and deadman/canary state. Every unavailable numeric value is null with explicit
// availability — missing evidence is never coerced to zero — and every status is a
// closed textual union. `generatedAt` is body materialization time. All imports are
// type-only and erased, so `/wire` stays runtime-free and PromQL-free.

import type { DataAvailability, HealthState } from "./common.js";
import type { RuleState } from "./alerts.js";
import type { CycleBuildFailure } from "../cycle/types.js";
import type { ScrapeTargetState } from "../sources/types.js";

/** One engine component with explicit health, version, and uptime evidence. */
export interface EngineComponent {
  /** Closed component id. */ readonly id: "victoriametrics" | "vmalert" | "alertmanager" |
    "gatus" | "grafana" | "web";
  /** Explicit component health. */ readonly state: HealthState;
  /** Validated version, or null when unavailable. */ readonly version: string | null;
  /** Process uptime in seconds, or null when unavailable. */ readonly uptimeSeconds: number | null;
  /** Governing source evidence. */ readonly availability: DataAvailability;
}

/** One VictoriaMetrics scrape job with its discovered targets and aggregate health. */
export interface ScrapeJobState {
  /** Bounded job label. */ readonly job: string;
  /** Targets in stable instance order. */ readonly targets: readonly ScrapeTargetState[];
  /** Aggregate state that cannot be healthy with unavailable discovery. */ readonly state: HealthState;
}

/** One vmalert rule group with evaluation health and its complete rule set. */
export interface RuleGroupState {
  /** vmalert group identity. */ readonly group: string;
  /** Group evaluation health. */ readonly health: HealthState;
  /** Latest group evaluation time in UTC, or null. */ readonly lastEvaluationAt: string | null;
  /** Rules in stable family/name order. */ readonly rules: readonly RuleState[];
}

/** Alertmanager notification failure/latency projection with governing evidence. */
export interface EngineNotificationState {
  /** Recent failures per second per integration, or null when unavailable. */
  readonly failuresPerSecond: Readonly<Record<string, number>> | null;
  /** Recent p95 latency seconds per integration, or null when unavailable. */
  readonly latencyP95Seconds: Readonly<Record<string, number>> | null;
  /** Governing metric-source evidence. */ readonly availability: DataAvailability;
}

/** VictoriaMetrics capacity projection with governing evidence. */
export interface EngineCapacityState {
  /** Recent ingestion rows per second, or null when unavailable. */ readonly ingestionRowsPerSecond: number | null;
  /** Hourly active-series cache population, or null when unavailable. */ readonly hourlyActiveSeries: number | null;
  /** VictoriaMetrics data bytes, or null when unavailable. */ readonly dataBytes: number | null;
  /** Minimum free disk bytes, or null when unavailable. */ readonly freeDiskBytes: number | null;
  /** Governing metric-source evidence. */ readonly availability: DataAvailability;
}

/** Current publication-cycle health independent of source acquisition. */
export interface CycleHealth {
  /** Latest published sequence. */ readonly sequence: number;
  /** Most recent cycle duration in milliseconds. */ readonly durationMs: number;
  /** Whether any configured governing source failed. */ readonly degraded: boolean;
  /** Last non-source materialization failure, or null. */ readonly buildFailure: CycleBuildFailure | null;
}

/** Deadman/canary rule state derived from configured identity, not current firing. */
export interface DeadmanState {
  /** Whether a canary/deadman rule is declared. */ readonly configured: boolean;
  /** Current rule-derived health. */ readonly state: HealthState;
  /** Last rule evaluation time in UTC, or null. */ readonly lastEvaluationAt: string | null;
  /** Governing vmalert evidence. */ readonly availability: DataAvailability;
}

/** The engine view payload: fixed components plus projections, cycle, and deadman state. */
export interface EnginePayload {
  /** Content materialization time in UTC. */ readonly generatedAt: string;
  /** Every component in fixed display order. */ readonly components: readonly EngineComponent[];
  /** VM scrape jobs in deterministic order. */ readonly scrapeJobs: readonly ScrapeJobState[];
  /** vmalert groups in deterministic order. */ readonly ruleGroups: readonly RuleGroupState[];
  /** Notification failure/latency state. */ readonly notifications: EngineNotificationState;
  /** VM capacity state. */ readonly capacity: EngineCapacityState;
  /** Current publication-cycle state. */ readonly cycle: CycleHealth;
  /** Deadman/canary state. */ readonly deadman: DeadmanState;
}
