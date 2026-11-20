// A minimal server context for calling the real route handlers from the fixture generator, plus the
// helpers that turn a handler's `Response` into a fixture body.

import { __resetCapabilityProvidersForTest } from "@pulse/web-data/contract";
import { canonicalJson } from "@pulse/web-data/cycle";
import type { AuthMode, Identity } from "@pulse/web-data/identity";
import type { ApiErrorCode, BundleErrorKind } from "@pulse/web-data/wire";

import { resetWritePathProvider } from "../../src/server/mutations/session-provider.js";
import { __resetMetricsForTest } from "../../src/server/routes/metrics.js";
import { overviewErrorBody } from "../../src/server/routes/overview.js";
import { errorFor } from "../../src/server/routes/respond.js";
import { EstateBundleError } from "../../src/shared/errors.js";
import type { RouteParams, RouteRequest, ServerContext } from "../../src/shared/registry.js";
import { ContractToolError } from "./errors.js";
import { PLACEHOLDER } from "./scenarios/common.js";

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

/** `RouteRequest` for `path` on the placeholder base URL: no path parameters, no peer address. */
export function stubRouteRequest<P extends string>(
  path: P,
  headers: Readonly<Record<string, string>> = {},
): RouteRequest<P> {
  return {
    request: new Request(PLACEHOLDER.baseUrl + path, { method: "GET", headers }),
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
