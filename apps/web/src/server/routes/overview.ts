// src/server/routes/overview.ts — GET /api/overview.
//
// Serves the current overview representation. As of item 036 it reads the captured cycle's
// materialized overview payload through the shared `cycleJsonResponse` helper (retained plain/gzip
// bytes, distinct strong ETags, bodyless 304, observation/payload-id headers — 05 §7). Until a cycle
// is published (item 039) it falls back to the transitional legacy `ctx.snapshot` (200) so the live
// container / smoke path keeps serving the grid; that fallback is removed when item 048 migrates the
// shell/store to the cycle. Before either exists it returns 503 `NOT_READY`. It accepts no
// query/expression (no passthrough, REQ-SEC-02). Bundle-error mode is short-circuited by the router
// BEFORE this handler runs (§4.4 / §7) — no stale cycle/snapshot is served.

import type { RouteDefinition, ServerContext } from "../../shared/registry.js";
import type { EstateBundleError } from "../../shared/errors.js";
import { cycleJsonResponse } from "../../shared/api/json.js";
import { notReadyResponse } from "./respond.js";

/** Structured 503 body served on `/api/overview` in error-page mode (REQ-MODEL-03). */
export interface OverviewErrorBody {
  /** Stable machine code from the `EstateBundleError` (`ESTATE_BUNDLE_*`). */
  code: string;
  /** The failure kind (`missing` | `unreadable` | `unparseable` | `version` | `structure` | `incoherent`). */
  kind: EstateBundleError["kind"];
  /** The in-container member path named in the message (agent-actionable). */
  path: string;
  /** The full agent-actionable message (file, problem, fix path). */
  message: string;
}

/** Project an `EstateBundleError` into the structured 503 body served in error-page mode (§4.4). */
export function overviewErrorBody(error: EstateBundleError): OverviewErrorBody {
  return { code: error.code, kind: error.kind, path: error.path, message: error.message };
}

/**
 * `GET /api/overview` — the current overview representation.
 *
 * - Cycle published (`ctx.cycle` present): the retained materialized overview payload via
 *   `cycleJsonResponse` (plain/gzip negotiation, strong ETags, 304, observation headers; §7).
 * - Transitional (no cycle yet, model OK, legacy snapshot present): `200` with `ctx.snapshot` so the
 *   live grid keeps serving until item 039 publishes cycles / item 048 migrates the shell.
 * - Neither available (model OK, nothing built yet): `503` `NOT_READY`.
 * - Error-page mode is short-circuited by the router BEFORE this handler runs (§4.4 / §7).
 *
 * @param request - The compiled route request (only `Accept-Encoding`/`If-None-Match` are read on the
 *   cycle path; no query is honoured; REQ-SEC-02).
 * @param ctx - The current server context; reads `ctx.cycle` then the transitional `ctx.snapshot`.
 */
export const overviewRoute: RouteDefinition = {
  method: "GET",
  path: "/api/overview",
  handler(request, ctx: ServerContext): Response {
    const cycle = ctx.cycle ?? null;
    if (cycle !== null) {
      return cycleJsonResponse({ request: request.request, cycle, payload: cycle.overview });
    }
    if (ctx.snapshot !== null) return Response.json(ctx.snapshot, { status: 200 });
    return notReadyResponse();
  },
};
