// src/server/routes/metrics.ts — GET /metrics, hand-rolled Prometheus text (REQ-OBS-03, 10 §6).
//
// The retained legacy families (pulse_web_build_info, pulse_web_source_up, pulse_web_snapshot_age_seconds,
// pulse_web_estate_model_loaded, pulse_web_refresh_total, pulse_web_http_requests_total,
// pulse_web_client_handshakes_total) are joined by
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
import type { HandshakeLabels } from "@pulse/web-data/contract";
import type { PushState } from "@pulse/web-data/wire";
// Type-only: erased at build time, so routes/ keeps no runtime edge into push/.
import type { NotificationKind } from "../push/plan.js";
import { CONTRACT_VERSION, KNOWN_CLIENTS, formatContractVersion } from "@pulse/web-data/contract";

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
const clientHandshakesTotal = new Map<string, number>(); // key: `${client}|${contractMajor}|${outcome}`

/** Closed client-label set of `pulse_web_client_handshakes_total`. */
const HANDSHAKE_CLIENTS: ReadonlySet<string> = new Set<string>([...KNOWN_CLIENTS, "other", "none"]);
/** Closed outcome-label set of `pulse_web_client_handshakes_total`. */
const HANDSHAKE_OUTCOMES: ReadonlySet<string> = new Set([
  "compatible",
  "server_too_old",
  "client_too_old",
  "not_announced",
]);

/**
 * True when `major` is a label value `handshakeLabels` can produce: "other", "none", or a canonical
 * decimal integer 0..CONTRACT_VERSION.major+1 (no leading zeros).
 */
function isHandshakeMajorLabel(major: string): boolean {
  if (major === "other" || major === "none") return true;
  if (!/^(0|[1-9][0-9]{0,3})$/.test(major)) return false;
  return Number(major) <= CONTRACT_VERSION.major + 1;
}
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

// ── Push gateway telemetry state ────────────────────────────────────────────────────────────────────

/** Closed `outcome` vocabulary of pulse_web_push_webhook_total. */
export type PushWebhookOutcome = "accepted" | "unauthorized" | "malformed" | "too_large" | "unavailable";
/** Closed `outcome` vocabulary of pulse_web_push_notifications_total. */
export type PushNotificationOutcome = "delivered" | "failed" | "dropped" | "filtered" | "token_removed";
/** Closed `event` vocabulary of pulse_web_push_pairing_events_total. */
export type PushPairingEvent =
  | "issued"
  | "redeemed"
  | "refused"
  | "cap_reached"
  | "rate_limited"
  | "cancelled"
  | "revoked"
  | "expired"
  | "removed_dead";

/** What the installed push provider reports at scrape time. */
export interface PushMetricsSnapshot {
  /** Current gateway state, for `pulse_web_push_state`. */
  readonly state: PushState;
  /** Devices in the registry; null when disabled. */
  readonly devices: number | null;
  /** Last successful delivery, epoch milliseconds; `null` before the first one. */
  readonly lastSuccessAtMs: number | null;
}

/** `state` label values of pulse_web_push_state, in render order. */
const PUSH_STATES = ["disabled", "configured", "misconfigured"] as const satisfies readonly PushState[];

/** `outcome` label values of pulse_web_push_webhook_total, in render order. */
export const PUSH_WEBHOOK_OUTCOMES = Object.freeze([
  "accepted",
  "unauthorized",
  "malformed",
  "too_large",
  "unavailable",
] as const satisfies readonly PushWebhookOutcome[]);

/** `kind` label values of pulse_web_push_notifications_total, in render order. */
export const PUSH_NOTIFICATION_KINDS = Object.freeze([
  "firing",
  "resolved",
  "repeat",
  "summary",
  "test",
] as const satisfies readonly NotificationKind[]);

/** `outcome` label values of pulse_web_push_notifications_total, in render order. */
export const PUSH_NOTIFICATION_OUTCOMES = Object.freeze([
  "delivered",
  "failed",
  "dropped",
  "filtered",
  "token_removed",
] as const satisfies readonly PushNotificationOutcome[]);

