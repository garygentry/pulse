// selectors.ts — the sole builder of `OverviewModel`, plus pure stats, firing-ribbon and drawer
// helpers. Pure module: no React components, no store, no storage, no clock, no DOM. It never
// mutates the snapshot or a previous model. Canonical identity is `TargetIdentity.id` /
// `drilldownId` only — never a display name. Status grouping, sorting and counting go through
// `effectiveStatus` so nominal health with non-current evidence is never treated as healthy.
import type {
  CheckSummary,
  DataAvailability,
  HostStatus,
  OverviewAlertSummary,
  OverviewSnapshotV2,
  ServiceStatus,
  TargetIdentity,
  TargetStatus,
  TargetStatusEvidence,
} from "@pulse/web-data/wire";
import type { TimelineLane, TimelineSegment } from "@/ui";
import { STATUS_LABEL } from "../../a11y/index.js";
import { effectiveStatus } from "./freshness.js";
import {
  KIOSK_ALERT_NAME_LIMIT,
  OVERVIEW_COLLATOR,
  OVERVIEW_STATUS_ORDER,
  type AlertSeverityCounts,
  type CoverageStat,
  type EngineOkStat,
  type GroupMode,
  type KioskFiringSummary,
  type OverviewGroup,
  type OverviewModel,
  type OverviewPreferencesV1,
  type OverviewStats,
  type OverviewTarget,
  type SortMode,
  type StatusCounts,
  type TargetDrawerModel,
} from "./model.js";

/** Visible copy when coverage has no value and the availability carries no message. */
export const COVERAGE_UNAVAILABLE_MESSAGE = "Coverage unavailable.";

/** Visible kiosk name for an alert whose name is missing (a protocol defect). */
export const UNNAMED_ALERT = "Unnamed alert";

// ---------------------------------------------------------------------------------------------
// Content keys (structural sharing aids; process-local, never persisted or exposed as identity)
// ---------------------------------------------------------------------------------------------

type Projection = readonly unknown[];

function availabilityProjection(a: DataAvailability): Projection {
  return [a.state, a.source, a.lastGoodAt, a.message];
}

function evidenceProjection(e: TargetStatusEvidence): Projection {
  return [e.status, availabilityProjection(e.availability)];
}

function identityProjection(t: TargetIdentity | null): Projection | null {
  return t === null ? null : [t.kind, t.id];
}

function alertProjection(a: OverviewAlertSummary): Projection {
  return [
    a.fingerprint,
    a.name,
    a.severity,
    a.startsAt,
    identityProjection(a.target),
    a.summary ?? null,
    // The ack marker is material: without it a newly acked alert would reuse the prior reference.
    ...(a.acked === true ? [true] : []),
  ];
}

function checkProjection(c: HostStatus["checks"][number]): Projection {
  return [c.endpoint, c.success, c.lastEvaluatedAt, c.responseTimeMs ?? null];
}

function suppressionProjection(s: HostStatus["suppressed"]): Projection | null {
  return s === null ? null : [s.class, s.rationale];
}

function grafanaProjection(g: HostStatus["grafana"]): Projection | null {
  return g === null ? null : [g.boardUid, g.url];
}

const serviceKeys = new WeakMap<ServiceStatus, string>();
const hostOwnKeys = new WeakMap<HostStatus, string>();
const alertKeys = new WeakMap<OverviewAlertSummary, string>();

/** Explicit semantic projection of every service field in wire declaration order. */
function serviceContentKey(service: ServiceStatus): string {
  const cached = serviceKeys.get(service);
  if (cached !== undefined) return cached;
  const key = JSON.stringify([
    service.name,
    service.host,
    service.managed,
    service.deepHealth,
    service.ingressUrl ?? null,
    service.drilldownId,
    suppressionProjection(service.suppressed),
    service.status,
    evidenceProjection(service.statusEvidence),
    service.live,
    service.activeAlerts.map(alertProjection),
    service.checks.map(checkProjection),
    grafanaProjection(service.grafana),
  ]);
  serviceKeys.set(service, key);
  return key;
}

