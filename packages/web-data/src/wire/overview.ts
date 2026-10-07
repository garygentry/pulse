// packages/web-data/src/wire/overview.ts — authoritative browser-safe overview wire
// contracts (01-core-definitions.md §9). `OverviewSnapshotV2` preserves the exact field
// names and target/status meanings of the existing `apps/web/src/shared/snapshot.ts`
// `OverviewSnapshot` and adds the live-signal, recent-check, alert-count, and coverage
// contracts. `apps/web/src/shared/snapshot.ts` becomes a compatibility re-export of these
// names, so no consumer receives a competing overview type. `generatedAt` is body
// materialization time — never the latest cycle observation. The renderer import is
// type-only and erased, so this module adds no runtime dependency to `/wire`.

import { CURRENT_MAX_PLAIN_BYTES } from "./common.js";
import type { AvailabilitySection, DataAvailability, SourceId, Unit } from "./common.js";
import type { TargetIdentity } from "./history.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

/**
 * The five visual target states. Drives cell colour and the redundant status token/glyph;
 * `suppressed` is visually distinct from `unknown`. Field meanings are preserved from the
 * existing overview contract.
 */
export type TargetStatus = "ok" | "warning" | "critical" | "unknown" | "suppressed";

/**
 * Per-source health as materialized into the overview body. Reflects whether the governing
 * source succeeded when this body was built, independent of later cycle observation freshness.
 */
export interface SourceHealthCompat {
  /** Whether the source succeeded when this body was materialized. */ readonly ok: boolean;
  /** Body's stable last-success context in UTC, or null before any success. */ readonly lastSuccess: string | null;
  /** Bounded safe body-materialization error, or null when ok. */ readonly error: string | null;
}

/** One active overview alert summary attributed to a host or service, or unattributed. */
export interface OverviewAlertSummary {
  /** Stable Alertmanager alert fingerprint. */ readonly fingerprint: string;
  /** Alert name (the `alertname` label). */ readonly name: string;
  /** Overview severity; `info` lists but never colours a cell. */ readonly severity: "critical" | "warning" | "info";
  /** Alert start in UTC. */ readonly startsAt: string;
  /** Canonical rendered target attribution, or null when unattributed. */
  readonly target: TargetIdentity | null;
  /** Optional bounded summary annotation for the strip/panel. */ readonly summary?: string;
  /** `true` when acknowledged in Pulse; absent otherwise (REQ-ACK-07d). Never `false`. */
  readonly acked?: true;
}

/** One recent Gatus check result shown as supporting detail; never colours a cell. */
export interface OverviewCheckResult {
  /** Gatus endpoint identity. */ readonly endpoint: string;
  /** Whether the latest evaluation in the retained body succeeded. */ readonly success: boolean;
  /** Latest evaluation time in the retained body, in UTC. */ readonly lastEvaluatedAt: string;
  /** Optional observed response time in milliseconds. */ readonly responseTimeMs?: number;
}

/** A resolved target status paired with the evidence that governs it. */
export interface TargetStatusEvidence {
  /** Resolved operator-facing status. */ readonly status: TargetStatus;
  /** Target-specific evidence governing the resolved status. */ readonly availability: DataAvailability;
}

/** One service as the overview renders it (a nested indicator under its host cell). */
export interface ServiceStatus {
  /** Service name. */ readonly name: string;
  /** Owning host name. */ readonly host: string;
  /** Whether Pulse manages the service. */ readonly managed: boolean;
  /** Whether a deep-health probe is declared. */ readonly deepHealth: boolean;
  /** Optional declared ingress URL. */ readonly ingressUrl?: string;
  /** Exact rendered drilldown id; never a Grafana value. */ readonly drilldownId: string;
  /** Deliberate suppression, or null when actively monitored. */
  readonly suppressed: {
    /** Closed rendered suppression class. */ readonly class: string;
    /** Human-readable rendered rationale. */ readonly rationale: string;
  } | null;
  /** Existing resolved visual status. */ readonly status: TargetStatus;
  /** Target-specific evidence governing `status`. */ readonly statusEvidence: TargetStatusEvidence;
  /** Affirmative liveness (`true`/`false` observed), or null when the source is unavailable. */ readonly live: boolean | null;
  /** Attributed active alert summaries. */ readonly activeAlerts: readonly OverviewAlertSummary[];
  /** Recent supporting checks. */ readonly checks: readonly OverviewCheckResult[];
  /** Resolved safe Grafana link, or null. */
  readonly grafana: {
    /** Validated dashboard UID. */ readonly boardUid: string;
    /** Server-resolved safe dashboard URL; "" when no Grafana origin is configured. */ readonly url: string;
  } | null;
}

