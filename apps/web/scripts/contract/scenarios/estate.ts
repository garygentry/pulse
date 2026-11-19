// Estate fixtures: typed `EstatePayload` literals around a rendered estate model, plus the real handler's not-ready body.

import type {
  CoverageEntry,
  WebChannel,
  WebCoverageArtifact,
  WebEstateHostBaseV2,
  WebEstateHostV2,
  WebEstateMetadata,
  WebEstateModelV2,
  WebEstateServiceV2,
  WebFindingsArtifact,
  WebProvenance,
  WebSuppressionInfo,
} from "@pulse/renderer";
import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import type {
  DataAvailability,
  DeclaredScrapeComparison,
  EstatePayload,
  EstateTargetState,
  HashId,
} from "@pulse/web-data/wire";

import { estateRoute } from "../../../src/server/routes/current.js";
import { bundleErrorBody, errorEnvelopeBody, responseBody, stubContext, stubRouteRequest } from "../stub-context.js";
import { jsonFixture, pad3, PLACEHOLDER } from "./common.js";
import type { ScenarioContext, ScenarioModule } from "./index.js";

const NODE_PORT = 9100;
const CHANNEL = "ops-chat";
const HOSTS_FILE = "hosts.yaml";
const SERVICES_FILE = "services.yaml";
const ESTATE_FILE = "estate.yaml";

const host = PLACEHOLDER.hostName;

function hostId(n: number): string {
  return `host:${host(n)}`;
}

function serviceName(n: number): string {
  return `svc-${pad3(n)}`;
}

/** Coverage and Gatus identity of a service: "<host>/<service>". */
function serviceKey(hostN: number, serviceN: number): string {
  return `${host(hostN)}/${serviceName(serviceN)}`;
}

function serviceId(hostN: number, serviceN: number): string {
  return `svc:${serviceKey(hostN, serviceN)}`;
}

function serviceUrl(n: number): string {
  return `https://${serviceName(n)}.example.com`;
}

/** Alertmanager-style fingerprint: 16 lower-case hex digits. */
function fingerprint(n: number): string {
  return n.toString(16).padStart(16, "0");
}

/** Source location of entry `index` of a top-level list, one entry every ten lines. */
function provenance(file: string, list: string, index: number): WebProvenance {
  return { file, path: `${list}[${index}]`, line: 2 + index * 10, col: 3 };
}

function current(ctx: ScenarioContext, source: DataAvailability["source"]): DataAvailability {
  return { state: "current", source, lastGoodAt: ctx.at(0), message: null };
}

/** A target with no live signal declared. */
const NOT_CONFIGURED = {
  state: "not-configured",
  source: "rendered-estate",
  lastGoodAt: null,
  message: null,
} satisfies DataAvailability;

/** Members every host class shares; `index` is the host's position in the model. */
function hostBase(
  n: number,
  index: number,
  extra: Pick<WebEstateHostBaseV2, "suppressed" | "expectedChurn" | "scrapeIntervalClass" | "scrapeTargets" | "artifacts">,
): Omit<WebEstateHostBaseV2, "collectionClass"> {
  return {
    name: host(n),
    addresses: [PLACEHOLDER.ipv4(n), PLACEHOLDER.ipv6(n)],
    drilldownId: hostId(n),
    provenance: provenance(HOSTS_FILE, "hosts", index),
    ...extra,
  };
}

/** Members every service shares; `index` is the service's position in the model. */
function serviceBase(
  hostN: number,
  serviceN: number,
  index: number,
): Pick<WebEstateServiceV2, "name" | "host" | "drilldownId" | "provenance"> {
  return {
    name: serviceName(serviceN),
    host: host(hostN),
    drilldownId: serviceId(hostN, serviceN),
    provenance: provenance(SERVICES_FILE, "services", index),
  };
}

function coverageEntry(
  kind: CoverageEntry["kind"],
  name: string,
  collectionClass: CoverageEntry["collectionClass"],
  artifacts: string[],
  suppressed: WebSuppressionInfo | null = null,
): CoverageEntry {
  return { kind, name, collectionClass, artifacts, suppressed };
}

