/** rendered-model-v2-benchmark.ts — the authoritative deterministic performance fixture
 *  (00-core-definitions.md §10, 07-format-transition-and-benchmark.md §5.1, 08 §9.1).
 *
 *  `buildRenderedModelV2BenchmarkFixture()` returns a validated-SHAPE `EstateModel` at exactly the
 *  supported envelope — 100 distinct hosts and 300 distinct services — together with deterministic
 *  loader findings of every severity. It is a PURE TypeScript builder: no random values, UUIDs,
 *  clock, environment, filesystem enumeration, network, or live-engine access. Every name,
 *  address, credential display, provenance, and ordering key is fixed and zero-padded so the source
 *  order and every expected value are explicit and reproducible.
 *
 *  The fixture deliberately spreads every repeatable optional / discriminated v2 shape across its
 *  records rather than duplicating each on every record (07 §5.1): all five collection classes,
 *  both managed-linux delivery forms, cAdvisor/heartbeat true/false, multiple exporter ports, both
 *  command-signal outputs with optional labels and credential present/null, the hypervisor
 *  credential, both NAS branches, probe `expect` present/null, the excluded empty detail, host
 *  `expectedChurn` true/false, scrape-interval present/null, standalone + in-target suppression,
 *  service managed true/false, ingress present/omitted, deep-health true-detail/false-null with
 *  host-local true/false and credential present/null, backup absent/present with command
 *  present/absent and default/declared interval, endpoint alerts with every optional key declared
 *  and omitted, every channel kind, safe options present/null, env and `op://` credential
 *  references, a routing override, and at least one finding of each severity. */

import type {
  Channel,
  CommandSignal,
  EstateModel,
  Finding,
  Host,
  Provenance,
  RoutingOverride,
  SecretRef,
  Service,
  Suppression,
} from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

// ── Envelope constants (00 §10) ─────────────────────────────────────────────────────────────────

/** Exact supported host cardinality. */
export const BENCHMARK_HOST_COUNT = 100 as const;
/** Exact supported service cardinality. */
export const BENCHMARK_SERVICE_COUNT = 300 as const;
/** Generation-median gate; a median at or above this value fails (07 §5.4). */
export const RENDER_MEDIAN_LIMIT_MS = 2_000 as const;
/** Load-median gate; a median at or above this value fails (07 §5.4). */
export const LOAD_MEDIAN_LIMIT_MS = 250 as const;
/** Measured sample count per series after one discarded warm-up (07 §5.3). */
export const MEASURED_SAMPLE_COUNT = 5 as const;

/** Deterministic validated model plus loader findings at exactly the supported envelope (00 §10). */
export interface RenderedModelV2BenchmarkFixture {
  /** Deterministic validated model at exactly the supported envelope. */
  model: EstateModel;
  /** Deterministic loader findings, including every severity. */
  findings: Finding[];
}

// ── Deterministic primitives ────────────────────────────────────────────────────────────────────

/** Zero-pad a non-negative integer to three digits, e.g. `pad3(7) === "007"`. */
function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

/** A fixed provenance stamp at a deterministic source path. */
function prov(path: string): Provenance {
  return { file: "estate.yaml", path, line: 1, col: 1 };
}

/** An `env` secret reference, e.g. `envRef("SLACK_TOKEN")` → `${SLACK_TOKEN}`. */
function envRef(varName: string): SecretRef {
  return { kind: "env", raw: `\${${varName}}`, varName };
}

/** An `op://` (1Password) secret reference. */
function opRef(vault: string, item: string, field: string): SecretRef {
  return { kind: "op", raw: `op://${vault}/${item}/${field}`, vault, item, field };
}

/** Hosts `host-094`..`host-099` carry the non-managed collection classes; `host-000`..`host-093`
 *  are managed-linux (the render-heavy bulk). */
const NON_MANAGED_START = 94;

// ── Host builders ─────────────────────────────────────────────────────────────────────────────

/** Deterministic command signals for a managed-linux host, spreading every command-signal shape
 *  across three specific hosts and leaving the rest signal-free. */
function commandSignalsFor(i: number): CommandSignal[] {
  if (i === 0) {
    // scalar with labels + env credential, and a plain exposition signal (no credential).
    return [
      {
        output: "scalar",
        name: "queue-depth",
        command: ["/usr/bin/depth", "--queue", "default queue"],
        interval: "30s",
        metric: "queue_depth",
        upMetric: "queue_depth_up",
        labels: { role: "worker" },
        credential: envRef("QUEUE_TOKEN"),
      },
      {
        output: "exposition",
        name: "metrics-dump",
        command: ["/usr/bin/dump"],
        interval: "60s",
      },
    ];
  }
  if (i === 10) {
    // scalar WITHOUT labels and WITHOUT credential (credential null in the projection).
    return [
      {
        output: "scalar",
        name: "disk-free",
        command: ["/usr/bin/free", "--bytes"],
        interval: "45s",
        metric: "disk_free_bytes",
        upMetric: "disk_free_up",
      },
    ];
  }
  if (i === 20) {
    // scalar with labels + op:// credential.
    return [
      {
        output: "scalar",
        name: "temperature",
        command: ["/usr/bin/temp"],
        interval: "30s",
        metric: "temp_celsius",
        upMetric: "temp_celsius_up",
        labels: { zone: "rack-1" },
        credential: opRef("infra", "sensors", "token"),
      },
    ];
  }
  return [];
}