/** One host cell — the grid's primary unit — nesting its services' indicators. */
export interface HostStatus {
  /** Host name. */ readonly name: string;
  /** Existing renderer collection class. */
  readonly collectionClass: WebEstateModelV2["hosts"][number]["collectionClass"];
  /** Declared addresses. */ readonly addresses: readonly string[];
  /** Exact rendered drilldown id; never a Grafana value. */ readonly drilldownId: string;
  /** Deliberate suppression, or null when actively monitored. */
  readonly suppressed: {
    /** Closed rendered suppression class. */ readonly class: string;
    /** Human-readable rendered rationale. */ readonly rationale: string;
  } | null;
  /** Existing host-own resolved status. */ readonly status: TargetStatus;
  /** Target-specific evidence governing host-own `status`. */ readonly statusEvidence: TargetStatusEvidence;
  /** Existing worst-of host/service rollup status. */ readonly rollup: TargetStatus;
  /** Evidence governing the host/service rollup. */ readonly rollupEvidence: TargetStatusEvidence;
  /** Affirmative liveness for the host, or null when the source is unavailable. */ readonly live: boolean | null;
  /** Attributed active alert summaries. */ readonly activeAlerts: readonly OverviewAlertSummary[];
  /** Recent supporting checks. */ readonly checks: readonly OverviewCheckResult[];
  /** Resolved safe Grafana link, or null. */
  readonly grafana: {
    /** Validated dashboard UID. */ readonly boardUid: string;
    /** Server-resolved safe dashboard URL; "" when no Grafana origin is configured. */ readonly url: string;
  } | null;
  /** Services in stable model order. */ readonly services: readonly ServiceStatus[];
}

/** One additive per-target live signal with its governing availability evidence. */
export interface LiveSignal {
  /** Canonical rendered target. */ readonly target: TargetIdentity;
  /** Stable signal id. */ readonly id: string;
  /** Human-readable label. */ readonly label: string;
  /** Display unit. */ readonly unit: Unit;
  /** Validated value, or null when unavailable. */ readonly value: number | string | boolean | null;
  /** Governing evidence for this value. */ readonly availability: DataAvailability;
}

/** One additive compact recent check outcome. */
export interface CheckSummary {
  /** Canonical rendered target, or null when attribution fails. */ readonly target: TargetIdentity | null;
  /** Endpoint id. */ readonly endpoint: string;
  /** Recent result, or null when unavailable. */ readonly success: boolean | null;
  /** Observation time in UTC, or null when unavailable. */ readonly observedAt: string | null;
  /** Duration in milliseconds, or null when unavailable. */ readonly durationMs: number | null;
}

/** Compact overview summary of monitoring-engine health. */
export interface EngineOverviewSummary {
  /** True only when every governing current engine source succeeded. */ readonly ok: boolean;
}

/** Additive coverage summary counts derived from declared-versus-rendered comparison. */
export interface CoverageSummary {
  /** Declared targets represented by scrape configuration. */ readonly covered: number;
  /** Declared targets without rendered coverage. */ readonly gaps: number;
  /** Rendered targets that are not declared. */ readonly extras: number;
}

/**
 * The whole-overview snapshot the server publishes and the client consumes. Preserves every
 * existing `OverviewSnapshot` field name and meaning and adds live signals, recent checks,
 * complete alert-state counts, and coverage availability.
 */
export interface OverviewSnapshotV2 {
  /** Build version; changes share the reload-once guard. */ readonly appVersion: string;
  /** Content materialization time in UTC, not the latest cycle observation. */ readonly generatedAt: string;
  /** Existing estate identity/timezone object, field names preserved. */
  readonly estate: {
    /** Estate display name. */ readonly name: string;
    /** Configured or fallback IANA timezone. */ readonly timezone: string;
    /** Whether UTC fallback replaced an invalid timezone. */ readonly tzFallback: boolean;
  };
  /** Existing body-materialization source health fields. */
  readonly sources: {
    /** VictoriaMetrics body evidence. */ readonly metrics: SourceHealthCompat;
    /** Alertmanager body evidence. */ readonly alerts: SourceHealthCompat;
    /** Gatus body evidence. */ readonly checks: SourceHealthCompat;
  };
  /** Every host with nested services in existing model order. */ readonly hosts: readonly HostStatus[];
  /** Existing active unsilenced overview alert strip. */ readonly alerts: readonly OverviewAlertSummary[];
  /** Additive per-target live signals. */ readonly signals: readonly LiveSignal[];
  /** Additive attributed recent check outcomes (multiple outcomes per endpoint retained). */ readonly recentChecks: readonly CheckSummary[];
  /** Additive monitoring-engine health summary. */ readonly engine: AvailabilitySection<EngineOverviewSummary>;
  /** Additive complete current alert-state counts. */
  readonly alertCounts: {
    /** Currently firing count. */ readonly firing: number;
    /** Currently silenced count. */ readonly silenced: number;
    /** Currently inhibited count. */ readonly inhibited: number;
  };
  /** Additive coverage availability/summary. */ readonly coverage: AvailabilitySection<CoverageSummary>;
}

