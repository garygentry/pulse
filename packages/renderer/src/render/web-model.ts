// packages/renderer/src/render/web-model.ts
import type {
  BackupFreshness,
  Channel,
  ChannelKind,
  CollectionClass,
  CommandSignal,
  DeepHealthProbe,
  EndpointAlert,
  EstateModel,
  Finding,
  FindingCode,
  Host,
  Provenance,
  RoutingOverride,
  Service,
  Suppression,
  SuppressionClass,
  SuppressionMark,
} from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

import type { BundleId } from "./web-artifacts.js";
import type { ArtifactIndex } from "./artifact-index.js";
import type { WebProjectionResult, WebSafetyContext } from "./web-safety.js";
import {
  projectCredential,
  projectProvenance,
  sanitizeChannelOptions,
  sanitizeUrl,
} from "./web-safety.js";
import { displayPosixArgv } from "./web-command.js";
import { DEFAULT_BACKUP_INTERVAL } from "./command-exporter.js";
import type { SuppressionInfo } from "../coverage.js";
import { compareString } from "../order.js";
import { toCanonicalJson } from "../format.js";
import { RENDER_FORMAT_VERSION } from "../manifest.js";
import type { EmitResult } from "./emit-result.js";

/** A deep-link id convention for web-app drilldowns: `"host:<name>"` or `"svc:<host>/<name>"`. */
export type DrilldownId = string;

/** One declared host as the web overview sees it. */
export interface WebEstateHost {
  /** Host identity (unique across the estate). */
  name: string;
  /** The host's fixed collection class. */
  collectionClass: CollectionClass;
  /** Declared reachable addresses (hostname/IP). */
  addresses: string[];
  /** Deliberate suppression, or `null` when actively monitored. */
  suppressed: SuppressionInfo | null;
  /** Stable id for web-app deep-links, e.g. `"host:<name>"`. */
  drilldownId: DrilldownId;
}

/** One declared service as the web overview sees it. */
export interface WebEstateService {
  /** Service identity (unique across the estate). */
  name: string;
  /** Owning host name (resolves against `hosts[].name`). */
  host: string;
  /** Whether Pulse manages this service's lifecycle. */
  managed: boolean;
  /** True iff a deep-health probe is declared for this service. */
  deepHealth: boolean;
  /** Ingress URL that drives end-to-end checks, when declared. */
  ingressUrl?: string;
  /** Deliberate suppression, or `null` when actively monitored. */
  suppressed: SuppressionInfo | null;
  /** Stable id for web-app deep-links, e.g. `"svc:<host>/<name>"`. */
  drilldownId: DrilldownId;
}

/**
 * The rendered `web-estate-model.json` artifact (REQ-WEM-01). Data, not UI. Leaks no
 * provenance, credentials, or routing — only what the grid needs. `formatVersion` mirrors
 * `.rendered-manifest.json` (REQ-RND-10) so a consumer asserts compatibility once.
 */
export interface WebEstateModel {
  /** Static integer; equals RENDER_FORMAT_VERSION; asserted by web-app. */
  formatVersion: number;
  /** Estate identity for the grid header. */
  estate: { name: string; domains: string[] };
  /** All declared hosts, sorted by `name` (raw code-point). */
  hosts: WebEstateHost[];
  /** All declared services, sorted by `host` then `name`. */
  services: WebEstateService[];
}

// ---------------------------------------------------------------------------
// rendered-model-v2 shared contracts (00-core-definitions.md §§1.3, 2)
//
// The v2 strict-superset model, safe source/credential projections, and per-class
// detail shapes. These are FROZEN compile-time declarations for items 003–010; the v1
// runtime above (buildWebEstateModel / emitWebEstateModelFile / WebEstateModel) stays
// authoritative until item 010 flips emission. `WebEstateModel` is NOT yet aliased to the
// v2 model to preserve current render output; that alias lands with the item-010 cutover.
// ---------------------------------------------------------------------------

/** Estate-root-relative source location safe for browser display (00 §1.3). */
export interface WebProvenance {
  /** Non-empty estate-root-relative POSIX path; never absolute and never escaping. */
  file: string;
  /** Source field path, e.g. `hosts[0].name`. */
  path: string;
  /** One-based source line. */
  line: number;
  /** One-based source column. */
  col: number;
}

/** Display-only credential reference. It is never resolved by the renderer or web app (00 §1.3). */
export interface WebCredentialReference {
  /** Credential provider represented by the display value. */
  kind: "env" | "op";
  /** `${NAME}` or complete `op://vault/item/field` reference. */
  display: string;
}

/** One rendered scrape identity used for explicit joins (00 §1.3). */
export interface WebScrapeTarget {
  /** Renderer job label; non-empty. */
  job: string;
  /** Renderer instance label; non-empty. */
  instance: string;
}