const MANAGED_ARTIFACTS = (n: number): string[] => [
  "scrape/file_sd/managed-linux.json",
  `agent/${host(n)}.yaml`,
  "scrape/file_sd/managed-linux-command-exporter.json",
];
const HYPERVISOR_ARTIFACTS = ["scrape/file_sd/hypervisor-api.json"];
const NAS_ARTIFACTS = ["scrape/file_sd/nas-api.json"];
const PROBE_ARTIFACTS = ["scrape/file_sd/probe-only.json", "prober/config.yaml", "gatus/config.yaml"];
const GATUS_ARTIFACTS = ["gatus/config.yaml"];
const PROBER_ARTIFACTS = ["prober/config.yaml", "scrape/file_sd/prober.json"];

const EXCLUDED = { class: "excluded", rationale: "Decommissioned; kept for the record." } satisfies WebSuppressionInfo;
const KNOWN_EXPECTED = {
  class: "known-expected",
  rationale: "Runs only during the nightly batch window.",
} satisfies WebSuppressionInfo;
const EXPECTED_CHURN = {
  class: "expected-churn",
  rationale: "Rebuilt on every deploy.",
} satisfies WebSuppressionInfo;

const TYPICAL_METADATA = {
  name: PLACEHOLDER.estateName,
  domains: ["example.com", "example.net"],
  timezone: PLACEHOLDER.timezone,
  dnsResolver: PLACEHOLDER.ipv4(53),
  retention: "30d",
  schemaMajor: 1,
  deadman: { configured: true, kind: "secret-ref" },
} satisfies WebEstateMetadata;

const OPS_CHANNEL = {
  name: CHANNEL,
  kind: "chat",
  credential: { kind: "env", display: "${PULSE_CHAT_WEBHOOK}" },
  options: { room: "ops", notify: true, retries: 3 },
  provenance: provenance(ESTATE_FILE, "channels", 0),
} satisfies WebChannel;

/** One host of each collection class, in name order. */
function typicalHosts(): WebEstateHostV2[] {
  return [
    {
      ...hostBase(1, 0, {
        suppressed: null,
        expectedChurn: false,
        scrapeIntervalClass: "fast",
        scrapeTargets: [
          { job: "managed-linux", instance: `${PLACEHOLDER.ipv4(1)}:${NODE_PORT}` },
          { job: "managed-linux-command-exporter", instance: `${PLACEHOLDER.ipv4(1)}:9105` },
        ],
        artifacts: MANAGED_ARTIFACTS(1),
      }),
      collectionClass: "managed-linux",
      detail: {
        exporterPorts: [NODE_PORT],
        cadvisor: true,
        heartbeat: true,
        deliveryForm: "compose",
        commandSignals: [
          {
            name: "data-disk-used",
            output: "scalar",
            interval: "5m",
            command: "df --output=pcent /var/lib/pulse",
            credential: null,
            metric: "pulse_data_disk_used_percent",
            upMetric: "pulse_data_disk_up",
          },
          {
            name: "queue-stats",
            output: "exposition",
            interval: "1m",
            command: "/var/lib/pulse/bin/queue-stats --format prometheus",
            credential: null,
          },
        ],
      },
    },
    {
      ...hostBase(2, 1, {
        suppressed: null,
        expectedChurn: false,
        scrapeIntervalClass: null,
        scrapeTargets: [{ job: "hypervisor-api", instance: host(2) }],
        artifacts: HYPERVISOR_ARTIFACTS,
      }),
      collectionClass: "hypervisor-api",
      detail: {
        apiEndpoint: `https://${host(2)}:8006`,
        credential: { kind: "op", display: "op://vault/hypervisor/token" },
      },
    },
    {
      // A NAS declared without an API: both detail members are null together.
      ...hostBase(3, 2, {
        suppressed: null,
        expectedChurn: false,
        scrapeIntervalClass: null,
        scrapeTargets: [{ job: "nas-api", instance: `${PLACEHOLDER.ipv4(3)}:${NODE_PORT}` }],
        artifacts: NAS_ARTIFACTS,
      }),
      collectionClass: "nas-api",
      detail: { apiEndpoint: null, credential: null },
    },
    {
      ...hostBase(4, 3, {
        suppressed: null,
        expectedChurn: false,
        scrapeIntervalClass: null,
        scrapeTargets: [{ job: "probe-only", instance: host(4) }],
        artifacts: PROBE_ARTIFACTS,
      }),
      collectionClass: "probe-only",
      detail: { probe: { kind: "tcp", target: `${PLACEHOLDER.ipv4(4)}:22`, expect: null } },
    },
    {
      ...hostBase(5, 4, {
        suppressed: EXCLUDED,
        expectedChurn: true,
        scrapeIntervalClass: null,
        scrapeTargets: [],
        artifacts: [],
      }),
      collectionClass: "excluded",
      detail: {},
    },
  ] satisfies WebEstateHostV2[];
}

