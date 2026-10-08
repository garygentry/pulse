// views/alerts/catalog/catalog-model.ts — rule health -> status-chip state, and stable row keys, for the
// catalog tab.
import type { RuleState } from "@pulse/web-data/wire";
import type { TargetStatus } from "../../../../shared/snapshot.js";
import { RULE_HEALTH_STATUS } from "../../../status/target-status.js";

/** Map a rule's health to its status-chip state. Total — every closed-union value maps. */
export function ruleHealthStatus(health: RuleState["health"]): TargetStatus {
  return RULE_HEALTH_STATUS[health];
}

/**
 * A stable, unique row key per rule, aligned with `rules`: `group NUL name`, plus an ordinal for the
 * 2nd+ rule sharing both (vmalert allows the same rule name twice in a group, e.g. one alert at two
 * severities). No row index: adding or removing a rule does not re-key the rows below it, so the
 * virtualized table keeps their measured heights.
 */
export function catalogRowKeys(rules: readonly RuleState[]): string[] {
  const seen = new Map<string, number>();
  return rules.map((rule) => {
    const base = `${rule.group}\u0000${rule.name}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}\u0000${count}`;
  });
}
