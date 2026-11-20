// The typed source for the operations table in contract/CONTRACT.md. Every row is derived from the route
// modules: paths, parameter sets, statuses and request limits are imported where the server exports them.

import { CLIENT_HEADER, CONTRACT_HEADER, CONTRACT_LIMITS } from "@pulse/web-data/contract";
import type { HistoryFailure } from "@pulse/web-data/history";
import { QUERY_CATALOG, RANGE_IDS, queryIdsForTargetKind } from "@pulse/web-data/queries";
import { SSE_HEARTBEAT_MS, SSE_MAX_STREAMS, SSE_RETRY_MS } from "@pulse/web-data/wire";
import type { ApiErrorCode } from "@pulse/web-data/wire";

import { PUSH_PATHS } from "../../src/server/push/constants.js";
import { MAX_PARAM_BYTES, MAX_QUERY_BYTES } from "../../src/server/routes/compile.js";
import { CHECKS_DEFAULT_RANGE, HISTORY_STATUS } from "../../src/server/routes/history.js";
import type { SHAPE_ROOTS } from "./shape-types.js";
import type { FixtureGroup } from "./types.js";

export { MAX_PARAM_BYTES, MAX_QUERY_BYTES };

/** Allowed values of one parameter. */
export type ParamValues =
  /** A closed set; rendered as a backticked, comma-separated list in source order. */
  | { readonly kind: "enum"; readonly values: readonly string[] }
  /** An open value described in prose. */
  | { readonly kind: "text"; readonly description: string };

/** One request parameter of a contract operation. */
export interface ContractParam {
  /** Name, without the leading ":" for path parameters. */
  readonly name: string;
  /** Where the parameter is carried. */
  readonly in: "path" | "query" | "header";
  /** Whether the request must carry it. */
  readonly required: boolean;
  /** Valid values. */
  readonly values: ParamValues;
  /** Value used when the parameter is omitted (prose). */
  readonly default?: string;
  /** Extra constraint. */
  readonly note?: string;
}

/** One error response an operation can return. */
export interface ContractOperationError {
  /** Stable code. */
  readonly code: ApiErrorCode;
  /** HTTP status. */
  readonly status: number;
  /** Which wire body carries it. */
  readonly body: "ErrorEnvelope" | "BundleErrorBody";
  /** When it is returned (one short clause). */
  readonly when: string;
  /** Response headers a client may act on. */
  readonly headers?: readonly string[];
}

/** Caching behaviour exactly as served. */
export type ContractCaching =
  | { readonly kind: "conditional"; readonly cacheControl: "private, no-cache"; readonly vary: "Accept-Encoding" }
  | { readonly kind: "always-full"; readonly cacheControl: "private, no-cache" }
  | { readonly kind: "no-store"; readonly cacheControl: "private, no-store" }
  | { readonly kind: "stream"; readonly cacheControl: "no-cache" };

/** HTTP method of a contract operation. */
export type ContractMethod = "GET" | "POST" | "PUT" | "DELETE";

/**
 * What authorises a contract operation. Reads are always `none`.
 * - `pairing-token`: the one-time token in the request body (`PairingRedeemRequest.token`).
 * - `device-credential`: exactly one `Authorization: Bearer <credential>` header.
 */
export type ContractAuth = "none" | "pairing-token" | "device-credential";

/** One contract operation. */
export interface ContractOperation {
  /** Operation label, equal to a fixture index entry's `operation`: `<METHOD> <path>` or `SSE /api/events`. */
  readonly label: string;
  /** Short human name for the table's first column. */
  readonly name: string;
  /** HTTP method. Every operation with `auth: "none"` is a GET. */
  readonly method: ContractMethod;
  /** Route pattern exactly as in the route module (`:name` parameters). */
  readonly path: string;
  /** What authorises the call. */
  readonly auth: ContractAuth;
  /** Request parameters (query, path, header). The Authorization header is described by `auth`, not here. */
  readonly params: readonly ContractParam[];
  /** Root type of the JSON request body, or null for an operation without a body. */
  readonly requestRoot: (typeof SHAPE_ROOTS)[number] | null;
  /** Success statuses in ascending order. */
  readonly success: readonly number[];
  /** Root type of the success body, or null when every success status has no body (204). */
  readonly responseRoot: (typeof SHAPE_ROOTS)[number] | null;
  /** Error responses, sorted by status then code. */
  readonly errors: readonly ContractOperationError[];
  /** Caching behaviour. */
  readonly caching: ContractCaching;
  /** Fixture groups holding this operation's fixtures. Never empty. */
  readonly fixtureGroups: readonly FixtureGroup[];
  /** Extra one-line facts rendered under the table. */
  readonly notes?: readonly string[];
  /** Source module the row is derived from, repo-relative. For review only, not rendered. */
  readonly source: string;
}

