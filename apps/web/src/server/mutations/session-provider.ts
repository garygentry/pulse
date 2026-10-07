// apps/web/src/server/mutations/session-provider.ts — process-wide write-path snapshot seam.
//
// Routes receive only `ServerContext`, which carries no write-path health, so `/api/session` reads it
// through this module-level provider rather than a new context field. The default (no provider) reports every
// capability false; `index.ts` installs a provider in proxy-header mode only.
// `currentHealthWritePath` feeds the identity-independent /healthz writePath block.

import type { AuthMode, Identity } from "@pulse/web-data/identity";
import type { SessionCapabilities } from "@pulse/web-data/wire";
import type { HealthBody } from "../../shared/snapshot.js";
import { capabilitiesForHealth, computeCapabilities } from "./capabilities.js";
import type { WritePathSnapshot } from "./write-path.js";

/** Reads the live write-path snapshot. Installed by index.ts in proxy-header mode only. */
export type WritePathProvider = () => WritePathSnapshot;

/** Default: no provider → every capability false. */
let provider: WritePathProvider | null = null;

/** Install the live snapshot accessor (at bootstrap, proxy-header only), or clear it with `null`. */
export function setWritePathProvider(next: WritePathProvider | null): void {
  provider = next;
}

/**
 * Restore the default (≡ setWritePathProvider(null)). Test seam: every suite that installs a provider
 * calls this in `afterEach`, so nothing leaks into sibling suites.
 */
export function resetWritePathProvider(): void {
  provider = null;
}

/**
 * Session capabilities for this request (REQ-AUTHZ-01/02). No provider → all false; a THROWING provider
 * fails closed → all false (computeCapabilities(identity, mode, null)). Never throws.
 */
export function currentCapabilities(identity: Identity | null, authMode: AuthMode): SessionCapabilities {
  return computeCapabilities(identity, authMode, currentWritePathSnapshot()).flags;
}

/** Current snapshot, or null when none is installed or the provider throws (fail closed). */
export function currentWritePathSnapshot(): WritePathSnapshot | null {
  if (provider === null) return null;
  try {
    return provider();
  } catch {
    return null;
  }
}

/** The /healthz writePath block. Throwing provider → not-configured (fail closed). Never throws. */
export function currentHealthWritePath(authMode: AuthMode | undefined): NonNullable<HealthBody["writePath"]> {
  return capabilitiesForHealth(authMode, currentWritePathSnapshot());
}