/** Deliberate suppression attached to a model or coverage entity (00 §1.3). */
export interface WebSuppressionInfo {
  /** Closed core suppression class. */
  class: SuppressionClass;
  /** Mandatory non-empty operator rationale. */
  rationale: string;
}

/** Complete v2 web estate artifact (00 §2). */
export interface WebEstateModelV2 {
  /** Literal format transition boundary. */
  formatVersion: 2;
  /** Shared deterministic identity carried by all three web artifacts. */
  bundleId: BundleId;
  /** Estate-level safe declaration metadata. */
  estate: WebEstateMetadata;
  /** Every host, sorted by raw code-point `name`. */
  hosts: WebEstateHostV2[];
  /** Every service, sorted by `(host, name)`. */
  services: WebEstateServiceV2[];
  /** Every notification channel, sorted by `name`. */
  channels: WebChannel[];
  /** Severity routing overrides in stable order. */
  routingOverrides: WebRoutingOverride[];
  /** Standalone suppressions in stable order. */
  suppressions: WebStandaloneSuppression[];
}

/** Safe estate metadata exposed to the web application (00 §2). */
export interface WebEstateMetadata {
  /** Estate display name. */
  name: string;
  /** Declared domains, sorted by raw code point. */
  domains: string[];
  /** Authoritative IANA timezone from the estate. */
  timezone: string;
  /** Declared DNS resolver, or `null` when absent. */
  dnsResolver: string | null;
  /** Declared retention target, or `null` when absent. */
  retention: string | null;
  /** Validated source schema major. */
  schemaMajor: number;
  /** Presence-only deadman declaration; hook text is never copied. */
  deadman: WebDeadmanMetadata;
}

/** Non-secret deadman declaration metadata (00 §2). */
export interface WebDeadmanMetadata {
  /** Always true for the current validated core contract; explicit for forwards compatibility. */
  configured: boolean;
  /** Whether the declaration was a SecretRef or a plain identifier. */
  kind: "secret-ref" | "plain";
}

/** Fields common to every host class (00 §2). */
export interface WebEstateHostBaseV2 {
  /** Existing v1 host identity. */
  name: string;
  /** Existing v1 collection-class discriminant. */
  collectionClass: CollectionClass;
  /** Existing v1 addresses array. */
  addresses: string[];
  /** Existing v1 suppression projection. */
  suppressed: WebSuppressionInfo | null;
  /** Existing v1 drilldown identity. */
  drilldownId: DrilldownId;
  /** Explicit false when core omitted `expectedChurn`. */
  expectedChurn: boolean;
  /** Declared scrape interval class, or `null`. */
  scrapeIntervalClass: string | null;
  /** Safe declaration location. */
  provenance: WebProvenance;
  /** Explicit renderer scrape relationships; always present. */
  scrapeTargets: WebScrapeTarget[];
  /** Rendered-root-relative monitoring artifact paths; always present. */
  artifacts: string[];
}

/** Exactly one class-specific `detail` shape selected by `collectionClass` (00 §2). */
export type WebEstateHostV2 =
  | (WebEstateHostBaseV2 & {
      collectionClass: "managed-linux";
      detail: WebManagedLinuxDetail;
    })
  | (WebEstateHostBaseV2 & {
      collectionClass: "hypervisor-api";
      detail: WebHypervisorApiDetail;
    })
  | (WebEstateHostBaseV2 & {
      collectionClass: "nas-api";
      detail: WebNasApiDetail;
    })
  | (WebEstateHostBaseV2 & {
      collectionClass: "probe-only";
      detail: WebProbeOnlyDetail;
    })
  | (WebEstateHostBaseV2 & {
      collectionClass: "excluded";
      detail: Record<string, never>;
    });

/** Managed Linux collection declaration (00 §2). */
export interface WebManagedLinuxDetail {
  /** Declared exporter ports in ascending numeric order. */
  exporterPorts: number[];
  /** Whether cAdvisor collection is declared. */
  cadvisor: boolean;
  /** Whether heartbeat collection is declared. */
  heartbeat: boolean;
  /** Agent delivery form. */
  deliveryForm: "compose" | "systemd";
  /** Declared command signals in stable name order. */
  commandSignals: WebCommandSignal[];
}

/** Hypervisor API declaration (00 §2). */
export interface WebHypervisorApiDetail {
  /** Sanitized API endpoint. */
  apiEndpoint: string;
  /** Display-only credential reference. */
  credential: WebCredentialReference;
}

/** NAS API fields are both values or both null (00 §2). */
export type WebNasApiDetail =
  | { apiEndpoint: string; credential: WebCredentialReference }
  | { apiEndpoint: null; credential: null };

