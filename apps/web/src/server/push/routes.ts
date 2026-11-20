// Push routing: the push route table, path matching, the push dispatcher and the request-body pipeline shared by
// every push route that takes a JSON body.

import type { ZodType, ZodTypeDef } from "zod";

import { CONTRACT_LIMITS, DEVICE_ID_PATTERN } from "@pulse/web-data/contract";
import type { Identity } from "@pulse/web-data/identity";
import {
  ERROR_MESSAGES,
  type DeviceRegistrationRequest,
  type ErrorEnvelope,
  type PairingRedeemRequest,
} from "@pulse/web-data/wire";

import { log } from "../log.js";
import { checkContentType, parseStrictBody, readBoundedJson } from "../mutations/guards.js";
import { recordPushAdminRefusal } from "../routes/metrics.js";
import { authoriseBrowser, authoriseDevice, authoriseSecret } from "./auth.js";
import { currentBadge } from "./badge.js";
import type { ConfiguredPushServices, PushDispatcher, PushServices } from "./bootstrap.js";
import { PUSH_CACHE_CONTROL, PUSH_PATHS } from "./constants.js";
import { handleAdminTest } from "./handlers/admin-test.js";
import { handleRegisterDevice, handleRemoveSelf } from "./handlers/device.js";
import { handleListAdminDevices, handleRevokeDevice } from "./handlers/devices.js";
import { handleCancelWebToken, handleIssueAdminToken, handleIssueWebToken } from "./handlers/pairing-tokens.js";
import { handleRedeem, type PushHandlerDeps } from "./handlers/redeem.js";
import {
  adminPairingRequestSchema,
  adminTestRequestSchema,
  deviceRegistrationRequestSchema,
  pairingRedeemRequestSchema,
  type AdminPairingRequest,
  type AdminTestRequest,
} from "./handlers/schemas.js";
import { buildPushStatus, pushStatusResponse } from "./handlers/status.js";
import { handleWebhook, type WebhookDeps } from "./handlers/webhook.js";
import { fromGuardReason, pushErrorResponse, type PushRefusal } from "./refusal.js";
import type { DeviceRecord } from "./registry/schema.js";
import { toDeviceSummary } from "./registry/summary.js";
import type { PushSecret } from "./secrets.js";
import type { TestSendDeps } from "./test-send.js";

export type { PushDispatcher } from "./bootstrap.js";

// ---------------------------------------------------------------------------------------------------------------
// Table types
// ---------------------------------------------------------------------------------------------------------------

/** HTTP methods the push table uses. Any other method on a known path is 405. */
export type PushMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Route class. It decides which surface switch applies and which body cap is used. */
export type PushRouteClass = "contract" | "webhook" | "web" | "operator";

/**
 * Authoriser kind; each route has exactly one.
 * - `pairing-token`: no header authoriser; the handler checks the token from the body.
 * - `device-credential`: the device bearer credential, applied by the dispatcher.
 * - `webhook-secret`: the webhook shared secret, applied by the webhook handler itself.
 * - `operator-secret`: the operator shared secret, applied by the dispatcher.
 * - `browser-read` / `browser-write`: the browser gate, applied by the dispatcher.
 */
export type AuthKind =
  | "pairing-token"
  | "device-credential"
  | "webhook-secret"
  | "operator-secret"
  | "browser-read"
  | "browser-write";

/** Every template, which is also the metric label. `:id` matches one path segment. */
export type PushPathTemplate = Exclude<(typeof PUSH_PATHS)[keyof typeof PUSH_PATHS], typeof PUSH_PATHS.prefix>;

/** What the dispatcher reads from the body before the handler runs. */
export type PushBodySpec =
  | {
      /** Never read by the dispatcher (GET, DELETE, web issue, and the webhook, which reads its own). */
      readonly kind: "none";
    }
  | {
      /** Read and validated by readPushBody before the handler runs. */
      readonly kind: "json";
      /** Maximum body size in bytes. */
      readonly cap: number;
      /** The strict request schema. */
      readonly schema: ZodType<unknown, ZodTypeDef, unknown>;
    };

/**
 * The bindings the dispatcher calls for a configured request, built once per dispatcher by `bindHandlers`. Their
 * input is already authorised and validated. A binding may answer synchronously or with a Promise.
 */
