// src/server/router.ts — compiled GET-route dispatch over the M1 registry + static assets (05).
//
// `createFetchHandler` returns the `fetch` callback `Bun.serve` invokes per request. It resolves one
// per-request identity (deny-by-default trusted-proxy resolution; 09 §§3–4) into a captured
// `ServerContext`, matches the compiled routes, and records the declared template metric label. Every path is GET-only
// (REQ-SEC-02); a non-GET request calls the named no-op `dispatchMutation` seam then returns the
// shared JSON 405 — no body is read, no write/audit API is imported. Unknown `/api/*` returns the
// shared JSON 404 (never an accidental SPA shell); non-API GET keeps the SPA/asset/error-shell
// behavior. A top-level catch maps an unexpected handler exception to a safe `INTERNAL_ERROR`.

import { resolveIdentity, type Identity } from "@pulse/web-data/identity";

import type { ServerRuntime } from "./refresh.js";
import type { RouteRequest } from "../shared/registry.js";
import { ROUTES } from "./routes/registry.js";
import { matchRoutes, validateQuery } from "./routes/compile.js";
import { errorFor } from "./routes/respond.js";
import { recordHttpRequest } from "./routes/metrics.js";
import { overviewErrorBody } from "./routes/overview.js";
import { ERROR_PAGE_CSP, renderErrorPage } from "./estate/error-page.js"; // error-page HTML (§4.4)
import { loadStaticAssets, type StaticAssets } from "./assets.js"; // dist/client loader (01 build)
import { log } from "./log.js";
import {
  newCspNonce,
  shellContentSecurityPolicy,
  withCspNonceMeta,
  withSecurityHeaders,
} from "./security-headers.js";

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

/** JSON `Response` with a status (the small helper the bundle-error path shares). */
function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/** The raw query string of a request, or `""` when the request has no parseable URL (a synthetic
 *  direct-dispatch request in a unit test). */
function safeSearch(req: Request): string {
  try {
    return new URL(req.url).search;
  } catch {
    return "";
  }
}

// ── Bun request services (§4) ──────────────────────────────────────────────────────────────────

/** The per-request Bun services the fetch handler threads into each route request. */
export interface RequestServices {
  /** Direct connecting peer IP, or `null` when unavailable. */
  readonly peerIp: string | null;
  /** Disable the per-request server timeout (only `/api/events` calls this; §9). */
  disableTimeout(): void;
}

/** The default services for direct tests / omitted production wiring: no peer, no timeout escape. */
const DEFAULT_SERVICES: RequestServices = { peerIp: null, disableTimeout() {} };

/** Build the compiled `RouteRequest` a handler receives (decoded params + peer + timeout escape). */
function buildRouteRequest(
  request: Request,
  routePattern: string,
  params: Readonly<Record<string, string>>,
  services: RequestServices,
): RouteRequest {
  return {
    request,
    params,
    routePattern,
    peerIp: services.peerIp,
    disableTimeout() {
      services.disableTimeout();
    },
  };
}

// ── Mutation seam (§5) ─────────────────────────────────────────────────────────────────────────

/** The bounded, safe context handed to the mutation seam for a non-GET request. */
export interface MutationDispatchContext {
  readonly request: Request;
  readonly pathname: string;
  readonly peerIp: string | null;
}
/** A mutation dispatcher: returns a `Response` to short-circuit, or `null` to fall to JSON 405. */
export type MutationDispatcher = (context: MutationDispatchContext) => Promise<Response | null>;

/**
 * The named no-op mutation seam (§5). It reads NO request body and imports NO write/audit API; it
 * always returns `null` so a non-GET request falls through to the shared JSON 405. M2 replaces this
 * with a real dispatcher; the M1 default never mutates state.
 */
export async function dispatchMutation(_context: MutationDispatchContext): Promise<Response | null> {
  return null;
}

// ── Metric label (§10) ───────────────────────────────────────────────────────────────────────

