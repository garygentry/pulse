// apps/web/src/server/mutations/capabilities.ts — the pure capability rule
// (REQ-AUTHZ-01/02/03).
//
// A capability is true iff auth mode is proxy-header AND a trusted identity is present AND every store it
// depends on is healthy. `capabilitiesForHealth` is the identity-independent /healthz variant.

import type { AuthMode, Identity } from "@pulse/web-data/identity";
import type { SessionCapabilities } from "@pulse/web-data/wire";
import type { HealthWritePathEntry } from "../../shared/snapshot.js";
import type { CapabilityName } from "./registry.js";
import type { WritePathReason, WritePathSnapshot, WritePathStore } from "./write-path.js";

/** Every capability name, in wire order. */
export const CAPABILITY_NAMES: readonly CapabilityName[] = ["silence", "ack", "proposeEstateEdit"] as const;

/** Stores each capability depends on (besides mode + identity). Order = reason precedence. */
export const CAPABILITY_STORES: Readonly<Record<CapabilityName, readonly WritePathStore[]>> = {
  silence: ["audit", "alertmanager"],
  ack: ["audit", "acks"],
  proposeEstateEdit: ["audit", "proposals", "secret"],
};

/** Why a capability is false (null when true). */
export type CapabilityDenial =
  | { readonly kind: "mode" } // authMode !== "proxy-header"
  | { readonly kind: "identity" } // no trusted identity
  | { readonly kind: "store"; readonly store: WritePathStore; readonly reason: WritePathReason };

/**
 * Pure capability rule (REQ-AUTHZ-01/02). A capability is true iff mode is proxy-header AND a trusted
 * identity is present AND every store in CAPABILITY_STORES[cap] is ok. No per-user rule (AUTHZ-01).
 * Denial precedence: mode > identity > first failing store (CAPABILITY_STORES order).
 * A `null` snapshot (no WritePath installed) → ALL flags false, denial store `audit` /
 * `not-configured`.
 *
 * @param identity - The request's trusted identity, or null.
 * @param authMode - `config.identity.mode`.
 * @param writePath - The live write-path snapshot, or null when none is installed.
 * @returns Frozen flags plus the first denial per capability (null when the capability is granted).
 */
export function computeCapabilities(
  identity: Identity | null,
  authMode: AuthMode,
  writePath: WritePathSnapshot | null,
): { readonly flags: SessionCapabilities; readonly denials: Readonly<Record<CapabilityName, CapabilityDenial | null>> } {
  const denials = {} as Record<CapabilityName, CapabilityDenial | null>;
  for (const cap of CAPABILITY_NAMES) denials[cap] = denialFor(cap, identity, authMode, writePath);
  const flags: SessionCapabilities = {
    silence: denials.silence === null,
    ack: denials.ack === null,
    proposeEstateEdit: denials.proposeEstateEdit === null,
  };
  return Object.freeze({ flags: Object.freeze(flags), denials: Object.freeze(denials) });
}

/** First denial for one capability, in precedence order; null when granted. */
function denialFor(
  cap: CapabilityName,
  identity: Identity | null,
  authMode: AuthMode,
  wp: WritePathSnapshot | null,
): CapabilityDenial | null {
  if (authMode !== "proxy-header") return { kind: "mode" };
  if (identity === null) return { kind: "identity" };
  if (wp === null) return { kind: "store", store: "audit", reason: "not-configured" };
  for (const store of CAPABILITY_STORES[cap]) {
    const s = wp[store];
    if (!s.ok) return { kind: "store", store, reason: s.reason ?? "write-failed" };
  }
  return null;
}

/**
 * Identity-independent per-capability availability for /healthz: "would this capability be available
 * to a trusted caller right now?" (REQ-OBS-02, REQ-CFG-03). Mode other than proxy-header (incl. an
 * unreadable `undefined` mode) → every entry `auth-mode-none`. Proxy-header with no installed WritePath
 * → `not-configured`. Otherwise the first failing store's reason in CAPABILITY_STORES order. Pure, total.
 *
 * @param authMode - `config.identity.mode`, possibly undefined when read defensively.
 * @param writePath - The live write-path snapshot, or null when none is installed.
 * @returns One fresh entry per capability.
 */
export function capabilitiesForHealth(
  authMode: AuthMode | undefined,
  writePath: WritePathSnapshot | null,
): { silence: HealthWritePathEntry; ack: HealthWritePathEntry; proposeEstateEdit: HealthWritePathEntry } {
  const entry = (cap: CapabilityName): HealthWritePathEntry => {
    if (authMode !== "proxy-header") return { ok: false, reason: "auth-mode-none" };
    if (writePath === null) return { ok: false, reason: "not-configured" };
    for (const store of CAPABILITY_STORES[cap]) {
      const s = writePath[store];
      if (!s.ok) return { ok: false, reason: s.reason ?? "write-failed" };
    }
    return { ok: true, reason: null };
  };
  return { silence: entry("silence"), ack: entry("ack"), proposeEstateEdit: entry("proposeEstateEdit") };
}