/** Every host field except `services`, in wire declaration order. */
function hostOwnContentKey(host: HostStatus): string {
  const cached = hostOwnKeys.get(host);
  if (cached !== undefined) return cached;
  const key = JSON.stringify([
    host.name,
    host.collectionClass,
    host.addresses,
    host.drilldownId,
    suppressionProjection(host.suppressed),
    host.status,
    evidenceProjection(host.statusEvidence),
    host.rollup,
    evidenceProjection(host.rollupEvidence),
    host.live,
    host.activeAlerts.map(alertProjection),
    host.checks.map(checkProjection),
    grafanaProjection(host.grafana),
  ]);
  hostOwnKeys.set(host, key);
  return key;
}

function alertContentKey(alert: OverviewAlertSummary): string {
  const cached = alertKeys.get(alert);
  if (cached !== undefined) return cached;
  const key = JSON.stringify(alertProjection(alert));
  alertKeys.set(alert, key);
  return key;
}

/**
 * Produce a deterministic content key for host-level structural sharing: all host fields and
 * all nested service fields in wire order. Process-local; never persisted or used as identity.
 */
export function hostContentKey(host: HostStatus): string {
  return JSON.stringify([hostOwnContentKey(host), host.services.map(serviceContentKey)]);
}

// ---------------------------------------------------------------------------------------------
// Canonical target resolution
// ---------------------------------------------------------------------------------------------

function hostTarget(host: HostStatus): OverviewTarget {
  return {
    identity: { kind: "host", id: host.drilldownId },
    drilldownId: host.drilldownId,
    kind: "host",
    host,
    service: null,
  };
}

function serviceTarget(host: HostStatus, service: ServiceStatus): OverviewTarget {
  return {
    identity: { kind: "service", id: service.drilldownId },
    drilldownId: service.drilldownId,
    kind: "service",
    host,
    service,
  };
}

/**
 * Resolve exactly one host or service by its exact drilldown id. Empty, ambiguous (the id
 * occurs more than once across hosts and services) or absent identities return null.
 */
export function resolveOverviewTarget(snapshot: OverviewSnapshotV2, drilldownId: string): OverviewTarget | null {
  if (drilldownId === "") return null;
  let found: OverviewTarget | null = null;
  let occurrences = 0;
  for (const host of snapshot.hosts) {
    if (host.drilldownId === drilldownId) {
      occurrences++;
      found = hostTarget(host);
    }
    for (const service of host.services) {
      if (service.drilldownId === drilldownId) {
        occurrences++;
        found = serviceTarget(host, service);
      }
    }
  }
  return occurrences === 1 ? found : null;
}

// ---------------------------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------------------------

type MutableCounts<T> = { -readonly [K in keyof T]: T[K] };

function emptyStatusCounts(): MutableCounts<StatusCounts> {
  return { ok: 0, warning: 0, critical: 0, unknown: 0, suppressed: 0 };
}

