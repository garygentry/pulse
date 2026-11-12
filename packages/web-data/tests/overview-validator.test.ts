import { describe, expect, test } from "bun:test";

import { OVERVIEW_MAX_RECENT_CHECKS, capRecentChecks, validateOverviewSnapshotV2 } from "../src/wire/index.js";

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

describe("overview validator — recentChecks bound (F1)", () => {
  function check(endpoint: string, minute: number): Record<string, unknown> {
    return {
      target: null,
      endpoint,
      success: true,
      observedAt: new Date(Date.parse(NOW) + minute * 60_000).toISOString(),
      durationMs: 5,
    };
  }

  test("an over-cap list is capped to the newest per endpoint instead of rejecting the body", () => {
    const body = validOverview();
    body.recentChecks = Array.from({ length: 21 }, (_, e) =>
      Array.from({ length: 100 }, (_, m) => check(`probe-${String(e).padStart(2, "0")}`, m))).flat();
    const result = validateOverviewSnapshotV2(body);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recentChecks.length).toBeLessThanOrEqual(OVERVIEW_MAX_RECENT_CHECKS);
    const probe = result.value.recentChecks.filter((item) => item.endpoint === "probe-00");
    expect(probe.at(-1)!.observedAt).toBe(new Date(Date.parse(NOW) + 99 * 60_000).toISOString());
  });

  test("a small endpoint keeps all its results and leaves the slack to the others", () => {
    const capped = capRecentChecks([
      ...Array.from({ length: 2 }, (_, m) => check("small", m)),
      ...Array.from({ length: 10 }, (_, m) => check("big", m)),
    ] as never, 8);
    expect(capped.filter((item) => item.endpoint === "small")).toHaveLength(2);
    expect(capped.filter((item) => item.endpoint === "big").map((item) => item.observedAt))
      .toEqual(Array.from({ length: 6 }, (_, i) => new Date(Date.parse(NOW) + (4 + i) * 60_000).toISOString()));
  });

  test("a list beyond the received ceiling is still refused, naming the field", () => {
    const body = validOverview();
    body.recentChecks = Array.from({ length: OVERVIEW_MAX_RECENT_CHECKS * 4 + 1 }, (_, m) => check("probe", m));
    const result = validateOverviewSnapshotV2(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("recentChecks");
  });
});

describe("overview validator — engine problems (F5)", () => {
  test("accepts and copies bounded problems; a body without them is copied without them", () => {
    const withProblems = validOverview();
    (withProblems.engine as Record<string, unknown>).value = { ok: false, problems: ["2 scrape targets down"] };
    const result = validateOverviewSnapshotV2(withProblems);
    expect(result.ok && result.value.engine.value).toEqual({ ok: false, problems: ["2 scrape targets down"] });
    const legacy = validOverview();
    (legacy.engine as Record<string, unknown>).value = { ok: true };
    const old = validateOverviewSnapshotV2(legacy);
    expect(old.ok && old.value.engine.value).toEqual({ ok: true });
  });

  test("refuses non-string or over-bound problems, naming the field", () => {
    for (const problems of [[1], Array.from({ length: 17 }, () => "x"), "x"]) {
      const body = validOverview();
      (body.engine as Record<string, unknown>).value = { ok: false, problems };
      const result = validateOverviewSnapshotV2(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("engine.problems");
    }
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
