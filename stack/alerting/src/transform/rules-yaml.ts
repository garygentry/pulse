// stack/alerting/src/transform/rules-yaml.ts
// The single deterministic vmalert rule-group serializer shared by both inventory-derived
// rule builders (deep-health-rules.ts, backup-rules.ts) so key ordering and formatting are
// identical and golden-stable. Canonical shape: 03-transform-and-rendered-rules.md §3.3.
import { stringify as stringifyYaml } from "yaml";

/** One vmalert alerting rule (Prometheus rule-group format). */
export interface AlertRuleYaml {
  alert: string;                          // PascalCase alert name (REQ-RULE-02)
  expr: string;                           // PromQL expression
  for?: string;                           // detection/grace window (REQ-RULE-05 for NoData)
  labels: Record<string, string>;         // severity (+ any rule-static labels)
  annotations: Record<string, string>;    // summary/description (REQ-RULE-04)
}

/** One vmalert rule group. */
export interface RuleGroupYaml {
  name: string;
  rules: AlertRuleYaml[];
}

/**
 * Serialize rule groups to deterministic vmalert YAML.
 * Groups with zero rules are dropped; if nothing remains, `groups: []` is emitted (a valid,
 * vmalert-loadable empty ruleset — e.g. an estate with no deep-health services).
 *
 * @param groups - The groups to emit.
 * @returns Byte-deterministic YAML (sorted keys, no wrapping, no timestamps).
 */
export function serializeRuleGroups(groups: RuleGroupYaml[]): string {
  const nonEmpty = groups.filter((g) => g.rules.length > 0);
  return stringifyYaml(
    { groups: nonEmpty },
    { sortMapEntries: true, lineWidth: 0 }, // sorted keys + no line wrapping = golden-stable
  );
}