/** Probe-only host declaration (00 §2). */
export interface WebProbeOnlyDetail {
  /** Reachability probe declaration. */
  probe: {
    /** Opaque probe kind. */
    kind: string;
    /** Sanitized target. */
    target: string;
    /** Optional expected-response assertion. */
    expect: string | null;
  };
}

/** Fields shared by both display-safe command signal variants (00 §2). */
export interface WebCommandSignalBase {
  /** Signal identity. */
  name: string;
  /** Effective cadence. */
  interval: string;
  /** Deterministic POSIX-quoted argv display; never executed. */
  command: string;
  /** Display-only credential, or `null`. */
  credential: WebCredentialReference | null;
}

/** Output-discriminated command signal; exposition can never carry scalar fields (00 §2). */
export type WebCommandSignal =
  | (WebCommandSignalBase & {
      output: "scalar";
      /** Required scalar metric. */
      metric: string;
      /** Required scalar liveness metric. */
      upMetric: string;
      /** Declared labels; omitted when undeclared. */
      labels?: Record<string, string>;
    })
  | (WebCommandSignalBase & {
      output: "exposition";
    });

/** Complete strict-superset service record (00 §2). */
export interface WebEstateServiceV2 {
  /** Existing v1 service identity. */
  name: string;
  /** Existing v1 owner identity. */
  host: string;
  /** Existing v1 management state. */
  managed: boolean;
  /** Existing v1 boolean; never replaced by an object. */
  deepHealth: boolean;
  /** Existing optional ingress URL; omitted when undeclared. */
  ingressUrl?: string;
  /** Existing v1 suppression projection. */
  suppressed: WebSuppressionInfo | null;
  /** Existing v1 drilldown identity. */
  drilldownId: DrilldownId;
  /** Opaque service kind. */
  kind: string;
  /** Safe declaration location. */
  provenance: WebProvenance;
  /** Explicit Gatus endpoint identities; always present. */
  gatusEndpoints: string[];
  /** Explicit rendered-root-relative artifact paths; always present. */
  artifacts: string[];
  /** Detailed deep-health declaration, or `null` when `deepHealth` is false. */
  deepHealthDetail: WebDeepHealthDetail | null;
  /** Backup freshness declaration, or `null`. */
  backupFreshness: WebBackupFreshness | null;
  /** Endpoint alert declarations; always present. */
  alerts: WebEndpointAlert[];
}

/** Detailed deep-health declaration (00 §2). */
export interface WebDeepHealthDetail {
  /** Sanitized probe endpoint. */
  endpoint: string;
  /** Sorted response-mapping keys exposed as metric labels. */
  metrics: string[];
  /** Metric name to response JSON-path map. */
  responseMapping: Record<string, string>;
  /** Alert expression copied without evaluation. */
  alertExpression: string;
  /** Whether probing occurs on the service host. */
  hostLocal: boolean;
  /** Display-only credential, or `null`. */
  credential: WebCredentialReference | null;
}

/** Backup freshness declaration without command argv (00 §2). */
export interface WebBackupFreshness {
  /** Declared signal. */
  signal: string;
  /** Declared freshness threshold. */
  threshold: string;
  /** Effective interval (`"15m"` when core omitted it). */
  interval: string;
  /** Whether a delivery command was declared. */
  hasCommand: boolean;
}

/** Endpoint alert with omission-preserving optional members (00 §2). */
export interface WebEndpointAlert {
  /** Provider type. */
  type: string;
  /** Copied only when declared. */
  enabled?: boolean;
  /** Copied only when declared; positive integer. */
  failureThreshold?: number;
  /** Copied only when declared; positive integer. */
  successThreshold?: number;
  /** Copied only when declared. */
  description?: string;
  /** Copied only when declared. */
  sendOnResolved?: boolean;
}

/** Display-safe channel declaration (00 §2). */
export interface WebChannel {
  /** Channel identity. */
  name: string;
  /** Closed core channel kind. */
  kind: ChannelKind;
  /** Display-only credential reference. */
  credential: WebCredentialReference;
  /** Safe options after sensitive-key omission, or `null` when none remain/were declared. */
  options: Record<string, string | number | boolean> | null;
  /** Safe declaration location. */
  provenance: WebProvenance;
}

/** Severity-to-channel override (00 §2). */
export interface WebRoutingOverride {
  /** Opaque severity label. */
  severity: string;
  /** Resolved channel names in stable order. */
  channels: string[];
  /** Safe declaration location. */
  provenance: WebProvenance;
}

/** Standalone suppression and resolved affected entities (00 §2). */
export interface WebStandaloneSuppression {
  /** Original target identity. */
  target: string;
  /** Suppression class. */
  class: SuppressionClass;
  /** Mandatory rationale. */
  rationale: string;
  /** Safe declaration location. */
  provenance: WebProvenance;
  /** Resolved host/service drilldown IDs in stable order. */
  resolves: DrilldownId[];
}

