// src/server/refresh.ts — the shared runtime + the 10s refresh loop (REQ-LIVE-04/05, REQ-PERF-03).
//
// Owns the mutable process state the router and the loop share: the three source clients + config
// (immutable after boot) and the swappable estate/snapshot/status (the ONLY writable state, replaced
// wholesale each cycle — no per-viewer state, REQ-CONC-01). The loop runs one cycle every
// REFRESH_INTERVAL_MS, building a fresh OverviewSnapshot off to the side and swapping it in with a
// single assignment (an in-flight /api/overview always reads a coherent snapshot, never a torn one).
// Per-source failure isolation: each fetch is independent, a failing source degrades only its facet
// (SourceHealth.ok=false) while the others stay live. The loop NEVER throws across its boundary — a
// source failure or a bad model is DATA, not a process failure.

import type { OverviewSnapshot, SourceHealth } from "../shared/snapshot.js";
import type { EstateBundleError } from "../shared/errors.js";
import type { ServerContext, SourceClients } from "../shared/registry.js"; // ServerContext defined in shared/registry
import { WEB_APP_VERSION } from "../version.js";

// The route-facing v2 source bundle + bounded history service (05 §3) use the runtime-neutral
// @pulse/web-data clients (distinct from the app's legacy refresh-loop clients below). Aliased to
// avoid colliding with `createVmClient`/`createAlertmanagerClient`/`createGatusClient` from
// `./sources`. Item 039 wires these into the scheduler; item 033 only establishes the context seam.
import {
  createVmClient as createDataVmClient,
  createAlertmanagerClient as createDataAlertmanagerClient,
  createVmalertClient as createDataVmalertClient,
  createGatusClient as createDataGatusClient,
  resolveGrafanaClient as resolveDataGrafanaClient,
  type SourceClientOptions,
} from "@pulse/web-data/sources";
import {
  createHistoryService,
  type HistoryService,
  type HistoryResult,
} from "@pulse/web-data/history";
import {
  buildCycleCandidate,
  type CycleState,
  type CycleBuildFailure,
  type CycleSourceRecords,
  type FoldInputs,
} from "@pulse/web-data/cycle";
import type {
  SourceResult as DataSourceResult,
  SourceRecord as DataSourceRecord,
} from "@pulse/web-data/sources";
import {
  SOURCE_ERROR_MESSAGES,
  type AvailabilityState,
  type CycleObservation,
  type SourceId,
  type SourceObservation,
} from "@pulse/web-data/wire";
import type { WebEstateModelV2 } from "@pulse/renderer";
import { randomUUID } from "node:crypto";
import type { Identity, IdentityConfig } from "@pulse/web-data/identity";

import { resolveEstateTimezone, type ServerConfig } from "./config.js";
import { buildSnapshot, type SourceData } from "./snapshot/build.js";
// The rendered-model-v2 three-file bundle watcher is now the runtime authority: it examines model +
// coverage + findings as one generation and installs a fully-validated `EstateBundle` or an explicit
// `EstateBundleError` (06-reload-and-runtime-integration.md §§3-5).
import {
  createWatcher,
  maybeReload,
  type BundleTransition,
  type EstateWatcherState,
} from "./estate/watch.js";
import type { EstateBundle, EstateBundleLoadResult } from "./estate/load.js";
import {
  createVmClient,
  createAlertmanagerClient,
  createGatusClient,
} from "./sources/index.js";
import { createEventStreamRegistry, type EventStreamRegistry } from "./events/registry.js";
import type { VmClient, AlertmanagerClient, GatusClient } from "./sources/index.js";
import type { SourceResult, FetchLike } from "./sources/types.js";
import type { AckStore } from "./mutations/stores/ack-store.js";

/** Optional dependency injection for `createServerRuntime` — lets the dev/mock engine swap the
 *  network boundary (`fetchImpl`) and stamp a supervisor-provided build id (`appVersion`), and
 *  lets tests inject deterministic clocks/timers/UUIDs for the monotonic cycle scheduler (04 §2,
 *  10 §2). Every field defaults to a production value when omitted. */
export interface RuntimeDeps {
  /** Injectable network boundary for the source clients. */ readonly fetchImpl?: FetchLike;
  /** Supervisor-provided build id, read once at construction. */ readonly appVersion?: () => string;
  /** Monotonic clock (ms) driving the chained deadline series; defaults to `performance.now`. */
  readonly monotonicNow?: () => number;
  /** Wall clock for attempt/observation timestamps; defaults to `new Date()`. */
  readonly wallNow?: () => Date;
  /** Process-generation UUID source; defaults to `node:crypto` `randomUUID`. */
  readonly randomUUID?: () => string;
  /** Scheduler timer; defaults to global `setTimeout`. */ readonly setTimer?: typeof setTimeout;
  /** Scheduler timer canceller; defaults to global `clearTimeout`. */
  readonly clearTimer?: typeof clearTimeout;
  /** Pulse-local ack store (proxy-header mode only, built by buildWriteRuntime). When
   *  absent, no reconcile runs and `FoldInputs.acks` is omitted (REQ-ACK-04/06). */
  readonly ackStore?: AckStore;
  /** Slow-cycle hook (write-path re-probe + idempotency sweep), built by
   *  buildWriteRuntime; run fire-and-forget after a slow-due publication. */
  readonly onSlowCycle?: () => Promise<void> | void;
}
import {
  recordRefresh,
  recordUpstreamCall,
  recordCyclePublication,
  recordSseEvent,
  recordHistoryRequest,
  type HistoryQueryLabel,
} from "./routes/metrics.js";
import { log } from "./log.js";

/** The fixed ten `SourceId`s in a stable order, for degradation/edge scans over a cycle's records. */
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

// ── Operational status singleton ─────────────────────────────────────────────────────────────────

/** Operational status the loop maintains and /healthz + /metrics read (§5.2/§5.3). Held as a
 *  process singleton (`getRuntimeStatus`) so it is reportable before the first snapshot exists. */
