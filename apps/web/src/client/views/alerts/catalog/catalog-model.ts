// views/alerts/catalog/catalog-model.ts — rule health -> status-chip state for the catalog tab.
import type { RuleState } from "@pulse/web-data/wire";
import type { TargetStatus } from "../../../../shared/snapshot.js";
import { RULE_HEALTH_STATUS } from "../../../status/target-status.js";

/** Map a rule's health to its status-chip state. Total — every closed-union value maps. */
export function ruleHealthStatus(health: RuleState["health"]): TargetStatus {
  return RULE_HEALTH_STATUS[health];
}
