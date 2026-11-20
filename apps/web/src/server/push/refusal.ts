// Push error model: the refusal vocabulary, its status/code policy, the error response builder, and the internal
// error classes.

import { ERROR_MESSAGES, type ApiErrorCode, type ErrorEnvelope } from "@pulse/web-data/wire";

import type { RefusalReason } from "../mutations/refusal.js";
import type { PushConfigReason } from "./config.js";
import { PUSH_CACHE_CONTROL } from "./constants.js";

/** Every way a push route can refuse. Keyed by refusal kind, not by guard reason. */
export type PushRefusal =
  | "cross-origin"
  | "untrusted-identity"
  | "invalid-body"
  | "body-too-large"
  | "unauthorized"
  | "pairing-refused"
  | "device-cap-reached"
  | "rate-limited"
  | "unavailable"
  | "not-found"
  | "no-usable-address"
  | "address-too-long"
  | "unsupported-version"
  | "internal";

/** Status and error code of one refusal kind. */
export interface PushRefusalPolicy {
  /** HTTP status of the refusal. */
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 503;
  /** Error envelope code. */
  readonly code: ApiErrorCode;
  /** Whether details.reason is set to the refusal name (only where the caller needs to branch). */
  readonly exposeReason: boolean;
}

/** The fixed policy for every push refusal. Frozen at every level. */
export const PUSH_REFUSAL_POLICY: Readonly<Record<PushRefusal, PushRefusalPolicy>> = Object.freeze({
  "cross-origin": Object.freeze({ status: 403, code: "INVALID_REQUEST", exposeReason: false }),
  "untrusted-identity": Object.freeze({ status: 403, code: "INVALID_REQUEST", exposeReason: false }),
  "invalid-body": Object.freeze({ status: 400, code: "INVALID_REQUEST", exposeReason: false }),
  "body-too-large": Object.freeze({ status: 413, code: "PAYLOAD_TOO_LARGE", exposeReason: false }),
  unauthorized: Object.freeze({ status: 401, code: "UNAUTHORIZED", exposeReason: false }),
  "pairing-refused": Object.freeze({ status: 403, code: "PAIRING_REFUSED", exposeReason: false }),
  "device-cap-reached": Object.freeze({ status: 409, code: "DEVICE_CAP_REACHED", exposeReason: false }),
  "rate-limited": Object.freeze({ status: 429, code: "RATE_LIMITED", exposeReason: false }),
  unavailable: Object.freeze({ status: 503, code: "PUSH_UNAVAILABLE", exposeReason: false }),
  "not-found": Object.freeze({ status: 404, code: "API_NOT_FOUND", exposeReason: false }),
  "no-usable-address": Object.freeze({ status: 409, code: "INVALID_REQUEST", exposeReason: true }),
  "address-too-long": Object.freeze({ status: 409, code: "INVALID_REQUEST", exposeReason: true }),
  "unsupported-version": Object.freeze({ status: 400, code: "INVALID_REQUEST", exposeReason: false }),
  internal: Object.freeze({ status: 500, code: "INTERNAL_ERROR", exposeReason: false }),
} satisfies Record<PushRefusal, PushRefusalPolicy>);

/**
 * Map a mutation-guard reason to a push refusal. Push routes run only the same-origin, identity, media-type and
 * bounded-body guards; any other reason indicates a bug and maps to "internal".
 */
export function fromGuardReason(reason: RefusalReason): PushRefusal {
  switch (reason) {
    case "cross-origin":
      return "cross-origin";
    case "untrusted-identity":
      return "untrusted-identity";
    case "invalid-body":
      return "invalid-body";
    case "body-too-large":
      return "body-too-large";
    default:
      return "internal";
  }
}

/** Optional extras of {@link pushErrorResponse}. */
export interface PushErrorExtra {
  /** Sanitised invalid-field paths; used only for invalid-body. */
  readonly fields?: string | undefined;
  /** Seconds for the Retry-After header. */
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Build the error Response for a refusal. The body is `{code, message, details?}` with the catalog message;
 * `details.reason` appears only when the policy exposes the reason, and `details.fields` only for invalid-body when
 * fields are given. "unauthorized" and "pairing-refused" never carry details, so their bodies are byte-identical
 * whatever the cause. Every response carries `Cache-Control: private, no-store`.
 */
export function pushErrorResponse(refusal: PushRefusal, extra?: PushErrorExtra): Response {
  const policy = PUSH_REFUSAL_POLICY[refusal];
  const details: Record<string, string> = {};
  if (policy.exposeReason) details["reason"] = refusal;
  if (refusal === "invalid-body" && extra?.fields !== undefined) details["fields"] = extra.fields;
  const body: ErrorEnvelope = {
    code: policy.code,
    message: ERROR_MESSAGES[policy.code],
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": PUSH_CACHE_CONTROL,
  });
  if (extra?.retryAfterSeconds !== undefined) headers.set("Retry-After", String(extra.retryAfterSeconds));
  return new Response(JSON.stringify(body), { status: policy.status, headers });
}

/**
 * Programmer error (invariant violation). Thrown where an invariant fails. Push code never catches it except at the
 * designated catch sites (dispatcher → 500, background loops → log). Carries a stable code, never a secret, and is
 * never serialised into a response.
 */
export class PushInvariantError extends Error {
  /** Stable machine-readable code. */
  readonly code = "PUSH_INVARIANT" as const;

  constructor(message: string) {
    super(message);
    this.name = "PushInvariantError";
  }
}

/**
 * Per-variable failure carrier used inside push configuration parsing. It is always caught there and never escapes
 * the parser. Its message names the variable and the reason kind only, never the value.
 */
export class PushConfigParseError extends Error {
  /** Stable machine-readable code. */
  readonly code = "PUSH_CONFIG" as const;
  /** The rejected variable and why. */
  readonly reason: PushConfigReason;

  constructor(reason: PushConfigReason) {
    super(`${reason.envVar}: ${reason.reason}`);
    this.name = "PushConfigParseError";
    this.reason = reason;
  }
}
