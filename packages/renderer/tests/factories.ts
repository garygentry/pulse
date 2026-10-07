/** factories.ts — the shared renderer test harness (07 §2).
 *
 *  Builds validated-SHAPE `EstateModel` values directly (no `@pulse/core` YAML round-trip): a
 *  test constructs exactly the model it needs without invoking the loader. Reused by the golden,
 *  determinism, materialize, diff, and coverage suites (items 008–011).
 *
 *  These builders produce the SHAPE `loadAndValidate` guarantees; they do NOT re-validate. A test
 *  that needs an invalid shape (e.g. a poisoned credential slot for the secret-refusal guard)
 *  overrides a field deliberately. */

import type {
  Channel,
  CollectionClass,
  EstateModel,
  Finding,
  Host,
  Provenance,
  SecretRef,
  Service,
} from "@pulse/core";
import { FINDING_CODES } from "@pulse/core";

/** A fixed, deterministic provenance stamp for every factory-built element. */
export const PROV: Provenance = { file: "estate.yaml", path: "", line: 1, col: 1 };

/** An `env` secret reference, e.g. `envRef("SLACK_TOKEN")` → `${SLACK_TOKEN}`. */
export const envRef = (varName: string): SecretRef => ({
  kind: "env",
  raw: `\${${varName}}`,
  varName,
});

/** An `op` (1Password) secret reference. */
export const opRef = (vault: string, item: string, field: string): SecretRef => ({
  kind: "op",
  raw: `op://${vault}/${item}/${field}`,
  vault,
  item,
  field,
});

/**
 * Build a `Host` of the given collection class with class-appropriate defaults, then apply
 * `overrides`. Every host gets `name`, `addresses`, and `provenance`; the discriminant field is
 * fixed by `cls` and its class-specific fields are supplied so the result is a valid union member.
 */
export function makeHost(
  cls: CollectionClass,
  overrides: Record<string, unknown> = {},
): Host {
  const base = {
    name: "host1",
    addresses: ["10.0.0.10"],
    provenance: PROV,
  };
  switch (cls) {
    case "managed-linux":
      return {
        ...base,
        collectionClass: cls,
        exporterPorts: [9100],
        // heartbeat defaults ON (issue #30) to match the schema default; a test opts out with
        // `{ heartbeat: false }`. cadvisor stays off unless a test opts in.
        heartbeat: true,
        commandSignals: [],
        ...overrides,
      } as Host;
    case "hypervisor-api":
      return {
        ...base,
        collectionClass: cls,
        apiEndpoint: "https://hv1:8006",
        credential: envRef("HV_TOKEN"),
        ...overrides,
      } as Host;
    case "nas-api":
      // Shipped default: a direct node_exporter scrape with NO apiEndpoint/credential (issue
      // #4). A test exercising the opt-in API-exporter override passes both via `overrides`.
      return {
        ...base,
        collectionClass: cls,
        ...overrides,
      } as Host;
    case "probe-only":
      return {
        ...base,
        collectionClass: cls,
        probe: { kind: "icmp", target: "10.0.0.10" },
        ...overrides,
      } as Host;
    case "excluded":
      return {
        ...base,
        collectionClass: cls,
        suppressed: { class: "excluded", rationale: "decommissioned" },
        ...overrides,
      } as Host;
    default: {
      const never: never = cls;
      throw new Error(`unknown collection class: ${String(never)}`);
    }
  }
}

/** Build a `Service` with sensible defaults, then apply `overrides`. */
export function makeService(overrides: Partial<Service> = {}): Service {
  return {
    name: "svc1",
    host: "host1",
    kind: "web",
    managed: true,
    provenance: PROV,
    ...overrides,
  };
}

/** Build a `Channel` with sensible defaults, then apply `overrides`. */
export function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    name: "chan1",
    kind: "chat",
    credential: envRef("SLACK_TOKEN"),
    provenance: PROV,
    ...overrides,
  };
}