/** Four services in (host, name) order: deep health, backup freshness, undeclared signal, suppressed. */
function typicalServices(): WebEstateServiceV2[] {
  return [
    {
      ...serviceBase(1, 1, 0),
      managed: true,
      deepHealth: true,
      ingressUrl: serviceUrl(1),
      suppressed: null,
      kind: "http",
      gatusEndpoints: [serviceKey(1, 1)],
      artifacts: [...GATUS_ARTIFACTS, ...PROBER_ARTIFACTS],
      deepHealthDetail: {
        endpoint: `${serviceUrl(1)}/healthz`,
        metrics: ["db", "queue"],
        responseMapping: { db: "$.db.ok", queue: "$.queue.ok" },
        alertExpression: "db == 0 or queue == 0",
        hostLocal: false,
        credential: null,
      },
      backupFreshness: null,
      alerts: [{ type: "chat", failureThreshold: 3 }],
    },
    {
      ...serviceBase(1, 2, 1),
      managed: true,
      deepHealth: false,
      suppressed: null,
      kind: "database",
      gatusEndpoints: [],
      artifacts: PROBER_ARTIFACTS,
      deepHealthDetail: null,
      backupFreshness: { signal: "svc-002-backup", threshold: "26h", interval: "15m", hasCommand: true },
      alerts: [],
    },
    {
      ...serviceBase(2, 3, 2),
      managed: false,
      deepHealth: false,
      suppressed: null,
      kind: "vm",
      gatusEndpoints: [],
      artifacts: [],
      deepHealthDetail: null,
      backupFreshness: null,
      alerts: [],
    },
    {
      ...serviceBase(3, 4, 3),
      managed: false,
      deepHealth: false,
      ingressUrl: serviceUrl(4),
      suppressed: KNOWN_EXPECTED,
      kind: "http",
      gatusEndpoints: [serviceKey(3, 4)],
      artifacts: GATUS_ARTIFACTS,
      deepHealthDetail: null,
      backupFreshness: null,
      alerts: [{ type: "chat" }],
    },
  ] satisfies WebEstateServiceV2[];
}

function typicalModel(bundleId: HashId): WebEstateModelV2 {
  return {
    formatVersion: 2,
    bundleId,
    estate: TYPICAL_METADATA,
    hosts: typicalHosts(),
    services: typicalServices(),
    channels: [OPS_CHANNEL],
    routingOverrides: [
      { severity: "critical", channels: [CHANNEL], provenance: provenance(ESTATE_FILE, "routing_overrides", 0) },
    ],
    suppressions: [
      {
        target: serviceKey(3, 4),
        class: KNOWN_EXPECTED.class,
        rationale: KNOWN_EXPECTED.rationale,
        provenance: provenance(ESTATE_FILE, "suppressions", 0),
        resolves: [serviceId(3, 4)],
      },
    ],
  } satisfies WebEstateModelV2;
}