function severityCounts(alerts: readonly OverviewAlertSummary[]): AlertSeverityCounts {
  const counts: MutableCounts<AlertSeverityCounts> = { critical: 0, warning: 0, info: 0 };
  for (const alert of alerts) {
    if (alert.severity === "critical" || alert.severity === "warning" || alert.severity === "info") {
      counts[alert.severity]++;
    }
  }
  return counts;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function coverageStat(section: OverviewSnapshotV2["coverage"]): CoverageStat {
  const { availability, value } = section;
  if (value !== null && isCount(value.covered) && isCount(value.gaps) && isCount(value.extras)) {
    return { status: "available", covered: value.covered, gaps: value.gaps, extras: value.extras, availability };
  }
  return { status: "unavailable", availability, message: availability.message ?? COVERAGE_UNAVAILABLE_MESSAGE };
}

function engineStat(section: OverviewSnapshotV2["engine"]): EngineOkStat {
  const { availability, value } = section;
  if (value !== null && typeof value.ok === "boolean") {
    return { status: "available", ok: value.ok, availability };
  }
  return { status: "unavailable", availability };
}

/**
 * Derive estate-wide counts from the same snapshot the grid renders: hosts by effective rollup
 * status, services by effective status, firing by severity from `snapshot.alerts`, silenced and
 * inhibited copied from `alertCounts`, and explicit unavailable coverage/engine members.
 */
export function deriveOverviewStats(snapshot: OverviewSnapshotV2): OverviewStats {
  const hosts = emptyStatusCounts();
  const services = emptyStatusCounts();
  for (const host of snapshot.hosts) {
    hosts[effectiveStatus(host.rollupEvidence)]++;
    for (const service of host.services) {
      services[effectiveStatus(service.statusEvidence)]++;
    }
  }
  return {
    hosts,
    services,
    firing: severityCounts(snapshot.alerts),
    silenced: snapshot.alertCounts.silenced,
    inhibited: snapshot.alertCounts.inhibited,
    coverage: coverageStat(snapshot.coverage),
    engine: engineStat(snapshot.engine),
  };
}

// ---------------------------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------------------------

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Collator, then Unicode code-unit order. */
function textCompare(left: string, right: string): number {
  return OVERVIEW_COLLATOR.compare(left, right) || codeUnitCompare(left, right);
}

function statusRank(status: TargetStatus): number {
  const index = OVERVIEW_STATUS_ORDER.indexOf(status);
  return index === -1 ? OVERVIEW_STATUS_ORDER.length : index;
}

function hostComparator(sortBy: SortMode, rank: ReadonlyMap<HostStatus, number>) {
  const byName = (a: HostStatus, b: HostStatus): number =>
    textCompare(a.name, b.name) || codeUnitCompare(a.drilldownId, b.drilldownId);
  const byStatus = (a: HostStatus, b: HostStatus): number => rank.get(a)! - rank.get(b)!;
  switch (sortBy) {
    case "class":
      return (a: HostStatus, b: HostStatus): number =>
        textCompare(a.collectionClass, b.collectionClass) || byStatus(a, b) || byName(a, b);
    case "status":
      return (a: HostStatus, b: HostStatus): number => byStatus(a, b) || byName(a, b);
    case "name":
      return byName;
  }
}

interface GroupDraft {
  readonly id: string;
  readonly label: string;
  /** Primary group-order key. */
  readonly order: number;
  /** Secondary group-order text (class value or host name). */
  readonly text: string;
  readonly hosts: HostStatus[];
}

function groupDraftFor(groupBy: GroupMode, host: HostStatus, status: TargetStatus): Omit<GroupDraft, "hosts"> {
  switch (groupBy) {
    case "class":
      return { id: `class:${host.collectionClass}`, label: host.collectionClass, order: 0, text: host.collectionClass };
    case "status":
      return { id: `status:${status}`, label: STATUS_LABEL[status], order: statusRank(status), text: "" };
    case "name":
      return { id: `name:${host.drilldownId}`, label: host.name, order: 0, text: host.name };
  }
}

function compareGroupDrafts(a: GroupDraft, b: GroupDraft): number {
  return a.order - b.order || textCompare(a.text, b.text) || codeUnitCompare(a.id, b.id);
}

function sameElements<T>(left: readonly T[], right: readonly T[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function buildGroups(
  hosts: readonly HostStatus[],
  preferences: OverviewPreferencesV1,
  previous: readonly OverviewGroup[] | undefined,
): readonly OverviewGroup[] {
  const rank = new Map<HostStatus, number>();
  const drafts = new Map<string, GroupDraft>();
  for (const host of hosts) {
    const status = effectiveStatus(host.rollupEvidence);
    rank.set(host, statusRank(status));
    const draft = groupDraftFor(preferences.groupBy, host, status);
    const existing = drafts.get(draft.id);
    if (existing === undefined) drafts.set(draft.id, { ...draft, hosts: [host] });
    else existing.hosts.push(host);
  }
  const compare = hostComparator(preferences.sortBy, rank);
  const ordered = [...drafts.values()].sort(compareGroupDrafts);
  const groups = ordered.map((draft, index): OverviewGroup => {
    const sorted = draft.hosts.sort(compare);
    const prior = previous?.[index];
    if (prior !== undefined && prior.id === draft.id && prior.label === draft.label && sameElements(prior.hosts, sorted)) {
      return prior;
    }
    return { id: draft.id, label: draft.label, hosts: sorted };
  });
  return previous !== undefined && sameElements(previous, groups) ? previous : groups;
}

// ---------------------------------------------------------------------------------------------
// Structural sharing helpers
// ---------------------------------------------------------------------------------------------

function sameAvailability(a: DataAvailability, b: DataAvailability): boolean {
  return a === b || (a.state === b.state && a.source === b.source && a.lastGoodAt === b.lastGoodAt && a.message === b.message);
}

function reuseCounts<T extends object>(next: T, prior: T | undefined): T {
  if (prior === undefined) return next;
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (next[key] !== prior[key]) return next;
  }
  return prior;
}

function reuseCoverage(next: CoverageStat, prior: CoverageStat | undefined): CoverageStat {
  if (prior === undefined || prior.status !== next.status || !sameAvailability(prior.availability, next.availability)) return next;
  if (next.status === "available" && prior.status === "available") {
    return prior.covered === next.covered && prior.gaps === next.gaps && prior.extras === next.extras ? prior : next;
  }
  if (next.status === "unavailable" && prior.status === "unavailable") {
    return prior.message === next.message ? prior : next;
  }
  return next;
}

function reuseEngine(next: EngineOkStat, prior: EngineOkStat | undefined): EngineOkStat {
  if (prior === undefined || prior.status !== next.status || !sameAvailability(prior.availability, next.availability)) return next;
  if (next.status === "available" && prior.status === "available") return prior.ok === next.ok ? prior : next;
  return prior;
}

function reuseStats(next: OverviewStats, prior: OverviewStats | undefined): OverviewStats {
  if (prior === undefined) return next;
  const candidate: OverviewStats = {
    hosts: reuseCounts(next.hosts, prior.hosts),
    services: reuseCounts(next.services, prior.services),
    firing: reuseCounts(next.firing, prior.firing),
    silenced: next.silenced,
    inhibited: next.inhibited,
    coverage: reuseCoverage(next.coverage, prior.coverage),
    engine: reuseEngine(next.engine, prior.engine),
  };
  return candidate.hosts === prior.hosts &&
    candidate.services === prior.services &&
    candidate.firing === prior.firing &&
    candidate.silenced === prior.silenced &&
    candidate.inhibited === prior.inhibited &&
    candidate.coverage === prior.coverage &&
    candidate.engine === prior.engine
    ? prior
    : candidate;
}

function reuseFiring(
  alerts: readonly OverviewAlertSummary[],
  prior: readonly OverviewAlertSummary[] | undefined,
): readonly OverviewAlertSummary[] {
  if (prior === undefined) return alerts;
  const byFingerprint = new Map<string, OverviewAlertSummary>();
  for (const alert of prior) byFingerprint.set(alert.fingerprint, alert);
  const normalized = alerts.map((alert) => {
    const priorAlert = byFingerprint.get(alert.fingerprint);
    return priorAlert !== undefined && (priorAlert === alert || alertContentKey(priorAlert) === alertContentKey(alert))
      ? priorAlert
      : alert;
  });
  if (sameElements(prior, normalized)) return prior;
  return sameElements(alerts, normalized) ? alerts : normalized;
}

function sameMap<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false;
  }
  return true;
}