/**
 * Map a core `SuppressionMark` to the shared `SuppressionInfo` (`00 §3.2`) used by both the web
 * model and coverage (`03`). Returns `null` for an actively-monitored entity (an absent mark).
 *
 * @param mark - The in-target suppression mark, or `undefined` when monitored.
 * @returns `{ class, rationale }` carried through, or `null` when `mark` is `undefined`.
 */
export function toSuppressionInfo(mark: SuppressionMark | undefined): SuppressionInfo | null {
  if (mark === undefined) return null;
  return { class: mark.class, rationale: mark.rationale };
}

/**
 * Build a lookup from an entity identity to its effective suppression (`02 §5.1`). An entity is
 * suppressed if it carries an in-target `SuppressionMark` (host `excluded` variant / service
 * `suppressed`) OR is named by a standalone `Suppression.target`. Keys use the same identity
 * convention as `drilldownId`: `"host:<name>"` / `"svc:<host>/<name>"`. In-target marks take
 * precedence over a standalone match on the same entity. Internal lookup only — never serialized,
 * so its iteration order never reaches output (REQ-RND-02). Deterministic; no I/O.
 *
 * Shared with `computeCoverage` (`03 §4`) so the web model and coverage stay in lockstep on
 * gaps-vs-suppressed.
 *
 * @param model - The validated estate.
 * @returns A map from entity identity → `SuppressionInfo`; an absent key ⇒ actively monitored.
 */
export function buildSuppressionIndex(model: EstateModel): Map<string, SuppressionInfo> {
  const index = new Map<string, SuppressionInfo>();

  // Standalone suppressions first; in-target marks below overwrite on any conflict.
  for (const suppression of model.suppressions) {
    const info: SuppressionInfo = {
      class: suppression.class,
      rationale: suppression.rationale,
    };
    for (const key of matchStandaloneTarget(model, suppression.target)) {
      index.set(key, info);
    }
  }

  // In-target marks: an `excluded` host's mandatory mark and a service's `suppressed` mark.
  for (const host of model.hosts) {
    if (host.collectionClass !== "excluded") continue;
    const info = toSuppressionInfo(host.suppressed);
    if (info !== null) index.set(`host:${host.name}`, info);
  }
  for (const service of model.services) {
    const info = toSuppressionInfo(service.suppressed);
    if (info !== null) index.set(`svc:${service.host}/${service.name}`, info);
  }

  return index;
}

/**
 * Resolve a standalone `Suppression.target` to the identity keys it suppresses. A target may name
 * a host by `name`, a service by its composite `"<host>/<name>"` id, or a service by its bare
 * `name` (matching coverage's composite-and-bare resolution, `03 §4`).
 */
function matchStandaloneTarget(model: EstateModel, target: string): string[] {
  const keys: string[] = [];
  for (const host of model.hosts) {
    if (host.name === target) keys.push(`host:${host.name}`);
  }
  for (const service of model.services) {
    const id = `${service.host}/${service.name}`;
    if (target === id || target === service.name) keys.push(`svc:${id}`);
  }
  return keys;
}

/**
 * Project a validated estate into the `WebEstateModel` artifact (REQ-WEM-01). Deterministic: hosts
 * sorted by `name`, services sorted by `host` then `name` (raw code-point). Stamps `formatVersion =
 * RENDER_FORMAT_VERSION` (REQ-RND-10). Leaks no provenance, credentials, timezone, `deadmanHook`,
 * or routing — only what the grid needs (`00 §4`).
 *
 * @param model - The validated estate.
 * @returns The in-memory `WebEstateModel` value (also serialized to `web-estate-model.json`).
 */
export function buildWebEstateModel(model: EstateModel): WebEstateModel {
  const index = buildSuppressionIndex(model);

  const hosts: WebEstateHost[] = model.hosts
    .map((host) => ({
      name: host.name,
      collectionClass: host.collectionClass,
      addresses: [...host.addresses],
      suppressed: index.get(`host:${host.name}`) ?? null,
      drilldownId: `host:${host.name}`,
    }))
    .sort((a, b) => compareString(a.name, b.name));

  const services: WebEstateService[] = model.services
    .map((service) => {
      const projected: WebEstateService = {
        name: service.name,
        host: service.host,
        managed: service.managed,
        deepHealth: service.deepHealth !== undefined,
        suppressed: index.get(`svc:${service.host}/${service.name}`) ?? null,
        drilldownId: `svc:${service.host}/${service.name}`,
      };
      // exactOptionalPropertyTypes: copy the key only when declared, never set `undefined`.
      if (service.ingressUrl !== undefined) projected.ingressUrl = service.ingressUrl;
      return projected;
    })
    .sort((a, b) => compareString(a.host, b.host) || compareString(a.name, b.name));

  return {
    formatVersion: RENDER_FORMAT_VERSION,
    estate: { name: model.estate.name, domains: [...model.estate.domains] },
    hosts,
    services,
  };
}