/** One managed-linux host (`host-000`..`host-093`), varying every managed-linux shape by index. */
function managedLinuxHost(i: number): Host {
  const host: Host = {
    name: `host-${pad3(i)}`,
    addresses: [`10.0.${Math.floor(i / 100)}.${i % 100}`],
    collectionClass: "managed-linux",
    exporterPorts: i % 4 === 0 ? [9100, 9256, 9800] : [9100, 9256],
    cadvisor: i % 3 === 0,
    heartbeat: i % 2 === 0,
    deliveryForm: i % 2 === 0 ? "compose" : "systemd",
    commandSignals: commandSignalsFor(i),
    provenance: prov(`hosts[${i}]`),
  };
  // expectedChurn: declared true, declared false, or omitted — all three shapes appear.
  if (i % 5 === 0) host.expectedChurn = true;
  else if (i % 5 === 1) host.expectedChurn = false;
  // scrapeIntervalClass: present ("fast"/"slow") or omitted.
  if (i % 3 === 0) host.scrapeIntervalClass = "fast";
  else if (i % 3 === 2) host.scrapeIntervalClass = "slow";
  return host;
}

/** The six non-managed hosts, covering every remaining class and both NAS/probe branches. */
function nonManagedHosts(): Host[] {
  return [
    {
      name: `host-${pad3(94)}`,
      addresses: ["10.0.0.94"],
      collectionClass: "hypervisor-api",
      apiEndpoint: "https://hv-01.example.com:8006",
      credential: envRef("HV_TOKEN"),
      provenance: prov("hosts[94]"),
    },
    {
      // NAS branch A: apiEndpoint + credential both present.
      name: `host-${pad3(95)}`,
      addresses: ["10.0.0.95"],
      collectionClass: "nas-api",
      apiEndpoint: "https://nas-01.example.com:9101",
      credential: opRef("infra", "nas-01", "token"),
      provenance: prov("hosts[95]"),
    },
    {
      // NAS branch B: neither apiEndpoint nor credential (direct node_exporter scrape).
      name: `host-${pad3(96)}`,
      addresses: ["10.0.0.96"],
      collectionClass: "nas-api",
      provenance: prov("hosts[96]"),
    },
    {
      // probe-only with an expected-response assertion.
      name: `host-${pad3(97)}`,
      addresses: ["10.0.0.97"],
      collectionClass: "probe-only",
      probe: { kind: "http", target: "https://cam-01.example.com/health", expect: "200" },
      provenance: prov("hosts[97]"),
    },
    {
      // probe-only without an expectation.
      name: `host-${pad3(98)}`,
      addresses: ["10.0.0.98"],
      collectionClass: "probe-only",
      probe: { kind: "icmp", target: "10.0.0.98" },
      provenance: prov("hosts[98]"),
    },
    {
      // excluded host with its mandatory in-target suppression mark (empty detail after projection).
      name: `host-${pad3(99)}`,
      addresses: ["10.0.0.99"],
      collectionClass: "excluded",
      suppressed: { class: "excluded", rationale: "decommissioned rack" },
      provenance: prov("hosts[99]"),
    },
  ];
}

/** Build all 100 deterministic hosts in source order. */
function buildHosts(): Host[] {
  const hosts: Host[] = [];
  for (let i = 0; i < NON_MANAGED_START; i++) hosts.push(managedLinuxHost(i));
  hosts.push(...nonManagedHosts());
  return hosts;
}

// ── Service builder ─────────────────────────────────────────────────────────────────────────────

/** One service, owned by a managed-linux host, varying every service shape by index. */
function serviceAt(i: number): Service {
  const name = `service-${pad3(i)}`;
  const owner = `host-${pad3(i % NON_MANAGED_START)}`;
  const svc: Service = {
    name,
    host: owner,
    kind: "http",
    managed: i % 2 === 0,
    provenance: prov(`services[${i}]`),
  };
  // ingressUrl present on two of every three services; omitted on the rest.
  if (i % 3 !== 0) svc.ingressUrl = `https://${name}.example.com`;
  // deepHealth present on one of every four; host-local + credential on one of every eight.
  if (i % 4 === 0) {
    const hostLocal = i % 8 === 0;
    svc.deepHealth = {
      endpoint: `https://${name}.example.com/api/health`,
      responseMapping: { database: "$.database", version: "$.version", uptime: "$.uptime_seconds" },
      alertExpression: "database < 1",
      hostLocal,
      ...(hostLocal ? { credential: envRef(`DH_${pad3(i)}`) } : {}),
    };
  }
  // backupFreshness present on one of every five, with command and interval sub-variants.
  if (i % 5 === 0) {
    svc.backupFreshness = {
      signal: "pulse_backup_freshness_age_seconds",
      threshold: "26h",
      ...(i % 10 === 0 ? { command: ["/usr/bin/backup-age", name] } : {}),
      ...(i % 15 === 0 ? { interval: "30m" } : {}),
    };
  }
  // endpoint alerts on one of every six: a fully-declared alert plus a minimal (all-omitted) one.
  if (i % 6 === 0) {
    svc.alerts = [
      {
        type: "custom",
        enabled: true,
        failureThreshold: 3,
        successThreshold: 2,
        description: "endpoint degraded",
        sendOnResolved: true,
      },
      { type: "custom" },
    ];
  }
  // in-target suppression on a handful of services.
  if (i % 50 === 0) svc.suppressed = { class: "expected-churn", rationale: "nightly job flaps" };
  return svc;
}

