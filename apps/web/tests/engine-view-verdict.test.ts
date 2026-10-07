// tests/engine-view-verdict.test.ts — pure unit tests for views/engine/verdict.ts (03 §3; 08 §3.1).
// One named test per 03 §3.2 decision-table row, in order; the §3.6 invariants; a seeded property
// test for REQ-VERDICT-03; presentVerdict (§3.5); the no-throw corpus for verdict.ts. No DOM.

import { describe, expect, test } from "bun:test";
import type {
  AvailabilityState,
  CycleObservation,
  DataAvailability,
  EngineComponent,
  EnginePayload,
  HealthState,
  OverviewSnapshotV2,
  ScrapeJobState,
  SourceId,
} from "@pulse/web-data/wire";

import { VERDICT_INLINE_CONTRIBUTORS } from "../src/client/views/engine/labels.js";
import {
  GOVERNING_SOURCES,
  presentVerdict,
  rollUpVerdict,
  type Verdict,
  type VerdictInput,
} from "../src/client/views/engine/verdict.js";
import {
  ENGINE_NOW_ISO,
  ENGINE_OUT_OF_CONTRACT,
  currentObservation,
  degradedEngine,
  delivery,
  makeComponent,
  makeEnginePayload,
  makeEngineSnapshot,
  makeObservation,
  okEngine,
} from "./engine-fixtures.js";

const NOW_MS = Date.parse(ENGINE_NOW_ISO);
const LAST_GOOD_MS = NOW_MS - 90_000;

type OverviewEngine = NonNullable<VerdictInput["overviewEngine"]>;

/** Same-cycle overview engine summary built from makeEngineSnapshot. */
function overview(engineOk: boolean | null, generatedAt: string = ENGINE_NOW_ISO): OverviewEngine {
  return { section: makeEngineSnapshot({ engineOk, generatedAt }).engine, generatedAt };
}

/** A clean input (all-green payload, current observation, same-cycle OK overview) with overrides. */
function input(o: Partial<VerdictInput> = {}): VerdictInput {
  return {
    engine: okEngine(),
    delivery: delivery("current"),
    notCurrent: false,
    observation: currentObservation(),
    overviewEngine: overview(true),
    lastGoodAt: LAST_GOOD_MS,
    ...o,
  };
}

function contributors(v: Verdict): readonly string[] {
  return v.kind === "degraded" ? v.contributors : [];
}

function withComponent(id: EngineComponent["id"], o: Parameters<typeof makeComponent>[1]): EnginePayload {
  const base = okEngine();
  return { ...base, components: base.components.map((c) => c.id === id ? makeComponent(id, o) : c) };
}

const identityFormat = (iso: string): string => iso;

// ---------------------------------------------------------------------------------------------
// 03 §3.2 decision table, top to bottom (08 §3.1 list)
// ---------------------------------------------------------------------------------------------

