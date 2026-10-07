// packages/web-data/tests/fixtures/envelope/index.ts — the deterministic sanitized envelope
// fixture factory for item 058 (04-cycle-and-current-view-folds.md §13, 11-testing-strategy.md
// §§3, 4, 6, 7, 10). Builds exactly 100 hosts and 300 services, bounded alerts/rules/silences/
// coverage/findings, and representative Gatus endpoint kinds below 512, plus standalone 511/512
// Gatus page builders for the completeness-boundary evidence. Everything is derived from a single
// fixed seed and index arithmetic — no RNG, no real estate data, no credentials/secrets.
//
// Shared by `envelope.test.ts` (fixtures/cardinality/body-budget) and `performance.test.ts`
// (history latency). It is a package-local test fixture: it depends only on `@pulse/renderer`
// types and the package's own source-record contracts, never on apps/web.

import type {
  WebCoverageArtifact,
  WebEstateHostV2,
  WebEstateModelV2,
  WebEstateServiceV2,
  WebFindingsArtifact,
} from "@pulse/renderer";

import type { CycleSourceRecords, FoldInputs } from "../../../src/cycle/records.js";
import type { SourceRecord } from "../../../src/sources/types.js";
import type { ScrapeTargetState } from "../../../src/sources/types.js";
import type { MetricSample, VmBuildInfo } from "../../../src/sources/vm.js";
import type {
  AlertmanagerAlert,
  AlertmanagerReceiver,
  AlertmanagerSilence,
  AlertmanagerStatus,
} from "../../../src/sources/alertmanager.js";
import type { VmalertRuleGroup } from "../../../src/sources/vmalert.js";
import type { GatusEndpointState } from "../../../src/sources/gatus.js";
import type { GrafanaHealth } from "../../../src/sources/grafana.js";

// ── Seed and counts (printed by tests; the fixture is 100 % deterministic) ─────────────────────

/** The single fixed factory seed. It drives every categorical rotation below; the fixture is
 *  otherwise pure index arithmetic, so the same seed always yields byte-identical output. */
export const ENVELOPE_SEED = 20260917;

/** Exactly 100 hosts (04 §13 / 11 §10). */
export const ENVELOPE_HOST_COUNT = 100;
/** Exactly 300 services (three per host). */
export const ENVELOPE_SERVICE_COUNT = 300;
/** One Gatus endpoint declared per service → 300 endpoint identities, well below the 512 cap. */
export const ENVELOPE_ENDPOINT_COUNT = ENVELOPE_SERVICE_COUNT;
/** Bounded alert cardinality (mixed states + one DeadMansSwitch canary). */
export const ENVELOPE_ALERT_COUNT = 24;
/** Bounded vmalert rule-group cardinality. */
export const ENVELOPE_RULE_GROUP_COUNT = 8;
/** Bounded active-silence cardinality. */
export const ENVELOPE_SILENCE_COUNT = 6;

const BUNDLE_ID = `sha256:${"0123456789abcdef".repeat(4)}` as WebEstateModelV2["bundleId"];
const AT = "2026-09-17T00:00:00.000Z";
/** The publication observation time (folds stamp `generatedAt` from it). */
export const ENVELOPE_OBSERVED_AT = "2026-09-17T00:00:05.000Z";

/** Counts a test can print alongside the seed to make the fixture reproducible on the record. */
export interface EnvelopeCounts {
  readonly seed: number;
  readonly hosts: number;
  readonly services: number;
  readonly endpoints: number;
  readonly alerts: number;
  readonly ruleGroups: number;
  readonly silences: number;
}

/** The exact fixture cardinality, for the printed reproducibility line. */
export function envelopeCounts(): EnvelopeCounts {
  return {
    seed: ENVELOPE_SEED,
    hosts: ENVELOPE_HOST_COUNT,
    services: ENVELOPE_SERVICE_COUNT,
    endpoints: ENVELOPE_ENDPOINT_COUNT,
    alerts: ENVELOPE_ALERT_COUNT,
    ruleGroups: ENVELOPE_RULE_GROUP_COUNT,
    silences: ENVELOPE_SILENCE_COUNT,
  };
}

