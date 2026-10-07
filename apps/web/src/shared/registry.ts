// src/shared/registry.ts — the two-sided extension-skeleton seam types (REQ-EXT-01/02/03).
// Server half + client half; compiled into BOTH bundles. The ROUTES array lives
// in src/server/routes/registry.ts; the VIEWS array in src/client/views/registry.ts.
//
// Server half is `ServerContext` v2 (05-http-routes-and-representations.md §§2–3): typed
// compiled GET routes with decode-once path params, the per-request `RouteRequest`, the
// readonly `SourceClients` bundle, the captured immutable cycle, the bounded history
// service, and the per-request resolved identity. All of these are private app seams — no
// symbol here is added to a package export. The pattern compiler / negotiation internals
// live in `../server/router.ts`. Client-half view seams are unchanged.

import type { ComponentType } from "react";

import type { CycleState } from "@pulse/web-data/cycle";
import type { HistoryService } from "@pulse/web-data/history";
import type { Identity } from "@pulse/web-data/identity";
import type { EventStreamRegistry } from "../server/events/registry.js";
import type {
  VmClient,
  AlertmanagerClient,
  VmalertClient,
  GatusClient,
  GrafanaClient,
} from "@pulse/web-data/sources";

import type { OverviewSnapshot } from "./snapshot.js";
import type { PathRouter } from "../client/router.js";
import type { AppStore } from "../client/store/index.js";
import type { ServerConfig } from "../server/config.js";
import type { EstateBundle } from "../server/estate/load.js";

// ── Typed compiled GET routes (§2) ────────────────────────────────────────────────────────────────

/** The parameter name captured by one `:name` segment (empty for a static segment). */
type SegmentParam<S extends string> = S extends `:${infer Name}` ? Name : never;
/** The union of every `:name` parameter captured across a slash-separated path pattern. */
type PathParamNames<P extends string> = P extends `${infer H}/${infer T}`
  ? SegmentParam<H> | PathParamNames<T>
  : SegmentParam<P>;
/** The decoded string map a handler receives for one route pattern's captured parameters. */
export type RouteParams<P extends string> = { readonly [N in PathParamNames<P>]: string };

/** Everything a route handler is handed for one request: the raw `Request`, the decoded (once)
 *  bounded path parameters, the declared template (never a raw path — the low-cardinality metric
 *  label), the direct-peer IP, and the SSE-only timeout escape. */
export interface RouteRequest<Path extends string = string> {
  /** The incoming request. Handlers never read its body — the surface is GET-only. */
  readonly request: Request;
  /** Decoded, validated path parameters for this route pattern. */
  readonly params: Readonly<RouteParams<Path>>;
  /** The route's declared pattern — the stable metric label (§10), never the raw path. */
  readonly routePattern: Path;
  /** Direct connecting peer IP, or `null` when unavailable (used only for trusted-proxy checks). */
  readonly peerIp: string | null;
  /** Disable the per-request server timeout. Only `/api/events` calls this (§9). */
  disableTimeout(): void;
}

// ── Server context v2 (§3) ────────────────────────────────────────────────────────────────────────

/** A readonly app-facing bundle of the five typed engine clients — the ONLY handles that reach an
 *  engine URL (03). `grafana` is `null` when `PULSE_GRAFANA_URL` is not configured. */
export interface SourceClients {
  /** VictoriaMetrics reads. */ readonly vm: VmClient;
  /** Alertmanager read/write surface; M1 routes use reads only. */ readonly alertmanager: AlertmanagerClient;
  /** vmalert rule reads. */ readonly vmalert: VmalertClient;
  /** Gatus status/history reads. */ readonly gatus: GatusClient;
  /** Grafana health, or null when not configured. */ readonly grafana: GrafanaClient | null;
}

/** Everything a route handler is handed — the charter-A8 internal exposure. A route NEVER
 *  constructs an engine URL or re-reads the model file; it reads from the context. Captured once
 *  per request and shallow-frozen; identity never enters runtime-global state (§3). */