export interface PushHandlers {
  /** POST /api/push/alertmanager; the handler checks availability, the secret and the body itself. */
  readonly webhook: (ctx: { readonly request: Request; readonly peerIp: string | null }) => Promise<Response>;
  /** POST /api/push/pairings/redeem. */
  readonly redeem: (body: PairingRedeemRequest) => Response | Promise<Response>;
  /** PUT /api/push/device. */
  readonly registerDevice: (deviceId: string, body: DeviceRegistrationRequest) => Response | Promise<Response>;
  /** DELETE /api/push/device. */
  readonly removeDevice: (deviceId: string) => Response | Promise<Response>;
  /** GET /api/push/status. */
  readonly status: (identity: Identity | null) => Response | Promise<Response>;
  /** POST /api/push/pairing-tokens (reads only the Origin header). */
  readonly issueWebToken: (request: Request) => Response | Promise<Response>;
  /** DELETE /api/push/pairing-tokens/current. */
  readonly cancelWebToken: () => Response | Promise<Response>;
  /** DELETE /api/push/devices/:id. */
  readonly revokeDevice: (id: string) => Response | Promise<Response>;
  /** POST /api/push/admin/pairing-tokens. */
  readonly issueAdminToken: (body: AdminPairingRequest) => Response | Promise<Response>;
  /** GET /api/push/admin/devices. */
  readonly listDevices: () => Response | Promise<Response>;
  /** DELETE /api/push/admin/devices/:id. */
  readonly adminRevokeDevice: (id: string) => Response | Promise<Response>;
  /** POST /api/push/admin/test. */
  readonly adminTest: (body: AdminTestRequest) => Response | Promise<Response>;
}

/** The name of a binding; each table row names one. */
export type PushHandlerName = keyof PushHandlers;

/** One row of the table: static data naming its handler; the binding is looked up at request time. */
export interface PushRoute {
  /** The HTTP method. */
  readonly method: PushMethod;
  /** The path template (also the metric label). */
  readonly template: PushPathTemplate;
  /** Route class. */
  readonly cls: PushRouteClass;
  /** The one authoriser. */
  readonly auth: AuthKind;
  /** What the dispatcher reads from the body. */
  readonly body: PushBodySpec;
  /** The binding to call. */
  readonly handler: PushHandlerName;
}

// ---------------------------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------------------------

/** Body cap for operator routes. Not a contract limit, so not in CONTRACT_LIMITS. */
const LOCAL_BODY_BYTES = 4096;
/** Body cap for contract routes. */
const CONTRACT_BODY_BYTES = CONTRACT_LIMITS.request.bodyBytes;
const NONE: PushBodySpec = Object.freeze({ kind: "none" });
const json = (cap: number, schema: ZodType<unknown, ZodTypeDef, unknown>): PushBodySpec =>
  Object.freeze({ kind: "json", cap, schema });

/** Every push route: twelve unique (method, template) rows, frozen. */
export const PUSH_ROUTES: readonly PushRoute[] = Object.freeze(
  (
    [
      { method: "POST", template: PUSH_PATHS.redeem, cls: "contract", auth: "pairing-token", body: json(CONTRACT_BODY_BYTES, pairingRedeemRequestSchema), handler: "redeem" },
      { method: "PUT", template: PUSH_PATHS.device, cls: "contract", auth: "device-credential", body: json(CONTRACT_BODY_BYTES, deviceRegistrationRequestSchema), handler: "registerDevice" },
      { method: "DELETE", template: PUSH_PATHS.device, cls: "contract", auth: "device-credential", body: NONE, handler: "removeDevice" },
      // The webhook handler reads its own (larger) body.
      { method: "POST", template: PUSH_PATHS.webhook, cls: "webhook", auth: "webhook-secret", body: NONE, handler: "webhook" },
      { method: "GET", template: PUSH_PATHS.status, cls: "web", auth: "browser-read", body: NONE, handler: "status" },
      { method: "POST", template: PUSH_PATHS.pairingTokens, cls: "web", auth: "browser-write", body: NONE, handler: "issueWebToken" },
      { method: "DELETE", template: PUSH_PATHS.pairingTokenCurrent, cls: "web", auth: "browser-write", body: NONE, handler: "cancelWebToken" },
      { method: "DELETE", template: PUSH_PATHS.deviceById, cls: "web", auth: "browser-write", body: NONE, handler: "revokeDevice" },
      { method: "POST", template: PUSH_PATHS.adminPairingTokens, cls: "operator", auth: "operator-secret", body: json(LOCAL_BODY_BYTES, adminPairingRequestSchema), handler: "issueAdminToken" },
      { method: "GET", template: PUSH_PATHS.adminDevices, cls: "operator", auth: "operator-secret", body: NONE, handler: "listDevices" },
      { method: "DELETE", template: PUSH_PATHS.adminDeviceById, cls: "operator", auth: "operator-secret", body: NONE, handler: "adminRevokeDevice" },
      { method: "POST", template: PUSH_PATHS.adminTest, cls: "operator", auth: "operator-secret", body: json(LOCAL_BODY_BYTES, adminTestRequestSchema), handler: "adminTest" },
    ] satisfies PushRoute[]
  ).map((r): PushRoute => Object.freeze(r)),
);