export interface RuntimeStatus {
  /** Per-source reachability, `lastSuccess` PRESERVED across failing cycles (REQ-LIVE-04). */
  sources: { metrics: SourceHealth; alerts: SourceHealth; checks: SourceHealth };
  /** Bundle load state driving /healthz + the error-page HTTP mapping (§4.4). The property name is
   *  retained for existing health/metrics consumers; only the error type is widened (06 §5.1). */
  model: { loaded: boolean; formatVersion: number | null; error: EstateBundleError | null };
  /** Epoch ms of the latest CYCLE OBSERVATION (`observedAt`) once cycles publish, else the legacy
   *  snapshot's `generatedAt` before the first cycle; `null` before either. Driving the age gauge off
   *  the observation corrects the previously-misleading materialization-age semantics (10 §6). */
  lastSnapshotAt: number | null;
  /** The last non-source cycle-construction failure, or `null` when the latest cycle published or
   *  none has failed (04 §6.1, 10 §2). Optional so pre-existing status literals compile unchanged. */
  lastCycleBuildFailure?: CycleBuildFailure | null;
  /** Duration in ms of the last successful cycle publication, or `null` before the first (10 §6);
   *  optional so pre-existing status literals compile unchanged. Drives `cycle_duration_seconds`. */
  lastCycleDurationMs?: number | null;
}

/** A blank source health — unknown before the first successful fetch. */
function blankHealth(): SourceHealth {
  return { ok: false, lastSuccess: null, error: null };
}

/** A fresh, pre-first-cycle operational status (all sources unknown, model not loaded). */
function initialStatus(): RuntimeStatus {
  return {
    sources: { metrics: blankHealth(), alerts: blankHealth(), checks: blankHealth() },
    model: { loaded: false, formatVersion: null, error: null },
    lastSnapshotAt: null,
    lastCycleBuildFailure: null,
    lastCycleDurationMs: null,
  };
}

/** The process-lifetime operational status. Replaced by `createServerRuntime`; readable before any
 *  runtime exists (returns a blank status) so the operational routes never crash on a bare import. */
let activeStatus: RuntimeStatus = initialStatus();

/** Read the process-lifetime operational status (§5.2/§5.3). */
export function getRuntimeStatus(): RuntimeStatus {
  return activeStatus;
}

/** Install the operational status singleton. Used by `createServerRuntime`; also a test seam so a
 *  handler test can assert /healthz + /metrics against a known status without a live loop. */
export function setRuntimeStatus(status: RuntimeStatus): void {
  activeStatus = status;
}

// ── Shared runtime state ───────────────────────────────────────────────────────────────────────

/** Everything the server holds for the lifetime of the process. The ONLY writable state is the
 *  swappable fields (`watcher`, `estate`, `snapshot`, `status`) — no per-viewer/session state exists
 *  (REQ-CONC-01). `sources`/`config` are immutable after boot. */
export interface RuntimeState {
  readonly config: ServerConfig;
  readonly sources: { vm: VmClient; alertmanager: AlertmanagerClient; gatus: GatusClient };
  /** The three-file bundle watcher (created lazily on the first cycle / prime); `null` before it. */
  watcher: EstateWatcherState | null;
  /** The loaded, validated bundle authority, or `null` in bundle-error mode (REQ-MODEL-03). */
  estate: EstateBundle | null;
  /** The latest built snapshot; `null` before the first successful cycle. */
  snapshot: OverviewSnapshot | null;
  /** The captured immutable current cycle, or `null` before readiness. Optional so existing
   *  runtime-state literals compile unchanged; item 039's scheduler publishes it. */
  cycle?: CycleState | null;
  /** Operational status read by /healthz + /metrics (§5.2/§5.3). */
  status: RuntimeStatus;
  /** Effective app-version string stamped on built snapshots; optional so pre-existing runtime-state
   *  literals compile unchanged. When absent, `runRefreshCycle` falls back to `WEB_APP_VERSION`. */
  appVersion?: string;
}

/** The runtime handle the entry (§2) and router (§4) share. */
export interface ServerRuntime {
  /** Project the current mutable state into a per-request `ServerContext`, capturing the current
   *  cycle once and carrying the per-request resolved `identity` (never runtime-global; 05 §3). */
  getContext(identity: Identity | null): ServerContext;
  /** The validated trusted-proxy identity configuration (immutable after boot). The router reads it
   *  to resolve one per-request identity from the peer/request before `getContext(identity)` (05 §4). */
  readonly identityConfig: IdentityConfig;
  /** The operational status (source health + model status) — read by /healthz + /metrics. */
  getStatus(): RuntimeStatus;
  /** Prime one cycle, then loop forever on the chained monotonic 10s deadline series (04 §2). */
  start(): Promise<void>;
  /** Run exactly one complete cycle (legacy snapshot + atomic cycle publication), serialized
   *  against any running cycle (test seam; the scheduler calls this internally, 04 §2). */
  runOnce(): Promise<void>;
  /** Stop the scheduler timer and prevent further publication; idempotent (04 §2, 10 §2). */
  close(): void;
}

/**
 * Build the shared runtime: construct the three source clients from the config's injected engine
 * URLs (REQ-PKG-02 — the ONLY place URLs enter the process) and the mutable state holder. Installs
 * this runtime's status as the process operational singleton (`getRuntimeStatus`).
 *
 * @param config - The parsed, validated server configuration (§3).
 * @returns The runtime handle used by the entry and the router.
 */
