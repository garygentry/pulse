// apps/cli/src/commands/push/client.ts — the operator secret and the HTTP client `pulse push` uses.
// Imports only @pulse/web-data (wire types, contract), @pulse/core and CLI-local modules; never apps/web.

import { FINDING_CODES } from "@pulse/core";
import type { Finding, FindingCode } from "@pulse/core";
import { PAIR_LINK_PARAM, PAIR_TOKEN_PATTERN, parseConnectLink } from "@pulse/web-data/contract";
import type { PairingTokenIssued, PushDevicesPayload, PushTestResult } from "@pulse/web-data/wire";

// ── Operator secret ──────────────────────────────────────────────────────────

/** The operator secret's env var; the same name the server reads. */
export const OPERATOR_SECRET_ENV = "PULSE_PUSH_OPERATOR_SECRET" as const;

/**
 * The operator secret, wrapped so that it cannot be printed by accident: toString() and toJSON() return
 * "[secret]". Only {@link createPushClient} reads `bearer()`, and only to build the Authorization header.
 */
export interface PushOperatorSecret {
  /** `Bearer <secret>`; used only as a request header value. */
  bearer(): string;
  /** Always `"[secret]"`. */
  toString(): "[secret]";
  /** Always `"[secret]"`. */
  toJSON(): "[secret]";
}

/** Every character in U+0021..U+007E (printable ASCII without space). */
const HEADER_SAFE = /^[\x21-\x7e]+$/;

function errorFinding(code: FindingCode, message: string, fix: string): Finding {
  return { severity: "error", code, file: "", path: "", message, fix };
}

function wrapSecret(value: string): PushOperatorSecret {
  const bearer = `Bearer ${value}`;
  const wrapped: PushOperatorSecret = {
    bearer: () => bearer,
    toString: () => "[secret]",
    toJSON: () => "[secret]",
  };
  Object.defineProperty(wrapped, Symbol.for("nodejs.util.inspect.custom"), { value: () => "[secret]" });
  return Object.freeze(wrapped);
}

/**
 * Read the operator secret from PULSE_PUSH_OPERATOR_SECRET, and only from there. There is no flag and no config key.
 * The value is used verbatim and is not trimmed, so it must equal the server's value byte for byte.
 *
 * @returns ok with the wrapped secret, or a PUSH_OPERATOR_SECRET_MISSING finding when it is unset or empty, or when it
 *   cannot be carried in an HTTP header (any character outside U+0021..U+007E). Pure; never throws; the value never
 *   appears in a finding.
 */
export function readPushOperatorSecret(
  env: NodeJS.ProcessEnv,
): { readonly ok: true; readonly secret: PushOperatorSecret } | { readonly ok: false; readonly finding: Finding } {
  const raw = env[OPERATOR_SECRET_ENV];
  if (typeof raw !== "string" || raw === "") {
    return {
      ok: false,
      finding: errorFinding(
        FINDING_CODES.PUSH_OPERATOR_SECRET_MISSING,
        "The operator secret is not set: set PULSE_PUSH_OPERATOR_SECRET.",
        "Export PULSE_PUSH_OPERATOR_SECRET with the server's operator secret. It is never read from pulse.config.yaml or a flag.",
      ),
    };
  }
  if (!HEADER_SAFE.test(raw)) {
    return {
      ok: false,
      finding: errorFinding(
        FINDING_CODES.PUSH_OPERATOR_SECRET_MISSING,
        "PULSE_PUSH_OPERATOR_SECRET contains spaces, control characters or non-ASCII characters and cannot be sent.",
        "Use a printable ASCII secret, for example one generated with openssl rand -base64 48, on both the server and the CLI.",
      ),
    };
  }
  return { ok: true, secret: wrapSecret(raw) };
}

// ── Client interface ─────────────────────────────────────────────────────────

/** Default per-request timeout. */
export const PUSH_HTTP_TIMEOUT_MS = 10_000;
/**
 * Timeout for POST /api/push/admin/test. The server retries a transient APNs failure up to 3 times at 1, 2 and 4 s,
 * each attempt bounded by a 10 s request timeout, so one device can take about 47 s.
 */
