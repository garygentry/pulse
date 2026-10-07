// src/server/routes/metrics.ts — GET /metrics, hand-rolled Prometheus text (REQ-OBS-03, 10 §6).
//
// The retained legacy families (pulse_web_build_info, pulse_web_source_up, pulse_web_snapshot_age_seconds,
// pulse_web_estate_model_loaded, pulse_web_refresh_total, pulse_web_http_requests_total) are joined by
// the runtime-cycle telemetry families required by 10 §6: cycle sequence/duration/publications, per-
// SourceId upstream call/up, SSE stream/event, and history request/cache/active/queued. Counters are
// process-lifetime monotonic Maps held here and mutated by the loop (recordRefresh, recordUpstreamCall,
// recordCyclePublication, recordSseEvent, recordHistoryRequest) and the router (recordHttpRequest); the
// gauges derive at render time from RuntimeStatus plus a bounded per-request runtime view (the current
// cycle observation, live history stats, and open-stream count). No client library — the set is small.
//
// Label discipline (10 §6): source labels are exactly `SourceId`; history query labels are exact
// `QueryId` plus two fixed operation names; outcomes/events are closed constants. No label is ever an
// entity id, raw path/query, peer, identity, error, or payload value.

import type { RouteDefinition, ServerContext } from "../../shared/registry.js";
import { getRuntimeStatus, type RuntimeStatus } from "../refresh.js";
import { WEB_APP_VERSION } from "../../version.js";
import type { CycleObservation, QueryId, SourceId } from "@pulse/web-data/wire";
import type { StreamRegistryEvent } from "@pulse/web-data/wire";
import type { HistoryStats } from "@pulse/web-data/history";
import type { MutationAction } from "../mutations/registry.js";
import type { RefusalReason } from "../mutations/refusal.js";
import type { WritePathSnapshot } from "../mutations/write-path.js";
import { WRITE_PATH_STORES } from "../mutations/write-path.js";

const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
type SourceKey = "metrics" | "alerts" | "checks";
type RefreshOutcome = "success" | "failure";

/** Closed publication outcome vocabulary (10 §6): a coherent publish with all governing sources
 *  current is `success`, one with a failed governing source is `degraded`, a build failure is `failed`. */
export type CyclePublicationOutcome = "success" | "degraded" | "failed";
/** Closed upstream-call outcome vocabulary — one recurring call either parses or fails. */
export type UpstreamCallOutcome = "success" | "failure";
/** Closed history delivery/outcome vocabulary reported per request (07 delivery + `error`). */
export type HistoryRequestOutcome = "hit" | "miss" | "coalesced" | "error";
/** The `query` label vocabulary — the exact 14 `QueryId`s plus two fixed non-curated operation names
 *  (Gatus endpoint history and vmalert alert intervals carry no `QueryId`, 10 §6). */
export type HistoryQueryLabel = QueryId | "alert-intervals" | "endpoint-history";

/** The fixed ten `SourceId`s, iterated for `pulse_web_source_up` and typed against the wire union. */
const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "victoriametrics-buildinfo",
  "alertmanager-alerts",
  "alertmanager-silences",
  "alertmanager-status",
  "alertmanager-receivers",
  "vmalert-rules",
  "gatus-statuses",
  "grafana-health",
];

/** A blank instantaneous history stats value — the render default when no runtime view is supplied. */
const ZERO_HISTORY_STATS: HistoryStats = {
  active: 0,
  queued: 0,
  inFlightKeys: 0,
  cachedKeys: 0,
  cachedBytes: 0,
  waiters: 0,
};

/** The bounded runtime view the `/metrics` handler captures from one request's `ServerContext` (10 §6):
 *  the current cycle observation (source freshness + sequence), live history stats, and open-stream
 *  count. All fields are safe categorical/numeric — never an entity id, peer, identity, or payload. */
export interface MetricsRuntimeView {
  /** The current cycle's observation, or `null` before readiness / in bundle-error mode. */
  readonly cycleObservation: CycleObservation | null;
  /** Instantaneous bounded history-service resource counters (gauges). */
  readonly history: HistoryStats;
  /** Number of currently open SSE streams (gauge). */
  readonly sseStreams: number;
}

const DEFAULT_VIEW: MetricsRuntimeView = {
  cycleObservation: null,
  history: ZERO_HISTORY_STATS,
  sseStreams: 0,
};

// ── Process-lifetime monotonic counters (the ONLY mutable state /metrics needs beyond RuntimeStatus) ──