/** Result of validating an untrusted overview response body. */
export type OverviewSnapshotValidationResult =
  | {
      /** Successful complete validation. */ readonly ok: true;
      /** Freshly copied accepted snapshot. */ readonly value: OverviewSnapshotV2;
    }
  | {
      /** Rejected untrusted body. */ readonly ok: false;
      /** Bounded operator-safe rejection reason. */ readonly message: string;
    };

const MAX_TEXT_BYTES = 512;
const MAX_MESSAGE_BYTES = 1_024;
const MAX_HOSTS = 100;
const MAX_SERVICES = 300;
const MAX_ALERTS = 1_024;
const MAX_SIGNALS = 4_096;
const MAX_CHECKS = 2_048;
const SOURCE_IDS = new Set<SourceId>([
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
]);
const UNITS = new Set<Unit>(["state", "percent", "count", "seconds", "milliseconds", "bytes", "scalar"]);
const COLLECTION_CLASSES = new Set(["managed-linux", "hypervisor-api", "nas-api", "probe-only", "excluded"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function boundedString(value: unknown, maxBytes = MAX_TEXT_BYTES): string | null {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= maxBytes
    ? value
    : null;
}

function nullableString(value: unknown, maxBytes = MAX_MESSAGE_BYTES): string | null | undefined {
  if (value === null) return null;
  return boundedString(value, maxBytes) ?? undefined;
}

function timestamp(value: unknown): string | null {
  const text = boundedString(value);
  return text !== null && Number.isFinite(Date.parse(text)) ? text : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function targetStatus(value: unknown): TargetStatus | null {
  return value === "ok" || value === "warning" || value === "critical" || value === "unknown" || value === "suppressed"
    ? value
    : null;
}

function availability(input: unknown): DataAvailability | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["state", "source", "lastGoodAt", "message"])) return null;
  const state = value.state;
  if (state !== "current" && state !== "stale" && state !== "unavailable" && state !== "not-configured") return null;
  const source = value.source;
  if (source !== "rendered-estate" && (typeof source !== "string" || !SOURCE_IDS.has(source as SourceId))) return null;
  const lastGoodAt = value.lastGoodAt === null ? null : timestamp(value.lastGoodAt);
  if (value.lastGoodAt !== null && lastGoodAt === null) return null;
  const message = nullableString(value.message);
  if (message === undefined) return null;
  return { state, source: source as DataAvailability["source"], lastGoodAt, message };
}

function identity(input: unknown): TargetIdentity | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["kind", "id"]) ||
      (value.kind !== "host" && value.kind !== "service" && value.kind !== "endpoint")) return null;
  const id = boundedString(value.id);
  return id === null ? null : { kind: value.kind, id };
}

function alert(input: unknown): OverviewAlertSummary | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["fingerprint", "name", "severity", "startsAt", "target"], ["summary", "acked"])) return null;
  const fingerprint = boundedString(value.fingerprint);
  const name = boundedString(value.name);
  const severity = value.severity;
  const startsAt = timestamp(value.startsAt);
  const target = value.target === null ? null : identity(value.target);
  const summary = value.summary === undefined ? undefined : boundedString(value.summary, MAX_MESSAGE_BYTES);
  if (fingerprint === null || name === null || startsAt === null || target === null && value.target !== null) return null;
  if (severity !== "critical" && severity !== "warning" && severity !== "info") return null;
  if (value.summary !== undefined && summary === null) return null;
  if (value.acked !== undefined && value.acked !== true) return null; // literal true only
  const base: Omit<OverviewAlertSummary, "summary" | "acked"> = { fingerprint, name, severity, startsAt, target };
  const withSummary: OverviewAlertSummary = summary === undefined || summary === null ? base : { ...base, summary };
  return value.acked === true ? { ...withSummary, acked: true } : withSummary;
}