/** Rows grouped by template, built once at module load. */
const ROUTES_BY_TEMPLATE: ReadonlyMap<PushPathTemplate, readonly PushRoute[]> = (() => {
  const map = new Map<PushPathTemplate, PushRoute[]>();
  for (const r of PUSH_ROUTES) {
    const rows = map.get(r.template);
    if (rows === undefined) map.set(r.template, [r]);
    else rows.push(r);
  }
  return map;
})();

/** Literal (id-free) templates, for exact lookup. */
const LITERAL_TEMPLATES: ReadonlySet<string> = new Set(
  [...ROUTES_BY_TEMPLATE.keys()].filter((t) => !t.endsWith("/:id")),
);

/** Templates with a trailing `:id` segment, longest base first so `/admin/devices/` wins over nothing shorter. */
const ID_TEMPLATES: readonly { readonly base: string; readonly template: PushPathTemplate }[] = Object.freeze(
  [PUSH_PATHS.deviceById, PUSH_PATHS.adminDeviceById].map((template) =>
    Object.freeze({ base: template.slice(0, -":id".length), template }),
  ),
);

// ---------------------------------------------------------------------------------------------------------------
// Matching and labels
// ---------------------------------------------------------------------------------------------------------------

/** Result of matching a pathname to a template. */
export interface PushPathMatch {
  /** The matched template. */
  readonly template: PushPathTemplate;
  /** The raw `:id` segment (not percent-decoded); `null` for a literal template. */
  readonly id: string | null;
  /** `DEVICE_ID_PATTERN.test(id)`; `true` when `id` is null. */
  readonly idValid: boolean;
}

/** True for any pathname under `/api/push/`. */
export function isPushPath(pathname: string): boolean {
  return pathname.startsWith(PUSH_PATHS.prefix);
}

const ANSWERED = new WeakSet<Response>();

/** True when `res` is a Response the push dispatcher returned for a matched path. */
export function isPushAnswer(res: Response): boolean {
  return ANSWERED.has(res);
}

/**
 * Match `pathname` exactly against the push templates. Literal templates match by string equality (no trailing-slash
 * or case folding); an id template matches when the remainder after its base is one non-empty segment with no `/`.
 * Pure; never throws.
 */
export function matchPushPath(pathname: string): PushPathMatch | null {
  if (LITERAL_TEMPLATES.has(pathname)) {
    return { template: pathname as PushPathTemplate, id: null, idValid: true };
  }
  for (const { base, template } of ID_TEMPLATES) {
    if (!pathname.startsWith(base)) continue;
    const id = pathname.slice(base.length);
    if (id.length === 0 || id.includes("/")) return null;
    return { template, id, idValid: DEVICE_ID_PATTERN.test(id) };
  }
  return null;
}

/**
 * Metric label for a push path: the matched template, or null when the path matches no template. The method does
 * not change the result: a known path requested with the wrong method is still labelled with its template.
 */
export function pushRouteLabel(_method: string, pathname: string): string | null {
  return matchPushPath(pathname)?.template ?? null;
}

// ---------------------------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------------------------

/** The no-op dispatcher: the default of the router's push parameter, so existing callers are unchanged. */
export const NO_PUSH: PushDispatcher = async () => null;

