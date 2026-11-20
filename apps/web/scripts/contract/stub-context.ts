// A minimal server context for calling the real route handlers from the fixture generator, plus the
// helpers that turn a handler's `Response` into a fixture body.

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __resetCapabilityProvidersForTest, PAIR_LINK_PARAM } from "@pulse/web-data/contract";
import { canonicalJson } from "@pulse/web-data/cycle";
import type { AuthMode, Identity } from "@pulse/web-data/identity";
import type { ApiErrorCode, BundleErrorKind, PairingRedeemResponse } from "@pulse/web-data/wire";

import type { ServerConfig } from "../../src/server/config.js";
import { resetWritePathProvider } from "../../src/server/mutations/session-provider.js";
import { __resetMetricsForTest } from "../../src/server/routes/metrics.js";
import { buildPushRuntime, type PushBootstrapDeps, type PushRuntime } from "../../src/server/push/bootstrap.js";
import { PUSH_LIMITS, PUSH_PATHS } from "../../src/server/push/constants.js";
import type { Timers } from "../../src/server/push/dispatch/queue.js";
import type { Clock, RandomSource } from "../../src/server/push/ids.js";
import { loadPushSecret } from "../../src/server/push/secrets.js";
import { overviewErrorBody } from "../../src/server/routes/overview.js";
import { errorFor } from "../../src/server/routes/respond.js";
import { EstateBundleError } from "../../src/shared/errors.js";
import type { RouteParams, RouteRequest, ServerContext } from "../../src/shared/registry.js";
import { ContractToolError } from "./errors.js";
import { FIXED_EPOCH_MS, PLACEHOLDER } from "./scenarios/common.js";
import { DISPLAY_NAME_PLACEHOLDER } from "./scenarios/push-common.js";

/** Fields a contract handler reads. Everything else is an inert placeholder that throws when touched. */
export interface StubContextOptions {
  /** Default null. */
  readonly identity?: Identity | null;
  /** Default "none". */
  readonly authMode?: AuthMode;
}

/** An object whose every property read throws, except the listed ones. */
function guarded<T extends object>(label: string, allowed: Readonly<Record<string, unknown>> = {}): T {
  return new Proxy(Object.create(null) as T, {
    get(_target, property) {
      if (typeof property === "string" && Object.hasOwn(allowed, property)) return allowed[property];
      throw new ContractToolError(
        "SCENARIO_INVALID",
        `${label}.${String(property)}`,
        "a route handler read server context the fixture generator does not provide",
      );
    },
  });
}

/**
 * Minimal `ServerContext`: no estate, cycle or snapshot, the given identity, and a config that exposes
 * only `identity.mode`. `history`, `events`, `sources` and every other config member throw
 * `ContractToolError` SCENARIO_INVALID on any read, so a handler that starts depending on more context
 * fails generation loudly instead of producing a wrong fixture.
 */
export function stubContext(options: StubContextOptions = {}): ServerContext {
  const identityConfig = guarded<ServerContext["config"]["identity"]>("config.identity", {
    mode: options.authMode ?? "none",
  });
  return Object.freeze({
    estate: null,
    cycle: null,
    history: guarded<ServerContext["history"]>("history"),
    events: guarded<ServerContext["events"]>("events"),
    sources: guarded<ServerContext["sources"]>("sources"),
    config: guarded<ServerContext["config"]>("config", { identity: identityConfig }),
    identity: options.identity ?? null,
    snapshot: null,
  });
}

/** What a non-GET stub request carries. */
export interface StubRequestInit {
  /** Default "GET". */
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  /**
   * Request body. A string is sent as is (so a fixture can carry malformed JSON). Any other value is serialised with
   * `JSON.stringify`. With a body and no `content-type` header, `content-type: application/json` is added.
   */
  readonly body?: unknown;
  /** Request headers. Lower-case names. */
  readonly headers?: Readonly<Record<string, string>>;
}

function isStubRequestInit(value: StubRequestInit | Readonly<Record<string, string>>): value is StubRequestInit {
  return Object.hasOwn(value, "method") || Object.hasOwn(value, "body") || Object.hasOwn(value, "headers");
}

