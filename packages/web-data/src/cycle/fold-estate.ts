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
import { hostLivenessJob, isHostLivenessSample } from "../wire/host-liveness.js";
import { DEFAULT_GATUS_STALE_SECONDS, effectiveData, sourceAvailability } from "./records.js";
import { candidateFromAlertLabels, resolveCandidate } from "./target-match.js";
import { ENGINE_SCRAPE_JOBS, scrapeInstanceSource, scrapeSeriesIdentity } from "../queries/series-identity.js";

/** The renderer host collection-class discriminant, derived from the model to avoid a core import. */
type CollectionClass = WebEstateHostV2["collectionClass"];

/** Colouring alert severities that force a target `unhealthy` when alert evidence is current. */
const COLOURING_SEVERITIES: ReadonlySet<string> = new Set(["critical", "warning"]);

/** The always-firing DeadMansSwitch canary; excluded from per-target attribution. */
const DEADMANS_SWITCH_ALERTNAME = "DeadMansSwitch" as const;

// ---------------------------------------------------------------------------
// Liveness helpers (mirroring the overview affirmative-liveness matrix)
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

/** A collision-free `job`/`instance` map key. */
function scrapeKey(job: string, instance: string): string {
  return `${job}\u0000${instance}`;
}

/**
 * A rendered `address:port` in the form {@link scrapeUrlAddress} produces. DNS names are
 * case-insensitive and `new URL().hostname` is always lowercase, so the host part is lowercased
 * (the port is digits) or a mixed-case rendered address would never match its own scrape URL.
 */
function normalizeRenderedAddress(address: string): string {
  return address.toLowerCase();
}

/**
 * The `host:port` a sanitized scrape URL connects to (default port by scheme), or null when there
 * is no URL or it does not parse. The host part is lowercase (WHATWG URL parsing lowercases it).
 */
function scrapeUrlAddress(scrapeUrl: string | null): string | null {
  if (scrapeUrl === null) return null;
  try {
    const url = new URL(scrapeUrl);
    const port = url.port !== "" ? url.port : url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
    const host = url.hostname.toLowerCase();
    return port === "" ? host : `${host}:${port}`;
  } catch {
    return null;
  }
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

  // Declared targets carry their post-relabel `job`/`instance` identity (issue #69): VM's targets
  // API reports labels AFTER relabeling, so a managed-linux target rendered as `10.0.0.5:9100` is
  // discovered as `instance="<host name>"` within its job. Several custom-exporter ports on one
  // host share that identity, so for a job whose instance comes from the host label the match
  // also requires the discovered scrape URL's `host:port` to equal the rendered target (the
  // targets source keeps the pre-relabel address there). Rows stay one per rendered target.
  interface Declared {
    readonly job: string;
    readonly instance: string;
    /** Rendered `address:port` to check against the scrape URL, or null for address-sourced jobs. */
    readonly address: string | null;
    readonly rendered: string;
    readonly drilldownId: string;
  }
  const declaredRows = new Map<string, Declared>();
  for (const host of inputs.model.hosts) {
    for (const target of host.scrapeTargets) {
      const rowKey = scrapeKey(target.job, target.instance);
      if (declaredRows.has(rowKey)) continue;
      const identity = scrapeSeriesIdentity(host.name, target);
      declaredRows.set(rowKey, {
        job: identity.job,
        instance: identity.instance,
        address: scrapeInstanceSource(target.job) === "host" ? normalizeRenderedAddress(target.instance) : null,
        rendered: target.instance,
        drilldownId: host.drilldownId,
      });
    }
  }

  if (availability.state !== "current" || !record.latest.result.ok) {
    const message = "Scrape discovery is unavailable; declared-versus-scraped drift cannot be determined.";
    const unknown = [...declaredRows.values()].map(({ rendered, drilldownId }): DeclaredScrapeComparison => ({
      drilldownId,
      scrapeTarget: rendered,
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

  const discovered = record.latest.result.data.map((target) => ({
    job: target.job,
    instance: target.instance,
    address: scrapeUrlAddress(target.scrapeUrl),
  }));
  const matches = (d: (typeof discovered)[number], r: Declared): boolean =>
    d.job === r.job &&
    d.instance === r.instance &&
    (r.address === null || d.address === null || d.address === r.address);
  const declared = [...declaredRows.values()];
  const rows: DeclaredScrapeComparison[] = [];
  for (const r of declared) {
    const matched = discovered.some((d) => matches(d, r));
    rows.push({
      drilldownId: r.drilldownId,
      scrapeTarget: r.rendered,
      state: matched ? "matched" : "missing",
      message: matched
        ? `Declared scrape target ${r.rendered} (job ${r.job}) was discovered.`
        : `Declared scrape target ${r.rendered} (job ${r.job}) was not discovered.`,
    });
  }
  const reported = new Set<string>();
  for (const d of discovered) {
    if (declared.some((r) => matches(d, r))) continue;
    const shown = d.address ?? d.instance;
    const key = scrapeKey(d.job, `${d.instance}\u0000${shown}`);
    if (reported.has(key)) continue;
    reported.add(key);
    const engine = ENGINE_SCRAPE_JOBS.has(d.job);
    rows.push({
      drilldownId: "",
      scrapeTarget: d.instance,
      state: engine ? "engine" : "unexpected",
      message: engine
        ? `Stack engine target ${d.instance} (job ${d.job}) is expected and not an estate declaration.`
        : `Discovered scrape target ${d.instance} (job ${d.job}, ${shown}) is not declared.`,
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
