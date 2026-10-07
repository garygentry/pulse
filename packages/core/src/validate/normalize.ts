/** Thin-normalization transform (04-validation-and-normalization.md §4). Transforms the
 *  snake_case, shape-validated tree into the camelCase EstateModel (00 §3). Runs ONLY after
 *  validateAndNormalize's gate confirms zero error findings, so every invariant of §3 already
 *  holds — normalize is a total function of a known-good tree with no config-error path. The
 *  `switch` default and `requireRef` throw are unreachable internal assertions, never config
 *  output (tech-spec §3.8). No code path reads env/1Password/FS (REQ-SECR-03). */

import type {
  EstateModel,
  Estate,
  Host,
  Service,
  Channel,
  RoutingOverride,
  Suppression,
  SuppressionMark,
  SecretRef,
  ProbeSpec,
  DeepHealthProbe,
  BackupFreshness,
  EndpointAlert,
  CommandSignal,
} from "../model/index.js";
import type { ProvenanceIndex } from "../loader/index.js";
import type { CommandSignalInput } from "../schema/index.js";
import { parseSecretRef } from "../schema/secret-ref.js";
import { CURRENT_SCHEMA_MAJOR } from "../version/index.js";
import type { MergedInventory } from "./index.js";

type MergedEstate = NonNullable<MergedInventory["estate"]>;
type MergedHost = NonNullable<MergedInventory["hosts"]>[number];
type MergedService = NonNullable<MergedInventory["services"]>[number];
type MergedChannel = NonNullable<MergedInventory["channels"]>[number];
type MergedRouting = NonNullable<MergedInventory["routing_overrides"]>[number];
type MergedSuppression = NonNullable<MergedInventory["suppressions"]>[number];

/**
 * Transform the snake_case validated tree into the camelCase, thin-normalized EstateModel
 * (00 §3). `exactOptionalPropertyTypes` is on (01 §2.3), so optional fields are added
 * conditionally via spread, never assigned `undefined`.
 */
export function normalize(merged: MergedInventory, prov: ProvenanceIndex): EstateModel {
  return {
    // Version already recognized/short-circuited upstream (06); `schema_version` lives inside
    // the estate block (02 §4.1 / 06 §3) and is present/valid by the gate.
    schemaMajor: merged.estate?.schema_version ?? CURRENT_SCHEMA_MAJOR,
    estate: normalizeEstate(merged.estate as MergedEstate, prov),
    hosts: (merged.hosts ?? []).map((h, i) => normalizeHost(h, i, prov)),
    services: (merged.services ?? []).map((s, i) => normalizeService(s, i, prov)),
    channels: (merged.channels ?? []).map((c, i) => normalizeChannel(c, i, prov)),
    routingOverrides: (merged.routing_overrides ?? []).map((r, i) =>
      normalizeRoutingOverride(r, i, prov),
    ),
    suppressions: (merged.suppressions ?? []).map((s, i) => normalizeSuppression(s, i, prov)),
  };
}

// ── §4.1 Estate ──────────────────────────────────────────────────────────────

function normalizeEstate(e: MergedEstate, prov: ProvenanceIndex): Estate {
  return {
    name: e.name,
    domains: e.domains,
    ...(e.dns_resolver !== undefined ? { dnsResolver: e.dns_resolver } : {}),
    timezone: e.timezone,
    // deadman_hook is a plain identifier unless it matches a reference grammar (§3.2).
    deadmanHook: parseSecretRef(e.deadman_hook) ?? e.deadman_hook,
    ...(e.retention !== undefined ? { retention: e.retention } : {}),
    provenance: prov.lookup("estate"),
  };
}

// ── §4.2 Hosts (discriminated on collectionClass, REQ-HOST-02/03) ────────────