/** Build an `EstateModel` with an empty estate and sensible defaults, then apply `overrides`. */
export function makeModel(overrides: Partial<EstateModel> = {}): EstateModel {
  return {
    schemaMajor: 1,
    estate: {
      name: "home-estate",
      domains: ["example.com"],
      timezone: "UTC",
      deadmanHook: "https://deadman.example.com/ping",
      provenance: PROV,
    },
    hosts: [],
    services: [],
    channels: [],
    routingOverrides: [],
    suppressions: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// rendered-model-v2 composition helpers (08 §4.2)
// ---------------------------------------------------------------------------

/**
 * Build ONE complete valid host for the requested discriminant (08 §4.2). Unlike `makeHost`, the
 * `managed-linux` variant supplies every required field (`cadvisor`, `deliveryForm`) so the v2
 * projection reads them directly. Overrides are applied last.
 */
export function makeV2Host(
  collectionClass: Host["collectionClass"],
  overrides: Record<string, unknown> = {},
): Host {
  const base = { name: "host1", addresses: ["10.0.0.10"], provenance: PROV };
  switch (collectionClass) {
    case "managed-linux":
      return {
        ...base,
        collectionClass,
        exporterPorts: [9100],
        cadvisor: false,
        heartbeat: true,
        deliveryForm: "compose",
        commandSignals: [],
        ...overrides,
      } as Host;
    case "hypervisor-api":
      return {
        ...base,
        collectionClass,
        apiEndpoint: "https://hv1.example.com:8006",
        credential: envRef("HV_TOKEN"),
        ...overrides,
      } as Host;
    case "nas-api":
      // Shipped default: a direct node_exporter scrape with NO apiEndpoint/credential (issue #4).
      return { ...base, collectionClass, ...overrides } as Host;
    case "probe-only":
      return {
        ...base,
        collectionClass,
        probe: { kind: "icmp", target: "10.0.0.10" },
        ...overrides,
      } as Host;
    case "excluded":
      return {
        ...base,
        collectionClass,
        suppressed: { class: "excluded", rationale: "decommissioned" },
        ...overrides,
      } as Host;
    default: {
      const never: never = collectionClass;
      throw new Error(`unknown collection class: ${String(never)}`);
    }
  }
}

/** Build one complete service with stable owner/provenance and focused overrides (08 §4.2). */
export function makeV2Service(overrides: Partial<Service> = {}): Service {
  return makeService(overrides);
}

/** A deterministic, actionable input finding of the requested severity (08 §4.2). Every default
 *  field is fixed so tests stay byte-deterministic. */
export function makeFinding(severity: Finding["severity"], overrides: Partial<Finding> = {}): Finding {
  return {
    severity,
    code: FINDING_CODES.UNRESOLVED_HOST,
    file: "estate.yaml",
    path: "hosts[0]",
    message: `deterministic ${severity} finding`,
    fix: "adjust the estate declaration",
    ...overrides,
  };
}

/**
 * A complete representative model containing every host class and all repeatable v2 variants
 * (08 §4.2): a managed-linux host with custom exporter ports, cAdvisor, and both command-signal
 * outputs; a hypervisor-api host; a nas-api host; a probe-only host; and an excluded host. Its
 * services exercise deep-health, backup freshness, endpoint alerts, an ingress URL, and an
 * in-target suppression. It also declares channels, a routing override, and a standalone
 * suppression. Human-readable text is distinguishable per REQ-A11Y-01. Overrides are applied last.
 */
export function makeRenderedModelV2Model(overrides: Partial<EstateModel> = {}): EstateModel {
  const hosts: Host[] = [
    makeV2Host("managed-linux", {
      name: "app01",
      addresses: ["10.0.0.4"],
      cadvisor: true,
      heartbeat: true,
      exporterPorts: [9100, 9256, 9800],
      expectedChurn: true,
      scrapeIntervalClass: "fast",
      commandSignals: [
        {
          output: "scalar",
          name: "queue depth",
          command: ["/usr/bin/depth", "--queue", "default queue"],
          interval: "30s",
          metric: "queue_depth",
          upMetric: "queue_depth_up",
          labels: { role: "worker" },
        },
        {
          output: "exposition",
          name: "metrics dump",
          command: ["/usr/bin/dump"],
          interval: "60s",
        },
      ],
    }),
    makeV2Host("hypervisor-api", { name: "hv01", addresses: ["10.0.0.5"] }),
    makeV2Host("nas-api", { name: "nas01", addresses: ["10.0.0.6"] }),
    makeV2Host("probe-only", {
      name: "cam01",
      addresses: ["10.0.0.7"],
      probe: { kind: "http", target: "https://cam01.example.com/health", expect: "200" },
    }),
    makeV2Host("excluded", { name: "old01", addresses: ["10.0.0.8"] }),
  ];

  const services: Service[] = [
    makeV2Service({
      name: "grafana",
      host: "app01",
      kind: "http",
      ingressUrl: "https://grafana.example.com",
      deepHealth: {
        endpoint: "https://grafana.example.com/api/health",
        responseMapping: { database: "$.database", version: "$.version" },
        alertExpression: "database < 1",
      },
      alerts: [
        { type: "custom", failureThreshold: 3, description: "grafana degraded" },
        { type: "custom", enabled: true, successThreshold: 2 },
      ],
    }),
    makeV2Service({
      name: "backup",
      host: "app01",
      kind: "job",
      backupFreshness: { signal: "pulse_backup_freshness_age_seconds", threshold: "26h" },
      suppressed: { class: "expected-churn", rationale: "nightly job flaps" },
    }),
  ];

  return makeModel({
    estate: {
      name: "home-estate",
      domains: ["z.example.com", "a.example.com"],
      timezone: "America/Chicago",
      dnsResolver: "10.0.0.1",
      retention: "30d",
      deadmanHook: envRef("DEADMAN_HOOK"),
      provenance: PROV,
    },
    hosts,
    services,
    channels: [
      makeChannel({
        name: "ops",
        kind: "chat",
        credential: envRef("SLACK_TOKEN"),
        options: { channel_id: "C123", apiToken: "should-be-omitted" },
      }),
    ],
    routingOverrides: [{ severity: "critical", channels: ["ops"], provenance: PROV }],
    suppressions: [
      { class: "known-expected", rationale: "maintenance window", target: "old01", provenance: PROV },
    ],
    ...overrides,
  });
}
