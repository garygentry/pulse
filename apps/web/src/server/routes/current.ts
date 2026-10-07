// src/server/routes/current.ts — the cycle-backed current-view routes (05 §7): GET /api/alerts,
// /api/estate, /api/engine, /api/timeline.
//
// Each captures ITS materialized payload and the observation from ONE cycle reference
// (`ctx.cycle`) and serves it through the shared `cycleJsonResponse` helper (retained plain/gzip
// bytes, distinct strong ETags, bodyless 304, observation/payload-id headers). Before the first
// cycle is published (`ctx.cycle === null`, item 039) they return the exact 503 `NOT_READY`.
// Bundle-error mode is short-circuited by the router BEFORE these handlers run (§7) — no stale
// cycle is ever served. `/api/overview` migrates to the same path in `overview.ts` (it retains a
// transitional legacy-snapshot fallback until a cycle is published).

import type { MaterializedPayload } from "@pulse/web-data/cycle";
import type { CycleState } from "@pulse/web-data/cycle";

import { defineRoute, type RouteDefinition } from "../../shared/registry.js";
import { cycleJsonResponse } from "../../shared/api/json.js";
import { notReadyResponse } from "./respond.js";

/** Pick one current view's retained materialized payload from a captured cycle. */
type CyclePayloadSelector = (cycle: CycleState) => MaterializedPayload<unknown>;

/** Build a cycle-backed current-view route: NOT_READY before readiness, else the retained bytes. */
function currentRoute<P extends string>(path: P, select: CyclePayloadSelector): RouteDefinition<P> {
  return defineRoute<P>({
    method: "GET",
    path,
    handler(request, ctx) {
      const cycle = ctx.cycle ?? null; // capture the cycle once from the same context (§7 step 1)
      if (cycle === null) return notReadyResponse();
      return cycleJsonResponse({ request: request.request, cycle, payload: select(cycle) });
    },
  });
}

/** `GET /api/alerts` — the current alerts representation (05 §7). */
export const alertsRoute = currentRoute("/api/alerts", (cycle) => cycle.alerts);
/** `GET /api/estate` — the current estate representation (05 §7). */
export const estateRoute = currentRoute("/api/estate", (cycle) => cycle.estate);
/** `GET /api/engine` — the current engine representation (05 §7). */
export const engineRoute = currentRoute("/api/engine", (cycle) => cycle.engine);
/** `GET /api/timeline` — the current timeline representation (05 §7). */
export const timelineRoute = currentRoute("/api/timeline", (cycle) => cycle.timeline);