describe("rollUpVerdict — 03 §3.2 decision table", () => {
  test("REQ-EFRESH-03 step 1: null engine, phase initial, not notCurrent → loading", () => {
    expect(rollUpVerdict(input({ engine: null, delivery: delivery("initial") }))).toEqual({ kind: "loading" });
  });

  test("REQ-VERDICT-01/REQ-DEGRADE-01 step 2: null engine, phase initial AND notCurrent → unknown (not loading)", () => {
    expect(rollUpVerdict(input({ engine: null, delivery: delivery("initial"), notCurrent: true })))
      .toEqual({ kind: "unknown", since: LAST_GOOD_MS });
  });

  test("REQ-VERDICT-01 step 2: null engine otherwise (phase current / stale, not notCurrent) → unknown", () => {
    expect(rollUpVerdict(input({ engine: null, delivery: delivery("current") })))
      .toEqual({ kind: "unknown", since: LAST_GOOD_MS });
    expect(rollUpVerdict(input({ engine: null, delivery: delivery("stale") })))
      .toEqual({ kind: "unknown", since: LAST_GOOD_MS });
    expect(rollUpVerdict(input({ engine: null, delivery: delivery("stale"), lastGoodAt: null })))
      .toEqual({ kind: "unknown", since: null });
  });

  test("REQ-VERDICT-01/REQ-EFRESH-02 step 2: persistent notCurrent with a payload → unknown(since lastGoodAt)", () => {
    expect(rollUpVerdict(input({ notCurrent: true }))).toEqual({ kind: "unknown", since: LAST_GOOD_MS });
    expect(rollUpVerdict(input({ engine: degradedEngine(), notCurrent: true })))
      .toEqual({ kind: "unknown", since: LAST_GOOD_MS });
  });

  test("REQ-VERDICT-02 step 3.1: cycle build failure alone → 'cycle build failed'", () => {
    const engine = makeEnginePayload({ cycle: { buildFailure: { kind: "fold", view: "engine", message: "boom" } } });
    expect(rollUpVerdict(input({ engine }))).toEqual({ kind: "degraded", contributors: ["cycle build failed"] });
  });

  test("REQ-VERDICT-02 step 3.2: cycle degraded alone → 'publication cycle degraded'", () => {
    const engine = makeEnginePayload({ cycle: { degraded: true } });
    expect(rollUpVerdict(input({ engine }))).toEqual({ kind: "degraded", contributors: ["publication cycle degraded"] });
  });

  test("REQ-VERDICT-02 step 3.3: a not-configured component adds nothing", () => {
    const engine = withComponent("grafana", { state: "not-configured", availability: { state: "not-configured", lastGoodAt: null } });
    expect(rollUpVerdict(input({ engine }))).toEqual({ kind: "ok" });
  });

  test("REQ-VERDICT-02 step 3.3: an unhealthy component alone → '{name} unreachable' (wins over stale)", () => {
    expect(rollUpVerdict(input({ engine: withComponent("vmalert", { state: "unhealthy" }) })))
      .toEqual({ kind: "degraded", contributors: ["vmalert unreachable"] });
    const both = withComponent("vmalert", { state: "unhealthy", availability: { state: "stale" } });
    expect(rollUpVerdict(input({ engine: both }))).toEqual({ kind: "degraded", contributors: ["vmalert unreachable"] });
  });

  test("REQ-EFRESH-02 step 3.3: an unknown-state component alone → '{name} stale'", () => {
    expect(rollUpVerdict(input({ engine: withComponent("alertmanager", { state: "unknown" }) })))
      .toEqual({ kind: "degraded", contributors: ["Alertmanager stale"] });
  });

  test("REQ-EFRESH-02 step 3.3: a healthy component with non-current availability alone → '{name} stale'", () => {
    expect(rollUpVerdict(input({ engine: withComponent("gatus", { availability: { state: "stale" } }) })))
      .toEqual({ kind: "degraded", contributors: ["Gatus stale"] });
    expect(rollUpVerdict(input({ engine: withComponent("web", { availability: { state: "unavailable" } }) })))
      .toEqual({ kind: "degraded", contributors: ["Pulse web app stale"] });
  });

  test("REQ-VERDICT-02 step 3.3: an out-of-contract component id falls back to the raw id string", () => {
    const base = okEngine();
    const odd = { ...makeComponent("vmalert", { state: "unhealthy" }), id: "mystery" } as unknown as EngineComponent;
    const engine: EnginePayload = { ...base, components: [...base.components, odd] };
    expect(rollUpVerdict(input({ engine }))).toEqual({ kind: "degraded", contributors: ["mystery unreachable"] });
  });

  test("REQ-VERDICT-02/REQ-DEADMAN-01 step 3.4: deadman not configured alone → 'deadman not configured'", () => {
    const engine = makeEnginePayload({ deadman: { configured: false, state: "not-configured", lastEvaluationAt: null } });
    expect(rollUpVerdict(input({ engine }))).toEqual({ kind: "degraded", contributors: ["deadman not configured"] });
  });

  test("REQ-DEADMAN-01 step 3.4: a configured deadman that is not healthy alone → 'deadman {state}'", () => {
    expect(rollUpVerdict(input({ engine: makeEnginePayload({ deadman: { state: "unhealthy" } }) })))
      .toEqual({ kind: "degraded", contributors: ["deadman unhealthy"] });
    expect(rollUpVerdict(input({ engine: makeEnginePayload({ deadman: { state: "unknown" } }) })))
      .toEqual({ kind: "degraded", contributors: ["deadman unknown"] });
  });

  test("REQ-SCRAPE-01 step 3.5: down targets alone → '{N} scrape targets down' (verbatim plural, 03 open item 5)", () => {
    const one = degradedEngine({ vmalert: "healthy", downTargets: 1, deadmanConfigured: true });
    expect(rollUpVerdict(input({ engine: one }))).toEqual({ kind: "degraded", contributors: ["1 scrape targets down"] });
    const three = degradedEngine({ vmalert: "healthy", downTargets: 3, deadmanConfigured: true });
    expect(rollUpVerdict(input({ engine: three }))).toEqual({ kind: "degraded", contributors: ["3 scrape targets down"] });
  });

  test("REQ-SCRAPE-01 step 3.5: 'unknown' target health counts as down", () => {
    const base = okEngine();
    const scrapeJobs: ScrapeJobState[] = base.scrapeJobs.map((j, i) => i === 1
      ? { ...j, targets: j.targets.map((t, k) => k < 2 ? { ...t, health: "unknown" as const } : t) }
      : j);
    expect(rollUpVerdict(input({ engine: { ...base, scrapeJobs } })))
      .toEqual({ kind: "degraded", contributors: ["2 scrape targets down"] });
  });

  test("REQ-SCRAPE-04 step 3.5: target discovery not current (observation) alone → 'target discovery not current'", () => {
    const observation = makeObservation({ sources: { "victoriametrics-targets": "stale" } });
    expect(rollUpVerdict(input({ observation })))
      .toEqual({ kind: "degraded", contributors: ["target discovery not current"] });
  });

  test("REQ-SCRAPE-04/REQ-DEGRADE-01 step 3.5: discovery not current fires even with zero scrape jobs", () => {
    const observation = makeObservation({ sources: { "victoriametrics-targets": "unavailable" } });
    expect(rollUpVerdict(input({ engine: makeEnginePayload({ scrapeJobs: [] }), observation })))
      .toEqual({ kind: "degraded", contributors: ["target discovery not current"] });
  });

  test("REQ-RULE-01 step 3.6: failing rule groups alone → '{M} rule groups failing'", () => {
    const base = okEngine();
    const ruleGroups = base.ruleGroups.map((g, i) => i === 1 ? { ...g, health: "unhealthy" as const } : i === 2 ? { ...g, health: "unknown" as const } : g);
    expect(rollUpVerdict(input({ engine: { ...base, ruleGroups } })))
      .toEqual({ kind: "degraded", contributors: ["2 rule groups failing"] });
  });

  test("REQ-NOTIFY-01 step 3.7: finite failure rates > 0 alone → 'notifications failing ({keys})' sorted by code point", () => {
    const engine = makeEnginePayload({ notifications: { failuresPerSecond: { webhook: 0, slack: 0.2, email: 0.1, Zulip: 1, bad: NaN, inf: Infinity, neg: -1 } } });
    expect(rollUpVerdict(input({ engine })))
      .toEqual({ kind: "degraded", contributors: ["notifications failing (Zulip, email, slack)"] });
  });

  test("REQ-NOTIFY-01 step 3.7: a null failure map adds nothing; all-zero rates add nothing", () => {
    expect(rollUpVerdict(input({ engine: makeEnginePayload({ notifications: { failuresPerSecond: null } }) }))).toEqual({ kind: "ok" });
    expect(rollUpVerdict(input())).toEqual({ kind: "ok" });
  });

  test("REQ-NOTIFY-01/REQ-DEGRADE-01 step 3.7: notification availability not current alone → 'notification metrics unavailable'", () => {
    const engine = makeEnginePayload({ notifications: { availability: { state: "stale" } } });
    expect(rollUpVerdict(input({ engine })))
      .toEqual({ kind: "degraded", contributors: ["notification metrics unavailable"] });
  });

  for (const id of GOVERNING_SOURCES) {
    test(`REQ-VERDICT-03 step 3.8(a): governing source ${id} not current → not OK`, () => {
      const observation = makeObservation({ sources: { [id]: "stale" } });
      const v = rollUpVerdict(input({ observation }));
      expect(v.kind).toBe("degraded");
      // victoriametrics-targets is also the discovery source, so step 3.5 fires first and the
      // guard (which runs only on an otherwise empty list) never gets there.
      expect(contributors(v)).toEqual(id === "victoriametrics-targets"
        ? ["target discovery not current"]
        : [`engine source ${id} not current`]);
    });
  }

  test("REQ-VERDICT-03 step 3.8(a): a missing observation.sources entry reads as not current", () => {
    const obs = currentObservation();
    const { "gatus-statuses": _gone, ...sources } = obs.sources;
    const observation = { ...obs, sources } as CycleObservation;
    expect(rollUpVerdict(input({ observation })))
      .toEqual({ kind: "degraded", contributors: ["engine source gatus-statuses not current"] });
  });

  test("REQ-VERDICT-03 step 3.8(a): several governing sources are listed in GOVERNING_SOURCES order", () => {
    const observation = makeObservation({ sources: { "gatus-statuses": "unavailable", "alertmanager-alerts": "stale", "grafana-health": "stale" } });
    expect(rollUpVerdict(input({ observation, overviewEngine: null }))).toEqual({
      kind: "degraded",
      contributors: ["engine source alertmanager-alerts not current", "engine source gatus-statuses not current"],
    });
  });

  test("REQ-VERDICT-03 step 3.8(b): same-cycle overview engine not OK → 'engine source {source} not current'", () => {
    expect(rollUpVerdict(input({ overviewEngine: overview(false) })))
      .toEqual({ kind: "degraded", contributors: ["engine source victoriametrics-signals not current"] });
    expect(rollUpVerdict(input({ overviewEngine: overview(null) })))
      .toEqual({ kind: "degraded", contributors: ["engine source victoriametrics-targets not current"] });
    const staleOk: OverviewEngine = {
      generatedAt: ENGINE_NOW_ISO,
      section: { availability: { state: "stale", source: "alertmanager-status", lastGoodAt: null, message: null }, value: { ok: true } },
    };
    expect(rollUpVerdict(input({ overviewEngine: staleOk })))
      .toEqual({ kind: "degraded", contributors: ["engine source alertmanager-status not current"] });
  });

  test("REQ-VERDICT-03 step 3.8(b): the overview string is not duplicated when 3.8(a) already added it", () => {
    const observation = makeObservation({ sources: { "victoriametrics-signals": "stale" } });
    expect(rollUpVerdict(input({ observation, overviewEngine: overview(false) })))
      .toEqual({ kind: "degraded", contributors: ["engine source victoriametrics-signals not current"] });
  });

  test("REQ-VERDICT-03 step 3.8: the guard runs only when steps 3.1–3.7 added nothing (03 open item 4)", () => {
    const observation = makeObservation({ sources: { "gatus-statuses": "stale" } });
    expect(rollUpVerdict(input({ engine: withComponent("vmalert", { state: "unhealthy" }), observation, overviewEngine: overview(false) })))
      .toEqual({ kind: "degraded", contributors: ["vmalert unreachable"] });
  });

  test("REQ-VERDICT-03: an older-cycle overviewEngine that is not OK is ignored (clean payload → ok)", () => {
    expect(rollUpVerdict(input({ overviewEngine: overview(false, "2026-09-24T11:59:45.000Z") }))).toEqual({ kind: "ok" });
    expect(rollUpVerdict(input({ overviewEngine: overview(null, "2026-09-24T11:59:45.000Z") }))).toEqual({ kind: "ok" });
  });

  test("REQ-VERDICT-03: a null overviewEngine is ignored (clean payload → ok)", () => {
    expect(rollUpVerdict(input({ overviewEngine: null }))).toEqual({ kind: "ok" });
  });

  test("REQ-VERDICT-03: a null observation skips 3.8(a) (clean payload → ok)", () => {
    expect(rollUpVerdict(input({ observation: null }))).toEqual({ kind: "ok" });
  });

  test("REQ-VERDICT-01 step 4: an empty list → ok (all-green fixture)", () => {
    expect(rollUpVerdict(input())).toEqual({ kind: "ok" });
  });

  test("REQ-VERDICT-01 step 4: a non-empty list → degraded with the contributors (degraded fixture)", () => {
    expect(rollUpVerdict(input({ engine: degradedEngine() }))).toEqual({
      kind: "degraded",
      contributors: ["vmalert unreachable", "deadman not configured", "2 scrape targets down"],
    });
  });

  test("REQ-VERDICT-03: GOVERNING_SOURCES equals the fold-overview buildEngineSummary id list", () => {
    // Literal copy of packages/web-data/src/cycle/fold-overview.ts buildEngineSummary `ids`.
    const FOLD_OVERVIEW_IDS = [
      "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
      "alertmanager-alerts", "alertmanager-status", "vmalert-rules", "gatus-statuses",
    ];
    expect<readonly string[]>([...GOVERNING_SOURCES]).toEqual(FOLD_OVERVIEW_IDS);
  });
});

