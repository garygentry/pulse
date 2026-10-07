// packages/web-data/src/cycle/fold-engine.ts — the pure engine fold
// (04-cycle-and-current-view-folds.md §10). Always emits the six fixed engine components in
// display order — VictoriaMetrics, vmalert, Alertmanager, Gatus, Grafana, web — each with
// explicit health, version, uptime, and governing availability. It also emits VM scrape
// jobs/target health, vmalert rule-group evaluation timing, Alertmanager notification
// failure/latency projections, VM capacity projections, publication-cycle health, and
// deadman/canary state.
//
// Current engine projections come only from the fixed VictoriaMetrics instant acquisition
// (`victoriametrics-signals`) — no HistoryService call is ever made. Version comes from slow
// metadata (buildinfo/status/grafana health); uptime comes only from the current instant
// process-start projection, and metadata success never substitutes for a missing uptime
// metric. Missing, non-finite, insufficient-window, or unsupported projections are
// unavailable (`null`), never zero, and a last-good metric under current source failure is
// stale and cannot green its component. `generatedAt` is body materialization time. The fold
// is pure: it reads only its inputs and makes no source or history call.

import type { DataAvailability, HealthState } from "../wire/common.js";
import type { RuleState } from "../wire/alerts.js";
import type {
  CycleHealth,
  DeadmanState,
  EngineCapacityState,
  EngineComponent,
  EngineNotificationState,
  EnginePayload,
  RuleGroupState,
  ScrapeJobState,
} from "../wire/engine.js";
import type { MetricSample } from "../sources/vm.js";
import type { ScrapeTargetState } from "../sources/types.js";
import type { VmalertRuleGroup } from "../sources/vmalert.js";
import type { SourceRecord } from "../sources/types.js";
import type { FoldInputs } from "./records.js";
import { DEFAULT_ENGINE_CONFIG, effectiveData, sourceAvailability } from "./records.js";

/** Fixed engine projection aliases forced by the VM instant union (matches `sources/vm.ts`). */
const PROJECTION = {
  ingestionRowsPerSecond: "pulse_web_engine_ingestion_rows_per_second",
  hourlyActiveSeries: "pulse_web_engine_hourly_active_series",
  dataBytes: "pulse_web_engine_data_bytes",
  freeDiskBytes: "pulse_web_engine_free_disk_bytes",
  notificationFailuresPerSecond: "pulse_web_engine_notification_failures_per_second",
  notificationLatencyP95Seconds: "pulse_web_engine_notification_latency_p95_seconds",
  processStartSeconds: "pulse_web_engine_process_start_seconds",
} as const;

/** The configured source ids whose current failure marks the publication cycle degraded. */
const CORE_SOURCE_IDS = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "alertmanager-alerts",
  "alertmanager-silences",
  "vmalert-rules",
  "gatus-statuses",
] as const;

/** Deterministic code-point string comparison used by every stable order below. */
function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Map a governing availability to a component health without ever greening stale/unavailable
 * evidence: `current` → `healthy`, `stale` → `unknown`, `unavailable` → `unhealthy`,
 * `not-configured` → `not-configured`.
 */
function healthFromAvailability(availability: DataAvailability): HealthState {
  switch (availability.state) {
    case "current":
      return "healthy";
    case "stale":
      return "unknown";
    case "not-configured":
      return "not-configured";
    default:
      return "unhealthy";
  }
}

/** First current finite sample value for a bare (label-free) projection, or null when unavailable. */
function scalarProjection(series: readonly MetricSample[], projection: string): number | null {
  for (const sample of series) {
    if (sample.projection === projection && sample.value !== null && Number.isFinite(sample.value)) {
      return sample.value;
    }
  }
  return null;
}

/**
 * Build a per-integration record from a labelled projection, keyed by `integration`. Returns
 * null when no current finite sample exists (never an empty/zeroed record).
 */