/** Coverage of the typical model: three buckets, each sorted by name. */
function typicalCoverage(bundleId: HashId): WebCoverageArtifact {
  return {
    formatVersion: 2,
    bundleId,
    covered: [
      coverageEntry("host", host(1), "managed-linux", MANAGED_ARTIFACTS(1)),
      coverageEntry("service", serviceKey(1, 1), "managed-linux", [...GATUS_ARTIFACTS, ...PROBER_ARTIFACTS]),
      coverageEntry("service", serviceKey(1, 2), "managed-linux", PROBER_ARTIFACTS),
      coverageEntry("host", host(2), "hypervisor-api", HYPERVISOR_ARTIFACTS),
      coverageEntry("host", host(3), "nas-api", NAS_ARTIFACTS),
      coverageEntry("host", host(4), "probe-only", PROBE_ARTIFACTS),
    ],
    gaps: [coverageEntry("service", serviceKey(2, 3), "hypervisor-api", [])],
    suppressed: [
      coverageEntry("service", serviceKey(3, 4), "nas-api", GATUS_ARTIFACTS, KNOWN_EXPECTED),
      coverageEntry("host", host(5), "excluded", [], EXCLUDED),
    ],
  } satisfies WebCoverageArtifact;
}

/** The typical model with live state for each of its targets, coverage, findings and scrape comparison. */
export async function typicalEstateBody(ctx: ScenarioContext): Promise<EstatePayload> {
  const bundleId = await ctx.hash({ fixture: "bundle" });
  const signals = current(ctx, "victoriametrics-signals");
  const checks = current(ctx, "gatus-statuses");
  return {
    generatedAt: ctx.at(0),
    estate: typicalModel(bundleId),
    liveTargets: [
      {
        target: { kind: "host", id: hostId(1) },
        name: host(1),
        state: "unhealthy",
        availability: signals,
        alertFingerprints: [fingerprint(1), fingerprint(4)],
      },
      { target: { kind: "host", id: hostId(2) }, name: host(2), state: "healthy", availability: signals, alertFingerprints: [] },
      { target: { kind: "host", id: hostId(3) }, name: host(3), state: "healthy", availability: signals, alertFingerprints: [] },
      { target: { kind: "host", id: hostId(4) }, name: host(4), state: "unknown", availability: checks, alertFingerprints: [] },
      {
        target: { kind: "host", id: hostId(5) },
        name: host(5),
        state: "not-configured",
        availability: NOT_CONFIGURED,
        alertFingerprints: [],
      },
      {
        target: { kind: "service", id: serviceId(1, 1) },
        name: serviceName(1),
        state: "unhealthy",
        availability: signals,
        alertFingerprints: [fingerprint(3)],
      },
      {
        target: { kind: "service", id: serviceId(1, 2) },
        name: serviceName(2),
        state: "healthy",
        availability: signals,
        alertFingerprints: [],
      },
      {
        target: { kind: "service", id: serviceId(2, 3) },
        name: serviceName(3),
        state: "not-configured",
        availability: NOT_CONFIGURED,
        alertFingerprints: [],
      },
      {
        target: { kind: "service", id: serviceId(3, 4) },
        name: serviceName(4),
        state: "healthy",
        availability: checks,
        alertFingerprints: [],
      },
    ],
    coverage: { availability: current(ctx, "rendered-estate"), value: typicalCoverage(bundleId) },
    findings: {
      availability: current(ctx, "rendered-estate"),
      value: {
        formatVersion: 2,
        bundleId,
        findings: [
          {
            severity: "warning",
            code: "web_url_userinfo_removed",
            file: SERVICES_FILE,
            path: "services[0].ingress_url",
            message: `Service ${serviceName(1)} ingress URL carried user info, which is removed from the web model.`,
            fix: "Move the credential out of the URL into a secret reference.",
          },
          {
            severity: "info",
            code: "web_sensitive_channel_option_omitted",
            file: ESTATE_FILE,
            path: "channels[0].options.token",
            message: `Channel ${CHANNEL} option 'token' is omitted from the web model.`,
            fix: "No action needed; move secrets to the channel credential to silence this note.",
          },
        ],
      },
    },
    declaredVersusScraped: {
      availability: current(ctx, "victoriametrics-targets"),
      value: [
        {
          drilldownId: hostId(1),
          scrapeTarget: `${PLACEHOLDER.ipv4(1)}:${NODE_PORT}`,
          state: "matched",
          message: `Declared scrape target ${PLACEHOLDER.ipv4(1)}:${NODE_PORT} (job managed-linux) was discovered.`,
          job: "managed-linux",
          health: "up",
        },
        {
          drilldownId: hostId(2),
          scrapeTarget: host(2),
          state: "missing",
          message: `Declared scrape target ${host(2)} (job hypervisor-api) was not discovered.`,
          job: "hypervisor-api",
        },
        {
          drilldownId: "",
          scrapeTarget: `${PLACEHOLDER.ipv4(9)}:${NODE_PORT}`,
          state: "unexpected",
          message: `Discovered scrape target ${PLACEHOLDER.ipv4(9)}:${NODE_PORT} (job managed-linux, ${PLACEHOLDER.ipv4(9)}) is not declared.`,
        },
        {
          drilldownId: "",
          scrapeTarget: `${PLACEHOLDER.ipv4(10)}:8428`,
          state: "engine",
          message: `Stack engine target ${PLACEHOLDER.ipv4(10)}:8428 (job victoriametrics) is expected and not an estate declaration.`,
        },
      ],
    },
  } satisfies EstatePayload;
}

