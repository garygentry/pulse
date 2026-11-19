// packages/web-data/src/cycle/fold-overview.ts — the pure overview fold
// (04-cycle-and-current-view-folds.md §7). Folds the captured rendered model plus the
// VictoriaMetrics/Alertmanager/Gatus records into `OverviewSnapshotV2`, preserving every
// existing host/service/status field and status meaning and adding live signals, compact
// recent checks, complete alert-state counts, and coverage availability.
//
// Never-silent-green: a host/service is `ok` only with an affirmative liveness signal from
// a currently-successful source and no colouring alert; a failed governing source forces
// `unknown` (liveness → null, alerts unavailable → unknown) while last-good body context is
// retained. `generatedAt` is body materialization time, not cycle observation freshness.
// The fold is pure: it reads only its inputs and makes no source or history call.

import type { DataAvailability } from "../wire/common.js";
import type {
  CheckSummary,
  CoverageSummary,
  HostStatus,
  LiveSignal,
  OverviewAlertSummary,
  OverviewCheckResult,
  OverviewSnapshotV2,
  ServiceStatus,
  SourceHealthCompat,
  TargetStatus,
  TargetStatusEvidence,
} from "../wire/overview.js";
import type { TargetIdentity } from "../wire/history.js";
import { CONTRACT_LIMITS, capList, truncateUtf8 } from "../contract/limits.js";
import type { OverviewLimits } from "../contract/limits.js";
import type { AvailabilitySection } from "../wire/common.js";
import type { MetricSample } from "../sources/vm.js";
import type { AlertmanagerAlert } from "../sources/alertmanager.js";
import type { GatusEndpointState, GatusCheckResult } from "../sources/gatus.js";
import type { WebEstateHostV2, WebEstateServiceV2 } from "@pulse/renderer";
import type { FoldInputs } from "./records.js";
import { hostLivenessJob, isHostLivenessSample } from "../wire/host-liveness.js";
import { capRecentChecks } from "../wire/overview.js";
import { ENGINE_MAX_PROBLEMS, engineProblems } from "../wire/engine-verdict.js";
import type { EnginePayload } from "../wire/engine.js";
import { foldEngine } from "./fold-engine.js";
import {
  DEFAULT_GATUS_STALE_SECONDS,
  effectiveData,
  sourceAvailability,
  sourceHealthCompat,
} from "./records.js";
import {
  candidateFromAlertLabels,
  candidateFromEndpointName,
  resolveCandidate,
  toTargetIdentity,
} from "./target-match.js";

/** The renderer host collection-class discriminant, derived from the model to avoid a core import. */
type CollectionClass = WebEstateHostV2["collectionClass"];

// ---------------------------------------------------------------------------
// Frozen presentation constants (mirroring the app/dashboards drilldown contract)
// ---------------------------------------------------------------------------

/** The always-firing DeadMansSwitch canary; excluded from cell matching, the strip, and counts. */
export const DEADMANS_SWITCH_ALERTNAME = "DeadMansSwitch" as const;

/** Active-alert severity precedence for cell colour: higher index is more severe; `info` never colours. */
const SEVERITY_ORDER: readonly OverviewAlertSummary["severity"][] = ["info", "warning", "critical"];

/** Roll-up severity order: a host cell's rollup is the worst of own status and non-suppressed services. */
const ROLLUP_ORDER: readonly TargetStatus[] = ["ok", "unknown", "warning", "critical"];

/** Return the worse governing availability; current < stale < not-configured < unavailable. */
function worseAvailability(a: DataAvailability, b: DataAvailability): DataAvailability {
  const rank = (state: DataAvailability["state"]): number =>
    state === "current" ? 0 : state === "stale" ? 1 : state === "not-configured" ? 2 : 3;
  return rank(b.state) > rank(a.state) ? b : a;
}

function renderedAvailability(inputs: FoldInputs): DataAvailability {
  return { state: "current", source: "rendered-estate", lastGoodAt: inputs.observedAt, message: null };
}

/** The class → Grafana board UID mapping; classes absent here have no drill-down board. */
const CLASS_BOARDS: Partial<Record<CollectionClass | "deep-health", string>> = {
  "managed-linux": "pulse-host",
  "hypervisor-api": "pulse-hypervisor",
  "nas-api": "pulse-nas",
  "deep-health": "pulse-deephealth",
};

/** The URL-bound template variable each board scopes by; `null` binds no variable. */
const TARGET_VARS: Record<string, "instance" | "service" | null> = {
  "pulse-host": "instance",
  "pulse-hypervisor": "instance",
  "pulse-nas": "instance",
  "pulse-deephealth": "service",
};

// ---------------------------------------------------------------------------
// Liveness and status resolution (preserving the existing overview matrix)
// ---------------------------------------------------------------------------

/** True when `iso` parses and is within `staleSeconds` of `now`; unparseable is never fresh. */
function isFresh(iso: string, now: Date, staleSeconds: number): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return (now.getTime() - t) / 1000 <= staleSeconds;
}

/** The latest evaluation for a Gatus endpoint (results are oldest→newest), or null. */
function latestResult(endpoint: GatusEndpointState): GatusCheckResult | null {
  return endpoint.results.length > 0 ? endpoint.results[endpoint.results.length - 1]! : null;
}

/** Endpoint is monitored & alive: a latest result exists, is fresh, and succeeded. */
function gatusAlive(
  endpoints: readonly GatusEndpointState[],
  name: string,
  now: Date,
  staleSeconds: number,
): boolean {
  const ep = endpoints.find((e) => e.name === name);
  if (ep === undefined) return false;
  const latest = latestResult(ep);
  if (latest === null) return false;
  return latest.success && isFresh(latest.timestamp, now, staleSeconds);
}

/** Endpoint's latest fresh result is an explicit failure (a current "down" reading, not missing evidence). */
function gatusFailing(
  endpoints: readonly GatusEndpointState[],
  name: string,
  now: Date,
  staleSeconds: number,
): boolean {
  const ep = endpoints.find((e) => e.name === name);
  const latest = ep === undefined ? null : latestResult(ep);
  return latest !== null && !latest.success && isFresh(latest.timestamp, now, staleSeconds);
}

