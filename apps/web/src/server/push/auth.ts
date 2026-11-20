// Push authorisers: device credential, shared secrets (webhook and operator) and the browser gate.
//
// Every authoriser is pure: it never throws, never logs and never counts. Counting is done by the callers. Each
// failure returns one frozen value, so missing, malformed, unknown and revoked credentials look identical.

import { BEARER_CREDENTIAL_PATTERN } from "@pulse/web-data/contract";
import { resolveIdentity, type Identity, type IdentityConfig } from "@pulse/web-data/identity";

import { checkSameOrigin } from "../mutations/guards.js";
import type { DeviceRecord } from "./registry/schema.js";
import { digestEquals, hashCredential, matchesSecret, type PushSecret } from "./secrets.js";

const BEARER_PREFIX = "Bearer ";

/** Result of {@link authoriseDevice}. */
export type DeviceAuthResult =
  | {
      /** The credential resolved to a registered device. */
      readonly ok: true;
      /** The device the credential belongs to. */
      readonly device: DeviceRecord;
    }
  | {
      /** The request is refused. */
      readonly ok: false;
      /** Always "unauthorized", whatever the cause. */
      readonly refusal: "unauthorized";
    };

/** The credential index the device authoriser reads. */
export interface DeviceCredentialIndex {
  /** The device whose credential hashes to `hash`, if any. */
  byCredentialHash(hash: string): DeviceRecord | undefined;
}

const UNAUTHORIZED: DeviceAuthResult = Object.freeze({ ok: false, refusal: "unauthorized" });

/**
 * Authorise a device request by its bearer credential.
 *
 * The header must match the anchored bearer pattern, which admits no comma and no second space, so a repeated or
 * comma-joined header is refused. The credential's SHA-256 is looked up in the index and the hit is confirmed with a
 * constant-time digest comparison.
 *
 * @param headers - The request headers.
 * @param store   - The credential index.
 * @returns The device, or the single frozen unauthorized result.
 */
export function authoriseDevice(headers: Headers, store: DeviceCredentialIndex): DeviceAuthResult {
  try {
    const raw = headers.get("authorization");
    if (raw === null || !BEARER_CREDENTIAL_PATTERN.test(raw)) return UNAUTHORIZED;
    const hash = hashCredential(raw.slice(BEARER_PREFIX.length));
    const record = store.byCredentialHash(hash);
    if (record === undefined) return UNAUTHORIZED;
    if (!digestEquals(hash, record.credentialHash)) return UNAUTHORIZED;
    return Object.freeze({ ok: true, device: record });
  } catch {
    return UNAUTHORIZED;
  }
}

/**
 * Authorise a shared-secret request (the webhook or the operator surface). The scheme is matched case-sensitively as
 * `Bearer` plus one space; the remainder is compared with the held secret in constant time. A repeated header joins
 * into a value that cannot match.
 *
 * @param request - The request.
 * @param secret  - The held secret for this surface.
 * @returns true only for the exact secret.
 */
export function authoriseSecret(request: Request, secret: PushSecret): boolean {
  try {
    const raw = request.headers.get("authorization");
    if (raw === null || !raw.startsWith(BEARER_PREFIX)) return false;
    const presented = raw.slice(BEARER_PREFIX.length);
    if (presented === "") return false;
    return matchesSecret(presented, secret);
  } catch {
    return false;
  }
}

/** Result of {@link authoriseBrowser}. */
export type BrowserGateResult =
  | {
      /** The gate passed. */
      readonly ok: true;
      /** The trusted identity in proxy-header mode; null in no-auth mode. */
      readonly identity: Identity | null;
    }
  | {
      /** The gate refused. */
      readonly ok: false;
      /** Why: no trusted identity, or a cross-origin write. */
      readonly refusal: "untrusted-identity" | "cross-origin";
    };

const UNTRUSTED: BrowserGateResult = Object.freeze({ ok: false, refusal: "untrusted-identity" });
const CROSS_ORIGIN: BrowserGateResult = Object.freeze({ ok: false, refusal: "cross-origin" });
const OPEN: BrowserGateResult = Object.freeze({ ok: true, identity: null });

/**
 * The browser gate for web-only push routes.
 *
 * - proxy-header mode: a trusted identity is required for both variants.
 * - "write", in every mode: the same-origin check must pass.
 * - "read" in no-auth mode: nothing is checked.
 *
 * Identity runs before same-origin, as in the mutation pipeline. Both refusals answer the same status and body.
 *
 * @param request        - The request.
 * @param peerIp         - The direct peer address, or null.
 * @param identityConfig - The trusted-identity configuration.
 * @param variant        - "read" for GET routes, "write" otherwise.
 */
export function authoriseBrowser(
  request: Request,
  peerIp: string | null,
  identityConfig: IdentityConfig,
  variant: "read" | "write",
): BrowserGateResult {
  try {
    let identity: Identity | null = null;
    if (identityConfig.mode === "proxy-header") {
      identity = resolveIdentity(request, peerIp, identityConfig);
      if (identity === null) return UNTRUSTED;
    }
    if (variant === "write" && !checkSameOrigin(request.headers).ok) return CROSS_ORIGIN;
    return identity === null ? OPEN : Object.freeze({ ok: true, identity });
  } catch {
    return variant === "write" ? CROSS_ORIGIN : UNTRUSTED;
  }
}