/**
 * `RouteRequest` for `path` on the placeholder base URL: no path parameters, no peer address.
 *
 * The second argument may be a plain header record or a {@link StubRequestInit}. It is read as the latter only when
 * it has an own `method`, `body` or `headers` member; no HTTP header the generator sends has those names.
 *
 * @throws {ContractToolError} SCENARIO_INVALID when `method` is GET and a body is given
 */
export function stubRouteRequest<P extends string>(
  path: P,
  init: StubRequestInit | Readonly<Record<string, string>> = {},
): RouteRequest<P> {
  const options: StubRequestInit = isStubRequestInit(init) ? init : { headers: init };
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.body !== undefined) {
    if (method === "GET") throw new ContractToolError("SCENARIO_INVALID", path, "a GET stub request cannot carry a body");
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    if (!Object.hasOwn(headers, "content-type")) headers["content-type"] = "application/json";
  }
  return {
    request: new Request(PLACEHOLDER.baseUrl + path, { method, headers, ...(body !== undefined ? { body } : {}) }),
    params: {} as Readonly<RouteParams<P>>,
    routePattern: path,
    peerIp: null,
    disableTimeout() {},
  };
}

const DECODER = new TextDecoder();

/**
 * Turn a real handler `Response` into a fixture body: the JSON value any client decodes. The caller
 * serialises it canonically, so fixture bytes do not depend on the handler's member order.
 *
 * @throws {ContractToolError} SCENARIO_INVALID when the status differs from `expectStatus`, the content
 *   type is not JSON, or the value does not survive a JSON round trip unchanged
 */
