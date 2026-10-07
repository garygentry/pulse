// tests/engine-view-model.test.ts — pure unit tests for views/engine/model.ts, labels.ts and
// scrape-match.ts (03 §2, §4, §5; 08 §3.1). No DOM.

import { describe, expect, test } from "bun:test";
import type {
  CycleObservation,
  DataAvailability,
  EnginePayload,
  HostStatus,
  OverviewSnapshotV2,
  ScrapeJobState,
  ServiceStatus,
} from "@pulse/web-data/wire";

import { createAppStore } from "../src/client/store/index.js";
import * as labels from "../src/client/views/engine/labels.js";
import * as model from "../src/client/views/engine/model.js";
import * as scrapeMatch from "../src/client/views/engine/scrape-match.js";
import {
  type ComponentPresentation,
  componentPresentation,
  deadmanPresentation,
  degradedText,
  engineBoardUrl,
  formatBytes,
  formatCount,
  formatLastGood,
  formatRate,
  formatSeconds,
  formatTileValue,
  formatUptime,
  formatVersion,
  NO_LAST_GOOD,
  NOT_REPORTED,
  PRESENTATION_ICON,
  toStatus,
  UNAVAILABLE,
} from "../src/client/views/engine/labels.js";
import { HEALTH_STATUS } from "../src/client/status/target-status.js";
import {
  canaryRule,
  capacityTiles,
  deriveGrafanaBase,
  notificationSection,
  overviewEngineOf,
  readConnectionPhase,
  readEngine,
  readEngineDelivery,
  readLastGoodAt,
  readObservation,
  readSnapshot,
  ruleGroupRows,
  ruleSection,
  scrapeCounts,
  scrapeDiscovery,
  scrapeJobRows,
  scrapeSection,
  type ScrapeDiscovery,
  type ScrapeTarget,
} from "../src/client/views/engine/model.js";
import {
  estateHostPath,
  matchScrapeInstanceToHost,
  splitInstance,
} from "../src/client/views/engine/scrape-match.js";
import {
  delivery,
  ENGINE_NOW_ISO,
  ENGINE_OUT_OF_CONTRACT,
  makeComponent,
  makeEnginePayload,
  makeEngineSnapshot,
  makeObservation,
} from "./engine-fixtures.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LAST_GOOD = "2026-09-24T11:55:00.000Z";
const fmt = (iso: string): string => `<${iso}>`;

function target(instance: string, health: string): ScrapeTarget {
  return {
    job: "j", instance, scrapeUrl: null, health, lastScrapeAt: ENGINE_NOW_ISO, lastError: null,
  } as unknown as ScrapeTarget;
}

function job(name: string, state: string, healths: readonly string[]): ScrapeJobState {
  return {
    job: name,
    state,
    targets: healths.map((h, i) => target(`${name}-${i}:9100`, h)),
  } as unknown as ScrapeJobState;
}

const CURRENT_DISCOVERY: ScrapeDiscovery = {
  current: true,
  availability: { state: "current", source: "victoriametrics-targets", lastGoodAt: ENGINE_NOW_ISO, message: null },
};
const STALE_DISCOVERY: ScrapeDiscovery = {
  current: false,
  availability: { state: "stale", source: "victoriametrics-targets", lastGoodAt: LAST_GOOD, message: null },
};

function avail(state: DataAvailability["state"], source: DataAvailability["source"] = "victoriametrics-signals"): DataAvailability {
  return { state, source, lastGoodAt: state === "current" ? ENGINE_NOW_ISO : LAST_GOOD, message: null };
}

/** An engine whose victoriametrics component has the given availability state. */
function engineWithVm(state: DataAvailability["state"], o: { scrapeJobs?: readonly ScrapeJobState[] } = {}): EnginePayload {
  const base = makeEnginePayload();
  return {
    ...base,
    components: base.components.map((c) => c.id === "victoriametrics"
      ? { ...c, availability: { ...c.availability, state, lastGoodAt: state === "current" ? ENGINE_NOW_ISO : LAST_GOOD } }
      : c),
    scrapeJobs: o.scrapeJobs ?? base.scrapeJobs,
  };
}

function hostWith(name: string, addresses: readonly string[], grafana: HostStatus["grafana"] = null, services: readonly ServiceStatus[] = []): HostStatus {
  const base = makeEngineSnapshot().hosts[0]!;
  return { ...base, name, addresses, grafana, services, drilldownId: `host:${name}` };
}

function snapshotWithHosts(hosts: readonly HostStatus[]): OverviewSnapshotV2 {
  return makeEngineSnapshot({ hosts });
}

function service(grafana: ServiceStatus["grafana"]): ServiceStatus {
  return { grafana } as unknown as ServiceStatus;
}

// ---------------------------------------------------------------------------
// Store readers
// ---------------------------------------------------------------------------

