// apps/web/tests/fixtures/overview/factory.ts — deterministic overview snapshot fixtures
// (08-testing-strategy.md §3). Every builder returns a fully typed current wire
// `OverviewSnapshotV2` from `@pulse/web-data/wire` (no parallel local interface) that passes
// `validateOverviewSnapshotV2`.
//
// Determinism rules: no random source, no current time, no locale-dependent names, no UUIDs
// and no I/O. Identities (names, drilldown ids, fingerprints, Grafana UIDs) derive only from
// target indices and `OVERVIEW_FIXTURE_SEED`. Per-target content is cycle-independent, so an
// unchanged target deep-equals itself across cycles; `cycle` advances only the snapshot-level
// timestamps (`generatedAt`, body source `lastSuccess`, engine/coverage `lastGoodAt`).

import type {
  CheckSummary,
  DataAvailability,
  HistoryPayload,
  HostStatus,
  LiveSignal,
  OverviewAlertSummary,
  OverviewCheckResult,
  OverviewSnapshotV2,
  ServiceStatus,
  SourceHealthCompat,
  TargetIdentity,
  TargetStatus,
} from "@pulse/web-data/wire";
import { CORE_CADENCE_MS } from "@pulse/web-data/wire";
import { ROLLUP_ORDER, rollup } from "../../../src/shared/status.js";

export const OVERVIEW_FIXTURE_SEED = 0x50_55_4c_53 as const;
export const ENVELOPE_HOST_COUNT = 100 as const;
export const ENVELOPE_SERVICE_COUNT = 300 as const;

/** Renderer collection class accepted by `HostStatus`. */
export type FixtureCollectionClass = HostStatus["collectionClass"];

export interface OverviewFixtureOptions {
  /** Number of hosts to generate; default `4`. */
  readonly hostCount?: number;
  /** Total services distributed deterministically across hosts; default `hostCount * 3`. */
  readonly serviceCount?: number;
  /** Deterministic refresh cycle used to advance fixture timestamps; default `1`. */
  readonly cycle?: number;
  /** Repeating status sequence; default includes all five target statuses. */
  readonly statuses?: readonly TargetStatus[];
  /** Evidence copied to generated target sections; default is fixed current evidence. */
  readonly availability?: DataAvailability;
  /** Whether coverage has a value; default `true`. */
  readonly includeCoverage?: boolean;
  /** Repeating collection-class sequence over hosts; default the four monitored classes. */
  readonly classes?: readonly FixtureCollectionClass[];
  /** Number of trailing hosts generated with no services; default `0`. */
  readonly zeroServiceHosts?: number;
  /** Per-drilldownId evidence overriding `availability` for exactly those targets. */
  readonly targetAvailability?: Readonly<Record<string, DataAvailability>>;
  /** Liveness forced onto every target; default derives from status (critical → false, unknown/suppressed → null). */
  readonly live?: boolean | null;
  /** Whether warning/critical targets carry attributed firing alerts plus one unattributed info alert; default `true`. */
  readonly alerts?: boolean;
  /** Whether hosts and even-indexed services carry a Grafana board; default `true`. */
  readonly grafana?: boolean;
  /** Whether per-target live signals are generated; default `true`. */
  readonly signals?: boolean;
  /** Whether first services carry checks and recent check summaries; default `true`. */
  readonly checks?: boolean;
  /** Whether the engine summary has a value; default `true`. */
  readonly engineAvailable?: boolean;
}

/** The five target statuses in the default repeating sequence. */
export const FIXTURE_STATUS_SEQUENCE: readonly TargetStatus[] = ["ok", "warning", "critical", "unknown", "suppressed"];
/** Default repeating host collection classes. */
export const FIXTURE_CLASS_SEQUENCE: readonly FixtureCollectionClass[] = [
  "managed-linux", "hypervisor-api", "nas-api", "probe-only",
];
/** Fixed first-cycle instant; later cycles advance by `CORE_CADENCE_MS`. */
export const FIXTURE_EPOCH = "2026-09-01T12:00:00.000Z" as const;
/** Fixed estate name/timezone for every fixture. */
export const FIXTURE_ESTATE = { name: "fixture-estate", timezone: "UTC", tzFallback: false } as const;
/** Fixed Grafana origin for resolved board URLs. */
export const FIXTURE_GRAFANA_ORIGIN = "https://grafana.example.test" as const;
/** Deterministic service names; a host with more services appends `-<n>`. */
const SERVICE_NAMES = ["api", "db", "cache", "proxy", "queue", "worker"] as const;
/** Fixed silenced/inhibited counts reported beside the firing count. */
const SILENCED_COUNT = 2;
const INHIBITED_COUNT = 1;
const COVERAGE_GAPS = 2;
const COVERAGE_EXTRAS = 1;

