// src/client/views/engine/scrape-model.ts — scrape target health words and problem-first ordering.
// Pure; nothing here mutates its input.

import type { TargetStatus } from "@pulse/web-data/wire";
import { SCRAPE_HEALTH_STATUS } from "../../status/target-status.js";
import type { ScrapeTarget } from "./model.js"; // ScrapeTarget: /wire does not export the target type

/** Status and word per target health. Out-of-contract values fall back to `unknown`. */
export const TARGET_HEALTH: Readonly<
  Record<ScrapeTarget["health"], { readonly status: TargetStatus; readonly text: string }>
> = {
  up: { status: SCRAPE_HEALTH_STATUS.up, text: "Up" },
  down: { status: SCRAPE_HEALTH_STATUS.down, text: "Down" },
  unknown: { status: SCRAPE_HEALTH_STATUS.unknown, text: "Unknown" },
};

/** Total TARGET_HEALTH lookup: own keys only, so prototype names ("toString") also read unknown. */
export function targetHealth(h: string): { readonly status: TargetStatus; readonly text: string } {
  return Object.prototype.hasOwnProperty.call(TARGET_HEALTH, h)
    ? (TARGET_HEALTH as Readonly<Record<string, { readonly status: TargetStatus; readonly text: string }>>)[h]!
    : TARGET_HEALTH.unknown;
}

/**
 * Targets in problem-first order: down, then unknown (including out-of-contract), then up. The sort
 * is stable within each class (payload order), so failing targets top an expanded job.
 * Pure; does not mutate its input.
 */
export function orderTargets(targets: readonly ScrapeTarget[]): readonly ScrapeTarget[] {
  const rank = (h: string): number => (h === "down" ? 0 : h === "up" ? 2 : 1);
  return targets
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t.health) - rank(b.t.health) || a.i - b.i)
    .map((x) => x.t);
}