export const PUSH_TEST_TIMEOUT_MS = 60_000;
/** Largest response body the client reads (characters). Larger bodies are an unexpected response. */
export const PUSH_MAX_RESPONSE_CHARS = 1_048_576;

/** CLI-local copy of the admin paths (the server keeps its own; a test pins that they agree). */
export const PUSH_ADMIN_PATHS = Object.freeze({
  pairingTokens: "/api/push/admin/pairing-tokens",
  devices: "/api/push/admin/devices",
  deviceById: (id: string): string => `/api/push/admin/devices/${encodeURIComponent(id)}`,
  test: "/api/push/admin/test",
} as const);

/** Options for {@link createPushClient}. */
export interface PushClientOptions {
  /** The fetch implementation (the global fetch in production, a stub in tests). */
  readonly fetch: typeof fetch;
  /** The resolved base URL, without a trailing slash. */
  readonly baseUrl: string;
  /** The operator secret. */
  readonly secret: PushOperatorSecret;
  /** Per-request timeout. Default {@link PUSH_HTTP_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Timeout for the test send. Default {@link PUSH_TEST_TIMEOUT_MS}. */
  readonly testTimeoutMs?: number;
  /** Trace sink for `--verbose`. It receives "METHOD URL → status" lines only, never headers or bodies. */
  readonly trace?: (line: string) => void;
}

/** Why a call failed. Mapped to exactly one finding by {@link findingForFailure}. */
export type PushCallFailure =
  /** fetch rejected: timeout (AbortSignal.timeout fired) or any other network/DNS/TLS/redirect error. */
  | { readonly kind: "unreachable"; readonly cause: "timeout" | "network" }
  /** A status outside the table, or an expected status with a body that fails its guard. */
  | { readonly kind: "unexpected"; readonly status: number; readonly cause: "status" | "body" }
  /** 401: the operator secret was refused. */
  | { readonly kind: "refused" }
  /** 404/405 on an admin route: push disabled, or a server that predates push. */
  | { readonly kind: "not-configured"; readonly status: 404 | 405 }
  /** 503 PUSH_UNAVAILABLE: misconfigured, or the admin surface is off. */
  | { readonly kind: "misconfigured" }
  /** A device-scoped 404 confirmed by the probe. */
  | { readonly kind: "device-not-found"; readonly deviceId: string }
  /** 409 on the pair route with details.reason no-usable-address or address-too-long. */
  | { readonly kind: "no-usable-address"; readonly reason: "no-usable-address" | "address-too-long" };

/** Result of one client call. */
export type PushCallResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: PushCallFailure };

/** The four operator calls. */
export interface PushClient {
  /** POST /api/push/admin/pairing-tokens with body {baseUrl}; 201 PairingTokenIssued. */
  issuePairingToken(): Promise<PushCallResult<PairingTokenIssued>>;
  /** GET /api/push/admin/devices; 200 PushDevicesPayload. */
  listDevices(): Promise<PushCallResult<PushDevicesPayload>>;
  /** DELETE /api/push/admin/devices/:id; 204. */
  revokeDevice(deviceId: string): Promise<PushCallResult<null>>;
  /** POST /api/push/admin/test with body {} or {deviceId}; 200 PushTestResult. */
  testSend(deviceId: string | null): Promise<PushCallResult<PushTestResult>>;
}

// ── Body guards (hand-written; no zod in the CLI) ────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A 201 pairing body whose link is a valid connect link carrying a well-formed pair token. */
export function isPairingTokenIssued(v: unknown): v is PairingTokenIssued {
  if (!isObject(v)) return false;
  if (typeof v.link !== "string" || typeof v.expiresAt !== "string") return false;
  if (Number.isNaN(Date.parse(v.expiresAt))) return false;
  const parsed = parseConnectLink(v.link);
  if (!parsed.ok) return false;
  const token = parsed.params[PAIR_LINK_PARAM];
  return typeof token === "string" && PAIR_TOKEN_PATTERN.test(token);
}