// ---------------------------------------------------------------------------------------------
// 03 §3.6 invariants
// ---------------------------------------------------------------------------------------------

describe("rollUpVerdict — 03 §3.6 invariants", () => {
  const CAPACITY_VARIANTS: readonly EnginePayload["capacity"][] = [
    { ingestionRowsPerSecond: null, hourlyActiveSeries: null, dataBytes: null, freeDiskBytes: null, availability: { state: "unavailable", source: "victoriametrics-signals", lastGoodAt: null, message: "down" } },
    { ingestionRowsPerSecond: 0, hourlyActiveSeries: 0, dataBytes: 0, freeDiskBytes: 0, availability: { state: "stale", source: "victoriametrics-signals", lastGoodAt: ENGINE_NOW_ISO, message: null } },
    { ingestionRowsPerSecond: 1e12, hourlyActiveSeries: 1e9, dataBytes: 1e15, freeDiskBytes: 1, availability: { state: "not-configured", source: "victoriametrics-signals", lastGoodAt: null, message: null } },
    { ingestionRowsPerSecond: NaN, hourlyActiveSeries: -1, dataBytes: Infinity, freeDiskBytes: -Infinity, availability: { state: "current", source: "victoriametrics-signals", lastGoodAt: ENGINE_NOW_ISO, message: null } },
  ];

  test("REQ-VERDICT-04 invariant 4: capacity-only changes (values and availability) never alter the result", () => {
    for (const base of [okEngine(), degradedEngine(), makeEnginePayload({ cycle: { degraded: true } })]) {
      const expected = rollUpVerdict(input({ engine: base }));
      for (const capacity of CAPACITY_VARIANTS) {
        expect(rollUpVerdict(input({ engine: { ...base, capacity } }))).toEqual(expected);
      }
    }
  });

  test("REQ-VERDICT-02 invariant 5: grafana not-configured stays OK", () => {
    const engine = withComponent("grafana", { state: "not-configured", availability: { state: "not-configured", lastGoodAt: null } });
    expect(rollUpVerdict(input({ engine }))).toEqual({ kind: "ok" });
  });

  test("REQ-VERDICT-02 invariant 6: okEngine with deadman not configured gives exactly ['deadman not configured']", () => {
    const base = okEngine();
    const engine: EnginePayload = { ...base, deadman: { ...base.deadman, configured: false, state: "not-configured" } };
    expect(contributors(rollUpVerdict(input({ engine })))).toEqual(["deadman not configured"]);
  });

  test("REQ-EFRESH-02 invariant 7: delivery 'stale' with notCurrent false rolls up normally", () => {
    expect(rollUpVerdict(input({ delivery: delivery("stale") }))).toEqual({ kind: "ok" });
    expect(rollUpVerdict(input({ engine: degradedEngine(), delivery: delivery("stale") })))
      .toEqual(rollUpVerdict(input({ engine: degradedEngine() })));
    expect(rollUpVerdict(input({ delivery: delivery("stale"), notCurrent: true }))).toEqual({ kind: "unknown", since: LAST_GOOD_MS });
  });

  test("REQ-VERDICT-02 invariant 8: all steps triggered → contributors in §3.2 step order, components in payload order", () => {
    const base = okEngine();
    const cmp = (id: EngineComponent["id"], state: HealthState, avail: AvailabilityState = "current"): EngineComponent =>
      makeComponent(id, { state, availability: { state: avail } });
    // Payload order deliberately differs from the fixed display order.
    const components = [
      cmp("web", "unhealthy"),
      cmp("gatus", "healthy"),
      cmp("victoriametrics", "healthy", "stale"),
      cmp("grafana", "not-configured", "not-configured"),
      cmp("vmalert", "unknown"),
      cmp("alertmanager", "unhealthy", "stale"),
    ];
    const scrapeJobs: ScrapeJobState[] = base.scrapeJobs.map((j, i) => ({
      ...j, targets: j.targets.map((t, k) => (i === 0 && k === 0) || (i === 2 && k === 1) ? { ...t, health: "down" as const } : t),
    }));
    const engine: EnginePayload = {
      ...base,
      components,
      scrapeJobs,
      ruleGroups: base.ruleGroups.map((g, i) => i === 0 ? g : { ...g, health: "unhealthy" }),
      notifications: {
        ...base.notifications,
        failuresPerSecond: { slack: 0.5, email: 0.25, webhook: 0 },
        availability: { ...base.notifications.availability, state: "stale" },
      },
      cycle: { ...base.cycle, degraded: true, buildFailure: { kind: "hash", view: null, message: "x" } },
      deadman: { ...base.deadman, state: "unhealthy" },
    };
    const observation = makeObservation({ sources: { "victoriametrics-targets": "stale", "gatus-statuses": "stale" } });
    expect(rollUpVerdict(input({ engine, observation, overviewEngine: overview(false) }))).toEqual({
      kind: "degraded",
      contributors: [
        "cycle build failed",
        "publication cycle degraded",
        "Pulse web app unreachable",
        "VictoriaMetrics stale",
        "vmalert stale",
        "Alertmanager unreachable",
        "deadman unhealthy",
        "2 scrape targets down",
        "target discovery not current",
        "3 rule groups failing",
        "notifications failing (email, slack)",
        "notification metrics unavailable",
      ],
    });
  });

  test("REQ-VERDICT-01/REQ-DEGRADE-01 invariant 10: stale before the first payload → unknown; not stale → loading", () => {
    expect(rollUpVerdict(input({ engine: null, delivery: delivery("initial"), notCurrent: true, lastGoodAt: null })))
      .toEqual({ kind: "unknown", since: null });
    expect(rollUpVerdict(input({ engine: null, delivery: delivery("initial"), notCurrent: false })))
      .toEqual({ kind: "loading" });
  });

  test("REQ-SCRAPE-04 step 3.5: the tech-spec heuristic (VM not current + unknown job) marks discovery not current", () => {
    const base = withComponent("victoriametrics", { availability: { state: "unavailable" } });
    const engine: EnginePayload = { ...base, scrapeJobs: base.scrapeJobs.map((j) => ({ ...j, state: "unknown" })) };
    expect(rollUpVerdict(input({ engine })))
      .toEqual({ kind: "degraded", contributors: ["VictoriaMetrics stale", "target discovery not current"] });
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests (seeded, no new dependency)
// ---------------------------------------------------------------------------------------------

/** mulberry32: a tiny deterministic 32-bit PRNG returning floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const HEALTH: readonly HealthState[] = ["healthy", "unhealthy", "unknown", "not-configured"];
const AVAIL: readonly AvailabilityState[] = ["current", "stale", "unavailable", "not-configured"];
const TARGET_HEALTH: readonly ScrapeJobState["targets"][number]["health"][] = ["up", "down", "unknown"];
const COMPONENT_IDS: readonly EngineComponent["id"][] = ["victoriametrics", "vmalert", "alertmanager", "gatus", "grafana", "web"];
const ALL_SOURCES: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];
const OVERVIEW_SOURCES: readonly DataAvailability["source"][] = [...ALL_SOURCES, "rendered-estate"];

interface Gen {
  readonly rnd: () => number;
  readonly pick: <T>(xs: readonly T[]) => T;
  readonly int: (maxExclusive: number) => number;
  readonly bool: (pTrue?: number) => boolean;
}

function gen(seed: number): Gen {
  const rnd = mulberry32(seed);
  const int = (n: number): number => Math.floor(rnd() * n);
  return { rnd, int, pick: (xs) => xs[int(xs.length)]!, bool: (p = 0.5) => rnd() < p };
}

function availability(g: Gen, source: DataAvailability["source"]): DataAvailability {
  const state = g.bool(0.6) ? "current" : g.pick(AVAIL);
  return { state, source, lastGoodAt: g.bool() ? ENGINE_NOW_ISO : null, message: null };
}

/** A random EnginePayload (component states/availabilities, jobs/targets, groups, notification
 *  maps, cycle, deadman), biased toward healthy so the guard is exercised often. */
function randomEngine(g: Gen): EnginePayload {
  const base = okEngine();
  const components = COMPONENT_IDS.map((id) => makComponentRandom(g, id));
  const scrapeJobs: ScrapeJobState[] = [];
  for (let j = 0, n = g.int(4); j < n; j++) {
    const targets = [];
    for (let t = 0, m = g.int(5); t < m; t++) {
      targets.push({
        job: `job-${j}`, instance: `h${t}:9100`, scrapeUrl: `http://h${t}:9100/metrics`,
        health: g.bool(0.8) ? "up" as const : g.pick(TARGET_HEALTH), lastScrapeAt: ENGINE_NOW_ISO, lastError: null,
      });
    }
    scrapeJobs.push({ job: `job-${j}`, targets, state: g.bool(0.8) ? "healthy" : g.pick(HEALTH) });
  }
  const ruleGroups = base.ruleGroups.slice(0, g.int(base.ruleGroups.length + 1))
    .map((rg) => ({ ...rg, health: g.bool(0.8) ? "healthy" as const : g.pick(HEALTH) }));
  const rate = (): number => g.bool(0.8) ? 0 : g.pick([0.5, NaN, Infinity, -1, 2]);
  const failuresPerSecond = g.bool(0.2) ? null : { email: rate(), slack: rate(), webhook: rate() };
  const configured = g.bool(0.85);
  return {
    ...base,
    generatedAt: ENGINE_NOW_ISO,
    components,
    scrapeJobs,
    ruleGroups,
    notifications: { ...base.notifications, failuresPerSecond, availability: availability(g, "victoriametrics-signals") },
    capacity: { ...base.capacity, availability: availability(g, "victoriametrics-signals") },
    cycle: {
      ...base.cycle,
      degraded: g.bool(0.15),
      buildFailure: g.bool(0.1) ? { kind: "fold", view: null, message: "x" } : null,
    },
    deadman: {
      ...base.deadman,
      configured,
      state: configured ? (g.bool(0.8) ? "healthy" : g.pick(HEALTH)) : "not-configured",
      availability: availability(g, "vmalert-rules"),
    },
  };
}

function makComponentRandom(g: Gen, id: EngineComponent["id"]): EngineComponent {
  const c = makeComponent(id);
  return {
    ...c,
    state: g.bool(0.75) ? "healthy" : g.pick(HEALTH),
    availability: { ...c.availability, state: g.bool(0.75) ? "current" : g.pick(AVAIL) },
  };
}

function randomObservation(g: Gen): CycleObservation | null {
  if (g.bool(0.2)) return null;
  const sources: Partial<Record<SourceId, AvailabilityState>> = {};
  for (const id of ALL_SOURCES) sources[id] = g.bool(0.85) ? "current" : g.pick(AVAIL);
  return makeObservation({ sources });
}

/** A same-cycle overview section that is NOT {availability current, value {ok: true}}. */
function notOkOverview(g: Gen, generatedAt: string): OverviewEngine {
  const source = g.pick(OVERVIEW_SOURCES);
  const shape = g.int(4);
  const section: OverviewSnapshotV2["engine"] =
    shape === 0 ? { availability: { state: "current", source, lastGoodAt: ENGINE_NOW_ISO, message: null }, value: { ok: false } }
    : shape === 1 ? { availability: { state: "current", source, lastGoodAt: ENGINE_NOW_ISO, message: null }, value: null }
    : shape === 2 ? { availability: { state: g.pick(AVAIL.slice(1)), source, lastGoodAt: null, message: null }, value: { ok: true } }
    : { availability: { state: g.pick(AVAIL.slice(1)), source, lastGoodAt: null, message: null }, value: g.bool() ? null : { ok: false } };
  return { section, generatedAt };
}

describe("rollUpVerdict — seeded property tests", () => {
  test("REQ-VERDICT-03 invariant 1: 500 random payloads with a same-cycle non-OK overviewEngine all give 'degraded'", () => {
    const g = gen(0x5eed_0006);
    let guardOnly = 0;
    for (let i = 0; i < 500; i++) {
      // A quarter of the cases start from a clean payload, so the 3.8 guard alone must hold them Degraded.
      const engine = g.bool(0.25) ? { ...okEngine(), capacity: randomEngine(g).capacity } : randomEngine(g);
      const observation = randomObservation(g);
      const overviewEngine = notOkOverview(g, engine.generatedAt);
      const v = rollUpVerdict(input({ engine, observation, overviewEngine, notCurrent: false, delivery: delivery(g.pick(["current", "stale"] as const)) }));
      if (v.kind !== "degraded") {
        throw new Error(`counter-example #${i}: ${JSON.stringify({ engine, observation, overviewEngine, v })}`);
      }
      expect(v.contributors.length).toBeGreaterThan(0);
      if (v.contributors.every((c) => c.startsWith("engine source "))) guardOnly += 1;
    }
    // The generator must actually reach the guard path, not only the payload contributors.
    expect(guardOnly).toBeGreaterThan(20);
  });

  test("REQ-VERDICT-03 invariant 2: any non-current GOVERNING_SOURCES entry in a non-null observation → not ok", () => {
    const g = gen(0x0b5e_4ae1);
    for (let i = 0; i < 500; i++) {
      const engine = randomEngine(g);
      const bad = g.pick(GOVERNING_SOURCES);
      const sources: Partial<Record<SourceId, AvailabilityState>> = { [bad]: g.pick(AVAIL.slice(1)) };
      const observation = makeObservation({ sources });
      const overviewEngine = g.bool() ? null : overview(g.bool(), g.bool() ? engine.generatedAt : "2020-01-01T00:00:00.000Z");
      expect(rollUpVerdict(input({ engine, observation, overviewEngine })).kind).not.toBe("ok");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// presentVerdict (03 §3.5)
// ---------------------------------------------------------------------------------------------

describe("presentVerdict — 03 §3.5", () => {
  test("REQ-EFRESH-03: loading → word Loading, status null, 'Loading engine state…'", () => {
    expect(presentVerdict({ kind: "loading" }, identityFormat)).toEqual({
      word: "Loading", status: null, headline: "Loading engine state…", inline: [], more: 0, all: [],
    });
  });

  test("REQ-VERDICT-05: ok → word OK, status ok, headline 'OK'", () => {
    expect(presentVerdict({ kind: "ok" }, identityFormat)).toEqual({
      word: "OK", status: "ok", headline: "OK", inline: [], more: 0, all: [],
    });
  });

  test("REQ-VERDICT-05: unknown with since → headline names formatIso(ISO of since)", () => {
    const seen: string[] = [];
    const p = presentVerdict({ kind: "unknown", since: LAST_GOOD_MS }, (iso) => { seen.push(iso); return "11:58 CDT"; });
    expect(seen).toEqual([new Date(LAST_GOOD_MS).toISOString()]);
    expect(p).toEqual({
      word: "Unknown", status: "unknown", headline: "Unknown — engine data not current since 11:58 CDT", inline: [], more: 0, all: [],
    });
  });

  test("REQ-VERDICT-05: unknown with null / non-finite / out-of-range since → headline without 'since'", () => {
    for (const since of [null, NaN, Infinity, -Infinity, 1e20]) {
      let called = false;
      const p = presentVerdict({ kind: "unknown", since }, (iso) => { called = true; return iso; });
      expect(p.headline).toBe("Unknown — engine data not current");
      expect(p.word).toBe("Unknown");
      expect(p.status).toBe("unknown");
      expect(called).toBe(false);
    }
  });

  test("REQ-VERDICT-05: degraded with ≤ VERDICT_INLINE_CONTRIBUTORS contributors → all inline, no 'and N more'", () => {
    const all = ["vmalert unreachable", "3 scrape targets down"];
    expect(presentVerdict({ kind: "degraded", contributors: all }, identityFormat)).toEqual({
      word: "Degraded", status: "warning", headline: "Degraded — vmalert unreachable; 3 scrape targets down", inline: all, more: 0, all,
    });
    const three = ["a", "b", "c"];
    expect(VERDICT_INLINE_CONTRIBUTORS).toBe(3);
    const p3 = presentVerdict({ kind: "degraded", contributors: three }, identityFormat);
    expect(p3.headline).toBe("Degraded — a; b; c");
    expect(p3.more).toBe(0);
  });

  test("REQ-VERDICT-05: degraded with more than VERDICT_INLINE_CONTRIBUTORS → '; and N more', status warning (not critical)", () => {
    const all = ["cycle build failed", "vmalert unreachable", "deadman not configured", "2 scrape targets down", "1 rule groups failing"];
    const p = presentVerdict({ kind: "degraded", contributors: all }, identityFormat);
    expect(p).toEqual({
      word: "Degraded",
      status: "warning",
      headline: "Degraded — cycle build failed; vmalert unreachable; deadman not configured; and 2 more",
      inline: all.slice(0, VERDICT_INLINE_CONTRIBUTORS),
      more: 2,
      all,
    });
  });

  test("REQ-VERDICT-05: the degraded fixture's banner text names each contributor", () => {
    const p = presentVerdict(rollUpVerdict(input({ engine: degradedEngine() })), identityFormat);
    expect(p.headline).toBe("Degraded — vmalert unreachable; deadman not configured; 2 scrape targets down");
  });
});

// ---------------------------------------------------------------------------------------------
// No-throw corpus (03 §6; 08 §3.1): verdict.ts on every ENGINE_OUT_OF_CONTRACT entry
// ---------------------------------------------------------------------------------------------

describe("verdict.ts no-throw corpus", () => {
  const observations: readonly (CycleObservation | null)[] = [null, currentObservation(), makeObservation({ sources: { "victoriametrics-targets": "stale", "gatus-statuses": "unavailable" } })];

  for (const { name, payload } of ENGINE_OUT_OF_CONTRACT) {
    test(`03 §6: rollUpVerdict and presentVerdict do not throw on out-of-contract '${name}'`, () => {
      for (const observation of observations) {
        for (const overviewEngine of [null, overview(false, payload.generatedAt), overview(true, payload.generatedAt)]) {
          for (const notCurrent of [false, true]) {
            const v = rollUpVerdict(input({ engine: payload, observation, overviewEngine, notCurrent }));
            expect(["ok", "degraded", "unknown"]).toContain(v.kind);
            const p = presentVerdict(v, identityFormat);
            expect(typeof p.headline).toBe("string");
          }
        }
      }
    });
  }
});