export function createServerRuntime(config: ServerConfig, deps: RuntimeDeps = {}): ServerRuntime {
  const state: RuntimeState = {
    config,
    sources: {
      vm: createVmClient(config.vmUrl, deps.fetchImpl),
      alertmanager: createAlertmanagerClient(config.alertmanagerUrl, deps.fetchImpl),
      gatus: createGatusClient(config.gatusUrl, deps.fetchImpl),
    },
    watcher: null,
    estate: null,
    snapshot: null,
    cycle: null,
    status: initialStatus(),
    ...(deps.appVersion !== undefined ? { appVersion: deps.appVersion() } : {}),
  };
  setRuntimeStatus(state.status); // /healthz + /metrics read this singleton (§5.2/§5.3)

  // The route-facing v2 source bundle + bounded history service (05 §3), constructed once from the
  // configured engine URLs. These serve the cycle/history routes (items 036/038); the legacy refresh
  // loop keeps using `state.sources`. Both share the injected `fetchImpl` (dev/mock boundary).
  const clientOptions: SourceClientOptions =
    deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {};
  const dataSources: SourceClients = {
    vm: createDataVmClient(config.vmUrl, clientOptions),
    alertmanager: createDataAlertmanagerClient(config.alertmanagerUrl, clientOptions),
    vmalert: createDataVmalertClient(config.vmalertUrl, clientOptions),
    gatus: createDataGatusClient(config.gatusUrl, clientOptions),
    grafana: resolveDataGrafanaClient(config.grafanaUrl, clientOptions),
  };
  // Wrap the bounded history service so each completed request records its delivery/outcome into the
  // `pulse_web_history_*` counters and emits a bounded event for the timeout/overload/model-invalidated
  // failure codes (10 §§6–7). The wrapper preserves the exact interface (stats/invalidate/close).
  const history: HistoryService = instrumentHistoryService(
    createHistoryService({
      vm: dataSources.vm,
      gatus: dataSources.gatus,
      model: () => state.estate?.model ?? null,
    }),
  );

  // The process-lifetime SSE stream registry (08 §3). Constructed once; the `/api/events` handler
  // reads it from the captured context, and the scheduler publishes each atomically-assigned cycle
  // into it exactly once. Timers default to global setTimeout/clearTimeout (injectable in tests). Its
  // bounded lifecycle telemetry sink records `pulse_web_sse_events_total` and logs the notable
  // displaced/write-failure edges — never a payload, identity, or peer (10 §§6–7).
  const events: EventStreamRegistry = createEventStreamRegistry({
    ...(deps.setTimer !== undefined ? { setTimer: deps.setTimer } : {}),
    ...(deps.clearTimer !== undefined ? { clearTimer: deps.clearTimer } : {}),
    onEvent: (event) => {
      recordSseEvent(event.event, event.outcome);
      if (event.event === "displaced") {
        safeSideEffect(() => log({ event: "sse_stream_displaced", ok: true, openStreams: event.openStreams }));
      } else if (event.event === "write-failed") {
        safeSideEffect(() => log({ event: "sse_stream_write_failed", ok: false, openStreams: event.openStreams }));
      }
    },
  });

  // The monotonic cycle scheduler (04 §2): generates the process generation, owns the chained
  // deadline series, and publishes `state.cycle` atomically. Clocks/timers/UUID are injectable. After
  // each successful atomic assignment it calls `events.publish(cycle)` exactly once (08 §3).
  const coordinator = createCycleCoordinator(state, dataSources, {
    monotonicNow: deps.monotonicNow ?? (() => performance.now()),
    wallNow: deps.wallNow ?? (() => new Date()),
    randomUUID: deps.randomUUID ?? randomUUID,
    setTimer: deps.setTimer ?? setTimeout,
    clearTimer: deps.clearTimer ?? clearTimeout,
    onCyclePublished: (cycle) => events.publish(cycle),
    ackStore: deps.ackStore ?? null,
    onSlowCycle: deps.onSlowCycle ?? null,
  });

  return {
    getContext(identity: Identity | null): ServerContext {
      const cycle = state.cycle ?? null; // capture the current cycle once into a local (05 §3)
      return Object.freeze({
        estate: state.estate,
        cycle,
        history,
        events,
        sources: dataSources,
        config: state.config,
        identity,
        snapshot: state.snapshot,
      });
    },
    identityConfig: config.identity,
    getStatus: () => state.status,
    runOnce: () => coordinator.runOnce(),
    start: () => coordinator.start(),
    close: () => {
      coordinator.close();
      events.close();
    },
  };
}

// ── The refresh cycle ────────────────────────────────────────────────────────────────────────────

/** One source's cycle outcome: the parsed payload (or `null` on failure) + the updated health. */
interface SourceCycle<T> {
  /** Parsed payload when the fetch succeeded; `null` when it failed (facet degrades to unknown). */
  data: T | null;
  /** Updated health — `lastSuccess` preserved from `prev` on failure (REQ-LIVE-04). */
  health: SourceHealth;
}

/**
 * Fetch one source under isolation. The client method NEVER throws — it returns a discriminated
 * `SourceResult<T>` — so this wrapper branches on `.ok`, folding the result into
 * `SourceHealth` (REQ-LIVE-04): success sets `ok:true` + a fresh `lastSuccess`; failure sets
 * `ok:false`, records `error`, and carries `prev.lastSuccess` forward. Logs only on a
 * reachable↔unreachable transition vs `prev` (§7). An outer try/catch remains as defence against a
 * truly-unexpected throw (the client contract says there is none), mapping it to the same shape.
 */
async function fetchSource<T>(
  key: "metrics" | "alerts" | "checks",
  fetchFn: () => Promise<SourceResult<T>>,
  prev: SourceHealth,
  nowIso: string,
): Promise<SourceCycle<T>> {
  let error: string | null = null;
  try {
    const res = await fetchFn();
    if (res.ok) {
      if (!prev.ok) log({ event: "source_recovered", ok: true, source: key });
      recordRefresh(key, "success");
      return { data: res.data, health: { ok: true, lastSuccess: nowIso, error: null } };
    }
    error = res.error; // discriminated failure — the normal failure path
  } catch (err) {
    error = (err as Error).message; // defensive only: the client contract never rejects
  }
  if (prev.ok) log({ event: "source_unreachable", ok: false, source: key, error });
  recordRefresh(key, "failure");
  return { data: null, health: { ok: false, lastSuccess: prev.lastSuccess, error } };
}

