import { describe, expect, test } from "bun:test";

import { validateOverviewSnapshotV2 } from "../src/wire/index.js";

const NOW = "2026-09-23T00:00:00.000Z";

function validOverview(): Record<string, unknown> {
  const availability = {
    state: "current",
    source: "victoriametrics-signals",
    lastGoodAt: NOW,
    message: null,
  };
  return {
    appVersion: "test",
    generatedAt: NOW,
    estate: { name: "estate", timezone: "UTC", tzFallback: false },
    sources: {
      metrics: { ok: true, lastSuccess: NOW, error: null },
      alerts: { ok: true, lastSuccess: NOW, error: null },
      checks: { ok: true, lastSuccess: NOW, error: null },
    },
    hosts: [{
      name: "host-a",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.1"],
      drilldownId: "host:host-a",
      suppressed: null,
      status: "ok",
      statusEvidence: { status: "ok", availability },
      rollup: "ok",
      rollupEvidence: { status: "ok", availability },
      live: true,
      activeAlerts: [],
      checks: [],
      grafana: null,
      services: [],
    }],
    alerts: [],
    signals: [],
    recentChecks: [],
    engine: { availability, value: { ok: true } },
    alertCounts: { firing: 0, silenced: 0, inhibited: 0 },
    coverage: {
      availability: { ...availability, source: "rendered-estate" },
      value: { covered: 1, gaps: 0, extras: 0 },
    },
  };
}

describe("validateOverviewSnapshotV2", () => {
  test("accepts and freshly copies a complete bounded body", () => {
    const input = validOverview();
    const result = validateOverviewSnapshotV2(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBe(input);
    expect(result.value.hosts).not.toBe(input.hosts);
    expect(result.value.hosts[0]?.drilldownId).toBe("host:host-a");
  });

  test("accepts a resolved Grafana board with an empty url (no Grafana origin configured)", () => {
    const input = validOverview();
    const hosts = input.hosts as Array<Record<string, unknown>>;
    hosts[0]!.grafana = { boardUid: "pulse-host", url: "" };
    const result = validateOverviewSnapshotV2(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hosts[0]?.grafana).toEqual({ boardUid: "pulse-host", url: "" });
    hosts[0]!.grafana = { boardUid: "", url: "" };
    expect(validateOverviewSnapshotV2(input).ok).toBe(false);
  });

  test("rejects missing required fields and malformed nested evidence without throwing", () => {
    expect(validateOverviewSnapshotV2({ appVersion: "test" }).ok).toBe(false);
    const malformed = validOverview();
    (malformed.hosts as Array<Record<string, unknown>>)[0]!.statusEvidence = {
      status: "ok",
      availability: { state: "current", source: "unknown-source", lastGoodAt: NOW, message: null },
    };
    expect(validateOverviewSnapshotV2(malformed).ok).toBe(false);
    const extra = validOverview();
    extra.unexpected = true;
    expect(validateOverviewSnapshotV2(extra).ok).toBe(false);
    const duplicate = validOverview();
    duplicate.hosts = [(duplicate.hosts as unknown[])[0], (duplicate.hosts as unknown[])[0]];
    expect(validateOverviewSnapshotV2(duplicate).ok).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateOverviewSnapshotV2(cyclic).ok).toBe(false);
  });

  test("rejects wrong scalar, identity, attribution, availability, and count fields", () => {
    const cases: Record<string, unknown>[] = [];
    const negativeCount = validOverview();
    (negativeCount.alertCounts as Record<string, unknown>).firing = -1;
    cases.push(negativeCount);
    const nonFinite = validOverview();
    nonFinite.signals = [{
      target: { kind: "host", id: "host:host-a" }, id: "signal", label: "Signal",
      unit: "scalar", value: Number.NaN,
      availability: { state: "current", source: "victoriametrics-signals", lastGoodAt: NOW, message: null },
    }];
    cases.push(nonFinite);
    const badIdentity = validOverview();
    badIdentity.alerts = [{ fingerprint: "fp", name: "Alert", severity: "warning", startsAt: NOW,
      target: { kind: "machine", id: "host:host-a" } }];
    cases.push(badIdentity);
    const badAttribution = validOverview();
    (badAttribution.hosts as Array<Record<string, unknown>>)[0]!.services = [{
      name: "svc", host: "different-host", managed: true, deepHealth: false,
      drilldownId: "service:host-a/svc", suppressed: null, status: "ok",
      statusEvidence: { status: "ok", availability: { state: "current", source: "victoriametrics-signals", lastGoodAt: NOW, message: null } },
      live: true, activeAlerts: [], checks: [], grafana: null,
    }];
    cases.push(badAttribution);
    const incompleteAvailability = validOverview();
    (incompleteAvailability.engine as Record<string, unknown>).availability = { state: "current" };
    cases.push(incompleteAvailability);
    for (const input of cases) expect(validateOverviewSnapshotV2(input).ok).toBe(false);
  });

  test("rejects arrays and strings beyond the supported envelope", () => {
    const hosts = validOverview();
    hosts.hosts = Array.from({ length: 101 }, () => (validOverview().hosts as unknown[])[0]);
    expect(validateOverviewSnapshotV2(hosts).ok).toBe(false);
    const text = validOverview();
    (text.estate as Record<string, unknown>).name = "x".repeat(513);
    expect(validateOverviewSnapshotV2(text).ok).toBe(false);
  });
});

describe("overview validator — acked marker (REQ-ACK-07)", () => {
  const summary = { fingerprint: "fp", name: "Alert", severity: "warning", startsAt: NOW, target: null };

  function withAlert(alert: Record<string, unknown>): Record<string, unknown> {
    const body = validOverview();
    body.alerts = [alert];
    return body;
  }

  test("accepts acked: true and preserves it", () => {
    const result = validateOverviewSnapshotV2(withAlert({ ...summary, acked: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.alerts[0]!.acked).toBe(true);
  });

  test("rejects acked: false, \"true\" and 1", () => {
    for (const acked of [false, "true", 1]) {
      expect(validateOverviewSnapshotV2(withAlert({ ...summary, acked })).ok).toBe(false);
    }
  });

  test("a body without acked validates unchanged, with no acked key", () => {
    const body = withAlert({ ...summary, summary: "text" });
    const result = validateOverviewSnapshotV2(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.alerts[0] as unknown).toStrictEqual({ ...summary, summary: "text" });
    expect("acked" in result.value.alerts[0]!).toBe(false);
  });

  test("unknown alert keys are still refused", () => {
    expect(validateOverviewSnapshotV2(withAlert({ ...summary, acked: true, ackedBy: "x" })).ok).toBe(false);
  });
});