/**
 * Build `buildWebEstateModel(model)` and serialize it as the canonical JSON file
 * `web-estate-model.json` (`02 §6.2`). Called by `render` for the `web` kind (`02 §3`).
 *
 * @param model - The validated estate.
 * @returns Exactly one `RenderedFile` (`web-estate-model.json`); no findings.
 */
export function emitWebEstateModelFile(model: EstateModel): EmitResult {
  return {
    files: [
      { path: "web-estate-model.json", contents: toCanonicalJson(buildWebEstateModel(model)) },
    ],
    findings: [],
  };
}

// ---------------------------------------------------------------------------
// rendered-model-v2 strict-superset projection (02 §§2–11)
//
// `buildWebEstateModelFromIndex` is the internal coordinated-emitter seam; item 005 wires it into
// `web-artifacts.ts`. It consumes the SAME `ArtifactIndex` passed to `computeCoverageFromIndex`
// and the SAME `WebSafetyContext` used by the final three-artifact assertion, so the model,
// coverage, and the recursive guard can never disagree about relationships or withheld canaries
// (02 §2.1). It is PURE: no I/O, no mutation of the model, the index, or nested arrays/maps; it
// never serializes, computes a `bundleId`, or rebuilds the relationship index. Every set-like
// collection is deduplicated and sorted with the existing raw `compareString`; ordered data
// (addresses, argv) is preserved. The value omits only `bundleId` — item 005 stamps the shared ID
// after all three unstamped payloads exist.
// ---------------------------------------------------------------------------

/**
 * Project a validated estate into the strict-superset v2 model, minus its coordinated `bundleId`
 * (02 §2.1). Warnings (URL-userinfo removal, sensitive-option omission) accumulate on `safety`;
 * fatal provenance/invariant failures return `{ ok: false, findings }` with no partial model
 * (02 §10). On success the strict-v1 fields keep their exact names, JSON types, meanings, drilldown
 * identities, and ingress omission behavior (02 §2.1).
 *
 * @param model - A validated `EstateModel` (the projection defends invariants but does not revalidate).
 * @param index - The shared relationship index; every declared entity has an entry (02 §8.1).
 * @param safety - The shared safety context accumulating warnings and withheld canaries (02 §2.1).
 * @returns The projected model without `bundleId`, or a fatal result carrying only findings.
 */
export function buildWebEstateModelFromIndex(
  model: EstateModel,
  index: ArtifactIndex,
  safety: WebSafetyContext,
): WebProjectionResult<Omit<WebEstateModelV2, "bundleId">> {
  const suppression = buildSuppressionIndex(model);
  // Fatal (invariant/provenance) findings are collected separately from `safety.findings`
  // (which holds only sanitization warnings + canaries for the coordinated guard). We accumulate
  // every deterministic warning across all members, then fail if any fatal finding exists (02 §10).
  const fatals: Finding[] = [];

  const estate = projectEstateMetadata(model, safety);

  const hosts = model.hosts
    .map((host) => projectHost(host, index, suppression, safety, fatals))
    .filter((host): host is WebEstateHostV2 => host !== null)
    .sort((a, b) => compareString(a.name, b.name));

  const services = model.services
    .map((service) => projectService(service, index, suppression, safety, fatals))
    .filter((service): service is WebEstateServiceV2 => service !== null)
    .sort((a, b) => compareString(a.host, b.host) || compareString(a.name, b.name));

  const channels = model.channels
    .map((channel) => projectChannel(channel, safety, fatals))
    .filter((channel): channel is WebChannel => channel !== null)
    .sort((a, b) => compareString(a.name, b.name));

  const routingOverrides = model.routingOverrides
    .map((override) => projectRoutingOverride(override, fatals))
    .filter((override): override is WebRoutingOverride => override !== null)
    .sort(
      (a, b) =>
        compareString(a.severity, b.severity) ||
        // U+0000 frames the joined channel set for comparison only; it never reaches output.
        compareString(a.channels.join(" "), b.channels.join(" ")),
    );

  const suppressions = model.suppressions
    .map((entry) => projectStandaloneSuppression(model, entry, fatals))
    .filter((entry): entry is WebStandaloneSuppression => entry !== null)
    .sort(
      (a, b) =>
        compareString(a.target, b.target) ||
        compareString(a.class, b.class) ||
        compareString(a.rationale, b.rationale),
    );

  if (fatals.length > 0) {
    return { ok: false, findings: [...safety.findings, ...fatals] };
  }

  return {
    ok: true,
    value: {
      formatVersion: 2,
      estate,
      hosts,
      services,
      channels,
      routingOverrides,
      suppressions,
    },
    findings: [...safety.findings],
  };
}

