// apps/web/tests/factories/estate-bundle.ts — complete, coherent v2 estate-bundle test factory
// (rendered-model-v2, 08-testing-strategy.md §4.3). Owned by rendered-model-v2. Produces a fully
// valid `WebEstateModelV2` covering every host discriminant, exact coverage recomputed from the
// model's relationships, a findings artifact carrying every severity, and canonical serialized bytes.
//
// `makeEstateBundleFixture()` is the coherent baseline every validation mutation test starts from;
// `cloneJson` isolates each row so one test cannot mutate another. File bytes end in one newline and
// contain no timestamp; the shared `sha256:` id is a fixed valid literal (loader tests validate an
// existing id — only renderer tests prove its computation).

import type {
  BundleId,
  CoverageEntry,
  WebChannel,
  WebCoverageArtifact,
  WebEstateHostV2,
  WebEstateModelV2,
  WebEstateServiceV2,
  WebFindingsArtifact,
  WebRoutingOverride,
  WebStandaloneSuppression,
  WebSuppressionInfo,
} from "@pulse/renderer";
import type { BundleFileBytes, EstateBundlePaths } from "../../src/server/estate/load.js";

/** Fully valid values and canonical bytes for one coherent v2 bundle. */
export interface EstateBundleFixture {
  /** Complete model artifact. */
  readonly model: WebEstateModelV2;
  /** Complete coverage artifact sharing model identity/relationships. */
  readonly coverage: WebCoverageArtifact;
  /** Complete findings artifact sharing model identity. */
  readonly findings: WebFindingsArtifact;
  /** Canonical serialized members. */
  readonly files: BundleFileBytes;
  /** Stable absolute-looking test paths; no file I/O implied. */
  readonly paths: EstateBundlePaths;
}

/** Fixed valid shared identity: `sha256:` + 64 lowercase hex. */
export const FIXTURE_BUNDLE_ID: BundleId = `sha256:${"0123456789abcdef".repeat(4)}`;

/** Stable test paths; no file I/O implied. */
export const FIXTURE_PATHS: EstateBundlePaths = {
  model: "/rendered/web-estate-model.json",
  coverage: "/rendered/web-coverage.json",
  findings: "/rendered/web-findings.json",
};