function check(input: unknown): OverviewCheckResult | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["endpoint", "success", "lastEvaluatedAt"], ["responseTimeMs"])) return null;
  const endpoint = boundedString(value.endpoint);
  const lastEvaluatedAt = timestamp(value.lastEvaluatedAt);
  const responseTimeMs = value.responseTimeMs === undefined ? undefined : finiteNumber(value.responseTimeMs);
  if (endpoint === null || typeof value.success !== "boolean" || lastEvaluatedAt === null) return null;
  if (value.responseTimeMs !== undefined && (responseTimeMs === null || responseTimeMs === undefined || responseTimeMs < 0)) return null;
  const base = { endpoint, success: value.success, lastEvaluatedAt };
  return responseTimeMs === undefined || responseTimeMs === null ? base : { ...base, responseTimeMs };
}

function statusEvidence(input: unknown): TargetStatusEvidence | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["status", "availability"])) return null;
  const status = targetStatus(value.status);
  const evidence = availability(value.availability);
  return status === null || evidence === null ? null : { status, availability: evidence };
}

function suppression(input: unknown): { readonly class: string; readonly rationale: string } | null | undefined {
  if (input === null) return null;
  const value = record(input);
  if (value === null || !hasKeys(value, ["class", "rationale"])) return undefined;
  const klass = boundedString(value.class);
  const rationale = boundedString(value.rationale, MAX_MESSAGE_BYTES);
  return klass === null || rationale === null ? undefined : { class: klass, rationale };
}

function grafana(input: unknown): { readonly boardUid: string; readonly url: string } | null | undefined {
  if (input === null) return null;
  const value = record(input);
  if (value === null || !hasKeys(value, ["boardUid", "url"])) return undefined;
  const boardUid = boundedString(value.boardUid);
  // `url` is "" when the server has no browser-facing Grafana origin (deep links disabled); the
  // board still resolved, so the empty string is a valid wire value, not a malformed one.
  const url = value.url === "" ? "" : boundedString(value.url, MAX_MESSAGE_BYTES);
  return boardUid === null || url === null ? undefined : { boardUid, url };
}

function arrayOf<T>(input: unknown, max: number, parse: (item: unknown) => T | null): readonly T[] | null {
  if (!Array.isArray(input) || input.length > max) return null;
  const out: T[] = [];
  for (const item of input) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function service(input: unknown): ServiceStatus | null {
  const value = record(input);
  if (value === null || !hasKeys(value,
      ["name", "host", "managed", "deepHealth", "drilldownId", "suppressed", "status", "statusEvidence", "live", "activeAlerts", "checks", "grafana"],
      ["ingressUrl"])) return null;
  const name = boundedString(value.name);
  const host = boundedString(value.host);
  const drilldownId = boundedString(value.drilldownId);
  const status = targetStatus(value.status);
  const evidence = statusEvidence(value.statusEvidence);
  const suppressed = suppression(value.suppressed);
  const activeAlerts = arrayOf(value.activeAlerts, MAX_ALERTS, alert);
  const checks = arrayOf(value.checks, MAX_CHECKS, check);
  const link = grafana(value.grafana);
  const ingressUrl = value.ingressUrl === undefined ? undefined : boundedString(value.ingressUrl, MAX_MESSAGE_BYTES);
  if (name === null || host === null || drilldownId === null || status === null || evidence === null) return null;
  if (typeof value.managed !== "boolean" || typeof value.deepHealth !== "boolean") return null;
  if (value.live !== null && typeof value.live !== "boolean") return null;
  if (suppressed === undefined || activeAlerts === null || checks === null || link === undefined) return null;
  if (value.ingressUrl !== undefined && ingressUrl === null) return null;
  const base = { name, host, managed: value.managed, deepHealth: value.deepHealth, drilldownId,
    suppressed, status, statusEvidence: evidence, live: value.live, activeAlerts, checks, grafana: link };
  return ingressUrl === undefined || ingressUrl === null ? base : { ...base, ingressUrl };
}

function host(input: unknown): HostStatus | null {
  const value = record(input);
  if (value === null || !hasKeys(value,
      ["name", "collectionClass", "addresses", "drilldownId", "suppressed", "status", "statusEvidence", "rollup", "rollupEvidence", "live", "activeAlerts", "checks", "grafana", "services"])) return null;
  const name = boundedString(value.name);
  const drilldownId = boundedString(value.drilldownId);
  const status = targetStatus(value.status);
  const rollup = targetStatus(value.rollup);
  const evidence = statusEvidence(value.statusEvidence);
  const rollupEvidence = statusEvidence(value.rollupEvidence);
  const suppressed = suppression(value.suppressed);
  const addresses = arrayOf(value.addresses, 64, (item) => boundedString(item));
  const activeAlerts = arrayOf(value.activeAlerts, MAX_ALERTS, alert);
  const checks = arrayOf(value.checks, MAX_CHECKS, check);
  const services = arrayOf(value.services, MAX_SERVICES, service);
  const link = grafana(value.grafana);
  if (name === null || drilldownId === null || status === null || rollup === null || evidence === null || rollupEvidence === null) return null;
  if (typeof value.collectionClass !== "string" || !COLLECTION_CLASSES.has(value.collectionClass)) return null;
  if (value.live !== null && typeof value.live !== "boolean") return null;
  if (suppressed === undefined || addresses === null || activeAlerts === null || checks === null || services === null || link === undefined) return null;
  return { name, collectionClass: value.collectionClass as HostStatus["collectionClass"], addresses, drilldownId,
    suppressed, status, statusEvidence: evidence, rollup, rollupEvidence, live: value.live,
    activeAlerts, checks, grafana: link, services };
}

function sourceHealth(input: unknown): SourceHealthCompat | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["ok", "lastSuccess", "error"]) || typeof value.ok !== "boolean") return null;
  const lastSuccess = value.lastSuccess === null ? null : timestamp(value.lastSuccess);
  const error = nullableString(value.error);
  if (value.lastSuccess !== null && lastSuccess === null || error === undefined) return null;
  return { ok: value.ok, lastSuccess, error };
}