/** A rendered estate that declares nothing, with the artifacts and scrape discovery unavailable. */
async function emptyBody(ctx: ScenarioContext): Promise<EstatePayload> {
  return {
    generatedAt: ctx.at(0),
    estate: {
      formatVersion: 2,
      bundleId: await ctx.hash({ fixture: "bundle" }),
      estate: {
        name: PLACEHOLDER.estateName,
        domains: [],
        timezone: PLACEHOLDER.timezone,
        dnsResolver: null,
        retention: null,
        schemaMajor: 1,
        deadman: { configured: true, kind: "plain" },
      },
      hosts: [],
      services: [],
      channels: [],
      routingOverrides: [],
      suppressions: [],
    },
    liveTargets: [],
    coverage: {
      availability: {
        state: "unavailable",
        source: "rendered-estate",
        lastGoodAt: null,
        message: "Coverage is unavailable; run `pulse render` to regenerate it.",
      },
      value: null,
    },
    findings: {
      availability: {
        state: "unavailable",
        source: "rendered-estate",
        lastGoodAt: null,
        message: "Findings are unavailable; run `pulse render` to regenerate them.",
      },
      value: null,
    },
    declaredVersusScraped: {
      availability: { state: "unavailable", source: "victoriametrics-targets", lastGoodAt: null, message: null },
      value: null,
    },
  } satisfies EstatePayload;
}