function integrationProjection(
  series: readonly MetricSample[],
  projection: string,
): Readonly<Record<string, number>> | null {
  const out: Record<string, number> = {};
  let found = false;
  for (const sample of series) {
    if (sample.projection !== projection) continue;
    if (sample.value === null || !Number.isFinite(sample.value)) continue;
    const integration = sample.metric["integration"];
    if (integration === undefined || integration === "") continue;
    out[integration] = sample.value;
    found = true;
  }
  return found ? out : null;
}

/** Current uptime seconds for a job from its process-start projection sample, or null. */
function uptimeSeconds(series: readonly MetricSample[], job: string, nowMs: number): number | null {
  for (const sample of series) {
    if (sample.projection !== PROJECTION.processStartSeconds) continue;
    if (sample.metric["job"] !== job) continue;
    if (sample.value === null || !Number.isFinite(sample.value)) continue;
    const uptime = nowMs / 1000 - sample.value;
    return Number.isFinite(uptime) && uptime >= 0 ? Math.round(uptime) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** Build one engine component with governing availability, version, and current uptime. */
function buildComponent(
  id: EngineComponent["id"],
  availability: DataAvailability,
  version: string | null,
  uptime: number | null,
): EngineComponent {
  return { id, state: healthFromAvailability(availability), version, uptimeSeconds: uptime, availability };
}

/** The reported version from a slow metadata record's effective value via `pick`, or null. */
function metadataVersion<T>(record: SourceRecord<T> | null, pick: (value: T) => string): string | null {
  if (record === null) return null;
  const effective = effectiveData(record);
  return effective === null ? null : pick(effective.data);
}

/** Build the six fixed engine components in display order. */
function buildComponents(
  inputs: FoldInputs,
  liveSeries: readonly MetricSample[],
  nowMs: number,
): EngineComponent[] {
  const { records } = inputs;
  const vmAvail = sourceAvailability(records["victoriametrics-signals"], "victoriametrics-signals");
  const vmalertAvail = sourceAvailability(records["vmalert-rules"], "vmalert-rules");
  const amAvail = sourceAvailability(records["alertmanager-alerts"], "alertmanager-alerts");
  const gatusAvail = sourceAvailability(records["gatus-statuses"], "gatus-statuses");

  const grafanaRecord = records["grafana-health"];
  const grafanaAvail: DataAvailability =
    grafanaRecord === null
      ? { state: "not-configured", source: "grafana-health", lastGoodAt: null, message: null }
      : sourceAvailability(grafanaRecord, "grafana-health");

  const webAvail: DataAvailability = {
    state: "current",
    source: "rendered-estate",
    lastGoodAt: inputs.observedAt,
    message: null,
  };

  return [
    buildComponent(
      "victoriametrics",
      vmAvail,
      metadataVersion(records["victoriametrics-buildinfo"], (v) => v.version),
      uptimeSeconds(liveSeries, "victoriametrics", nowMs),
    ),
    buildComponent("vmalert", vmalertAvail, null, uptimeSeconds(liveSeries, "vmalert", nowMs)),
    buildComponent(
      "alertmanager",
      amAvail,
      metadataVersion(records["alertmanager-status"], (v) => v.version),
      uptimeSeconds(liveSeries, "alertmanager", nowMs),
    ),
    buildComponent("gatus", gatusAvail, null, uptimeSeconds(liveSeries, "gatus", nowMs)),
    buildComponent(
      "grafana",
      grafanaAvail,
      metadataVersion(grafanaRecord, (v) => v.version),
      null,
    ),
    buildComponent("web", webAvail, inputs.appVersion, null),
  ];
}

// ---------------------------------------------------------------------------
// Scrape jobs
// ---------------------------------------------------------------------------

/** Aggregate scrape-target health: any `down` → unhealthy; else any `unknown` → unknown; else healthy. */
function aggregateScrapeHealth(targets: readonly ScrapeTargetState[]): HealthState {
  let anyUnknown = false;
  for (const t of targets) {
    if (t.health === "down") return "unhealthy";
    if (t.health === "unknown") anyUnknown = true;
  }
  return anyUnknown ? "unknown" : "healthy";
}

/** Build VM scrape jobs grouped by job; a non-current discovery can never be healthy. */
function buildScrapeJobs(record: SourceRecord<readonly ScrapeTargetState[]>): ScrapeJobState[] {
  const effective = effectiveData(record);
  const targets = effective?.data ?? [];
  const discoveryCurrent = record.latest.result.ok;

  const byJob = new Map<string, ScrapeTargetState[]>();
  for (const target of targets) {
    (byJob.get(target.job) ?? byJob.set(target.job, []).get(target.job)!).push(target);
  }

  const jobs: ScrapeJobState[] = [];
  for (const [job, jobTargets] of byJob) {
    const sorted = [...jobTargets].sort((a, b) => compareString(a.instance, b.instance));
    // Never green a job when discovery is not current, even if last-good targets are all up.
    const state = discoveryCurrent ? aggregateScrapeHealth(sorted) : "unknown";
    jobs.push({ job, targets: sorted, state });
  }
  return jobs.sort((a, b) => compareString(a.job, b.job));
}

// ---------------------------------------------------------------------------
// Rule groups and deadman
// ---------------------------------------------------------------------------

/** Map one vmalert rule to its wire {@link RuleState}, preserving group/family attribution. */
function toRuleState(group: VmalertRuleGroup, rule: VmalertRuleGroup["rules"][number]): RuleState {
  return {
    group: group.group,
    family: group.family,
    name: rule.name,
    state: rule.state,
    health: rule.health,
    lastEvaluationAt: rule.lastEvaluationAt,
    lastError: rule.lastError,
    deadman: rule.deadman,
  };
}

/** Group evaluation health: not-current → unknown; any unhealthy rule → unhealthy; any unknown → unknown; else healthy. */
function ruleGroupHealth(rules: readonly RuleState[], vmalertCurrent: boolean): HealthState {
  if (!vmalertCurrent) return "unknown";
  let anyUnknown = false;
  for (const rule of rules) {
    if (rule.health === "unhealthy") return "unhealthy";
    if (rule.health === "unknown") anyUnknown = true;
  }
  return anyUnknown ? "unknown" : "healthy";
}

/** Build vmalert rule groups in deterministic order with per-group evaluation health. */
function buildRuleGroups(
  record: SourceRecord<readonly VmalertRuleGroup[]>,
): RuleGroupState[] {
  const groups = effectiveData(record)?.data ?? [];
  const vmalertCurrent = record.latest.result.ok;

  const out = groups.map((group): RuleGroupState => {
    const rules = group.rules
      .map((rule) => toRuleState(group, rule))
      .sort((a, b) => compareString(a.name, b.name));
    return {
      group: group.group,
      health: ruleGroupHealth(rules, vmalertCurrent),
      lastEvaluationAt: group.lastEvaluationAt,
      rules,
    };
  });
  return out.sort((a, b) => compareString(a.group, b.group));
}

/** Build the deadman/canary state from configured rule identity and current firing evidence. */
function buildDeadman(record: SourceRecord<readonly VmalertRuleGroup[]>): DeadmanState {
  const availability = sourceAvailability(record, "vmalert-rules");
  const groups = effectiveData(record)?.data ?? [];
  const vmalertCurrent = record.latest.result.ok;

  let deadmanRule: VmalertRuleGroup["rules"][number] | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (rule.deadman) {
        deadmanRule = rule;
        break;
      }
    }
    if (deadmanRule !== null) break;
  }

  if (deadmanRule === null) {
    return { configured: false, state: "not-configured", lastEvaluationAt: null, availability };
  }

  // Configured from identity (effective) but health governed by current firing evidence: a
  // deadman that is not currently firing (or whose evidence is stale) can never be healthy.
  const state: HealthState = !vmalertCurrent
    ? "unknown"
    : deadmanRule.state === "firing" && deadmanRule.health === "healthy"
      ? "healthy"
      : "unhealthy";
  return { configured: true, state, lastEvaluationAt: deadmanRule.lastEvaluationAt, availability };
}

