// apps/web/src/client/views/connect/push/push-api.ts — the browser side of the web-only push routes: the status
// GET (through apiFetch), a small writer for the POST/DELETE calls, strict body parsers and the error copy.
// Nothing here logs or persists a response body: an issued pairing link is a secret.
import { CONNECT_LINK_MAX_LENGTH } from "@pulse/web-data/contract";
import {
  ERROR_MESSAGES,
  type DeliveryOutcome,
  type DeviceSummary,
  type LastDelivery,
  type PairingTokenIssued,
  type PushEnvironment,
  type PushPreferences,
  type PushStatusPayload,
} from "@pulse/web-data/wire";

import { apiFetch } from "../../../api/client.js";
import { isLoginPage, isRedirect } from "../../../api/proxy-answer.js";

/** Client copies of the web-only push paths (the server's path table must not be imported into the client). */
export const PUSH_CLIENT_PATHS = Object.freeze({
  status: "/api/push/status",
  pairingTokens: "/api/push/pairing-tokens",
  pairingTokenCurrent: "/api/push/pairing-tokens/current",
  deviceById: (id: string): string => `/api/push/devices/${encodeURIComponent(id)}`,
} as const);

/**
 * Why a push call failed, as the UI branches on it. Bounded; never carries a server message.
 * - "unavailable":        404/405 (push disabled), 503 PUSH_UNAVAILABLE
 * - "no-usable-address":  409 INVALID_REQUEST details.reason "no-usable-address"
 * - "address-too-long":   409 INVALID_REQUEST details.reason "address-too-long"
 * - "forbidden":          403 with a Pulse error envelope (cross-origin or no identity)
 * - "not-found":          404 on a device DELETE (already gone)
 * - "session-expired":    redirect, 2xx HTML, or 401/403 without a Pulse envelope
 * - "network":            fetch rejected or the body stream failed
 * - "malformed-response": 2xx body that fails its parser, or any other status
 */
export type PushClientError =
  | "unavailable"
  | "no-usable-address"
  | "address-too-long"
  | "forbidden"
  | "not-found"
  | "session-expired"
  | "network"
  | "malformed-response";

/** Outcome of one push call. Never rejects. */
export type PushFetchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: PushClientError; readonly httpStatus: number };

const LINK_PREFIX = "pulse://connect?";
const DEVICE_PATH_PREFIX = "/api/push/devices/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` has exactly the own keys in `keys`. */
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isInstant(value: unknown): value is string {
  return typeof value === "string" && value !== "" && Number.isFinite(Date.parse(value));
}

function fail<T>(error: PushClientError, httpStatus: number): PushFetchResult<T> {
  return { ok: false, error, httpStatus };
}

/** The validated Pulse error envelope's code and details, or null for anything else (a proxy page, junk). */
function readEnvelope(body: unknown): { readonly code: string; readonly details: Record<string, unknown> | null } | null {
  if (!isRecord(body) || typeof body["code"] !== "string" || typeof body["message"] !== "string") return null;
  if (!Object.hasOwn(ERROR_MESSAGES, body["code"])) return null;
  const details = body["details"];
  return { code: body["code"], details: isRecord(details) ? details : null };
}

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Classify a non-2xx answer to a push write. */
function classifyRefusal(
  status: number,
  method: "POST" | "DELETE",
  path: string,
  envelope: ReturnType<typeof readEnvelope>,
): PushClientError {
  if (envelope === null && (status === 401 || status === 403)) return "session-expired";
  if (status === 403) return "forbidden";
  if (status === 404) return method === "DELETE" && path.startsWith(DEVICE_PATH_PREFIX) ? "not-found" : "unavailable";
  if (status === 405 || status === 503) return "unavailable";
  if (status === 409 && envelope !== null) {
    const reason = envelope.details?.["reason"];
    if (reason === "no-usable-address" || reason === "address-too-long") return reason;
  }
  return "malformed-response";
}

/**
 * One write to a web-only push route: method POST or DELETE, credentials same-origin, cache no-store,
 * redirect manual, accept JSON; a body is sent as `content-type: application/json`. 201/200 bodies go to
 * `parse`; 204 resolves `{ok:true, value: null}` (parse not called). Never throws, never logs the body
 * (the 201 body of an issue is a secret).
 */
