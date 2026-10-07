// src/server/routes/healthz.ts — GET /healthz (REQ-OBS-01).
//
// Returns 200 whenever the process can respond, with the machine-readable HealthBody. The
// compose healthcheck asserts HTTP 200 (process liveness). `status` is `degraded` when any source is
// unreachable OR the model is not loaded. Reads `getRuntimeStatus()` (the operational singleton),
// NOT `ctx.snapshot`, so per-source reachability is reportable before the first snapshot exists.
// M2: the body always carries `writePath` (per-capability status); it
// never changes the top-level `status`.

import type { RouteDefinition, RouteRequest, ServerContext } from "../../shared/registry.js";
import type { HealthBody } from "../../shared/snapshot.js";
import { getRuntimeStatus } from "../refresh.js"; // operational status singleton (§6)
import { WEB_APP_VERSION } from "../../version.js"; // generated stamp
import { currentHealthWritePath } from "../mutations/session-provider.js";

/**
 * `GET /healthz` — the `HealthBody`. Always `200` when the process can respond.
 * `status: "degraded"` when any `SourceHealth.ok === false` OR the model is not loaded. The AI
 * operator agent reads the body for per-source diagnosis (PRD §2).
 * @returns `200` with the `HealthBody`.
 */
export const healthzRoute: RouteDefinition = {
  method: "GET",
  path: "/healthz",
  handler(_req: RouteRequest, ctx: ServerContext): Response {
    const s = getRuntimeStatus();
    const sourcesOk = s.sources.metrics.ok && s.sources.alerts.ok && s.sources.checks.ok;
    const body: HealthBody = {
      status: sourcesOk && s.model.loaded ? "ok" : "degraded",
      version: WEB_APP_VERSION,
      estateModel: {
        loaded: s.model.loaded,
        formatVersion: s.model.formatVersion,
        error: s.model.error?.message ?? null,
      },
      sources: s.sources,
      // Defensive read: direct-dispatch tests pass `{} as ServerContext` (status.test.ts:86).
      writePath: currentHealthWritePath(ctx?.config?.identity?.mode),
    };
    return Response.json(body, { status: 200 });
  },
};