// ---------------------------------------------------------------------------
// Notification / capacity projections and cycle health
// ---------------------------------------------------------------------------

/** Build the notification failure/latency projection from the current VM instant series. */
function buildNotifications(
  inputs: FoldInputs,
  liveSeries: readonly MetricSample[],
): EngineNotificationState {
  return {
    failuresPerSecond: integrationProjection(liveSeries, PROJECTION.notificationFailuresPerSecond),
    latencyP95Seconds: integrationProjection(liveSeries, PROJECTION.notificationLatencyP95Seconds),
    // The notification projections are VM-scraped metrics, so VM instant is the governing source.
    availability: sourceAvailability(inputs.records["victoriametrics-signals"], "victoriametrics-signals"),
  };
}

/** Build the VM capacity projection from the current VM instant series. */
function buildCapacity(inputs: FoldInputs, liveSeries: readonly MetricSample[]): EngineCapacityState {
  return {
    ingestionRowsPerSecond: scalarProjection(liveSeries, PROJECTION.ingestionRowsPerSecond),
    hourlyActiveSeries: scalarProjection(liveSeries, PROJECTION.hourlyActiveSeries),
    dataBytes: scalarProjection(liveSeries, PROJECTION.dataBytes),
    freeDiskBytes: scalarProjection(liveSeries, PROJECTION.freeDiskBytes),
    availability: sourceAvailability(inputs.records["victoriametrics-signals"], "victoriametrics-signals"),
  };
}