const DELIVERY_OUTCOMES: ReadonlySet<unknown> = new Set(["delivered", "failed", "dropped"]);
const TEST_OUTCOMES: ReadonlySet<unknown> = new Set(["delivered", "rejected", "token-removed", "unreachable"]);

function isDeviceSummary(v: unknown): boolean {
  if (!isObject(v)) return false;
  for (const key of ["id", "displayName", "pairedAt", "seenAt"] as const) {
    if (typeof v[key] !== "string") return false;
  }
  if (v.environment !== null && v.environment !== "sandbox" && v.environment !== "production") return false;
  const prefs = v.preferences;
  if (!isObject(prefs)) return false;
  for (const key of ["critical", "warning", "info"] as const) {
    if (typeof prefs[key] !== "boolean") return false;
  }
  if (v.tokenSuffix !== null && typeof v.tokenSuffix !== "string") return false;
  const ld = v.lastDelivery;
  if (ld !== null) {
    if (!isObject(ld)) return false;
    if (!DELIVERY_OUTCOMES.has(ld.outcome)) return false;
    if (typeof ld.at !== "string") return false;
    if (ld.reason !== null && typeof ld.reason !== "string") return false;
  }
  return true;
}

/** A 200 devices body: `devices` is an array of well-formed summaries. */
export function isPushDevicesPayload(v: unknown): v is PushDevicesPayload {
  return isObject(v) && Array.isArray(v.devices) && v.devices.every(isDeviceSummary);
}

/** A 200 test body: `results` is an array of well-formed per-device outcomes. */
export function isPushTestResult(v: unknown): v is PushTestResult {
  if (!isObject(v) || !Array.isArray(v.results)) return false;
  return v.results.every(
    (r: unknown) =>
      isObject(r) &&
      typeof r.deviceId === "string" &&
      typeof r.displayName === "string" &&
      TEST_OUTCOMES.has(r.outcome) &&
      (r.reason === undefined || typeof r.reason === "string"),
  );
}

/** The server's error body: string `code` and `message`, `details` absent or an object. */
export function isErrorEnvelope(
  v: unknown,
): v is { readonly code: string; readonly message: string; readonly details?: Record<string, unknown> } {
  return (
    isObject(v) &&
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    (v.details === undefined || isObject(v.details))
  );
}

// ── Response classification ──────────────────────────────────────────────────

/** Which client call produced a response; "test-device" is testSend with a deviceId. */
export type PushCallKind = "pair" | "devices" | "revoke" | "test" | "test-device";

/** What a response means for a call, before any probe. "probe" = device-scoped 404. "success" = before the body guard. */
export type PushStatusClass = "success" | "probe" | PushCallFailure;

const SUCCESS_STATUS: Readonly<Record<PushCallKind, number>> = {
  pair: 201,
  devices: 200,
  revoke: 204,
  test: 200,
  "test-device": 200,
};

/**
 * Classify a received response (pure). `json` is the parsed body, or undefined.
 * Order: expected success; 401; device-scoped 404 API_NOT_FOUND → probe; other 404 or 405; 503 PUSH_UNAVAILABLE;
 * 409 on pair with a known address reason; anything else is unexpected.
 */
export function classifyPushResponse(call: PushCallKind, status: number, json: unknown): PushStatusClass {
  if (status === SUCCESS_STATUS[call]) return "success";
  if (status === 401) return { kind: "refused" };
  if (status === 404) {
    const deviceScoped = call === "revoke" || call === "test-device";
    if (deviceScoped && isErrorEnvelope(json) && json.code === "API_NOT_FOUND") return "probe";
    return { kind: "not-configured", status: 404 };
  }
  if (status === 405) return { kind: "not-configured", status: 405 };
  if (status === 503 && isErrorEnvelope(json) && json.code === "PUSH_UNAVAILABLE") return { kind: "misconfigured" };
  if (status === 409 && call === "pair" && isErrorEnvelope(json)) {
    const reason = json.details?.reason;
    if (reason === "no-usable-address" || reason === "address-too-long") return { kind: "no-usable-address", reason };
  }
  return { kind: "unexpected", status, cause: "status" };
}

