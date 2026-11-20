// Public-safe placeholder values shared by the push fixture modules and the connect-link pairing row, plus the
// structural guards the push builders and contract tests apply to server bodies.

import { DEVICE_CREDENTIAL_PATTERN, DEVICE_ID_PATTERN } from "@pulse/web-data/contract";
import {
  ERROR_MESSAGES,
  type ApiErrorCode,
  type DeviceRegistrationResponse,
  type PairingRedeemResponse,
} from "@pulse/web-data/wire";

import { ContractToolError } from "../errors.js";

/** The first pairing token a fresh, zero-seeded fixture runtime draws: 16 zero bytes as base64url. */
export const PAIR_TOKEN_PLACEHOLDER = "AAAAAAAAAAAAAAAAAAAAAA";
/** An APNs device token: 64 lower-case hex characters. */
export const APNS_TOKEN_PLACEHOLDER = "0123456789abcdef".repeat(4);
/** A device display name. */
export const DISPLAY_NAME_PLACEHOLDER = "Example iPhone";
/** Alertmanager fingerprint number `n`: 16 lower-case hex characters. */
export const FINGERPRINT = (n: number): string => n.toString(16).padStart(16, "0");

// ---------------------------------------------------------------------------------------------------------------
// Structural guards shared by the push builders and the contract tests
// ---------------------------------------------------------------------------------------------------------------

/** Own keys of a plain JSON object, or null when `value` is not one. */
function ownKeys(value: unknown): string[] | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return Object.keys(value).sort();
}

function sameKeys(value: unknown, expected: readonly string[]): boolean {
  const keys = ownKeys(value);
  return keys !== null && keys.join(",") === [...expected].sort().join(",");
}

function invalid(subject: string, reason: string): never {
  throw new ContractToolError("SCENARIO_INVALID", subject, reason);
}

/** The redeem success body: exactly `deviceId` and `credential`, each matching its pattern. */
export function assertRedeemResponse(value: unknown, subject: string): asserts value is PairingRedeemResponse {
  if (!sameKeys(value, ["credential", "deviceId"])) invalid(subject, "the redeem response members are not {deviceId, credential}");
  const body = value as Record<string, unknown>;
  if (typeof body.deviceId !== "string" || !DEVICE_ID_PATTERN.test(body.deviceId)) {
    invalid(subject, "the redeem response deviceId is malformed");
  }
  if (typeof body.credential !== "string" || !DEVICE_CREDENTIAL_PATTERN.test(body.credential)) {
    invalid(subject, "the redeem response credential is malformed");
  }
}

/** The instant FIXTURE_CLOCK reads, as the registration response reports it. */
export const FIXTURE_SEEN_AT = "2026-01-01T00:00:00.000Z";

/** The registration success body: exactly the four members, with `seenAt` at the fixture clock. */
export function assertRegistrationResponse(value: unknown, subject: string): asserts value is DeviceRegistrationResponse {
  if (!sameKeys(value, ["deviceId", "environment", "preferences", "seenAt"])) {
    invalid(subject, "the registration response members are not {deviceId, environment, preferences, seenAt}");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.deviceId !== "string" || !DEVICE_ID_PATTERN.test(body.deviceId)) {
    invalid(subject, "the registration response deviceId is malformed");
  }
  if (body.environment !== "sandbox" && body.environment !== "production") {
    invalid(subject, "the registration response environment is not a PushEnvironment");
  }
  const prefs = body.preferences as Record<string, unknown> | null;
  if (!sameKeys(prefs, ["critical", "info", "warning"]) || Object.values(prefs!).some((v) => typeof v !== "boolean")) {
    invalid(subject, "the registration response preferences are malformed");
  }
  if (body.seenAt !== FIXTURE_SEEN_AT) invalid(subject, `the registration response seenAt is not ${FIXTURE_SEEN_AT}`);
}

/** Codes whose bodies never carry `details`, so every refusal looks the same. */
const UNIFORM_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>(["PAIRING_REFUSED", "UNAUTHORIZED"]);

/**
 * A push error body: `{code, message}` (optionally `details`) with `message === ERROR_MESSAGES[code]`, `code` equal
 * to `expected`, and no `details` for the uniform refusals.
 */
export function assertPushErrorBody(value: unknown, expected: ApiErrorCode, subject: string): void {
  const keys = ownKeys(value);
  if (keys === null || !keys.includes("code") || !keys.includes("message") || keys.some((k) => !["code", "details", "message"].includes(k))) {
    invalid(subject, "the error body members are not {code, message[, details]}");
  }
  const body = value as Record<string, unknown>;
  if (body.code !== expected) invalid(subject, `the error code is ${String(body.code)}, not ${expected}`);
  if (body.message !== ERROR_MESSAGES[expected]) invalid(subject, "the error message is not the catalogue message");
  if (UNIFORM_CODES.has(expected) && Object.hasOwn(body, "details")) invalid(subject, `a ${expected} body must not carry details`);
}