/** `event` label values of pulse_web_push_pairing_events_total, in render order. */
export const PUSH_PAIRING_EVENTS = Object.freeze([
  "issued",
  "redeemed",
  "refused",
  "cap_reached",
  "rate_limited",
  "cancelled",
  "revoked",
  "expired",
  "removed_dead",
] as const satisfies readonly PushPairingEvent[]);

/** Guard sets: any value outside the closed set is dropped silently (the HANDSHAKE_CLIENTS pattern). */
const PUSH_STATE_SET: ReadonlySet<string> = new Set(PUSH_STATES);
const PUSH_WEBHOOK_OUTCOME_SET: ReadonlySet<string> = new Set(PUSH_WEBHOOK_OUTCOMES);
const PUSH_NOTIFICATION_KIND_SET: ReadonlySet<string> = new Set(PUSH_NOTIFICATION_KINDS);
const PUSH_NOTIFICATION_OUTCOME_SET: ReadonlySet<string> = new Set(PUSH_NOTIFICATION_OUTCOMES);
const PUSH_PAIRING_EVENT_SET: ReadonlySet<string> = new Set(PUSH_PAIRING_EVENTS);

/** Compile-time proof that each array lists every union member (no runtime cost). */
type _AssertAll<U, A extends readonly U[]> = [U] extends [A[number]] ? true : never;
const _pushVocabComplete: [
  _AssertAll<PushState, typeof PUSH_STATES>,
  _AssertAll<PushWebhookOutcome, typeof PUSH_WEBHOOK_OUTCOMES>,
  _AssertAll<NotificationKind, typeof PUSH_NOTIFICATION_KINDS>,
  _AssertAll<PushNotificationOutcome, typeof PUSH_NOTIFICATION_OUTCOMES>,
  _AssertAll<PushPairingEvent, typeof PUSH_PAIRING_EVENTS>,
] = [true, true, true, true, true];
void _pushVocabComplete;

const pushWebhookTotal = new Map<PushWebhookOutcome, number>(); // key: outcome
const pushNotificationsTotal = new Map<string, number>(); // key: `${kind}|${outcome}`
const pushPairingEventsTotal = new Map<PushPairingEvent, number>(); // key: event
let pushAdminRefusalsTotal = 0;
let pushMetricsProvider: (() => PushMetricsSnapshot) | null = null;