/** Whether any configured governing source's latest attempt failed. */
function anyConfiguredSourceFailed(inputs: FoldInputs): boolean {
  return CORE_SOURCE_IDS.some((id) => !inputs.records[id].latest.result.ok);
}

/** Build the current publication-cycle health from the (optional) engine config plus records. */
function buildCycleHealth(inputs: FoldInputs): CycleHealth {
  const config = inputs.engine ?? DEFAULT_ENGINE_CONFIG;
  return {
    sequence: config.sequence,
    durationMs: config.durationMs,
    degraded: anyConfiguredSourceFailed(inputs),
    buildFailure: config.buildFailure,
  };
}

// ---------------------------------------------------------------------------
// The engine fold
// ---------------------------------------------------------------------------

/**
 * Fold the captured source records into the engine view payload (§10). Always emits the six
 * fixed components in display order plus scrape/rule/notification/capacity/cycle/deadman
 * sections with exact availability semantics. Current projections come only from the fixed VM
 * instant acquisition (no history call), uptime only from the current process-start metric,
 * and missing/stale/non-finite evidence never greens a component nor becomes zero. Pure and
 * total over valid inputs; deterministic ordering.
 *
 * @param inputs - The captured model/artifacts, source records, and stamping metadata.
 * @returns The materialized {@link EnginePayload}.
 */
export function foldEngine(inputs: FoldInputs): EnginePayload {
  const { records } = inputs;
  const metricsOk = records["victoriametrics-signals"].latest.result.ok;
  // Current instant series only — a stale last-good must not green a component or projection.
  const liveSeries = metricsOk ? records["victoriametrics-signals"].latest.result.data : [];
  const nowMs = Date.parse(inputs.observedAt);

  return {
    generatedAt: inputs.observedAt,
    components: buildComponents(inputs, liveSeries, nowMs),
    scrapeJobs: buildScrapeJobs(records["victoriametrics-targets"]),
    ruleGroups: buildRuleGroups(records["vmalert-rules"]),
    notifications: buildNotifications(inputs, liveSeries),
    capacity: buildCapacity(inputs, liveSeries),
    cycle: buildCycleHealth(inputs),
    deadman: buildDeadman(records["vmalert-rules"]),
  };
}
