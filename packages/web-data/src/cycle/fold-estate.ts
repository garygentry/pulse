// packages/web-data/src/cycle/fold-estate.ts — the pure estate fold
// (04-cycle-and-current-view-folds.md §9). Joins the captured, already-validated rendered
// estate model with current target/check/alert evidence, preserving provenance and
// renderer-safe credential references exactly as rendered (they are never resolved). It
// never reads estate YAML or reconstructs a missing declaration — the model is passed
// through verbatim.
//
// `liveTargets` carries one `EstateTargetState` per rendered host and service in model
// order, joined with liveness evidence and attributed Alertmanager fingerprints. Coverage
// and findings are optional artifacts surfaced through `AvailabilitySection`: present →
// current value; absent → unavailable with explicit re-render guidance. The single
// declared-versus-scraped section becomes unavailable/unknown with VM-target source context
// when scrape discovery is not current — a discovery failure is never reported as no-drift.
//
// Never-silent-green: a target is `healthy` only with an affirmative current liveness signal
// from a currently-successful governing source and current alert evidence; stale or missing
// governing evidence yields `unknown`/`unhealthy`, never `healthy`. `generatedAt` is body
// materialization time. The fold is pure: it reads only its inputs and makes no source call.

import type { AvailabilitySection, DataAvailability, HealthState } from "../wire/common.js";
import type {
  DeclaredScrapeComparison,
  EstatePayload,
  EstateTargetState,
} from "../wire/estate.js";
import type { TargetIdentity } from "../wire/history.js";
import type { MetricSample } from "../sources/vm.js";
import type { AlertmanagerAlert } from "../sources/alertmanager.js";
import type { GatusCheckResult, GatusEndpointState } from "../sources/gatus.js";
import type {
  WebCoverageArtifact,
  WebEstateHostV2,
  WebEstateServiceV2,
  WebFindingsArtifact,
} from "@pulse/renderer";
import type { FoldInputs } from "./records.js";
import { DEFAULT_GATUS_STALE_SECONDS, effectiveData, sourceAvailability } from "./records.js";
import { candidateFromAlertLabels, resolveCandidate } from "./target-match.js";

/** The renderer host collection-class discriminant, derived from the model to avoid a core import. */
type CollectionClass = WebEstateHostV2["collectionClass"];

/** Colouring alert severities that force a target `unhealthy` when alert evidence is current. */
const COLOURING_SEVERITIES: ReadonlySet<string> = new Set(["critical", "warning"]);

/** The always-firing DeadMansSwitch canary; excluded from per-target attribution. */
const DEADMANS_SWITCH_ALERTNAME = "DeadMansSwitch" as const;

// ---------------------------------------------------------------------------
// Liveness helpers (mirroring the overview affirmative-liveness matrix)
// ---------------------------------------------------------------------------

/** True iff any sample with `projection` carries `host=<host>` and value `1`. */
function hasLive(series: readonly MetricSample[], projection: string, host: string): boolean {
  return series.some(
    (s) => s.projection === projection && s.metric["host"] === host && s.value === 1,
  );
}

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

/** Governing-source flags and current data captured once for the whole fold. */
interface EstateContext {
  readonly metricsOk: boolean;
  readonly checksOk: boolean;
  readonly alertsOk: boolean;
  /** Current live series (empty when metrics failed). */
  readonly liveSeries: readonly MetricSample[];
  /** Current Gatus states used for liveness (empty when checks failed). */
  readonly liveCheckStates: readonly GatusEndpointState[];
  readonly now: Date;
  readonly staleSeconds: number;
}

/** Affirmative liveness for a host (null when the governing source is not current, or no signal). */
function evaluateHostLiveness(host: WebEstateHostV2, ctx: EstateContext): boolean | null {
  const cls: CollectionClass = host.collectionClass;
  if (cls === "managed-linux") {
    if (!ctx.metricsOk) return null;
    return (
      hasLive(ctx.liveSeries, "pulse_agent_up", host.name) || hasLive(ctx.liveSeries, "up", host.name)
    );
  }
  if (cls === "hypervisor-api" || cls === "nas-api") {
    if (!ctx.metricsOk) return null;
    return hasLive(ctx.liveSeries, "up", host.name);
  }
  if (cls === "probe-only") {
    if (!ctx.checksOk) return null;
    return gatusAlive(ctx.liveCheckStates, `host:${host.name}`, ctx.now, ctx.staleSeconds);
  }
  return null; // "excluded" — no signal by design.
}

/** Affirmative liveness for a service; deep-health takes precedence over ingress freshness. */
function evaluateServiceLiveness(service: WebEstateServiceV2, ctx: EstateContext): boolean | null {
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
    return gatusAlive(ctx.liveCheckStates, `${service.host}/${service.name}`, ctx.now, ctx.staleSeconds);
  }
  return null; // no signal declared → structurally unknown/not-configured.
}