/** True for a positive safe integer (the accepted increment for the `n` argument). */
function isPositiveCount(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

/**
 * +1 pulse_web_push_webhook_total{outcome}. Called once per webhook request by the webhook handler,
 * after the outcome is known. A value outside PUSH_WEBHOOK_OUTCOMES is dropped silently (never throws,
 * never logs).
 * @param outcome - The closed webhook outcome.
 */
export function recordPushWebhook(outcome: PushWebhookOutcome): void {
  if (!PUSH_WEBHOOK_OUTCOME_SET.has(outcome)) return;
  pushWebhookTotal.set(outcome, (pushWebhookTotal.get(outcome) ?? 0) + 1);
}

/**
 * += n on pulse_web_push_notifications_total{kind,outcome}.
 * - `kind` is the planned kind. `filtered` is counted per alert under the kind it would have had.
 * - A summary counts once per device as `summary`.
 * - Test sends count as `kind="test"`.
 * A kind or outcome outside the closed sets, or an `n` that is not a positive safe integer, is dropped
 * silently, so the series set can never grow beyond 5 × 5.
 * @param kind - The NotificationKind of the item.
 * @param outcome - The closed delivery outcome.
 * @param n - Increment, default 1 (the planner batches `filtered`).
 */
export function recordPushNotification(kind: NotificationKind, outcome: PushNotificationOutcome, n: number = 1): void {
  if (!PUSH_NOTIFICATION_KIND_SET.has(kind) || !PUSH_NOTIFICATION_OUTCOME_SET.has(outcome)) return;
  if (!isPositiveCount(n)) return;
  const key = `${kind}|${outcome}`;
  pushNotificationsTotal.set(key, (pushNotificationsTotal.get(key) ?? 0) + n);
}

/**
 * +1 pulse_web_push_pairing_events_total{event}. `revoked`, `expired` and `removed_dead` are recorded
 * ONLY by the device store's removal path, their single emitter; the other events by the pairing
 * service. The matching log line is written by the same caller, not here.
 * @param event - The closed pairing/registry event.
 */
export function recordPushPairingEvent(event: PushPairingEvent): void {
  if (!PUSH_PAIRING_EVENT_SET.has(event)) return;
  pushPairingEventsTotal.set(event, (pushPairingEventsTotal.get(event) ?? 0) + 1);
}

/** +1 pulse_web_push_admin_refusals_total, once per 401 from the operator-secret authoriser. */
export function recordPushAdminRefusal(): void {
  pushAdminRefusalsTotal += 1;
}

/**
 * Install the push gauge source (non-disabled runtime), or clear it with null (disabled runtime, and
 * close()). With no provider installed the gateway renders as `disabled`.
 * @param provider - Snapshot thunk, or null.
 */
export function setPushMetricsProvider(provider: (() => PushMetricsSnapshot) | null): void {
  pushMetricsProvider = provider;
}

/** Result of one provider read. `error` = the provider threw or returned an invalid snapshot. */
type PushSnapshotRead =
  | { readonly kind: "none" }
  | { readonly kind: "ok"; readonly snapshot: PushMetricsSnapshot }
  | { readonly kind: "error" };

/** Read the provider defensively: a scrape never fails because of push. */
function readPushSnapshot(): PushSnapshotRead {
  if (pushMetricsProvider === null) return { kind: "none" };
  try {
    const snapshot: unknown = pushMetricsProvider();
    if (snapshot === null || typeof snapshot !== "object") return { kind: "error" };
    const state: unknown = (snapshot as { state?: unknown }).state;
    if (typeof state !== "string" || !PUSH_STATE_SET.has(state)) return { kind: "error" };
    return { kind: "ok", snapshot: snapshot as PushMetricsSnapshot };
  } catch {
    return { kind: "error" };
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

/**
 * Increment `pulse_web_client_handshakes_total{client, contract_major, outcome}`.
 *
 * Accepts only `handshakeLabels()` output. The type enforces this at compile time, and a runtime guard
 * silently drops any value outside the closed sets, so the series count can never exceed
 * 4 × (CONTRACT_VERSION.major + 4) × 4 even if a caller bypasses the type. Never throws and never logs.
 */
export function recordClientHandshake(labels: HandshakeLabels): void {
  const { client, contractMajor, outcome } = labels;
  if (!HANDSHAKE_CLIENTS.has(client) || !HANDSHAKE_OUTCOMES.has(outcome) || !isHandshakeMajorLabel(contractMajor)) {
    return;
  }
  const key = `${client}|${contractMajor}|${outcome}`;
  clientHandshakesTotal.set(key, (clientHandshakesTotal.get(key) ?? 0) + 1);
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
  clientHandshakesTotal.clear();
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
  pushWebhookTotal.clear();
  pushNotificationsTotal.clear();
  pushPairingEventsTotal.clear();
  pushAdminRefusalsTotal = 0;
  pushMetricsProvider = null;
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
  lines.push(
    `pulse_web_build_info{version="${esc(WEB_APP_VERSION)}",contract="${formatContractVersion(CONTRACT_VERSION)}"} 1`,
  );

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

  // Client handshakes by bounded labels; series follow first-observation order.
  lines.push(`# TYPE pulse_web_client_handshakes_total counter`);
  for (const [key, value] of clientHandshakesTotal) {
    const [client, major, outcome] = key.split("|");
    lines.push(
      `pulse_web_client_handshakes_total{client="${esc(client ?? "")}",contract_major="${esc(major ?? "")}",outcome="${esc(outcome ?? "")}"} ${value}`,
    );
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
  renderPushMetrics(lines);
  return lines.join("\n") + "\n";
}

/** HELP text per push family (fixed strings, no runtime value). */
const PUSH_HELP = Object.freeze({
  state: "Push gateway state; 1 on the current state (disabled, configured, misconfigured).",
  devices: "Devices in the push registry.",
  webhook: "Alertmanager push webhook calls by outcome.",
  notifications: "Push notifications by kind and outcome.",
  lastSuccess: "Unix time of the last notification Apple accepted.",
  pairing: "Pairing and device registry events.",
  adminRefusals: "Operator push API calls refused for the operator secret.",
} as const);

/**
 * Append the push families.
 * - pulse_web_push_state is ALWAYS emitted (3 series). No provider → `disabled` = 1. A provider error →
 *   all three 0 (state unknown, so neither the disabled assumption nor the misconfigured rule fires).
 * - Every other family is emitted only for an `ok` snapshot whose state is not `disabled`.
 * - Counter families render the FULL closed label space, zero-initialised, in array order, so rate()
 *   and increase() see a series from 0 and the output is deterministic.
 * - pulse_web_push_last_success_timestamp_seconds is emitted only when lastSuccessAtMs is set.
 * Every label value comes from a closed constant array, so no value is escaped.
 */
function renderPushMetrics(lines: string[]): void {
  const read = readPushSnapshot();
  const current: PushState | null = read.kind === "none" ? "disabled" : read.kind === "ok" ? read.snapshot.state : null;

  lines.push(`# HELP pulse_web_push_state ${PUSH_HELP.state}`);
  lines.push(`# TYPE pulse_web_push_state gauge`);
  for (const s of PUSH_STATES) {
    lines.push(`pulse_web_push_state{state="${s}"} ${s === current ? 1 : 0}`);
  }
  if (read.kind !== "ok" || read.snapshot.state === "disabled") return;
  const snap = read.snapshot;

  const devices = typeof snap.devices === "number" && Number.isSafeInteger(snap.devices) && snap.devices >= 0 ? snap.devices : 0;
  lines.push(`# HELP pulse_web_push_devices ${PUSH_HELP.devices}`);
  lines.push(`# TYPE pulse_web_push_devices gauge`);
  lines.push(`pulse_web_push_devices ${devices}`);

  lines.push(`# HELP pulse_web_push_webhook_total ${PUSH_HELP.webhook}`);
  lines.push(`# TYPE pulse_web_push_webhook_total counter`);
  for (const o of PUSH_WEBHOOK_OUTCOMES) {
    lines.push(`pulse_web_push_webhook_total{outcome="${o}"} ${pushWebhookTotal.get(o) ?? 0}`);
  }

  lines.push(`# HELP pulse_web_push_notifications_total ${PUSH_HELP.notifications}`);
  lines.push(`# TYPE pulse_web_push_notifications_total counter`);
  for (const k of PUSH_NOTIFICATION_KINDS) {
    for (const o of PUSH_NOTIFICATION_OUTCOMES) {
      lines.push(
        `pulse_web_push_notifications_total{kind="${k}",outcome="${o}"} ${pushNotificationsTotal.get(`${k}|${o}`) ?? 0}`,
      );
    }
  }

  const last = snap.lastSuccessAtMs;
  if (typeof last === "number" && Number.isFinite(last) && last > 0) {
    lines.push(`# HELP pulse_web_push_last_success_timestamp_seconds ${PUSH_HELP.lastSuccess}`);
    lines.push(`# TYPE pulse_web_push_last_success_timestamp_seconds gauge`);
    lines.push(`pulse_web_push_last_success_timestamp_seconds ${Math.floor(last / 1000)}`);
  }

  lines.push(`# HELP pulse_web_push_pairing_events_total ${PUSH_HELP.pairing}`);
  lines.push(`# TYPE pulse_web_push_pairing_events_total counter`);
  for (const e of PUSH_PAIRING_EVENTS) {
    lines.push(`pulse_web_push_pairing_events_total{event="${e}"} ${pushPairingEventsTotal.get(e) ?? 0}`);
  }

  lines.push(`# HELP pulse_web_push_admin_refusals_total ${PUSH_HELP.adminRefusals}`);
  lines.push(`# TYPE pulse_web_push_admin_refusals_total counter`);
  lines.push(`pulse_web_push_admin_refusals_total ${pushAdminRefusalsTotal}`);
}

/** Escape a Prometheus label value (`\`, `"`, newline). */
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