/** Hosts of every class with every nullable member set, in name order. */
function allOptionalHosts(): WebEstateHostV2[] {
  return [
    {
      ...hostBase(1, 0, {
        suppressed: EXPECTED_CHURN,
        expectedChurn: true,
        scrapeIntervalClass: "fast",
        scrapeTargets: [
          { job: "managed-linux", instance: `${PLACEHOLDER.ipv4(1)}:${NODE_PORT}` },
          { job: "managed-linux-exporters", instance: `${PLACEHOLDER.ipv4(1)}:9187` },
        ],
        artifacts: MANAGED_ARTIFACTS(1),
      }),
      collectionClass: "managed-linux",
      detail: {
        exporterPorts: [9187, 9216],
        cadvisor: true,
        heartbeat: true,
        deliveryForm: "systemd",
        commandSignals: [
          {
            name: "backup-age",
            output: "scalar",
            interval: "15m",
            command: "/var/lib/pulse/bin/backup-age --repo /var/lib/pulse/backups",
            credential: { kind: "env", display: "${PULSE_BACKUP_TOKEN}" },
            metric: "pulse_backup_age_seconds",
            upMetric: "pulse_backup_age_up",
            labels: { repo: "primary", tier: "nightly" },
          },
          {
            name: "queue-stats",
            output: "exposition",
            interval: "1m",
            command: "/var/lib/pulse/bin/queue-stats --format prometheus",
            credential: { kind: "op", display: "op://vault/queue/token" },
          },
        ],
      },
    },
    {
      ...hostBase(2, 1, {
        suppressed: KNOWN_EXPECTED,
        expectedChurn: false,
        scrapeIntervalClass: "slow",
        scrapeTargets: [{ job: "hypervisor-api", instance: host(2) }],
        artifacts: HYPERVISOR_ARTIFACTS,
      }),
      collectionClass: "hypervisor-api",
      detail: {
        apiEndpoint: `https://${host(2)}:8006`,
        credential: { kind: "op", display: "op://vault/hypervisor/token" },
      },
    },
    {
      ...hostBase(3, 2, {
        suppressed: KNOWN_EXPECTED,
        expectedChurn: false,
        scrapeIntervalClass: "slow",
        scrapeTargets: [{ job: "nas-api", instance: `${PLACEHOLDER.ipv4(3)}:${NODE_PORT}` }],
        artifacts: NAS_ARTIFACTS,
      }),
      collectionClass: "nas-api",
      detail: {
        apiEndpoint: `https://${host(3)}:5001`,
        credential: { kind: "env", display: "${PULSE_NAS_TOKEN}" },
      },
    },
    {
      ...hostBase(4, 3, {
        suppressed: KNOWN_EXPECTED,
        expectedChurn: false,
        scrapeIntervalClass: "slow",
        scrapeTargets: [{ job: "probe-only", instance: host(4) }],
        artifacts: PROBE_ARTIFACTS,
      }),
      collectionClass: "probe-only",
      detail: { probe: { kind: "http", target: `https://${host(4)}/healthz`, expect: "200" } },
    },
    {
      ...hostBase(5, 4, {
        suppressed: EXCLUDED,
        expectedChurn: true,
        scrapeIntervalClass: "slow",
        scrapeTargets: [],
        artifacts: [],
      }),
      collectionClass: "excluded",
      detail: {},
    },
  ] satisfies WebEstateHostV2[];
}

/** A service with every optional member present and every nullable member set. */
function allOptionalService(hostN: number, serviceN: number, index: number): WebEstateServiceV2 {
  return {
    ...serviceBase(hostN, serviceN, index),
    managed: true,
    deepHealth: true,
    ingressUrl: serviceUrl(serviceN),
    suppressed: EXPECTED_CHURN,
    kind: "http",
    gatusEndpoints: [serviceKey(hostN, serviceN)],
    artifacts: [...GATUS_ARTIFACTS, ...PROBER_ARTIFACTS],
    deepHealthDetail: {
      endpoint: `${serviceUrl(serviceN)}/healthz`,
      metrics: ["db", "queue"],
      responseMapping: { db: "$.db.ok", queue: "$.queue.ok" },
      alertExpression: "db == 0 or queue == 0",
      hostLocal: true,
      credential: { kind: "env", display: "${PULSE_HEALTH_TOKEN}" },
    },
    backupFreshness: {
      signal: `${serviceName(serviceN)}-backup`,
      threshold: "26h",
      interval: "15m",
      hasCommand: true,
    },
    alerts: [
      {
        type: "chat",
        enabled: true,
        failureThreshold: 3,
        successThreshold: 2,
        description: `${serviceName(serviceN)} health check`,
        sendOnResolved: true,
      },
    ],
  } satisfies WebEstateServiceV2;
}

