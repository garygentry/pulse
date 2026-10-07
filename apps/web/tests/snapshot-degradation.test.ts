// apps/web/tests/snapshot-degradation.test.ts — per-source degradation (SC-2, never-silent-green).
//
// Proves each single-source failure degrades ONLY its own facet, and the safety invariant: NO host
// (or service) resolves `ok` while `sources.alerts.ok === false`. When alerts are unreachable the
// colour is undeterminable, so every cell degrades to `unknown` — the estate can never show a
// silent green while blind to alerts (REQ-STATE-03, REQ-LIVE-04, §3.5 row 2).

import { describe, expect, test } from "bun:test";

import { host, model, ok, down, service } from "./factories.js";
import type { SourceData, BuildConfig } from "../src/server/snapshot/build.js";
import { buildSnapshot } from "../src/server/snapshot/build.js";
import type { LiveSeries } from "../src/server/sources/types.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");

const CFG: BuildConfig = {
  appVersion: "1.0.0",
  timezone: "UTC",
  tzFallback: true,
  grafanaOrigin: "https://grafana.example",
  gatusStaleSeconds: 300,
};

/** A fully-healthy estate: one managed-linux host + one deep-health service, all sources live. */
function healthyModel() {
  return model({
    hosts: [host({ name: "web01" })],
    services: [service({ name: "grafana", host: "web01", deepHealth: true })],
  });
}

const liveSeries: LiveSeries[] = [
  { name: "up", labels: { job: "managed-linux", host: "web01", instance: "web01:9100" }, value: 1 },
  { name: "pulse_agent_up", labels: { host: "web01" }, value: 1 },
  { name: "pulse_deep_health_up", labels: { host: "web01", service: "grafana" }, value: 1 },
];

function healthySources(): SourceData {
  return {
    liveness: { series: liveSeries, health: ok() },
    alerts: { active: [], health: ok() },
    checks: { endpoints: [], health: ok() },
  };
}

describe("baseline — everything green", () => {
  test("all sources ok → host + service resolve ok", () => {
    const snap = buildSnapshot(healthyModel(), healthySources(), NOW, CFG);
    expect(snap.hosts[0]!.status).toBe("ok");
    expect(snap.hosts[0]!.services[0]!.status).toBe("ok");
    expect(snap.hosts[0]!.rollup).toBe("ok");
  });
});

describe("single-source degradation isolates its facet", () => {
  test("metrics (VM) down → host.live=null, status unknown; alerts/checks health untouched", () => {
    const data = healthySources();
    data.liveness = { series: [], health: down("vm unreachable") };
    const snap = buildSnapshot(healthyModel(), data, NOW, CFG);
    expect(snap.hosts[0]!.live).toBeNull();
    expect(snap.hosts[0]!.status).toBe("unknown"); // no positive liveness → never green
    expect(snap.sources.metrics.ok).toBe(false);
    expect(snap.sources.alerts.ok).toBe(true); // OTHER facets stay live
    expect(snap.sources.checks.ok).toBe(true);
  });

  test("checks (Gatus) down → only the checks facet degrades; a metrics-live host stays ok", () => {
    const data = healthySources();
    data.checks = { endpoints: [], health: down("gatus unreachable") };
    const snap = buildSnapshot(healthyModel(), data, NOW, CFG);
    // The managed-linux host + deep-health service derive liveness from metrics, not checks.
    expect(snap.hosts[0]!.status).toBe("ok");
    expect(snap.hosts[0]!.services[0]!.status).toBe("ok");
    expect(snap.sources.checks.ok).toBe(false);
    expect(snap.sources.metrics.ok).toBe(true);
    expect(snap.sources.alerts.ok).toBe(true);
  });
});

describe("SC-2 never-silent-green: alerts unreachable ⇒ nothing green", () => {
  test("NO host or service resolves ok while sources.alerts.ok === false", () => {
    const data = healthySources();
    data.alerts = { active: [], health: down("alertmanager unreachable") }; // blind to alerts
    const snap = buildSnapshot(healthyModel(), data, NOW, CFG);

    expect(snap.sources.alerts.ok).toBe(false);
    for (const h of snap.hosts) {
      expect(h.status).not.toBe("ok");
      expect(h.rollup).not.toBe("ok");
      for (const s of h.services) expect(s.status).not.toBe("ok");
    }
    // Specifically: every cell degrades to unknown (colour undeterminable), not silent green.
    expect(snap.hosts[0]!.status).toBe("unknown");
    expect(snap.hosts[0]!.services[0]!.status).toBe("unknown");
  });

  test("holds even across a multi-host estate with otherwise-live metrics", () => {
    const m = model({
      hosts: [host({ name: "a" }), host({ name: "b" }), host({ name: "c" })],
      services: [],
    });
    const data: SourceData = {
      liveness: {
        series: [
          { name: "pulse_agent_up", labels: { host: "a" }, value: 1 },
          { name: "pulse_agent_up", labels: { host: "b" }, value: 1 },
          { name: "pulse_agent_up", labels: { host: "c" }, value: 1 },
        ],
        health: ok(),
      },
      alerts: { active: [], health: down("am down") },
      checks: { endpoints: [], health: ok() },
    };
    const snap = buildSnapshot(m, data, NOW, CFG);
    expect(snap.hosts.every((h) => h.status === "unknown")).toBe(true);
    expect(snap.hosts.some((h) => h.status === "ok")).toBe(false);
  });
});