describe("model.ts store readers", () => {
  test("REQ-EFRESH-03: readers return store values unchanged (by identity)", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    expect(readEngine(store)).toBeNull();
    expect(readSnapshot(store)).toBeNull();
    expect(readObservation(store)).toBeNull();
    expect(readLastGoodAt(store)).toBeNull();
    expect(readConnectionPhase(store)).toBe("initial");
    expect(readEngineDelivery(store)).toBe(store.connection.value.views.engine);

    const engine = makeEnginePayload();
    const snapshot = makeEngineSnapshot();
    const observation = makeObservation();
    const engineDelivery = delivery("current");
    store.engine.value = engine;
    store.snapshot.value = snapshot;
    store.connection.value = {
      ...store.connection.value,
      phase: "live",
      lastGoodAt: 1_790_251_200_000,
      observation,
      views: { ...store.connection.value.views, engine: engineDelivery },
    };
    expect(readEngine(store)).toBe(engine);
    expect(readSnapshot(store)).toBe(snapshot);
    expect(readObservation(store)).toBe(observation);
    expect(readLastGoodAt(store)).toBe(1_790_251_200_000);
    expect(readConnectionPhase(store)).toBe("live");
    expect(readEngineDelivery(store)).toBe(engineDelivery);
  });

  test("REQ-EFRESH-03: readEngineDelivery falls back to a frozen initial delivery when the engine entry is missing", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const views = { ...store.connection.value.views } as Record<string, unknown>;
    delete views["engine"];
    store.connection.value = { ...store.connection.value, views: views as typeof store.connection.value.views };
    const d = readEngineDelivery(store);
    expect(d).toEqual({ phase: "initial", identity: null, failure: null });
    expect(Object.isFrozen(d)).toBe(true);
  });

  test("REQ-VERDICT-03: overviewEngineOf projects section and generatedAt; null snapshot → null", () => {
    const snap = makeEngineSnapshot({ engineOk: false, generatedAt: "2026-09-24T11:59:00.000Z" });
    expect(overviewEngineOf(snap)).toEqual({ section: snap.engine, generatedAt: "2026-09-24T11:59:00.000Z" });
    expect(overviewEngineOf(snap)?.section).toBe(snap.engine);
    expect(overviewEngineOf(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scrape discovery, counts, rows and section
// ---------------------------------------------------------------------------

describe("model.ts scrape selectors", () => {
  test("REQ-SCRAPE-01: scrapeCounts counts up/down/unknown; out-of-contract health counts unknown", () => {
    expect(scrapeCounts([])).toEqual({ up: 0, down: 0, unknown: 0 });
    expect(scrapeCounts(["up", "down", "unknown", "wobbly", "up", ""].map((h, i) => target(`t${i}`, h))))
      .toEqual({ up: 2, down: 1, unknown: 3 });
  });

  test("REQ-SCRAPE-02: scrapeJobRows is a problem-first stable partition that keeps wire order", () => {
    const jobs = [
      job("a-ok", "healthy", ["up"]),
      job("b-down", "healthy", ["up", "down"]),
      job("c-ok", "healthy", ["up", "up"]),
      job("d-unhealthy", "unhealthy", ["up"]),
      job("e-unknown-target", "healthy", ["unknown"]),
      job("f-ok", "healthy", []),
    ];
    const input = [...jobs];
    const rows = scrapeJobRows(jobs, CURRENT_DISCOVERY);
    expect(rows.map((r) => r.job.job)).toEqual(["b-down", "d-unhealthy", "e-unknown-target", "a-ok", "c-ok", "f-ok"]);
    expect(rows.map((r) => r.problem)).toEqual([true, true, true, false, false, false]);
    expect(rows[0]!.counts).toEqual({ up: 1, down: 1, unknown: 0 });
    expect(rows[0]!.job).toBe(jobs[1]!);
    expect(jobs).toEqual(input);
    expect(rows).not.toBe(jobs);
  });

  test("REQ-SCRAPE-02: stability holds for many equal-key rows", () => {
    const jobs = Array.from({ length: 40 }, (_, i) => job(`j${String(i).padStart(2, "0")}`, i % 3 === 0 ? "unhealthy" : "healthy", ["up"]));
    const rows = scrapeJobRows(jobs, CURRENT_DISCOVERY);
    const problems = jobs.filter((_, i) => i % 3 === 0).map((j) => j.job);
    const healthy = jobs.filter((_, i) => i % 3 !== 0).map((j) => j.job);
    expect(rows.map((r) => r.job.job)).toEqual([...problems, ...healthy]);
  });

  test("REQ-SCRAPE-04: discovery not current forces every job's effectiveState to unknown and problem", () => {
    const jobs = [job("a", "healthy", ["up"]), job("b", "unhealthy", ["down"])];
    const rows = scrapeJobRows(jobs, STALE_DISCOVERY);
    expect(rows.map((r) => r.effectiveState)).toEqual(["unknown", "unknown"]);
    expect(rows.every((r) => r.problem)).toBe(true);
    expect(rows.map((r) => r.job.job)).toEqual(["a", "b"]);
  });

  test("REQ-SCRAPE-04: observation marks victoriametrics-targets stale while the VM component is current → every job unknown", () => {
    const engine = makeEnginePayload();
    const observation = makeObservation({ sources: { "victoriametrics-targets": "stale" } });
    const d = scrapeDiscovery(engine, observation);
    expect(d.current).toBe(false);
    expect(d.availability).toEqual({
      state: "stale", source: "victoriametrics-targets", lastGoodAt: observation.sources["victoriametrics-targets"].lastSuccess, message: null,
    });
    const section = scrapeSection(engine, observation);
    expect(section.state).toBe("rows");
    expect(section.rows.length).toBe(engine.scrapeJobs.length);
    expect(section.rows.every((r) => r.effectiveState === "unknown" && r.problem)).toBe(true);
    expect(section.availability.state).toBe("stale");
  });

  test("REQ-SCRAPE-04: tech-spec heuristic — an unknown job with the VM component not current → every job unknown", () => {
    const base = makeEnginePayload();
    const jobs = base.scrapeJobs.map((j, i) => (i === 0 ? { ...j, state: "unknown" as const } : j));
    const engine = engineWithVm("unavailable", { scrapeJobs: jobs });
    const d = scrapeDiscovery(engine, null);
    expect(d.current).toBe(false);
    expect(d.availability.state).toBe("unavailable");
    expect(d.availability.source).toBe("victoriametrics-targets");
    expect(d.availability.lastGoodAt).toBe(LAST_GOOD);
    const rows = scrapeSection(engine, makeObservation()).rows;
    expect(rows.every((r) => r.effectiveState === "unknown")).toBe(true);
  });

  test("REQ-SCRAPE-04: VM component stale but no job unknown → heuristic does not fire", () => {
    const engine = engineWithVm("stale");
    expect(scrapeDiscovery(engine, makeObservation()).current).toBe(true);
    expect(scrapeDiscovery(engine, null).current).toBe(true);
  });

  test("REQ-SCRAPE-04: a missing victoriametrics-targets entry in a non-null observation is unavailable", () => {
    const obs = makeObservation();
    const sources = { ...obs.sources } as Record<string, unknown>;
    delete sources["victoriametrics-targets"];
    const d = scrapeDiscovery(makeEnginePayload(), { ...obs, sources } as unknown as CycleObservation);
    expect(d.current).toBe(false);
    expect(d.availability.state).toBe("unavailable");
  });

  test("REQ-SCRAPE-04: a missing victoriametrics component counts as not current for the heuristic", () => {
    const base = makeEnginePayload();
    const engine: EnginePayload = {
      ...base,
      components: base.components.filter((c) => c.id !== "victoriametrics"),
      scrapeJobs: [job("x", "unknown", ["unknown"])],
    };
    const d = scrapeDiscovery(engine, null);
    expect(d.current).toBe(false);
    expect(d.availability.lastGoodAt).toBeNull();
  });

  test("REQ-SCRAPE-01: current discovery keeps the wire job state; all-green rows are not problems", () => {
    const section = scrapeSection(makeEnginePayload(), makeObservation());
    expect(section.state).toBe("rows");
    expect(section.rows.every((r) => r.effectiveState === "healthy" && !r.problem)).toBe(true);
    expect(section.availability.state).toBe("current");
  });

  test("REQ-SCRAPE-01/REQ-DEGRADE-01: empty jobs with current discovery → 'empty'; not current → 'unavailable', never 'empty'", () => {
    const empty = { ...makeEnginePayload(), scrapeJobs: [] };
    expect(scrapeSection(empty, makeObservation()).state).toBe("empty");
    const down = scrapeSection(empty, makeObservation({ sources: { "victoriametrics-targets": "unavailable" } }));
    expect(down.state).toBe("unavailable");
    expect(down.rows).toEqual([]);
    expect(down.availability.state).toBe("unavailable");
  });
});

// ---------------------------------------------------------------------------
// Rule groups and canary
// ---------------------------------------------------------------------------

describe("model.ts rule selectors", () => {
  test("REQ-RULE-01: ruleGroupRows is problem-first and stable over wire order", () => {
    const base = makeEnginePayload().ruleGroups;
    const groups = base.map((g, i) => (i === 1 || i === 3 ? { ...g, health: i === 1 ? "unhealthy" as const : "unknown" as const } : g));
    const snapshot = [...groups];
    const rows = ruleGroupRows(groups);
    expect(rows.map((r) => r.group.group)).toEqual([groups[1]!.group, groups[3]!.group, groups[0]!.group, groups[2]!.group]);
    expect(rows.map((r) => r.problem)).toEqual([true, true, false, false]);
    expect(groups).toEqual(snapshot);
    expect(rows.some((r) => "duration" in r || "durationMs" in r)).toBe(false);
  });

  test("REQ-RULE-01/REQ-DEGRADE-01: ruleSection empty → 'empty' when vmalert current, 'unavailable' when not, and when vmalert is missing", () => {
    const base = makeEnginePayload();
    expect(ruleSection(base).state).toBe("rows");
    expect(ruleSection(base).availability.source).toBe("vmalert-rules");
    const empty = { ...base, ruleGroups: [] };
    expect(ruleSection(empty).state).toBe("empty");
    const stale: EnginePayload = {
      ...empty,
      components: empty.components.map((c) => c.id === "vmalert" ? { ...c, availability: { ...c.availability, state: "stale" as const } } : c),
    };
    expect(ruleSection(stale).state).toBe("unavailable");
    const missing: EnginePayload = { ...empty, components: empty.components.filter((c) => c.id !== "vmalert") };
    const s = ruleSection(missing);
    expect(s.state).toBe("unavailable");
    expect(s.availability).toEqual({ state: "unavailable", source: "vmalert-rules", lastGoodAt: null, message: null });
  });

  test("REQ-DEADMAN-01: canaryRule returns the first deadman rule in wire order, or null", () => {
    const engine = makeEnginePayload();
    const r = canaryRule(engine);
    expect(r?.deadman).toBe(true);
    expect(r?.name).toBe("DeadMansSwitch");
    const none = { ...engine, ruleGroups: engine.ruleGroups.map((g) => ({ ...g, rules: g.rules.map((x) => ({ ...x, deadman: false })) })) };
    expect(canaryRule(none)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Notifications and capacity
// ---------------------------------------------------------------------------

describe("model.ts notification and capacity selectors", () => {
  const notif = (
    f: Readonly<Record<string, number>> | null,
    l: Readonly<Record<string, number>> | null,
    state: DataAvailability["state"] = "current",
  ) => ({ failuresPerSecond: f, latencyP95Seconds: l, availability: avail(state) });

  test("REQ-NOTIFY-01: the 03 §2.5 worked example (key union, missing key → not-reported, 0 → value 0)", () => {
    const s = notificationSection(notif({ email: 0, slack: 0.2 }, { slack: 1.4 }));
    expect(s.state).toBe("rows");
    expect(s.rows).toEqual([
      { integration: "email", failuresPerSecond: { kind: "value", value: 0 }, latencyP95Seconds: { kind: "not-reported" } },
      { integration: "slack", failuresPerSecond: { kind: "value", value: 0.2 }, latencyP95Seconds: { kind: "value", value: 1.4 } },
    ]);
  });

  test("REQ-NOTIFY-01: a null map → not-reported for every cell of that column", () => {
    const s = notificationSection(notif(null, { email: 0.4 }));
    expect(s.rows).toEqual([{ integration: "email", failuresPerSecond: { kind: "not-reported" }, latencyP95Seconds: { kind: "value", value: 0.4 } }]);
  });

  test("REQ-NOTIFY-01: NaN / ±Infinity / non-number → not-reported", () => {
    const s = notificationSection(notif({ a: NaN, b: Infinity, c: -Infinity, d: "7" as unknown as number, e: 3 }, null));
    expect(s.rows.map((r) => r.failuresPerSecond)).toEqual([
      { kind: "not-reported" }, { kind: "not-reported" }, { kind: "not-reported" }, { kind: "not-reported" }, { kind: "value", value: 3 },
    ]);
  });

  test("REQ-NOTIFY-01: keys sort by code point", () => {
    const s = notificationSection(notif({ b: 1, B: 1, a: 1 }, { "Z": 1 }));
    expect(s.rows.map((r) => r.integration)).toEqual(["B", "Z", "a", "b"]);
  });

  test("REQ-NOTIFY-01/REQ-DEGRADE-01: availability not current → every cell unavailable (never zero)", () => {
    for (const state of ["stale", "unavailable", "not-configured"] as const) {
      const s = notificationSection(notif({ email: 0 }, { email: 0 }, state));
      expect(s.state).toBe("rows");
      expect(s.rows).toEqual([{ integration: "email", failuresPerSecond: { kind: "unavailable" }, latencyP95Seconds: { kind: "unavailable" } }]);
    }
  });

  test("REQ-NOTIFY-01: no keys → 'none-reported' when current, 'unavailable' when not", () => {
    expect(notificationSection(notif(null, null)).state).toBe("none-reported");
    expect(notificationSection(notif({}, {})).state).toBe("none-reported");
    expect(notificationSection(notif(null, null, "unavailable")).state).toBe("unavailable");
  });

  test("REQ-CAP-01: capacityTiles returns exactly four tiles in ingestion-rate, active-series, data-size, free-disk order", () => {
    const tiles = capacityTiles(makeEnginePayload().capacity);
    expect(tiles.map((t) => t.id)).toEqual(["ingestion-rate", "active-series", "data-size", "free-disk"]);
    expect(tiles.map((t) => t.value)).toEqual([
      { kind: "value", value: 1_250 }, { kind: "value", value: 48_000 },
      { kind: "value", value: 12_884_901_888 }, { kind: "value", value: 214_748_364_800 },
    ]);
    expect(tiles.every((t) => Object.keys(t).sort().join(",") === "id,value")).toBe(true);
  });

  test("REQ-CAP-01: null / non-finite → not-reported, 0 → value 0, availability not current → unavailable", () => {
    const cap = { ingestionRowsPerSecond: 0, hourlyActiveSeries: null, dataBytes: NaN, freeDiskBytes: Infinity, availability: avail("current") };
    expect(capacityTiles(cap).map((t) => t.value)).toEqual([
      { kind: "value", value: 0 }, { kind: "not-reported" }, { kind: "not-reported" }, { kind: "not-reported" },
    ]);
    const stale = capacityTiles({ ...cap, availability: avail("stale") });
    expect(stale.length).toBe(4);
    expect(stale.every((t) => t.value.kind === "unavailable")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Grafana base and engine board link
// ---------------------------------------------------------------------------

describe("model.ts deriveGrafanaBase and labels.ts engineBoardUrl", () => {
  const rows: readonly [string, string, string | null][] = [
    ["https://grafana.example/d/pulse-host?var-host=web1", "pulse-host", "https://grafana.example"],
    ["https://ops.example/grafana/d/pulse-host?var-host=a", "pulse-host", "https://ops.example/grafana"],
    ["javascript:alert(1)//d/x", "x", null],
    ["https://u:p@grafana.example/d/pulse-host", "pulse-host", null],
    ["", "pulse-host", null],
  ];
  for (const [url, boardUid, expected] of rows) {
    test(`REQ-ELINK-01/REQ-SEC-03: ${JSON.stringify(url)} (boardUid ${boardUid}) → ${String(expected)}`, () => {
      const snap = snapshotWithHosts([hostWith("web1", ["10.0.0.5"], { boardUid, url })]);
      expect(deriveGrafanaBase(snap)).toBe(expected);
    });
  }

  test("REQ-ELINK-01: null snapshot, or no grafana links at all → null", () => {
    expect(deriveGrafanaBase(null)).toBeNull();
    expect(deriveGrafanaBase(makeEngineSnapshot())).toBeNull();
  });

  test("REQ-ELINK-01: a malformed first candidate is skipped; host link, then its services, then the next host", () => {
    const snap = snapshotWithHosts([
      hostWith("a", [], { boardUid: "pulse-host", url: "not a url" }, [
        service(null),
        service({ boardUid: "pulse-service", url: "ftp://grafana.example/d/pulse-service" }),
        service({ boardUid: "pulse-service", url: "https://svc.example/g/d/pulse-service?var-x=1#frag" }),
      ]),
      hostWith("b", [], { boardUid: "pulse-host", url: "https://second.example/d/pulse-host" }),
    ]);
    expect(deriveGrafanaBase(snap)).toBe("https://svc.example/g");
  });

  test("REQ-SEC-03: a uid mismatch or a path without /d/ is skipped; query and hash never reach the base", () => {
    const snap = snapshotWithHosts([
      hostWith("a", [], { boardUid: "other", url: "https://wrong.example/d/pulse-host" }),
      hostWith("b", [], { boardUid: "pulse-host", url: "https://nod.example/dash/pulse-host" }),
      hostWith("c", [], { boardUid: "pulse-host", url: "https://ok.example/prefix/d/pulse-host/slug?var-host=secret#x" }),
    ]);
    const base = deriveGrafanaBase(snap);
    expect(base).toBe("https://ok.example/prefix");
    expect(base).not.toContain("secret");
  });

  test("REQ-ELINK-01: engineBoardUrl builds {base}/d/pulse-engine", () => {
    expect(engineBoardUrl("https://grafana.example", makeEnginePayload())).toBe("https://grafana.example/d/pulse-engine");
  });

  test("REQ-ELINK-01/REQ-SEC-03: engineBoardUrl → null for a not-configured Grafana component, a missing one, or a null base", () => {
    const base = makeEnginePayload();
    const notConfigured: EnginePayload = {
      ...base,
      components: base.components.map((c) => c.id === "grafana" ? makeComponent("grafana", { state: "not-configured", availability: { state: "not-configured" } }) : c),
    };
    expect(engineBoardUrl("https://grafana.example", notConfigured)).toBeNull();
    expect(engineBoardUrl("https://grafana.example", { ...base, components: base.components.filter((c) => c.id !== "grafana") })).toBeNull();
    expect(engineBoardUrl(null, base)).toBeNull();
  });

  test("REQ-ELINK-01: an unhealthy Grafana still gets a link", () => {
    const base = makeEnginePayload();
    const down: EnginePayload = { ...base, components: base.components.map((c) => c.id === "grafana" ? { ...c, state: "unhealthy" as const } : c) };
    expect(engineBoardUrl("https://g.example", down)).toBe("https://g.example/d/pulse-engine");
  });
});

// ---------------------------------------------------------------------------
// labels.ts — status mapping and presentation
// ---------------------------------------------------------------------------

describe("labels.ts status mapping and presentation", () => {
  test("REQ-COMP-02: HEALTH_STATUS and toStatus (unmapped → unknown)", () => {
    expect(HEALTH_STATUS).toEqual({ healthy: "ok", unhealthy: "critical", unknown: "unknown", "not-configured": "unknown" });
    expect(toStatus("healthy")).toBe("ok");
    expect(toStatus("unhealthy")).toBe("critical");
    expect(toStatus("unknown")).toBe("unknown");
    expect(toStatus("not-configured")).toBe("unknown");
    expect(toStatus("toString")).toBe("unknown");
    expect(toStatus("exploded")).toBe("unknown");
  });

  const comp = (state: string, availability: DataAvailability["state"] = "current") =>
    ({ ...makeComponent("alertmanager"), state, availability: { ...avail(availability, "alertmanager-alerts") } }) as unknown as Parameters<typeof componentPresentation>[0];

  const expectP = (p: ComponentPresentation, kind: string, status: string, text: string, qualifyValues: boolean) =>
    expect({ kind: p.kind, status: p.status, text: p.text, qualifyValues: p.qualifyValues }).toEqual({ kind, status, text, qualifyValues } as never);

  test("REQ-COMP-02: four HealthStates give four distinct kinds, statuses and texts", () => {
    const ps = (["healthy", "unhealthy", "unknown", "not-configured"] as const).map((s) => componentPresentation(comp(s)));
    expect(new Set(ps.map((p) => p.kind)).size).toBe(4);
    // not-configured shares the unknown status; its icon and word keep the four distinct.
    expect(ps.map((p) => p.status)).toEqual(["ok", "critical", "unknown", "unknown"]);
    expect(new Set(ps.map((p) => `${p.status}/${PRESENTATION_ICON[p.kind]}`)).size).toBe(4);
    expect(new Set(ps.map((p) => p.text)).size).toBe(4);
  });

  test("REQ-COMP-02: 03 §4.3 row — not-configured (any availability) → Not configured / unknown, icon minus", () => {
    expectP(componentPresentation(comp("not-configured", "not-configured")), "not-configured", "unknown", "Not configured", false);
    expectP(componentPresentation(comp("not-configured", "stale"), { viewNotCurrent: true }), "not-configured", "unknown", "Not configured", false);
    expect(PRESENTATION_ICON["not-configured"]).toBe("minus");
    expect(PRESENTATION_ICON["not-configured"]).not.toBe(PRESENTATION_ICON.unknown);
  });

  test("REQ-COMP-02: 03 §4.3 row — healthy + current + view current → Healthy / ok", () => {
    const p = componentPresentation(comp("healthy"));
    expectP(p, "healthy", "ok", "Healthy", false);
    expect(p.lastGoodAt).toBe(ENGINE_NOW_ISO);
  });

  test("REQ-COMP-04/REQ-EFRESH-02: 03 §4.3 row — healthy + not current → Stale; viewNotCurrent downgrades Healthy to Stale", () => {
    const p = componentPresentation(comp("healthy", "stale"));
    expectP(p, "stale", "unknown", "Stale", true);
    expect(p.lastGoodAt).toBe(LAST_GOOD);
    expectP(componentPresentation(comp("healthy"), { viewNotCurrent: true }), "stale", "unknown", "Stale", true);
    expectP(componentPresentation(comp("healthy"), { viewNotCurrent: false }), "healthy", "ok", "Healthy", false);
  });

  test("REQ-COMP-02/04: 03 §4.3 rows — unhealthy → Unreachable, unknown → Unknown; qualifyValues follows currency", () => {
    expectP(componentPresentation(comp("unhealthy")), "unreachable", "critical", "Unreachable", false);
    expectP(componentPresentation(comp("unhealthy", "unavailable")), "unreachable", "critical", "Unreachable", true);
    expectP(componentPresentation(comp("unhealthy"), { viewNotCurrent: true }), "unreachable", "critical", "Unreachable", true);
    expectP(componentPresentation(comp("unknown")), "unknown", "unknown", "Unknown", false);
    expectP(componentPresentation(comp("unknown", "stale")), "unknown", "unknown", "Unknown", true);
  });

  test("REQ-COMP-02: 03 §4.3 row — out-of-contract state → Unknown with qualifyValues", () => {
    expectP(componentPresentation(comp("exploded")), "unknown", "unknown", "Unknown", true);
  });

  test("REQ-DEADMAN-01: deadmanPresentation rows", () => {
    const d = makeEnginePayload().deadman;
    expectP(deadmanPresentation(d), "healthy", "ok", "Healthy", false);
    expectP(deadmanPresentation({ ...d, availability: avail("stale", "vmalert-rules") }), "stale", "unknown", "Stale", true);
    expectP(deadmanPresentation({ ...d, state: "unhealthy" }), "unreachable", "critical", "Not firing", false);
    expectP(deadmanPresentation({ ...d, state: "unknown" }), "unknown", "unknown", "Unknown", false);
    expectP(deadmanPresentation({ ...d, state: "zombie" as never }), "unknown", "unknown", "Unknown", false);
    const nc = deadmanPresentation({ ...d, configured: false, state: "not-configured" });
    expect(nc.kind).toBe("not-configured");
    expect(nc.status).toBe("unknown");
    expect(PRESENTATION_ICON[nc.kind]).toBe("minus");
    expect(nc.text).toBe("Not configured");
    expect(nc.kind).not.toBe(deadmanPresentation(d).kind);
  });
});

// ---------------------------------------------------------------------------
// labels.ts — formatters and degraded text
// ---------------------------------------------------------------------------

describe("labels.ts formatters", () => {
  const numeric: readonly [string, (n: number | null) => string, string][] = [
    ["formatUptime", formatUptime, "0s"],
    ["formatBytes", formatBytes, "0 B"],
    ["formatCount", formatCount, "0"],
    ["formatRate", (n) => formatRate(n, "rows"), "0 rows/s"],
    ["formatSeconds", formatSeconds, "0 ms"],
  ];
  for (const [name, f, zero] of numeric) {
    test(`REQ-COMP-03/REQ-NOTIFY-01/REQ-CAP-01: ${name} → 'not reported' for null/NaN/±Infinity, '${zero}' for 0`, () => {
      for (const bad of [null, NaN, Infinity, -Infinity]) expect(f(bad)).toBe(NOT_REPORTED);
      expect(f(0)).toBe(zero);
    });
  }

  test("REQ-COMP-03: formatVersion → NOT_REPORTED for null and empty; plain text otherwise", () => {
    expect(NOT_REPORTED).toBe("not reported");
    expect(formatVersion(null)).toBe(NOT_REPORTED);
    expect(formatVersion("")).toBe(NOT_REPORTED);
    expect(formatVersion("v1.2.3")).toBe("v1.2.3");
    expect(formatVersion("<b>x</b>")).toBe("<b>x</b>");
  });

  test("REQ-COMP-03: formatTileValue maps value / not-reported / unavailable", () => {
    expect(formatTileValue({ kind: "value", value: 0 }, formatCount)).toBe("0");
    expect(formatTileValue({ kind: "not-reported" }, formatCount)).toBe(NOT_REPORTED);
    expect(formatTileValue({ kind: "unavailable" }, formatCount)).toBe(UNAVAILABLE);
    expect(UNAVAILABLE).toBe("unavailable");
  });

  test("REQ-COMP-01: formatUptime uses the two largest units", () => {
    expect(formatUptime(3 * 86_400 + 4 * 3_600 + 59)).toBe("3d 4h");
    expect(formatUptime(5 * 3_600 + 12 * 60 + 7)).toBe("5h 12m");
    expect(formatUptime(12 * 60 + 5)).toBe("12m 5s");
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(-5)).toBe(NOT_REPORTED);
  });

  test("REQ-CAP-01: formatBytes uses IEC units", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1536 * 1024 * 1024)).toBe("1.5 GiB");
    expect(formatBytes(512 * 1024 * 1024)).toBe("512 MiB");
    expect(formatBytes(12_884_901_888)).toBe("12.0 GiB");
    expect(formatBytes(-1)).toBe(NOT_REPORTED);
  });

  test("REQ-CAP-01/REQ-NOTIFY-01: formatCount, formatRate and formatSeconds", () => {
    expect(formatCount(1_234_567)).toBe("1,234,567");
    expect(formatRate(1_250, "rows")).toBe("1,250 rows/s");
    expect(formatRate(2.345, "failures")).toBe("2.3 failures/s");
    expect(formatRate(0.012345, "failures")).toBe("0.0123 failures/s");
    expect(formatSeconds(0.0005)).toBe("<1 ms");
    expect(formatSeconds(0.42)).toBe("420 ms");
    expect(formatSeconds(1.4)).toBe("1.40 s");
    expect(formatSeconds(90)).toBe("1.5 min");
    expect(formatSeconds(-1)).toBe(NOT_REPORTED);
  });

  test("REQ-COMP-04/REQ-DEGRADE-01: formatLastGood and degradedText", () => {
    expect(formatLastGood(LAST_GOOD, fmt)).toBe(`last good <${LAST_GOOD}>`);
    expect(formatLastGood(null, fmt)).toBe(NO_LAST_GOOD);
    expect(degradedText(avail("current", "alertmanager-alerts"), fmt)).toBeNull();
    expect(degradedText(avail("unavailable", "alertmanager-alerts"), fmt)).toBe(`Alertmanager unavailable — last good <${LAST_GOOD}>`);
    expect(degradedText({ state: "stale", source: "vmalert-rules", lastGoodAt: null, message: null }, fmt)).toBe("vmalert stale — no successful read yet");
    expect(degradedText({ state: "not-configured", source: "grafana-health", lastGoodAt: null, message: null }, fmt)).toBe("Grafana not configured — no successful read yet");
    expect(degradedText({ state: "stale", source: "mystery" as never, lastGoodAt: null, message: null }, fmt)).toBe("mystery stale — no successful read yet");
  });
});

// ---------------------------------------------------------------------------
// scrape-match.ts
// ---------------------------------------------------------------------------

describe("scrape-match.ts", () => {
  const hosts = [
    hostWith("web1", ["10.0.0.5", "fd00::5"]),
    hostWith("db1", ["10.0.0.6"]),
    hostWith("dup-a", ["10.0.0.9"]),
    hostWith("dup-b", ["10.0.0.9"]),
  ];
  const table: readonly [string, string | null][] = [
    ["web1:9100", "web1"],
    ["10.0.0.6:9100", "db1"],
    ["[fd00::5]:9100", "web1"],
    ["fd00::5", "web1"],
    ["10.0.0.9:9100", null],
    ["web1.example:9100", null],
    ["http://web1:9100/metrics", null],
    ["web1:http", null],
    ["", null],
  ];
  for (const [instance, expected] of table) {
    test(`REQ-ELINK-02: matchScrapeInstanceToHost(${JSON.stringify(instance)}) → ${String(expected)}`, () => {
      expect(matchScrapeInstanceToHost(instance, hosts)).toBe(expected);
    });
  }

  test("REQ-ELINK-02: no hosts → null; a host matching by both name and address counts once", () => {
    expect(matchScrapeInstanceToHost("web1:9100", [])).toBeNull();
    expect(matchScrapeInstanceToHost("x:1", [hostWith("x", ["x"])])).toBe("x");
  });

  test("REQ-ELINK-02: splitInstance forms", () => {
    expect(splitInstance("web1:9100")).toEqual({ host: "web1", port: "9100" });
    expect(splitInstance("web1")).toEqual({ host: "web1", port: null });
    expect(splitInstance("[fd00::5]:9100")).toEqual({ host: "fd00::5", port: "9100" });
    expect(splitInstance("[fd00::5]")).toEqual({ host: "fd00::5", port: null });
    expect(splitInstance("fd00::5")).toEqual({ host: "fd00::5", port: null });
    expect(splitInstance("  web1:9100  ")).toEqual({ host: "web1", port: "9100" });
    for (const bad of ["", "   ", "[fd00::5]x", "[fd00::5]:", "[fd00::5]:ab", "[]:9100", "[fd00::5", ":9100", "web1:", "a b", "u@h:1", "h/x"]) {
      expect(splitInstance(bad)).toBeNull();
    }
  });

  test("REQ-SEC-04: estateHostPath encodes the name as one segment", () => {
    expect(estateHostPath("web1")).toBe("/estate/host/web1");
    expect(estateHostPath("a/b?c#d%")).toBe("/estate/host/a%2Fb%3Fc%23d%25");
  });
});

// ---------------------------------------------------------------------------
// No-throw corpus (03 §6)
// ---------------------------------------------------------------------------

describe("no-throw on ENGINE_OUT_OF_CONTRACT (03 §6)", () => {
  /** Call every exported function of the three modules with arguments derived from `p`. */
  function exercise(p: EnginePayload): void {
    const store = createAppStore({ storage: null, initialQuery: {} });
    store.engine.value = p;
    const observation = makeObservation({ sources: { "victoriametrics-targets": "stale" } });
    const snapshot = makeEngineSnapshot({ generatedAt: p.generatedAt });
    const calls: Record<string, () => unknown> = {
      // model.ts
      readEngine: () => model.readEngine(store),
      readEngineDelivery: () => model.readEngineDelivery(store),
      readSnapshot: () => model.readSnapshot(store),
      readObservation: () => model.readObservation(store),
      readLastGoodAt: () => model.readLastGoodAt(store),
      readConnectionPhase: () => model.readConnectionPhase(store),
      overviewEngineOf: () => model.overviewEngineOf(snapshot),
      scrapeDiscovery: () => [model.scrapeDiscovery(p, null), model.scrapeDiscovery(p, observation)],
      scrapeCounts: () => p.scrapeJobs.map((j) => model.scrapeCounts(j.targets)),
      scrapeJobRows: () => [model.scrapeJobRows(p.scrapeJobs, CURRENT_DISCOVERY), model.scrapeJobRows(p.scrapeJobs, STALE_DISCOVERY)],
      scrapeSection: () => [model.scrapeSection(p, null), model.scrapeSection(p, observation)],
      ruleGroupRows: () => model.ruleGroupRows(p.ruleGroups),
      ruleSection: () => model.ruleSection(p),
      canaryRule: () => model.canaryRule(p),
      notificationSection: () => model.notificationSection(p.notifications),
      capacityTiles: () => model.capacityTiles(p.capacity),
      deriveGrafanaBase: () => model.deriveGrafanaBase(snapshot),
      // labels.ts
      toStatus: () => p.ruleGroups.map((g) => labels.toStatus(g.health)),
      componentPresentation: () => p.components.flatMap((c) => [labels.componentPresentation(c), labels.componentPresentation(c, { viewNotCurrent: true })]),
      deadmanPresentation: () => labels.deadmanPresentation(p.deadman),
      formatVersion: () => p.components.map((c) => labels.formatVersion(c.version)),
      formatUptime: () => p.components.map((c) => labels.formatUptime(c.uptimeSeconds)),
      formatBytes: () => [labels.formatBytes(p.capacity.dataBytes), labels.formatBytes(p.capacity.freeDiskBytes)],
      formatCount: () => [labels.formatCount(p.capacity.hourlyActiveSeries), labels.formatCount(p.cycle.sequence)],
      formatRate: () => labels.formatRate(p.capacity.ingestionRowsPerSecond, "rows"),
      formatSeconds: () => labels.formatSeconds(p.cycle.durationMs / 1000),
      formatTileValue: () => [
        ...model.capacityTiles(p.capacity).map((t) => labels.formatTileValue(t.value, labels.formatBytes)),
        ...model.notificationSection(p.notifications).rows.map((r) => labels.formatTileValue(r.failuresPerSecond, (n) => labels.formatRate(n, "failures"))),
      ],
      formatLastGood: () => p.components.map((c) => labels.formatLastGood(c.availability.lastGoodAt, fmt)),
      degradedText: () => [...p.components.map((c) => labels.degradedText(c.availability, fmt)), labels.degradedText(p.notifications.availability, fmt)],
      engineBoardUrl: () => labels.engineBoardUrl("https://grafana.example", p),
      // scrape-match.ts
      splitInstance: () => p.scrapeJobs.flatMap((j) => j.targets.map((t) => scrapeMatch.splitInstance(t.instance))),
      matchScrapeInstanceToHost: () => p.scrapeJobs.flatMap((j) => j.targets.map((t) => scrapeMatch.matchScrapeInstanceToHost(t.instance, snapshot.hosts))),
      estateHostPath: () => scrapeMatch.estateHostPath(p.components[0]?.id ?? ""),
    };
    // Every exported function of the three modules is exercised.
    const exported = [
      ...Object.entries(model), ...Object.entries(labels), ...Object.entries(scrapeMatch),
    ].filter(([, v]) => typeof v === "function").map(([k]) => k).sort();
    expect(Object.keys(calls).sort()).toEqual(exported);
    for (const call of Object.values(calls)) call();
  }

  for (const { name, payload } of ENGINE_OUT_OF_CONTRACT) {
    test(`REQ-COMP-03/REQ-DEGRADE-01: every model/labels/scrape-match export survives "${name}"`, () => {
      expect(() => exercise(payload)).not.toThrow();
    });
  }
});

// ---------------------------------------------------------------------------
// Structural guards over views/engine/** (08 §5.1). Plain string/regex checks, not AST analysis.
// Protection set: every .ts/.tsx source under views/engine/ (and no stylesheet there). Non-goals: test
// files, type-only /wire imports.
// ---------------------------------------------------------------------------

describe("structural guards", () => {
  const ENGINE_ROOT = new URL("../src/client/views/engine/", import.meta.url).pathname;

  async function engineSources(): Promise<readonly { readonly rel: string; readonly text: string }[]> {
    const out: { rel: string; text: string }[] = [];
    for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: ENGINE_ROOT })) {
      out.push({ rel, text: await Bun.file(ENGINE_ROOT + rel).text() });
    }
    return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  }

  /** Every import/export specifier in a source (static, side-effect and dynamic forms). */
  function specifiers(text: string): string[] {
    const out: string[] = [];
    const re = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1]!);
    return out;
  }

  test("the guards scan a non-empty file set that includes view.tsx and model.ts", async () => {
    const rels = (await engineSources()).map((s) => s.rel);
    expect(rels).toContain("view.tsx");
    expect(rels).toContain("model.ts");
    expect(rels.length).toBeGreaterThanOrEqual(10);
  });

  test("REQ-SEC-01: no engine source imports the query catalog", async () => {
    const catalog = "@pulse/web-data/" + "queries";
    const offenders = (await engineSources())
      .filter((s) => specifiers(s.text).includes(catalog) || s.text.includes(`from "${catalog}"`) || s.text.includes(`import("${catalog}")`))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("CON-03 / V-002: no engine source uses the generic TimeSeriesChart (charts go through SyncedChart)", async () => {
    const offenders = (await engineSources())
      .filter((s) => /\bTimeSeriesChart\b/.test(s.text) || specifiers(s.text).some((spec) => /viz\/time-series-chart(\.js)?$/.test(spec)))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("REQ-SEC-02: no engine source uses dangerouslySetInnerHTML or assigns innerHTML", async () => {
    const offenders = (await engineSources())
      .filter((s) => s.text.includes("dangerouslySetInnerHTML") || /\binnerHTML\s*=(?!=)/.test(s.text))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("no .css import under views/engine", async () => {
    const cssImports = (await engineSources()).flatMap((s) =>
      specifiers(s.text).filter((spec) => spec.endsWith(".css")).map((spec) => `${s.rel} -> ${spec}`),
    );
    expect(cssImports).toEqual([]);
  });

  test("04 §2.2: no engine .tsx reads store.<signal>.value directly (model.ts readers only)", async () => {
    const offenders = (await engineSources())
      .filter((s) => s.rel.endsWith(".tsx") && /\bstore\.[A-Za-z]+\.value\b/.test(s.text))
      .map((s) => s.rel);
    expect(offenders).toEqual([]);
  });

  test("CON-02: engine/view.css is gone and no stylesheet remains under views/engine", async () => {
    const cssFiles: string[] = [];
    for await (const rel of new Bun.Glob("**/*.css").scan({ cwd: ENGINE_ROOT })) cssFiles.push(rel);
    expect(cssFiles).toEqual([]);
    expect(await Bun.file(ENGINE_ROOT + "view.css").exists()).toBe(false);
  });
});