function signal(input: unknown): LiveSignal | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["target", "id", "label", "unit", "value", "availability"])) return null;
  const target = identity(value.target);
  const id = boundedString(value.id);
  const label = boundedString(value.label);
  const evidence = availability(value.availability);
  const scalar = value.value;
  const validScalar = scalar === null || typeof scalar === "boolean" || boundedString(scalar, MAX_MESSAGE_BYTES) !== null || finiteNumber(scalar) !== null;
  if (target === null || id === null || label === null || typeof value.unit !== "string" || !UNITS.has(value.unit as Unit)) return null;
  if (!validScalar || evidence === null) return null;
  return { target, id, label, unit: value.unit as Unit, value: scalar as LiveSignal["value"], availability: evidence };
}

function recentCheck(input: unknown): CheckSummary | null {
  const value = record(input);
  if (value === null || !hasKeys(value, ["target", "endpoint", "success", "observedAt", "durationMs"])) return null;
  const target = value.target === null ? null : identity(value.target);
  const endpoint = boundedString(value.endpoint);
  const observedAt = value.observedAt === null ? null : timestamp(value.observedAt);
  const durationMs = value.durationMs === null ? null : finiteNumber(value.durationMs);
  if (target === null && value.target !== null || endpoint === null) return null;
  if (value.success !== null && typeof value.success !== "boolean") return null;
  if (value.observedAt !== null && observedAt === null || durationMs !== null && durationMs < 0) return null;
  if (value.durationMs !== null && durationMs === null) return null;
  return { target, endpoint, success: value.success, observedAt, durationMs };
}

/**
 * Validate and copy one untrusted overview body without throwing. The validator checks every
 * field consumed by overview and enforces the current route-size and supported-estate bounds.
 */
