// packages/web-data/src/contract/capabilities.ts — server capability registry. Browser-safe.
// The registry is the module's only mutable state; registration happens at server bootstrap.

import { ContractError } from "./errors.js";

/** An optional server feature name. Grammar: ^[a-z][a-z0-9-]{0,31}$. */
export type ServerCapability = string;

/** Grammar every capability name must satisfy; registerCapabilityProvider enforces it. */
export const SERVER_CAPABILITY_PATTERN: RegExp = /^[a-z][a-z0-9-]{0,31}$/;

/** Every capability name this contract version defines (`push` since 1.1); each addition is a minor bump. */
export const KNOWN_SERVER_CAPABILITIES: readonly ServerCapability[] = Object.freeze(["push"]);

/** Predicate deciding whether a capability is currently available. Must be synchronous, in-process and side-effect free. */
export type CapabilityProvider = () => boolean;

/** Registered providers keyed by capability name. */
const providers = new Map<ServerCapability, CapabilityProvider>();

/**
 * Register (or replace) the provider for a known capability. The grammar check runs first.
 * @throws {ContractError} code CAPABILITY_INVALID_NAME when `name` fails SERVER_CAPABILITY_PATTERN
 * @throws {ContractError} code CAPABILITY_UNKNOWN when `name` is not in KNOWN_SERVER_CAPABILITIES
 */
export function registerCapabilityProvider(name: ServerCapability, isAvailable: CapabilityProvider): void {
  if (typeof name !== "string" || !SERVER_CAPABILITY_PATTERN.test(name)) {
    throw new ContractError(
      "CAPABILITY_INVALID_NAME",
      String(name),
      "capability name does not match ^[a-z][a-z0-9-]{0,31}$",
    );
  }
  if (!KNOWN_SERVER_CAPABILITIES.includes(name)) {
    throw new ContractError(
      "CAPABILITY_UNKNOWN",
      name,
      "capability is not in KNOWN_SERVER_CAPABILITIES; add it (minor bump) first",
    );
  }
  providers.set(name, isAvailable);
}

/**
 * Sorted names whose provider currently returns exactly `true`. A provider that throws counts as false
 * and is never propagated, so the session response never fails because of a capability.
 */
export function currentServerCapabilities(): readonly ServerCapability[] {
  const out: ServerCapability[] = [];
  for (const [name, provider] of providers) {
    try {
      if (provider() === true) out.push(name);
    } catch {
      // A throwing provider counts as unavailable; each provider owns its own diagnostics.
    }
  }
  out.sort();
  return Object.freeze(out);
}

/**
 * Remove a previously registered provider. Unknown or never-registered names are a no-op (idempotent), so close()
 * paths can call it unconditionally. No grammar or known-name check: removing can never make the registry invalid.
 * @param name - The capability name, e.g. "push".
 */
export function unregisterCapabilityProvider(name: ServerCapability): void {
  providers.delete(name);
}

/** Test-only: remove every registered provider. */
export function __resetCapabilityProvidersForTest(): void {
  providers.clear();
}

/**
 * Test-only seam: install a provider without the KNOWN_SERVER_CAPABILITIES check, so registry behaviour
 * can be exercised while the known list is empty. Not exported from the package barrel.
 */
export function __seedCapabilityProviderForTest(name: ServerCapability, isAvailable: CapabilityProvider): void {
  providers.set(name, isAvailable);
}