/** Normalize hosts/services against the previous model's canonical references. */
function normalizeHosts(
  hosts: readonly HostStatus[],
  previous: OverviewModel | undefined,
): readonly HostStatus[] {
  if (previous === undefined) return hosts;
  const priorTargets = previous.targetById;
  return hosts.map((host) => {
    const priorHostTarget = priorTargets.get(host.drilldownId);
    const priorHost = priorHostTarget?.kind === "host" ? priorHostTarget.host : undefined;

    const services = host.services.map((service) => {
      const prior = priorTargets.get(service.drilldownId);
      const priorService = prior?.kind === "service" ? prior.service : null;
      return priorService !== null && (priorService === service || serviceContentKey(priorService) === serviceContentKey(service))
        ? priorService
        : service;
    });
    const normalizedServices: readonly ServiceStatus[] =
      priorHost !== undefined && sameElements(priorHost.services, services)
        ? priorHost.services
        : sameElements(host.services, services)
          ? host.services
          : services;

    if (
      priorHost !== undefined &&
      normalizedServices === priorHost.services &&
      (priorHost === host || hostOwnContentKey(priorHost) === hostOwnContentKey(host))
    ) {
      return priorHost;
    }
    return normalizedServices === host.services ? host : { ...host, services: normalizedServices };
  });
}