/** Sort key order for error rows: status ascending, then code (code-unit). Stable for equal keys. */
export function compareOperationErrors(a: ContractOperationError, b: ContractOperationError): number {
  if (a.status !== b.status) return a.status - b.status;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/** Router query guard and path-parameter guard; runs for every matched route. */
const REQUEST_GUARD: ContractOperationError = {
  code: "INVALID_REQUEST",
  status: 400,
  body: "ErrorEnvelope",
  when: `query string over ${MAX_QUERY_BYTES} bytes, a repeated query key, or a malformed/over-${MAX_PARAM_BYTES}-byte path parameter`,
};

/** Router top-level catch. */
const INTERNAL: ContractOperationError = {
  code: "INTERNAL_ERROR",
  status: 500,
  body: "ErrorEnvelope",
  when: "unexpected server fault",
};

/** Bundle-error short-circuit: every /api path except session and events. One row per code. */
const BUNDLE_ERRORS: readonly ContractOperationError[] = (
  [
    "ESTATE_BUNDLE_MISSING",
    "ESTATE_BUNDLE_UNREADABLE",
    "ESTATE_BUNDLE_UNPARSEABLE",
    "ESTATE_BUNDLE_VERSION",
    "ESTATE_BUNDLE_STRUCTURE",
    "ESTATE_BUNDLE_INCOHERENT",
  ] as const
).map((code) => ({ code, status: 503, body: "BundleErrorBody" as const, when: "the estate bundle failed to load" }));

/** Current views before the first cycle. */
const NOT_READY: ContractOperationError = {
  code: "NOT_READY",
  status: 503,
  body: "ErrorEnvelope",
  when: "before the first cycle is published",
};

/** When each history failure is returned. A new failure code without a clause fails typecheck. */
const HISTORY_WHEN = {
  INVALID_REQUEST: "a `range` value outside the allowed ids, or any query key other than `range`",
  QUERY_NOT_FOUND: "unknown `queryId`",
  TARGET_NOT_FOUND: "no target or endpoint with that exact id in the current estate",
  QUERY_NOT_APPLICABLE: "the query does not apply to that kind of target",
  RANGE_UNSUPPORTED: "the range is longer than the query supports",
  HISTORY_OVERLOADED: "too many history requests are in progress",
  SOURCE_UNAVAILABLE: "the upstream metrics or checks source failed",
  SOURCE_TIMEOUT: "the upstream source timed out",
  HISTORY_LIMIT_EXCEEDED: "the result exceeds a history maximum",
  MODEL_CHANGED: "the estate model changed while the query ran",
  HISTORY_CANCELLED: "the request was cancelled before it finished",
} as const satisfies Record<HistoryFailure["code"], string>;

/** History: every failure code at the status the routes map it to. */
const HISTORY_ERRORS: readonly ContractOperationError[] = (
  Object.keys(HISTORY_STATUS) as HistoryFailure["code"][]
).map((code) => ({
  code,
  status: HISTORY_STATUS[code],
  body: "ErrorEnvelope" as const,
  when: HISTORY_WHEN[code],
  ...(code === "HISTORY_OVERLOADED" ? { headers: ["Retry-After"] } : {}),
}));

const sorted = (errors: readonly ContractOperationError[]): readonly ContractOperationError[] =>
  Object.freeze([...errors].sort(compareOperationErrors));

const CURRENT_VIEW_ERRORS = sorted([REQUEST_GUARD, NOT_READY, ...BUNDLE_ERRORS, INTERNAL]);
const HISTORY_OPERATION_ERRORS = sorted([REQUEST_GUARD, ...HISTORY_ERRORS, ...BUNDLE_ERRORS, INTERNAL]);
const GUARD_ONLY_ERRORS = sorted([REQUEST_GUARD, INTERNAL]);

/** How every push request body is carried. */
const PUSH_BODY = `\`Content-Type: application/json\`, at most ${CONTRACT_LIMITS.request.bodyBytes} bytes`;

/** Push body refused: wrong media type, malformed JSON or failed validation. There is no 415. */
const PUSH_INVALID: ContractOperationError = {
  code: "INVALID_REQUEST",
  status: 400,
  body: "ErrorEnvelope",
  when: "the media type is not `application/json`, the body is not valid JSON, or it fails validation (unknown member, missing member, bad value)",
};

/** Device credential refused, uniformly. */
const PUSH_UNAUTHORIZED: ContractOperationError = {
  code: "UNAUTHORIZED",
  status: 401,
  body: "ErrorEnvelope",
  when: "the `Authorization` header is missing, repeated or malformed, or the credential is unknown or revoked; the response does not say which",
};

/** Push disabled: the path is an unknown non-GET route. */
const PUSH_NOT_CONFIGURED: ContractOperationError = {
  code: "METHOD_NOT_ALLOWED",
  status: 405,
  body: "ErrorEnvelope",
  when: "push is not configured on this server (the `push` capability is absent)",
};

/** Push body over the request cap. */
const PUSH_TOO_LARGE: ContractOperationError = {
  code: "PAYLOAD_TOO_LARGE",
  status: 413,
  body: "ErrorEnvelope",
  when: `the body is over ${CONTRACT_LIMITS.request.bodyBytes} bytes`,
};

/** Push configured but unable to serve. */
const PUSH_UNAVAILABLE: ContractOperationError = {
  code: "PUSH_UNAVAILABLE",
  status: 503,
  body: "ErrorEnvelope",
  when: "push is configured but unavailable (misconfigured, or the device registry cannot be written)",
};

const NO_STORE: ContractCaching = { kind: "no-store", cacheControl: "private, no-store" };

const CONDITIONAL: ContractCaching = { kind: "conditional", cacheControl: "private, no-cache", vary: "Accept-Encoding" };
const ALWAYS_FULL: ContractCaching = { kind: "always-full", cacheControl: "private, no-cache" };

const unique = (values: readonly string[]): readonly string[] => [...new Set(values)];

/** The `range` query parameter of a history operation. */
function rangeParam(defaultText: string): ContractParam {
  return {
    name: "range",
    in: "query",
    required: false,
    values: { kind: "enum", values: [...RANGE_IDS] },
    default: defaultText,
    note: "no other query key is accepted",
  };
}

/** Canonical display case of a lower-case header constant, e.g. `x-pulse-client` → `X-Pulse-Client`. */
const headerName = (lower: string): string =>
  lower.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");

const QUERY_DEFAULT = "the query's default range";

/** A cycle-backed current view (alerts, estate, timeline). */
function currentView(
  name: string,
  path: string,
  responseRoot: ContractOperation["responseRoot"],
  group: FixtureGroup,
  source: string,
  notes?: readonly string[],
): ContractOperation {
  return {
    label: `GET ${path}`,
    name,
    method: "GET",
    path,
    auth: "none",
    params: [],
    requestRoot: null,
    success: [200, 304],
    responseRoot,
    errors: CURRENT_VIEW_ERRORS,
    caching: CONDITIONAL,
    fixtureGroups: [group],
    ...(notes !== undefined ? { notes } : {}),
    source,
  };
}

/** A bounded-history operation. */
function historyOperation(
  name: string,
  path: string,
  params: readonly ContractParam[],
  responseRoot: ContractOperation["responseRoot"],
  group: FixtureGroup,
): ContractOperation {
  return {
    label: `GET ${path}`,
    name,
    method: "GET",
    path,
    auth: "none",
    params,
    requestRoot: null,
    success: [200],
    responseRoot,
    errors: HISTORY_OPERATION_ERRORS,
    caching: ALWAYS_FULL,
    fixtureGroups: [group],
    source: "apps/web/src/server/routes/history.ts",
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Every contract operation, in table order. Frozen. */
export const OPERATIONS: readonly ContractOperation[] = deepFreeze([
  {
    label: "GET /api/session",
    name: "Session",
    method: "GET",
    path: "/api/session",
    auth: "none",
    params: [
      {
        name: headerName(CLIENT_HEADER),
        in: "header",
        required: false,
        values: { kind: "text", description: "client name, lower-case letters, digits and hyphens, 1 to 32 characters" },
        note: "ignored when malformed",
      },
      {
        name: headerName(CONTRACT_HEADER),
        in: "header",
        required: false,
        values: { kind: "text", description: "the client's `<major>.<minMinor>`" },
        note: "ignored when malformed",
      },
    ],
    requestRoot: null,
    success: [200],
    responseRoot: "SessionPayload",
    errors: GUARD_ONLY_ERRORS,
    caching: { kind: "no-store", cacheControl: "private, no-store" },
    fixtureGroups: ["session", "handshake"],
    notes: ["Served even when the estate bundle failed to load. Unknown query keys are ignored."],
    source: "apps/web/src/server/routes/session.ts",
  },
  currentView("Overview", "/api/overview", "OverviewSnapshotV2", "overview", "apps/web/src/server/routes/overview.ts", [
    "Before the first cycle, the server may answer 200 with the same body type and no `ETag`, `X-Pulse-*` or `Vary` headers.",
  ]),
  currentView("Alerts", "/api/alerts", "AlertsPayload", "alerts", "apps/web/src/server/routes/current.ts"),
  currentView("Estate", "/api/estate", "EstatePayload", "estate", "apps/web/src/server/routes/current.ts"),
  currentView("Timeline", "/api/timeline", "TimelinePayload", "timeline", "apps/web/src/server/routes/current.ts"),
  historyOperation(
    "Estate history",
    "/api/history/estate/:queryId",
    [
      { name: "queryId", in: "path", required: true, values: { kind: "enum", values: [...queryIdsForTargetKind("estate")] } },
      rangeParam(QUERY_DEFAULT),
    ],
    "HistoryPayload",
    "history-estate",
  ),
  historyOperation(
    "Target history",
    "/api/history/target/:drilldownId/:queryId",
    [
      {
        name: "drilldownId",
        in: "path",
        required: true,
        values: { kind: "text", description: "exact drilldown id from overview or estate" },
        note: "may contain an encoded slash (`%2F`)",
      },
      {
        name: "queryId",
        in: "path",
        required: true,
        values: {
          kind: "enum",
          values: unique([
            ...queryIdsForTargetKind("host"),
            ...queryIdsForTargetKind("service"),
            ...queryIdsForTargetKind("endpoint"),
          ]),
        },
      },
      rangeParam(QUERY_DEFAULT),
    ],
    "HistoryPayload",
    "history-target",
  ),
  historyOperation(
    "Alert history",
    "/api/history/alerts",
    [rangeParam(`\`${QUERY_CATALOG["alerts.firing"].defaultRange}\``)],
    "IntervalHistoryPayload",
    "history-alerts",
  ),
  historyOperation(
    "Check history",
    "/api/history/checks/:endpoint",
    [
      {
        name: "endpoint",
        in: "path",
        required: true,
        values: { kind: "text", description: "exact Gatus endpoint name" },
        note: "may contain an encoded slash (`%2F`)",
      },
      rangeParam(`\`${CHECKS_DEFAULT_RANGE}\``),
    ],
    "EndpointHistoryPayload",
    "history-checks",
  ),
  {
    label: "SSE /api/events",
    name: "Live events",
    method: "GET",
    path: "/api/events",
    auth: "none",
    params: [
      {
        name: "Last-Event-ID",
        in: "header",
        required: false,
        values: { kind: "text", description: "the `id` of the last tick received" },
      },
    ],
    requestRoot: null,
    success: [200],
    responseRoot: "LiveTick",
    errors: GUARD_ONLY_ERRORS,
    caching: { kind: "stream", cacheControl: "no-cache" },
    fixtureGroups: ["events"],
    notes: [
      `The response is \`text/event-stream\`. The server sends \`retry: ${SSE_RETRY_MS}\` on connect and a heartbeat comment every ${SSE_HEARTBEAT_MS} ms, and keeps at most ${SSE_MAX_STREAMS} streams open.`,
      "There is no `NOT_READY` response: before the first publication the stream opens and sends only `retry` and heartbeats.",
    ],
    source: "apps/web/src/server/routes/events.ts",
  },
  {
    label: `POST ${PUSH_PATHS.redeem}`,
    name: "Redeem pairing token",
    method: "POST",
    path: PUSH_PATHS.redeem,
    auth: "pairing-token",
    params: [],
    requestRoot: "PairingRedeemRequest",
    success: [201],
    responseRoot: "PairingRedeemResponse",
    errors: sorted([
      PUSH_INVALID,
      {
        code: "PAIRING_REFUSED",
        status: 403,
        body: "ErrorEnvelope",
        when: "the token is missing, malformed, unknown, expired or already used; the response does not say which",
      },
      PUSH_NOT_CONFIGURED,
      {
        code: "DEVICE_CAP_REACHED",
        status: 409,
        body: "ErrorEnvelope",
        when: "the server's paired-device limit is reached; an operator must revoke a device first",
      },
      PUSH_TOO_LARGE,
      {
        code: "RATE_LIMITED",
        status: 429,
        body: "ErrorEnvelope",
        when: "too many failed redemptions recently; every outstanding token was invalidated",
        headers: ["Retry-After"],
      },
      INTERNAL,
      PUSH_UNAVAILABLE,
    ]),
    caching: NO_STORE,
    fixtureGroups: ["push-pairing"],
    notes: [
      `The body is ${PUSH_BODY}. \`displayName\` is 1 to 64 UTF-8 bytes after trimming, from letters, digits, space and \`'’.-_()#\`.`,
      "`credential` appears in this response only. Store it in the Keychain; never log, display or send it anywhere except the `Authorization` header of the device operations.",
      "A token is valid for 10 minutes and can be redeemed once. A server restart invalidates it.",
    ],
    source: "apps/web/src/server/push/handlers/redeem.ts",
  },
  {
    label: `PUT ${PUSH_PATHS.device}`,
    name: "Register device",
    method: "PUT",
    path: PUSH_PATHS.device,
    auth: "device-credential",
    params: [],
    requestRoot: "DeviceRegistrationRequest",
    success: [200],
    responseRoot: "DeviceRegistrationResponse",
    errors: sorted([PUSH_INVALID, PUSH_UNAUTHORIZED, PUSH_NOT_CONFIGURED, PUSH_TOO_LARGE, INTERNAL, PUSH_UNAVAILABLE]),
    caching: NO_STORE,
    fixtureGroups: ["push-device"],
    notes: [
      `The body is ${PUSH_BODY}. Every member is required; a request replaces the APNs token, environment and preferences.`,
      "Refresh the registration at least every 30 days whenever the app runs, including background launches. A device not seen for 90 days is removed.",
      "On `401 UNAUTHORIZED`, discard the stored credential and show that the device must be paired again. Do not retry with the same credential.",
    ],
    source: "apps/web/src/server/push/handlers/device.ts",
  },
  {
    label: `DELETE ${PUSH_PATHS.device}`,
    name: "Remove device",
    method: "DELETE",
    path: PUSH_PATHS.device,
    auth: "device-credential",
    params: [],
    requestRoot: null,
    success: [204],
    responseRoot: null,
    errors: sorted([PUSH_UNAUTHORIZED, PUSH_NOT_CONFIGURED, INTERNAL, PUSH_UNAVAILABLE]),
    caching: NO_STORE,
    fixtureGroups: ["push-device"],
    notes: ["No request body. On 204 the credential is invalidated and nothing more is sent to the device; discard it."],
    source: "apps/web/src/server/push/handlers/device.ts",
  },
] satisfies ContractOperation[]);
