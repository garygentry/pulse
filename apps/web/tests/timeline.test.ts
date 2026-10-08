// apps/web/tests/timeline.test.ts — item 013 / REQ-MOCK-04/05, SC-12.
//
// Determinism of the pure `applyTimeline` fold, the fixed-clock re-run guarantee, the
// degraded-mix drift transitions at t=0/30_000/60_000, and the `freshenGatus` re-basing that
// keeps a frozen Gatus fixture under the 300s staleness rule, and the scenario-clock re-base of
// the Alertmanager/vmalert/VM fixture timestamps (GitHub #3).

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import type {
  AmAlertsResponse,
  GatusStatusesResponse,
  VmQueryResponse,
} from "../src/server/sources/index.js";
import {
  FIXTURE_ANCHOR_MS,
  GATUS_FIXTURE_ANCHOR_MS,
  applyTimeline,
  freshenGatus,
  rebaseAlertmanager,
  rebaseVm,
  rebaseVmalert,
  shiftInstant,
  type ScenarioBase,
  type Timeline,
  type VmalertRulesResponse,
} from "../src/server/dev/timeline.js";

const FIXTURES_DIR = resolve(import.meta.dir, "fixtures/engine");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function loadBase(scenario: string): Promise<ScenarioBase> {
  const [vm, alertmanager, gatus, vmalert] = await Promise.all([
    readJson<VmQueryResponse>(resolve(FIXTURES_DIR, scenario, "vm.json")),
    readJson<AmAlertsResponse>(resolve(FIXTURES_DIR, scenario, "alertmanager.json")),
    readJson<GatusStatusesResponse>(resolve(FIXTURES_DIR, scenario, "gatus.json")),
    readJson<VmalertRulesResponse>(resolve(FIXTURES_DIR, scenario, "vmalert.json")),
  ]);
  return { vm, alertmanager, gatus, vmalert };
}

async function loadTimeline(scenario: string): Promise<Timeline> {
  return readJson<Timeline>(resolve(FIXTURES_DIR, scenario, "timeline.json"));
}

describe("applyTimeline determinism (REQ-MOCK-04)", () => {
  test("two calls with equal inputs return deep-equal outputs", async () => {
    const base = await loadBase("degraded-mix");
    const timeline = await loadTimeline("degraded-mix");
    const a = applyTimeline(base, timeline, 32_500);
    const b = applyTimeline(base, timeline, 32_500);
    expect(a).toEqual(b);
    expect([...a.outages]).toEqual([...b.outages]);
  });

  test("does not mutate the input base", async () => {
    const base = await loadBase("degraded-mix");
    const timeline = await loadTimeline("degraded-mix");
    const snapshotBefore = JSON.stringify(base);
    applyTimeline(base, timeline, 60_000);
    applyTimeline(base, timeline, 45_000);
    expect(JSON.stringify(base)).toBe(snapshotBefore);
  });
});

describe("applyTimeline clock rebase (REQ-MOCK-05)", () => {
  test("elapsedMs derived from the same startedAt yields the same states", async () => {
    const base = await loadBase("degraded-mix");
    const timeline = await loadTimeline("degraded-mix");
    const startedAt = 1_800_000_000_000;
    const nowA = startedAt + 20_000;
    const nowB = startedAt + 20_000;
    const a = applyTimeline(base, timeline, nowA - startedAt);
    const b = applyTimeline(base, timeline, nowB - startedAt);
    expect(a).toEqual(b);
  });

  test("negative or zero elapsedMs applies zero steps", async () => {
    const base = await loadBase("degraded-mix");
    const timeline = await loadTimeline("degraded-mix");
    expect(applyTimeline(base, timeline, 0).appliedSteps).toBe(0);
    expect(applyTimeline(base, timeline, -1).appliedSteps).toBe(0);
  });
});