/**
 * Atomically project one authoritative bundle result into runtime state and status, emitting exactly
 * one primary transition log with the structured fields from 06 §6.2 (06 §5.2).
 *
 * On success, `state.estate` becomes the complete bundle and status is loaded with the model's
 * `formatVersion`. On failure, `state.estate` AND `state.snapshot` are cleared so no route can serve
 * a pre-error snapshot as current authority, and status carries the full `EstateBundleError`. A
 * previous bundle is never preserved or merged (REQ-BUNDLE-09, REQ-REL-03, REQ-CONC-02).
 *
 * @param state      - The runtime state to mutate.
 * @param result     - The authoritative bundle result being installed.
 * @param transition - The classified transition; its `kind` selects the success event literal.
 */
function applyBundleResult(
  state: RuntimeState,
  result: EstateBundleLoadResult,
  transition: BundleTransition,
): void {
  if (result.ok) {
    const bundle = result.bundle;
    state.estate = bundle;
    state.status.model = { loaded: true, formatVersion: bundle.model.formatVersion, error: null };
    log({
      event: transition.kind, // bundle_loaded | bundle_reloaded | bundle_recovered
      ok: true,
      artifact: null,
      kind: null,
      path: state.config.estateModelPath,
      field: null,
      foundVersion: null,
      formatVersion: bundle.model.formatVersion,
      bundleId: bundle.model.bundleId,
      hosts: bundle.model.hosts.length,
      services: bundle.model.services.length,
      coveragePresent: bundle.coverage !== null,
      findingsPresent: bundle.findings !== null,
      loadedAt: bundle.loadedAt,
      error: null,
    });
    // One mismatch warning per newly authoritative bundle (initial/reload/recovery), never on a
    // no-op — `applyBundleResult` is only reached for a real byte-distinct authority change (§7.2).
    const decision = resolveEstateTimezone(state.config.estateTz, bundle.model.estate.timezone);
    if (decision.warning !== null) {
      log({
        event: "config_warning",
        ok: false,
        warning: "estate_timezone_override_mismatch",
        configured: decision.warning.configured,
        rendered: decision.warning.rendered,
        bundleId: bundle.model.bundleId,
      });
    }
    return;
  }

  const err = result.error;
  state.estate = null;
  state.snapshot = null; // clear snapshot so error-page mode never serves a stale grid (§5.2)
  state.status.model = { loaded: false, formatVersion: err.foundVersion, error: err };
  log({
    event: "bundle_error",
    ok: false,
    artifact: err.artifact,
    kind: err.kind,
    path: err.path,
    field: err.field,
    foundVersion: err.foundVersion,
    formatVersion: null,
    bundleId: null,
    hosts: null,
    services: null,
    coveragePresent: null,
    findingsPresent: null,
    loadedAt: null,
    error: err.message,
  });
  // A version error may additionally retain the compatibility event, but never replaces the primary
  // `bundle_error` above (06 §6.2).
  if (err.kind === "version") {
    log({
      event: "version_assert_failed",
      ok: false,
      artifact: err.artifact,
      path: err.path,
      foundVersion: err.foundVersion,
    });
  }
}

/**
 * Create the bundle watcher on the first cycle (applying the initial `bundle_loaded`/`bundle_error`
 * classification), then apply only real byte/presence-distinct transitions on each later cycle (06
 * §5.2). A no-op leaves runtime bundle, status, snapshot authority, and logs untouched.
 */
async function syncBundle(state: RuntimeState): Promise<void> {
  if (state.watcher === null) {
    state.watcher = await createWatcher(state.config.estateModelPath);
    applyBundleResult(state, state.watcher.current, initialTransition(state.watcher.current));
    return;
  }
  const outcome = await maybeReload(state.watcher);
  if (outcome.reloaded && outcome.transition !== null) {
    applyBundleResult(state, outcome.result, outcome.transition);
  }
}

/** Classify the watcher's initial authority into a startup transition (06 §4.3). */
function initialTransition(result: EstateBundleLoadResult): BundleTransition {
  if (result.ok) {
    return {
      kind: "bundle_loaded",
      artifact: null,
      errorKind: null,
      bundleId: result.bundle.model.bundleId,
    };
  }
  return {
    kind: "bundle_error",
    artifact: result.error.artifact,
    errorKind: result.error.kind,
    bundleId: null,
  };
}

/**
 * The cycle body (exported for a loop-resilience unit test — force a source rejection and assert the
 * process continues; prober idiom). One cycle: prime/reload the model (05), fetch the three sources
 * under per-source isolation (§6.2), build a fresh snapshot (04), swap it in, update status.
 * NEVER throws — a per-source failure is DATA (SourceHealth.ok=false), not a process failure.
 */
export async function runRefreshCycle(state: RuntimeState): Promise<void> {
  await syncBundle(state);

  const nowIso = new Date().toISOString();
  const [vm, am, gatus] = await Promise.all([
    fetchSource("metrics", () => state.sources.vm.queryLiveness(), state.status.sources.metrics, nowIso),
    fetchSource("alerts", () => state.sources.alertmanager.activeAlerts(), state.status.sources.alerts, nowIso),
    fetchSource("checks", () => state.sources.gatus.endpointStatuses(), state.status.sources.checks, nowIso),
  ]);

  // Per-source isolation: each source's health updates independently (REQ-LIVE-04).
  state.status.sources = { metrics: vm.health, alerts: am.health, checks: gatus.health };

  if (state.estate !== null) {
    // buildSnapshot is pure + total (04): a source whose health.ok=false degrades the affected
    // facets to unknown. A null payload (fetch failed) becomes an empty array beside health.ok=false.
    const sourceData: SourceData = {
      liveness: { series: vm.data ?? [], health: vm.health },
      alerts: { active: am.data ?? [], health: am.health },
      checks: { endpoints: gatus.data ?? [], health: gatus.health },
    };
    // Model timezone is authoritative; a valid explicit override wins, else the rendered zone (06
    // §7). The one-per-bundle mismatch warning is emitted by `applyBundleResult`, not here.
    const tz = resolveEstateTimezone(state.config.estateTz, state.estate.model.estate.timezone);
    const snapshot = buildSnapshot(state.estate.model, sourceData, new Date(), {
      appVersion: state.appVersion ?? WEB_APP_VERSION,
      timezone: tz.timezone, // effective zone: override, else model zone (REQ-LIVE-02)
      tzFallback: tz.fallback, // true only in defensive UTC error mode
      grafanaOrigin: state.config.grafanaUrl, // null → deep links disabled (04 links.ts)
      gatusStaleSeconds: state.config.gatusStaleSeconds,
    });
    state.snapshot = snapshot; // single-assignment swap — atomic from a request's view (REQ-LIVE-05)
    state.status.lastSnapshotAt = Date.parse(snapshot.generatedAt);
  }
}

