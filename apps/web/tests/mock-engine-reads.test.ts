// apps/web/tests/mock-engine-reads.test.ts — the dev mock serves Alertmanager silences (GitHub #32)
// and the history reads (VM `query_range`, Gatus check history).
//
// Before #32 the mock answered `/api/v2/silences` with a 404, the cycle folded Alertmanager as
// unavailable (alerts and silences share one availability), and `/alerts` showed "Alertmanager
// unreachable" in every scenario. The history routes 502'd the same way. These drive the REAL
// `@pulse/web-data` clients and the REAL server runtime over the mock's fetch.

import { mkdir, copyFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";

import type { WebEstateModelV2 } from "@pulse/renderer";
import { scrapeSeriesIdentity } from "@pulse/web-data/queries";
import { createAlertmanagerClient, createGatusClient, createVmClient } from "@pulse/web-data/sources";

import { loadServerConfig } from "../src/server/config.js";
import { MOCK_BASE_URLS, MOCK_ENV, SCENARIO_NAMES, createMockEngine } from "../src/server/dev/mock-engine.js";
import { DEFAULT_SCENARIO_DIR, MockScenarioError, loadScenario } from "../src/server/dev/scenario.js";
import { createServerRuntime } from "../src/server/refresh.js";

const REFERENCE_MODEL = resolve(import.meta.dir, "../../../examples/reference/rendered/web-estate-model.json");
const CLOCK = Date.parse("2026-10-08T12:00:00.000Z");
const ANCHOR = Date.parse("2026-01-01T00:00:00.000Z");

async function engineAt(scenario: string, now = CLOCK) {
  return createMockEngine({ scenario, now: () => now, startedAt: CLOCK });
}

describe("Alertmanager silences (GitHub #32)", () => {
  test("every shipped scenario's silences parse through the real silences client", async () => {
    for (const scenario of SCENARIO_NAMES) {
      const engine = await engineAt(scenario);
      const client = createAlertmanagerClient(MOCK_BASE_URLS.alertmanagerUrl, { fetchImpl: engine.fetchImpl });
      const result = await client.silences();
      expect(result.ok, `${scenario} silences`).toBe(true);
    }
  });

  test("degraded-mix: the silenced alert's silence is served active, re-based onto the scenario clock", async () => {
    const engine = await engineAt("degraded-mix");
    const am = createAlertmanagerClient(MOCK_BASE_URLS.alertmanagerUrl, { fetchImpl: engine.fetchImpl });
    const [silences, alerts] = await Promise.all([am.silences(), am.alerts()]);
    if (!silences.ok || !alerts.ok) throw new Error("expected both reads to succeed");
    expect(silences.data.map((s) => s.state).sort()).toEqual(["active", "expired", "pending"]);

    const silenced = alerts.data.find((a) => a.state === "silenced");
    const active = silences.data.find((s) => s.state === "active");
    expect(silenced?.silencedBy).toEqual([active!.id]);
    // Authored 70 minutes before the anchor, so 70 minutes old at scenario start.
    expect(CLOCK - Date.parse(active!.startsAt)).toBe(70 * 60_000);
    expect(Date.parse(active!.endsAt)).toBeGreaterThan(CLOCK);
  });

  test("a clock at the fixture anchor serves silences.json verbatim", async () => {
    const engine = await createMockEngine({ scenario: "degraded-mix", now: () => ANCHOR, startedAt: ANCHOR });
    const scenario = await loadScenario(DEFAULT_SCENARIO_DIR, "degraded-mix");
    const res = await engine.fetchImpl(`${MOCK_BASE_URLS.alertmanagerUrl}/api/v2/silences`);
    expect(await res.json()).toEqual(scenario.base.silences);
  });

  test("silences.json is optional; a malformed one fails the load", async () => {
    const tmpDir = resolve(DEFAULT_SCENARIO_DIR, `.tmp-silences-${process.pid}`);
    const greenDir = resolve(DEFAULT_SCENARIO_DIR, "all-green");
    try {
      for (const name of ["no-silences", "bad-silences"]) {
        await mkdir(resolve(tmpDir, name), { recursive: true });
        for (const f of ["vm.json", "alertmanager.json", "gatus.json", "vmalert.json"]) {
          await copyFile(resolve(greenDir, f), resolve(tmpDir, name, f));
        }
      }
      expect((await loadScenario(tmpDir, "no-silences")).base.silences).toEqual([]);

      // Valid JSON, but a silence without matchers is not the Alertmanager wire shape.
      await writeFile(resolve(tmpDir, "bad-silences", "silences.json"), '[{"id":"x","status":{"state":"active"}}]');
      let caught: unknown = null;
      try {
        await loadScenario(tmpDir, "bad-silences");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MockScenarioError);
      expect((caught as MockScenarioError).code).toBe("MOCK_SCENARIO_INVALID");
      expect((caught as MockScenarioError).file).toBe("silences.json");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("history reads", () => {
  const window = (seconds: number): string => {
    const end = CLOCK / 1000;
    return `start=${end - seconds}&end=${end}&step=60`;
  };
  const vmFor = async (scenario: string) =>
    createVmClient(MOCK_BASE_URLS.vmUrl, { fetchImpl: (await engineAt(scenario)).fetchImpl });
  const range = { startSeconds: CLOCK / 1000 - 3_600, endSeconds: CLOCK / 1000, stepSeconds: 60 };

  test("the alerts query returns one firing series per current alert, from its start", async () => {
    const vm = await vmFor("degraded-mix");
    const result = await vm.queryRange({
      ...range,
      promql: 'sum by (alertname, severity, host, service, instance) (ALERTS{alertstate="firing"})',
    });
    if (!result.ok) throw new Error("query_range failed");
    const names = result.data.series.map((s) => s.metric["alertname"]).sort();
    expect(names).toEqual(["HypervisorUnreachable", "NasCapacityHigh", "PortalLatencyElevated"]);
    const hv = result.data.series.find((s) => s.metric["alertname"] === "HypervisorUnreachable")!;
    expect(hv.metric).toEqual({
      alertname: "HypervisorUnreachable",
      severity: "critical",
      host: "harbor-hv-01",
      instance: "harbor-hv-01:9633",
    });
    // Fired 19 minutes before the scenario start: firing samples cover only the last 19 minutes.
    expect(hv.samples[0]!.timestampMs).toBeGreaterThanOrEqual(CLOCK - 19 * 60_000);
    expect(hv.samples.every((s) => s.value === 1)).toBe(true);
  });

  test("liveness follows the VM fixture; curated metrics draw a bounded wave; unknown is empty", async () => {
    const vm = await vmFor("degraded-mix");
    const down = await vm.queryRange({
      ...range,
      promql:
        'min((up{job="hypervisor-api",instance="https://harbor-hv-01.nimbus.example/api"} or pulse_agent_up{job="hypervisor-api",instance="https://harbor-hv-01.nimbus.example/api"})) or vector(0/0)',
    });
    if (!down.ok) throw new Error("liveness failed");
    expect(down.data.series[0]!.samples.every((s) => s.value === 0)).toBe(true);

    const cpu = await vm.queryRange({
      ...range,
      promql: 'avg(100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle",job="managed-linux",instance="harbor-web-01"}[5m]))))',
    });
    if (!cpu.ok) throw new Error("cpu failed");
    const values = cpu.data.series[0]!.samples.map((s) => s.value!);
    expect(values.length).toBe(61);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);

    // A host metric bound to the pre-relabel address:port selects nothing the fixture stores.
    const stale = await vm.queryRange({
      ...range,
      promql: 'avg(100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle",job="managed-linux",instance="10.20.0.11:9100"}[5m]))))',
    });
    expect(stale.ok && stale.data.series.length).toBe(0);

    const never = await vm.queryRange({ ...range, promql: 'up{instance="__pulse_no_target__"}' });
    expect(never.ok && never.data.series.length).toBe(0);
  });

  test("a range query honours outages and rejects a malformed window", async () => {
    const engine = await engineAt("degraded-mix", CLOCK + 35_000); // inside the VM outage step
    await expect(engine.fetchImpl(`${MOCK_BASE_URLS.vmUrl}/api/v1/query_range?query=up&${window(600)}`)).rejects.toThrow(
      "mock outage",
    );
    const healthy = await engineAt("degraded-mix");
    const bad = await healthy.fetchImpl(`${MOCK_BASE_URLS.vmUrl}/api/v1/query_range?query=up&start=10&end=5&step=60`);
    expect(bad.status).toBe(400);
  });

  test("Gatus check history serves the endpoint's rows by key; an unknown key is a 404", async () => {
    const engine = await engineAt("degraded-mix");
    const gatus = createGatusClient(MOCK_BASE_URLS.gatusUrl, { fetchImpl: engine.fetchImpl });
    const result = await gatus.endpointHistory("harbor-edge-01_host-harbor-edge-01");
    if (!result.ok) throw new Error("endpoint history failed");
    expect(result.data.results.map((r) => r.success)).toEqual([true, false]);
    expect((await gatus.endpointHistory("estate_dns-nimbus-example")).ok).toBe(true);
    expect((await gatus.endpointHistory("no-such_endpoint")).ok).toBe(false);
  });
});

describe("VM fixtures follow the scrape relabel contract (issue #69)", () => {
  test("every estate-host sample carries the post-relabel job/instance the model's targets produce", async () => {
    const model = JSON.parse(readFileSync(REFERENCE_MODEL, "utf8")) as WebEstateModelV2;
    for (const scenario of SCENARIO_NAMES) {
      const { base } = await loadScenario(DEFAULT_SCENARIO_DIR, scenario);
      let checked = 0;
      for (const sample of base.vm.data?.result ?? []) {
        const host = model.hosts.find((h) => h.name === sample.metric.host);
        if (host === undefined || sample.metric.__name__ === "pulse_deep_health_up") continue;
        const allowed = host.scrapeTargets.map((t) => scrapeSeriesIdentity(host.name, t));
        const own = { job: sample.metric.job ?? "", instance: sample.metric.instance ?? "" };
        expect(allowed, `${scenario}: ${JSON.stringify(sample.metric)}`).toContainEqual(own);
        checked += 1;
      }
      expect(checked, scenario).toBeGreaterThan(0);
    }
  });
});

describe("round trip through createServerRuntime", () => {
  async function runtimeFor(scenario: string) {
    const engine = await createMockEngine({ scenario });
    const config = loadServerConfig({ ...process.env, ...MOCK_ENV, PULSE_WEB_ESTATE_MODEL: REFERENCE_MODEL });
    const runtime = createServerRuntime(config, { fetchImpl: engine.fetchImpl });
    await runtime.runOnce();
    return runtime;
  }

  test("all-green and degraded-mix publish Alertmanager as current (no 'unreachable' notice)", async () => {
    for (const scenario of ["all-green", "degraded-mix"]) {
      const runtime = await runtimeFor(scenario);
      try {
        const alerts = runtime.getContext(null).cycle?.alerts.value;
        expect(alerts?.alertmanager.state, scenario).toBe("current");
      } finally {
        runtime.close();
      }
    }
  });

  test("degraded-mix: alert, check and curated history resolve instead of SOURCE_UNAVAILABLE", async () => {
    const runtime = await runtimeFor("degraded-mix");
    try {
      const { history } = runtime.getContext(null);
      const alerts = await history.alertIntervals({ range: "6h", target: null });
      if (!alerts.ok) throw new Error(`alert history: ${alerts.error.code}`);
      expect(alerts.data.lanes.length).toBe(3);

      const checks = await history.endpointHistory({ endpoint: "harbor-web-01/portal-web", range: "1h" });
      if (!checks.ok) throw new Error(`check history: ${checks.error.code}`);
      expect(checks.data.results.length).toBeGreaterThan(0);
      // The model puts DNS checks in no group; the fixture row says `estate`. Found by name.
      const dns = await history.endpointHistory({ endpoint: "dns:nimbus.example", range: "24h" });
      expect(dns.ok).toBe(true);

      const cpu = await history.query({
        queryId: "host.cpu.utilization",
        target: { kind: "host", id: "host:harbor-web-01" },
        range: "1h",
      });
      if (!cpu.ok) throw new Error(`cpu history: ${cpu.error.code}`);
      expect(cpu.data.series.length).toBe(1);

      // Host liveness binds on the stored job/instance identity (issue #69): the down hypervisor
      // draws a 0 line, healthy managed and NAS hosts draw a 1 line.
      for (const [id, expected] of [
        ["host:harbor-hv-01", 0],
        ["host:harbor-app-02", 1],
        ["host:harbor-web-01", 1],
        ["host:harbor-nas-01", 1],
      ] as const) {
        const live = await history.query({ queryId: "estate.liveness", target: { kind: "host", id }, range: "1h" });
        if (!live.ok) throw new Error(`${id} liveness: ${live.error.code}`);
        expect(live.data.series.length, id).toBe(1);
        const values = live.data.series[0]!.points.map(([, v]) => v);
        expect(values.length, id).toBeGreaterThan(0);
        expect(values.every((v) => v === expected), id).toBe(true);
      }

      const engineSeries = await history.query({ queryId: "engine.active-series", target: null, range: "6h" });
      expect(engineSeries.ok).toBe(true);
    } finally {
      runtime.close();
    }
  });
});
