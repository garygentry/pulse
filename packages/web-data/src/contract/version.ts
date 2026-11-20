// packages/web-data/src/contract/version.ts — contract version and the handshake decision rule.
// Browser-safe and pure: integer comparisons only, no validation beyond the version grammar.

import type { ContractHandshake } from "../wire/session.js";

/** A contract version. Breaking changes bump `major` and reset `minor`; additive changes bump `minor`. */
export interface ContractVersion {
  /** Incremented on any breaking change; `minor` resets to 0. Non-negative integer. */
  readonly major: number;
  /** Incremented on any additive change within a major. Non-negative integer. */
  readonly minor: number;
}

/** What a client needs from a server. A client declares this at build time. */
export interface ClientRequirement {
  /** The contract major the client was built against. */
  readonly major: number;
  /** The lowest minor whose additions the client relies on. */
  readonly minMinor: number;
}

/** The three handshake outcomes. */
export type CompatibilityOutcome = "compatible" | "server-too-old" | "client-too-old";

/** The version this server speaks. */
export const CONTRACT_VERSION: ContractVersion = Object.freeze({ major: 1, minor: 1 });

/**
 * Grammar shared by parseContractVersion and the X-Pulse-Contract header: no leading zeros, ≤ 4 digits
 * per part. No `g`/`y` flag, so `.test()`/`.exec()` keep no `lastIndex` state between calls.
 */
export const CONTRACT_VERSION_PATTERN: RegExp = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

/** Longest valid version string ("9999.9999"); longer input is rejected before the regex runs. */
const MAX_VERSION_LENGTH = 9;

/**
 * The reference decision rule. Rules are applied in order and the first match wins:
 * 1. `server === undefined` (pre-contract server, no `contract` member) → "server-too-old"
 * 2. `server.major > client.major` → "client-too-old"
 * 3. `server.major < client.major` → "server-too-old"
 * 4. `server.minor < client.minMinor` → "server-too-old"
 * 5. otherwise → "compatible"
 * Never throws.
 */
export function decideCompatibility(
  client: ClientRequirement,
  server: Pick<ContractHandshake, "major" | "minor"> | undefined,
): CompatibilityOutcome {
  if (server === undefined) return "server-too-old";
  if (server.major > client.major) return "client-too-old";
  if (server.major < client.major) return "server-too-old";
  if (server.minor < client.minMinor) return "server-too-old";
  return "compatible";
}

/** Format as "<major>.<minor>", e.g. "1.0". */
export function formatContractVersion(v: ContractVersion): string {
  return `${v.major}.${v.minor}`;
}

/**
 * Parse "<major>.<minor>" per CONTRACT_VERSION_PATTERN.
 * @returns the version, or null for any malformed input (never throws)
 */
export function parseContractVersion(s: string): ContractVersion | null {
  if (typeof s !== "string" || s.length > MAX_VERSION_LENGTH) return null;
  const m = CONTRACT_VERSION_PATTERN.exec(s);
  if (m === null) return null;
  return Object.freeze({ major: Number.parseInt(m[1]!, 10), minor: Number.parseInt(m[2]!, 10) });
}