describe("degraded-mix drift transitions (SC-12)", () => {
  test("states at t=0, t=30_000, t=60_000 differ predictably", async () => {
    const base = await loadBase("degraded-mix");
    const timeline = await loadTimeline("degraded-mix");

    const t0 = applyTimeline(base, timeline, 0);
    const t30 = applyTimeline(base, timeline, 30_000);
    const t60 = applyTimeline(base, timeline, 60_000);

    expect(t0.appliedSteps).toBe(0);
    expect(t30.appliedSteps).toBe(3);
    expect(t60.appliedSteps).toBe(6);

    // t=0: no outages, baseline vm/alerts.
    expect(t0.outages.size).toBe(0);
    expect(t0.alertmanager).toEqual(base.alertmanager);
    expect(t0.vm).toEqual(base.vm);

    // t=30_000: vm source in outage, one extra alert, host-down harbor-app-02.
    expect(t30.outages.has("vm")).toBe(true);
    expect(t30.alertmanager.length).toBe(base.alertmanager.length + 1);
    const app02Down = (t30.vm.data?.result ?? []).filter(
      (s) => s.metric.host === "harbor-app-02",
    );
    expect(app02Down.length).toBeGreaterThan(0);
    for (const s of app02Down) expect(s.value[1]).toBe("0");

    // t=60_000: all six steps applied, back to baseline vm/alerts, no outages.
    expect(t60.outages.size).toBe(0);
    expect(t60.alertmanager).toEqual(base.alertmanager);
    expect(t60.vm).toEqual(base.vm);
    expect(t60.gatus).toEqual(base.gatus);
  });

  test("host-down + alert-fire between t=20_000 and t=29_999 stay in effect", async () => {
    const base = await loadBase("degraded-mix");
    const timeline = await loadTimeline("degraded-mix");
    const t25 = applyTimeline(base, timeline, 25_000);
    expect(t25.appliedSteps).toBe(2);
    expect(t25.outages.size).toBe(0);
    expect(t25.alertmanager.length).toBe(base.alertmanager.length + 1);
    const app02 = (t25.vm.data?.result ?? []).filter(
      (s) => s.metric.host === "harbor-app-02",
    );
    for (const s of app02) expect(s.value[1]).toBe("0");
  });
});

describe("freshenGatus rebase (05 §2.4 refinement)", () => {
  test("shifts every result timestamp so the newest is within 300s of nowMs", async () => {
    const base = await loadBase("all-green");
    const wallNowMs = Date.now();
    const fresh = freshenGatus(base.gatus, wallNowMs);
    let maxTimestampMs = 0;
    for (const ep of fresh) {
      for (const r of ep.results ?? []) {
        const t = Date.parse(r.timestamp);
        expect(Number.isFinite(t)).toBe(true);
        if (t > maxTimestampMs) maxTimestampMs = t;
      }
    }
    // Every fixture result is authored at or before the anchor; the newest must be within
    // 300s of the wall clock after rebasing.
    expect(wallNowMs - maxTimestampMs).toBeLessThanOrEqual(300_000);
  });

  test("preserves each result's authored age relative to the anchor", async () => {
    const base = await loadBase("all-green");
    const wallNowMs = 2_000_000_000_000;
    const fresh = freshenGatus(base.gatus, wallNowMs);
    for (let i = 0; i < base.gatus.length; i += 1) {
      const beforeEp = base.gatus[i]!;
      const afterEp = fresh[i]!;
      const beforeResults = beforeEp.results ?? [];
      const afterResults = afterEp.results ?? [];
      expect(afterResults.length).toBe(beforeResults.length);
      for (let j = 0; j < beforeResults.length; j += 1) {
        const authoredAge = GATUS_FIXTURE_ANCHOR_MS - Date.parse(beforeResults[j]!.timestamp);
        const rebasedAge = wallNowMs - Date.parse(afterResults[j]!.timestamp);
        expect(rebasedAge).toBe(authoredAge);
      }
    }
  });

  test("does not mutate the input body", async () => {
    const base = await loadBase("all-green");
    const before = JSON.stringify(base.gatus);
    freshenGatus(base.gatus, 1_800_000_000_000);
    expect(JSON.stringify(base.gatus)).toBe(before);
  });
});