export function validateOverviewSnapshotV2(input: unknown): OverviewSnapshotValidationResult {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, message: "The overview response is malformed." };
  }
  if (serialized === undefined || new TextEncoder().encode(serialized).length > CURRENT_MAX_PLAIN_BYTES) {
    return { ok: false, message: "The overview response exceeds its safety limit." };
  }
  const value = record(input);
  if (value === null || !hasKeys(value,
      ["appVersion", "generatedAt", "estate", "sources", "hosts", "alerts", "signals", "recentChecks", "engine", "alertCounts", "coverage"])) {
    return { ok: false, message: "The overview response is malformed." };
  }
  const appVersion = boundedString(value.appVersion);
  const generatedAt = timestamp(value.generatedAt);
  const estate = record(value.estate);
  const sources = record(value.sources);
  const alertCounts = record(value.alertCounts);
  if (appVersion === null || generatedAt === null || estate === null || sources === null || alertCounts === null ||
      !hasKeys(estate, ["name", "timezone", "tzFallback"]) ||
      !hasKeys(sources, ["metrics", "alerts", "checks"]) ||
      !hasKeys(alertCounts, ["firing", "silenced", "inhibited"])) {
    return { ok: false, message: "The overview response is malformed." };
  }
  const estateName = boundedString(estate.name);
  const timezone = boundedString(estate.timezone);
  if (estateName === null || timezone === null || typeof estate.tzFallback !== "boolean") {
    return { ok: false, message: "The overview response is malformed." };
  }
  const metrics = sourceHealth(sources.metrics);
  const alertsSource = sourceHealth(sources.alerts);
  const checksSource = sourceHealth(sources.checks);
  const hosts = arrayOf(value.hosts, MAX_HOSTS, host);
  const alerts = arrayOf(value.alerts, MAX_ALERTS, alert);
  const signals = arrayOf(value.signals, MAX_SIGNALS, signal);
  const recentChecks = arrayOf(value.recentChecks, MAX_CHECKS, recentCheck);
  const firing = nonNegativeInteger(alertCounts.firing);
  const silenced = nonNegativeInteger(alertCounts.silenced);
  const inhibited = nonNegativeInteger(alertCounts.inhibited);
  const engineSection = record(value.engine);
  const coverageSection = record(value.coverage);
  if (engineSection === null || coverageSection === null ||
      !hasKeys(engineSection, ["availability", "value"]) || !hasKeys(coverageSection, ["availability", "value"])) {
    return { ok: false, message: "The overview response is malformed." };
  }
  const engineAvailability = availability(engineSection.availability);
  const coverageAvailability = availability(coverageSection.availability);
  const engineValue = engineSection?.value === null ? null : record(engineSection?.value);
  const coverageValue = coverageSection?.value === null ? null : record(coverageSection?.value);
  if (metrics === null || alertsSource === null || checksSource === null || hosts === null || alerts === null || signals === null || recentChecks === null) {
    return { ok: false, message: "The overview response is malformed." };
  }
  if (firing === null || silenced === null || inhibited === null || engineAvailability === null || coverageAvailability === null) {
    return { ok: false, message: "The overview response is malformed." };
  }
  if (engineValue !== null && (!hasKeys(engineValue, ["ok"]) || typeof engineValue.ok !== "boolean")) {
    return { ok: false, message: "The overview response is malformed." };
  }
  if (coverageValue !== null && !hasKeys(coverageValue, ["covered", "gaps", "extras"])) {
    return { ok: false, message: "The overview response is malformed." };
  }
  const covered = coverageValue === null ? null : nonNegativeInteger(coverageValue.covered);
  const gaps = coverageValue === null ? null : nonNegativeInteger(coverageValue.gaps);
  const extras = coverageValue === null ? null : nonNegativeInteger(coverageValue.extras);
  if (coverageValue !== null && (covered === null || gaps === null || extras === null)) {
    return { ok: false, message: "The overview response is malformed." };
  }
  const targetIds = new Set<string>();
  let serviceCount = 0;
  for (const parsedHost of hosts) {
    if (parsedHost.statusEvidence.status !== parsedHost.status || parsedHost.rollupEvidence.status !== parsedHost.rollup ||
        targetIds.has(parsedHost.drilldownId)) return { ok: false, message: "The overview response is malformed." };
    targetIds.add(parsedHost.drilldownId);
    serviceCount += parsedHost.services.length;
    if (serviceCount > MAX_SERVICES) return { ok: false, message: "The overview response exceeds its safety limit." };
    for (const parsedService of parsedHost.services) {
      if (parsedService.host !== parsedHost.name || parsedService.statusEvidence.status !== parsedService.status ||
          targetIds.has(parsedService.drilldownId)) return { ok: false, message: "The overview response is malformed." };
      targetIds.add(parsedService.drilldownId);
    }
  }
  return {
    ok: true,
    value: {
      appVersion, generatedAt,
      estate: { name: estateName, timezone, tzFallback: estate.tzFallback },
      sources: { metrics, alerts: alertsSource, checks: checksSource },
      hosts, alerts, signals, recentChecks,
      engine: engineValue === null
        ? { availability: engineAvailability, value: null }
        : { availability: engineAvailability, value: { ok: engineValue.ok as boolean } },
      alertCounts: { firing, silenced, inhibited },
      coverage: coverageValue === null
        ? { availability: coverageAvailability, value: null }
        : { availability: coverageAvailability, value: { covered: covered as number, gaps: gaps as number, extras: extras as number } },
    },
  };
}