/** Build all 300 deterministic services in source order. */
function buildServices(): Service[] {
  const services: Service[] = [];
  for (let i = 0; i < BENCHMARK_SERVICE_COUNT; i++) services.push(serviceAt(i));
  return services;
}

// ── Channels, routing, suppressions ───────────────────────────────────────────────────────────

/** Every supported channel kind, spreading options present/null and env/op credential references.
 *  A channel option named `apiToken`/`webhook_url` is intentionally sensitive: the safety layer
 *  omits it and raises a display-safe warning (exercises the sanitizer at scale). */
function buildChannels(): Channel[] {
  return [
    {
      name: "ops-chat",
      kind: "chat",
      credential: envRef("SLACK_TOKEN"),
      options: { channel_id: "C0001", apiToken: "should-be-omitted" },
      provenance: prov("channels[0]"),
    },
    {
      name: "ops-email",
      kind: "email",
      credential: opRef("infra", "smtp", "password"),
      provenance: prov("channels[1]"),
    },
    {
      name: "ops-push",
      kind: "push",
      credential: envRef("PUSHOVER_TOKEN"),
      provenance: prov("channels[2]"),
    },
    {
      name: "ops-telegram",
      kind: "telegram",
      credential: envRef("TELEGRAM_TOKEN"),
      options: { chat_id: "-1000000000001" },
      provenance: prov("channels[3]"),
    },
    {
      name: "ops-webhook",
      kind: "webhook",
      credential: envRef("WEBHOOK_TOKEN"),
      options: { webhook_url: "https://hooks.example.com/should-be-omitted", retries: 3 },
      provenance: prov("channels[4]"),
    },
  ];
}

/** Severity→channel routing overrides in stable order. */
function buildRoutingOverrides(): RoutingOverride[] {
  return [
    { severity: "critical", channels: ["ops-chat", "ops-telegram"], provenance: prov("routing[0]") },
    { severity: "warning", channels: ["ops-email"], provenance: prov("routing[1]") },
  ];
}

/** Standalone suppressions resolving to a monitored host and a bare service name. */
function buildSuppressions(): Suppression[] {
  return [
    {
      class: "known-expected",
      rationale: "quarterly maintenance window",
      target: "host-050",
      provenance: prov("suppressions[0]"),
    },
    {
      class: "known-expected",
      rationale: "flaps during nightly rotation",
      target: "service-001",
      provenance: prov("suppressions[1]"),
    },
  ];
}

// ── Findings ────────────────────────────────────────────────────────────────────────────────────

/** Deterministic loader findings covering every severity. */
function buildFindings(): Finding[] {
  return [
    {
      severity: "error",
      code: FINDING_CODES.UNRESOLVED_HOST,
      file: "estate.yaml",
      path: "services[7].host",
      message: "deterministic error finding",
      fix: "declare the referenced host",
    },
    {
      severity: "warning",
      code: FINDING_CODES.SECRET_LITERAL,
      file: "estate.yaml",
      path: "channels[0].credential",
      message: "deterministic warning finding",
      fix: "replace the literal with a secret reference",
    },
    {
      severity: "info",
      code: FINDING_CODES.UNRESOLVED_HOST,
      file: "estate.yaml",
      path: "hosts[3]",
      message: "deterministic info finding",
      fix: "review the declaration",
    },
  ];
}

// ── Public builder ──────────────────────────────────────────────────────────────────────────────

/** Build the deterministic 100-host / 300-service benchmark fixture (00 §10, 07 §5.1). */
export function buildRenderedModelV2BenchmarkFixture(): RenderedModelV2BenchmarkFixture {
  const model: EstateModel = {
    schemaMajor: 1,
    estate: {
      name: "benchmark-estate",
      domains: ["b.example.com", "a.example.com"],
      timezone: "America/Chicago",
      dnsResolver: "10.0.0.1",
      retention: "30d",
      deadmanHook: envRef("DEADMAN_HOOK"),
      provenance: prov("estate"),
    },
    hosts: buildHosts(),
    services: buildServices(),
    channels: buildChannels(),
    routingOverrides: buildRoutingOverrides(),
    suppressions: buildSuppressions(),
  };
  return { model, findings: buildFindings() };
}