/** Every optional member present and every nullable member set, across the model and the live sections. */
async function allOptionalBody(ctx: ScenarioContext): Promise<EstatePayload> {
  const bundleId = await ctx.hash({ fixture: "bundle" });
  const stale = (source: DataAvailability["source"], message: string): DataAvailability => ({
    state: "stale",
    source,
    lastGoodAt: ctx.at(-120),
    message,
  });
  const signals = stale("victoriametrics-signals", "VictoriaMetrics did not answer; showing the last good result.");
  const checks = stale("gatus-statuses", "Gatus did not answer; showing the last good result.");
  const rendered = stale("rendered-estate", "The rendered estate changed on disk; showing the loaded bundle.");
  const hostLive = (n: number, availability: DataAvailability, alert: number): EstateTargetState => ({
    target: { kind: "host", id: hostId(n) },
    name: host(n),
    state: "unhealthy",
    availability,
    alertFingerprints: [fingerprint(alert)],
  });
  const serviceLive = (hostN: number, serviceN: number, alert: number): EstateTargetState => ({
    target: { kind: "service", id: serviceId(hostN, serviceN) },
    name: serviceName(serviceN),
    state: "unhealthy",
    availability: signals,
    alertFingerprints: [fingerprint(alert)],
  });
  const serviceArtifacts = [...GATUS_ARTIFACTS, ...PROBER_ARTIFACTS];
  return {
    generatedAt: ctx.at(0),
    estate: {
      formatVersion: 2,
      bundleId,
      estate: TYPICAL_METADATA,
      hosts: allOptionalHosts(),
      services: [allOptionalService(1, 1, 0), allOptionalService(2, 2, 1)],
      channels: [OPS_CHANNEL],
      routingOverrides: [
        { severity: "critical", channels: [CHANNEL], provenance: provenance(ESTATE_FILE, "routing_overrides", 0) },
      ],
      suppressions: [
        {
          target: host(1),
          class: EXPECTED_CHURN.class,
          rationale: EXPECTED_CHURN.rationale,
          provenance: provenance(ESTATE_FILE, "suppressions", 0),
          resolves: [hostId(1), serviceId(1, 1)],
        },
      ],
    },
    liveTargets: [
      hostLive(1, signals, 1),
      hostLive(2, signals, 2),
      hostLive(3, signals, 3),
      hostLive(4, checks, 4),
      hostLive(5, checks, 5),
      serviceLive(1, 1, 6),
      serviceLive(2, 2, 7),
    ],
    coverage: {
      availability: rendered,
      value: {
        formatVersion: 2,
        bundleId,
        // The type lets an entry in any bucket carry a suppression, so each bucket shows one here.
        covered: [coverageEntry("host", host(1), "managed-linux", MANAGED_ARTIFACTS(1), EXPECTED_CHURN)],
        gaps: [coverageEntry("service", serviceKey(2, 2), "hypervisor-api", [], EXPECTED_CHURN)],
        suppressed: [
          coverageEntry("service", serviceKey(1, 1), "managed-linux", serviceArtifacts, EXPECTED_CHURN),
          coverageEntry("host", host(2), "hypervisor-api", HYPERVISOR_ARTIFACTS, KNOWN_EXPECTED),
          coverageEntry("host", host(3), "nas-api", NAS_ARTIFACTS, KNOWN_EXPECTED),
          coverageEntry("host", host(4), "probe-only", PROBE_ARTIFACTS, KNOWN_EXPECTED),
          coverageEntry("host", host(5), "excluded", [], EXCLUDED),
        ],
      },
    },
    findings: {
      availability: rendered,
      value: {
        formatVersion: 2,
        bundleId,
        findings: [
          {
            severity: "error",
            code: "missing_rationale",
            file: ESTATE_FILE,
            path: "suppressions[0].rationale",
            message: `Suppression of ${host(1)} has no rationale.`,
            fix: "Add a rationale that states why the target is suppressed.",
          },
          {
            severity: "warning",
            code: "inert_alert_binding",
            file: SERVICES_FILE,
            path: "services[1].alerts",
            message: `Service ${serviceName(2)} binds alerts that can never fire.`,
            fix: "Declare a signal the alerts can evaluate, or remove them.",
          },
        ],
      },
    },
    declaredVersusScraped: {
      availability: stale("victoriametrics-targets", "Scrape discovery did not answer; showing the last good result."),
      value: [
        {
          drilldownId: hostId(1),
          scrapeTarget: `${PLACEHOLDER.ipv4(1)}:${NODE_PORT}`,
          state: "matched",
          message: `Declared scrape target ${PLACEHOLDER.ipv4(1)}:${NODE_PORT} (job managed-linux) was discovered.`,
          job: "managed-linux",
          health: "up",
        },
        {
          drilldownId: hostId(3),
          scrapeTarget: `${PLACEHOLDER.ipv4(3)}:${NODE_PORT}`,
          state: "matched",
          message: `Declared scrape target ${PLACEHOLDER.ipv4(3)}:${NODE_PORT} (job nas-api) was discovered.`,
          job: "nas-api",
          health: "down",
        },
      ],
    },
  } satisfies EstatePayload;
}