/** Canonical index: exact ids only; empty ids skipped; duplicated ids removed and ignored. */
function buildTargetIndex(
  hosts: readonly HostStatus[],
  previous: OverviewModel | undefined,
): ReadonlyMap<string, OverviewTarget> {
  const index = new Map<string, OverviewTarget>();
  const ambiguous = new Set<string>();
  const prior = previous?.targetById;
  const insert = (id: string, host: HostStatus, service: ServiceStatus | null): void => {
    if (id === "" || ambiguous.has(id)) return;
    if (index.has(id)) {
      index.delete(id);
      ambiguous.add(id);
      return;
    }
    const existing = prior?.get(id);
    const reusable =
      existing !== undefined &&
      existing.kind === (service === null ? "host" : "service") &&
      existing.host === host &&
      existing.service === service;
    index.set(id, reusable ? existing : service === null ? hostTarget(host) : serviceTarget(host, service));
  };
  for (const host of hosts) {
    insert(host.drilldownId, host, null);
    for (const service of host.services) insert(service.drilldownId, host, service);
  }
  return prior !== undefined && sameMap(index, prior) ? prior : index;
}

// ---------------------------------------------------------------------------------------------
// Model derivation
// ---------------------------------------------------------------------------------------------

/**
 * Derive every overview presentation index from one immutable accepted snapshot. The optional
 * prior model is used only for structural reference reuse; it is never mutated. When nothing
 * material changed, `previous` itself is returned.
 */
export function deriveOverviewModel(
  snapshot: OverviewSnapshotV2,
  preferences: OverviewPreferencesV1,
  previous?: OverviewModel,
): OverviewModel {
  const hosts = normalizeHosts(snapshot.hosts, previous);
  const targetById = buildTargetIndex(hosts, previous);
  const groups = buildGroups(hosts, preferences, previous?.groups);
  const stats = reuseStats(deriveOverviewStats(snapshot), previous?.stats);
  const firing = reuseFiring(snapshot.alerts, previous?.firing);
  if (
    previous !== undefined &&
    previous.groups === groups &&
    previous.targetById === targetById &&
    previous.stats === stats &&
    previous.firing === firing
  ) {
    return previous;
  }
  return { groups, targetById, stats, firing };
}

// ---------------------------------------------------------------------------------------------
// Firing ribbon
// ---------------------------------------------------------------------------------------------

const SEVERITY_RANK: Readonly<Record<string, number>> = { critical: 0, warning: 1, info: 2 };

function severityRank(severity: string): number {
  return SEVERITY_RANK[severity] ?? 3;
}

/** Severity descending, oldest valid startsAt first (invalid after), name collator, then fingerprint. */
export function compareFiringAlerts(left: OverviewAlertSummary, right: OverviewAlertSummary): number {
  const bySeverity = severityRank(left.severity) - severityRank(right.severity);
  if (bySeverity !== 0) return bySeverity;
  const leftAt = Date.parse(left.startsAt);
  const rightAt = Date.parse(right.startsAt);
  const leftValid = Number.isFinite(leftAt);
  const rightValid = Number.isFinite(rightAt);
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  if (leftValid && rightValid && leftAt !== rightAt) return leftAt - rightAt;
  return (
    OVERVIEW_COLLATOR.compare(left.name ?? "", right.name ?? "") ||
    codeUnitCompare(left.fingerprint ?? "", right.fingerprint ?? "")
  );
}

/** Text-only kiosk content: complete severity counts, first five ordered names, and overflow. */
export function buildKioskFiringSummary(alerts: readonly OverviewAlertSummary[]): KioskFiringSummary {
  const names = [...alerts]
    .sort(compareFiringAlerts)
    .slice(0, KIOSK_ALERT_NAME_LIMIT)
    .map((alert) => (alert.name ? alert.name : UNNAMED_ALERT));
  return {
    counts: severityCounts(alerts),
    names,
    overflow: Math.max(0, alerts.length - names.length),
  };
}

/** Number of firing summaries carrying the read-only ack marker. */
export function countAcked(alerts: readonly OverviewAlertSummary[]): number {
  let count = 0;
  for (const alert of alerts) if (alert.acked === true) count++;
  return count;
}