/** The governing liveness availability for a host, given its class. */
function hostLivenessAvailability(host: WebEstateHostV2, inputs: FoldInputs): DataAvailability {
  const cls = host.collectionClass;
  if (cls === "probe-only") {
    return sourceAvailability(inputs.records["gatus-statuses"], "gatus-statuses");
  }
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

/**
 * Resolve a target's {@link HealthState} from governing liveness, alert evidence, and
 * suppression. A `not-configured` governing availability (excluded/no-signal) is
 * `not-configured`; suppression is `not-configured`; non-current governing evidence or
 * missing alert evidence is `unknown` (never `healthy`); a current colouring alert is
 * `unhealthy`; an affirmative current liveness signal is `healthy`; anything else is
 * `unknown`.
 */
function resolveHealth(p: {
  readonly suppressed: boolean;
  readonly availability: DataAvailability;
  readonly alertsOk: boolean;
  readonly hasColouringAlert: boolean;
  readonly live: boolean | null;
}): HealthState {
  if (p.suppressed) return "not-configured";
  if (p.availability.state === "not-configured") return "not-configured";
  if (p.availability.state !== "current") return "unknown";
  if (!p.alertsOk) return "unknown";
  if (p.hasColouringAlert) return "unhealthy";
  return p.live === true ? "healthy" : "unknown";
}

// ---------------------------------------------------------------------------
// Alert attribution
// ---------------------------------------------------------------------------

/** Composite service key — space separator (no declared name contains a space in this join). */
function targetKey(kind: "host" | "service", host: string, service?: string): string {
  return kind === "host" ? `host:${host}` : `svc:${host}/${service ?? ""}`;
}

/** Attributed alert evidence per declared target: firing colouring severities and all fingerprints. */
interface AttributedAlerts {
  /** Target keys with at least one current colouring (critical/warning) firing alert. */
  readonly colouring: ReadonlySet<string>;
  /** All attributed alert fingerprints per target key, in stable order. */
  readonly fingerprints: ReadonlyMap<string, string[]>;
}

/** Attribute effective AM alerts to declared targets by the identity convention. */
function attributeAlerts(
  inputs: FoldInputs,
  alerts: readonly AlertmanagerAlert[],
): AttributedAlerts {
  const colouring = new Set<string>();
  const fingerprints = new Map<string, string[]>();
  for (const alert of alerts) {
    if (alert.name === DEADMANS_SWITCH_ALERTNAME) continue;
    const resolved = resolveCandidate(inputs.model, candidateFromAlertLabels(alert.labels));
    if (resolved === null) continue;
    const key =
      resolved.kind === "service"
        ? targetKey("service", resolved.host, resolved.service)
        : targetKey("host", resolved.host);
    (fingerprints.get(key) ?? fingerprints.set(key, []).get(key)!).push(alert.fingerprint);
    if (alert.state === "firing" && COLOURING_SEVERITIES.has(alert.severity)) colouring.add(key);
  }
  for (const list of fingerprints.values()) {
    list.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
  return { colouring, fingerprints };
}

// ---------------------------------------------------------------------------
// Target builders
// ---------------------------------------------------------------------------

/** Build one host {@link EstateTargetState}. */
function buildHostTarget(
  host: WebEstateHostV2,
  ctx: EstateContext,
  inputs: FoldInputs,
  attributed: AttributedAlerts,
): EstateTargetState {
  const key = targetKey("host", host.name);
  const availability = hostLivenessAvailability(host, inputs);
  const live = evaluateHostLiveness(host, ctx);
  const state = resolveHealth({
    suppressed: host.suppressed !== null,
    availability,
    alertsOk: ctx.alertsOk,
    hasColouringAlert: attributed.colouring.has(key),
    live,
  });
  const target: TargetIdentity = { kind: "host", id: host.drilldownId };
  return {
    target,
    name: host.name,
    state,
    availability,
    alertFingerprints: attributed.fingerprints.get(key) ?? [],
  };
}

/** Build one service {@link EstateTargetState}. */
function buildServiceTarget(
  service: WebEstateServiceV2,
  ctx: EstateContext,
  inputs: FoldInputs,
  attributed: AttributedAlerts,
): EstateTargetState {
  const key = targetKey("service", service.host, service.name);
  const availability = serviceLivenessAvailability(service, inputs);
  const live = evaluateServiceLiveness(service, ctx);
  const state = resolveHealth({
    suppressed: service.suppressed !== null,
    availability,
    alertsOk: ctx.alertsOk,
    hasColouringAlert: attributed.colouring.has(key),
    live,
  });
  const target: TargetIdentity = { kind: "service", id: service.drilldownId };
  return {
    target,
    name: `${service.host}/${service.name}`,
    state,
    availability,
    alertFingerprints: attributed.fingerprints.get(key) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Optional artifacts and declared-versus-scraped comparison
// ---------------------------------------------------------------------------

/** Coverage availability section: present artifact → current value; absent → unavailable with guidance. */
function buildCoverage(inputs: FoldInputs): AvailabilitySection<WebCoverageArtifact> {
  if (inputs.coverage === null) {
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
  return {
    availability: { state: "current", source: "rendered-estate", lastGoodAt: inputs.observedAt, message: null },
    value: inputs.coverage,
  };
}

/** Findings availability section: present artifact → current value; absent → unavailable with guidance. */
function buildFindings(inputs: FoldInputs): AvailabilitySection<WebFindingsArtifact> {
  if (inputs.findings === null) {
    return {
      availability: {
        state: "unavailable",
        source: "rendered-estate",
        lastGoodAt: null,
        message: "Findings are unavailable; run `pulse render` to regenerate them.",
      },
      value: null,
    };
  }
  return {
    availability: { state: "current", source: "rendered-estate", lastGoodAt: inputs.observedAt, message: null },
    value: inputs.findings,
  };
}

/**
 * Build independently actionable declared-versus-scraped rows from VM scrape discovery.
 * A non-current source yields explicit unknown rows (never an implied clean result); a current
 * source emits one row per declared target plus one per unexpected discovered target.
 */
function buildDeclaredVersusScraped(
  inputs: FoldInputs,
): AvailabilitySection<readonly DeclaredScrapeComparison[]> {
  const record = inputs.records["victoriametrics-targets"];
  const availability = sourceAvailability(record, "victoriametrics-targets");

  const declared = new Map<string, string>();
  for (const host of inputs.model.hosts) {
    for (const target of host.scrapeTargets) {
      if (!declared.has(target.instance)) declared.set(target.instance, host.drilldownId);
    }
  }

  if (availability.state !== "current" || !record.latest.result.ok) {
    const message = "Scrape discovery is unavailable; declared-versus-scraped drift cannot be determined.";
    const unknown = [...declared].map(([instance, drilldownId]): DeclaredScrapeComparison => ({
      drilldownId,
      scrapeTarget: instance,
      state: "unknown",
      message,
    }));
    return {
      availability,
      value: unknown.length > 0
        ? unknown
        : [{ drilldownId: "", scrapeTarget: null, state: "unknown", message }],
    };
  }

  const discovered = new Set(record.latest.result.data.map((target) => target.instance));
  const rows: DeclaredScrapeComparison[] = [];
  for (const [instance, drilldownId] of declared) {
    const matched = discovered.has(instance);
    rows.push({
      drilldownId,
      scrapeTarget: instance,
      state: matched ? "matched" : "missing",
      message: matched
        ? `Declared scrape target ${instance} was discovered.`
        : `Declared scrape target ${instance} was not discovered.`,
    });
  }
  for (const instance of discovered) {
    if (declared.has(instance)) continue;
    rows.push({
      drilldownId: "",
      scrapeTarget: instance,
      state: "unexpected",
      message: `Discovered scrape target ${instance} is not declared.`,
    });
  }

  return { availability, value: rows };
}

// ---------------------------------------------------------------------------
// The estate fold
// ---------------------------------------------------------------------------

/**
 * Fold the captured model and source records into the estate view payload (§9). Passes the
 * validated rendered model through verbatim (preserving provenance and renderer-safe
 * credential references, which are never resolved), joins every rendered host and service
 * with current liveness and attributed alert evidence in model order, surfaces optional
 * coverage/findings artifacts through availability sections, and derives directional
 * declared-versus-scraped rows that become `unknown` on scrape-discovery failure.
 * Pure and total over valid inputs; never-silent-green; performs no source or history call.
 *
 * @param inputs - The captured model/artifacts, source records, and stamping metadata.
 * @returns The materialized {@link EstatePayload}.
 */
export function foldEstate(inputs: FoldInputs): EstatePayload {
  const { model, records } = inputs;

  const metricsOk = records["victoriametrics-signals"].latest.result.ok;
  const checksOk = records["gatus-statuses"].latest.result.ok;
  const alertsOk = records["alertmanager-alerts"].latest.result.ok;

  const ctx: EstateContext = {
    metricsOk,
    checksOk,
    alertsOk,
    liveSeries: metricsOk ? records["victoriametrics-signals"].latest.result.data : [],
    liveCheckStates: checksOk ? records["gatus-statuses"].latest.result.data : [],
    now: new Date(inputs.observedAt),
    staleSeconds: inputs.overview?.gatusStaleSeconds ?? DEFAULT_GATUS_STALE_SECONDS,
  };

  const attributed = attributeAlerts(inputs, effectiveData(records["alertmanager-alerts"])?.data ?? []);

  const liveTargets: EstateTargetState[] = [
    ...model.hosts.map((host) => buildHostTarget(host, ctx, inputs, attributed)),
    ...model.services.map((service) => buildServiceTarget(service, ctx, inputs, attributed)),
  ];

  return {
    generatedAt: inputs.observedAt,
    estate: model,
    liveTargets,
    coverage: buildCoverage(inputs),
    findings: buildFindings(inputs),
    declaredVersusScraped: buildDeclaredVersusScraped(inputs),
  };
}
