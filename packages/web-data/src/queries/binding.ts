// packages/web-data/src/queries/binding.ts — curated target resolution, safe PromQL
// construction, and the public binder (06-curated-query-catalog.md §§3–7). No public
// function accepts client PromQL: `BoundQuery.promql` is server-internal, built only from
// pinned templates after the query id, target relationship, metric names, and range have
// all been validated against a captured immutable `WebEstateModelV2`. Renderer label
// values are escaped into exactly one quoted exact-match label; renderer metric names are
// validated against a strict pattern rather than escaped into query syntax.

import type { ApiError, RangeId, TargetKind, Unit } from "../wire/common.js";
import { ERROR_MESSAGES } from "../wire/common.js";
import type { QueryId, TargetIdentity } from "../wire/history.js";
import type {
  WebEstateHostV2,
  WebEstateModelV2,
  WebEstateServiceV2,
} from "@pulse/renderer";
import { QUERY_CATALOG, isQueryId } from "./catalog.js";
import { parseRange } from "./ranges.js";

// ---------------------------------------------------------------------------
// Public contracts (01-core-definitions.md §… / 06 §1)
// ---------------------------------------------------------------------------

/** A safely bound server query. `promql` is server-authored and never client-supplied. */
export interface BoundQuery {
  /** Catalog query id. */ readonly queryId: QueryId;
  /** Validated target, or null for estate-wide queries. */ readonly target: TargetIdentity | null;
  /** Accepted closed range. */ readonly range: RangeId;
  /** Server-authored PromQL; never contains raw client language. */ readonly promql: string;
  /** Catalog result unit. */ readonly unit: Unit;
  /** Bounded sampling step in seconds. */ readonly effectiveStepSeconds: number;
}

/** Closed set of expected binder validation/applicability failure codes (06 §7). */
export type QueryBindFailureCode =
  | "INVALID_REQUEST"
  | "QUERY_NOT_FOUND"
  | "TARGET_NOT_FOUND"
  | "QUERY_NOT_APPLICABLE"
  | "RANGE_UNSUPPORTED";

/** Result of binding a curated query request against a captured model. */
export type QueryBindResult =
  | {
      /** Success discriminator. */ readonly ok: true;
      /** Safely bound server query. */ readonly query: BoundQuery;
    }
  | {
      /** Failure discriminator. */ readonly ok: false;
      /** Expected validation/applicability failure. */ readonly error: ApiError<QueryBindFailureCode>;
    };

// ---------------------------------------------------------------------------
// Internal resolved-target contract (06 §3) — never exported; builders never
// receive a raw model object or request string.
// ---------------------------------------------------------------------------

interface ResolvedTargetBase {
  readonly target: TargetIdentity;
  readonly host: string | null;
  readonly instances: readonly string[];
}
type ResolvedTarget =
  | (ResolvedTargetBase & { readonly kind: "host"; readonly drilldownId: string })
  | (ResolvedTargetBase & {
      readonly kind: "service";
      readonly service: string;
      readonly deepHealthMetric: string | null;
      readonly backupAgeMetric: string | null;
    })
  | (ResolvedTargetBase & { readonly kind: "endpoint"; readonly endpointKey: string });

type QueryBuilder = (target: ResolvedTarget | null) => string;

// ---------------------------------------------------------------------------
// Escaping and validation primitives (06 §3, §4)
// ---------------------------------------------------------------------------

/** Strict Prometheus metric-name pattern; renderer names failing it are never used (06 §4). */
const METRIC_NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/** Maximum accepted request-id byte length before lookup (06 §3). */
const MAX_ID_BYTES = 512;

/** Server-authored fixed metric names bound only after model relationship validation. */
const DEEP_HEALTH_METRIC = "pulse_deep_health_up";
const BACKUP_AGE_METRIC = "pulse_backup_freshness_age_seconds";

/** An empty-set selector used when a builder has no bound target; it never broadens (06 §4). */
const NEVER_MATCH = 'up{instance="__pulse_no_target__"}';

const UTF8 = new TextEncoder();