export async function pushFetch<T>(
  path: string,
  init: { readonly method: "POST" | "DELETE"; readonly body?: unknown; readonly signal?: AbortSignal },
  parse: (value: unknown) => T | null,
  fetchImpl: typeof fetch = fetch,
): Promise<PushFetchResult<T | null>> {
  let res: Response;
  try {
    const hasBody = init.body !== undefined;
    res = await fetchImpl(path, {
      method: init.method,
      credentials: "same-origin",
      cache: "no-store",
      // Never follow: a followed login redirect would turn the write into a GET of the login page.
      redirect: "manual",
      headers: hasBody ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    });
  } catch {
    return fail("network", 0);
  }
  try {
    if (isRedirect(res) || (res.ok && isLoginPage(res))) return fail("session-expired", res.status);
    if (res.status === 204) return { ok: true, value: null };

    let text: string;
    try {
      text = await res.text();
    } catch {
      return fail("network", 0);
    }
    const json = parseJson(text);

    if (res.ok) {
      if (!json.ok) return fail("malformed-response", res.status);
      const value = parse(json.value);
      return value === null ? fail("malformed-response", res.status) : { ok: true, value };
    }
    const envelope = json.ok ? readEnvelope(json.value) : null;
    return fail(classifyRefusal(res.status, init.method, path, envelope), res.status);
  } catch {
    return fail("malformed-response", res.status);
  }
}

const ENVIRONMENTS: readonly PushEnvironment[] = ["sandbox", "production"];
const OUTCOMES: readonly DeliveryOutcome[] = ["delivered", "failed", "dropped"];
const DEVICE_KEYS = [
  "id", "displayName", "pairedAt", "seenAt", "environment", "preferences", "tokenSuffix", "lastDelivery",
] as const;

function parsePreferences(value: unknown): PushPreferences | null {
  if (!isRecord(value) || !hasExactKeys(value, ["critical", "warning", "info"])) return null;
  const { critical, warning, info } = value;
  if (typeof critical !== "boolean" || typeof warning !== "boolean" || typeof info !== "boolean") return null;
  return { critical, warning, info };
}

function parseLastDelivery(value: unknown): LastDelivery | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["outcome", "at", "reason"])) return undefined;
  const outcome = OUTCOMES.find((known) => known === value["outcome"]);
  const { at, reason } = value;
  if (outcome === undefined || !isInstant(at) || (reason !== null && typeof reason !== "string")) return undefined;
  return { outcome, at, reason };
}

function parseDevice(value: unknown): DeviceSummary | null {
  if (!isRecord(value) || !hasExactKeys(value, DEVICE_KEYS)) return null;
  const { id, displayName, pairedAt, seenAt, environment, tokenSuffix } = value;
  if (typeof id !== "string" || id === "" || typeof displayName !== "string") return null;
  if (!isInstant(pairedAt) || !isInstant(seenAt)) return null;
  const env = environment === null ? null : ENVIRONMENTS.find((known) => known === environment);
  if (env === undefined) return null;
  if (tokenSuffix !== null && typeof tokenSuffix !== "string") return null;
  const preferences = parsePreferences(value["preferences"]);
  if (preferences === null) return null;
  const lastDelivery = parseLastDelivery(value["lastDelivery"]);
  if (lastDelivery === undefined) return null;
  return { id, displayName, pairedAt, seenAt, environment: env, preferences, tokenSuffix, lastDelivery };
}

/** Strict parser for PushStatusPayload: exact keys state/devices/outstanding/maxDevices; state in
 *  "configured" | "misconfigured"; each DeviceSummary field type-checked; null on any mismatch. Pure. */
export function parsePushStatus(value: unknown): PushStatusPayload | null {
  if (!isRecord(value) || !hasExactKeys(value, ["state", "devices", "outstanding", "maxDevices"])) return null;
  const { state, devices, outstanding, maxDevices } = value;
  if (state !== "configured" && state !== "misconfigured") return null;
  if (typeof maxDevices !== "number" || !Number.isSafeInteger(maxDevices) || maxDevices < 0) return null;
  if (!Array.isArray(devices)) return null;
  const parsed: DeviceSummary[] = [];
  for (const device of devices) {
    const one = parseDevice(device);
    if (one === null) return null;
    parsed.push(one);
  }
  let out: PushStatusPayload["outstanding"] = null;
  if (outstanding !== null) {
    if (!isRecord(outstanding) || !hasExactKeys(outstanding, ["expiresAt"])) return null;
    const { expiresAt } = outstanding;
    if (!isInstant(expiresAt)) return null;
    out = { expiresAt };
  }
  return { state, devices: parsed, outstanding: out, maxDevices };
}