/**
 * Map a request pathname to a stable, low-cardinality metric label (§10): the matched route's
 * declared template, or one of `static` / `api-notfound` / `spa`. Never the raw request path (which
 * would explode label cardinality under kiosk-scale polling of unknown routes).
 */
function labelFor(pathname: string): string {
  const match = matchRoutes(ROUTES, pathname);
  if (match.kind === "match" || match.kind === "invalid") return match.route.path;
  if (pathname.startsWith("/assets/")) return "static";
  if (pathname.startsWith("/api/")) return "api-notfound";
  return "spa";
}

/**
 * Build the `Bun.serve` fetch handler.
 *
 * @param runtime - The shared runtime (context projection + operational status; §2).
 * @param assets - The loaded static client bundle (default: loaded from `dist/client`).
 * @param mutationDispatcher - The mutation seam for non-GET requests (default: the M1 no-op
 *   `dispatchMutation`). This is the injection point M2 registers against from `server/index.ts`, so
 *   the write path plugs in without editing this file; the GET route registry stays GET-only.
 * @returns The `(request, services?) => Promise<Response>` handler passed to `Bun.serve`.
 */
export function createFetchHandler(
  runtime: ServerRuntime,
  assets: StaticAssets = loadStaticAssets(),
  mutationDispatcher: MutationDispatcher = dispatchMutation,
): (request: Request, services?: RequestServices) => Promise<Response> {
  return async (request: Request, services: RequestServices = DEFAULT_SERVICES): Promise<Response> => {
    const { pathname } = new URL(request.url);
    const routeLabel = labelFor(pathname); // stable low-cardinality label for the metric (§10)
    let status = 200;
    // Every response leaves with the security headers for its type (security-headers.ts): the base
    // set everywhere, plus CSP/COOP/Permissions-Policy on HTML documents.
    // A document without its own policy gets the shell policy minus the style nonce (computed only
    // if such a response occurs; the shell and the error page both carry their own).
    const shellCsp = (): string => shellContentSecurityPolicy(assets.inlineScriptHashes?.() ?? []);
    try {
      const res = await dispatch(request, pathname, runtime, assets, services, mutationDispatcher);
      status = res.status;
      return withSecurityHeaders(res, shellCsp);
    } catch (err) {
      // Top-level catch — an unexpected handler exception is a safe INTERNAL_ERROR + a structured
      // log; a route error NEVER kills the process. Model/source failure modes are handled below the
      // throw as normal, non-exceptional paths.
      status = 500;
      log({ event: "request_error", ok: false, route: routeLabel, error: (err as Error).message });
      return withSecurityHeaders(errorFor("INTERNAL_ERROR", 500), shellCsp);
    } finally {
      recordHttpRequest(routeLabel, status); // pulse_web_http_requests_total{route,status} (§10)
    }
  };
}

/**
 * The pure dispatch (exported for router unit tests — no port binding, prober idiom). Dispatch order
 * per §5: non-GET → mutation seam → JSON 405; then GET bundle-error handling; compiled route match;
 * `/assets/*`; unknown `/api/*` → JSON 404; otherwise the SPA shell.
 */