const refreshTotal = new Map<string, number>(); // key: `${source}|${outcome}` (legacy loop, retained)
const httpRequestsTotal = new Map<string, number>(); // key: `${route}|${status}`
const cyclePublicationsTotal = new Map<CyclePublicationOutcome, number>(); // key: outcome
const upstreamCallsTotal = new Map<string, number>(); // key: `${SourceId}|${outcome}`
const sseEventsTotal = new Map<string, number>(); // key: `${event}|${outcome}`
const historyRequestsTotal = new Map<string, number>(); // key: `${query}|${outcome}`
const historyCacheHitsTotal = new Map<HistoryQueryLabel, number>(); // key: query

// ── Mutation / write-path telemetry state (REQ-OBS-01/02) ───────────────────────────────────────────

/** Closed outcome vocabulary for pulse_web_mutations_total (REQ-OBS-01). */
export type MutationMetricOutcome = "succeeded" | "failed" | "replayed";

const mutationsTotal = new Map<string, number>(); // key: `${action}|${outcome}`
const mutationRefusalsTotal = new Map<string, number>(); // key: `${action}|${reason}`
const auditWriteFailuresTotal = new Map<"attempted" | "finalize", number>();
let ackAutoClearsTotal = 0;
let writePathStatusProvider: (() => WritePathSnapshot) | null = null;

/** +1 pulse_web_mutations_total{action,outcome} — dispatcher step 13 (succeeded/failed) or step-9 replay. */
export function recordMutation(action: MutationAction, outcome: MutationMetricOutcome): void {
  const key = `${action}|${outcome}`;
  mutationsTotal.set(key, (mutationsTotal.get(key) ?? 0) + 1);
}

/** +1 pulse_web_mutation_refusals_total{action,reason}. `action` is a MutationAction ONLY — an unmatched
 *  path never reaches a refusal (router 405), so there is no `unmatched` value. */
export function recordMutationRefusal(action: MutationAction, reason: RefusalReason): void {
  const key = `${action}|${reason}`;
  mutationRefusalsTotal.set(key, (mutationRefusalsTotal.get(key) ?? 0) + 1);
}

/** +1 pulse_web_audit_write_failures_total{phase} — step 10 (attempted) / step 12 (finalize) append failure. */
export function recordAuditWriteFailure(phase: "attempted" | "finalize"): void {
  auditWriteFailuresTotal.set(phase, (auditWriteFailuresTotal.get(phase) ?? 0) + 1);
}

/** += count on pulse_web_ack_auto_clears_total (06 reconcile). Non-positive / non-integer counts are ignored. */
export function recordAckAutoClears(count: number): void {
  if (Number.isInteger(count) && count > 0) ackAutoClearsTotal += count;
}

/** Install (proxy-header, by bootstrap) or clear (null) the gauge source. Null → the gauge family is omitted. */
export function setWritePathStatusProvider(provider: (() => WritePathSnapshot) | null): void {
  writePathStatusProvider = provider;
}

/** The gauge snapshot, or null when no provider is installed or it throws (a scrape never fails). */
function readWritePathStatus(): WritePathSnapshot | null {
  if (writePathStatusProvider === null) return null;
  try {
    return writePathStatusProvider();
  } catch {
    return null;
  }
}

/** Increment `pulse_web_refresh_total{source,outcome}` — called by the legacy refresh loop (§6.2). */
export function recordRefresh(source: SourceKey, outcome: RefreshOutcome): void {
  const key = `${source}|${outcome}`;
  refreshTotal.set(key, (refreshTotal.get(key) ?? 0) + 1);
}

/** Increment `pulse_web_http_requests_total{route,status}` — called by the router (§4.2). */
export function recordHttpRequest(route: string, status: number): void {
  const key = `${route}|${status}`;
  httpRequestsTotal.set(key, (httpRequestsTotal.get(key) ?? 0) + 1);
}

/** Increment `pulse_web_cycle_publications_total{outcome}` — called once per cycle publication (10 §6). */
export function recordCyclePublication(outcome: CyclePublicationOutcome): void {
  cyclePublicationsTotal.set(outcome, (cyclePublicationsTotal.get(outcome) ?? 0) + 1);
}

/** Increment `pulse_web_upstream_calls_total{source,outcome}` — called once per recurring source call
 *  so the fixed cycle cardinality is provable independent of estate size/viewers (10 §6). */
export function recordUpstreamCall(source: SourceId, outcome: UpstreamCallOutcome): void {
  const key = `${source}|${outcome}`;
  upstreamCallsTotal.set(key, (upstreamCallsTotal.get(key) ?? 0) + 1);
}

/** Increment `pulse_web_sse_events_total{event,outcome}` — called by the SSE registry's telemetry sink. */
export function recordSseEvent(
  event: StreamRegistryEvent["event"],
  outcome: StreamRegistryEvent["outcome"],
): void {
  const key = `${event}|${outcome}`;
  sseEventsTotal.set(key, (sseEventsTotal.get(key) ?? 0) + 1);
}

/** Increment `pulse_web_history_requests_total{query,outcome}` (and `pulse_web_history_cache_hits_total`
 *  when the delivery was a cache hit) — called once per completed history request (10 §6). */