/** The three capped collections exactly at their caps around an estate model that declares nothing. */
async function maxSizeBody(ctx: ScenarioContext): Promise<EstatePayload> {
  const limits = CONTRACT_LIMITS.estate;
  const bundleId = await ctx.hash({ fixture: "bundle" });
  const rendered = { state: "current", source: "rendered-estate", lastGoodAt: null, message: null } satisfies DataAvailability;
  const liveTargets = Array.from(
    { length: limits.liveTargets },
    (_, i) =>
      ({
        target: { kind: "host", id: `host:${i.toString(36)}` },
        name: i.toString(36),
        state: "unknown",
        availability: NOT_CONFIGURED,
        alertFingerprints: [],
      }) satisfies EstateTargetState,
  );
  const findings = Array.from(
    { length: limits.findings },
    () =>
      ({
        severity: "info",
        code: "wrong_type",
        file: "a",
        path: "",
        message: "a",
        fix: "a",
      }) satisfies WebFindingsArtifact["findings"][number],
  );
  const comparisons = Array.from(
    { length: limits.declaredVersusScraped },
    () => ({ drilldownId: "", scrapeTarget: null, state: "unknown", message: "a" }) satisfies DeclaredScrapeComparison,
  );
  return {
    generatedAt: ctx.at(0),
    estate: {
      formatVersion: 2,
      bundleId,
      estate: {
        name: "a",
        domains: [],
        timezone: PLACEHOLDER.timezone,
        dnsResolver: null,
        retention: null,
        schemaMajor: 1,
        deadman: { configured: true, kind: "plain" },
      },
      hosts: [],
      services: [],
      channels: [],
      routingOverrides: [],
      suppressions: [],
    },
    liveTargets,
    coverage: { availability: rendered, value: { formatVersion: 2, bundleId, covered: [], gaps: [], suppressed: [] } },
    findings: { availability: rendered, value: { formatVersion: 2, bundleId, findings } },
    declaredVersusScraped: {
      availability: { state: "current", source: "victoriametrics-targets", lastGoodAt: null, message: null },
      value: comparisons,
    },
  } satisfies EstatePayload;
}

export const estateScenarios: ScenarioModule = {
  group: "estate",
  operation: "GET /api/estate",
  async build(ctx) {
    const notReady = await responseBody(await estateRoute.handler(stubRouteRequest("/api/estate"), stubContext()), 503);
    return [
      jsonFixture(this, "typical", "response", 200, await typicalEstateBody(ctx)),
      jsonFixture(this, "empty", "response", 200, await emptyBody(ctx)),
      jsonFixture(this, "all-optional", "response", 200, await allOptionalBody(ctx)),
      jsonFixture(this, "max-size", "response", 200, await maxSizeBody(ctx)),
      jsonFixture(this, "error-not-ready", "error", 503, notReady),
      jsonFixture(this, "error-invalid-request", "error", 400, await errorEnvelopeBody("INVALID_REQUEST", 400)),
      jsonFixture(this, "bundle-error", "error", 503, await bundleErrorBody("missing")),
    ];
  },
};
