// apps/web/tests/timeline.test.ts — item 013 / REQ-MOCK-04/05, SC-12.
//
// Determinism of the pure `applyTimeline` fold, the fixed-clock re-run guarantee, the
// degraded-mix drift transitions at t=0/30_000/60_000, and the `freshenGatus` re-basing that
// keeps a frozen Gatus fixture under the 300s staleness rule.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import type {
  AmAlertsResponse,
  GatusStatusesResponse,
  VmQueryResponse,
} from "../src/server/sources/index.js";
import {
  GATUS_FIXTURE_ANCHOR_MS,
  applyTimeline,
  freshenGatus,
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