function normalizeHost(h: MergedHost, i: number, prov: ProvenanceIndex): Host {
  const base = {
    name: h.name,
    addresses: h.addresses,
    ...(h.expected_churn !== undefined ? { expectedChurn: h.expected_churn } : {}),
    ...(h.scrape_interval_class !== undefined
      ? { scrapeIntervalClass: h.scrape_interval_class }
      : {}),
    provenance: prov.lookup(`hosts[${i}]`),
  };
  switch (h.collection_class) {
    case "managed-linux":
      return {
        ...base,
        collectionClass: "managed-linux",
        exporterPorts: h.exporter_ports,
        cadvisor: h.cadvisor,
        heartbeat: h.heartbeat,
        deliveryForm: h.delivery_form,
        // `command_signals` is optional in YAML; the model always carries the array (possibly
        // empty) so downstream never branches on presence (issue #3). Uniqueness/host-class were
        // enforced pre-gate (checkCommandSignals / the managed-linux-only schema placement).
        commandSignals: (h.command_signals ?? []).map((cs, j) =>
          normalizeCommandSignal(cs, `hosts[${i}].command_signals[${j}]`),
        ),
      };
    case "hypervisor-api":
      return {
        ...base,
        collectionClass: "hypervisor-api",
        apiEndpoint: h.api_endpoint,
        credential: requireRef(h.credential, `hosts[${i}].credential`),
      };
    case "nas-api":
      // `api_endpoint`/`credential` are optional, reserved override fields (issue #4);
      // include each only when declared. Both-or-neither is guaranteed pre-gate by
      // checkNasApiCompleteness, so a present credential is always paired with an endpoint.
      return {
        ...base,
        collectionClass: "nas-api",
        ...(h.api_endpoint !== undefined ? { apiEndpoint: h.api_endpoint } : {}),
        ...(h.credential !== undefined
          ? { credential: requireRef(h.credential, `hosts[${i}].credential`) }
          : {}),
      };
    case "probe-only":
      return { ...base, collectionClass: "probe-only", probe: normalizeProbe(h.probe) };
    case "excluded":
      return {
        ...base,
        collectionClass: "excluded",
        // `suppressed` mark carried on the excluded arm (02 §4.2 / 00 §3.2); rationale
        // presence was already enforced by checkSuppressionRationales (§3.1).
        suppressed: { class: h.suppressed.class, rationale: h.suppressed.rationale },
      };
    default:
      // Unreachable: §3.5 gated on a valid class. Internal assertion, not config output.
      throw new Error(`internal: unhandled collection_class at hosts[${i}]`);
  }
}

function normalizeProbe(p: {
  kind: string;
  target: string;
  expect?: string | undefined;
}): ProbeSpec {
  return {
    kind: p.kind,
    target: p.target,
    ...(p.expect !== undefined ? { expect: p.expect } : {}),
  };
}

/** Normalize one command-signal (issue #3). `up_metric` → `upMetric`; `credential` parsed to a
 *  SecretRef (a non-reference was already an error pre-gate — checkSecretLiterals). */
function normalizeCommandSignal(cs: CommandSignalInput, path: string): CommandSignal {
  const cred =
    cs.credential !== undefined
      ? { credential: requireRef(cs.credential, `${path}.credential`) }
      : {};
  if (cs.output === "scalar") {
    return {
      output: "scalar",
      name: cs.name,
      command: cs.command,
      interval: cs.interval,
      metric: cs.metric,
      upMetric: cs.up_metric,
      ...(cs.labels !== undefined ? { labels: cs.labels } : {}),
      ...cred,
    };
  }
  return {
    output: "exposition",
    name: cs.name,
    command: cs.command,
    interval: cs.interval,
    ...cred,
  };
}

// ── §4.3 Services (REQ-SVC-01/02/03/04) ──────────────────────────────────────

function normalizeService(s: MergedService, i: number, prov: ProvenanceIndex): Service {
  return {
    name: s.name,
    host: s.host, // carried as a resolved name (integrity checked in §3.3)
    kind: s.kind,
    managed: s.managed,
    ...(s.ingress_url !== undefined ? { ingressUrl: s.ingress_url } : {}),
    ...(s.deep_health !== undefined
      ? { deepHealth: normalizeDeepHealth(s.deep_health, i) }
      : {}),
    ...(s.backup_freshness !== undefined
      ? { backupFreshness: normalizeBackup(s.backup_freshness) }
      : {}),
    ...(s.alerts !== undefined ? { alerts: s.alerts.map(normalizeEndpointAlert) } : {}),
    ...(s.suppressed !== undefined ? { suppressed: normalizeMark(s.suppressed) } : {}),
    provenance: prov.lookup(`services[${i}]`),
  };
}