/** Project estate-level metadata (02 §3). Presence-only deadman; a non-empty plain hook is added
 *  to the withheld canaries and never copied. Infallible: `WebEstateMetadata` carries no provenance. */
function projectEstateMetadata(model: EstateModel, safety: WebSafetyContext): WebEstateMetadata {
  const { estate, schemaMajor } = model;
  const hook = estate.deadmanHook;
  if (typeof hook === "string" && hook !== "") safety.canaries.add(hook);
  return {
    name: estate.name,
    domains: [...new Set(estate.domains)].sort(compareString),
    timezone: estate.timezone,
    dnsResolver: estate.dnsResolver ?? null,
    retention: estate.retention ?? null,
    schemaMajor,
    deadman: {
      configured: true,
      kind: typeof hook !== "string" ? "secret-ref" : "plain",
    },
  };
}

/** Project one host into exactly its class-specific v2 record (02 §§4.1–4.3). Returns `null` and
 *  records a fatal finding on unsafe provenance, a half-present NAS pair, or an unknown class. */
function projectHost(
  host: Host,
  index: ArtifactIndex,
  suppression: Map<string, SuppressionInfo>,
  safety: WebSafetyContext,
  fatals: Finding[],
): WebEstateHostV2 | null {
  const provenance = projectProvenanceOrFatal(host.provenance, fatals);
  if (provenance === null) return null;

  const relationships = index.hosts.get(host.name);
  const base: WebEstateHostBaseV2 = {
    name: host.name,
    collectionClass: host.collectionClass,
    addresses: [...host.addresses],
    suppressed: suppression.get(`host:${host.name}`) ?? null,
    drilldownId: `host:${host.name}`,
    expectedChurn: host.expectedChurn ?? false,
    scrapeIntervalClass: host.scrapeIntervalClass ?? null,
    provenance,
    scrapeTargets: (relationships?.scrapeTargets ?? []).map((target) => ({
      job: target.job,
      instance: target.instance,
    })),
    artifacts: [...(relationships?.artifacts ?? [])],
  };

  switch (host.collectionClass) {
    case "managed-linux":
      return {
        ...base,
        collectionClass: "managed-linux",
        detail: {
          exporterPorts: [...new Set(host.exporterPorts)].sort((a, b) => a - b),
          cadvisor: host.cadvisor,
          heartbeat: host.heartbeat,
          deliveryForm: host.deliveryForm,
          commandSignals: projectCommandSignals(host.commandSignals),
        },
      };
    case "hypervisor-api":
      return {
        ...base,
        collectionClass: "hypervisor-api",
        detail: {
          apiEndpoint: sanitizeUrl(host.apiEndpoint, provenance, safety),
          credential: projectCredential(host.credential),
        },
      };
    case "nas-api": {
      const hasEndpoint = host.apiEndpoint !== undefined;
      const hasCredential = host.credential !== undefined;
      if (hasEndpoint !== hasCredential) {
        fatals.push(
          invariantFinding(
            FINDING_CODES.INCOMPLETE_NAS_API,
            `hosts[${host.name}].detail`,
            "NAS API host declared only one of apiEndpoint/credential; the pair must be both or neither.",
          ),
        );
        return null;
      }
      const detail: WebNasApiDetail =
        host.apiEndpoint !== undefined && host.credential !== undefined
          ? {
              apiEndpoint: sanitizeUrl(host.apiEndpoint, provenance, safety),
              credential: projectCredential(host.credential),
            }
          : { apiEndpoint: null, credential: null };
      return { ...base, collectionClass: "nas-api", detail };
    }
    case "probe-only":
      return {
        ...base,
        collectionClass: "probe-only",
        detail: {
          probe: {
            kind: host.probe.kind,
            target: sanitizeUrl(host.probe.target, provenance, safety),
            expect: host.probe.expect ?? null,
          },
        },
      };
    case "excluded":
      // A newly allocated empty object; effective suppression stays in the common field (02 §4.3).
      return { ...base, collectionClass: "excluded", detail: {} };
    default: {
      const exhaustive: never = host;
      void exhaustive;
      fatals.push(
        invariantFinding(
          FINDING_CODES.INVALID_ENUM,
          "hosts[].collectionClass",
          "Host declared an unknown collection class.",
        ),
      );
      return null;
    }
  }
}

/** Project a host's command signals (02 §4.2): each maps `command` through `displayPosixArgv`, and
 *  the set is sorted by `(name, output, interval, command display)`. */
function projectCommandSignals(signals: readonly CommandSignal[]): WebCommandSignal[] {
  return signals.map(projectCommandSignal).sort(compareCommandSignal);
}

