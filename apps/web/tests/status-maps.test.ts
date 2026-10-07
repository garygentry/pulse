// apps/web/tests/status-maps.test.ts — every domain → TargetStatus map lives in one module, is total
// over its domain type, maps only to real statuses, and pins the two normalizations: engine
// `not-configured` and swimlane `info` both render as `unknown`.

import { describe, expect, test } from "bun:test";

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

import { STATUS_LABEL } from "../src/client/a11y/status-labels.js";
import type { ActionState } from "../src/client/mutations/StateBadge.js";
import {
  ACTION_STATE_STATUS,
  COVERAGE_STATUS,
  DIFF_STATUS,
  FINDING_SEVERITY_STATUS,
  HEALTH_STATUS,
  HEALTH_TO_STATUS,
  INTERVAL_STATUS,
  PROPOSAL_STATE_STATUS,
  RULE_HEALTH_STATUS,
  SCRAPE_HEALTH_STATUS,
  SEVERITY_STATUS,
  SWIM_ROW_STATUS,
  severityToStatus,
  stateToStatus,
} from "../src/client/status/target-status.js";
import { PRESENTATION_ICON, componentPresentation, deadmanPresentation, toStatus } from "../src/client/views/engine/labels.js";
import { makeComponent, makeEnginePayload } from "./engine-fixtures.js";
import type { HostCoverage } from "../src/client/views/estate/inventory-model.js";
import type { Severity as FindingSeverity } from "../src/client/views/estate/findings-model.js";
import { toTargetStatus } from "../src/client/views/estate/status.js";
import type { SwimSeverity } from "../src/client/views/timeline/swimlane-pack.js";

/** Typed list of every member of `T`: a missing member is a typecheck error. */
function domain<T extends string>() {
  return <const A extends readonly T[]>(values: A & ([T] extends [A[number]] ? unknown : never)): A => values;
}

const STATUSES = Object.keys(STATUS_LABEL) as TargetStatus[];

interface MapCase {
  readonly name: string;
  readonly map: Readonly<Record<string, TargetStatus>>;
  readonly keys: readonly string[];
}

const CASES: readonly MapCase[] = [
  { name: "HEALTH_TO_STATUS", map: HEALTH_TO_STATUS, keys: domain<HealthState>()(["healthy", "unhealthy", "unknown", "not-configured"]) },
  { name: "HEALTH_STATUS", map: HEALTH_STATUS, keys: domain<HealthState>()(["healthy", "unhealthy", "unknown", "not-configured"]) },
  { name: "SCRAPE_HEALTH_STATUS", map: SCRAPE_HEALTH_STATUS, keys: domain<ScrapeJobState["targets"][number]["health"]>()(["up", "down", "unknown"]) },
  { name: "COVERAGE_STATUS", map: COVERAGE_STATUS, keys: domain<HostCoverage>()(["covered", "gap", "suppressed", "unknown"]) },
  { name: "DIFF_STATUS", map: DIFF_STATUS, keys: domain<DeclaredScrapeComparison["state"]>()(["matched", "missing", "unexpected", "unknown"]) },
  { name: "FINDING_SEVERITY_STATUS", map: FINDING_SEVERITY_STATUS, keys: domain<FindingSeverity>()(["error", "warning", "info"]) },
  { name: "SEVERITY_STATUS", map: SEVERITY_STATUS, keys: ["critical", "warning", "info"] },
  { name: "INTERVAL_STATUS", map: INTERVAL_STATUS, keys: domain<StatusInterval["state"]>()(["firing", "failed"]) },
  { name: "RULE_HEALTH_STATUS", map: RULE_HEALTH_STATUS, keys: domain<RuleState["health"]>()(["healthy", "unhealthy", "unknown"]) },
  { name: "SWIM_ROW_STATUS", map: SWIM_ROW_STATUS, keys: domain<SwimSeverity>()(["critical", "warning", "info", "unknown"]) },
  { name: "ACTION_STATE_STATUS", map: ACTION_STATE_STATUS, keys: domain<ActionState>()(["acked", "pending", "failed"]) },
  { name: "PROPOSAL_STATE_STATUS", map: PROPOSAL_STATE_STATUS, keys: domain<ProposalState>()(["pending", "applied", "rejected"]) },
];

describe("status maps", () => {
  for (const c of CASES) {
    test(`${c.name} is exhaustive over its domain and maps only to TargetStatus values`, () => {
      expect(Object.keys(c.map).sort()).toEqual([...c.keys].sort());
      for (const v of Object.values(c.map)) expect(STATUSES).toContain(v);
    });
  }

  test("engine not-configured renders as unknown (matches estate)", () => {
    expect(HEALTH_STATUS["not-configured"]).toBe("unknown");
    expect(HEALTH_TO_STATUS["not-configured"]).toBe("unknown");
    expect(toStatus("not-configured")).toBe("unknown");
    expect(toTargetStatus({ health: "not-configured", suppressed: false, availability: "current" }).status).toBe("unknown");
  });

  test("engine component and deadman not-configured presentations are unknown, told apart by the minus icon and word", () => {
    const card = componentPresentation(makeComponent("grafana", { state: "not-configured" }));
    const deadman = deadmanPresentation({ ...makeEnginePayload().deadman, configured: false, state: "not-configured" });
    for (const p of [card, deadman]) {
      expect({ kind: p.kind, status: p.status, text: p.text, icon: PRESENTATION_ICON[p.kind] })
        .toEqual({ kind: "not-configured", status: "unknown", text: "Not configured", icon: "minus" });
    }
    expect(PRESENTATION_ICON.unknown).not.toBe("minus");
  });

  test("swimlane info renders as unknown (matches alerts)", () => {
    expect(SWIM_ROW_STATUS.info).toBe("unknown");
    expect(SWIM_ROW_STATUS.info).toBe(severityToStatus("info"));
  });

  test("alert severity and delivery state resolve totally", () => {
    expect(severityToStatus("critical")).toBe("critical");
    expect(severityToStatus("info")).toBe("unknown");
    expect(severityToStatus("toString")).toBe("unknown");
    const states: readonly ActiveAlert["state"][] = ["firing", "silenced", "inhibited"];
    expect(states.map((s) => stateToStatus(s, "warning"))).toEqual(["warning", "suppressed", "suppressed"]);
  });

  test("no view module defines its own domain → TargetStatus Record", async () => {
    const { Glob } = await import("bun");
    const root = new URL("../src/client/", import.meta.url).pathname;
    const offenders: string[] = [];
    for await (const file of new Glob("{views,mutations}/**/*.{ts,tsx}").scan(root)) {
      const src = await Bun.file(root + file).text();
      if (/Record<[^>]*,\s*TargetStatus>\s*>?\s*=/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