export async function responseBody(res: Response, expectStatus: number): Promise<unknown> {
  const subject = `HTTP ${expectStatus}`;
  if (res.status !== expectStatus) {
    throw new ContractToolError("SCENARIO_INVALID", subject, `status ${res.status} != ${expectStatus}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ContractToolError("SCENARIO_INVALID", subject, "handler response is not application/json");
  }
  const text = await res.text();
  const value: unknown = JSON.parse(text);
  const canonical = DECODER.decode(canonicalJson(value));
  const stable = DECODER.decode(canonicalJson(JSON.parse(canonical)));
  if (JSON.stringify(value) !== text || stable !== canonical) {
    throw new ContractToolError("SCENARIO_INVALID", subject, "handler body does not survive a JSON round trip");
  }
  return value;
}

/** The router's error envelope for `code` at `status`, as a fixture body. */
export function errorEnvelopeBody(code: ApiErrorCode, status: number): Promise<unknown> {
  return responseBody(errorFor(code, status), status);
}

const MODEL_PATH = `${PLACEHOLDER.bundleDir}/web-estate-model.json`;

/** One representative operator message per bundle failure kind, worded as the bundle loader words them. */
const BUNDLE_ERROR_MESSAGES: Readonly<Record<BundleErrorKind, string>> = {
  missing: `Required estate model is missing at ${MODEL_PATH}. Run 'pulse render' and verify the PULSE_WEB_ESTATE_MODEL mount.`,
  unreadable: `Estate bundle model is unreadable at ${MODEL_PATH}. Verify the read-only rendered-tree mount and file permissions, then run 'pulse render' if needed.`,
  unparseable: `Estate bundle model at ${MODEL_PATH} is not valid JSON. Run 'pulse render'; do not hand-edit or copy individual bundle files.`,
  version: `Estate bundle model at ${MODEL_PATH} has an unsupported formatVersion. Re-render with the same Pulse version as the web image.`,
  structure: `Estate bundle model at ${MODEL_PATH} has malformed field 'estate' (expected an object). Run 'pulse render'; do not hand-edit rendered artifacts.`,
  incoherent: `Estate bundle model at ${MODEL_PATH} belongs to a different render generation. Run 'pulse render' and mount the rendered tree as one unit.`,
};

/** Every bundle failure kind, in the order the wire type lists them. */
export const BUNDLE_ERROR_KINDS = Object.freeze(
  Object.keys(BUNDLE_ERROR_MESSAGES) as BundleErrorKind[],
) as readonly BundleErrorKind[];

/** The 503 body the router serves in bundle-error mode for a failure of `kind`, as a fixture body. */
export function bundleErrorBody(kind: BundleErrorKind): Promise<unknown> {
  const error = new EstateBundleError(kind, "model", MODEL_PATH, BUNDLE_ERROR_MESSAGES[kind]);
  return responseBody(Response.json(overviewErrorBody(error), { status: 503 }), 503);
}

/**
 * Restore the process globals a real handler call can touch: the write-path provider and the metrics
 * registry (the session handler counts a handshake). The generator calls this in a `finally` block.
 */
export function resetHandlerGlobals(): void {
  resetWritePathProvider();
  __resetMetricsForTest();
  __resetCapabilityProvidersForTest();
}

// ---------------------------------------------------------------------------------------------------------------
// Push stub runtime
// ---------------------------------------------------------------------------------------------------------------

/** Options for one stub runtime. */
export interface StubPushOptions {
  /** Default "configured". "misconfigured" yields 503 PUSH_UNAVAILABLE on every contract route. */
  readonly state?: "configured" | "misconfigured";
  /** Paired-device cap. Default PUSH_LIMITS.defaultMaxDevices (20). */
  readonly maxDevices?: number;
}

/** A push runtime the fixture builders drive through its dispatcher. */
export interface StubPushRuntime {
  /** The underlying runtime. */
  readonly runtime: PushRuntime;
  /** Dispatch one request and return the push response. Throws SCENARIO_INVALID if the dispatcher returned null. */
  send(method: StubRequestInit["method"], path: string, init?: Omit<StubRequestInit, "method">): Promise<Response>;
  /**
   * Issue a pairing token through `POST /api/push/admin/pairing-tokens` with the stub operator secret, and return the
   * token parsed from the `pair` parameter of the returned link.
   */
  issueToken(): Promise<string>;
  /** Issue, redeem with `displayName`, and return the redeem response body. */
  pair(displayName?: string): Promise<PairingRedeemResponse>;
  /** `runtime.close()` (unregisters the capability), then remove the scratch directory. Idempotent. */
  close(): Promise<void>;
}

/** Fixed clock at FIXED_EPOCH_MS (2026-01-01T00:00:00Z). */
export const FIXTURE_CLOCK: Clock = Object.freeze({ nowMs: (): number => FIXED_EPOCH_MS });

/**
 * Deterministic RandomSource. Call k (0-based) of bytes(n) returns n bytes, all zero except the last, which is
 * k % 256. So the first token drawn is `AAAAAAAAAAAAAAAAAAAAAA`. unit() always returns 0.5.
 * A fresh source is created per stub runtime.
 */
export function createFixtureRandom(): RandomSource {
  let calls = 0;
  return {
    bytes(n: number): Uint8Array {
      const out = new Uint8Array(n);
      if (n > 0) out[n - 1] = calls % 256;
      calls += 1;
      return out;
    },
    unit: (): number => 0.5,
  };
}

/** Timers that never fire: no sweep, no soft flush, no retry. The store's close still flushes soft fields. */
export const INERT_TIMERS: Timers = Object.freeze({
  setTimeout: (): unknown => null,
  clearTimeout: (): void => {},
  setInterval: (): unknown => null,
  clearInterval: (): void => {},
});

/** The stub operator secret (public-safe, 40 bytes). Never a real secret. */
export const STUB_OPERATOR_SECRET = "example-operator-secret-not-a-real-value";

/** A syntactically valid pairing-redeem response, or a SCENARIO_INVALID throw. */
function redeemBody(value: unknown, subject: string): PairingRedeemResponse {
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { deviceId?: unknown }).deviceId === "string" &&
    typeof (value as { credential?: unknown }).credential === "string"
  ) {
    return value as PairingRedeemResponse;
  }
  throw new ContractToolError("SCENARIO_INVALID", subject, "the redeem response is not a PairingRedeemResponse");
}

/**
 * A push runtime for fixture generation: fixed clock, seeded randomness, inert timers, no APNs traffic, and a
 * configured (or misconfigured) state, all public-safe.
 *
 * @throws {ContractToolError} SCENARIO_INVALID when buildPushRuntime does not report the requested state
 */
export async function createStubPushRuntime(options: StubPushOptions = {}): Promise<StubPushRuntime> {
  const state = options.state ?? "configured";
  const dataDir = state === "configured" ? mkdtempSync(join(tmpdir(), "pulse-contract-push-")) : null;
  const removeDir = (): void => {
    if (dataDir !== null) rmSync(dataDir, { recursive: true, force: true });
  };

  let push: ServerConfig["push"];
  if (dataDir !== null) {
    const operator = loadPushSecret({ X: STUB_OPERATOR_SECRET }, "X");
    if (!operator.ok) {
      removeDir();
      throw new ContractToolError("SCENARIO_INVALID", "push-stub", "the stub operator secret is unusable");
    }
    push = {
      state: "configured",
      apns: {
        key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey,
        keyId: "ABCDE12345",
        teamId: "FGHIJ67890",
        topic: "com.example.pulse",
      },
      dataDir,
      maxDevices: options.maxDevices ?? PUSH_LIMITS.defaultMaxDevices,
      webhook: "off",
      admin: "on",
      webhookSecret: null,
      operatorSecret: operator.secret,
      warnings: [],
    };
  } else {
    push = { state: "misconfigured", reasons: [{ envVar: "PULSE_PUSH_APNS_KEY_FILE", reason: "unreadable" }] };
  }

  const config = guarded<ServerConfig>("config", {
    push,
    identity: Object.freeze({ mode: "none" }),
    externalUrl: Object.freeze({ state: "unset" }),
  });
  const deps: PushBootstrapDeps = {
    clock: FIXTURE_CLOCK,
    random: createFixtureRandom(),
    timers: INERT_TIMERS,
    apns: { origins: { sandbox: "https://apns.invalid", production: "https://apns.invalid" } },
  };

  let runtime: PushRuntime;
  try {
    runtime = await buildPushRuntime(config, deps);
  } catch (error) {
    removeDir();
    throw error;
  }

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await runtime.close();
      } finally {
        removeDir();
      }
    })();
    return closing;
  };

  if (runtime.state !== state) {
    await close();
    throw new ContractToolError("SCENARIO_INVALID", "push-stub", `the stub runtime is ${runtime.state}, not ${state}`);
  }

  const send = async (
    method: StubRequestInit["method"],
    path: string,
    init: Omit<StubRequestInit, "method"> = {},
  ): Promise<Response> => {
    const rr = stubRouteRequest(path, { ...init, ...(method !== undefined ? { method } : {}) });
    const res = await runtime.dispatcher({ request: rr.request, pathname: path, peerIp: null });
    if (res === null) {
      throw new ContractToolError("SCENARIO_INVALID", `${method ?? "GET"} ${path}`, "the push dispatcher did not handle the request");
    }
    return res;
  };

  const issueToken = async (): Promise<string> => {
    const res = await send("POST", PUSH_PATHS.adminPairingTokens, {
      headers: { authorization: `Bearer ${STUB_OPERATOR_SECRET}` },
      body: { baseUrl: PLACEHOLDER.baseUrl },
    });
    const issued = await responseBody(res, 201);
    const link = typeof issued === "object" && issued !== null ? (issued as { link?: unknown }).link : undefined;
    if (typeof link !== "string") {
      throw new ContractToolError("SCENARIO_INVALID", "push-stub", "the issue response carries no link");
    }
    const token = new URL(link).searchParams.get(PAIR_LINK_PARAM);
    if (token === null) throw new ContractToolError("SCENARIO_INVALID", "push-stub", "the issued link carries no pairing token");
    return token;
  };

  const pair = async (displayName: string = DISPLAY_NAME_PLACEHOLDER): Promise<PairingRedeemResponse> => {
    const token = await issueToken();
    const res = await send("POST", PUSH_PATHS.redeem, { body: { token, displayName } });
    return redeemBody(await responseBody(res, 201), "push-stub");
  };

  return Object.freeze({ runtime, send, issueToken, pair, close });
}