/**
 * Escape a label value for a Prometheus exact-match selector, performing exactly the
 * backslash, newline, and double-quote substitutions (06 §4). Other control characters
 * must be rejected by the caller before escaping; this function performs no broadening.
 */
export function escapePrometheusLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

/** Whether a string contains a control character other than the escapable newline (06 §4). */
function hasForbiddenControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0a) continue; // newline is escaped, not rejected
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A non-empty, control-free request id within the byte bound (06 §3). */
function isBoundedControlFreeId(value: string): boolean {
  if (value.length === 0) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return UTF8.encode(value).length <= MAX_ID_BYTES;
}

/** Render one exact-match label selector `name="<escaped value>"`. */
function labelSelector(name: string, value: string): string {
  return `${name}="${escapePrometheusLabelValue(value)}"`;
}

// ---------------------------------------------------------------------------
// Target resolution (06 §3)
// ---------------------------------------------------------------------------

type ResolveOutcome =
  | { readonly ok: true; readonly target: ResolvedTarget | null }
  | { readonly ok: false; readonly error: ApiError<QueryBindFailureCode> };

function fail(code: QueryBindFailureCode, details?: ApiError["details"]): ResolveOutcome {
  return { ok: false, error: makeError(code, details) };
}

function makeError(code: QueryBindFailureCode, details?: ApiError["details"]): ApiError<QueryBindFailureCode> {
  return { code, message: ERROR_MESSAGES[code], ...(details !== undefined ? { details } : {}) };
}

/** Deduplicate and sort validated instance labels in deterministic code-point order. */
function instancesOf(host: WebEstateHostV2): readonly string[] {
  return [...new Set(host.scrapeTargets.map((t) => t.instance))].sort();
}

function resolveHost(model: WebEstateModelV2, id: string, targetKind: TargetKind): ResolveOutcome {
  const matches = model.hosts.filter((h) => h.drilldownId === id);
  if (matches.length === 0) return fail("TARGET_NOT_FOUND");
  if (matches.length > 1) return fail("TARGET_NOT_FOUND"); // ambiguous identity: never "first wins"
  const host = matches[0]!;
  const instances = instancesOf(host);
  if (instances.length === 0 || instances.some(hasForbiddenControl)) {
    return fail("QUERY_NOT_APPLICABLE", { queryId: id, targetKind });
  }
  return {
    ok: true,
    target: {
      kind: "host",
      target: { kind: "host", id },
      host: host.name,
      instances,
      drilldownId: host.drilldownId,
    },
  };
}

/** The validated deep-health metric name for a service, or null when unavailable (06 §4). */
function deepHealthMetricOf(service: WebEstateServiceV2): string | null {
  if (service.deepHealth !== true || service.deepHealthDetail === null) return null;
  // A malformed renderer-declared metric key makes the query unavailable rather than
  // being escaped into query syntax (06 §4).
  if (service.deepHealthDetail.metrics.some((m) => !METRIC_NAME_RE.test(m))) return null;
  return METRIC_NAME_RE.test(DEEP_HEALTH_METRIC) ? DEEP_HEALTH_METRIC : null;
}

function resolveService(model: WebEstateModelV2, id: string, targetKind: TargetKind): ResolveOutcome {
  const matches = model.services.filter((s) => s.drilldownId === id);
  if (matches.length === 0) return fail("TARGET_NOT_FOUND");
  if (matches.length > 1) return fail("TARGET_NOT_FOUND"); // ambiguous identity
  const service = matches[0]!;
  if (hasForbiddenControl(service.name)) return fail("QUERY_NOT_APPLICABLE", { queryId: id, targetKind });
  return {
    ok: true,
    target: {
      kind: "service",
      target: { kind: "service", id },
      host: service.host,
      instances: [],
      service: service.name,
      deepHealthMetric: deepHealthMetricOf(service),
      backupAgeMetric: service.backupFreshness !== null ? BACKUP_AGE_METRIC : null,
    },
  };
}