/** Governing-source flags and data captured once for the whole fold. */
interface FoldContext {
  readonly metricsOk: boolean;
  readonly alertsOk: boolean;
  readonly checksOk: boolean;
  /** Live series for liveness/link resolution (current data only; empty when metrics failed). */
  readonly liveSeries: readonly MetricSample[];
  /** Gatus states used for liveness (current data only; empty when checks failed). */
  readonly liveCheckStates: readonly GatusEndpointState[];
  readonly now: Date;
  readonly staleSeconds: number;
  readonly grafanaOrigin: string | null;
  /** Silenced/inhibited (non-firing) alerts matched to targets: a muted target's down evidence is not escalated. */
  readonly muted?: MatchedAlerts;
}

/** Affirmative-liveness for a host (null when the governing source is unreachable). */
function evaluateHostLiveness(host: WebEstateHostV2, ctx: FoldContext): boolean | null {
  const cls: CollectionClass = host.collectionClass;
  if (hostLivenessJob(cls) !== null) {
    // `up` of the host's main scrape job only — the HostDown series (wire/host-liveness.ts). An
    // auxiliary exporter's `up` or the agent heartbeat (`pulse_agent_up`) is never host liveness.
    if (!ctx.metricsOk) return null;
    return ctx.liveSeries.some((s) => isHostLivenessSample(cls, host.name, s.projection, s.metric, s.value));
  }
  if (cls === "probe-only") {
    if (!ctx.checksOk) return null;
    return gatusAlive(ctx.liveCheckStates, `host:${host.name}`, ctx.now, ctx.staleSeconds);
  }
  return null; // "excluded" — no signal by design.
}

/**
 * True when the host's current liveness evidence explicitly says DOWN (`up == 0` of its main job, or
 * a fresh failing probe for a probe-only host). Missing or stale evidence is never "down" (F8: that
 * stays unknown).
 */
function observedHostDown(host: WebEstateHostV2, ctx: FoldContext): boolean {
  const cls: CollectionClass = host.collectionClass;
  const job = hostLivenessJob(cls);
  if (job !== null) {
    if (!ctx.metricsOk) return false;
    // Every hypervisor-api scrape goes through pve-exporter: while it is down, hypervisor liveness
    // is unknown, not failed (HypervisorExporterDown inhibits HostDown for the same reason, #74).
    if (cls === "hypervisor-api" && ctx.liveSeries.some((s) =>
      s.projection === "up" && s.metric["job"] === "pve-exporter" && s.value === 0)) return false;
    return ctx.liveSeries.some((s) =>
      s.projection === "up" && s.metric["job"] === job && s.metric["host"] === host.name && s.value === 0);
  }
  if (cls === "probe-only") {
    return ctx.checksOk && gatusFailing(ctx.liveCheckStates, `host:${host.name}`, ctx.now, ctx.staleSeconds);
  }
  return false;
}

/** True when the service's current liveness evidence explicitly says DOWN (see observedHostDown). */
function observedServiceDown(service: WebEstateServiceV2, ctx: FoldContext): boolean {
  if (service.deepHealth) {
    return ctx.metricsOk && ctx.liveSeries.some((s) =>
      s.projection === "pulse_deep_health_up" && s.metric["host"] === service.host &&
      s.metric["service"] === service.name && s.value === 0);
  }
  if (service.ingressUrl !== undefined) {
    return ctx.checksOk &&
      gatusFailing(ctx.liveCheckStates, `${service.host}/${service.name}`, ctx.now, ctx.staleSeconds);
  }
  return false;
}

/** Affirmative-liveness for a service; deep-health takes precedence over ingress freshness. */
function evaluateServiceLiveness(service: WebEstateServiceV2, ctx: FoldContext): boolean | null {
  if (service.deepHealth) {
    if (!ctx.metricsOk) return null;
    return ctx.liveSeries.some(
      (s) =>
        s.projection === "pulse_deep_health_up" &&
        s.metric["host"] === service.host &&
        s.metric["service"] === service.name &&
        s.value === 1,
    );
  }
  if (service.ingressUrl !== undefined) {
    if (!ctx.checksOk) return null;
    return gatusAlive(
      ctx.liveCheckStates,
      `${service.host}/${service.name}`,
      ctx.now,
      ctx.staleSeconds,
    );
  }
  return false; // no signal declared → structurally unknown, even when sources are healthy.
}

/** Resolve one target's `TargetStatus` from the preserved resolution matrix. */
function resolveStatus(p: {
  readonly suppressed: boolean;
  readonly alertsAvailable: boolean;
  readonly alerts: readonly OverviewAlertSummary[];
  readonly live: boolean | null;
  /** Current evidence explicitly says down (observedHostDown / observedServiceDown). */
  readonly down: boolean;
  /** A silenced or inhibited alert is attributed to this target. */
  readonly muted: boolean;
}): TargetStatus {
  if (p.suppressed) return "suppressed";
  if (!p.alertsAvailable) return "unknown";
  let worst = -1;
  for (const a of p.alerts) {
    const rank = SEVERITY_ORDER.indexOf(a.severity);
    if (rank > worst) worst = rank;
  }
  if (worst === SEVERITY_ORDER.indexOf("critical")) return "critical";
  if (worst === SEVERITY_ORDER.indexOf("warning")) return "warning";
  // F8: current evidence that says DOWN is never "unknown" (that is reserved for missing or stale
  // evidence), but it is only a WARNING until the matching alert fires: the alert's own severity and
  // `for:` window then decide, so a single missed scrape never flips a cell critical, and the cell
  // never outranks (or disagrees with) the alert. A silenced or inhibited target is not escalated.
  if (p.down && p.live !== true && !p.muted) return "warning";
  return p.live === true ? "ok" : "unknown";
}