export interface ServerContext {
  /** Complete validated bundle authority, or `null` in bundle-error mode (REQ-MODEL-03). */
  readonly estate: EstateBundle | null;
  /** Captured immutable current cycle, or `null` before readiness (populated by item 039). */
  readonly cycle: CycleState | null;
  /** Process-local bounded history service. */
  readonly history: HistoryService;
  /** Process-lifetime SSE stream registry — the only route that reads it is `/api/events` (§3). */
  readonly events: EventStreamRegistry;
  /** Configured source access (the readonly five-client bundle). */
  readonly sources: SourceClients;
  /** Validated immutable server configuration. */
  readonly config: ServerConfig;
  /** Identity resolved for only this request. */
  readonly identity: Identity | null;
  /** Transitional: the latest legacy overview snapshot (`null` before the first refresh). The
   *  current-view routes migrate to `cycle` in item 036; `/api/overview` still reads this until
   *  then, so it is retained additively rather than removed. */
  readonly snapshot: OverviewSnapshot | null;
}

/** One server route. `method` is the literal `"GET"` — the read-only surface (REQ-SEC-02) is
 *  enforced by the seam's type, not by review; a mutating route cannot be registered. The handler
 *  receives the compiled `RouteRequest` (decoded params, peer, timeout escape) and the context. */
export interface RouteDefinition<Path extends string = string> {
  readonly method: "GET";
  /** Exact pattern, e.g. `"/api/overview"` or `"/api/history/estate/:queryId"`. */
  readonly path: Path;
  /** Parameter names (each a `:param` of `path`) whose decoded value may contain `/` — sent
   *  percent-encoded as `%2F` (amendment 12 §1). The slash rule is replaced by structural checks
   *  (no leading/trailing `/`, no `//`, no `.`/`..` piece, no `\`); every other bound still applies.
   *  Absent means no parameter of the route may carry a slash. */
  readonly slashParams?: readonly string[];
  // Method syntax (bivariant params) so a `RouteDefinition<"/api/history/estate/:queryId">` with a
  // param-typed handler is still assignable into the shared `RouteDefinition[]` registry.
  handler(request: RouteRequest<Path>, context: ServerContext): Response | Promise<Response>;
}

/** Identity helper preserving the literal path type so `RouteParams` is inferred (§2). */
export function defineRoute<const P extends string>(route: RouteDefinition<P>): RouteDefinition<P> {
  return route;
}

/** Nav placement (REQ-VIEW-01). */
export interface ViewNav {
  /** Ascending sort key in the shell nav. */
  order: number;
  /** Whether the view participates in kiosk rotation (consumed by `design-system-shell`). */
  kiosk?: boolean;
}

/** Readonly shell-owned kiosk rotation context exposed to the active view. */
export interface ViewRotationContext {
  /** Active rotation entry. */
  readonly entry: { readonly viewId: string; readonly dwellMs: number };
  /** Zero-based position in the validated rotation. */
  readonly index: number;
  /** Number of validated entries. */
  readonly total: number;
  /** Monotonic shell-owned epoch incremented on each rotation advance. */
  readonly epoch: number;
}

/** Everything a client view component is handed — the client-side internal exposure. */
export interface ViewProps {
  store: AppStore;
  router: PathRouter;
  /** Present only while this view participates in an active kiosk rotation. */
  rotation?: ViewRotationContext | null;
}

/** One client view, v2 (REQ-VIEW-01). Adding a view = one module (`views/<id>/view.tsx`) + one
 *  registry line (REQ-VIEW-02). */
export interface ViewDefinition {
  /** Also the view's primary path segment: `/<id>`. */
  id: string;
  /** Nav label. */
  label: string;
  /** Icon name from the icon library; typed by `design-system-shell`. */
  icon?: string;
  /** Lazily loads the view component — its own chunk (REQ-BUILD-01). */
  load: () => Promise<ComponentType<ViewProps>>;
  nav?: ViewNav;
  /** Extra path patterns owned by this view. */
  routes?: readonly string[];
}