const EPOCH_MS = Date.parse(FIXTURE_EPOCH);

/** ISO instant for `cycle` (cycle 1 is `FIXTURE_EPOCH`). */
export function cycleInstant(cycle: number): string {
  return new Date(EPOCH_MS + (cycle - 1) * CORE_CADENCE_MS).toISOString();
}

/** ISO instant `minutes` before `FIXTURE_EPOCH`. */
function minutesBeforeEpoch(minutes: number): string {
  return new Date(EPOCH_MS - minutes * 60_000).toISOString();
}

/** Stable seeded FNV-1a (32-bit) hex digest; two rounds give a 16-hex fingerprint. */
function fingerprint(text: string): string {
  let a = OVERVIEW_FIXTURE_SEED >>> 0;
  let b = (OVERVIEW_FIXTURE_SEED ^ 0x9e37_79b9) >>> 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x0100_0193) >>> 0;
    b = Math.imul(b ^ code, 0x0100_0193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/** Zero-padded host name for index `i` (`host-001`, …). */
export function fixtureHostName(i: number): string {
  return `host-${String(i + 1).padStart(3, "0")}`;
}

/** Host drilldown id for index `i`. */
export function fixtureHostId(i: number): string {
  return `host:${fixtureHostName(i)}`;
}

/** Service name for the `local`-th service on a host. */
export function fixtureServiceName(local: number): string {
  const base = SERVICE_NAMES[local % SERVICE_NAMES.length]!;
  const round = Math.floor(local / SERVICE_NAMES.length);
  return round === 0 ? base : `${base}-${round}`;
}

/** Service drilldown id for host index `i` and local service index `local`. */
export function fixtureServiceId(i: number, local: number): string {
  return `svc:${fixtureHostName(i)}/${fixtureServiceName(local)}`;
}

function currentEvidence(source: DataAvailability["source"]): DataAvailability {
  return { state: "current", source, lastGoodAt: FIXTURE_EPOCH, message: null };
}

/**
 * Status of the `local`-th service on a host whose own status is `host`, given the sequence
 * candidate `candidate`. The first service mirrors the host; later services take the candidate
 * unless it is more severe than the host (then they mirror the host). Every service on a
 * suppressed host is suppressed. Hence each host's rollup equals its own status, while the
 * default envelope still carries every status on both hosts and services.
 */
function serviceStatusFor(host: TargetStatus, candidate: TargetStatus, local: number): TargetStatus {
  if (local === 0 || host === "suppressed") return host;
  if (candidate === "suppressed") return candidate;
  return ROLLUP_ORDER.indexOf(candidate) > ROLLUP_ORDER.indexOf(host) ? host : candidate;
}

function derivedLive(status: TargetStatus): boolean | null {
  if (status === "critical") return false;
  if (status === "unknown" || status === "suppressed") return null;
  return true;
}

function suppression(name: string, status: TargetStatus): ServiceStatus["suppressed"] {
  return status === "suppressed"
    ? { class: "maintenance", rationale: `${name} is deliberately suppressed for planned maintenance.` }
    : null;
}

function firingAlert(target: TargetIdentity, label: string, status: TargetStatus, order: number): OverviewAlertSummary | null {
  if (status !== "critical" && status !== "warning") return null;
  const name = target.kind === "host"
    ? (status === "critical" ? "HostDown" : "HostHighLoad")
    : (status === "critical" ? "ServiceDown" : "ServiceDegraded");
  return {
    fingerprint: fingerprint(`${target.kind}:${target.id}:${name}`),
    name,
    severity: status,
    startsAt: minutesBeforeEpoch(order + 1),
    target,
    summary: `${name} on ${label}`,
  };
}

const AVAILABILITY_RANK: Readonly<Record<DataAvailability["state"], number>> = {
  current: 0, "not-configured": 1, stale: 2, unavailable: 3,
};

/** First evidence with the least-current state (stable on ties). */
function worstAvailability(evidence: readonly DataAvailability[]): DataAvailability {
  let worst = evidence[0]!;
  for (const item of evidence) {
    if (AVAILABILITY_RANK[item.state] > AVAILABILITY_RANK[worst.state]) worst = item;
  }
  return worst;
}

/** Recompute a host's rollup/rollupEvidence from its own and its services' evidence. */
function withRollup(host: Omit<HostStatus, "rollup" | "rollupEvidence"> & Partial<Pick<HostStatus, "rollup" | "rollupEvidence">>): HostStatus {
  const status = rollup(host.status, host.services.map((service) => service.status));
  const contributing = [
    host.statusEvidence.availability,
    ...host.services.filter((service) => service.status !== "suppressed").map((service) => service.statusEvidence.availability),
  ];
  return {
    name: host.name,
    collectionClass: host.collectionClass,
    addresses: host.addresses,
    drilldownId: host.drilldownId,
    suppressed: host.suppressed,
    status: host.status,
    statusEvidence: host.statusEvidence,
    rollup: status,
    rollupEvidence: { status, availability: worstAvailability(contributing) },
    live: host.live,
    activeAlerts: host.activeAlerts,
    checks: host.checks,
    grafana: host.grafana,
    services: host.services,
  };
}

/** Services per host: trailing `zeroServiceHosts` get none, the rest share `serviceCount` evenly (earlier hosts take the remainder). */
function serviceDistribution(hostCount: number, serviceCount: number, zeroServiceHosts: number): number[] {
  const eligible = Math.max(0, hostCount - zeroServiceHosts);
  return Array.from({ length: hostCount }, (_, i) => {
    if (i >= eligible) return 0;
    return Math.floor(serviceCount / eligible) + (i < serviceCount % eligible ? 1 : 0);
  });
}

function cycleSourceHealth(cycle: number): SourceHealthCompat {
  return { ok: true, lastSuccess: cycleInstant(cycle), error: null };
}

/** Build stable ids, names, timestamps, classes, signals, checks, and alert attribution. */
export function makeOverviewSnapshot(options: OverviewFixtureOptions = {}): OverviewSnapshotV2 {
  const hostCount = options.hostCount ?? 4;
  const serviceCount = options.serviceCount ?? hostCount * 3;
  const cycle = options.cycle ?? 1;
  const statuses = options.statuses ?? FIXTURE_STATUS_SEQUENCE;
  const classes = options.classes ?? FIXTURE_CLASS_SEQUENCE;
  const withAlerts = options.alerts ?? true;
  const withGrafana = options.grafana ?? true;
  const withSignals = options.signals ?? true;
  const withChecks = options.checks ?? true;
  const includeCoverage = options.includeCoverage ?? true;
  const engineAvailable = options.engineAvailable ?? true;
  if (statuses.length === 0) throw new Error("statuses must not be empty");
  if (classes.length === 0) throw new Error("classes must not be empty");

  const evidenceFor = (id: string, source: DataAvailability["source"]): DataAvailability =>
    options.targetAvailability?.[id] ?? options.availability ?? currentEvidence(source);
  const liveFor = (status: TargetStatus): boolean | null =>
    options.live !== undefined ? options.live : derivedLive(status);

  const perHost = serviceDistribution(hostCount, serviceCount, options.zeroServiceHosts ?? 0);
  const alerts: OverviewAlertSummary[] = [];
  const signals: LiveSignal[] = [];
  const recentChecks: CheckSummary[] = [];
  let globalService = 0;

  const hosts: HostStatus[] = [];
  for (let i = 0; i < hostCount; i++) {
    const hostName = fixtureHostName(i);
    const hostId = fixtureHostId(i);
    const hostTarget: TargetIdentity = { kind: "host", id: hostId };
    const hostStatus = statuses[i % statuses.length]!;
    const hostEvidence = evidenceFor(hostId, "victoriametrics-signals");
    const hostLive = liveFor(hostStatus);
    const hostAlert = withAlerts ? firingAlert(hostTarget, hostName, hostStatus, alerts.length) : null;
    if (hostAlert !== null) alerts.push(hostAlert);
    if (withSignals) {
      signals.push({
        target: hostTarget, id: "cpu.utilization", label: "CPU utilization", unit: "percent",
        value: hostLive === null ? null : (i * 7) % 100, availability: hostEvidence,
      });
    }

    const services: ServiceStatus[] = [];
    for (let local = 0; local < perHost[i]!; local++, globalService++) {
      const name = fixtureServiceName(local);
      const id = fixtureServiceId(i, local);
      const target: TargetIdentity = { kind: "service", id };
      const status = serviceStatusFor(hostStatus, statuses[(i + local) % statuses.length]!, local);
      const evidence = evidenceFor(id, "victoriametrics-targets");
      const live = liveFor(status);
      const alert = withAlerts ? firingAlert(target, `${hostName}/${name}`, status, alerts.length) : null;
      if (alert !== null) alerts.push(alert);
      const endpoint = `${hostName}/${name}`;
      const hasCheck = withChecks && local === 0;
      const checks: OverviewCheckResult[] = hasCheck
        ? [{ endpoint, success: status !== "critical", lastEvaluatedAt: FIXTURE_EPOCH, responseTimeMs: 10 + (globalService % 90) }]
        : [];
      if (hasCheck) {
        recentChecks.push(
          { target, endpoint, success: status !== "critical", observedAt: minutesBeforeEpoch(1), durationMs: 10 + (globalService % 90) },
          { target, endpoint, success: true, observedAt: FIXTURE_EPOCH, durationMs: 12 },
        );
      }
      if (withSignals) {
        signals.push({ target, id: "service.up", label: "Service up", unit: "state", value: live, availability: evidence });
      }
      services.push({
        name,
        host: hostName,
        managed: local % 2 === 0,
        deepHealth: local === 0,
        drilldownId: id,
        suppressed: suppression(name, status),
        status,
        statusEvidence: { status, availability: evidence },
        live,
        activeAlerts: alert === null ? [] : [alert],
        checks,
        grafana: withGrafana && local % 2 === 0
          ? { boardUid: `pulse-${hostName}-${name}`, url: `${FIXTURE_GRAFANA_ORIGIN}/d/pulse-${hostName}-${name}` }
          : null,
      });
    }

    hosts.push(withRollup({
      name: hostName,
      collectionClass: classes[i % classes.length]!,
      addresses: [`10.0.${Math.floor(i / 250)}.${(i % 250) + 1}`],
      drilldownId: hostId,
      suppressed: suppression(hostName, hostStatus),
      status: hostStatus,
      statusEvidence: { status: hostStatus, availability: hostEvidence },
      live: hostLive,
      activeAlerts: hostAlert === null ? [] : [hostAlert],
      checks: [],
      grafana: withGrafana ? { boardUid: `pulse-${hostName}`, url: `${FIXTURE_GRAFANA_ORIGIN}/d/pulse-${hostName}` } : null,
      services,
    }));
  }

  if (withAlerts) {
    alerts.push({
      fingerprint: fingerprint("unattributed:WatchdogInfo"),
      name: "WatchdogInfo",
      severity: "info",
      startsAt: minutesBeforeEpoch(alerts.length + 1),
      target: null,
    });
  }
  if (withChecks) {
    // One endpoint check whose attribution and outcome are unavailable.
    recentChecks.push({ target: null, endpoint: "external/unattributed", success: null, observedAt: null, durationMs: null });
  }

  const at = cycleInstant(cycle);
  const targetTotal = hosts.length + globalService;
  return {
    appVersion: "0.0.0-fixture",
    generatedAt: at,
    estate: { ...FIXTURE_ESTATE },
    sources: { metrics: cycleSourceHealth(cycle), alerts: cycleSourceHealth(cycle), checks: cycleSourceHealth(cycle) },
    hosts,
    alerts,
    signals,
    recentChecks,
    engine: engineAvailable
      ? { availability: { state: "current", source: "victoriametrics-buildinfo", lastGoodAt: at, message: null }, value: { ok: true } }
      : { availability: { state: "unavailable", source: "victoriametrics-buildinfo", lastGoodAt: null, message: "Engine health is unavailable." }, value: null },
    alertCounts: { firing: alerts.length, silenced: SILENCED_COUNT, inhibited: INHIBITED_COUNT },
    coverage: includeCoverage
      ? {
          availability: { state: "current", source: "rendered-estate", lastGoodAt: at, message: null },
          value: { covered: Math.max(0, targetTotal - COVERAGE_GAPS), gaps: Math.min(COVERAGE_GAPS, targetTotal), extras: COVERAGE_EXTRAS },
        }
      : { availability: { state: "unavailable", source: "rendered-estate", lastGoodAt: null, message: "Coverage comparison is unavailable." }, value: null },
  };
}

/** Exactly 100 hosts and 300 services; every status appears and identities are stable. */
export function makeEnvelopeOverviewSnapshot(cycle = 1): OverviewSnapshotV2 {
  return makeOverviewSnapshot({ hostCount: ENVELOPE_HOST_COUNT, serviceCount: ENVELOPE_SERVICE_COUNT, cycle });
}

function restatus<T extends HostStatus | ServiceStatus>(target: T, name: string, status: TargetStatus): T {
  return {
    ...target,
    suppressed: status === "suppressed" ? (target.suppressed ?? suppression(name, status)) : null,
    status,
    statusEvidence: { ...target.statusEvidence, status },
  };
}

/**
 * Clone one cycle while changing only the named canonical target's effective status.
 * Snapshot-level cycle timestamps move to `cycle`; the target's `status`, `statusEvidence.status`
 * and matching suppression declaration change, and its host's derived rollup is recomputed. Every
 * other host/service object is carried over by reference. Throws when `drilldownId` is unknown.
 */
export function withTargetStatus(
  snapshot: OverviewSnapshotV2,
  drilldownId: string,
  status: TargetStatus,
  cycle: number,
): OverviewSnapshotV2 {
  let found = false;
  const hosts = snapshot.hosts.map((host) => {
    if (host.drilldownId === drilldownId) {
      found = true;
      return withRollup(restatus(host, host.name, status));
    }
    const index = host.services.findIndex((service) => service.drilldownId === drilldownId);
    if (index === -1) return host;
    found = true;
    const services = host.services.map((service, i) => (i === index ? restatus(service, service.name, status) : service));
    return withRollup({ ...host, services });
  });
  if (!found) throw new Error(`withTargetStatus: no target with drilldownId ${drilldownId}`);
  const at = cycleInstant(cycle);
  const stamp = (health: SourceHealthCompat): SourceHealthCompat => (health.ok ? { ...health, lastSuccess: at } : health);
  const restamp = <S extends OverviewSnapshotV2["engine"] | OverviewSnapshotV2["coverage"]>(section: S): S =>
    section.availability.state === "current" ? { ...section, availability: { ...section.availability, lastGoodAt: at } } : section;
  return {
    ...snapshot,
    generatedAt: at,
    sources: { metrics: stamp(snapshot.sources.metrics), alerts: stamp(snapshot.sources.alerts), checks: stamp(snapshot.sources.checks) },
    hosts,
    engine: restamp(snapshot.engine),
    coverage: restamp(snapshot.coverage),
  };
}

export interface LivenessHistoryOptions {
  /** Number of one-minute points; default `60`. */
  readonly pointCount?: number;
  /** Every n-th point (1-based) is a `null` gap; default `0` (no gaps). */
  readonly nullEvery?: number;
  /** Whether the payload is marked stale; default `false`. */
  readonly stale?: boolean;
}

/** One-hour `estate.liveness` history for `target` with selectable nullable samples. */
export function makeLivenessHistoryPayload(target: TargetIdentity, options: LivenessHistoryOptions = {}): HistoryPayload {
  const pointCount = options.pointCount ?? 60;
  const nullEvery = options.nullEvery ?? 0;
  const start = EPOCH_MS - pointCount * 60_000;
  const points = Array.from({ length: pointCount }, (_, i): readonly [number, number | null] => [
    start + (i + 1) * 60_000,
    nullEvery > 0 && (i + 1) % nullEvery === 0 ? null : (i % 7 === 3 ? 0 : 1),
  ]);
  return {
    queryId: "estate.liveness",
    target,
    range: "1h",
    fetchedAt: FIXTURE_EPOCH,
    effectiveStepSeconds: 60,
    unit: "state",
    stale: options.stale ?? false,
    series: [{ labels: { target: target.id }, points }],
  };
}