/** Fold statuses to the most severe under `ROLLUP_ORDER`, ignoring suppressed inputs. */
function rollup(own: TargetStatus, services: readonly TargetStatus[]): TargetStatus {
  const contributing = [own, ...services].filter((s) => s !== "suppressed");
  if (contributing.length === 0) return "suppressed";
  let worst = contributing[0]!;
  for (const status of contributing) {
    if (ROLLUP_ORDER.indexOf(status) > ROLLUP_ORDER.indexOf(worst)) worst = status;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Alert / check matching
// ---------------------------------------------------------------------------

/** Composite service key — NUL separator (no declared name contains NUL). */
function serviceKey(host: string, service: string): string {
  return `${host} ${service}`;
}

/** Map an Alertmanager severity to the overview's closed severity vocabulary (unknown → info). */
function overviewSeverity(severity: string): OverviewAlertSummary["severity"] {
  return severity === "critical" || severity === "warning" || severity === "info"
    ? severity
    : "info";
}

/** Matched firing alerts: the strip list plus per-host/per-service colouring maps. */
interface MatchedAlerts {
  readonly all: OverviewAlertSummary[];
  readonly byHost: Map<string, OverviewAlertSummary[]>;
  readonly byService: Map<string, OverviewAlertSummary[]>;
}

/** Match firing alerts (excluding DeadMansSwitch) to declared targets by the identity convention. */
function matchFiringAlerts(inputs: FoldInputs, firing: readonly AlertmanagerAlert[]): MatchedAlerts {
  const all: OverviewAlertSummary[] = [];
  const byHost = new Map<string, OverviewAlertSummary[]>();
  const byService = new Map<string, OverviewAlertSummary[]>();

  for (const raw of firing) {
    if (raw.name === DEADMANS_SWITCH_ALERTNAME) continue;
    const resolved = resolveCandidate(inputs.model, candidateFromAlertLabels(raw.labels));
    const summary = raw.annotations["summary"];
    const target: OverviewAlertSummary["target"] = toTargetIdentity(resolved);
    const alert: OverviewAlertSummary = {
      fingerprint: raw.fingerprint,
      name: raw.name,
      severity: overviewSeverity(raw.severity),
      startsAt: raw.startsAt,
      target,
      ...(summary !== undefined ? { summary } : {}),
      // REQ-ACK-07d: read-only marker; literal true only when acked, absent otherwise.
      ...(inputs.acks?.has(raw.fingerprint) === true ? { acked: true as const } : {}),
    };
    all.push(alert);
    if (resolved !== null) {
      if (resolved.kind === "service") {
        const key = serviceKey(resolved.host, resolved.service);
        (byService.get(key) ?? byService.set(key, []).get(key)!).push(alert);
      } else {
        (byHost.get(resolved.host) ?? byHost.set(resolved.host, []).get(resolved.host)!).push(alert);
      }
    }
  }
  return { all, byHost, byService };
}

/** One matched Gatus check result mapped to the overview supporting-detail shape. */
function toOverviewCheck(endpoint: GatusEndpointState): OverviewCheckResult {
  const latest = latestResult(endpoint);
  return {
    endpoint: endpoint.name,
    success: latest?.success ?? false,
    lastEvaluatedAt: latest?.timestamp ?? "",
    ...(latest?.durationMs != null ? { responseTimeMs: latest.durationMs } : {}),
  };
}

/** Attribute Gatus endpoint states to declared targets; estate-level/undeclared are dropped. */
function matchChecks(
  inputs: FoldInputs,
  endpoints: readonly GatusEndpointState[],
): { readonly byHost: Map<string, OverviewCheckResult[]>; readonly byService: Map<string, OverviewCheckResult[]> } {
  const byHost = new Map<string, OverviewCheckResult[]>();
  const byService = new Map<string, OverviewCheckResult[]>();
  for (const endpoint of endpoints) {
    const resolved = resolveCandidate(inputs.model, candidateFromEndpointName(endpoint.name));
    if (resolved === null) continue;
    const check = toOverviewCheck(endpoint);
    if (resolved.kind === "service") {
      const key = serviceKey(resolved.host, resolved.service);
      (byService.get(key) ?? byService.set(key, []).get(key)!).push(check);
    } else {
      (byHost.get(resolved.host) ?? byHost.set(resolved.host, []).get(resolved.host)!).push(check);
    }
  }
  return { byHost, byService };
}

// ---------------------------------------------------------------------------
// Grafana deep links (from observed live series only)
// ---------------------------------------------------------------------------

/** `""` when origin is unset (disabled link); else `<origin>/d/<uid>?var-<var>=<enc>`. */
function buildUrl(origin: string | null, uid: string, variable: string, value: string): string {
  if (origin === null) return "";
  const base = origin.replace(/\/+$/, "");
  return `${base}/d/${uid}?var-${variable}=${encodeURIComponent(value)}`;
}

/** Grafana link for a host, or null when its class has no board or no series was observed. */
function hostGrafanaLink(host: WebEstateHostV2, ctx: FoldContext): HostStatus["grafana"] {
  const boardUid = CLASS_BOARDS[host.collectionClass];
  if (boardUid === undefined) return null;
  const variable = TARGET_VARS[boardUid] ?? null;
  const observed = ctx.liveSeries.find(
    (s) => s.projection === "up" && s.metric["host"] === host.name,
  )?.metric["instance"];
  if (observed === undefined || variable === null) return null;
  return { boardUid, url: buildUrl(ctx.grafanaOrigin, boardUid, variable, observed) };
}

/** Grafana link for a deep-health service, or null otherwise / when no series was observed. */
function serviceGrafanaLink(service: WebEstateServiceV2, ctx: FoldContext): ServiceStatus["grafana"] {
  if (!service.deepHealth) return null;
  const boardUid = CLASS_BOARDS["deep-health"];
  if (boardUid === undefined) return null;
  const variable = TARGET_VARS[boardUid] ?? null;
  const observed = ctx.liveSeries.find(
    (s) =>
      s.projection === "pulse_deep_health_up" &&
      s.metric["host"] === service.host &&
      s.metric["service"] === service.name,
  )?.metric["service"];
  if (observed === undefined || variable === null) return null;
  return { boardUid, url: buildUrl(ctx.grafanaOrigin, boardUid, variable, observed) };
}

// ---------------------------------------------------------------------------
// Host / service builders
// ---------------------------------------------------------------------------

/** The governing liveness availability for a host, given its class and the fold context. */
function hostLivenessAvailability(
  host: WebEstateHostV2,
  inputs: FoldInputs,
): DataAvailability {
  const cls = host.collectionClass;
  if (cls === "probe-only") return sourceAvailability(inputs.records["gatus-statuses"], "gatus-statuses");
  if (cls === "excluded") {
    return { state: "not-configured", source: "rendered-estate", lastGoodAt: null, message: null };
  }
  return sourceAvailability(inputs.records["victoriametrics-signals"], "victoriametrics-signals");
}

/** The governing liveness availability for a service, given its declared signal. */
function serviceLivenessAvailability(
  service: WebEstateServiceV2,
  inputs: FoldInputs,
): DataAvailability {
  if (service.deepHealth) {
    return sourceAvailability(inputs.records["victoriametrics-signals"], "victoriametrics-signals");
  }
  if (service.ingressUrl !== undefined) {
    return sourceAvailability(inputs.records["gatus-statuses"], "gatus-statuses");
  }
  return { state: "not-configured", source: "rendered-estate", lastGoodAt: null, message: null };
}

/** Build one `ServiceStatus`. */
function buildService(
  service: WebEstateServiceV2,
  ctx: FoldContext,
  inputs: FoldInputs,
  matched: MatchedAlerts,
  checks: ReturnType<typeof matchChecks>,
): ServiceStatus {
  const key = serviceKey(service.host, service.name);
  const activeAlerts = matched.byService.get(key) ?? [];
  const serviceChecks = checks.byService.get(key) ?? [];
  const live = evaluateServiceLiveness(service, ctx);
  const suppressed = service.suppressed
    ? { class: service.suppressed.class, rationale: service.suppressed.rationale }
    : null;
  const status = resolveStatus({
    suppressed: suppressed !== null,
    alertsAvailable: ctx.alertsOk,
    alerts: activeAlerts,
    live,
    down: observedServiceDown(service, ctx),
    muted: (ctx.muted?.byService.get(key)?.length ?? 0) > 0,
  });
  const statusAvailability = suppressed !== null
    ? renderedAvailability(inputs)
    : worseAvailability(
        serviceLivenessAvailability(service, inputs),
        sourceAvailability(inputs.records["alertmanager-alerts"], "alertmanager-alerts"),
      );
  return {
    name: service.name,
    host: service.host,
    managed: service.managed,
    deepHealth: service.deepHealth,
    ...(service.ingressUrl !== undefined ? { ingressUrl: service.ingressUrl } : {}),
    drilldownId: service.drilldownId,
    suppressed,
    status,
    statusEvidence: { status, availability: statusAvailability },
    live,
    activeAlerts,
    checks: serviceChecks,
    grafana: serviceGrafanaLink(service, ctx),
  };
}

/** Build one `HostStatus` including its services and roll-up. */
function buildHost(
  host: WebEstateHostV2,
  ctx: FoldContext,
  inputs: FoldInputs,
  matched: MatchedAlerts,
  checks: ReturnType<typeof matchChecks>,
): HostStatus {
  const services = inputs.model.services
    .filter((s) => s.host === host.name)
    .map((s) => buildService(s, ctx, inputs, matched, checks));

  const activeAlerts = matched.byHost.get(host.name) ?? [];
  const hostChecks = checks.byHost.get(host.name) ?? [];
  const live = evaluateHostLiveness(host, ctx);
  const suppressed = host.suppressed
    ? { class: host.suppressed.class, rationale: host.suppressed.rationale }
    : null;
  const status = resolveStatus({
    suppressed: suppressed !== null,
    alertsAvailable: ctx.alertsOk,
    alerts: activeAlerts,
    live,
    down: observedHostDown(host, ctx),
    muted: (ctx.muted?.byHost.get(host.name)?.length ?? 0) > 0,
  });
  const contributingServices = services.filter((s) => s.suppressed === null);
  const contributing = contributingServices.map((s) => s.status);
  const rolled = rollup(status, contributing);
  const statusAvailability = suppressed !== null
    ? renderedAvailability(inputs)
    : worseAvailability(
        hostLivenessAvailability(host, inputs),
        sourceAvailability(inputs.records["alertmanager-alerts"], "alertmanager-alerts"),
      );
  const rollupAvailability = contributingServices.reduce(
    (availability, service) => worseAvailability(availability, service.statusEvidence.availability),
    statusAvailability,
  );

  return {
    name: host.name,
    collectionClass: host.collectionClass,
    addresses: host.addresses,
    drilldownId: host.drilldownId,
    suppressed,
    status,
    statusEvidence: { status, availability: statusAvailability },
    rollup: rolled,
    rollupEvidence: { status: rolled, availability: rollupAvailability },
    live,
    activeAlerts,
    checks: hostChecks,
    grafana: hostGrafanaLink(host, ctx),
    services,
  };
}

// ---------------------------------------------------------------------------
// Additive sections: signals, recent checks, alert counts, coverage
// ---------------------------------------------------------------------------

/** Find one current finite VM sample for a declared target/metric tuple. */
function metricValue(
  series: readonly MetricSample[],
  metric: string,
  host: string,
  service?: string,
): number | null {
  const sample = series.find((candidate) =>
    candidate.projection === metric &&
    candidate.metric["host"] === host &&
    (service === undefined || candidate.metric["service"] === service) &&
    candidate.value !== null && Number.isFinite(candidate.value),
  );
  return sample?.value ?? null;
}

/** Mark a declared scalar signal unavailable when its current source body contains no finite sample. */
function scalarAvailability(value: number | null, availability: DataAvailability): DataAvailability {
  if (value !== null || availability.state !== "current") return availability;
  return {
    state: "unavailable",
    source: availability.source,
    lastGoodAt: availability.lastGoodAt,
    message: "No current sample exists for this declared signal.",
  };
}

/** Build attributed liveness, deep-health, backup, and command signal families in model order. */
function buildSignals(
  hosts: readonly HostStatus[],
  inputs: FoldInputs,
  hostAvailability: ReadonlyMap<string, DataAvailability>,
  serviceAvailability: ReadonlyMap<string, DataAvailability>,
): LiveSignal[] {
  const signals: LiveSignal[] = [];
  const metricAvailability = sourceAvailability(
    inputs.records["victoriametrics-signals"],
    "victoriametrics-signals",
  );
  for (const host of hosts) {
    const hostTarget = { kind: "host", id: host.drilldownId } as const;
    signals.push({
      target: hostTarget,
      id: `${host.drilldownId}:liveness`,
      label: `${host.name} liveness`,
      unit: "state",
      value: host.live,
      availability: hostAvailability.get(host.drilldownId)!,
    });
    const declaredHost = inputs.model.hosts.find((candidate) => candidate.drilldownId === host.drilldownId);
    if (declaredHost?.collectionClass === "managed-linux") {
      for (const command of declaredHost.detail.commandSignals) {
        if (command.output !== "scalar") continue;
        const value = metricValue(inputs.records["victoriametrics-signals"].latest.result.ok
          ? inputs.records["victoriametrics-signals"].latest.result.data : [], command.metric, host.name);
        signals.push({
          target: hostTarget,
          id: `${host.drilldownId}:command:${command.name}`,
          label: command.name,
          unit: "scalar",
          value,
          availability: scalarAvailability(value, metricAvailability),
        });
      }
    }
    for (const service of host.services) {
      const target = { kind: "service", id: service.drilldownId } as const;
      signals.push({
        target,
        id: `${service.drilldownId}:liveness`,
        label: `${service.host}/${service.name} liveness`,
        unit: "state",
        value: service.live,
        availability: serviceAvailability.get(service.drilldownId)!,
      });
      const declared = inputs.model.services.find((candidate) => candidate.drilldownId === service.drilldownId);
      for (const metric of declared?.deepHealthDetail?.metrics ?? []) {
        const value = metricValue(inputs.records["victoriametrics-signals"].latest.result.ok
          ? inputs.records["victoriametrics-signals"].latest.result.data : [], metric, service.host, service.name);
        signals.push({
          target,
          id: `${service.drilldownId}:deep-health:${metric}`,
          label: metric,
          unit: "scalar",
          value,
          availability: scalarAvailability(value, metricAvailability),
        });
      }
      if (declared?.backupFreshness !== null && declared?.backupFreshness !== undefined) {
        const value = metricValue(inputs.records["victoriametrics-signals"].latest.result.ok
          ? inputs.records["victoriametrics-signals"].latest.result.data : [],
          "pulse_backup_freshness_age_seconds", service.host, service.name);
        signals.push({
          target,
          id: `${service.drilldownId}:backup-age`,
          label: `${service.name} backup age`,
          unit: "seconds",
          value,
          availability: scalarAvailability(value, metricAvailability),
        });
      }
    }
  }
  return signals;
}

/** Build the newest retained attributed Gatus outcomes (bounded), sorted by endpoint then time. */
function buildRecentChecks(inputs: FoldInputs, endpoints: readonly GatusEndpointState[]): CheckSummary[] {
  const checks: CheckSummary[] = [];
  for (const endpoint of endpoints) {
    const target = toTargetIdentity(
      resolveCandidate(inputs.model, candidateFromEndpointName(endpoint.name)),
    );
    if (endpoint.results.length === 0) {
      checks.push({ target, endpoint: endpoint.name, success: null, observedAt: null, durationMs: null });
      continue;
    }
    for (const result of endpoint.results) {
      checks.push({
        target,
        endpoint: endpoint.name,
        success: result.success,
        observedAt: result.timestamp,
        durationMs: result.durationMs ?? null,
      });
    }
  }
  // Keep the newest results per endpoint within the shared client bound (F1); also sorts by
  // endpoint, then observation time.
  return capRecentChecks(checks);
}

/**
 * Build the compact engine summary without treating transport contact as health. Health uses the
 * same payload derivation as the Engine verdict (`engineProblems`), so the views agree (F5).
 */
function buildEngineSummary(inputs: FoldInputs, engine: EnginePayload): OverviewSnapshotV2["engine"] {
  const ids = [
    "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
    "alertmanager-alerts", "alertmanager-status", "vmalert-rules", "gatus-statuses",
  ] as const;
  const failed = ids.find((id) => !inputs.records[id].latest.result.ok);
  if (failed !== undefined) {
    return { availability: sourceAvailability(inputs.records[failed], failed), value: null };
  }
  const problems = engineProblems(engine).slice(0, ENGINE_MAX_PROBLEMS);
  return {
    availability: sourceAvailability(
      inputs.records["victoriametrics-signals"],
      "victoriametrics-signals",
    ),
    value: { ok: problems.length === 0, problems },
  };
}

/** Count complete current alert states (all states, excluding the DeadMansSwitch canary). */
function buildAlertCounts(
  alerts: readonly AlertmanagerAlert[],
): OverviewSnapshotV2["alertCounts"] {
  let firing = 0;
  let silenced = 0;
  let inhibited = 0;
  for (const alert of alerts) {
    if (alert.name === DEADMANS_SWITCH_ALERTNAME) continue;
    if (alert.state === "firing") firing += 1;
    else if (alert.state === "silenced") silenced += 1;
    else inhibited += 1;
  }
  return { firing, silenced, inhibited };
}

/** Build the coverage availability section: present artifact → summary; absent → unavailable. */
function buildCoverage(inputs: FoldInputs): AvailabilitySection<CoverageSummary> {
  const coverage = inputs.coverage;
  if (coverage === null) {
    return {
      availability: {
        state: "unavailable",
        source: "rendered-estate",
        lastGoodAt: null,
        message: "Coverage is unavailable; run `pulse render` to regenerate it.",
      },
      value: null,
    };
  }
  const summary: CoverageSummary = {
    covered: coverage.covered.length,
    gaps: coverage.gaps.length,
    // The coverage artifact records only declared entities; every rendered artifact traces to a
    // declared entity, so there are no undeclared "extra" rendered targets from its perspective.
    extras: 0,
  };
  return {
    availability: {
      state: "current",
      source: "rendered-estate",
      lastGoodAt: inputs.observedAt,
      message: null,
    },
    value: summary,
  };
}

// ---------------------------------------------------------------------------
// Contract limits: trim collections and truncate strings so the body always validates
// ---------------------------------------------------------------------------

/** Map preserving identity: returns `items` itself when every `fn(item) === item`. */
function mapSame<T>(items: readonly T[], fn: (item: T) => T): readonly T[] {
  let out: T[] | null = null;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as T;
    const next = fn(item);
    if (out !== null) out.push(next);
    else if (next !== item) {
      out = items.slice(0, i);
      out.push(next);
    }
  }
  return out ?? items;
}

/** truncateUtf8 for a text field (limits.textBytes). */
function text(value: string, limits: OverviewLimits): string {
  return truncateUtf8(value, limits.textBytes);
}

/** truncateUtf8 for a message field (limits.messageBytes); null passes through. */
function message(value: string | null, limits: OverviewLimits): string | null {
  return value === null ? null : truncateUtf8(value, limits.messageBytes);
}

function enforceAvailability(a: DataAvailability, limits: OverviewLimits): DataAvailability {
  const bounded = message(a.message, limits);
  return bounded === a.message ? a : { ...a, message: bounded };
}

function enforceEvidence(e: TargetStatusEvidence, limits: OverviewLimits): TargetStatusEvidence {
  const availability = enforceAvailability(e.availability, limits);
  return availability === e.availability ? e : { ...e, availability };
}

function enforceIdentity(t: TargetIdentity, limits: OverviewLimits): TargetIdentity {
  const id = text(t.id, limits);
  return id === t.id ? t : { ...t, id };
}

function enforceAlert(a: OverviewAlertSummary, limits: OverviewLimits): OverviewAlertSummary {
  const fingerprint = text(a.fingerprint, limits);
  const name = text(a.name, limits);
  const target = a.target === null ? null : enforceIdentity(a.target, limits);
  const summary = a.summary === undefined ? undefined : truncateUtf8(a.summary, limits.messageBytes);
  if (fingerprint === a.fingerprint && name === a.name && target === a.target && summary === a.summary) return a;
  return { ...a, fingerprint, name, target, ...(summary !== undefined ? { summary } : {}) };
}

function enforceTargetCheck(c: OverviewCheckResult, limits: OverviewLimits): OverviewCheckResult {
  const endpoint = text(c.endpoint, limits);
  return endpoint === c.endpoint ? c : { ...c, endpoint };
}

/** Suppression shared by hosts and services: `class` is a text field, `rationale` a message field. */
function enforceSuppressed(s: HostStatus["suppressed"], limits: OverviewLimits): HostStatus["suppressed"] {
  if (s === null) return null;
  const klass = text(s.class, limits);
  const rationale = truncateUtf8(s.rationale, limits.messageBytes);
  return klass === s.class && rationale === s.rationale ? s : { class: klass, rationale };
}

/** Grafana link: an over-cap `url` becomes "" (deep links disabled), because a cut URL is a broken link. */
function enforceGrafana(g: HostStatus["grafana"], limits: OverviewLimits): HostStatus["grafana"] {
  if (g === null) return null;
  const boardUid = text(g.boardUid, limits);
  const url = truncateUtf8(g.url, limits.messageBytes) === g.url ? g.url : "";
  return boardUid === g.boardUid && url === g.url ? g : { boardUid, url };
}

function enforceAlerts(
  alerts: readonly OverviewAlertSummary[],
  limits: OverviewLimits,
): readonly OverviewAlertSummary[] {
  return mapSame(capList(alerts, limits.alerts), (a) => enforceAlert(a, limits));
}

function enforceTargetChecks(
  checks: readonly OverviewCheckResult[],
  limits: OverviewLimits,
): readonly OverviewCheckResult[] {
  return mapSame(capList(checks, limits.targetChecks), (c) => enforceTargetCheck(c, limits));
}

function enforceService(s: ServiceStatus, limits: OverviewLimits): ServiceStatus {
  const name = text(s.name, limits);
  const host = text(s.host, limits);
  const drilldownId = text(s.drilldownId, limits);
  const suppressed = enforceSuppressed(s.suppressed, limits);
  const statusEvidence = enforceEvidence(s.statusEvidence, limits);
  const activeAlerts = enforceAlerts(s.activeAlerts, limits);
  const checks = enforceTargetChecks(s.checks, limits);
  const grafana = enforceGrafana(s.grafana, limits);
  // An over-cap ingress URL is omitted rather than cut: the member is optional and a cut URL is a broken link.
  const dropIngress = s.ingressUrl !== undefined && truncateUtf8(s.ingressUrl, limits.messageBytes) !== s.ingressUrl;
  if (name === s.name && host === s.host && drilldownId === s.drilldownId && suppressed === s.suppressed &&
      statusEvidence === s.statusEvidence && activeAlerts === s.activeAlerts && checks === s.checks &&
      grafana === s.grafana && !dropIngress) return s;
  const { ingressUrl, ...rest } = s;
  return {
    ...rest,
    ...(ingressUrl !== undefined && !dropIngress ? { ingressUrl } : {}),
    name, host, drilldownId, suppressed, statusEvidence, activeAlerts, checks, grafana,
  };
}

/** `status` and `rollup` are kept: they were resolved from the complete alert and service sets. */
function enforceHost(h: HostStatus, services: readonly ServiceStatus[], limits: OverviewLimits): HostStatus {
  const name = text(h.name, limits);
  const drilldownId = text(h.drilldownId, limits);
  const addresses = mapSame(capList(h.addresses, limits.hostAddresses), (a) => text(a, limits));
  const suppressed = enforceSuppressed(h.suppressed, limits);
  const statusEvidence = enforceEvidence(h.statusEvidence, limits);
  const rollupEvidence = enforceEvidence(h.rollupEvidence, limits);
  const activeAlerts = enforceAlerts(h.activeAlerts, limits);
  const checks = enforceTargetChecks(h.checks, limits);
  const grafana = enforceGrafana(h.grafana, limits);
  if (name === h.name && drilldownId === h.drilldownId && addresses === h.addresses && suppressed === h.suppressed &&
      statusEvidence === h.statusEvidence && rollupEvidence === h.rollupEvidence && activeAlerts === h.activeAlerts &&
      checks === h.checks && grafana === h.grafana && services === h.services) return h;
  return {
    ...h, name, drilldownId, addresses, suppressed, statusEvidence, rollupEvidence, activeAlerts, checks, grafana,
    services,
  };
}

function enforceSignal(s: LiveSignal, limits: OverviewLimits): LiveSignal {
  const target = enforceIdentity(s.target, limits);
  const id = text(s.id, limits);
  const label = text(s.label, limits);
  const value = typeof s.value === "string" ? truncateUtf8(s.value, limits.messageBytes) : s.value;
  const availability = enforceAvailability(s.availability, limits);
  if (target === s.target && id === s.id && label === s.label && value === s.value &&
      availability === s.availability) return s;
  return { ...s, target, id, label, value, availability };
}

function enforceRecentCheck(c: CheckSummary, limits: OverviewLimits): CheckSummary {
  const target = c.target === null ? null : enforceIdentity(c.target, limits);
  const endpoint = text(c.endpoint, limits);
  return target === c.target && endpoint === c.endpoint ? c : { ...c, target, endpoint };
}

function enforceSourceHealth(s: SourceHealthCompat, limits: OverviewLimits): SourceHealthCompat {
  const error = message(s.error, limits);
  return error === s.error ? s : { ...s, error };
}

function enforceEngine(e: OverviewSnapshotV2["engine"], limits: OverviewLimits): OverviewSnapshotV2["engine"] {
  const availability = enforceAvailability(e.availability, limits);
  let value = e.value;
  if (value !== null && value.problems !== undefined) {
    const problems = mapSame(capList(value.problems, limits.engineProblems), (p) => text(p, limits));
    if (problems !== value.problems) value = { ...value, problems };
  }
  return availability === e.availability && value === e.value ? e : { ...e, availability, value };
}

/**
 * Bring an overview snapshot within the contract's overview limits: trim every bounded collection in its
 * existing order and truncate every validator-bounded string to its UTF-8 byte cap, so the result always
 * passes `validateOverviewSnapshotV2` (given otherwise well-formed input).
 *
 * Pure and copy-on-write: never mutates `snapshot` (which may be deep-frozen). Returns the SAME reference
 * when nothing exceeded a cap. Otherwise it returns a new root, and only the changed paths are new objects;
 * unchanged subtrees are shared.
 *
 * Hosts keep their first `hosts` entries; services share one `servicesTotal` budget in host order (a host past
 * the budget stays, with no services). Signals of a host or service that was trimmed away are dropped; alerts
 * and recent checks of trimmed targets are kept. Status, rollup and `alertCounts` are NOT recomputed: they
 * describe the complete estate, computed before trimming.
 *
 * @param snapshot - A complete overview body.
 * @param limits - Caps to enforce; tests pass small values. Defaults to `CONTRACT_LIMITS.overview`.
 * @returns A snapshot within `limits`.
 * @throws {RangeError} only if `limits` holds a negative or non-integer cap; `CONTRACT_LIMITS` never does.
 */
export function enforceOverviewLimits(
  snapshot: OverviewSnapshotV2,
  limits: OverviewLimits = CONTRACT_LIMITS.overview,
): OverviewSnapshotV2 {
  // Hosts, with one shared service budget walked in host order.
  const cappedHosts = capList(snapshot.hosts, limits.hosts);
  let targetsDropped = cappedHosts !== snapshot.hosts;
  let idsTruncated = false;
  let budget = limits.servicesTotal;
  let hosts = mapSame(cappedHosts, (h) => {
    const kept = capList(h.services, budget);
    budget -= kept.length;
    if (kept !== h.services) targetsDropped = true;
    const services = mapSame(kept, (s) => {
      const next = enforceService(s, limits);
      if (next.drilldownId !== s.drilldownId) idsTruncated = true;
      return next;
    });
    const next = enforceHost(h, services, limits);
    if (next.drilldownId !== h.drilldownId) idsTruncated = true;
    return next;
  });

  // Two ids that share their whole kept prefix collide once truncated; the later target is dropped, because
  // the validator requires unique drilldown ids.
  if (idsTruncated) {
    const seen = new Set<string>();
    const unique: HostStatus[] = [];
    let collided = false;
    for (const h of hosts) {
      if (seen.has(h.drilldownId)) {
        collided = true;
        continue;
      }
      seen.add(h.drilldownId);
      const services = h.services.filter((s) => {
        if (seen.has(s.drilldownId)) return false;
        seen.add(s.drilldownId);
        return true;
      });
      if (services.length === h.services.length) unique.push(h);
      else {
        collided = true;
        unique.push({ ...h, services });
      }
    }
    if (collided) {
      hosts = unique;
      targetsDropped = true;
    }
  }

  const alerts = enforceAlerts(snapshot.alerts, limits);

  // Signals are drawer detail for a cell: once a cell is no longer sent, its signals go with it.
  let keptSignals = snapshot.signals;
  if (targetsDropped) {
    const retained = new Set<string>();
    for (const h of hosts) {
      retained.add(h.drilldownId);
      for (const s of h.services) retained.add(s.drilldownId);
    }
    const filtered = keptSignals.filter((s) => s.target.kind === "endpoint" || retained.has(text(s.target.id, limits)));
    if (filtered.length !== keptSignals.length) keptSignals = filtered;
  }
  const signals = mapSame(capList(keptSignals, limits.signals), (s) => enforceSignal(s, limits));

  // capRecentChecks always allocates and re-sorts, so it runs only over the cap.
  const boundedChecks = mapSame(snapshot.recentChecks, (c) => enforceRecentCheck(c, limits));
  const recentChecks = boundedChecks.length > limits.recentChecks
    ? capRecentChecks(boundedChecks, limits.recentChecks)
    : boundedChecks;

  const engine = enforceEngine(snapshot.engine, limits);
  const appVersion = text(snapshot.appVersion, limits);
  const estateName = text(snapshot.estate.name, limits);
  const timezone = text(snapshot.estate.timezone, limits);
  const estate = estateName === snapshot.estate.name && timezone === snapshot.estate.timezone
    ? snapshot.estate
    : { ...snapshot.estate, name: estateName, timezone };
  const metrics = enforceSourceHealth(snapshot.sources.metrics, limits);
  const alertsSource = enforceSourceHealth(snapshot.sources.alerts, limits);
  const checksSource = enforceSourceHealth(snapshot.sources.checks, limits);
  const sources = metrics === snapshot.sources.metrics && alertsSource === snapshot.sources.alerts &&
      checksSource === snapshot.sources.checks
    ? snapshot.sources
    : { metrics, alerts: alertsSource, checks: checksSource };
  const coverageAvailability = enforceAvailability(snapshot.coverage.availability, limits);
  const coverage = coverageAvailability === snapshot.coverage.availability
    ? snapshot.coverage
    : { ...snapshot.coverage, availability: coverageAvailability };

  if (appVersion === snapshot.appVersion && estate === snapshot.estate && sources === snapshot.sources &&
      hosts === snapshot.hosts && alerts === snapshot.alerts && signals === snapshot.signals &&
      recentChecks === snapshot.recentChecks && engine === snapshot.engine && coverage === snapshot.coverage) {
    return snapshot;
  }
  return {
    appVersion,
    generatedAt: snapshot.generatedAt,
    estate,
    sources,
    hosts,
    alerts,
    signals,
    recentChecks,
    engine,
    alertCounts: snapshot.alertCounts,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// The overview fold
// ---------------------------------------------------------------------------

/**
 * Fold the captured model and source records into the overview snapshot (§7). Preserves
 * every existing host/service/status field and status meaning, applies the never-silent-green
 * matrix, and adds live signals, compact recent checks, complete alert-state counts, and
 * coverage availability. Deterministic (model declaration order for entities; signal/check
 * ids) and pure — no source or history call. `generatedAt` is body materialization time.
 *
 * @param inputs - The captured model/artifacts, source records, and stamping metadata.
 * @param engine - This cycle's engine payload, whose problems decide the engine summary
 *   (folded from `inputs` when omitted).
 * @returns The materialized {@link OverviewSnapshotV2}.
 */
export function foldOverview(inputs: FoldInputs, engine: EnginePayload = foldEngine(inputs)): OverviewSnapshotV2 {
  const { model, records } = inputs;

  const metricsRecord = records["victoriametrics-signals"];
  const alertsRecord = records["alertmanager-alerts"];
  const checksRecord = records["gatus-statuses"];

  const metricsOk = metricsRecord.latest.result.ok;
  const alertsOk = alertsRecord.latest.result.ok;
  const checksOk = checksRecord.latest.result.ok;

  const ctx: FoldContext = {
    metricsOk,
    alertsOk,
    checksOk,
    liveSeries: metricsOk ? metricsRecord.latest.result.data : [],
    liveCheckStates: checksOk ? checksRecord.latest.result.data : [],
    now: new Date(inputs.observedAt),
    staleSeconds: inputs.overview?.gatusStaleSeconds ?? DEFAULT_GATUS_STALE_SECONDS,
    grafanaOrigin: inputs.overview?.grafanaOrigin ?? null,
  };

  // Effective (last-good-retaining) source bodies for the retained lists/counts.
  const effectiveAlerts = effectiveData(alertsRecord)?.data ?? [];
  const effectiveChecks = effectiveData(checksRecord)?.data ?? [];
  const firingAlerts = effectiveAlerts.filter((a) => a.state === "firing");

  const matched = matchFiringAlerts(inputs, firingAlerts);
  const checks = matchChecks(inputs, effectiveChecks);

  const muted = matchFiringAlerts(inputs, effectiveAlerts.filter((a) => a.state !== "firing"));
  const statusCtx: FoldContext = { ...ctx, muted };
  const hosts = model.hosts.map((host) => buildHost(host, statusCtx, inputs, matched, checks));

  // Per-target liveness availability, keyed by drilldown id, for the additive signals.
  const hostAvailability = new Map<string, DataAvailability>();
  const serviceAvailability = new Map<string, DataAvailability>();
  for (const host of model.hosts) {
    hostAvailability.set(host.drilldownId, hostLivenessAvailability(host, inputs));
    for (const service of model.services) {
      if (service.host === host.name) {
        serviceAvailability.set(service.drilldownId, serviceLivenessAvailability(service, inputs));
      }
    }
  }

  // The strip: active unsilenced (firing) alerts, matched + unattributed, severity then recency.
  const strip = [...matched.all].sort((a, b) => {
    const sev = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);
    if (sev !== 0) return sev;
    const at = Date.parse(b.startsAt) - Date.parse(a.startsAt);
    return Number.isNaN(at) ? 0 : at;
  });

  const sources: OverviewSnapshotV2["sources"] = {
    metrics: sourceHealthCompat(metricsRecord),
    alerts: sourceHealthCompat(alertsRecord),
    checks: sourceHealthCompat(checksRecord),
  };

  // The body is brought within the contract caps here, so the client validator never rejects it.
  return enforceOverviewLimits({
    appVersion: inputs.appVersion,
    generatedAt: inputs.observedAt,
    estate: { name: model.estate.name, timezone: model.estate.timezone, tzFallback: false },
    sources,
    hosts,
    alerts: strip,
    signals: buildSignals(hosts, inputs, hostAvailability, serviceAvailability),
    recentChecks: buildRecentChecks(inputs, effectiveChecks),
    engine: buildEngineSummary(inputs, engine),
    alertCounts: buildAlertCounts(effectiveAlerts),
    coverage: buildCoverage(inputs),
  });
}