// ── The client ───────────────────────────────────────────────────────────────

interface Exchange {
  readonly status: number;
  readonly json: unknown;
}

type ExchangeResult = { readonly ok: true; readonly exchange: Exchange } | { readonly ok: false; readonly failure: PushCallFailure };

function rejectionCause(err: unknown): "timeout" | "network" {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

/**
 * Create the client. It never throws: every fetch rejection, abort and parse error becomes a PushCallFailure.
 * It holds no state between calls.
 */
export function createPushClient(options: PushClientOptions): PushClient {
  const timeoutMs = options.timeoutMs ?? PUSH_HTTP_TIMEOUT_MS;
  const testTimeoutMs = options.testTimeoutMs ?? PUSH_TEST_TIMEOUT_MS;
  const trace = (line: string): void => {
    try {
      options.trace?.(line);
    } catch {
      // A failing trace sink never affects the call.
    }
  };

  async function exchange(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    timeout: number,
  ): Promise<ExchangeResult> {
    const url = `${options.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: options.secret.bearer(),
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers, redirect: "error", signal: AbortSignal.timeout(timeout) };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      const res = await options.fetch(url, init);
      const status = res.status;
      let json: unknown = undefined;
      if (status !== 204) {
        const text = await res.text();
        if (text.length > PUSH_MAX_RESPONSE_CHARS) {
          trace(`${method} ${url} → ${status}`);
          return { ok: false, failure: { kind: "unexpected", status, cause: "body" } };
        }
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
      }
      trace(`${method} ${url} → ${status}`);
      return { ok: true, exchange: { status, json } };
    } catch (err) {
      const cause = rejectionCause(err);
      trace(`${method} ${url} → ${cause === "timeout" ? "timeout" : "network error"}`);
      return { ok: false, failure: { kind: "unreachable", cause } };
    }
  }

  /** Run one call through the classification table; `guard` checks a success body (null = no body). */
  async function call<T>(
    kind: PushCallKind,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    timeout: number,
    guard: ((v: unknown) => v is T) | null,
    probeDeviceId: string | null,
  ): Promise<PushCallResult<T>> {
    const result = await exchange(method, path, body, timeout);
    if (!result.ok) return { ok: false, failure: result.failure };
    const { status, json } = result.exchange;
    const cls = classifyPushResponse(kind, status, json);
    if (cls === "success") {
      if (guard === null) return { ok: true, value: null as T };
      return guard(json) ? { ok: true, value: json } : { ok: false, failure: { kind: "unexpected", status, cause: "body" } };
    }
    if (cls === "probe") {
      const probe = await call("devices", "GET", PUSH_ADMIN_PATHS.devices, undefined, timeout, isPushDevicesPayload, null);
      if (probe.ok) return { ok: false, failure: { kind: "device-not-found", deviceId: probeDeviceId ?? "" } };
      return { ok: false, failure: probe.failure };
    }
    return { ok: false, failure: cls };
  }

  return Object.freeze({
    issuePairingToken: () =>
      call(
        "pair",
        "POST",
        PUSH_ADMIN_PATHS.pairingTokens,
        { baseUrl: options.baseUrl },
        timeoutMs,
        isPairingTokenIssued,
        null,
      ),
    listDevices: () => call("devices", "GET", PUSH_ADMIN_PATHS.devices, undefined, timeoutMs, isPushDevicesPayload, null),
    revokeDevice: (deviceId: string) =>
      call<null>("revoke", "DELETE", PUSH_ADMIN_PATHS.deviceById(deviceId), undefined, timeoutMs, null, deviceId),
    testSend: (deviceId: string | null) =>
      call(
        deviceId === null ? "test" : "test-device",
        "POST",
        PUSH_ADMIN_PATHS.test,
        deviceId === null ? {} : { deviceId },
        testTimeoutMs,
        isPushTestResult,
        deviceId,
      ),
  });
}

// ── Failure → finding ────────────────────────────────────────────────────────

/** Context the messages need. Never contains the secret. */
export interface FailureContext {
  /** The base URL called (normalised; never has credentials). */
  readonly baseUrl: string;
  /** True under --insecure-local (changes the PUSH_PAIR_NO_ADDRESS fix). */
  readonly insecure: boolean;
  /** The timeout that applied, for the timeout message. */
  readonly timeoutMs: number;
}

const REACH_FIX = "Check the address and that the server is running and reachable from here.";
const UNEXPECTED_FIX =
  "Check that the address points at a Pulse server with push support, and that no proxy rewrites /api/push/.";

/** Map a failure to exactly one error finding (file "", path ""). Pure. */
export function findingForFailure(failure: PushCallFailure, context: FailureContext): Finding {
  const base = context.baseUrl;
  switch (failure.kind) {
    case "unreachable":
      return failure.cause === "timeout"
        ? errorFinding(
            FINDING_CODES.PUSH_SERVER_UNREACHABLE,
            `Could not reach the Pulse server at ${base}: no answer within ${context.timeoutMs / 1000} s.`,
            REACH_FIX,
          )
        : errorFinding(
            FINDING_CODES.PUSH_SERVER_UNREACHABLE,
            `Could not reach the Pulse server at ${base}: network error (connection refused, DNS, TLS, or a redirect).`,
            `${REACH_FIX} Redirects are not followed; use the server's final https address.`,
          );
    case "unexpected":
      return failure.cause === "status"
        ? errorFinding(
            FINDING_CODES.PUSH_SERVER_UNREACHABLE,
            `The server at ${base} gave an unexpected answer (HTTP ${failure.status}).`,
            UNEXPECTED_FIX,
          )
        : errorFinding(
            FINDING_CODES.PUSH_SERVER_UNREACHABLE,
            `The server at ${base} sent a response that is not a valid push response (HTTP ${failure.status}).`,
            UNEXPECTED_FIX,
          );
    case "refused":
      return errorFinding(
        FINDING_CODES.PUSH_OPERATOR_REFUSED,
        "The server refused the operator secret.",
        "Check that PULSE_PUSH_OPERATOR_SECRET matches the server's value exactly.",
      );
    case "not-configured":
      return errorFinding(
        FINDING_CODES.PUSH_NOT_CONFIGURED,
        `Push is not configured on the server at ${base}, or the server predates push.`,
        "Set the PULSE_PUSH_APNS_* variables on the server and restart it (see the operator guide).",
      );
    case "misconfigured":
      return errorFinding(
        FINDING_CODES.PUSH_MISCONFIGURED,
        "Push is misconfigured on the server, or its operator commands are off.",
        "Check the server's config_warning log lines and pulse_web_push_state. Operator commands need PULSE_PUSH_OPERATOR_SECRET set on the server.",
      );
    case "no-usable-address":
      return failure.reason === "no-usable-address"
        ? errorFinding(
            FINDING_CODES.PUSH_PAIR_NO_ADDRESS,
            "The server has no usable https address to put in the pairing link.",
            "Set PULSE_WEB_EXTERNAL_URL on the server to its https address, or pass that address with --server." +
              (context.insecure ? " A --insecure-local address can never go into a link." : ""),
          )
        : errorFinding(
            FINDING_CODES.PUSH_PAIR_NO_ADDRESS,
            "The server's address makes the pairing link longer than 256 characters.",
            "Use a shorter https address in PULSE_WEB_EXTERNAL_URL or --server.",
          );
    case "device-not-found":
      return errorFinding(
        FINDING_CODES.PUSH_DEVICE_NOT_FOUND,
        `No paired device has the id ${failure.deviceId}.`,
        "Run pulse push devices to list device ids.",
      );
  }
}
