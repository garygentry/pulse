// apps/web/tests/alerts-model.test.ts — model.ts narrowing boundary + selectors (02 §2).

import { describe, expect, test } from "bun:test";

import { createAppStore } from "../src/client/store/index.js";
import {
  buildRuleFamilyIndex,
  facetValues,
  firingRows,
  hostServiceValue,
  readAlerts,
  relatedByTarget,
  ruleFamily,
  rules,
  silences,
  targetEquals,
  UNGROUPED_FAMILY,
} from "../src/client/views/alerts/model.js";
import { FIXTURE_FINGERPRINTS, makeAlertsPayload } from "./alerts-fixtures.js";

const byFp = (fp: string) => {
  const a = makeAlertsPayload().alerts.find((x) => x.fingerprint === fp);
  if (a === undefined) throw new Error(`fixture alert ${fp} missing`);
  return a;
};

describe("alerts model", () => {
  test("readAlerts passes through null and the published payload", () => {
    const store = createAppStore();
    expect(readAlerts(store)).toBeNull();
    const payload = makeAlertsPayload();
    store.alerts.value = payload;
    expect(readAlerts(store)).toBe(payload);
  });

  test("firingRows/rules/silences return payload arrays by reference", () => {
    const p = makeAlertsPayload();
    expect(firingRows(p)).toBe(p.alerts);
    expect(rules(p)).toBe(p.rules);
    expect(silences(p)).toBe(p.silences);
  });

  test("ruleFamily joins by name, falls back to UNGROUPED, and matches the index", () => {
    const p = makeAlertsPayload();
    expect(ruleFamily(p, byFp(FIXTURE_FINGERPRINTS.hostDown))).toBe("host");
    expect(ruleFamily(p, byFp(FIXTURE_FINGERPRINTS.backupAge))).toBe("service");
    expect(ruleFamily(p, byFp(FIXTURE_FINGERPRINTS.unattributed))).toBe(UNGROUPED_FAMILY);
    const index = buildRuleFamilyIndex(p);
    for (const a of p.alerts) {
      expect(index.get(a.name) ?? UNGROUPED_FAMILY).toBe(ruleFamily(p, a));
    }
  });

  test("buildRuleFamilyIndex is first-match-wins", () => {
    const base = makeAlertsPayload();
    const first = base.rules[0]!;
    const p = { ...base, rules: [...base.rules, { ...first, family: "other" }] };
    expect(buildRuleFamilyIndex(p).get(first.name)).toBe(first.family);
    expect(ruleFamily(p, byFp(FIXTURE_FINGERPRINTS.hostDown))).toBe(first.family);
  });

  test("facetValues yields distinct first-seen values, omitting null group/target", () => {
    const p = makeAlertsPayload();
    const v = facetValues(p);
    const distinct = (xs: readonly (string | null)[]) =>
      [...new Set(xs.filter((x): x is string => x !== null))];
    expect(v.severity).toEqual(distinct(p.alerts.map((a) => a.severity)));
    expect(v.state).toEqual(distinct(p.alerts.map((a) => a.state)));
    expect(v.group).toEqual(distinct(p.alerts.map((a) => a.group)));
    expect(v.hostService).toEqual(distinct(p.alerts.map(hostServiceValue)));
    expect(v.ruleFamily).toEqual(distinct(p.alerts.map((a) => ruleFamily(p, a))));
    expect(v.ruleFamily).toContain(UNGROUPED_FAMILY);
  });

  test("hostServiceValue is the canonical target id, prefixed once (GitHub #10), or null", () => {
    expect(hostServiceValue(byFp(FIXTURE_FINGERPRINTS.hostDown))).toBe("host:web-01");
    expect(hostServiceValue(byFp(FIXTURE_FINGERPRINTS.backupAge))).toBe("svc:web-01/backup");
    expect(hostServiceValue(byFp(FIXTURE_FINGERPRINTS.unattributed))).toBeNull();
  });

  test("facetValues.hostService lists each wire target id once, never double-prefixed (GitHub #10)", () => {
    const values = facetValues(makeAlertsPayload()).hostService;
    expect(values).toEqual(["host:web-01", "svc:web-01/backup"]);
    expect(values.some((v) => /^(host:host:|service:svc:)/.test(v))).toBe(false);
  });

  test("targetEquals is exact and treats two nulls as unequal", () => {
    expect(targetEquals({ kind: "host", id: "a" }, { kind: "host", id: "a" })).toBe(true);
    expect(targetEquals({ kind: "host", id: "a" }, { kind: "service", id: "a" })).toBe(false);
    expect(targetEquals({ kind: "host", id: "a" }, null)).toBe(false);
    expect(targetEquals(null, null)).toBe(false);
  });

  test("relatedByTarget returns exact-target rows in payload order; [] for null", () => {
    const p = makeAlertsPayload();
    const target = { kind: "host", id: "host:web-01" } as const;
    const related = relatedByTarget(p, target);
    expect(related).toEqual(p.alerts.filter((a) => a.target?.kind === "host" && a.target.id === "host:web-01"));
    expect(related.length).toBeGreaterThan(1);
    expect(relatedByTarget(p, null)).toEqual([]);
  });
});
