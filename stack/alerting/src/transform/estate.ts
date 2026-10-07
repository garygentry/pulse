// stack/alerting/src/transform/estate.ts
// The estate model is CONSUMED BY REFERENCE from @pulse/core (00 §2, CON-06). Every shape below is
// `import type`d from the verified core barrel and NEVER re-declared here; `loadAndValidate` is the
// read/validate seam render.ts (008) drives. Small field-access helpers the later rule/route builders
// (004-008) reuse live here so lookups and secret-vs-literal checks stay consistent.

import type {
  EstateModel,
  Estate,
  Host,
  Service,
  DeepHealthProbe,
  BackupFreshness,
  Channel,
  ChannelKind,
  RoutingOverride,
  Suppression,
  SuppressionMark,
  SuppressionClass,
  SecretRef,
} from "@pulse/core";
import { loadAndValidate } from "@pulse/core";

// Re-export the consumed vocabulary so downstream builders import the estate shapes from one hub
// (still @pulse/core's types — nothing is re-declared).
export type {
  EstateModel,
  Estate,
  Host,
  Service,
  DeepHealthProbe,
  BackupFreshness,
  Channel,
  ChannelKind,
  RoutingOverride,
  Suppression,
  SuppressionMark,
  SuppressionClass,
  SecretRef,
} from "@pulse/core";
export { loadAndValidate } from "@pulse/core";

/** A service known to declare a deep-health probe (narrowed for the deep-health rule builder, 004). */
export type ServiceWithDeepHealth = Service & { deepHealth: DeepHealthProbe };

/** A service known to declare backup-freshness (narrowed for the backup rule builder, 004). */
export type ServiceWithBackup = Service & { backupFreshness: BackupFreshness };

/** True iff `value` is a SecretRef (an `{ kind, … }` object), not a plain string literal. Used to
 *  detect a resolved literal where a reference belongs — e.g. `estate.deadmanHook` (006, REQ-SEC-01). */
export function isSecretRef(value: SecretRef | string): value is SecretRef {
  return typeof value === "object" && value !== null && "kind" in value;
}

/** Estate-level metadata block. */
export function estateMeta(model: EstateModel): Estate {
  return model.estate;
}

/** Services that declare a deep-health probe, insertion order preserved (REQ-DET-01). */
export function deepHealthServices(model: EstateModel): ServiceWithDeepHealth[] {
  return model.services.filter(
    (s): s is ServiceWithDeepHealth => s.deepHealth !== undefined,
  );
}

/** Services that declare backup-freshness, insertion order preserved. */
export function backupServices(model: EstateModel): ServiceWithBackup[] {
  return model.services.filter(
    (s): s is ServiceWithBackup => s.backupFreshness !== undefined,
  );
}

/** Host lookup by name (Host.name is unique across the estate). */
export function hostsByName(model: EstateModel): Map<string, Host> {
  return new Map(model.hosts.map((h) => [h.name, h]));
}

/** Service lookup by name (Service.name is unique — REQ-SVC-01). */
export function servicesByName(model: EstateModel): Map<string, Service> {
  return new Map(model.services.map((s) => [s.name, s]));
}

/** Channel lookup by name (Channel.name is unique across the estate). */
export function channelsByName(model: EstateModel): Map<string, Channel> {
  return new Map(model.channels.map((c) => [c.name, c]));
}

/** Channels of a given kind (e.g. the human `chat`/`email`/`push` channels vs `webhook`). */
export function channelsOfKind(model: EstateModel, kind: ChannelKind): Channel[] {
  return model.channels.filter((c) => c.kind === kind);
}

/** The severity→channel routing override for `severity`, if any (routing is consumed from the
 *  rendered tree — this is a model-side lookup only). */
export function routingOverrideFor(
  model: EstateModel,
  severity: string,
): RoutingOverride | undefined {
  return model.routingOverrides.find((r) => r.severity === severity);
}

/** Standalone suppressions of a given class (drives inhibit-rule generation, 006). */
export function suppressionsOfClass(
  model: EstateModel,
  cls: SuppressionClass,
): Suppression[] {
  return model.suppressions.filter((s) => s.class === cls);
}

/** A suppression mark carried in-place on a host/service target (REQ-SUPP-03). */
export interface SuppressedTarget {
  /** Whether the mark sits on a host or a service. */
  readonly kind: "host" | "service";
  /** The host/service name carrying the mark. */
  readonly name: string;
  /** The in-place suppression mark. */
  readonly mark: SuppressionMark;
}

/** Every in-place suppression mark across hosts and services (`excluded` hosts + suppressed services),
 *  hosts first then services, each in insertion order (deterministic). */
export function suppressedTargets(model: EstateModel): SuppressedTarget[] {
  const out: SuppressedTarget[] = [];
  for (const h of model.hosts) {
    if (h.collectionClass === "excluded") {
      out.push({ kind: "host", name: h.name, mark: h.suppressed });
    }
  }
  for (const s of model.services) {
    if (s.suppressed !== undefined) {
      out.push({ kind: "service", name: s.name, mark: s.suppressed });
    }
  }
  return out;
}

/** Hosts flagged `expectedChurn: true` — scope the narrow churn-only inhibit rule (006, REQ-SUPP-03). */
export function expectedChurnHosts(model: EstateModel): Host[] {
  return model.hosts.filter((h) => h.expectedChurn === true);
}
