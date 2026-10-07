// src/server/snapshot/build.ts — the pure OverviewSnapshot fold.
//
// `buildSnapshot(model, sourceData, now, cfg)` folds the loaded estate model plus the three parsed
// engine-source outputs into one `OverviewSnapshot`. PURE: no `fetch`, no clock read (uses `now`),
// no env read (uses `cfg`). Deterministic for a fixed input tuple, which is what makes the §3.5
// resolution matrix, roll-up, matching, and link construction exhaustively table-testable.

import { rollup, SEVERITY_ORDER } from "../../shared/status.js";
import type {
  ActiveAlert,
  HostStatus,
  OverviewSnapshot,
  ServiceStatus,
  SourceHealth,
  TargetStatus,
} from "../../shared/snapshot.js";
import type { WebEstateHost, WebEstateModel, WebEstateService } from "@pulse/renderer";
import type { LiveSeries, RawActiveAlert, RawCheckStatus } from "../sources/types.js";

import { evaluateHostLiveness, evaluateServiceLiveness } from "./liveness.js";
import { hostGrafanaLink, serviceGrafanaLink } from "./links.js";
import { matchAlerts, matchChecks, serviceKey } from "./match.js";

/** Parsed outputs of the three engine sources, each with its own reachability (REQ-LIVE-04). */
export interface SourceData {
  /** VictoriaMetrics liveness union-query result. `health.ok=false` ⇒ liveness unknown (`live=null`). */
  liveness: { series: LiveSeries[]; health: SourceHealth };
  /** Alertmanager active alerts. `health.ok=false` ⇒ colour cannot be determined (cells → unknown). */
  alerts: { active: RawActiveAlert[]; health: SourceHealth };
  /** Gatus endpoint statuses. `health.ok=false` ⇒ check-derived liveness unknown; checks empty. */
  checks: { endpoints: RawCheckStatus[]; health: SourceHealth };
}

/**
 * Config-derived scalars the pure build needs. Threaded as an explicit argument (never read from
 * `process.env` inside the fold) so `buildSnapshot` stays pure and table-testable.
 */
function availability(
  health: SourceHealth,
  source: "victoriametrics-signals" | "alertmanager-alerts" | "gatus-statuses",
): import("@pulse/web-data/wire").DataAvailability {
  return {
    state: health.ok ? "current" : health.lastSuccess === null ? "unavailable" : "stale",
    source,
    lastGoodAt: health.lastSuccess,
    message: health.error,
  };
}

export interface BuildConfig {
  /** `WEB_APP_VERSION` — the version-skew reload key (REQ-LIVE-06, `OverviewSnapshot.appVersion`). */
  appVersion: string;
  /** Effective IANA timezone, or `"UTC"` on fallback (REQ-LIVE-02). */
  timezone: string;
  /** True when `PULSE_ESTATE_TZ` was absent/invalid and UTC was substituted (REQ-LIVE-02). */
  tzFallback: boolean;
  /** `PULSE_GRAFANA_URL` origin (no trailing slash), or `null` when unset (deep links disabled, §6.3). */
  grafanaOrigin: string | null;
  /** Gatus evaluation-freshness threshold in seconds; defaults to `GATUS_STALE_SECONDS_DEFAULT` (300). */
  gatusStaleSeconds: number;
}

/**
 * Resolve one target's `TargetStatus` from the §3.5 matrix. Pure; total over every input combination.
 *
 * @param p.suppressed - True when the target carries a suppression mark (renders `suppressed`, wins).
 * @param p.alertsAvailable - `sourceData.alerts.health.ok`; when false, colour is undeterminable → unknown.
 * @param p.alerts - This target's matched alerts (incl. `info`); highest crit/warn severity colours.
 * @param p.live - Affirmative-liveness signal: `true`=alive, `false`=down/absent, `null`=source down.
 */
export function resolveStatus(p: {
  suppressed: boolean;
  alertsAvailable: boolean;
  alerts: ActiveAlert[];
  live: boolean | null;
}): TargetStatus {
  if (p.suppressed) return "suppressed";
  if (!p.alertsAvailable) return "unknown";

  // Highest colouring severity among matched alerts (`info` cannot colour).
  let worst = -1;
  for (const a of p.alerts) {
    const rank = SEVERITY_ORDER.indexOf(a.severity); // ["info","warning","critical"]
    if (rank > worst) worst = rank;
  }
  if (worst === SEVERITY_ORDER.indexOf("critical")) return "critical";
  if (worst === SEVERITY_ORDER.indexOf("warning")) return "warning";

  // No colouring alert → green ONLY with an affirmative liveness signal (REQ-STATE-05).
  return p.live === true ? "ok" : "unknown";
}

/** Build one `ServiceStatus` (§2.4). */
function buildService(
  service: WebEstateService,
  data: SourceData,
  now: Date,
  cfg: BuildConfig,
  matchedAlerts: ReturnType<typeof matchAlerts>,
  matchedChecks: ReturnType<typeof matchChecks>,
): ServiceStatus {
  const key = serviceKey(service.host, service.name);
  const activeAlerts = matchedAlerts.byService.get(key) ?? [];
  const checks = matchedChecks.byService.get(key) ?? [];
  const live = evaluateServiceLiveness(service, data, now, cfg);
  const suppressed = service.suppressed
    ? { class: service.suppressed.class, rationale: service.suppressed.rationale }
    : null;
  const status = resolveStatus({
    suppressed: suppressed !== null,
    alertsAvailable: data.alerts.health.ok,
    alerts: activeAlerts,
    live,
  });
  return {
    name: service.name,
    host: service.host,
    managed: service.managed,
    deepHealth: service.deepHealth,
    ...(service.ingressUrl !== undefined ? { ingressUrl: service.ingressUrl } : {}),
    drilldownId: service.drilldownId,
    suppressed,
    status,
    statusEvidence: {
      status,
      availability: availability(
        service.deepHealth ? data.liveness.health : data.checks.health,
        service.deepHealth ? "victoriametrics-signals" : "gatus-statuses",
      ),
    },
    live,
    activeAlerts,
    checks,
    grafana: serviceGrafanaLink(service, data.liveness.series, cfg),
  };
}

