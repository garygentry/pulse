// src/client/status/target-status.ts — every domain → TargetStatus decision in one module.
//
// Views keep their own icons, labels and copy; only the choice of status triple lives here, so the
// same domain value always renders as the same status everywhere. Every map is a total Record over
// its closed domain type, so a new domain value without a mapping is a typecheck error.
// Pure: no JSX, no UI-framework import.

import type { ProposalState } from "@pulse/core/proposals";
import type {
  ActiveAlert,
  DeclaredScrapeComparison,
  HealthState,
  RuleState,
  ScrapeJobState,
  StatusInterval,
  TargetStatus,
} from "@pulse/web-data/wire";

import type { ActionState } from "../mutations/StateBadge.js";
import type { HostCoverage } from "../views/estate/inventory-model.js";
import type { Severity as FindingSeverity } from "../views/estate/findings-model.js";
import type { SwimSeverity } from "../views/timeline/swimlane-pack.js";

// ── Health ───────────────────────────────────────────────────────────────────

/** Raw wire health → status. `not-configured` collapses to `unknown`; views that need the nuance
 *  carry it in their label text. */
export const HEALTH_TO_STATUS: Readonly<Record<HealthState, TargetStatus>> = {
  healthy: "ok",
  unhealthy: "critical", // loud, safe choice: no `warning` gradation in HealthState
  unknown: "unknown",
  "not-configured": "unknown",
};

/** Engine name for the health map; the same decision as HEALTH_TO_STATUS. */
export const HEALTH_STATUS: Readonly<Record<HealthState, TargetStatus>> = HEALTH_TO_STATUS;

/** Scrape target health → status. */
export const SCRAPE_HEALTH_STATUS: Readonly<Record<ScrapeJobState["targets"][number]["health"], TargetStatus>> = {
  up: "ok",
  down: "critical",
  unknown: "unknown",
};

// ── Estate ───────────────────────────────────────────────────────────────────

/** Host coverage → status. Gap is a configuration concern → warning; critical stays reserved for
 *  live unhealthy. */
export const COVERAGE_STATUS: Readonly<Record<HostCoverage, TargetStatus>> = {
  covered: "ok",
  gap: "warning",
  suppressed: "suppressed",
  unknown: "unknown",
};

/** Declared-vs-scraped diff outcome → status; `matched` is downgraded when stale by the caller. */
export const DIFF_STATUS: Readonly<Record<DeclaredScrapeComparison["state"], TargetStatus>> = {
  matched: "ok",
  missing: "warning",
  unexpected: "warning",
  unknown: "unknown",
};

/** Loader/renderer finding severity → status token. Narrowed so the findings presentation can name
 *  only the triples it uses. */
export const FINDING_SEVERITY_STATUS = {
  error: "critical",
  warning: "warning",
  info: "unknown",
} as const satisfies Readonly<Record<FindingSeverity, TargetStatus>>;

// ── Alerts ───────────────────────────────────────────────────────────────────

/** Wire ActiveAlert.severity (free-form string) → status. `info` has no dedicated status and
 *  renders as neutral `unknown`; values outside the map resolve through severityToStatus. */
export const SEVERITY_STATUS: Readonly<Record<string, TargetStatus>> = {
  critical: "critical",
  warning: "warning",
  info: "unknown",
};

/** Map every severity string to a status; values outside the known map are unknown. */
export function severityToStatus(severity: string): TargetStatus {
  return Object.hasOwn(SEVERITY_STATUS, severity) ? (SEVERITY_STATUS[severity] ?? "unknown") : "unknown";
}

/** Delivery state → TargetStatus. silenced/inhibited are "suppressed" (marked, not hidden); firing
 *  maps to the alert's own severity, with info collapsing to `unknown`. Alert state BADGES render
 *  through `ALERT_STATE`/`alertStateOf` (`@/ui`) instead, where firing info keeps its own state. */
export function stateToStatus(state: ActiveAlert["state"], severity: string): TargetStatus {
  return state === "firing" ? severityToStatus(severity) : "suppressed";
}

/** History StatusInterval.state → timeline segment status. */
export const INTERVAL_STATUS: Readonly<Record<StatusInterval["state"], TargetStatus>> = {
  firing: "critical",
  failed: "warning",
};

/** Rule health → status, total over the closed `RuleState.health` union. */
export const RULE_HEALTH_STATUS: Readonly<Record<RuleState["health"], TargetStatus>> = {
  healthy: "ok",
  unhealthy: "critical",
  unknown: "unknown",
};

// ── Timeline ─────────────────────────────────────────────────────────────────

/** Alert swimlane severity row → fill status. Matches SEVERITY_STATUS: `info` is `unknown`; the row
 *  text carries the severity word. */
export const SWIM_ROW_STATUS: Readonly<Record<SwimSeverity, TargetStatus>> = {
  critical: "critical",
  warning: "warning",
  info: "unknown",
  unknown: "unknown",
};

// ── Mutations ────────────────────────────────────────────────────────────────

/** Mutation action state → status triple. Narrowed so the badge names only the triples it uses. */
export const ACTION_STATE_STATUS = {
  acked: "suppressed",
  pending: "unknown",
  failed: "critical",
} as const satisfies Readonly<Record<ActionState, TargetStatus>>;

/** Proposal lifecycle state → status triple. Narrowed so the chip names only the triples it uses. */
export const PROPOSAL_STATE_STATUS = {
  pending: "unknown",
  applied: "ok",
  rejected: "suppressed",
} as const satisfies Readonly<Record<ProposalState, TargetStatus>>;