/** Set `Cache-Control: private, no-store` (copying the response if its headers are immutable) and mark it. */
function finish(res: Response): Response {
  let out = res;
  try {
    res.headers.set("cache-control", PUSH_CACHE_CONTROL);
  } catch {
    const headers = new Headers(res.headers);
    headers.set("cache-control", PUSH_CACHE_CONTROL);
    out = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
  ANSWERED.add(out);
  return out;
}

/** 405 with `Allow` listing the template's methods; the body equals the router's shared 405 body. */
function methodNotAllowed(rows: readonly PushRoute[]): Response {
  const allow = [...new Set(rows.map((r) => r.method))].sort().join(", ");
  return Response.json(
    { code: "METHOD_NOT_ALLOWED", message: ERROR_MESSAGES.METHOD_NOT_ALLOWED } satisfies ErrorEnvelope,
    { status: 405, headers: { allow, "cache-control": PUSH_CACHE_CONTROL } },
  );
}

/** Build the configured bindings from the services. */
function bindHandlers(services: ConfiguredPushServices): PushHandlers {
  const deps: PushHandlerDeps = { pairing: services.pairing, store: services.store, clock: services.clock };
  const webhookDeps: WebhookDeps =
    services.webhook === "on" && services.webhookSecret !== null
      ? { available: true, secret: services.webhookSecret, intake: services.intake, store: services.store }
      : { available: false };
  const testDeps: TestSendDeps = {
    apns: services.apns,
    store: services.store,
    signer: services.signer,
    monitor: services.monitor,
    clock: services.clock,
    timers: services.timers,
    badge: () => currentBadge(services.getRuntime()),
    topic: services.topic,
  };
  return {
    webhook: (ctx) => handleWebhook(ctx, webhookDeps),
    redeem: (body) => handleRedeem(deps, body),
    registerDevice: (deviceId, body) => handleRegisterDevice(deps, deviceId, body),
    removeDevice: (deviceId) => handleRemoveSelf(deps, deviceId),
    status: (_identity) => {
      const outstanding = services.pairing.outstandingWeb();
      return pushStatusResponse(
        buildPushStatus({
          state: "configured",
          devices: services.store.list().map(toDeviceSummary),
          outstandingExpiresAt: outstanding === null ? null : new Date(outstanding.expiresAt).toISOString(),
          maxDevices: services.maxDevices,
        }),
      );
    },
    issueWebToken: (request) => handleIssueWebToken(deps, request),
    cancelWebToken: () => handleCancelWebToken(deps),
    revokeDevice: (id) => handleRevokeDevice(deps, id),
    issueAdminToken: (b) => handleIssueAdminToken(deps, b.baseUrl === undefined ? {} : { baseUrl: b.baseUrl }),
    listDevices: () => handleListAdminDevices(deps),
    adminRevokeDevice: (id) => handleRevokeDevice(deps, id),
    adminTest: (body) => handleAdminTest(testDeps, body),
  };
}

/** The request slice the dispatcher hands to each step. */
interface PushRequest {
  readonly request: Request;
  readonly peerIp: string | null;
}

/** Misconfigured: the webhook answers its own counted 503, status is served behind the read gate, the rest 503. */
async function answerMisconfigured(
  services: PushServices,
  route: PushRoute,
  { request, peerIp }: PushRequest,
): Promise<Response> {
  if (route.handler === "webhook") return handleWebhook({ request, peerIp }, { available: false });
  if (route.handler !== "status") return pushErrorResponse("unavailable");
  const gate = authoriseBrowser(request, peerIp, services.identity, "read");
  if (!gate.ok) return pushErrorResponse(gate.refusal);
  return pushStatusResponse(
    buildPushStatus({ state: "misconfigured", devices: [], outstandingExpiresAt: null, maxDevices: services.maxDevices }),
  );
}

/** Configured: surface, authorise, id, body, handler, in that order. */
async function answerConfigured(
  services: ConfiguredPushServices,
  h: PushHandlers,
  route: PushRoute,
  match: PushPathMatch,
  { request, peerIp }: PushRequest,
): Promise<Response> {
  // 1. The webhook does its own availability, secret and body work.
  if (route.handler === "webhook") return h.webhook({ request, peerIp });

  // 2. Operator surface: an off surface has no secret to compare against.
  let operatorSecret: PushSecret | null = null;
  if (route.cls === "operator") {
    operatorSecret = services.admin === "on" ? services.operatorSecret : null;
    if (operatorSecret === null) return pushErrorResponse("unavailable");
  }

  // 3. Authorise.
  let device: DeviceRecord | null = null;
  let identity: Identity | null = null;
  switch (route.auth) {
    case "pairing-token":
    case "webhook-secret":
      break;
    case "device-credential": {
      const auth = authoriseDevice(request.headers, services.store);
      if (!auth.ok) return pushErrorResponse(auth.refusal);
      device = auth.device;
      break;
    }
    case "operator-secret": {
      if (operatorSecret === null || !authoriseSecret(request, operatorSecret)) {
        recordPushAdminRefusal();
        return pushErrorResponse("unauthorized");
      }
      break;
    }
    case "browser-read":
    case "browser-write": {
      const gate = authoriseBrowser(request, peerIp, services.identity, route.auth === "browser-read" ? "read" : "write");
      if (!gate.ok) return pushErrorResponse(gate.refusal);
      identity = gate.identity;
      break;
    }
  }

  // 4. Id: a malformed id is 404 without a lookup.
  if (match.id !== null && !match.idValid) return pushErrorResponse("not-found");
  const id = match.id ?? "";

  // 5. Body.
  let body: unknown = undefined;
  if (route.body.kind === "json") {
    const read = await readPushBody(request, route.body.cap, route.body.schema);
    if (!read.ok) return pushErrorResponse(read.refusal, read.fields === undefined ? undefined : { fields: read.fields });
    body = read.body;
  }

  // 6. Handler, with exactly the validated input it takes.
  const deviceId = device?.id ?? "";
  switch (route.handler) {
    case "redeem":
      return h.redeem(body as PairingRedeemRequest);
    case "registerDevice":
      return h.registerDevice(deviceId, body as DeviceRegistrationRequest);
    case "removeDevice":
      return h.removeDevice(deviceId);
    case "status":
      return h.status(identity);
    case "issueWebToken":
      return h.issueWebToken(request);
    case "cancelWebToken":
      return h.cancelWebToken();
    case "revokeDevice":
      return h.revokeDevice(id);
    case "issueAdminToken":
      return h.issueAdminToken(body as AdminPairingRequest);
    case "listDevices":
      return h.listDevices();
    case "adminRevokeDevice":
      return h.adminRevokeDevice(id);
    case "adminTest":
      return h.adminTest(body as AdminTestRequest);
  }
}

/**
 * Build the push dispatcher from bootstrap's services. For a path matchPushPath does not match it resolves null; for
 * a matched path it always resolves a Response that carries `Cache-Control: private, no-store` and is marked for
 * isPushAnswer. A wrong method on a known path is 405 with `Allow`, before any state or auth check. Any exception is
 * logged as `push_internal_error {route: <template>}` (never the message) and answered 500. Never rejects.
 *
 * @param services - Everything bootstrap assembled for the current state.
 */
export function createPushDispatcher(services: PushServices): PushDispatcher {
  const handlers = services.state === "configured" ? bindHandlers(services) : null;
  return async (ctx) => {
    const match = matchPushPath(ctx.pathname);
    if (match === null) return null;
    try {
      const rows = ROUTES_BY_TEMPLATE.get(match.template) ?? [];
      const route = rows.find((r) => r.method === ctx.request.method);
      if (route === undefined) return finish(methodNotAllowed(rows));
      const req: PushRequest = { request: ctx.request, peerIp: ctx.peerIp };
      const res =
        services.state === "configured" && handlers !== null
          ? await answerConfigured(services, handlers, route, match, req)
          : await answerMisconfigured(services, route, req);
      return finish(res);
    } catch {
      log({ event: "push_internal_error", ok: false, route: match.template });
      try {
        return finish(pushErrorResponse("internal"));
      } catch {
        return pushErrorResponse("internal");
      }
    }
  };
}

/** Result of {@link readPushBody}. */
export type PushBodyResult<B> =
  | {
      /** The body was read and validated. */
      readonly ok: true;
      /** The validated body. */
      readonly body: B;
    }
  | {
      /** The body was refused. */
      readonly ok: false;
      /** Why: invalid-body or body-too-large (anything else is a bug and maps to internal). */
      readonly refusal: PushRefusal;
      /** Sanitised invalid-field paths, never values; set only when known. */
      readonly fields?: string;
    };

function refused<B>(refusal: PushRefusal, fields: string | undefined): PushBodyResult<B> {
  return fields === undefined ? { ok: false, refusal } : { ok: false, refusal, fields };
}

/**
 * Read and validate a JSON request body. Never throws.
 *
 * 1. The media type must be `application/json` (optionally with `charset=utf-8`); otherwise invalid-body and the body
 *    is not read. There is no unsupported-media-type status.
 * 2. The body is read up to `cap` bytes: a declared or streamed size over the cap is body-too-large; a malformed
 *    Content-Length, an absent body or a stream error is invalid-body.
 * 3. Strict UTF-8, JSON and schema validation; a failure is invalid-body with the failing paths in `fields`.
 *
 * @param request - The request.
 * @param cap     - Maximum body size in bytes.
 * @param schema  - The strict request schema.
 */
export async function readPushBody<B>(
  request: Request,
  cap: number,
  schema: ZodType<B, ZodTypeDef, unknown>,
): Promise<PushBodyResult<B>> {
  try {
    const type = checkContentType(request.headers);
    if (!type.ok) return refused(fromGuardReason(type.reason), undefined);
    const bytes = await readBoundedJson(request, cap);
    if (!bytes.ok) return refused(fromGuardReason(bytes.reason), undefined);
    const parsed = parseStrictBody(schema, bytes.value);
    if (!parsed.ok) {
      const refusal = fromGuardReason(parsed.reason);
      return refused(refusal, refusal === "invalid-body" ? parsed.fields : undefined);
    }
    return { ok: true, body: parsed.value };
  } catch {
    return refused("internal", undefined);
  }
}
