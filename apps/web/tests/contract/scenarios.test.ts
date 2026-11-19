// apps/web/tests/contract/scenarios.test.ts — the view, history and event fixture groups: the scenario set
// each group carries, max-size fixtures sitting exactly at their caps, the raw event transcripts and the
// derived unknown-enum fixtures.
//
// Generation is memoised per process; every case here shares the one `frozen: "report"` generation.

import { describe, expect, test } from "bun:test";

import { CONTRACT_LIMITS, ENUM_FALLBACKS } from "@pulse/web-data/contract";
import { SSE_RETRY_MS } from "@pulse/web-data/wire";

import { GENERATION } from "../../scripts/contract/scenarios/common.js";
import { HISTORY_STATUS } from "../../src/server/routes/history.js";
import { fixtureIndex, generated, GENERATION_TIMEOUT } from "./generated.js";

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();
const FIXTURES = "contract/fixtures/";

async function bytesOf(path: string): Promise<Uint8Array> {
  const file = (await generated()).find((candidate) => candidate.path === FIXTURES + path);
  if (file === undefined) throw new Error(`not generated: ${path}`);
  return file.bytes;
}

// Fixture bodies are read structurally; the assertions below pin the members they touch.
// biome-ignore lint/suspicious/noExplicitAny: decoded JSON under test
async function json(path: string): Promise<any> {
  return JSON.parse(DECODER.decode(await bytesOf(`${path}.json`)));
}

async function text(path: string): Promise<string> {
  return DECODER.decode(await bytesOf(path));
}

async function scenariosOf(group: string): Promise<string[]> {
  const prefix = `${FIXTURES}${group}/`;
  return (await generated())
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => file.path.slice(prefix.length))
    .filter((name) => !name.startsWith("unknown-enum-"))
    .sort();
}

const utf8Bytes = (value: string): number => ENCODER.encode(value).length;

const VIEW_SCENARIOS = [
  "all-optional.json", "bundle-error.json", "empty.json", "error-invalid-request.json", "error-not-ready.json",
  "max-size.json", "typical.json",
];
const HISTORY_ERRORS = Object.keys(HISTORY_STATUS).map((code) => `error-${code.toLowerCase().replaceAll("_", "-")}.json`);
const historyScenarios = (maxSize: readonly string[]): string[] =>
  ["all-optional.json", "bundle-error.json", "empty.json", "typical.json", ...HISTORY_ERRORS, ...maxSize].sort();

describe("scenario sets", () => {
  test("each current view carries the seven shared scenarios; overview adds unknown-fields", async () => {
    expect(await scenariosOf("overview")).toEqual([...VIEW_SCENARIOS, "unknown-fields.json"].sort());
    for (const group of ["alerts", "estate", "timeline"]) expect(await scenariosOf(group)).toEqual(VIEW_SCENARIOS);
  }, GENERATION_TIMEOUT);

  test("each history group carries the response scenarios, its max-size split and every mapped error", async () => {
    expect(HISTORY_ERRORS).toHaveLength(11);
    const points = ["max-size-points.json", "max-size-series.json"];
    expect(await scenariosOf("history-estate")).toEqual(historyScenarios(points));
    expect(await scenariosOf("history-target")).toEqual(historyScenarios(points));
    expect(await scenariosOf("history-alerts")).toEqual(historyScenarios(["max-size-intervals.json", "max-size-lanes.json"]));
    expect(await scenariosOf("history-checks")).toEqual(historyScenarios(["max-size.json"]));
  }, GENERATION_TIMEOUT);

  test("the events group carries tick bodies and raw transcripts", async () => {
    expect(await scenariosOf("events")).toEqual([
      "stream-resume-match.sse", "stream-typical.sse", "stream-unknown-event.sse",
      "tick-typical.json", "tick-unknown-fields.json", "tick-unknown-view.json",
    ]);
  }, GENERATION_TIMEOUT);

  test("history error fixtures carry the route's status for their code", async () => {
    const index = await fixtureIndex();
    for (const group of ["history-estate", "history-target", "history-alerts", "history-checks"]) {
      for (const [code, status] of Object.entries(HISTORY_STATUS)) {
        const scenario = `error-${code.toLowerCase().replaceAll("_", "-")}`;
        const entry = index.fixtures.find((candidate) => candidate.group === group && candidate.scenario === scenario);
        expect(entry).toMatchObject({ kind: "error", status, expect: "accept", webValidator: null });
        expect((await json(`${group}/${scenario}`)).code).toBe(code);
      }
    }
  }, GENERATION_TIMEOUT);

  test("not-ready and bundle-error bodies are the documented errors", async () => {
    for (const group of ["overview", "alerts", "estate", "timeline"]) {
      expect((await json(`${group}/error-not-ready`)).code).toBe("NOT_READY");
      expect(await json(`${group}/bundle-error`)).toMatchObject({ kind: "missing", code: "ESTATE_BUNDLE_MISSING" });
    }
  }, GENERATION_TIMEOUT);
});