/** Deep-clone JSON test values so one test cannot mutate another. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Canonical member bytes: stable JSON ending in exactly one newline, no timestamp. */
export function serializeArtifact(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function prov(file: string, path: string): WebEstateModelV2["hosts"][number]["provenance"] {
  return { file, path, line: 1, col: 1 };
}

function buildHosts(): WebEstateHostV2[] {
  return [
    {
      name: "hostA-managed",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.1"],
      suppressed: null,
      drilldownId: "host:hostA-managed",
      expectedChurn: false,
      scrapeIntervalClass: "fast",
      provenance: prov("hosts/hostA.yml", "hosts[0].name"),
      scrapeTargets: [{ job: "node", instance: "10.0.0.1:9100" }],
      artifacts: ["scrape/hostA.yml"],
      detail: {
        exporterPorts: [9100],
        cadvisor: true,
        heartbeat: true,
        deliveryForm: "compose",
        commandSignals: [
          {
            name: "disk",
            output: "scalar",
            interval: "5m",
            command: "df -h",
            credential: null,
            metric: "disk_free",
            upMetric: "disk_up",
            labels: { mount: "/" },
          },
          {
            name: "uptime",
            output: "exposition",
            interval: "1m",
            command: "cat /proc/uptime",
            credential: null,
          },
        ],
      },
    },
    {
      name: "hostB-hyper",
      collectionClass: "hypervisor-api",
      addresses: ["10.0.0.2"],
      suppressed: null,
      drilldownId: "host:hostB-hyper",
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: prov("hosts/hostB.yml", "hosts[1].name"),
      scrapeTargets: [],
      artifacts: ["scrape/hostB.yml"],
      detail: {
        apiEndpoint: "https://pve.example",
        credential: { kind: "env", display: "${PVE_TOKEN}" },
      },
    },
    {
      name: "hostC-nas",
      collectionClass: "nas-api",
      addresses: ["10.0.0.3"],
      suppressed: null,
      drilldownId: "host:hostC-nas",
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: prov("hosts/hostC.yml", "hosts[2].name"),
      scrapeTargets: [],
      artifacts: ["scrape/hostC.yml"],
      detail: {
        apiEndpoint: "https://nas.example",
        credential: { kind: "op", display: "op://vault/item/field" },
      },
    },
    {
      name: "hostD-probe",
      collectionClass: "probe-only",
      addresses: ["10.0.0.4"],
      suppressed: null,
      drilldownId: "host:hostD-probe",
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: prov("hosts/hostD.yml", "hosts[3].name"),
      scrapeTargets: [],
      artifacts: [],
      detail: {
        probe: { kind: "tcp", target: "10.0.0.9:22", expect: null },
      },
    },
    {
      name: "hostE-excluded",
      collectionClass: "excluded",
      addresses: ["10.0.0.5"],
      suppressed: { class: "excluded", rationale: "decommissioned host" },
      drilldownId: "host:hostE-excluded",
      expectedChurn: true,
      scrapeIntervalClass: null,
      provenance: prov("hosts/hostE.yml", "hosts[4].name"),
      scrapeTargets: [],
      artifacts: [],
      detail: {},
    },
  ];
}

function buildServices(): WebEstateServiceV2[] {
  return [
    {
      name: "grafana",
      host: "hostA-managed",
      managed: true,
      deepHealth: true,
      ingressUrl: "https://grafana.example",
      suppressed: null,
      drilldownId: "svc:hostA-managed/grafana",
      kind: "dashboard",
      provenance: prov("services/grafana.yml", "services[0].name"),
      gatusEndpoints: ["hostA-managed/grafana"],
      artifacts: ["gatus/grafana.yml"],
      deepHealthDetail: {
        endpoint: "https://grafana.example/api/health",
        metrics: ["cache", "db"],
        responseMapping: { cache: "$.cache", db: "$.db" },
        alertExpression: "up == 0",
        hostLocal: false,
        credential: null,
      },
      backupFreshness: null,
      alerts: [
        {
          type: "gatus",
          enabled: true,
          failureThreshold: 3,
          successThreshold: 2,
          description: "grafana health",
          sendOnResolved: true,
        },
      ],
    },
    {
      name: "loki",
      host: "hostA-managed",
      managed: true,
      deepHealth: false,
      suppressed: null,
      drilldownId: "svc:hostA-managed/loki",
      kind: "logs",
      provenance: prov("services/loki.yml", "services[1].name"),
      gatusEndpoints: [],
      artifacts: [],
      deepHealthDetail: null,
      backupFreshness: { signal: "backup", threshold: "24h", interval: "15m", hasCommand: true },
      alerts: [],
    },
    {
      name: "restic",
      host: "hostC-nas",
      managed: false,
      deepHealth: false,
      suppressed: { class: "expected-churn", rationale: "ephemeral backups" },
      drilldownId: "svc:hostC-nas/restic",
      kind: "backup",
      provenance: prov("services/restic.yml", "services[2].name"),
      gatusEndpoints: [],
      artifacts: ["gatus/restic.yml"],
      deepHealthDetail: null,
      backupFreshness: null,
      alerts: [{ type: "gatus" }],
    },
  ];
}

function buildChannels(): WebChannel[] {
  return [
    {
      name: "ops-chat",
      kind: "chat",
      credential: { kind: "env", display: "${SLACK_TOKEN}" },
      options: { "chat-id": "C123", retries: 3, verbose: true },
      provenance: prov("channels/ops.yml", "channels[0].name"),
    },
    {
      name: "ops-email",
      kind: "email",
      credential: { kind: "op", display: "op://vault/email/token" },
      options: null,
      provenance: prov("channels/ops.yml", "channels[1].name"),
    },
  ];
}

function buildRoutingOverrides(): WebRoutingOverride[] {
  return [
    {
      severity: "critical",
      channels: ["ops-chat", "ops-email"],
      provenance: prov("routing/overrides.yml", "routingOverrides[0].severity"),
    },
  ];
}

function buildSuppressions(): WebStandaloneSuppression[] {
  return [
    {
      target: "hostE-excluded",
      class: "excluded",
      rationale: "decommissioned host",
      provenance: prov("suppressions/hosts.yml", "suppressions[0].target"),
      resolves: ["host:hostE-excluded"],
    },
    {
      target: "hostC-nas/restic",
      class: "expected-churn",
      rationale: "ephemeral backups",
      provenance: prov("suppressions/services.yml", "suppressions[1].target"),
      resolves: ["svc:hostC-nas/restic"],
    },
  ];
}

/** Build a complete valid model; all required arrays and nested fields are present. */
export function makeWebEstateModelV2(overrides?: Partial<WebEstateModelV2>): WebEstateModelV2 {
  const base: WebEstateModelV2 = {
    formatVersion: 2,
    bundleId: FIXTURE_BUNDLE_ID,
    estate: {
      name: "home-estate",
      domains: ["example.com"],
      timezone: "America/Chicago",
      dnsResolver: "10.0.0.1",
      retention: "30d",
      schemaMajor: 1,
      deadman: { configured: true, kind: "secret-ref" },
    },
    hosts: buildHosts(),
    services: buildServices(),
    channels: buildChannels(),
    routingOverrides: buildRoutingOverrides(),
    suppressions: buildSuppressions(),
  };
  return { ...base, ...overrides };
}

function coverageEntry(
  kind: "host" | "service",
  name: string,
  collectionClass: CoverageEntry["collectionClass"],
  artifacts: readonly string[],
  suppressed: WebSuppressionInfo | null,
): CoverageEntry {
  return {
    kind,
    name,
    collectionClass,
    artifacts: [...artifacts],
    suppressed: suppressed === null ? null : { ...suppressed },
  };
}

function bucketOf(suppressed: WebSuppressionInfo | null, artifacts: readonly string[]): "covered" | "gaps" | "suppressed" {
  if (suppressed !== null) return "suppressed";
  return artifacts.length > 0 ? "covered" : "gaps";
}

/**
 * Build exact coverage from the supplied model relationships and suppression state. Recomputes each
 * bucket so an entity override in the model yields a coherent coverage artifact (08 §4.3).
 */
export function makeWebCoverageArtifact(
  model: WebEstateModelV2,
  bundleId: BundleId = model.bundleId,
): WebCoverageArtifact {
  const covered: CoverageEntry[] = [];
  const gaps: CoverageEntry[] = [];
  const suppressed: CoverageEntry[] = [];
  const push = (entry: CoverageEntry, bucket: "covered" | "gaps" | "suppressed"): void => {
    (bucket === "covered" ? covered : bucket === "gaps" ? gaps : suppressed).push(entry);
  };

  const hostClass = new Map<string, WebEstateHostV2["collectionClass"]>();
  for (const host of model.hosts) hostClass.set(host.name, host.collectionClass);

  for (const host of model.hosts) {
    const entry = coverageEntry("host", host.name, host.collectionClass, host.artifacts, host.suppressed);
    push(entry, bucketOf(host.suppressed, host.artifacts));
  }
  for (const service of model.services) {
    const ownerClass = hostClass.get(service.host);
    if (ownerClass === undefined) continue;
    const entry = coverageEntry(
      "service",
      `${service.host}/${service.name}`,
      ownerClass,
      service.artifacts,
      service.suppressed,
    );
    push(entry, bucketOf(service.suppressed, service.artifacts));
  }

  return { formatVersion: 2, bundleId, covered, gaps, suppressed };
}

/** Build a complete findings artifact using the supplied generation id (one of each severity). */
export function makeWebFindingsArtifact(bundleId: BundleId): WebFindingsArtifact {
  return {
    formatVersion: 2,
    bundleId,
    findings: [
      {
        severity: "error",
        code: "web_unsafe_provenance",
        file: "hosts/hostA.yml",
        path: "hosts[0].name",
        message: "provenance escaped the estate root",
        fix: "re-render with 'pulse render'",
      },
      {
        severity: "warning",
        code: "web_url_userinfo_removed",
        file: "services/grafana.yml",
        path: "",
        message: "URL userinfo was removed for display",
        fix: "store the credential in a secret reference",
      },
      {
        severity: "info",
        code: "web_sensitive_channel_option_omitted",
        file: "channels/ops.yml",
        path: "channels[0].options",
        message: "a sensitive channel option was omitted",
        fix: "no action required",
      },
    ],
  };
}

/** Build coherent values and canonical bytes; defaults include every host discriminant. */
export function makeEstateBundleFixture(): EstateBundleFixture {
  const model = makeWebEstateModelV2();
  const coverage = makeWebCoverageArtifact(model);
  const findings = makeWebFindingsArtifact(model.bundleId);
  const files: BundleFileBytes = {
    model: serializeArtifact(model),
    coverage: serializeArtifact(coverage),
    findings: serializeArtifact(findings),
  };
  return { model, coverage, findings, files, paths: FIXTURE_PATHS };
}