// ── The monotonic cycle scheduler + atomic publication (04 §§2–6, 10 §§2, 4) ───────────────────────

/** Core cycle cadence in ms — chained monotonic deadlines, never `setInterval` (04 §2). */
const CORE_CADENCE_MS = 10_000;
/** Slow-tier cadence in ms — a cycle runs slow ops when its start is at/after the slow deadline. */
const SLOW_CADENCE_MS = 60_000;

/** The route-facing v2 source bundle the scheduler acquires from (constructed in the runtime). */
interface CycleClients {
  readonly vm: SourceClients["vm"];
  readonly alertmanager: SourceClients["alertmanager"];
  readonly vmalert: SourceClients["vmalert"];
  readonly gatus: SourceClients["gatus"];
  readonly grafana: SourceClients["grafana"];
}

/** The scheduler's injected clocks/timers, defaulted from `RuntimeDeps` (04 §2). */
interface CoordinatorDeps {
  readonly monotonicNow: () => number;
  readonly wallNow: () => Date;
  readonly randomUUID: () => string;
  readonly setTimer: typeof setTimeout;
  readonly clearTimer: typeof clearTimeout;
  /** Post-publication observer invoked with the just-assigned cycle exactly once per successful
   *  atomic publication (08 §3 — the SSE fan-out). Isolated so an observer throw never invalidates
   *  the published cycle (10 §4). */
  readonly onCyclePublished: (cycle: CycleState) => void;
  /** Ack store reconciled against each cycle's alertmanager-alerts record before the fold. */
  readonly ackStore: AckStore | null;
  /** Fire-and-forget hook run after a slow-due publication; never awaited. */
  readonly onSlowCycle: (() => Promise<void> | void) | null;
}

/** The cycle coordinator surface wired into `ServerRuntime` (04 §2). */
interface CycleCoordinator {
  runOnce(): Promise<void>;
  start(): Promise<void>;
  close(): void;
}

/** Wrap a source call so a truly-unexpected throw becomes a safe `transport` failure — the client
 *  contract already returns a discriminated `SourceResult`, so `Promise.all` only sees settled
 *  results and one failure never prevents unrelated records from being current (04 §4). */
async function guardedCall<T>(
  fn: () => Promise<DataSourceResult<T>>,
): Promise<DataSourceResult<T>> {
  try {
    return await fn();
  } catch {
    return { ok: false, error: { kind: "transport", message: SOURCE_ERROR_MESSAGES.transport, status: null } };
  }
}

/** `guardedCall` plus one `pulse_web_upstream_calls_total{source,outcome}` increment, so every recurring
 *  source call is counted by its fixed `SourceId` — proving the fixed cycle cardinality is independent
 *  of estate size and viewer count (10 §6). The `source` label is a categorical id, never an entity. */
async function countedCall<T>(
  source: SourceId,
  fn: () => Promise<DataSourceResult<T>>,
): Promise<DataSourceResult<T>> {
  const result = await guardedCall(fn);
  recordUpstreamCall(source, result.ok ? "success" : "failure");
  return result;
}

/** Fold one attempt into a source record: a success refreshes `lastGood`; a failure retains the
 *  prior `lastGood` as stale context (04 §4). */
function foldRecord<T>(
  prev: DataSourceRecord<T> | null,
  attemptedAt: string,
  result: DataSourceResult<T>,
): DataSourceRecord<T> {
  if (result.ok) {
    return { latest: { attemptedAt, result }, lastGood: { at: attemptedAt, data: result.data } };
  }
  return { latest: { attemptedAt, result }, lastGood: prev?.lastGood ?? null };
}

/** Derive the per-source publication observation from its record (04 §4/§5): `current` on a fresh
 *  success, `stale` when a failed attempt retains last-good, else `unavailable`; a `null` record is
 *  a not-configured optional source with no attempt. */
function sourceObservation(record: DataSourceRecord<unknown> | null): SourceObservation {
  if (record === null) return { state: "not-configured", lastAttemptAt: null, lastSuccess: null };
  const ok = record.latest.result.ok;
  const state: AvailabilityState = ok ? "current" : record.lastGood !== null ? "stale" : "unavailable";
  return { state, lastAttemptAt: record.latest.attemptedAt, lastSuccess: record.lastGood?.at ?? null };
}

/** Clamp `observedAt` so publication order is strictly monotonic even if the wall clock regresses:
 *  at least the previous instant plus 1 ms (04 §6). */
function clampObservedAt(now: Date, prevIso: string | undefined): string {
  const t = now.getTime();
  if (prevIso !== undefined) {
    const prevT = Date.parse(prevIso);
    if (Number.isFinite(prevT) && t <= prevT) return new Date(prevT + 1).toISOString();
  }
  return new Date(t).toISOString();
}

/** The expected Gatus endpoint identities derived from the captured model (04 §3): the union of
 *  every service's declared Gatus endpoint names, deterministically sorted, independent of viewers. */