export async function dispatch(
  req: Request,
  pathname: string,
  runtime: ServerRuntime,
  assets: StaticAssets,
  services: RequestServices = DEFAULT_SERVICES,
  mutationDispatcher: MutationDispatcher = dispatchMutation,
): Promise<Response> {
  // (1) Non-GET → the named no-op mutation seam, then the shared JSON 405 (§5). The M1 seam never
  //     returns a response, reads no body, and imports no write/audit API (REQ-SEC-02).
  if (req.method !== "GET") {
    const mutated = await mutationDispatcher({ request: req, pathname, peerIp: services.peerIp });
    if (mutated !== null) return mutated;
    return errorFor("METHOD_NOT_ALLOWED", 405);
  }

  // Resolve one per-request identity from the direct peer, request headers, and the validated
  // IdentityConfig, then capture it into a shallow-frozen context (05 §4, 09 §§3–4). Resolution is
  // deny-by-default and pure: it returns null unless proxy-header mode trusts the peer's CIDR and the
  // configured header carries one bounded control-free value; a raw peer/header value never leaks.
  // Identity is passed ONLY through the captured context and never stored in runtime-global state.
  const identity: Identity | null = resolveIdentity(req, services.peerIp, runtime.identityConfig);
  const ctx = runtime.getContext(identity);
  const modelError = runtime.getStatus().model.error;

  // (2) Bundle-error mode (§7): operational routes and session/events stay live; every estate/cycle
  //     -backed API returns the safe bundle 503 (no stale cycle); non-API GET returns the error-page
  //     HTML; `/assets/*` falls through to normal serving.
  if (modelError !== null) {
    if (pathname === "/healthz" || pathname === "/metrics") {
      const match = matchRoutes(ROUTES, pathname);
      if (match.kind === "match") {
        return match.route.handler(buildRouteRequest(req, match.route.path, match.params, services), ctx);
      }
    } else if (pathname.startsWith("/api/")) {
      if (pathname !== "/api/session" && pathname !== "/api/events") {
        return json(overviewErrorBody(modelError), 503); // existing safe bundle code/message (§7)
      }
      // session/events fall through to the normal match below (they respond without a cycle).
    } else if (!pathname.startsWith("/assets/")) {
      return new Response(renderErrorPage(modelError), {
        status: 200,
        headers: { ...HTML_HEADERS, "content-security-policy": ERROR_PAGE_CSP },
      });
    }
    // `/assets/*` (and session/events) fall through.
  }

  // (3) Match the compiled GET routes.
  const match = matchRoutes(ROUTES, pathname);
  if (match.kind === "invalid") {
    // Shape matched but a path parameter was malformed/out-of-bounds → 400 (never history/upstream).
    return errorFor("INVALID_REQUEST", 400);
  }
  if (match.kind === "match") {
    // Bounded query guard (§2): raw length ≤ 2 KiB, no repeated key. Per-key allowlists are enforced
    // by the individual handlers (history allows only `range`; item 038). `req.url` is defensively
    // parsed so a synthetic direct-dispatch request without a URL still routes.
    const query = validateQuery(safeSearch(req));
    if (!query.ok) return errorFor("INVALID_REQUEST", 400);
    return match.route.handler(buildRouteRequest(req, match.route.path, match.params, services), ctx);
  }

  // (4) Static assets — immutable-cacheable, content-hashed names.
  if (pathname.startsWith("/assets/")) {
    const asset = assets.get(pathname);
    if (asset === undefined) return new Response("not found", { status: 404 });
    return new Response(asset.body, {
      headers: {
        "content-type": asset.contentType,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  // (5) Unknown `/api/*` → shared JSON 404 (never an accidental SPA shell; §5/§6).
  if (pathname.startsWith("/api/")) return errorFor("API_NOT_FOUND", 404);

  // (6) SPA shell fallback — any other GET path returns index.html (hash-routed client; 06). Each
  //     response carries a fresh CSP style nonce, in its policy and in the shell's nonce meta, so
  //     the shell is never stored (`no-store`) and a nonce is never replayed from a cache.
  //     The shell and its hashes come from one loader snapshot (never a pair split by a rebuild).
  const doc = assets.shellDocument?.() ?? { html: assets.shell(), scriptHashes: assets.inlineScriptHashes?.() ?? [] };
  const nonce = newCspNonce();
  return new Response(withCspNonceMeta(doc.html, nonce), {
    headers: {
      ...HTML_HEADERS,
      "cache-control": "no-store",
      "content-security-policy": shellContentSecurityPolicy(doc.scriptHashes, nonce),
    },
  });
}
