/** Pure, deterministic builders for estate-config fixtures (07-testing-strategy.md §2).
 *
 *  Every factory returns a plain **snake_case** object matching the consumer YAML surface
 *  (02-inventory-schema.md), constructed from valid defaults and shallow-merged with the
 *  caller's overrides. There is NO randomness and NO wall-clock read anywhere, so the same
 *  call always yields a deeply-equal value (REQ-DET-01).
 *
 *  These are consumed by the unit/cross-cutting suites (items 012/013). The scale builder
 *  ({@link scaleInventory}) generates N hosts/services under a fixed `host-0001…` naming
 *  scheme; the committed `fixtures/scale/` YAML was produced from it via {@link toYaml}. */

import { stringify } from "yaml";

// ── snake_case input shapes (mirror the schema layer, pre-normalization) ─────

/** A managed-linux host (the default host arm). */
export interface ManagedLinuxHost {
  name: string;
  collection_class: "managed-linux";
  addresses: string[];
  exporter_ports: number[];
  cadvisor?: boolean;
  delivery_form: "compose" | "systemd";
  expected_churn?: boolean;
  scrape_interval_class?: string;
}

/** Any host arm — factories build the managed-linux arm by default; pass a full
 *  override object for the api/probe/excluded arms. */
export type HostInput = Record<string, unknown> & { name: string; collection_class: string };

export interface ChannelInput {
  name: string;
  kind: "chat" | "email" | "push" | "webhook";
  credential: string;
}

export interface ServiceInput {
  name: string;
  host: string;
  kind: string;
  managed: boolean;
  [k: string]: unknown;
}

export interface EstateInput {
  schema_version: number;
  name: string;
  domains: string[];
  dns_resolver?: string;
  timezone: string;
  deadman_hook: string;
  retention?: string;
}

export interface SuppressionInput {
  class: "excluded" | "expected-churn" | "known-expected";
  rationale: string;
  target: string;
}

// ── Element builders (valid defaults + shallow override) ─────────────────────

/** A valid managed-linux host by default. Override `collection_class` plus the arm's
 *  fields to build another class, e.g.
 *  `aHost({ name: "nas", collection_class: "nas-api", api_endpoint: "https://n", credential: "${K}" })`. */
export function aHost(overrides: Partial<ManagedLinuxHost> & Record<string, unknown> = {}): HostInput {
  return {
    name: "host-a",
    collection_class: "managed-linux",
    delivery_form: "compose",
    addresses: ["10.0.0.10"],
    exporter_ports: [9100],
    ...overrides,
  } as HostInput;
}

/** A valid chat channel whose credential is an `${ENV}` reference by default. */
export function aChannel(overrides: Partial<ChannelInput> = {}): ChannelInput {
  return {
    name: "ops-chat",
    kind: "chat",
    credential: "${SLACK_TOKEN}",
    ...overrides,
  };
}

/** A valid service on `host-a` by default. Pass `deep_health`, `backup_freshness`, etc.
 *  through the override object. */
export function aService(overrides: Partial<ServiceInput> = {}): ServiceInput {
  return {
    name: "svc-a",
    host: "host-a",
    kind: "http",
    managed: true,
    ...overrides,
  };
}

/** A valid estate metadata block (schema_version 1, a real IANA zone) by default. */
export function anEstate(overrides: Partial<EstateInput> = {}): EstateInput {
  return {
    schema_version: 1,
    name: "estate-a",
    domains: ["estate-a.example"],
    timezone: "America/Chicago",
    deadman_hook: "${DEADMAN_URL}",
    ...overrides,
  };
}

/** A valid standalone suppression (with rationale + target) by default. */
export function aSuppression(overrides: Partial<SuppressionInput> = {}): SuppressionInput {
  return {
    class: "expected-churn",
    rationale: "Deliberately silenced for a documented reason.",
    target: "some-target",
    ...overrides,
  };
}

// ── Deterministic scale factory (REQ-PERF-01, REQ-DET-01) ────────────────────

/** Zero-padded index → stable id, e.g. `padId(1)` = "0001". Fixed width keeps the
 *  code-unit sort of ids identical to their numeric order (determinism seam). */
export function padId(n: number, width = 4): string {
  return String(n).padStart(width, "0");
}

/** N managed-linux hosts named `host-0001…host-000N`, each with a deterministic address
 *  and exporter port. No randomness (REQ-DET-01). */
export function scaleHosts(n: number): ManagedLinuxHost[] {
  const hosts: ManagedLinuxHost[] = [];
  for (let i = 1; i <= n; i++) {
    const id = padId(i);
    hosts.push({
      name: `host-${id}`,
      collection_class: "managed-linux",
      delivery_form: "compose",
      addresses: [`10.${Math.floor(i / 256)}.${i % 256}.1`],
      exporter_ports: [9100],
    });
  }
  return hosts;
}

/** N services named `service-0001…`, each bound to `host-000i` (so every service.host
 *  resolves). Deterministic, no randomness (REQ-DET-01). */
export function scaleServices(n: number): ServiceInput[] {
  const services: ServiceInput[] = [];
  for (let i = 1; i <= n; i++) {
    const id = padId(i);
    services.push({
      name: `service-${id}`,
      host: `host-${id}`,
      kind: "http",
      managed: true,
    });
  }
  return services;
}

/** A complete, VALID inventory object with `n` hosts and `n` services (default 300),
 *  plus one estate block and one channel. Loads to `ok: true`. Pure + deterministic —
 *  the committed `fixtures/scale/inventory.yaml` is exactly `toYaml(scaleInventory())`. */
export function scaleInventory(n = 300): {
  estate: EstateInput;
  hosts: ManagedLinuxHost[];
  services: ServiceInput[];
  channels: ChannelInput[];
} {
  return {
    estate: anEstate({
      name: "scale-estate",
      domains: ["scale.example"],
      timezone: "UTC",
    }),
    hosts: scaleHosts(n),
    services: scaleServices(n),
    channels: [aChannel({ name: "scale-chat", credential: "${SCALE_TOKEN}" })],
  };
}

// ── Serialization helper ─────────────────────────────────────────────────────

/** Deterministically serialize a factory object to YAML text (no timestamps, stable key
 *  order). Used to author the committed scale fixture; also handy in-memory in tests. */
export function toYaml(obj: unknown): string {
  return stringify(obj);
}