/** Exact alert triage path: `/alerts/<encoded fingerprint>`. */
export function alertTriagePath(alert: OverviewAlertSummary): string {
  return `/alerts/${encodeURIComponent(alert.fingerprint)}`;
}

/** Exact target triage path: `/alerts?target=<encoded TargetIdentity.id>`. */
export function targetTriagePath(target: TargetIdentity): string {
  return `/alerts?target=${encodeURIComponent(target.id)}`;
}

// ---------------------------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------------------------

function attributedTo(identity: TargetIdentity | null, target: OverviewTarget): boolean {
  return identity !== null && identity.kind === target.kind && identity.id === target.drilldownId;
}

/**
 * Index the snapshot fields attributed to exactly this canonical target (kind + id), preserving
 * server order. Status is the target's own effective status: the service's `statusEvidence`, or
 * the host's own `statusEvidence` (the grid cell shows the rollup; the drawer shows the target).
 */
export function deriveTargetDrawerModel(snapshot: OverviewSnapshotV2, target: OverviewTarget): TargetDrawerModel {
  const evidence = target.service !== null ? target.service.statusEvidence : target.host.statusEvidence;
  const checks = snapshot.recentChecks.filter((check) => attributedTo(check.target, target));
  const grafana = (target.service !== null ? target.service : target.host).grafana;
  return {
    target,
    status: effectiveStatus(evidence),
    availability: evidence.availability,
    signals: snapshot.signals.filter((signal) => attributedTo(signal.target, target)),
    alerts: snapshot.alerts.filter((alert) => attributedTo(alert.target, target)),
    checks,
    checkLanes: buildCheckTimeline(checks),
    grafana: grafana === null ? null : { boardUid: grafana.boardUid, url: grafana.url },
  };
}

function checkOutcome(success: boolean | null): TargetStatus {
  return success === true ? "ok" : success === false ? "critical" : "unknown";
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Build deterministic `StatusTimeline` lanes, one per endpoint (sorted by collator then exact
 * endpoint). Rows without a finite `observedAt` are omitted (the drawer lists them as text).
 * Equal timestamps collapse with the last input winning. Each segment runs to the next
 * observation; the final one ends at newest + median positive adjacent delta (or +1 ms).
 * `success` maps true → ok, false → critical, null → unknown.
 */
export function buildCheckTimeline(checks: readonly CheckSummary[]): readonly TimelineLane[] {
  const byEndpoint = new Map<string, { at: number; status: TargetStatus }[]>();
  for (const check of checks) {
    const at = check.observedAt === null ? Number.NaN : Date.parse(check.observedAt);
    if (!Number.isFinite(at)) continue;
    const rows = byEndpoint.get(check.endpoint);
    const row = { at, status: checkOutcome(check.success) };
    if (rows === undefined) byEndpoint.set(check.endpoint, [row]);
    else rows.push(row);
  }
  if (byEndpoint.size === 0) return [];

  const lanes: { endpoint: string; points: { at: number; status: TargetStatus }[] }[] = [];
  const deltas: number[] = [];
  let newest = -Infinity;
  for (const [endpoint, rows] of byEndpoint) {
    const sorted = rows.map((row, i) => ({ ...row, i })).sort((a, b) => a.at - b.at || a.i - b.i);
    const points: { at: number; status: TargetStatus }[] = [];
    for (const row of sorted) {
      const last = points[points.length - 1];
      if (last !== undefined && last.at === row.at) last.status = row.status;
      else points.push({ at: row.at, status: row.status });
    }
    for (let i = 1; i < points.length; i++) deltas.push(points[i]!.at - points[i - 1]!.at);
    newest = Math.max(newest, points[points.length - 1]!.at);
    lanes.push({ endpoint, points });
  }
  const interval = deltas.length > 0 ? median(deltas) : 1;
  const domainEnd = newest + interval;

  return lanes
    .sort((a, b) => textCompare(a.endpoint, b.endpoint))
    .map(({ endpoint, points }): TimelineLane => ({
      id: endpoint,
      label: endpoint,
      segments: points.map((point, i): TimelineSegment => ({
        status: point.status,
        start: point.at,
        end: points[i + 1]?.at ?? domainEnd,
      })),
    }));
}