function expectedGatusIdentities(model: WebEstateModelV2): string[] {
  const set = new Set<string>();
  for (const service of model.services) {
    for (const endpoint of service.gatusEndpoints) set.add(endpoint);
  }
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Build the monotonic, non-overlapping cycle coordinator. It generates one process generation,
 * launches the fixed six core (and, when due, four configured slow) acquisitions concurrently on
 * the v2 clients, folds each into a retained last-good record, composes the candidate off-side
 * through `buildCycleCandidate`, and publishes with exactly one `state.cycle = nextCycle`
 * assignment only on success (04 §§2–6). A construction failure retains the prior authority (or
 * `NOT_READY` before the first success), advances no sequence, records safe status, and retries on
 * the next deadline (04 §6.1).
 */
function createCycleCoordinator(
  state: RuntimeState,
  clients: CycleClients,
  deps: CoordinatorDeps,
): CycleCoordinator {
  let generation = deps.randomUUID();
  /** Records committed by the LAST SUCCESSFUL publication (never a failed candidate, 04 §6.1); the
   *  authority a non-due cycle reuses for its slow records. */
  let lastRecords: CycleSourceRecords | null = null;
  /** The degraded state of the LAST successful publication, or `null` before the first (10 §7). Drives
   *  the edge-triggered `cycle_degraded`/`cycle_healthy` transition logs so a persistently-degraded or
   *  persistently-healthy estate is not re-logged every 10 s. */
  let lastDegraded: boolean | null = null;
  /** The deadline (Dn) the current cycle is anchored to; the series is D0, D0+10s, … regardless of
   *  overruns. `null` before the prime cycle. */
  let currentDeadline: number | null = null;
  /** The slow-tier deadline; advanced by 60s (never in catch-up bursts) as cycles pass it. */
  let slowDeadline = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  /** Serialization chain so `runOnce` and the scheduler tick never run a cycle concurrently. */
  let chain: Promise<void> = Promise.resolve();

  const grafanaConfigured = clients.grafana !== null;

  function serialize(fn: () => Promise<void>): Promise<void> {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  }

  /** Acquire, fold, compose, and (on success) atomically publish one cycle at logical time
   *  `logicalStart`. Never throws across its boundary. */
  async function acquireAndPublish(logicalStart: number): Promise<void> {
    const estate = state.estate;
    if (estate === null) {
      // Bundle error/loss: APIs must not serve prior authority as current (10 §3).
      state.cycle = null;
      lastRecords = null;
      return;
    }
    const model = estate.model;

    // Slow-tier due decision: due when the cycle's start is at/after the slow deadline (or when no
    // prior published records exist to reuse). Advance the deadline by 60s until it is in the future.
    if (slowDeadline === Number.NEGATIVE_INFINITY) slowDeadline = logicalStart;
    const canReuseSlow = lastRecords !== null;
    const slowDue = logicalStart >= slowDeadline || !canReuseSlow;
    if (slowDue) {
      while (slowDeadline <= logicalStart) slowDeadline += SLOW_CADENCE_MS;
    }

    const expected = expectedGatusIdentities(model);
    const overviewMetrics = [...new Set([
      "pulse_backup_freshness_age_seconds",
      ...model.hosts.flatMap((host) => host.collectionClass === "managed-linux"
        ? host.detail.commandSignals.flatMap((signal) => signal.output === "scalar" ? [signal.metric] : [])
        : []),
      ...model.services.flatMap((service) => service.deepHealthDetail?.metrics ?? []),
    ])].sort();
    const attemptAt = deps.wallNow().toISOString();

    // The six fixed core operations, launched concurrently, exactly once each (04 §3).
    const [signals, targets, alerts, silences, rules, checks] = await Promise.all([
      countedCall("victoriametrics-signals", () => clients.vm.statusSignals(overviewMetrics)),
      countedCall("victoriametrics-targets", () => clients.vm.targets()),
      countedCall("alertmanager-alerts", () => clients.alertmanager.alerts()),
      countedCall("alertmanager-silences", () => clients.alertmanager.silences()),
      countedCall("vmalert-rules", () => clients.vmalert.rules()),
      countedCall("gatus-statuses", () => clients.gatus.endpointStatuses(expected)),
    ]);

    const prior = lastRecords;
    const records: CycleSourceRecords = {
      "victoriametrics-signals": foldRecord(prior?.["victoriametrics-signals"] ?? null, attemptAt, signals),
      "victoriametrics-targets": foldRecord(prior?.["victoriametrics-targets"] ?? null, attemptAt, targets),
      "alertmanager-alerts": foldRecord(prior?.["alertmanager-alerts"] ?? null, attemptAt, alerts),
      "alertmanager-silences": foldRecord(prior?.["alertmanager-silences"] ?? null, attemptAt, silences),
      "vmalert-rules": foldRecord(prior?.["vmalert-rules"] ?? null, attemptAt, rules),
      "gatus-statuses": foldRecord(prior?.["gatus-statuses"] ?? null, attemptAt, checks),
      // Slow tier: acquired only when due; otherwise the prior published records are reused exactly
      // and their `lastAttemptAt` does not advance (04 §4).
      ...(await acquireSlowRecords(slowDue, prior, attemptAt)),
    };

    // REQ-ACK-04: clear resolved acks BEFORE the fold, so this cycle publishes the post-clear state.
    // Clears only when this cycle's alertmanager-alerts attempt succeeded (reconcile enforces it).
    // reconcile never rejects; the guard is defence in depth so an ack fault can never stall a cycle.
    if (deps.ackStore !== null) {
      await deps.ackStore.reconcile(records["alertmanager-alerts"]).catch(() => 0);
    }
    const acks = deps.ackStore?.foldView();

    // One process generation; a safe positive sequence that resets under a fresh generation on the
    // (astronomically distant) overflow boundary (04 §6).
    const prevObs = state.cycle?.observation ?? null;
    let seq = (prevObs?.seq ?? 0) + 1;
    if (prevObs !== null && prevObs.seq >= Number.MAX_SAFE_INTEGER) {
      generation = deps.randomUUID();
      seq = 1;
    }
    const observedAt = clampObservedAt(deps.wallNow(), prevObs?.observedAt);
    const appVersion = state.appVersion ?? WEB_APP_VERSION;
    const durationMs = Math.max(0, Math.round(deps.monotonicNow() - logicalStart));

    const observation: CycleObservation = {
      generation,
      seq,
      observedAt,
      appVersion,
      sources: buildSourceObservations(records),
    };

    const inputs: FoldInputs = {
      model,
      coverage: estate.coverage,
      findings: estate.findings,
      records,
      appVersion,
      observedAt,
      overview: {
        grafanaOrigin: state.config.grafanaUrl,
        gatusStaleSeconds: state.config.gatusStaleSeconds,
      },
      engine: {
        sequence: seq,
        durationMs,
        buildFailure: state.status.lastCycleBuildFailure ?? null,
      },
      // Omitted (not undefined) without a store — exactOptionalPropertyTypes.
      ...(acks !== undefined ? { acks } : {}),
    };

    const result = await buildCycleCandidate(state.cycle ?? null, observation, inputs);

    if (!result.ok) {
      // Retain prior authority (or NOT_READY), advance nothing, record safe status + one event (04 §6.1).
      state.status.lastCycleBuildFailure = result.error;
      recordCyclePublication("failed");
      safeSideEffect(() =>
        log({ event: "cycle_build_failed", ok: false, kind: result.error.kind, view: result.error.view }),
      );
      return;
    }

    // The single synchronous atomic publication — a request captures one coherent `CycleState`.
    const recovered = (state.status.lastCycleBuildFailure ?? null) !== null;
    state.cycle = result.cycle;
    lastRecords = records;
    state.status.lastCycleBuildFailure = null;

    // §4 (1): update runtime status — sequence/observation-age/duration. `lastSnapshotAt` now tracks
    // the published observation time so the age gauge means cycle observation age, not materialization.
    state.status.lastSnapshotAt = Date.parse(observedAt);
    state.status.lastCycleDurationMs = durationMs;

    // §4 (2): update source counters/transition state. A publication is `degraded` when any governing
    // configured source failed this cycle, while the publication itself remains a success (10 §7).
    const degradedCount = countDegradedSources(records);
    const degraded = degradedCount > 0;
    recordCyclePublication(degraded ? "degraded" : "success");
    emitSourceEdges(prior, records);
    emitDegradeEdge(degraded, degradedCount, seq, generation);

    // §4 (3): publish exactly one SSE tick per successful assignment, isolated so an observer throw can
    // never invalidate the already-published cycle or stall the scheduler (08 §3, 10 §4).
    safeSideEffect(() => deps.onCyclePublished(result.cycle));
    // The write-path re-probe + idempotency sweep, isolated so it can neither delay nor fail
    // the cycle — never awaited, and a throw or rejection is swallowed.
    if (slowDue && deps.onSlowCycle !== null) {
      const hook = deps.onSlowCycle;
      void Promise.resolve().then(hook).catch(() => undefined);
    }
    // §4 (4): the build-failure-recovery cycle event (degradation edges are emitted above).
    if (recovered) safeSideEffect(() => log({ event: "cycle_recovered", ok: true, seq }));
  }

  /** Emit the edge-triggered degradation transition log (10 §7): only when the degraded state changes
   *  versus the last publication, so a steady state is never re-logged. Fields are safe categorical
   *  ids/counts/sequence/generation only. */
  function emitDegradeEdge(degraded: boolean, degradedCount: number, seq: number, generation: string): void {
    const changed = lastDegraded === null ? degraded : degraded !== lastDegraded;
    if (changed) {
      safeSideEffect(() =>
        log(
          degraded
            ? { event: "cycle_degraded", ok: false, seq, generation, degradedSources: degradedCount }
            : { event: "cycle_healthy", ok: true, seq, generation, degradedSources: 0 },
        ),
      );
    }
    lastDegraded = degraded;
  }

  /** Emit an edge-triggered source failure/recovery log per `SourceId` versus the prior published
   *  records (10 §7): `source_unreachable` on a current→failed edge (with the safe closed error kind),
   *  `source_recovered` on a failed→current edge. No message/body/URL is ever included. */
  function emitSourceEdges(prior: CycleSourceRecords | null, records: CycleSourceRecords): void {
    if (prior === null) return;
    for (const sid of SOURCE_IDS) {
      const before = prior[sid];
      const after = records[sid];
      if (before === null || after === null) continue; // never attempted / not configured
      const wasOk = before.latest.result.ok;
      const nowOk = after.latest.result.ok;
      if (wasOk && !nowOk) {
        const kind = after.latest.result.ok ? null : after.latest.result.error.kind;
        safeSideEffect(() => log({ event: "source_unreachable", ok: false, source: sid, kind }));
      } else if (!wasOk && nowOk) {
        safeSideEffect(() => log({ event: "source_recovered", ok: true, source: sid }));
      }
    }
  }

  /** Acquire the four slow-tier records when due, else reuse the prior published records exactly.
   *  Grafana is `null` (not-configured, zero calls) whenever unconfigured. */
  async function acquireSlowRecords(
    slowDue: boolean,
    prior: CycleSourceRecords | null,
    attemptAt: string,
  ): Promise<
    Pick<
      CycleSourceRecords,
      "victoriametrics-buildinfo" | "alertmanager-status" | "alertmanager-receivers" | "grafana-health"
    >
  > {
    if (!slowDue && prior !== null) {
      return {
        "victoriametrics-buildinfo": prior["victoriametrics-buildinfo"],
        "alertmanager-status": prior["alertmanager-status"],
        "alertmanager-receivers": prior["alertmanager-receivers"],
        "grafana-health": prior["grafana-health"],
      };
    }
    const grafana = clients.grafana;
    const [buildinfo, amStatus, amReceivers, grafanaResult] = await Promise.all([
      countedCall("victoriametrics-buildinfo", () => clients.vm.buildInfo()),
      countedCall("alertmanager-status", () => clients.alertmanager.status()),
      countedCall("alertmanager-receivers", () => clients.alertmanager.receivers()),
      grafana !== null ? countedCall("grafana-health", () => grafana.health()) : Promise.resolve(null),
    ]);
    return {
      "victoriametrics-buildinfo": foldRecord(prior?.["victoriametrics-buildinfo"] ?? null, attemptAt, buildinfo),
      "alertmanager-status": foldRecord(prior?.["alertmanager-status"] ?? null, attemptAt, amStatus),
      "alertmanager-receivers": foldRecord(prior?.["alertmanager-receivers"] ?? null, attemptAt, amReceivers),
      "grafana-health":
        grafanaResult === null
          ? null
          : foldRecord(prior?.["grafana-health"] ?? null, attemptAt, grafanaResult),
    };
  }

  /** Build the fixed `Record<SourceId, SourceObservation>` for the publication observation. */
  function buildSourceObservations(
    records: CycleSourceRecords,
  ): Readonly<Record<SourceId, SourceObservation>> {
    return {
      "victoriametrics-signals": sourceObservation(records["victoriametrics-signals"]),
      "victoriametrics-targets": sourceObservation(records["victoriametrics-targets"]),
      "victoriametrics-buildinfo": sourceObservation(records["victoriametrics-buildinfo"]),
      "alertmanager-alerts": sourceObservation(records["alertmanager-alerts"]),
      "alertmanager-silences": sourceObservation(records["alertmanager-silences"]),
      "alertmanager-status": sourceObservation(records["alertmanager-status"]),
      "alertmanager-receivers": sourceObservation(records["alertmanager-receivers"]),
      "vmalert-rules": sourceObservation(records["vmalert-rules"]),
      "gatus-statuses": sourceObservation(records["gatus-statuses"]),
      "grafana-health": sourceObservation(records["grafana-health"]),
    };
  }

  /** Run one complete cycle: the legacy snapshot/health build (keeps /healthz + /api/overview
   *  compatibility) followed by the atomic cycle publication. Never throws across its boundary. */
  async function runCycle(logicalStart: number): Promise<void> {
    if (closed) return;
    try {
      await runRefreshCycle(state);
      await acquireAndPublish(logicalStart);
    } catch (err) {
      // Defensive cycle-boundary catch: the body is already total, but the scheduler must never die.
      safeSideEffect(() => log({ event: "cycle_error", ok: false, error: (err as Error).message }));
    }
  }

  function scheduleNext(): void {
    if (closed || currentDeadline === null) return;
    currentDeadline += CORE_CADENCE_MS;
    const delay = Math.max(0, currentDeadline - deps.monotonicNow());
    timer = deps.setTimer(() => {
      // `runCycle` is total, but schedule the next deadline regardless of settle outcome so the
      // chain can never stall.
      void serialize(() => runCycle(currentDeadline ?? deps.monotonicNow())).then(
        scheduleNext,
        scheduleNext,
      );
    }, delay);
    // A request-scoped background timer must never keep the host process alive on its own; a fake
    // timer handle injected by a test has no `unref` (optional-chained no-op).
    (timer as { unref?: () => void }).unref?.();
  }

  return {
    runOnce(): Promise<void> {
      return serialize(() => runCycle(currentDeadline ?? deps.monotonicNow()));
    },
    async start(): Promise<void> {
      currentDeadline = deps.monotonicNow(); // D0 = prime start deadline
      await serialize(() => runCycle(currentDeadline ?? deps.monotonicNow()));
      scheduleNext();
    },
    close(): void {
      closed = true;
      if (timer !== null) {
        deps.clearTimer(timer);
        timer = null;
      }
    },
  };
}

/** Run a publication side effect (log/telemetry/SSE) in isolation so an observer throw can never
 *  invalidate the already-published cycle or stall the scheduler (10 §4). */
function safeSideEffect(fn: () => void): void {
  try {
    fn();
  } catch {
    /* observer failures are isolated after publication */
  }
}

/** Count the governing CONFIGURED sources whose latest attempt failed this cycle (10 §7). A `null`
 *  record is a not-configured optional source (Grafana) with no attempt and never counts. */
function countDegradedSources(records: CycleSourceRecords): number {
  let count = 0;
  for (const sid of SOURCE_IDS) {
    const record = records[sid];
    if (record !== null && !record.latest.result.ok) count += 1;
  }
  return count;
}

/** Wrap a {@link HistoryService} so each completed request records its delivery/outcome into the
 *  `pulse_web_history_*` counters and emits a bounded event for the timeout/overload/model-invalidated
 *  failure codes (10 §§6–7). The wrapper is transparent — `stats`/`invalidateModel`/`close` delegate
 *  unchanged — so the gauges (`history_active`/`history_queued`) still read the live service. */
function instrumentHistoryService(inner: HistoryService): HistoryService {
  return {
    async query(request) {
      const result = await inner.query(request);
      recordHistoryOutcome(request.queryId, result);
      return result;
    },
    async alertIntervals(request) {
      const result = await inner.alertIntervals(request);
      recordHistoryOutcome("alert-intervals", result);
      return result;
    },
    async endpointHistory(request) {
      const result = await inner.endpointHistory(request);
      recordHistoryOutcome("endpoint-history", result);
      return result;
    },
    stats: () => inner.stats(),
    invalidateModel: () => inner.invalidateModel(),
    close: () => inner.close(),
  };
}

/** Record one completed history request: the delivery (hit/miss/coalesced) or `error` into the request
 *  counter (and the cache-hit counter on a hit), plus a bounded structured event for the notable
 *  timeout/overload/model-invalidated failure codes. `query` and `code` are safe categorical ids. */
function recordHistoryOutcome<T>(query: HistoryQueryLabel, result: HistoryResult<T>): void {
  if (result.ok) {
    recordHistoryRequest(query, result.delivery);
    return;
  }
  recordHistoryRequest(query, "error");
  const code = result.error.code;
  if (code === "SOURCE_TIMEOUT") {
    safeSideEffect(() => log({ event: "history_timeout", ok: false, query, code }));
  } else if (code === "HISTORY_OVERLOADED") {
    safeSideEffect(() => log({ event: "history_overloaded", ok: false, query, code }));
  } else if (code === "MODEL_CHANGED") {
    safeSideEffect(() => log({ event: "history_model_invalidated", ok: false, query, code }));
  }
}