function normalizeDeepHealth(d: {
  endpoint: string;
  response_mapping: Record<string, string>;
  alert_expression: string;
  credential?: string | undefined;
  host_local?: boolean | undefined;
}, serviceIndex: number): DeepHealthProbe {
  return {
    endpoint: d.endpoint,
    responseMapping: d.response_mapping,
    alertExpression: d.alert_expression,
    ...(d.credential !== undefined
      ? {
          credential: requireRef(
            d.credential,
            `services[${serviceIndex}].deep_health.credential`,
          ),
        }
      : {}),
    ...(d.host_local !== undefined ? { hostLocal: d.host_local } : {}),
  };
}

/** Normalize one per-endpoint alert binding (issue #15): snake_case → camelCase, optional fields
 *  added conditionally (exactOptionalPropertyTypes). */
function normalizeEndpointAlert(a: {
  type: string;
  enabled?: boolean | undefined;
  description?: string | undefined;
  failure_threshold?: number | undefined;
  success_threshold?: number | undefined;
  send_on_resolved?: boolean | undefined;
}): EndpointAlert {
  return {
    type: a.type,
    ...(a.enabled !== undefined ? { enabled: a.enabled } : {}),
    ...(a.description !== undefined ? { description: a.description } : {}),
    ...(a.failure_threshold !== undefined ? { failureThreshold: a.failure_threshold } : {}),
    ...(a.success_threshold !== undefined ? { successThreshold: a.success_threshold } : {}),
    ...(a.send_on_resolved !== undefined ? { sendOnResolved: a.send_on_resolved } : {}),
  };
}

function normalizeBackup(b: {
  signal: string;
  threshold: string;
  command?: string[] | undefined;
  interval?: string | undefined;
}): BackupFreshness {
  return {
    signal: b.signal,
    threshold: b.threshold,
    ...(b.command !== undefined ? { command: b.command } : {}),
    ...(b.interval !== undefined ? { interval: b.interval } : {}),
  };
}

/** class values are identical strings in YAML and model — no case change. */
function normalizeMark(m: { class: SuppressionMark["class"]; rationale: string }): SuppressionMark {
  return { class: m.class, rationale: m.rationale };
}

// ── §4.4 Channels, routing, suppressions, and secret parsing ─────────────────

/** Parse a credential slot to a SecretRef. Post-gate this always succeeds (§3.2). */
function requireRef(value: string, path: string): SecretRef {
  const ref = parseSecretRef(value);
  if (ref === undefined) {
    // Unreachable: checkSecretLiterals (§3.2) errors on any non-reference before the gate.
    throw new Error(`internal: unparsed credential reached normalize at ${path}`);
  }
  return ref;
}

function normalizeChannel(c: MergedChannel, i: number, prov: ProvenanceIndex): Channel {
  return {
    name: c.name,
    kind: c.kind,
    credential: requireRef(c.credential, `channels[${i}].credential`),
    // `options` is the generic, non-secret per-kind map (issue #2); pass through when declared.
    ...(c.options !== undefined ? { options: c.options } : {}),
    provenance: prov.lookup(`channels[${i}]`),
  };
}

function normalizeRoutingOverride(
  r: MergedRouting,
  i: number,
  prov: ProvenanceIndex,
): RoutingOverride {
  return {
    severity: r.severity,
    channels: r.channels, // resolved names (integrity checked in §3.3)
    provenance: prov.lookup(`routing_overrides[${i}]`),
  };
}

function normalizeSuppression(s: MergedSuppression, i: number, prov: ProvenanceIndex): Suppression {
  return {
    class: s.class,
    rationale: s.rationale, // presence guaranteed by §3.1
    target: s.target,
    provenance: prov.lookup(`suppressions[${i}]`),
  };
}