describe("max-size fixtures sit exactly at their caps", () => {
  test("overview", async () => {
    const limits = CONTRACT_LIMITS.overview;
    const body = await json("overview/max-size");
    const [host] = body.hosts;
    const [service] = host.services;
    expect(body.hosts).toHaveLength(limits.hosts);
    expect(body.hosts.reduce((sum: number, each: { services: unknown[] }) => sum + each.services.length, 0)).toBe(
      limits.servicesTotal,
    );
    expect(body.alerts).toHaveLength(limits.alerts);
    expect(host.activeAlerts).toHaveLength(limits.alerts);
    expect(service.activeAlerts).toHaveLength(limits.alerts);
    expect(body.signals).toHaveLength(limits.signals);
    expect(body.recentChecks).toHaveLength(limits.recentChecks);
    expect(host.checks).toHaveLength(limits.targetChecks);
    expect(service.checks).toHaveLength(limits.targetChecks);
    expect(host.addresses).toHaveLength(limits.hostAddresses);
    expect(body.engine.value.problems).toHaveLength(limits.engineProblems);
    expect(utf8Bytes(host.name)).toBe(limits.textBytes);
    expect(utf8Bytes(host.drilldownId)).toBe(limits.textBytes);
    expect(utf8Bytes(body.alerts[0].name)).toBe(limits.textBytes);
    expect(utf8Bytes(body.alerts[0].summary)).toBe(limits.messageBytes);
    // Nested caps are filled on one host and one service only.
    expect(body.hosts[1].checks).toHaveLength(0);
    expect(host.services[1].checks).toHaveLength(0);
    expect((await bytesOf("overview/max-size.json")).length).toBeLessThan(CONTRACT_LIMITS.body.plainBytes);
  }, GENERATION_TIMEOUT);

  test("alerts, estate and timeline", async () => {
    const alerts = await json("alerts/max-size");
    expect(alerts.alerts).toHaveLength(CONTRACT_LIMITS.alerts.alerts);
    expect(alerts.rules).toHaveLength(CONTRACT_LIMITS.alerts.rules);
    expect(alerts.silences).toHaveLength(CONTRACT_LIMITS.alerts.silences);

    const estate = await json("estate/max-size");
    expect(estate.liveTargets).toHaveLength(CONTRACT_LIMITS.estate.liveTargets);
    expect(estate.findings.value.findings).toHaveLength(CONTRACT_LIMITS.estate.findings);
    expect(estate.declaredVersusScraped.value).toHaveLength(CONTRACT_LIMITS.estate.declaredVersusScraped);

    const timeline = await json("timeline/max-size");
    expect(timeline.targets).toHaveLength(CONTRACT_LIMITS.timeline.targets);
    expect(timeline.domains).toHaveLength(CONTRACT_LIMITS.timeline.domains);
    expect(timeline.checkHistory.endpoints).toHaveLength(CONTRACT_LIMITS.timeline.checkEndpoints);

    for (const group of ["alerts", "estate", "timeline"]) {
      expect((await bytesOf(`${group}/max-size.json`)).length).toBeLessThan(CONTRACT_LIMITS.body.plainBytes);
    }
  }, GENERATION_TIMEOUT);

  test("history splits a product of two caps into one fixture per cap", async () => {
    const limits = CONTRACT_LIMITS.history;
    for (const group of ["history-estate", "history-target"]) {
      const series = await json(`${group}/max-size-series`);
      expect(series.series).toHaveLength(limits.series);
      expect(series.series[0].points).toHaveLength(1);

      const points = await json(`${group}/max-size-points`);
      expect(points.series).toHaveLength(1);
      expect(points.series[0].points).toHaveLength(limits.pointsPerSeries);
      const labels = Object.entries(points.series[0].labels as Record<string, string>);
      expect(labels).toHaveLength(limits.labels);
      for (const [key, value] of labels) {
        expect(utf8Bytes(key)).toBe(limits.labelKeyBytes);
        expect(utf8Bytes(value)).toBe(limits.labelValueBytes);
      }
    }

    const lanes = await json("history-alerts/max-size-lanes");
    expect(lanes.lanes).toHaveLength(limits.lanes);
    expect(new Set(lanes.lanes.map((lane: { id: string }) => lane.id)).size).toBe(limits.lanes);
    const intervals = await json("history-alerts/max-size-intervals");
    expect(intervals.lanes).toHaveLength(1);
    expect(intervals.lanes[0].intervals).toHaveLength(limits.intervalsPerLane);

    const checks = await json("history-checks/max-size");
    expect(checks.results).toHaveLength(limits.endpointResults);
    expect(checks.incidents).toHaveLength(limits.incidents);
  }, GENERATION_TIMEOUT);
});