export function recordHistoryRequest(query: HistoryQueryLabel, outcome: HistoryRequestOutcome): void {
  const key = `${query}|${outcome}`;
  historyRequestsTotal.set(key, (historyRequestsTotal.get(key) ?? 0) + 1);
  if (outcome === "hit") historyCacheHitsTotal.set(query, (historyCacheHitsTotal.get(query) ?? 0) + 1);
}

/** Reset every process-lifetime counter. Test seam only — never called in production. */
export function __resetMetricsForTest(): void {
  refreshTotal.clear();
  httpRequestsTotal.clear();
  cyclePublicationsTotal.clear();
  upstreamCallsTotal.clear();
  sseEventsTotal.clear();
  historyRequestsTotal.clear();
  historyCacheHitsTotal.clear();
  mutationsTotal.clear();
  mutationRefusalsTotal.clear();
  auditWriteFailuresTotal.clear();
  ackAutoClearsTotal = 0;
  writePathStatusProvider = null;
}

/**
 * `GET /metrics` — the app's own Prometheus exposition on the listen port (REQ-OBS-03). The
 * engine-side `web` scrape job is stack-core-owned wiring. Reads the current cycle observation, live
 * history stats, and open-stream count from the captured `ServerContext` (defensively — a bare direct
 * dispatch may pass a partial context), so the cycle/history/SSE gauges reflect this instant (10 §6).
 * @returns `200` `text/plain; version=0.0.4` with the retained legacy plus telemetry family set.
 */
export const metricsRoute: RouteDefinition = {
  method: "GET",
  handler(_req, ctx: ServerContext): Response {
    // Read the live cycle/history/SSE state defensively: a bare direct-dispatch may pass a partial
    // context whose `history`/`events` are stubs without the accessor methods.
    const view: MetricsRuntimeView = {
      cycleObservation: ctx.cycle?.observation ?? null,
      history: typeof ctx.history?.stats === "function" ? ctx.history.stats() : ZERO_HISTORY_STATS,
      sseStreams: typeof ctx.events?.count === "function" ? ctx.events.count() : 0,
    };
    return new Response(renderMetrics(getRuntimeStatus(), Date.now(), view), {
      headers: { "content-type": METRICS_CONTENT_TYPE },
    });
  },
  path: "/metrics",
};

/**
 * Render the exposition text (pure — exported for a golden metrics test; `08`, 10 §6). Label values
 * are escaped per the Prometheus text format (`\`, `"`, newline). Every required family emits its
 * `# TYPE` line unconditionally so the family exists even with no series yet.
 * @param status - The operational runtime status (§6).
 * @param nowMs  - Current epoch ms (test seam for a deterministic `snapshot_age_seconds`).
 * @param view   - The bounded per-request runtime view; defaults to an all-zero view (legacy 2-arg calls).
 */
