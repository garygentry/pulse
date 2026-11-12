// packages/web-data/src/wire/engine-verdict.ts — the payload-derived engine problems, shared by the
// server's overview engine summary and the client's Engine verdict so the two views can never
// disagree about the engine (F5: Overview said "Engine OK" while Engine said "Degraded"). Pure and
// total: no clock, no I/O, never throws.

import type { EngineComponent, EnginePayload } from "./engine.js";

/** Display names per engine component id. */
export const ENGINE_COMPONENT_LABEL: Readonly<Record<EngineComponent["id"], string>> = {
  victoriametrics: "VictoriaMetrics", vmalert: "vmalert", alertmanager: "Alertmanager",
  gatus: "Gatus", grafana: "Grafana", web: "Pulse web app",
};

/** Most problems an overview engine summary carries (the overview validator's bound). */
export const ENGINE_MAX_PROBLEMS = 16;

const codePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Every problem the engine payload itself shows, in the fixed verdict order: cycle, components,
 * deadman, scrape targets (and target discovery), rule groups, notifications. Governing-source
 * freshness, which needs the cycle observation, is added by the client verdict on top of this.
 *
 * @param engine - The engine view payload.
 * @param options - `discoveryCurrent: false` adds "target discovery not current" (the client knows
 *   it from the cycle observation; the server fold omits it).
 * @returns Operator-facing problem phrases; empty when the payload shows nothing wrong.
 */
export function engineProblems(
  engine: EnginePayload,
  options: { readonly discoveryCurrent?: boolean } = {},
): string[] {
  const out: string[] = [];

  if (engine.cycle.buildFailure !== null) out.push("cycle build failed");
  if (engine.cycle.degraded) out.push("publication cycle degraded");

  for (const c of engine.components) {
    if (c.state === "not-configured") continue;
    const name = ENGINE_COMPONENT_LABEL[c.id] ?? String(c.id);
    if (c.state === "unhealthy") out.push(`${name} unreachable`);
    else if (c.state !== "healthy" || c.availability.state !== "current") out.push(`${name} stale`);
  }

  if (!engine.deadman.configured) out.push("deadman not configured");
  else if (engine.deadman.state !== "healthy") out.push(`deadman ${engine.deadman.state}`);

  let down = 0;
  for (const job of engine.scrapeJobs) for (const t of job.targets) if (t.health !== "up") down += 1;
  if (down > 0) out.push(`${down} scrape targets down`);
  if (options.discoveryCurrent === false) out.push("target discovery not current");

  const failing = engine.ruleGroups.filter((g) => g.health !== "healthy").length;
  if (failing > 0) out.push(`${failing} rule groups failing`);

  const f = engine.notifications.failuresPerSecond;
  if (f !== null) {
    const keys = Object.keys(f)
      .filter((k) => { const v = f[k]; return typeof v === "number" && Number.isFinite(v) && v > 0; })
      .sort(codePoint);
    if (keys.length > 0) out.push(`notifications failing (${keys.join(", ")})`);
  }
  if (engine.notifications.availability.state !== "current") out.push("notification metrics unavailable");

  return out;
}