/** Collect the canonical endpoint-key set with occurrence counts for ambiguity detection. */
function endpointKeyCounts(model: WebEstateModelV2): Map<string, number> {
  const counts = new Map<string, number>();
  for (const service of model.services) {
    for (const key of service.gatusEndpoints) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function resolveEndpoint(model: WebEstateModelV2, id: string): ResolveOutcome {
  const count = endpointKeyCounts(model).get(id) ?? 0;
  if (count === 0) return fail("TARGET_NOT_FOUND");
  if (count > 1) return fail("TARGET_NOT_FOUND"); // ambiguous identity
  return {
    ok: true,
    target: { kind: "endpoint", target: { kind: "endpoint", id }, host: null, instances: [], endpointKey: id },
  };
}

/**
 * Resolve the request target against the captured model for one definition, enforcing the
 * estate/host/service/endpoint kind contract, id bounds, exact uniqueness, and service
 * metric relationships (06 §3–§4).
 */
function resolveTarget(
  queryId: QueryId,
  targetKind: TargetKind,
  target: TargetIdentity | null,
  model: WebEstateModelV2,
): ResolveOutcome {
  if (queryId === "estate.liveness" && target !== null) {
    if (!isBoundedControlFreeId(target.id)) return fail("INVALID_REQUEST");
    if (target.kind === "host") return resolveHost(model, target.id, "host");
    if (target.kind === "service") return resolveService(model, target.id, "service");
    return fail("QUERY_NOT_APPLICABLE", { queryId, targetKind: target.kind });
  }
  if (targetKind === "estate") {
    if (target !== null) return fail("QUERY_NOT_APPLICABLE", { queryId, targetKind });
    return { ok: true, target: null };
  }

  if (target === null || target.kind !== targetKind) {
    return fail("QUERY_NOT_APPLICABLE", { queryId, targetKind });
  }
  if (!isBoundedControlFreeId(target.id)) {
    return fail("INVALID_REQUEST");
  }

  if (targetKind === "host") return resolveHost(model, target.id, targetKind);
  if (targetKind === "endpoint") return resolveEndpoint(model, target.id);

  const resolved = resolveService(model, target.id, targetKind);
  if (!resolved.ok || resolved.target === null || resolved.target.kind !== "service") return resolved;
  if (queryId === "service.deep-health" && resolved.target.deepHealthMetric === null) {
    return fail("QUERY_NOT_APPLICABLE", { queryId, targetKind });
  }
  if (queryId === "service.backup-age" && resolved.target.backupAgeMetric === null) {
    return fail("QUERY_NOT_APPLICABLE", { queryId, targetKind });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Pinned server-authored query templates (06 §4, §6)
// ---------------------------------------------------------------------------

function asHost(target: ResolvedTarget | null): Extract<ResolvedTarget, { kind: "host" }> | null {
  return target !== null && target.kind === "host" && target.instances.length > 0 ? target : null;
}
function asService(target: ResolvedTarget | null): Extract<ResolvedTarget, { kind: "service" }> | null {
  return target !== null && target.kind === "service" ? target : null;
}
function asEndpoint(target: ResolvedTarget | null): Extract<ResolvedTarget, { kind: "endpoint" }> | null {
  return target !== null && target.kind === "endpoint" ? target : null;
}

/** Build a host query as an `or`-union of one exact-instance sub-expression per instance. */
function hostQuery(
  target: ResolvedTarget | null,
  aggregator: string,
  perInstance: (instanceSelector: string) => string,
): string {
  const host = asHost(target);
  if (host === null) return NEVER_MATCH;
  const union = host.instances.map((i) => perInstance(labelSelector("instance", i))).join(" or ");
  return `${aggregator}(${union})`;
}

const QUERY_BUILDERS: Readonly<Record<QueryId, QueryBuilder>> = {
  "estate.liveness": (target) => {
    const host = asHost(target);
    if (host !== null) {
      return `${hostQuery(target, "min", (selector) => `(up{${selector}} or pulse_agent_up{${selector}})`)} or vector(0/0)`;
    }
    const service = asService(target);
    if (service !== null) {
      const labels = `${labelSelector("host", service.host ?? "")},${labelSelector("service", service.service)}`;
      return `max(pulse_deep_health_up{${labels}} or pulse_backup_freshness_up{${labels}}) or vector(0/0)`;
    }
    return "min(up or pulse_agent_up or pulse_deep_health_up) or vector(0/0)";
  },
  "alerts.firing": () =>
    'sum by (alertname, severity, host, service, instance) (ALERTS{alertstate="firing"})',
  "host.cpu.utilization": (t) =>
    hostQuery(t, "avg", (sel) => `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle",${sel}}[5m])))`),
  "host.memory.utilization": (t) =>
    hostQuery(t, "avg", (sel) => `100 * (1 - node_memory_MemAvailable_bytes{${sel}} / node_memory_MemTotal_bytes{${sel}})`),
  "host.disk.utilization": (t) =>
    hostQuery(t, "max", (sel) => `100 * (1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay",${sel}} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay",${sel}})`),
  "host.load.1m": (t) => hostQuery(t, "max", (sel) => `node_load1{${sel}}`),
  "endpoint.check.latency": (t) => {
    const endpoint = asEndpoint(t);
    if (endpoint === null) return NEVER_MATCH;
    return `1000 * avg(gatus_results_duration_seconds{${labelSelector("name", endpoint.endpointKey)}})`;
  },
  "service.deep-health": (t) => {
    const service = asService(t);
    if (service === null || service.deepHealthMetric === null) return NEVER_MATCH;
    return `max(${service.deepHealthMetric}{${labelSelector("service", service.service)}})`;
  },
  "service.backup-age": (t) => {
    const service = asService(t);
    if (service === null || service.backupAgeMetric === null) return NEVER_MATCH;
    return `max(${service.backupAgeMetric}{${labelSelector("service", service.service)}})`;
  },
  "engine.ingestion-rate": () => "sum(rate(vm_rows_inserted_total[5m]))",
  "engine.active-series": () => 'sum(vm_cache_entries{type="storage/tsid"})',
  "engine.disk-usage": () => "sum(vm_data_size_bytes)",
  "engine.notification-failures": () => "sum(rate(alertmanager_notifications_failed_total[5m]))",
  "engine.notification-latency": () =>
    "histogram_quantile(0.99, sum by (le) (rate(alertmanager_notification_latency_seconds_bucket[5m])))",
};

// ---------------------------------------------------------------------------
// Public binder (06 §1, §3–§7)
// ---------------------------------------------------------------------------

/**
 * Bind a curated history request into a safe server query (06 §3–§7). Validation order:
 * malformed/overlong id → `INVALID_REQUEST`; unknown id → `QUERY_NOT_FOUND` (checked before
 * any target lookup); target kind/relationship → `QUERY_NOT_APPLICABLE`/`TARGET_NOT_FOUND`;
 * range → `RANGE_UNSUPPORTED`/`INVALID_REQUEST`. PromQL is built only from pinned templates
 * after every check passes; no client-supplied query language is ever accepted.
 */
export function bindCuratedQuery(
  queryId: string,
  target: TargetIdentity | null,
  range: string | null,
  model: WebEstateModelV2,
): QueryBindResult {
  if (!isBoundedControlFreeId(queryId)) {
    return { ok: false, error: makeError("INVALID_REQUEST") };
  }
  if (!isQueryId(queryId)) {
    return { ok: false, error: makeError("QUERY_NOT_FOUND") };
  }

  const definition = QUERY_CATALOG[queryId];

  const resolved = resolveTarget(queryId, definition.targetKind, target, model);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const parsed = parseRange(range, definition);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const promql = QUERY_BUILDERS[queryId](resolved.target);

  return {
    ok: true,
    query: {
      queryId,
      target: resolved.target === null ? null : resolved.target.target,
      range: parsed.range,
      promql,
      unit: definition.unit,
      effectiveStepSeconds: parsed.effectiveStepSeconds,
    },
  };
}