describe("event fixtures", () => {
  test("every transcript opens with the retry hint and frames ticks with their event id", async () => {
    const typical = await text("events/stream-typical.sse");
    const tick = await json("events/tick-typical");
    const frames = typical.split("\n\n");
    expect(frames[0]).toBe(`retry: ${SSE_RETRY_MS}`);
    const lines = frames[1]!.split("\n");
    expect(lines.slice(0, 2)).toEqual([`id: ${GENERATION}:1`, "event: tick"]);
    expect(JSON.parse(lines[2]!.slice("data: ".length))).toEqual(tick);
    expect(frames[2]).toBe(": heartbeat");
    expect(frames[3]!.startsWith(`id: ${GENERATION}:2\nevent: tick\n`)).toBe(true);
    expect(typical.endsWith(": heartbeat\n\n")).toBe(true);

    for (const name of ["stream-resume-match", "stream-unknown-event"]) {
      expect((await text(`events/${name}.sse`)).startsWith(`retry: ${SSE_RETRY_MS}\n\n`)).toBe(true);
    }
  }, GENERATION_TIMEOUT);

  test("a resume at the current cycle gets no tick until the next cycle", async () => {
    const frames = (await text("events/stream-resume-match.sse")).split("\n\n");
    expect(frames[1]).toBe(": heartbeat");
    expect(frames[2]!.startsWith(`id: ${GENERATION}:2\nevent: tick\n`)).toBe(true);
  }, GENERATION_TIMEOUT);

  test("the unknown event sits between two ticks", async () => {
    const frames = (await text("events/stream-unknown-event.sse")).split("\n\n");
    expect(frames[2]).toBe(`id: ${GENERATION}:1\nevent: future-event\ndata: {"future":true}`);
    expect(frames[4]!.startsWith(`id: ${GENERATION}:2\nevent: tick\n`)).toBe(true);
  }, GENERATION_TIMEOUT);

  test("forward-compatible ticks add a view and unknown members to the typical tick", async () => {
    const tick = await json("events/tick-typical");
    const view = await json("events/tick-unknown-view");
    expect(view).toEqual({ ...tick, identities: { ...tick.identities, "future-view": tick.identities.overview } });
    const fields = await json("events/tick-unknown-fields");
    expect(fields.futureField).toEqual({ nested: true });
    expect(fields.observation.futureField).toEqual({ nested: true });
    expect(
      Object.values(fields.observation.sources as Record<string, object>).filter((source) => "futureField" in source),
    ).toHaveLength(1);
    const overview = await json("overview/unknown-fields");
    for (const holder of [overview, overview.hosts[0], overview.hosts[0].services[0], overview.alerts[0]]) {
      expect(holder.futureField).toEqual({ nested: true });
    }
  }, GENERATION_TIMEOUT);
});

describe("unknown-enum fixtures", () => {
  /** The fixture group each root type's unknown-enum fixtures belong to. */
  const GROUP_OF_ROOT: Readonly<Record<string, string>> = {
    SessionPayload: "session",
    OverviewSnapshotV2: "overview",
    AlertsPayload: "alerts",
    EstatePayload: "estate",
    TimelinePayload: "timeline",
    HistoryPayload: "history-estate",
    IntervalHistoryPayload: "history-alerts",
    EndpointHistoryPayload: "history-checks",
    LiveTick: "events",
    ErrorEnvelope: "errors",
    BundleErrorBody: "errors",
  };

  test("there is exactly one per enum fallback entry, in the group of its first path's root", async () => {
    const expected = ENUM_FALLBACKS.map(({ group, paths }) => {
      const root = paths[0]!.split(/[.[{(]/)[0]!;
      return `${FIXTURES}${GROUP_OF_ROOT[root]}/unknown-enum-${group}.json`;
    }).sort();
    const actual = (await generated())
      .map((file) => file.path)
      .filter((path) => path.includes("/unknown-enum-"))
      .sort();
    expect(actual).toEqual(expected);
    const index = await fixtureIndex();
    for (const entry of index.fixtures.filter((candidate) => candidate.scenario.startsWith("unknown-enum-"))) {
      expect(entry).toMatchObject({ expect: "accept", webValidator: null });
    }
  }, GENERATION_TIMEOUT);

  test("each differs from its base only by the unknown value at the enum's path", async () => {
    expect((await json("alerts/unknown-enum-alert-state")).alerts[0].state).toBe("future-value");
    expect((await json("alerts/all-optional")).alerts[0].state).not.toBe("future-value");
    expect((await json("errors/unknown-enum-api-error-code")).code).toBe("future-value");
    expect((await json("errors/unknown-enum-bundle-error-kind")).kind).toBe("future-value");
    expect((await json("session/unknown-enum-auth-mode")).authMode).toBe("future-value");
    expect((await json("history-estate/unknown-enum-query-id")).queryId).toBe("future-value");
    expect((await json("history-checks/unknown-enum-interval-state")).incidents[0].state).toBe("future-value");

    // A variant path edits the element of that variant, wherever it sits in the array.
    const estate = await json("estate/unknown-enum-delivery-form");
    const managed = estate.estate.hosts.filter((host: { collectionClass: string }) => host.collectionClass === "managed-linux");
    expect(managed[0].detail.deliveryForm).toBe("future-value");

    // A closed key set gains a key carrying a copy of a known key's value.
    const tick = await json("events/tick-typical");
    const view = await json("events/unknown-enum-view-id");
    expect(view.identities).toEqual({ ...tick.identities, "future-value": tick.identities.alerts });
    expect(view.observation).toEqual(tick.observation);
  }, GENERATION_TIMEOUT);
});
