// src/server/routes/registry.ts — the ROUTES array (the complete M1 registry, §6).
//
// The server half of the two-sided extension skeleton (RouteDefinition/ServerContext live in
// src/shared/registry.ts). Every entry's `method` is the literal `"GET"`, so the read-only surface
// (REQ-SEC-02) is enforced by the seam's type, not by review: a mutating route cannot be
// registered. All 13 M1 read routes are registered NOW so wave-3 views never edit shared server
// files (§6); the cycle/session/history/events handlers now have real modules
// (`current.ts`/`session.ts`/`history.ts`/`events.ts`). Patterns are compiled and
// whole-set-validated at load (`assertRegistry`), so a
// malformed / duplicate / ambiguous pattern fails startup before any port bind (§10).

import type { RouteDefinition } from "../../shared/registry.js";
import { overviewRoute } from "./overview.js";
import { healthzRoute } from "./healthz.js";
import { metricsRoute } from "./metrics.js";
import { sessionRoute } from "./session.js";
import { alertsRoute, estateRoute, engineRoute, timelineRoute } from "./current.js";
import { eventsRoute } from "./events.js";
import {
  historyEstateRoute,
  historyTargetRoute,
  historyAlertsRoute,
  historyChecksRoute,
} from "./history.js";
import { proposalsRoute } from "./proposals.js";
import { assertRegistry } from "./compile.js";

/** The complete M1 read registry (§6): the two operational endpoints, the five current-view routes,
 *  session, events, and the four bounded-history routes — all GET-only. Later views/items replace
 *  their placeholder entries here (REQ-EXT-01). */
export const ROUTES: readonly RouteDefinition[] = [
  healthzRoute,
  metricsRoute,
  overviewRoute,
  alertsRoute,
  estateRoute,
  engineRoute,
  timelineRoute,
  sessionRoute,
  eventsRoute,
  historyEstateRoute,
  historyTargetRoute,
  historyAlertsRoute,
  historyChecksRoute,
  proposalsRoute, // M2: estate-edit proposal list (GET-only; RouteDefinition.method stays "GET")
];

// Fail startup on any malformed / duplicate / ambiguous pattern before a port is bound (§10).
assertRegistry(ROUTES);