/** Project one command signal; absent credential maps to `null`; `labels` are copied only when
 *  declared, into a fresh object (02 §4.2). */
function projectCommandSignal(signal: CommandSignal): WebCommandSignal {
  const base: WebCommandSignalBase = {
    name: signal.name,
    interval: signal.interval,
    command: displayPosixArgv(signal.command),
    credential: signal.credential !== undefined ? projectCredential(signal.credential) : null,
  };
  if (signal.output === "scalar") {
    const scalar: Extract<WebCommandSignal, { output: "scalar" }> = {
      ...base,
      output: "scalar",
      metric: signal.metric,
      upMetric: signal.upMetric,
    };
    if (signal.labels !== undefined) scalar.labels = { ...signal.labels };
    return scalar;
  }
  return { ...base, output: "exposition" };
}

/** Stable command-signal order: `(name, output, interval, command display)` (02 §4.2). */
function compareCommandSignal(a: WebCommandSignal, b: WebCommandSignal): number {
  return (
    compareString(a.name, b.name) ||
    compareString(a.output, b.output) ||
    compareString(a.interval, b.interval) ||
    compareString(a.command, b.command)
  );
}

/** Project one service into its complete v2 record (02 §5). Returns `null` and records a fatal
 *  finding on unsafe provenance or a malformed alert threshold. */
function projectService(
  service: Service,
  index: ArtifactIndex,
  suppression: Map<string, SuppressionInfo>,
  safety: WebSafetyContext,
  fatals: Finding[],
): WebEstateServiceV2 | null {
  const provenance = projectProvenanceOrFatal(service.provenance, fatals);
  if (provenance === null) return null;

  const alerts = projectEndpointAlerts(service.alerts, fatals);
  if (alerts === null) return null;

  const id = `${service.host}/${service.name}`;
  const relationships = index.services.get(id);
  const projected: WebEstateServiceV2 = {
    name: service.name,
    host: service.host,
    managed: service.managed,
    deepHealth: service.deepHealth !== undefined,
    suppressed: suppression.get(`svc:${id}`) ?? null,
    drilldownId: `svc:${id}`,
    kind: service.kind,
    provenance,
    gatusEndpoints: [...(relationships?.gatusEndpoints ?? [])],
    artifacts: [...(relationships?.artifacts ?? [])],
    deepHealthDetail: projectDeepHealthDetail(service.deepHealth, provenance, safety),
    backupFreshness: projectBackupFreshness(service.backupFreshness),
    alerts,
  };
  // exactOptionalPropertyTypes: copy `ingressUrl` only when declared, never set `undefined`.
  if (service.ingressUrl !== undefined) {
    projected.ingressUrl = sanitizeUrl(service.ingressUrl, provenance, safety);
  }
  return projected;
}

/** Project deep-health detail (02 §5.2), or `null` when the service declares no probe. `metrics`
 *  are the unique raw-code-point-sorted keys of `responseMapping`; no mapping value is evaluated. */
function projectDeepHealthDetail(
  deepHealth: DeepHealthProbe | undefined,
  provenance: WebProvenance,
  safety: WebSafetyContext,
): WebDeepHealthDetail | null {
  if (deepHealth === undefined) return null;
  return {
    endpoint: sanitizeUrl(deepHealth.endpoint, provenance, safety),
    metrics: [...new Set(Object.keys(deepHealth.responseMapping))].sort(compareString),
    responseMapping: { ...deepHealth.responseMapping },
    alertExpression: deepHealth.alertExpression,
    hostLocal: deepHealth.hostLocal ?? false,
    credential:
      deepHealth.credential !== undefined ? projectCredential(deepHealth.credential) : null,
  };
}

/** Project backup freshness (02 §5.3), or `null` when absent. Command argv is never exposed. */
function projectBackupFreshness(backup: BackupFreshness | undefined): WebBackupFreshness | null {
  if (backup === undefined) return null;
  return {
    signal: backup.signal,
    threshold: backup.threshold,
    interval: backup.interval ?? DEFAULT_BACKUP_INTERVAL,
    hasCommand: backup.command !== undefined,
  };
}

/** Project endpoint alerts in declaration order, then stable-sort (02 §5.4). Optional members are
 *  copied only when their core property is declared. A non-positive/non-integer threshold on direct
 *  malformed input is a fatal invariant (returns `null`). */
