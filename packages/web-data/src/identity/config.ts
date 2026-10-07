// packages/web-data/src/identity/config.ts — trusted-identity configuration parsing
// (09-identity-audit-and-dark-mutation-seams.md §2, contracts from 01-core-definitions.md §8).
// Pure, deny-by-default validation of the mode / proxy-header name / trusted-proxy CIDR
// list. Uses `ipaddr.js` 2.5.0 (MIT) only for CIDR parsing/normalization; never touches
// the network, DNS, global state, or the configured values in any error/warning text.

import * as ipaddr from "ipaddr.js";

/** Trusted-identity mode; `none` disables header trust unconditionally. */
export type AuthMode = "none" | "proxy-header";

/** Stable, value-free category for a non-fatal identity configuration warning. */
export type IdentityWarningCode = "identity-settings-ignored" | "trusted-proxies-empty";

/** A non-fatal identity configuration warning carrying only a fixed safe category/message. */
export interface IdentityWarning {
  /** Stable warning category; no configured value is retained. */ readonly code: IdentityWarningCode;
  /** Fixed safe operator message. */ readonly message: string;
}

/** Stable category for a fatal identity configuration error. */
export type IdentityConfigErrorCode = "invalid-mode" | "invalid-header" | "invalid-cidr" | "too-many-cidrs";

/**
 * Fixed operator-facing messages for each identity configuration error category. Each names
 * the environment key the operator must correct but never interpolates the supplied value.
 */
export const IDENTITY_CONFIG_ERROR_MESSAGES: Readonly<Record<IdentityConfigErrorCode, string>> = {
  "invalid-mode": "PULSE_WEB_AUTH_MODE must be none or proxy-header.",
  "invalid-header": "PULSE_WEB_AUTH_HEADER must be a valid HTTP field name.",
  "invalid-cidr": "PULSE_WEB_TRUSTED_PROXIES must contain valid IPv4 or IPv6 CIDRs.",
  "too-many-cidrs": "PULSE_WEB_TRUSTED_PROXIES exceeds the supported CIDR limit.",
};

/** A fatal identity configuration error; its message never contains the rejected value. */
export interface IdentityConfigError {
  /** Stable invalid configuration category. */ readonly code: IdentityConfigErrorCode;
  /** Safe message naming the environment key, never its value. */ readonly message: string;
  /** Environment key the operator must correct. */ readonly envVar: string;
}

/** Validated, canonical trusted-identity configuration consumed by {@link resolveIdentity}. */
export interface IdentityConfig {
  /** Identity mode; none disables header trust unconditionally. */ readonly mode: AuthMode;
  /** Validated RFC-token header name. */ readonly headerName: string;
  /** Canonical validated CIDRs; empty denies every peer. */ readonly trustedProxies: readonly string[];
}

/** Raw, pre-validation identity configuration read from the environment. */
export interface IdentityConfigInput {
  /** Configured mode, or null to accept the `none` default. */ readonly mode: string | null;
  /** Configured proxy header name, or null to accept the `Remote-User` default. */ readonly headerName: string | null;
  /** Comma-separated trusted-proxy CIDRs, or null for an empty deny-all list. */ readonly trustedProxies: string | null;
}

/** Discriminated result of {@link parseIdentityConfig}: canonical config with warnings, or a fatal error. */
export type IdentityConfigResult =
  | {
      /** Parsing succeeded. */ readonly ok: true;
      /** Canonical validated configuration. */ readonly config: IdentityConfig;
      /** Non-fatal categorical warnings, if any. */ readonly warnings: readonly IdentityWarning[];
    }
  | {
      /** Parsing failed. */ readonly ok: false;
      /** The fatal configuration error. */ readonly error: IdentityConfigError;
    };

/** Environment key the operator sets to choose the authentication mode. */
const MODE_ENV_VAR = "PULSE_WEB_AUTH_MODE";
/** Environment key the operator sets to choose the trusted proxy header name. */
const HEADER_ENV_VAR = "PULSE_WEB_AUTH_HEADER";
/** Environment key the operator sets to list trusted proxy CIDRs. */
const TRUSTED_PROXIES_ENV_VAR = "PULSE_WEB_TRUSTED_PROXIES";

/** Default proxy header name when unset. */
const DEFAULT_HEADER_NAME = "Remote-User";
/** Maximum accepted proxy header name length, in ASCII bytes. */
const MAX_HEADER_BYTES = 128;
/** Maximum number of configured trusted-proxy CIDRs. */
const MAX_TRUSTED_PROXIES = 64;

/** RFC 9110 `token` characters permitted in an HTTP field name. */
const TOKEN_CHARS = new Set(
  "!#$%&'*+-.^_`|~0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
);