/** Build one `HostStatus` including its services and roll-up (§2.3, §7). */
function buildHost(
  host: WebEstateHost,
  model: WebEstateModel,
  data: SourceData,
  now: Date,
  cfg: BuildConfig,
  matchedAlerts: ReturnType<typeof matchAlerts>,
  matchedChecks: ReturnType<typeof matchChecks>,
): HostStatus {
  const services = model.services
    .filter((s) => s.host === host.name)
    .map((s) => buildService(s, data, now, cfg, matchedAlerts, matchedChecks));

  const activeAlerts = matchedAlerts.byHost.get(host.name) ?? [];
  const checks = matchedChecks.byHost.get(host.name) ?? [];
  const live = evaluateHostLiveness(host, data, now, cfg);
  const suppressed = host.suppressed
    ? { class: host.suppressed.class, rationale: host.suppressed.rationale }
    : null;
  const status = resolveStatus({
    suppressed: suppressed !== null,
    alertsAvailable: data.alerts.health.ok,
    alerts: activeAlerts,
    live,
  });

  // Roll-up: worst of own status + NON-suppressed services (REQ-GRID-03). Suppressed services stay
  // in the list but contribute nothing to the cell colour (charter inv. 6).
  const contributingServices = services.filter((s) => s.suppressed === null);
  const contributing = contributingServices.map((s) => s.status);
  const rolled = rollup(status, contributing);
  const ownAvailability = availability(
    host.collectionClass === "probe-only" ? data.checks.health : data.liveness.health,
    host.collectionClass === "probe-only" ? "gatus-statuses" : "victoriametrics-signals",
  );
  const rollupAvailability = contributingServices.find(
    (service) => service.statusEvidence.availability.state !== "current",
  )?.statusEvidence.availability ?? ownAvailability;

  return {
    name: host.name,
    collectionClass: host.collectionClass,
    addresses: host.addresses,
    drilldownId: host.drilldownId,
    suppressed,
    status,
    statusEvidence: { status, availability: ownAvailability },
    rollup: rolled,
    rollupEvidence: { status: rolled, availability: rollupAvailability },
    live,
    activeAlerts,
    checks,
    grafana: hostGrafanaLink(host, data.liveness.series, cfg),
    services,
  };
}

/** Strip content: matched + unattributed alerts, severity-then-recency ordered (§8). */
function buildStrip(matchedAlerts: ReturnType<typeof matchAlerts>): ActiveAlert[] {
  return [...matchedAlerts.all].sort((a, b) => {
    const sev = SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity); // crit → info
    if (sev !== 0) return sev;
    return Date.parse(b.startsAt) - Date.parse(a.startsAt); // newer first
  });
}

/**
 * Fold the estate model and the three parsed source outputs into one `OverviewSnapshot`. Pure: no
 * I/O, no clock read (uses `now`), no env read (uses `cfg`). Deterministic for a fixed input tuple.
 *
 * @param model - The loaded, validated web estate model (the SOLE source of grid membership, REQ-GRID-01).
 * @param sourceData - Parsed VM/AM/Gatus outputs + per-source health.
 * @param now - The snapshot generation instant; stamps `generatedAt` and anchors Gatus freshness.
 * @param cfg - Config-derived scalars (version, timezone, Grafana origin, Gatus threshold).
 */
export function buildSnapshot(
  model: WebEstateModel,
  sourceData: SourceData,
  now: Date,
  cfg: BuildConfig,
): OverviewSnapshot {
  const matchedAlerts = matchAlerts(model, sourceData.alerts.active);
  const matchedChecks = matchChecks(model, sourceData.checks.endpoints);

  const hosts: HostStatus[] = model.hosts.map((host) =>
    buildHost(host, model, sourceData, now, cfg, matchedAlerts, matchedChecks),
  );

  return {
    appVersion: cfg.appVersion,
    generatedAt: now.toISOString(),
    estate: { name: model.estate.name, timezone: cfg.timezone, tzFallback: cfg.tzFallback },
    sources: {
      metrics: sourceData.liveness.health,
      alerts: sourceData.alerts.health,
      checks: sourceData.checks.health,
    },
    hosts,
    alerts: buildStrip(matchedAlerts),
    signals: [],
    recentChecks: [],
    engine: {
      availability: availability(sourceData.liveness.health, "victoriametrics-signals"),
      value: sourceData.liveness.health.ok && sourceData.alerts.health.ok && sourceData.checks.health.ok
        ? { ok: true }
        : null,
    },
    alertCounts: {
      firing: sourceData.alerts.active.length,
      silenced: 0,
      inhibited: 0,
    },
    coverage: {
      availability: {
        state: "not-configured",
        source: "rendered-estate",
        lastGoodAt: null,
        message: "Coverage is unavailable in the compatibility snapshot builder.",
      },
      value: null,
    },
  };
}

/** Re-exports for consumers that import the snapshot fold's helpers (server tier, tests). */
export { matchAlerts, matchChecks } from "./match.js";
export { evaluateHostLiveness, evaluateServiceLiveness, isFresh } from "./liveness.js";
export { hostGrafanaLink, serviceGrafanaLink } from "./links.js";