/** A one-line human summary printed by the fixture-count test. */
export function describeEnvelope(): string {
  const c = envelopeCounts();
  return (
    `envelope fixture: seed=${c.seed} hosts=${c.hosts} services=${c.services} ` +
    `endpoints=${c.endpoints} alerts=${c.alerts} ruleGroups=${c.ruleGroups} silences=${c.silences}`
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────────────────────

/** Zero-padded host name, e.g. `host-007`. */
export function hostName(i: number): string {
  return `host-${String(i).padStart(3, "0")}`;
}

/** The k-th service name on host i, e.g. `svc-007-1`. */
export function serviceName(i: number, k: number): string {
  return `svc-${String(i).padStart(3, "0")}-${k}`;
}

function prov(i: number): WebEstateHostV2["provenance"] {
  return { file: `hosts/${hostName(i)}.yml`, path: `hosts[${i}].name`, line: 1, col: 1 };
}

/** Every 7th host is probe-only (no scrape targets); the rest are managed-linux. Index-derived
 *  so the class mix is deterministic and the folds exercise both liveness paths. */
function isProbeOnly(i: number): boolean {
  return (i + ENVELOPE_SEED) % 7 === 0;
}

const SEVERITIES = ["critical", "warning", "info"] as const;
const AM_STATES = ["firing", "silenced", "inhibited"] as const;

// ── Model (100 hosts, 300 services) ──────────────────────────────────────────────────────────────

function buildHost(i: number): WebEstateHostV2 {
  const addr = `10.${Math.floor(i / 254)}.${i % 254}.10`;
  if (isProbeOnly(i)) {
    return {
      name: hostName(i),
      collectionClass: "probe-only",
      addresses: [addr],
      suppressed: null,
      drilldownId: `host:${hostName(i)}`,
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: prov(i),
      scrapeTargets: [],
      artifacts: [],
      detail: { probe: { kind: "tcp", target: `${addr}:22`, expect: null } },
    } as WebEstateHostV2;
  }
  return {
    name: hostName(i),
    collectionClass: "managed-linux",
    addresses: [addr],
    suppressed: null,
    drilldownId: `host:${hostName(i)}`,
    expectedChurn: false,
    scrapeIntervalClass: "fast",
    provenance: prov(i),
    scrapeTargets: [{ job: "node", instance: `${addr}:9100` }],
    artifacts: [`scrape/${hostName(i)}.yml`],
    detail: {
      exporterPorts: [9100],
      cadvisor: false,
      heartbeat: true,
      deliveryForm: "compose",
      commandSignals: [],
    },
  } as WebEstateHostV2;
}

function buildService(i: number, k: number): WebEstateServiceV2 {
  const host = hostName(i);
  const name = serviceName(i, k);
  const endpointKey = `${host}/${name}`;
  return {
    name,
    host,
    managed: true,
    deepHealth: false,
    ingressUrl: `https://${name}.example`,
    suppressed: null,
    drilldownId: `svc:${host}/${name}`,
    kind: "web",
    provenance: { file: `services/${host}.yml`, path: `services[${i * 3 + k}].name`, line: 1, col: 1 },
    gatusEndpoints: [endpointKey],
    artifacts: [`gatus/${name}.yml`],
    deepHealthDetail: null,
    backupFreshness: null,
    alerts: [],
  } as unknown as WebEstateServiceV2;
}

/** Build the deterministic 100-host / 300-service model. */
export function envelopeModel(over: Partial<WebEstateModelV2> = {}): WebEstateModelV2 {
  const hosts: WebEstateHostV2[] = [];
  const services: WebEstateServiceV2[] = [];
  for (let i = 0; i < ENVELOPE_HOST_COUNT; i += 1) {
    hosts.push(buildHost(i));
    for (let k = 0; k < 3; k += 1) services.push(buildService(i, k));
  }
  return {
    formatVersion: 2,
    bundleId: BUNDLE_ID,
    estate: {
      name: "envelope-estate",
      domains: ["example.com"],
      timezone: "America/Chicago",
      dnsResolver: null,
      retention: "30d",
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts,
    services,
    channels: [],
    routingOverrides: [],
    suppressions: [],
    ...over,
  } as WebEstateModelV2;
}

/** Coverage that marks every host/service covered (bounded artifact traces). */
export function envelopeCoverage(model: WebEstateModelV2 = envelopeModel()): WebCoverageArtifact {
  const covered = [
    ...model.hosts.map((h) => ({
      kind: "host" as const,
      name: h.name,
      collectionClass: h.collectionClass,
      artifacts: h.artifacts,
      suppressed: null,
    })),
    ...model.services.map((s) => ({
      kind: "service" as const,
      name: `${s.host}/${s.name}`,
      collectionClass: "managed-linux" as const,
      artifacts: s.artifacts,
      suppressed: null,
    })),
  ];
  return { formatVersion: 2, bundleId: model.bundleId, covered, gaps: [], suppressed: [] } as WebCoverageArtifact;
}

/** A small bounded findings artifact (one of each severity). */
export function envelopeFindings(model: WebEstateModelV2 = envelopeModel()): WebFindingsArtifact {
  return {
    formatVersion: 2,
    bundleId: model.bundleId,
    findings: [
      {
        severity: "warning",
        code: "web_url_userinfo_removed",
        file: "services/host-000.yml",
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
  } as WebFindingsArtifact;
}

// ── Source records (bounded, sanitized) ───────────────────────────────────────────────────────

function record<T>(data: T, at = AT): SourceRecord<T> {
  return { latest: { attemptedAt: at, result: { ok: true, data } }, lastGood: { at, data } };
}

function metric(projection: string, labels: Record<string, string>, value: number | null): MetricSample {
  return { metric: labels, timestampMs: Date.parse(AT), value, projection };
}

/** Live metrics: `up` + `pulse_agent_up` for every managed host plus the engine instant
 *  projections the engine fold reads. Bounded to ~2 samples/host + a fixed engine block. */
export function envelopeMetrics(): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  for (let i = 0; i < ENVELOPE_HOST_COUNT; i += 1) {
    if (isProbeOnly(i)) continue;
    const addr = `10.${Math.floor(i / 254)}.${i % 254}.10`;
    const instance = `${addr}:9100`;
    samples.push(metric("up", { host: hostName(i), instance }, 1));
    samples.push(metric("pulse_agent_up", { host: hostName(i), instance }, 1));
  }
  // Engine instant projections (job=web); uptime derives from process-start.
  const engineLabels = { job: "web" };
  samples.push(metric("pulse_web_engine_process_start_seconds", engineLabels, Date.parse(AT) / 1000 - 3600));
  samples.push(metric("pulse_web_engine_hourly_active_series", engineLabels, 12000));
  samples.push(metric("pulse_web_engine_data_bytes", engineLabels, 5_000_000_000));
  samples.push(metric("pulse_web_engine_free_disk_bytes", engineLabels, 40_000_000_000));
  samples.push(metric("pulse_web_engine_ingestion_rows_per_second", engineLabels, 8500));
  samples.push(metric("pulse_web_engine_notification_failures_per_second", engineLabels, 0));
  samples.push(metric("pulse_web_engine_notification_latency_p95_seconds", engineLabels, 0.4));
  return samples;
}

/** Scrape targets discovered for every managed host. */
export function envelopeTargets(): readonly ScrapeTargetState[] {
  const targets: ScrapeTargetState[] = [];
  for (let i = 0; i < ENVELOPE_HOST_COUNT; i += 1) {
    if (isProbeOnly(i)) continue;
    const addr = `10.${Math.floor(i / 254)}.${i % 254}.10`;
    targets.push({
      job: "node",
      instance: `${addr}:9100`,
      scrapeUrl: `http://${addr}:9100/metrics`,
      health: "up",
      lastScrapeAt: AT,
      lastError: null,
    });
  }
  return targets;
}

/** Bounded mixed-state alerts across the first hosts, plus the always-firing DeadMansSwitch. */
export function envelopeAlerts(): readonly AlertmanagerAlert[] {
  const alerts: AlertmanagerAlert[] = [];
  for (let n = 0; n < ENVELOPE_ALERT_COUNT - 1; n += 1) {
    const host = hostName(n % ENVELOPE_HOST_COUNT);
    const severity = SEVERITIES[n % SEVERITIES.length]!;
    const state = AM_STATES[n % AM_STATES.length]!;
    alerts.push({
      fingerprint: `fp-${String(n).padStart(4, "0")}`,
      state,
      name: "HighCpu",
      severity,
      startsAt: AT,
      endsAt: "2026-09-18T00:00:00.000Z",
      labels: { alertname: "HighCpu", severity, host },
      annotations: { summary: "cpu high" },
      receivers: ["team"],
      silencedBy: state === "silenced" ? ["sil-0"] : [],
      inhibitedBy: state === "inhibited" ? ["fp-0000"] : [],
      group: null,
    });
  }
  alerts.push({
    fingerprint: "fp-deadman",
    state: "firing",
    name: "DeadMansSwitch",
    severity: "info",
    startsAt: AT,
    endsAt: "2026-09-18T00:00:00.000Z",
    labels: { alertname: "DeadMansSwitch" },
    annotations: {},
    receivers: ["team"],
    silencedBy: [],
    inhibitedBy: [],
    group: null,
  });
  return alerts;
}

/** Bounded vmalert rule groups (each with an alerting rule + the deadman canary in the first). */
export function envelopeRules(): readonly VmalertRuleGroup[] {
  const groups: VmalertRuleGroup[] = [];
  for (let g = 0; g < ENVELOPE_RULE_GROUP_COUNT; g += 1) {
    const rules = [
      {
        name: `Rule${g}`,
        type: "alerting" as const,
        state: g % 2 === 0 ? "firing" : "inactive",
        health: "healthy" as const,
        lastEvaluationAt: AT,
        lastError: null,
        labels: {},
        annotations: {},
        deadman: false,
      },
    ];
    if (g === 0) {
      rules.push({
        name: "DeadMansSwitch",
        type: "alerting",
        state: "firing",
        health: "healthy",
        lastEvaluationAt: AT,
        lastError: null,
        labels: {},
        annotations: {},
        deadman: true,
      });
    }
    groups.push({
      group: `group-${g}`,
      file: `/etc/vmalert/rules/group-${g}.yml`,
      family: `group-${g}`,
      intervalSeconds: 30,
      lastEvaluationAt: AT,
      rules,
    });
  }
  return groups;
}

/** Bounded active silences. */
export function envelopeSilences(): readonly AlertmanagerSilence[] {
  return Array.from({ length: ENVELOPE_SILENCE_COUNT }, (_, n) => ({
    id: `sil-${n}`,
    matchers: [{ name: "host", value: hostName(n), isRegex: false, isEqual: true }],
    createdBy: "op",
    comment: "maintenance",
    startsAt: AT,
    endsAt: "2026-09-18T00:00:00.000Z",
    state: "active" as const,
  }));
}

const STATUS: AlertmanagerStatus = {
  version: "0.27.0",
  uptime: AT,
  cluster: { status: "ready", peerCount: 1 },
};
const RECEIVERS: readonly AlertmanagerReceiver[] = [{ name: "team", integrations: [] }];
const BUILDINFO: VmBuildInfo = { version: "1.102.1", startedAt: AT };
const GRAFANA: GrafanaHealth = { database: "ok", version: "11.4.0" };

/** Gatus endpoint states covering service, probe-only-host, and domain identity kinds — all
 *  bounded well below 512. Service keys mirror the model's declared `gatusEndpoints`. */
export function envelopeGatusStates(): readonly GatusEndpointState[] {
  const states: GatusEndpointState[] = [];
  for (let i = 0; i < ENVELOPE_HOST_COUNT; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const key = `${hostName(i)}/${serviceName(i, k)}`;
      states.push({
        name: key,
        group: hostName(i),
        key: `${hostName(i)}_${serviceName(i, k)}`,
        identity: key,
        expected: true,
        results: [{ timestamp: AT, success: true, durationMs: 40, conditionResults: [] }],
      });
    }
  }
  // One probe-only host and one domain identity kind for representativeness.
  states.push({
    name: "host:host-006",
    group: "",
    key: "host_host-006",
    identity: "host:host-006",
    expected: false,
    results: [{ timestamp: AT, success: true, durationMs: 12, conditionResults: [] }],
  });
  states.push({
    name: "dns:example.com",
    group: "",
    key: "dns_example.com",
    identity: "dns:example.com",
    expected: false,
    results: [{ timestamp: AT, success: true, durationMs: 8, conditionResults: [] }],
  });
  return states;
}

/** The complete keyed source records for one healthy envelope cycle. */
export function envelopeRecords(over: Partial<CycleSourceRecords> = {}): CycleSourceRecords {
  return {
    "victoriametrics-signals": record<readonly MetricSample[]>(envelopeMetrics()),
    "victoriametrics-targets": record<readonly ScrapeTargetState[]>(envelopeTargets()),
    "victoriametrics-buildinfo": record(BUILDINFO),
    "alertmanager-alerts": record<readonly AlertmanagerAlert[]>(envelopeAlerts()),
    "alertmanager-silences": record<readonly AlertmanagerSilence[]>(envelopeSilences()),
    "alertmanager-status": record(STATUS),
    "alertmanager-receivers": record<readonly AlertmanagerReceiver[]>(RECEIVERS),
    "vmalert-rules": record<readonly VmalertRuleGroup[]>(envelopeRules()),
    "gatus-statuses": record<readonly GatusEndpointState[]>(envelopeGatusStates()),
    "grafana-health": record(GRAFANA),
    ...over,
  };
}

/** Full fold inputs for the envelope cycle. */
export function envelopeInputs(over: Partial<FoldInputs> = {}): FoldInputs {
  const model = over.model ?? envelopeModel();
  return {
    model,
    coverage: envelopeCoverage(model),
    findings: envelopeFindings(model),
    records: envelopeRecords(),
    appVersion: "1.2.3",
    observedAt: ENVELOPE_OBSERVED_AT,
    ...over,
  };
}

// ── Tiny estate (for the tiny-vs-envelope cardinality comparison) ────────────────────────────────

/** A minimal one-host / one-service estate; the acquisition plan and fold call cardinality must be
 *  identical to the envelope estate (04 §13 / 11 §3). */
export function tinyModel(): WebEstateModelV2 {
  return {
    formatVersion: 2,
    bundleId: BUNDLE_ID,
    estate: {
      name: "tiny-estate",
      domains: ["example.com"],
      timezone: "America/Chicago",
      dnsResolver: null,
      retention: null,
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts: [buildHost(1)],
    services: [buildService(1, 0)],
    channels: [],
    routingOverrides: [],
    suppressions: [],
  } as WebEstateModelV2;
}

/** Fold inputs for the tiny estate (empty healthy records). */
export function tinyInputs(over: Partial<FoldInputs> = {}): FoldInputs {
  const model = tinyModel();
  return {
    model,
    coverage: envelopeCoverage(model),
    findings: null,
    records: envelopeRecords({
      "victoriametrics-signals": record<readonly MetricSample[]>([]),
      "victoriametrics-targets": record<readonly ScrapeTargetState[]>([]),
      "alertmanager-alerts": record<readonly AlertmanagerAlert[]>([]),
      "vmalert-rules": record<readonly VmalertRuleGroup[]>([]),
      "alertmanager-silences": record<readonly AlertmanagerSilence[]>([]),
      "gatus-statuses": record<readonly GatusEndpointState[]>([]),
    }),
    appVersion: "1.2.3",
    observedAt: ENVELOPE_OBSERVED_AT,
    ...over,
  };
}

// ── Standalone Gatus completeness pages (511 success, 512 overflow) ───────────────────────────────

/** A synthetic Gatus `/api/v1/endpoints/statuses` page body of `n` distinct endpoints. */
export function gatusPage(n: number): string {
  const rows = Array.from({ length: n }, (_, i) => ({
    name: `${hostName(i % ENVELOPE_HOST_COUNT)}/probe-${i}`,
    group: hostName(i % ENVELOPE_HOST_COUNT),
    key: `${hostName(i % ENVELOPE_HOST_COUNT)}_probe-${i}`,
    results: [{ success: true, timestamp: AT, duration: 40_000_000, status: 200 }],
  }));
  return JSON.stringify(rows);
}

/** The expected identities matching a `gatusPage(n)` body. */
export function gatusExpected(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${hostName(i % ENVELOPE_HOST_COUNT)}/probe-${i}`);
}
