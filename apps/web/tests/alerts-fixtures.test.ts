// apps/web/tests/alerts-fixtures.test.ts — shape checks for the alert-triage fixture builder (08 §3).
// Pure data assertions; never renders.

import { describe, expect, it } from "bun:test";

import {
  ALERTS_SCENARIOS,
  FIXTURE_FINGERPRINTS,
  FIXTURE_SILENCE_IDS,
  UNKNOWN_SEL_FINGERPRINT,
  makeAlertsPayload,
  makeHistoryOverflow,
  makeHistoryPayload,
  makeSession,
} from "./alerts-fixtures.js";

describe("alerts-fixtures", () => {
  it("mixed has firing+silenced+inhibited rows, rules, silences, and both sources current", () => {
    const p = makeAlertsPayload();
    expect(new Set(p.alerts.map((a) => a.state))).toEqual(new Set(["firing", "silenced", "inhibited"]));
    expect(p.rules.length).toBeGreaterThan(0);
    expect(p.rules.some((r) => r.deadman)).toBe(true);
    expect(p.silences.length).toBeGreaterThan(0);
    expect(p.alertmanager.state).toBe("current");
    expect(p.vmalert.state).toBe("current");
  });

  it("covers historyRef alerts.firing, historyRef null, and target null edges", () => {
    const { alerts } = makeAlertsPayload({ scenario: "mixed" });
    expect(alerts.some((a) => a.historyRef?.queryId === "alerts.firing")).toBe(true);
    expect(alerts.some((a) => a.historyRef === null)).toBe(true);
    expect(alerts.some((a) => a.target === null)).toBe(true);
    const backup = alerts.find((a) => a.fingerprint === FIXTURE_FINGERPRINTS.backupAge);
    expect(backup?.silencedBy).toContain(FIXTURE_SILENCE_IDS.missing);
  });

  it("degraded scenarios set per-source availability independently", () => {
    const am = makeAlertsPayload({ scenario: "am-down" });
    expect(am.alertmanager.state).toBe("unavailable");
    expect(am.vmalert.state).toBe("current");
    const vm = makeAlertsPayload({ scenario: "vmalert-down" });
    expect(vm.vmalert.state).toBe("unavailable");
    expect(vm.alertmanager.state).toBe("current");
    const stale = makeAlertsPayload({ scenario: "stale" });
    const staleSource = [stale.alertmanager, stale.vmalert].find((s) => s.state === "stale");
    expect(staleSource?.lastGoodAt).not.toBeNull();
  });

  it("empty-healthy has zero alerts under two current sources", () => {
    const p = makeAlertsPayload({ scenario: "empty-healthy" });
    expect(p.alerts).toHaveLength(0);
    expect(p.alertmanager.state).toBe("current");
    expect(p.vmalert.state).toBe("current");
  });

  it("unknown-sel fingerprint matches no alert in any scenario", () => {
    for (const scenario of ALERTS_SCENARIOS) {
      const p = makeAlertsPayload({ scenario });
      expect(p.alerts.some((a) => a.fingerprint === UNKNOWN_SEL_FINGERPRINT)).toBe(false);
    }
    expect(makeAlertsPayload({ scenario: "unknown-sel" }).alerts.length).toBeGreaterThan(0);
  });

  it("history kinds: ready is all matched, unmatched adds a labeled lane, overflow is an envelope", () => {
    const ready = makeHistoryPayload();
    expect(ready.operation).toBe("alert-intervals");
    expect(ready.lanes.length).toBeGreaterThan(0);
    expect(ready.lanes.every((l) => l.attribution === "matched" && l.intervals.length > 0)).toBe(true);
    const unmatched = makeHistoryPayload({ kind: "unmatched" });
    expect(unmatched.lanes.some((l) => l.attribution === "unmatched")).toBe(true);
    const overflow = makeHistoryPayload({ kind: "overflow" });
    expect(overflow.code).toBe("HISTORY_LIMIT_EXCEEDED");
    expect(overflow).toEqual(makeHistoryOverflow());
  });

  it("session capabilities are all false in M1", () => {
    expect(makeSession().capabilities).toEqual({ silence: false, ack: false, proposeEstateEdit: false });
  });

  it("returns deep-frozen values", () => {
    const p = makeAlertsPayload();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.alerts[0]?.labels)).toBe(true);
    expect(Object.isFrozen(makeHistoryPayload().lanes[0]?.intervals)).toBe(true);
    expect(Object.isFrozen(makeSession().capabilities)).toBe(true);
  });
});