/** Fixed safe warning messages keyed by category; never contain a configured value. */
const WARNING_MESSAGES: Readonly<Record<IdentityWarningCode, string>> = {
  "identity-settings-ignored":
    "Identity trust settings are ignored because the authentication mode is none.",
  "trusted-proxies-empty":
    "Proxy-header mode trusts no proxies; every request is treated as anonymous until a trusted CIDR is configured.",
};

/** Build a fatal error result without echoing the rejected value. */
function configError(code: IdentityConfigErrorCode, envVar: string): IdentityConfigResult {
  return { ok: false, error: { code, message: IDENTITY_CONFIG_ERROR_MESSAGES[code], envVar } };
}

/** True when every byte of `value` is a valid RFC 9110 token character and within length. */
function isValidHeaderToken(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HEADER_BYTES) return false;
  for (const ch of value) {
    // Token chars are ASCII, so a multi-byte code unit is already out of range.
    if (!TOKEN_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * Parse a single trusted-proxy CIDR member into its canonical `network/prefix` string, or
 * null when the member is malformed. Rejects zone ids and bare addresses without a prefix.
 */
function canonicalizeCidr(member: string): string | null {
  if (member.length === 0) return null;
  if (member.includes("%")) return null; // zone ids are rejected
  if (!member.includes("/")) return null; // a bare address without a prefix is rejected
  let parsed: [ipaddr.IPv4 | ipaddr.IPv6, number];
  try {
    parsed = ipaddr.parseCIDR(member);
  } catch {
    return null;
  }
  const [addr, prefix] = parsed;
  try {
    if (addr.kind() === "ipv4") {
      return `${ipaddr.IPv4.networkAddressFromCIDR(member).toNormalizedString()}/${prefix}`;
    }
    return `${ipaddr.IPv6.networkAddressFromCIDR(member).toNormalizedString()}/${prefix}`;
  } catch {
    return null;
  }
}

/**
 * Validate and canonicalize raw identity configuration. Returns the canonical {@link IdentityConfig}
 * plus any categorical warnings, or the first fatal {@link IdentityConfigError}. Pure: performs no
 * I/O, DNS resolution, or global mutation, and never places a configured value in a message.
 */
export function parseIdentityConfig(input: IdentityConfigInput): IdentityConfigResult {
  // Mode — default none; only the two literals are accepted.
  const rawMode = input.mode === null ? null : input.mode.trim();
  let mode: AuthMode;
  if (rawMode === null || rawMode === "") {
    mode = "none";
  } else if (rawMode === "none" || rawMode === "proxy-header") {
    mode = rawMode;
  } else {
    return configError("invalid-mode", MODE_ENV_VAR);
  }

  // Header — default Remote-User; RFC 9110 token, <=128 ASCII bytes.
  let headerName: string;
  if (input.headerName === null) {
    headerName = DEFAULT_HEADER_NAME;
  } else {
    const trimmed = input.headerName.trim();
    if (!isValidHeaderToken(trimmed)) {
      return configError("invalid-header", HEADER_ENV_VAR);
    }
    headerName = trimmed;
  }

  // Trusted proxies — comma-separated CIDRs; canonicalized and deduped.
  const trustedRaw = input.trustedProxies === null ? "" : input.trustedProxies.trim();
  const trustedProxies: string[] = [];
  if (trustedRaw !== "") {
    const members = trustedRaw.split(",").map((m) => m.trim());
    if (members.length > MAX_TRUSTED_PROXIES) {
      return configError("too-many-cidrs", TRUSTED_PROXIES_ENV_VAR);
    }
    const seen = new Set<string>();
    for (const member of members) {
      const canonical = canonicalizeCidr(member);
      if (canonical === null) {
        return configError("invalid-cidr", TRUSTED_PROXIES_ENV_VAR);
      }
      if (!seen.has(canonical)) {
        seen.add(canonical);
        trustedProxies.push(canonical);
      }
    }
  }

  // Warnings — categorical only, never a configured value.
  const warnings: IdentityWarning[] = [];
  const settingsSupplied = input.headerName !== null || trustedRaw !== "";
  if (mode === "none" && settingsSupplied) {
    warnings.push({ code: "identity-settings-ignored", message: WARNING_MESSAGES["identity-settings-ignored"] });
  }
  if (mode === "proxy-header" && trustedProxies.length === 0) {
    warnings.push({ code: "trusted-proxies-empty", message: WARNING_MESSAGES["trusted-proxies-empty"] });
  }

  return { ok: true, config: { mode, headerName, trustedProxies }, warnings };
}