function projectEndpointAlerts(
  alerts: readonly EndpointAlert[] | undefined,
  fatals: Finding[],
): WebEndpointAlert[] | null {
  const out: WebEndpointAlert[] = [];
  const source = alerts ?? [];
  for (let i = 0; i < source.length; i += 1) {
    const alert = source[i]!;
    const projected: WebEndpointAlert = { type: alert.type };
    if (alert.enabled !== undefined) projected.enabled = alert.enabled;
    if (alert.failureThreshold !== undefined) {
      if (!isPositiveInteger(alert.failureThreshold)) {
        fatals.push(
          invariantFinding(
            FINDING_CODES.WRONG_TYPE,
            `services[].alerts[${i}].failureThreshold`,
            "Endpoint alert failureThreshold must be a positive integer.",
          ),
        );
        return null;
      }
      projected.failureThreshold = alert.failureThreshold;
    }
    if (alert.successThreshold !== undefined) {
      if (!isPositiveInteger(alert.successThreshold)) {
        fatals.push(
          invariantFinding(
            FINDING_CODES.WRONG_TYPE,
            `services[].alerts[${i}].successThreshold`,
            "Endpoint alert successThreshold must be a positive integer.",
          ),
        );
        return null;
      }
      projected.successThreshold = alert.successThreshold;
    }
    if (alert.description !== undefined) projected.description = alert.description;
    if (alert.sendOnResolved !== undefined) projected.sendOnResolved = alert.sendOnResolved;
    out.push(projected);
  }
  return out.sort(compareEndpointAlert);
}

/** Stable endpoint-alert order (02 §5.4):
 *  `(type, description-or-empty, failureThreshold-or-0, successThreshold-or-0, enabled, sendOnResolved)`
 *  where a boolean orders absent < false < true. */
function compareEndpointAlert(a: WebEndpointAlert, b: WebEndpointAlert): number {
  return (
    compareString(a.type, b.type) ||
    compareString(a.description ?? "", b.description ?? "") ||
    (a.failureThreshold ?? 0) - (b.failureThreshold ?? 0) ||
    (a.successThreshold ?? 0) - (b.successThreshold ?? 0) ||
    boolRank(a.enabled) - boolRank(b.enabled) ||
    boolRank(a.sendOnResolved) - boolRank(b.sendOnResolved)
  );
}

/** Order an optional boolean by presence then value: absent (0) < false (1) < true (2). */
function boolRank(value: boolean | undefined): number {
  return value === undefined ? 0 : value ? 2 : 1;
}

/** Project one channel (02 §7.2): safe credential reference, sanitized options, safe provenance. */
function projectChannel(
  channel: Channel,
  safety: WebSafetyContext,
  fatals: Finding[],
): WebChannel | null {
  const provenance = projectProvenanceOrFatal(channel.provenance, fatals);
  if (provenance === null) return null;
  return {
    name: channel.name,
    kind: channel.kind,
    credential: projectCredential(channel.credential),
    options: sanitizeChannelOptions(channel.options, provenance, safety),
    provenance,
  };
}

/** Project one routing override (02 §7.2): unique raw-code-point-sorted channel names, safe provenance. */
function projectRoutingOverride(
  override: RoutingOverride,
  fatals: Finding[],
): WebRoutingOverride | null {
  const provenance = projectProvenanceOrFatal(override.provenance, fatals);
  if (provenance === null) return null;
  return {
    severity: override.severity,
    channels: [...new Set(override.channels)].sort(compareString),
    provenance,
  };
}

/** Project one standalone suppression (02 §7.3): human-readable target/class/rationale preserved,
 *  affected identities resolved by the same rules as the effective suppression index, deduped and
 *  raw-code-point sorted. An unmatched target keeps `resolves: []`. */
function projectStandaloneSuppression(
  model: EstateModel,
  suppression: Suppression,
  fatals: Finding[],
): WebStandaloneSuppression | null {
  const provenance = projectProvenanceOrFatal(suppression.provenance, fatals);
  if (provenance === null) return null;
  return {
    target: suppression.target,
    class: suppression.class,
    rationale: suppression.rationale,
    provenance,
    resolves: [...new Set(matchStandaloneTarget(model, suppression.target))].sort(compareString),
  };
}

/** Project provenance, recording a fatal `WEB_UNSAFE_PROVENANCE` finding (which never echoes the
 *  unsafe path) on failure and returning `null` (02 §7.1). */
function projectProvenanceOrFatal(provenance: Provenance, fatals: Finding[]): WebProvenance | null {
  const result = projectProvenance(provenance);
  if (!result.ok) {
    for (const finding of result.findings) fatals.push(finding);
    return null;
  }
  return result.value;
}

/** True iff `value` is a positive integer (`> 0`). */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** A fatal structured projection finding for a violated validated-model invariant (02 §10). The
 *  `file` sentinel and generic `path` never reproduce an unsafe source value. */
function invariantFinding(code: FindingCode, path: string, message: string): Finding {
  return {
    severity: "error",
    code,
    file: "<estate>",
    path,
    message,
    fix: "Re-render from a validated estate; this indicates a violated model invariant.",
  };
}
