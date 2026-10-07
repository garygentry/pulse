// stack/alerting/tests/rules-yaml.test.ts
// Tier-A unit test for the deterministic rule-group serializer (03 §3.3): determinism
// (identical input → byte-identical output), zero-rule-group drop, all-empty → `groups: []`,
// and alphabetized keys (sortMapEntries).
/// <reference path="./bun-test.d.ts" />
import { describe, expect, test } from "bun:test";
import {
  serializeRuleGroups,
  type AlertRuleYaml,
  type RuleGroupYaml,
} from "../src/transform/rules-yaml.js";

function sampleRule(alert: string): AlertRuleYaml {
  return {
    alert,
    // out-of-alphabetical-order keys on purpose, to prove sortMapEntries reorders them
    expr: `pulse_deep_health{service="cameras",metric="camera_count"} < 6`,
    for: "2m",
    labels: { severity: "critical" },
    annotations: {
      summary: `Deep-health functional check failed for ${alert}`,
      description: "Declared deep-health expression is failing.",
    },
  };
}

describe("serializeRuleGroups", () => {
  test("identical input → byte-identical output (determinism)", () => {
    const groups: RuleGroupYaml[] = [
      { name: "deep-health-functional", rules: [sampleRule("DeepHealthFailed")] },
    ];
    const a = serializeRuleGroups(groups);
    // Rebuild an independent, structurally-identical input to prove insertion order is irrelevant.
    const b = serializeRuleGroups([
      { name: "deep-health-functional", rules: [sampleRule("DeepHealthFailed")] },
    ]);
    expect(a).toBe(b);
  });

  test("a zero-rule group is dropped", () => {
    const groups: RuleGroupYaml[] = [
      { name: "empty-group", rules: [] },
      { name: "deep-health-functional", rules: [sampleRule("DeepHealthFailed")] },
    ];
    const out = serializeRuleGroups(groups);
    expect(out).not.toContain("empty-group");
    expect(out).toContain("deep-health-functional");
  });

  test("all-empty input serializes to `groups: []`", () => {
    const out = serializeRuleGroups([
      { name: "empty-a", rules: [] },
      { name: "empty-b", rules: [] },
    ]);
    expect(out).toBe("groups: []\n");
  });

  test("no groups at all also serializes to `groups: []`", () => {
    expect(serializeRuleGroups([])).toBe("groups: []\n");
  });

  test("keys are alphabetized (sortMapEntries)", () => {
    const out = serializeRuleGroups([
      { name: "deep-health-functional", rules: [sampleRule("DeepHealthFailed")] },
    ]);
    // Within the rule map, keys must appear in alphabetical order:
    // alert < annotations < expr < for < labels
    const idxAlert = out.indexOf("alert:");
    const idxAnnotations = out.indexOf("annotations:");
    const idxExpr = out.indexOf("expr:");
    const idxFor = out.indexOf("for:");
    const idxLabels = out.indexOf("labels:");
    expect(idxAlert).toBeGreaterThanOrEqual(0);
    expect(idxAlert).toBeLessThan(idxAnnotations);
    expect(idxAnnotations).toBeLessThan(idxExpr);
    expect(idxExpr).toBeLessThan(idxFor);
    expect(idxFor).toBeLessThan(idxLabels);

    // Within the annotations map, `description` sorts before `summary`.
    const idxDescription = out.indexOf("description:");
    const idxSummary = out.indexOf("summary:");
    expect(idxDescription).toBeGreaterThanOrEqual(0);
    expect(idxDescription).toBeLessThan(idxSummary);
  });

  test("byte-for-byte golden shape matches the §4.4 concrete output", () => {
    const rule: AlertRuleYaml = {
      alert: "DeepHealthFailed",
      expr: 'pulse_deep_health{service="cameras",metric="camera_count"} < 6',
      for: "2m",
      labels: { severity: "critical" },
      annotations: {
        summary: "Deep-health functional check failed for {{ $labels.service }}",
        description:
          "Declared deep-health expression is failing for service {{ $labels.service }} on host " +
          "{{ $labels.host }} in estate {{ $labels.estate }}.",
      },
    };
    const out = serializeRuleGroups([{ name: "deep-health-functional", rules: [rule] }]);
    const expected =
      "groups:\n" +
      "  - name: deep-health-functional\n" +
      "    rules:\n" +
      "      - alert: DeepHealthFailed\n" +
      "        annotations:\n" +
      "          description: Declared deep-health expression is failing for service {{ $labels.service }} on host {{ $labels.host }} in estate {{ $labels.estate }}.\n" +
      "          summary: Deep-health functional check failed for {{ $labels.service }}\n" +
      '        expr: pulse_deep_health{service="cameras",metric="camera_count"} < 6\n' +
      "        for: 2m\n" +
      "        labels:\n" +
      "          severity: critical\n";
    expect(out).toBe(expected);
  });
});