export function renderMetrics(
  status: RuntimeStatus,
  nowMs: number,
  view: MetricsRuntimeView = DEFAULT_VIEW,
): string {
  const lines: string[] = [];
  const obs = view.cycleObservation;

  lines.push(`# TYPE pulse_web_build_info gauge`);
  lines.push(`pulse_web_build_info{version="${esc(WEB_APP_VERSION)}"} 1`);

  // Retained legacy per-loop source health (metrics/alerts/checks); item 048 removes it once the shell
  // moves fully onto the cycle observation. The corrected cycle-observation source health follows below.
  lines.push(`# TYPE pulse_web_source_up gauge`);
  for (const src of ["metrics", "alerts", "checks"] as SourceKey[]) {
    lines.push(`pulse_web_source_up{source="${src}"} ${status.sources[src].ok ? 1 : 0}`);
  }
  // Cycle-observation source freshness keyed by the exact ten SourceIds: 1 iff the source is `current`
  // in the latest publication, else 0 (a stale/unavailable/not-configured source is never reported up).
  for (const sid of SOURCE_IDS) {
    const up = obs !== null && obs.sources[sid].state === "current" ? 1 : 0;
    lines.push(`pulse_web_source_up{source="${sid}"} ${up}`);
  }

  // Snapshot age now reflects the latest CYCLE OBSERVATION time (10 §6): `lastSnapshotAt` is stamped
  // from the published observation, not the legacy materialization time, so this is observation age.
  lines.push(`# TYPE pulse_web_snapshot_age_seconds gauge`);
  const age =
    status.lastSnapshotAt === null
      ? "NaN"
      : String(Math.max(0, Math.floor((nowMs - status.lastSnapshotAt) / 1000)));
  lines.push(`pulse_web_snapshot_age_seconds ${age}`);

  lines.push(`# TYPE pulse_web_estate_model_loaded gauge`);
  lines.push(`pulse_web_estate_model_loaded ${status.model.loaded ? 1 : 0}`);

  // ── Cycle publication telemetry (10 §6) ──────────────────────────────────────────────────────────
  lines.push(`# TYPE pulse_web_cycle_sequence gauge`);
  lines.push(`pulse_web_cycle_sequence ${obs !== null ? obs.seq : 0}`);

  lines.push(`# TYPE pulse_web_cycle_duration_seconds gauge`);
  const durMs = status.lastCycleDurationMs ?? null;
  lines.push(`pulse_web_cycle_duration_seconds ${durMs === null ? "NaN" : String(durMs / 1000)}`);

  lines.push(`# TYPE pulse_web_cycle_publications_total counter`);
  for (const [outcome, value] of cyclePublicationsTotal) {
    lines.push(`pulse_web_cycle_publications_total{outcome="${outcome}"} ${value}`);
  }

  lines.push(`# TYPE pulse_web_upstream_calls_total counter`);
  for (const [key, value] of upstreamCallsTotal) {
    const [source, outcome] = key.split("|");
    lines.push(`pulse_web_upstream_calls_total{source="${source}",outcome="${outcome}"} ${value}`);
  }

  // ── SSE stream telemetry (10 §6) ─────────────────────────────────────────────────────────────────
  lines.push(`# TYPE pulse_web_sse_streams gauge`);
  lines.push(`pulse_web_sse_streams ${view.sseStreams}`);

  lines.push(`# TYPE pulse_web_sse_events_total counter`);
  for (const [key, value] of sseEventsTotal) {
    const [event, outcome] = key.split("|");
    lines.push(`pulse_web_sse_events_total{event="${event}",outcome="${outcome}"} ${value}`);
  }

  // ── History service telemetry (10 §6) ────────────────────────────────────────────────────────────
  lines.push(`# TYPE pulse_web_history_requests_total counter`);
  for (const [key, value] of historyRequestsTotal) {
    const [query, outcome] = key.split("|");
    lines.push(`pulse_web_history_requests_total{query="${query}",outcome="${outcome}"} ${value}`);
  }

  lines.push(`# TYPE pulse_web_history_cache_hits_total counter`);
  for (const [query, value] of historyCacheHitsTotal) {
    lines.push(`pulse_web_history_cache_hits_total{query="${query}"} ${value}`);
  }

  lines.push(`# TYPE pulse_web_history_active gauge`);
  lines.push(`pulse_web_history_active ${view.history.active}`);

  lines.push(`# TYPE pulse_web_history_queued gauge`);
  lines.push(`pulse_web_history_queued ${view.history.queued}`);

  // ── Retained legacy counters ─────────────────────────────────────────────────────────────────────
  lines.push(`# TYPE pulse_web_refresh_total counter`);
  for (const [key, value] of refreshTotal) {
    const [source, outcome] = key.split("|");
    lines.push(`pulse_web_refresh_total{source="${source}",outcome="${outcome}"} ${value}`);
  }

  lines.push(`# TYPE pulse_web_http_requests_total counter`);
  for (const [key, value] of httpRequestsTotal) {
    const [route, statusCode] = key.split("|");
    lines.push(`pulse_web_http_requests_total{route="${esc(route ?? "")}",status="${statusCode}"} ${value}`);
  }

  // ── Mutation / write-path telemetry ───────────────────────────────────────────────────────────
  lines.push(`# TYPE pulse_web_mutations_total counter`);
  for (const [key, value] of mutationsTotal) {
    const [action, outcome] = key.split("|");
    lines.push(`pulse_web_mutations_total{action="${action}",outcome="${outcome}"} ${value}`);
  }
  lines.push(`# TYPE pulse_web_mutation_refusals_total counter`);
  for (const [key, value] of mutationRefusalsTotal) {
    const [action, reason] = key.split("|");
    lines.push(`pulse_web_mutation_refusals_total{action="${action}",reason="${reason}"} ${value}`);
  }
  lines.push(`# TYPE pulse_web_audit_write_failures_total counter`);
  for (const [phase, value] of auditWriteFailuresTotal) {
    lines.push(`pulse_web_audit_write_failures_total{phase="${phase}"} ${value}`);
  }
  lines.push(`# TYPE pulse_web_ack_auto_clears_total counter`);
  lines.push(`pulse_web_ack_auto_clears_total ${ackAutoClearsTotal}`);
  const wp = readWritePathStatus();
  if (wp !== null) {
    // Absent entirely in none mode (no provider installed) or when the provider throws.
    lines.push(`# TYPE pulse_web_write_path_status gauge`);
    for (const store of WRITE_PATH_STORES) {
      lines.push(`pulse_web_write_path_status{store="${store}",reason="${wp[store].reason ?? "ok"}"} 1`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Escape a Prometheus label value (`\`, `"`, newline). */
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