describe("scenario-clock rebase (GitHub #3)", () => {
  const START = Date.parse("2026-10-08T12:00:00.000Z");
  const offset = (iso: string, anchor: number): number => Date.parse(iso) - anchor;

  test("every shipped fixture timestamp is authored around the shared anchor", async () => {
    // Guard for future fixtures: a timestamp far from the anchor would re-base to a nonsense age.
    for (const scenario of ["all-green", "degraded-mix", "source-outage"]) {
      const base = await loadBase(scenario);
      for (const a of base.alertmanager) {
        expect(Math.abs(offset(a.startsAt, FIXTURE_ANCHOR_MS))).toBeLessThanOrEqual(2 * 86_400_000);
      }
      for (const g of base.vmalert.data.groups) {
        for (const r of g.rules) {
          if (r.lastEvaluation !== undefined) expect(r.lastEvaluation).toBe(new Date(FIXTURE_ANCHOR_MS).toISOString());
        }
      }
    }
  });

  test("Alertmanager: each alert's age at scenario start equals its authored offset", async () => {
    const base = await loadBase("degraded-mix");
    const rebased = rebaseAlertmanager(base.alertmanager, START);
    expect(rebased.length).toBe(base.alertmanager.length);
    for (let i = 0; i < base.alertmanager.length; i += 1) {
      const before = base.alertmanager[i]!;
      const after = rebased[i]!;
      expect(START - Date.parse(after.startsAt)).toBe(FIXTURE_ANCHOR_MS - Date.parse(before.startsAt));
      expect(offset(after.endsAt!, START)).toBe(offset(before.endsAt!, FIXTURE_ANCHOR_MS));
      expect(offset(after.updatedAt!, START)).toBe(offset(before.updatedAt!, FIXTURE_ANCHOR_MS));
      // Firing semantics hold at scenario start: started in the past, ends in the future.
      expect(Date.parse(after.startsAt)).toBeLessThanOrEqual(START);
      expect(Date.parse(after.endsAt!)).toBeGreaterThan(START);
      expect(after.labels).toEqual(before.labels);
      expect(after.status).toEqual(before.status);
    }
    // degraded-mix: HypervisorUnreachable started 19 minutes before the anchor.
    expect(START - Date.parse(rebased[0]!.startsAt)).toBe(19 * 60_000);
  });

  test("Alertmanager: a resolved alert's window and the zero time are preserved", () => {
    const zero = "0001-01-01T00:00:00Z";
    const body: AmAlertsResponse = [{
      labels: { alertname: "Resolved" },
      annotations: {},
      startsAt: "2025-12-31T22:00:00.000Z",
      endsAt: "2025-12-31T23:30:00.000Z",
      updatedAt: zero,
      fingerprint: "0000000000000001",
      status: { state: "unprocessed", silencedBy: [], inhibitedBy: [] },
      receivers: [{ name: "default" }],
    }];
    const [after] = rebaseAlertmanager(body, START);
    expect(after!.updatedAt).toBe(zero);
    expect(Date.parse(after!.endsAt!) - Date.parse(after!.startsAt)).toBe(90 * 60_000);
    expect(START - Date.parse(after!.endsAt!)).toBe(30 * 60_000); // still ended in the past
  });

  test("shiftInstant leaves unset and unparseable values untouched", () => {
    expect(shiftInstant("0001-01-01T00:00:00Z", 1_000)).toBe("0001-01-01T00:00:00Z");
    expect(shiftInstant("1970-01-01T00:00:00Z", 1_000)).toBe("1970-01-01T00:00:00Z");
    expect(shiftInstant("not a date", 1_000)).toBe("not a date");
    expect(shiftInstant("2026-01-01T00:00:00.000Z", 1_000)).toBe("2026-01-01T00:00:01.000Z");
  });

  test("vmalert: lastEvaluation and activeAt keep their offsets from the anchor", async () => {
    const base = await loadBase("degraded-mix");
    const rebased = rebaseVmalert(base.vmalert, START);
    base.vmalert.data.groups.forEach((g, gi) => {
      const ag = rebased.data.groups[gi]!;
      if (g.lastEvaluation !== undefined) expect(offset(ag.lastEvaluation!, START)).toBe(offset(g.lastEvaluation, FIXTURE_ANCHOR_MS));
      g.rules.forEach((r, ri) => {
        const ar = ag.rules[ri]!;
        if (r.lastEvaluation !== undefined) expect(offset(ar.lastEvaluation!, START)).toBe(offset(r.lastEvaluation, FIXTURE_ANCHOR_MS));
        (r.alerts ?? []).forEach((a, ai) => {
          const before = (a as { activeAt: string }).activeAt;
          const after = (ar.alerts![ai] as { activeAt: string }).activeAt;
          expect(offset(after, START)).toBe(offset(before, FIXTURE_ANCHOR_MS));
        });
      });
    });
  });

  test("VM: sample times shift by the same delta (seconds)", async () => {
    const base = await loadBase("all-green");
    const rebased = rebaseVm(base.vm, START);
    base.vm.data!.result.forEach((s, i) => {
      const after = rebased.data!.result[i]!;
      expect((after.value[0] - s.value[0]) * 1000).toBe(START - FIXTURE_ANCHOR_MS);
      expect(after.value[1]).toBe(s.value[1]);
      expect(after.metric).toEqual(s.metric);
    });
  });

  test("identity at the anchor, no input mutation, and deterministic output", async () => {
    const base = await loadBase("degraded-mix");
    const before = JSON.stringify(base);
    expect(JSON.stringify(rebaseAlertmanager(base.alertmanager, FIXTURE_ANCHOR_MS))).toBe(JSON.stringify(base.alertmanager));
    expect(JSON.stringify(rebaseVmalert(base.vmalert, FIXTURE_ANCHOR_MS))).toBe(JSON.stringify(base.vmalert));
    expect(JSON.stringify(rebaseVm(base.vm, FIXTURE_ANCHOR_MS))).toBe(JSON.stringify(base.vm));
    const a = JSON.stringify([rebaseAlertmanager(base.alertmanager, START), rebaseVmalert(base.vmalert, START), rebaseVm(base.vm, START)]);
    const b = JSON.stringify([rebaseAlertmanager(base.alertmanager, START), rebaseVmalert(base.vmalert, START), rebaseVm(base.vm, START)]);
    expect(a).toBe(b);
    expect(JSON.stringify(base)).toBe(before);
    expect(GATUS_FIXTURE_ANCHOR_MS).toBe(FIXTURE_ANCHOR_MS);
  });
});