/** Strict parser for PairingTokenIssued: exactly {link, expiresAt}, link starts "pulse://connect?" and is at most
 *  CONNECT_LINK_MAX_LENGTH characters, expiresAt parses as a date. Pure. */
export function parsePairingTokenIssued(value: unknown): PairingTokenIssued | null {
  if (!isRecord(value) || !hasExactKeys(value, ["link", "expiresAt"])) return null;
  const { link, expiresAt } = value;
  if (typeof link !== "string" || !link.startsWith(LINK_PREFIX) || link.length > CONNECT_LINK_MAX_LENGTH) return null;
  if (!isInstant(expiresAt)) return null;
  return { link, expiresAt };
}

/** GET status via apiFetch. A status "error" result maps: httpStatus 404 or 405 → "unavailable" (also a
 *  PUSH_UNAVAILABLE envelope); a 403 Pulse envelope → "forbidden"; SESSION_EXPIRED → "session-expired";
 *  SERVER_UNREACHABLE/SERVER_TIMEOUT/REQUEST_CANCELLED → "network"; anything else → "malformed-response".
 *  A 200 that fails parsePushStatus → "malformed-response". Never rejects. */
export async function getPushStatus(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PushFetchResult<PushStatusPayload>> {
  try {
    const result = await apiFetch<unknown>(PUSH_CLIENT_PATHS.status, { signal }, fetchImpl);
    if (result.status === "ok") {
      const payload = parsePushStatus(result.value);
      return payload === null ? fail("malformed-response", 200) : { ok: true, value: payload };
    }
    if (result.status === "not-modified") return fail("malformed-response", 304);
    const { error, httpStatus } = result;
    if (httpStatus === 404 || httpStatus === 405 || error.code === "PUSH_UNAVAILABLE") return fail("unavailable", httpStatus);
    switch (error.code) {
      case "SESSION_EXPIRED":
        return fail("session-expired", httpStatus);
      case "SERVER_UNREACHABLE":
      case "SERVER_TIMEOUT":
      case "REQUEST_CANCELLED":
        return fail("network", httpStatus);
      default:
        return fail(httpStatus === 403 ? "forbidden" : "malformed-response", httpStatus);
    }
  } catch {
    return fail("network", 0);
  }
}

/** POST /api/push/pairing-tokens. The route reads no body, so none is sent. */
export async function issuePairingToken(fetchImpl: typeof fetch = fetch): Promise<PushFetchResult<PairingTokenIssued>> {
  const result = await pushFetch(PUSH_CLIENT_PATHS.pairingTokens, { method: "POST" }, parsePairingTokenIssued, fetchImpl);
  if (!result.ok) return result;
  return result.value === null ? fail("malformed-response", 204) : { ok: true, value: result.value };
}

const NO_BODY = (): null => null;

/** DELETE /api/push/pairing-tokens/current (204 with or without an outstanding token). */
export function cancelPairingToken(fetchImpl: typeof fetch = fetch): Promise<PushFetchResult<null>> {
  return pushFetch<null>(PUSH_CLIENT_PATHS.pairingTokenCurrent, { method: "DELETE" }, NO_BODY, fetchImpl);
}

/** DELETE /api/push/devices/:id (204; 404 "not-found" when the device is already gone). */
export function revokeDevice(id: string, fetchImpl: typeof fetch = fetch): Promise<PushFetchResult<null>> {
  return pushFetch<null>(PUSH_CLIENT_PATHS.deviceById(id), { method: "DELETE" }, NO_BODY, fetchImpl);
}

const ERROR_TEXT: Readonly<Record<PushClientError, string>> = {
  unavailable: "Push notifications are not available on this server right now.",
  "no-usable-address":
    "No pairing code: this server has no address a phone can reach. Set PULSE_WEB_EXTERNAL_URL to the server's https address.",
  "address-too-long": "No pairing code: the server address is too long for a scannable code.",
  forbidden: "This action was refused. Reload the page and try again.",
  "not-found": "That device was already removed.",
  "session-expired": "Your sign-in session has expired. Reload the page to sign in again.",
  network: "Could not reach the server. Check the connection and try again.",
  "malformed-response": "The server sent an unexpected response.",
};

/** Operator-facing copy per error (rendered as text). */
export function pushErrorText(error: PushClientError): string {
  return ERROR_TEXT[error];
}
