// APNs provider-token signer: a cached ES256 JWT, renewed before Apple's 60-minute limit.

import { sign, type KeyObject } from "node:crypto";
import { PUSH_LIMITS } from "../constants.js";
import type { Clock } from "../ids.js";

/** Cached ES256 provider token for APNs token-based authentication. */
export interface ProviderTokenSigner {
  /**
   * The current provider token (`<header>.<claims>.<signature>`, base64url, no padding). It re-signs when no
   * token is cached, when the cached token is at least `PUSH_LIMITS.jwtRefreshMs` old, when the clock has moved
   * backwards past the signing time, or after `invalidate()`.
   *
   * @throws {Error} Only if `crypto.sign` throws, which cannot happen for an accepted EC P-256 private key.
   */
  current(): string;
  /** Discard the cached token so the next `current()` re-signs (used after `403 ExpiredProviderToken`). */
  invalidate(): void;
}

/** base64url without padding. */
function b64url(input: string | Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(key: KeyObject, keyId: string, teamId: string, iatSeconds: number): string {
  // Object literals fix the JSON key order: alg then kid, iss then iat.
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: iatSeconds }));
  const signingInput = `${header}.${claims}`;
  // ieee-p1363 yields the raw 64-byte r||s signature JWS ES256 requires (DER would be rejected).
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * Create the provider-token signer.
 *
 * @param key - Parsed P-256 private key (`ApnsSettings.key`).
 * @param keyId - 10-character key id, sent as the JWT `kid`.
 * @param teamId - 10-character team id, sent as the JWT `iss`.
 * @param clock - Injectable clock. `iat` is `floor(clock.nowMs() / 1000)`.
 * @returns A signer that never logs and never exposes the key.
 */
export function createProviderTokenSigner(
  key: KeyObject,
  keyId: string,
  teamId: string,
  clock: Clock,
): ProviderTokenSigner {
  let cached: { readonly token: string; readonly signedAtMs: number } | null = null;
  return Object.freeze({
    current(): string {
      const now = clock.nowMs();
      if (cached === null || now - cached.signedAtMs >= PUSH_LIMITS.jwtRefreshMs || now < cached.signedAtMs) {
        cached = { token: signToken(key, keyId, teamId, Math.floor(now / 1000)), signedAtMs: now };
      }
      return cached.token;
    },
    invalidate(): void {
      cached = null;
    },
  });
}
