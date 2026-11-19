// packages/web-data/tests/cycle/fold-limits.test.ts — the overview body is trimmed to the contract caps
// instead of being emitted over-cap and rejected by the client validator. One cap+1 → cap case per overview
// collection, the string caps, and the November 2026 regression driven through the real `foldOverview`.
// The alerts, estate and timeline folds follow: one cap+1 → cap case per collection, in the trim order.

import { describe, expect, test } from "bun:test";

import { CONTRACT_LIMITS } from "../../src/contract/limits.js";
import type { OverviewLimits } from "../../src/contract/limits.js";
import { foldAlerts } from "../../src/cycle/fold-alerts.js";
import { foldEstate } from "../../src/cycle/fold-estate.js";
import { enforceOverviewLimits, foldOverview } from "../../src/cycle/fold-overview.js";
import { foldTimeline } from "../../src/cycle/fold-timeline.js";
import * as cycleBarrel from "../../src/cycle/index.js";
import { materializeView } from "../../src/cycle/identity.js";
import { validateOverviewSnapshotV2 } from "../../src/wire/overview.js";
import type { CycleSourceRecords, FoldInputs } from "../../src/cycle/records.js";
import type { SourceRecord } from "../../src/sources/types.js";
import type { AlertmanagerAlert, AlertmanagerSilence } from "../../src/sources/alertmanager.js";
import type { ScrapeTargetState } from "../../src/sources/types.js";
import type { VmalertRuleGroup } from "../../src/sources/vmalert.js";
import type { GatusEndpointState } from "../../src/sources/gatus.js";
import type { DataAvailability } from "../../src/wire/common.js";
import type {
  CheckSummary,
  HostStatus,
  LiveSignal,
  OverviewAlertSummary,
  OverviewCheckResult,
  OverviewSnapshotV2,
  ServiceStatus,
} from "../../src/wire/overview.js";
import type { WebEstateModelV2, WebFindingsArtifact } from "@pulse/renderer";

const AT = "2026-01-01T00:00:00.000Z";
const OBSERVED = "2026-01-01T00:00:05.000Z";
const L = CONTRACT_LIMITS.overview;
const UTF8 = new TextEncoder();
const bytes = (value: string): number => UTF8.encode(value).length;
const pad = (n: number, width = 4): string => String(n).padStart(width, "0");

// --- snapshot builders -------------------------------------------------------

const CURRENT: DataAvailability = { state: "current", source: "rendered-estate", lastGoodAt: AT, message: null };

function alert(i: number, over: Partial<OverviewAlertSummary> = {}): OverviewAlertSummary {
  return { fingerprint: `fp-${pad(i)}`, name: "HighCpu", severity: "critical", startsAt: AT, target: null, ...over };
}

function targetCheck(i: number, over: Partial<OverviewCheckResult> = {}): OverviewCheckResult {
  return { endpoint: `probe-${pad(i)}`, success: true, lastEvaluatedAt: AT, ...over };
}

function service(host: string, i: number, over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: `svc-${pad(i)}`,
    host,
    managed: true,
    deepHealth: false,
    drilldownId: `svc:${host}/svc-${pad(i)}`,
    suppressed: null,
    status: "ok",
    statusEvidence: { status: "ok", availability: CURRENT },
    live: true,
    activeAlerts: [],
    checks: [],
    grafana: null,
    ...over,
  };
}

function host(i: number, over: Partial<HostStatus> = {}): HostStatus {
  const name = over.name ?? `host-${pad(i, 3)}`;
  return {
    name,
    collectionClass: "managed-linux",
    addresses: ["192.0.2.10"],
    drilldownId: `host:${name}`,
    suppressed: null,
    status: "ok",
    statusEvidence: { status: "ok", availability: CURRENT },
    rollup: "ok",
    rollupEvidence: { status: "ok", availability: CURRENT },
    live: true,
    activeAlerts: [],
    checks: [],
    grafana: null,
    services: [],
    ...over,
  };
}

function signal(target: LiveSignal["target"], i: number, over: Partial<LiveSignal> = {}): LiveSignal {
  return { target, id: `${target.id}:sig-${pad(i)}`, label: `signal ${i}`, unit: "scalar", value: i, availability: CURRENT, ...over };
}

function recentCheck(endpoint: string, r: number, over: Partial<CheckSummary> = {}): CheckSummary {
  return {
    target: null,
    endpoint,
    success: true,
    observedAt: new Date(Date.parse(AT) + r * 60_000).toISOString(),
    durationMs: 5,
    ...over,
  };
}

function snapshot(over: Partial<OverviewSnapshotV2> = {}): OverviewSnapshotV2 {
  return {
    appVersion: "1.2.3",
    generatedAt: OBSERVED,
    estate: { name: "home", timezone: "UTC", tzFallback: false },
    sources: {
      metrics: { ok: true, lastSuccess: AT, error: null },
      alerts: { ok: true, lastSuccess: AT, error: null },
      checks: { ok: true, lastSuccess: AT, error: null },
    },
    hosts: [host(1, { services: [service("host-001", 1)] })],
    alerts: [],
    signals: [signal({ kind: "host", id: "host:host-001" }, 1)],
    recentChecks: [recentCheck("probe-0001", 0)],
    engine: { availability: CURRENT, value: { ok: true, problems: [] } },
    alertCounts: { firing: 0, silenced: 0, inhibited: 0 },
    coverage: { availability: CURRENT, value: { covered: 1, gaps: 0, extras: 0 } },
    ...over,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Trim, assert the client validator accepts the result, and return it. */
function enforced(input: OverviewSnapshotV2, limits?: OverviewLimits): OverviewSnapshotV2 {
  const out = enforceOverviewLimits(input, limits);
  const verdict = validateOverviewSnapshotV2(out);
  expect(verdict.ok ? "ok" : verdict.message).toBe("ok");
  return out;
}

// ---------------------------------------------------------------------------

describe("enforceOverviewLimits — export and identity", () => {
  test("is exported from the /cycle barrel", () => {
    expect(cycleBarrel.enforceOverviewLimits).toBe(enforceOverviewLimits);
  });

  test("within-cap input returns the identical object reference", () => {
    const s = deepFreeze(snapshot());
    expect(enforceOverviewLimits(s)).toBe(s);
  });

  test("a body exactly at every collection cap returns the identical reference", () => {
    const hosts = Array.from({ length: L.hosts }, (_, h) => {
      const name = `host-${pad(h, 3)}`;
      return host(h, {
        name,
        addresses: h === 0 ? Array.from({ length: L.hostAddresses }, (_, a) => `192.0.2.${a}`) : ["192.0.2.10"],
        activeAlerts: h === 0 ? Array.from({ length: L.alerts }, (_, a) => alert(a)) : [],
        checks: h === 0 ? Array.from({ length: L.targetChecks }, (_, c) => targetCheck(c)) : [],
        services: Array.from({ length: L.servicesTotal / L.hosts }, (_, s) => service(name, s)),
      });
    });
    const s = snapshot({
      hosts,
      alerts: Array.from({ length: L.alerts }, (_, a) => alert(a)),
      signals: Array.from({ length: L.signals }, (_, i) => signal({ kind: "host", id: "host:host-000" }, i)),
      recentChecks: Array.from({ length: L.recentChecks }, (_, i) => recentCheck(`probe-${pad(i % 64)}`, i)),
      engine: { availability: CURRENT, value: { ok: false, problems: Array.from({ length: L.engineProblems }, (_, p) => `problem ${p}`) } },
    });
    expect(enforced(s)).toBe(s);
  });

  test("the real fold output is within caps, so re-enforcing it is a no-op", () => {
    const ov = foldOverview(regressionInputs({ hosts: 3, services: 4, endpoints: 2, results: 2, alerts: 2, commands: 1 }));
    expect(enforceOverviewLimits(ov)).toBe(ov);
  });

  test("never mutates a deep-frozen over-cap input and is idempotent", () => {
    const s = snapshot({
      hosts: Array.from({ length: L.hosts + 1 }, (_, h) => host(h)),
      alerts: Array.from({ length: L.alerts + 1 }, (_, a) => alert(a, { name: "n".repeat(L.textBytes + 1) })),
    });
    const before = structuredClone(s);
    deepFreeze(s);
    const once = enforced(s);
    expect(once).not.toBe(s);
    expect(s).toEqual(before);
    expect(enforceOverviewLimits(once)).toBe(once);
  });

  test("a changed path is new, unchanged subtrees are shared", () => {
    const s = snapshot({ alerts: Array.from({ length: L.alerts + 1 }, (_, a) => alert(a)) });
    const out = enforced(s);
    expect(out.hosts).toBe(s.hosts);
    expect(out.signals).toBe(s.signals);
    expect(out.engine).toBe(s.engine);
    expect(out.alertCounts).toBe(s.alertCounts);
    expect(Object.keys(out).sort()).toEqual(Object.keys(s).sort());
  });

  test("a negative or non-integer cap throws RangeError", () => {
    expect(() => enforceOverviewLimits(snapshot(), { ...L, hosts: -1 })).toThrow(RangeError);
    expect(() => enforceOverviewLimits(snapshot(), { ...L, textBytes: 1.5 })).toThrow(RangeError);
    // The cap is checked where it is applied, so a message cap needs a message to bound.
    const withMessage = snapshot({ coverage: { availability: { ...CURRENT, message: "note" }, value: null } });
    expect(() => enforceOverviewLimits(withMessage, { ...L, messageBytes: -1 })).toThrow(RangeError);
  });
});

describe("enforceOverviewLimits — cap+1 → cap for every overview collection", () => {
  test("hosts: 101 → the first 100 in order", () => {
    const hosts = Array.from({ length: L.hosts + 1 }, (_, h) => host(h));
    const out = enforced(snapshot({ hosts, signals: [] }));
    expect(out.hosts.length).toBe(L.hosts);
    expect(out.hosts.map((h) => h.name)).toEqual(hosts.slice(0, L.hosts).map((h) => h.name));
    expect(out.hosts[0]).toBe(hosts[0]!);
  });

  test("servicesTotal: 301 → 300, cut only at the boundary host", () => {
    const hosts = [
      host(0, { services: Array.from({ length: L.servicesTotal }, (_, s) => service("host-000", s)) }),
      host(1, { services: [service("host-001", 0)] }),
    ];
    const out = enforced(snapshot({ hosts, signals: [] }));
    expect(out.hosts.map((h) => h.services.length)).toEqual([L.servicesTotal, 0]);
    expect(out.hosts[0]).toBe(hosts[0]!);
  });

  test("servicesTotal: one shared budget in host order (200/150/10 → 200/100/0), hosts never dropped", () => {
    const sizes = [200, 150, 10];
    const hosts = sizes.map((n, h) => {
      const name = `host-${pad(h, 3)}`;
      return host(h, { status: "warning", statusEvidence: { status: "warning", availability: CURRENT },
        services: Array.from({ length: n }, (_, s) => service(name, s)) });
    });
    const out = enforced(snapshot({ hosts, signals: [] }));
    expect(out.hosts.map((h) => h.services.length)).toEqual([200, 100, 0]);
    expect(out.hosts[1]!.services.map((s) => s.name)).toEqual(hosts[1]!.services.slice(0, 100).map((s) => s.name));
    expect(out.hosts.map((h) => h.status)).toEqual(["warning", "warning", "warning"]);
  });

  test("alerts: 1025 in the strip → 1024 in strip order; alertCounts stays complete", () => {
    const alerts = Array.from({ length: L.alerts + 1 }, (_, a) => alert(a));
    const s = snapshot({ alerts, alertCounts: { firing: L.alerts + 1, silenced: 0, inhibited: 0 } });
    const out = enforced(s);
    expect(out.alerts.length).toBe(L.alerts);
    expect(out.alerts[0]).toBe(alerts[0]!);
    expect(out.alerts.at(-1)).toBe(alerts[L.alerts - 1]!);
    expect(out.alertCounts).toBe(s.alertCounts);
    expect(out.alertCounts.firing).toBe(L.alerts + 1);
  });

  test("alerts: 1025 activeAlerts on a host and on a service → 1024 each; status and rollup unchanged", () => {
    const many = Array.from({ length: L.alerts + 1 }, (_, a) => alert(a, { target: { kind: "host", id: "host:host-000" } }));
    const critical = { status: "critical", availability: CURRENT } as const;
    const hosts = [host(0, {
      status: "critical", statusEvidence: critical, rollup: "critical", rollupEvidence: critical,
      activeAlerts: many,
      services: [service("host-000", 0, { status: "critical", statusEvidence: critical, activeAlerts: many })],
    })];
    const out = enforced(snapshot({ hosts, signals: [] }));
    expect(out.hosts[0]!.activeAlerts.length).toBe(L.alerts);
    expect(out.hosts[0]!.activeAlerts.at(-1)).toBe(many[L.alerts - 1]!);
    expect(out.hosts[0]!.services[0]!.activeAlerts.length).toBe(L.alerts);
    expect(out.hosts[0]!.status).toBe("critical");
    expect(out.hosts[0]!.rollup).toBe("critical");
    expect(out.hosts[0]!.services[0]!.status).toBe("critical");
  });

  test("signals: 4097 on retained targets → 4096 in order", () => {
    const signals = Array.from({ length: L.signals + 1 }, (_, i) => signal({ kind: "host", id: "host:host-001" }, i));
    const out = enforced(snapshot({ signals }));
    expect(out.signals.length).toBe(L.signals);
    expect(out.signals[0]).toBe(signals[0]!);
    expect(out.signals.at(-1)).toBe(signals[L.signals - 1]!);
  });

  test("signals of a trimmed host or service are dropped before the cap; endpoint signals are kept", () => {
    const hosts = Array.from({ length: L.hosts + 1 }, (_, h) => host(h));
    const trimmedHost = hosts[L.hosts]!;
    const signals: LiveSignal[] = [
      signal({ kind: "host", id: trimmedHost.drilldownId }, 0),
      signal({ kind: "service", id: `svc:${trimmedHost.name}/gone` }, 1),
      signal({ kind: "endpoint", id: "probe-0001" }, 2),
      ...Array.from({ length: L.signals }, (_, i) => signal({ kind: "host", id: hosts[0]!.drilldownId }, i + 3)),
    ];
    const out = enforced(snapshot({ hosts, signals }));
    expect(out.signals.some((s) => s.target.id === trimmedHost.drilldownId)).toBe(false);
    expect(out.signals.some((s) => s.target.kind === "service")).toBe(false);
    expect(out.signals[0]!.target.kind).toBe("endpoint");
    // The two orphans leave before the cap applies, so only one retained signal is cut.
    expect(out.signals.length).toBe(L.signals);
    expect(out.signals.at(-1)).toBe(signals[L.signals + 1]!);
  });

  test("recentChecks: 2049 → 2048, the newest per endpoint, sorted by endpoint then time", () => {
    const perEndpoint = 683; // 3 × 683 = 2049
    const endpoints = ["probe-a", "probe-b", "probe-c"];
    const recentChecks = endpoints.flatMap((e) => Array.from({ length: perEndpoint }, (_, r) => recentCheck(e, r)));
    expect(recentChecks.length).toBe(L.recentChecks + 1);
    const out = enforced(snapshot({ recentChecks }));
    expect(out.recentChecks.length).toBe(L.recentChecks);
    const newest = recentCheck("x", perEndpoint - 1).observedAt;
    for (const e of endpoints) {
      const kept = out.recentChecks.filter((c) => c.endpoint === e);
      expect(kept.length).toBeGreaterThanOrEqual(perEndpoint - 1);
      expect(kept.at(-1)!.observedAt).toBe(newest);
    }
    expect(out.recentChecks.map((c) => c.endpoint)).toEqual([...out.recentChecks.map((c) => c.endpoint)].sort());
  });

  test("targetChecks: 2049 per-target checks on a host and on a service → 2048 each", () => {
    const many = Array.from({ length: L.targetChecks + 1 }, (_, c) => targetCheck(c));
    const hosts = [host(0, { checks: many, services: [service("host-000", 0, { checks: many })] })];
    const out = enforced(snapshot({ hosts, signals: [] }));
    expect(out.hosts[0]!.checks.length).toBe(L.targetChecks);
    expect(out.hosts[0]!.checks.at(-1)).toBe(many[L.targetChecks - 1]!);
    expect(out.hosts[0]!.services[0]!.checks.length).toBe(L.targetChecks);
  });

  test("hostAddresses: 65 → 64", () => {
    const addresses = Array.from({ length: L.hostAddresses + 1 }, (_, a) => `192.0.2.${a}`);
    const out = enforced(snapshot({ hosts: [host(1, { addresses })] }));
    expect(out.hosts[0]!.addresses).toEqual(addresses.slice(0, L.hostAddresses));
  });

  test("engineProblems: 17 → 16", () => {
    const problems = Array.from({ length: L.engineProblems + 1 }, (_, p) => `problem ${p}`);
    const out = enforced(snapshot({ engine: { availability: CURRENT, value: { ok: false, problems } } }));
    expect(out.engine.value!.problems).toEqual(problems.slice(0, L.engineProblems));
    expect(out.engine.value!.ok).toBe(false);
  });

  test("every CONTRACT_LIMITS.overview key has a case above", () => {
    expect(Object.keys(L).sort()).toEqual([
      "alerts", "engineProblems", "hostAddresses", "hosts", "messageBytes", "recentChecks",
      "servicesTotal", "signals", "targetChecks", "textBytes",
    ]);
  });

  test("small caps passed by a caller are honoured", () => {
    const small: OverviewLimits = { ...L, hosts: 1, servicesTotal: 1, alerts: 1, signals: 1, recentChecks: 1,
      targetChecks: 1, hostAddresses: 1, engineProblems: 1 };
    const s = snapshot({
      hosts: [
        host(0, { addresses: ["192.0.2.1", "192.0.2.2"], checks: [targetCheck(0), targetCheck(1)],
          services: [service("host-000", 0), service("host-000", 1)] }),
        host(1),
      ],
      alerts: [alert(0), alert(1)],
      signals: [signal({ kind: "host", id: "host:host-000" }, 0), signal({ kind: "host", id: "host:host-000" }, 1)],
      recentChecks: [recentCheck("probe-a", 0), recentCheck("probe-a", 1)],
      engine: { availability: CURRENT, value: { ok: false, problems: ["a", "b"] } },
    });
    const out = enforceOverviewLimits(s, small);
    expect(out.hosts.length).toBe(1);
    expect(out.hosts[0]!.services.length).toBe(1);
    expect(out.hosts[0]!.addresses.length).toBe(1);
    expect(out.hosts[0]!.checks.length).toBe(1);
    expect(out.alerts.length).toBe(1);
    expect(out.signals.length).toBe(1);
    expect(out.recentChecks).toEqual([recentCheck("probe-a", 1)]);
    expect(out.engine.value!.problems).toEqual(["a"]);
  });
});

describe("enforceOverviewLimits — string caps", () => {
  // 511 ASCII + "é" (2 bytes) = 513 bytes: the é is cut whole.
  const TEXT_OVER = "a".repeat(L.textBytes - 1) + "é";
  const TEXT_CUT = "a".repeat(L.textBytes - 1);
  // 1022 ASCII + "😀" (4 bytes) straddles 1024: the pair is cut whole, never a lone surrogate.
  const MSG_OVER = "m".repeat(L.messageBytes - 2) + "😀";
  const MSG_CUT = "m".repeat(L.messageBytes - 2);
  const overAvailability: DataAvailability = { ...CURRENT, message: MSG_OVER };

  test("the samples are one code point over their cap", () => {
    expect(bytes(TEXT_OVER)).toBe(L.textBytes + 1);
    expect(bytes(MSG_OVER)).toBe(L.messageBytes + 2);
  });

  test("a 3-byte code point at the boundary is cut whole", () => {
    const out = enforced(snapshot({ appVersion: "a".repeat(L.textBytes - 2) + "€x" }));
    expect(out.appVersion).toBe("a".repeat(L.textBytes - 2));
  });

  test("top-level scalars, sources and section availabilities", () => {
    const out = enforced(snapshot({
      appVersion: TEXT_OVER,
      estate: { name: TEXT_OVER, timezone: TEXT_OVER, tzFallback: true },
      sources: {
        metrics: { ok: false, lastSuccess: AT, error: MSG_OVER },
        alerts: { ok: false, lastSuccess: null, error: MSG_OVER },
        checks: { ok: false, lastSuccess: AT, error: MSG_OVER },
      },
      engine: { availability: overAvailability, value: { ok: false, problems: [TEXT_OVER, "short"] } },
      coverage: { availability: overAvailability, value: { covered: 1, gaps: 0, extras: 0 } },
    }));
    expect(out.appVersion).toBe(TEXT_CUT);
    expect(out.estate).toEqual({ name: TEXT_CUT, timezone: TEXT_CUT, tzFallback: true });
    expect(out.sources.metrics).toEqual({ ok: false, lastSuccess: AT, error: MSG_CUT });
    expect(out.sources.alerts.error).toBe(MSG_CUT);
    expect(out.sources.checks.error).toBe(MSG_CUT);
    expect(out.engine.availability.message).toBe(MSG_CUT);
    expect(out.engine.value!.problems).toEqual([TEXT_CUT, "short"]);
    expect(out.coverage.availability.message).toBe(MSG_CUT);
    expect(out.coverage.value).toEqual({ covered: 1, gaps: 0, extras: 0 });
  });

  test("alert fields, in the strip and under a host and a service", () => {
    const over = alert(0, {
      fingerprint: TEXT_OVER, name: TEXT_OVER, summary: MSG_OVER, acked: true,
      target: { kind: "service", id: TEXT_OVER },
    });
    const cut: OverviewAlertSummary = { fingerprint: TEXT_CUT, name: TEXT_CUT, severity: "critical", startsAt: AT,
      target: { kind: "service", id: TEXT_CUT }, summary: MSG_CUT, acked: true };
    const hosts = [host(0, { activeAlerts: [over], services: [service("host-000", 0, { activeAlerts: [over] })] })];
    const out = enforced(snapshot({ hosts, alerts: [over, alert(1)], signals: [] }));
    expect(out.alerts[0]).toEqual(cut);
    expect(out.alerts[1]).toBe(out.alerts[1]!);
    expect("summary" in out.alerts[1]!).toBe(false);
    expect(out.hosts[0]!.activeAlerts[0]).toEqual(cut);
    expect(out.hosts[0]!.services[0]!.activeAlerts[0]).toEqual(cut);
  });

  test("host and service fields; service.host still equals its host's name", () => {
    const longName = "h".repeat(600);
    const suppressed = { class: TEXT_OVER, rationale: MSG_OVER };
    const hosts = [host(0, {
      name: longName,
      drilldownId: TEXT_OVER,
      addresses: [TEXT_OVER, "192.0.2.1"],
      suppressed,
      status: "suppressed",
      statusEvidence: { status: "suppressed", availability: overAvailability },
      rollup: "suppressed",
      rollupEvidence: { status: "suppressed", availability: overAvailability },
      checks: [targetCheck(0, { endpoint: TEXT_OVER, responseTimeMs: 4 })],
      grafana: { boardUid: TEXT_OVER, url: "https://grafana.example.com/d/x" },
      services: [service(longName, 0, {
        name: TEXT_OVER,
        drilldownId: `svc:${TEXT_OVER}`,
        suppressed,
        status: "suppressed",
        statusEvidence: { status: "suppressed", availability: overAvailability },
        checks: [targetCheck(0, { endpoint: TEXT_OVER })],
        grafana: { boardUid: TEXT_OVER, url: "" },
        ingressUrl: "https://pulse.example.com/",
      })],
    })];
    const out = enforced(snapshot({ hosts, signals: [] }));
    const h = out.hosts[0]!;
    const s = h.services[0]!;
    expect(h.name).toBe("h".repeat(L.textBytes));
    expect(s.host).toBe(h.name);
    expect(h.drilldownId).toBe(TEXT_CUT);
    expect(h.addresses).toEqual([TEXT_CUT, "192.0.2.1"]);
    expect(h.suppressed).toEqual({ class: TEXT_CUT, rationale: MSG_CUT });
    expect(h.statusEvidence).toEqual({ status: "suppressed", availability: { ...CURRENT, message: MSG_CUT } });
    expect(h.rollupEvidence.availability.message).toBe(MSG_CUT);
    expect(h.checks).toEqual([{ endpoint: TEXT_CUT, success: true, lastEvaluatedAt: AT, responseTimeMs: 4 }]);
    expect(h.grafana).toEqual({ boardUid: TEXT_CUT, url: "https://grafana.example.com/d/x" });
    expect(s.name).toBe(TEXT_CUT);
    expect(bytes(s.drilldownId)).toBeLessThanOrEqual(L.textBytes);
    expect(s.suppressed).toEqual({ class: TEXT_CUT, rationale: MSG_CUT });
    expect(s.statusEvidence.availability.message).toBe(MSG_CUT);
    expect(s.checks[0]!.endpoint).toBe(TEXT_CUT);
    expect(s.grafana).toEqual({ boardUid: TEXT_CUT, url: "" });
    expect(s.ingressUrl).toBe("https://pulse.example.com/");
  });

  test("an over-cap grafana url becomes \"\" and an over-cap ingressUrl is omitted, never cut", () => {
    const longUrl = `https://pulse.example.com/${"p".repeat(L.messageBytes)}`;
    const hosts = [host(0, {
      grafana: { boardUid: "pulse-host", url: longUrl },
      services: [
        service("host-000", 0, { grafana: { boardUid: "pulse-deephealth", url: longUrl }, ingressUrl: longUrl }),
        service("host-000", 1, { ingressUrl: "https://pulse.example.com/ok" }),
      ],
    })];
    const out = enforced(snapshot({ hosts, signals: [] }));
    expect(out.hosts[0]!.grafana).toEqual({ boardUid: "pulse-host", url: "" });
    expect(out.hosts[0]!.services[0]!.grafana).toEqual({ boardUid: "pulse-deephealth", url: "" });
    expect("ingressUrl" in out.hosts[0]!.services[0]!).toBe(false);
    expect(out.hosts[0]!.services[1]).toBe(hosts[0]!.services[1]!);
  });

  test("signal and recent-check fields", () => {
    const hostTarget = { kind: "host", id: "host:host-001" } as const;
    const out = enforced(snapshot({
      signals: [
        signal(hostTarget, 0, { id: TEXT_OVER, label: TEXT_OVER, value: MSG_OVER, availability: overAvailability }),
        signal({ kind: "endpoint", id: TEXT_OVER }, 1, { id: "endpoint-signal" }),
        signal(hostTarget, 2, { value: true }),
      ],
      recentChecks: [recentCheck(TEXT_OVER, 0, { target: { kind: "endpoint", id: TEXT_OVER } })],
    }));
    expect(out.signals[0]).toEqual({ target: hostTarget, id: TEXT_CUT, label: TEXT_CUT, unit: "scalar", value: MSG_CUT,
      availability: { ...CURRENT, message: MSG_CUT } });
    expect(out.signals[1]!.target).toEqual({ kind: "endpoint", id: TEXT_CUT });
    expect(out.signals[2]!.value).toBe(true);
    expect(out.recentChecks[0]!.endpoint).toBe(TEXT_CUT);
    expect(out.recentChecks[0]!.target).toEqual({ kind: "endpoint", id: TEXT_CUT });
  });

  test("a signal keeps following its target when both ids are truncated alike", () => {
    const longId = `host:${"x".repeat(L.textBytes)}`;
    const hosts = [host(0, { drilldownId: longId }), ...Array.from({ length: L.hosts }, (_, h) => host(h + 1))];
    const out = enforced(snapshot({ hosts, signals: [signal({ kind: "host", id: longId }, 0, { id: "liveness" })] }));
    expect(out.hosts.length).toBe(L.hosts);
    expect(out.signals.length).toBe(1);
    expect(out.signals[0]!.target.id).toBe(out.hosts[0]!.drilldownId);
  });

  test("drilldown ids that collide once truncated: the later host or service is dropped", () => {
    const prefix = "x".repeat(L.textBytes);
    const hosts = [
      host(0, { drilldownId: `${prefix}-a`, services: [
        service("host-000", 0, { drilldownId: `svc-${prefix}-a` }),
        service("host-000", 1, { drilldownId: `svc-${prefix}-b` }),
        service("host-000", 2),
      ] }),
      host(1, { drilldownId: `${prefix}-b`, services: [service("host-001", 0)] }),
      host(2),
    ];
    const out = enforced(snapshot({ hosts, signals: [] }));
    expect(out.hosts.map((h) => h.name)).toEqual(["host-000", "host-002"]);
    expect(out.hosts[0]!.services.map((s) => s.name)).toEqual(["svc-0000", "svc-0002"]);
    expect(out.hosts[1]).toBe(hosts[2]!);
  });

  test("timestamps are never touched", () => {
    const s = snapshot();
    expect(enforceOverviewLimits(s).generatedAt).toBe(OBSERVED);
  });
});

// ---------------------------------------------------------------------------
// November 2026 regression: the real fold on an over-cap estate
// ---------------------------------------------------------------------------

function ok<T>(data: T): SourceRecord<T> {
  return { latest: { attemptedAt: AT, result: { ok: true, data } }, lastGood: { at: AT, data } };
}

interface RegressionSize {
  readonly hosts: number;
  readonly services: number;
  readonly endpoints: number;
  readonly results: number;
  readonly alerts: number;
  /** Scalar command signals per host. */
  readonly commands: number;
}

function regressionInputs(size: RegressionSize): FoldInputs {
  const provenance = { file: "estate.yml", path: "hosts[0]", line: 1, col: 1 };
  const hostName = (h: number): string => `host-${pad(h + 1, 3)}`;
  const hosts: WebEstateModelV2["hosts"] = Array.from({ length: size.hosts }, (_, h) => ({
    name: hostName(h),
    collectionClass: "managed-linux",
    addresses: [`192.0.2.${(h % 250) + 1}`, `2001:db8::${(h + 1).toString(16)}`],
    suppressed: null,
    drilldownId: `host:${hostName(h)}`,
    expectedChurn: false,
    scrapeIntervalClass: null,
    provenance,
    scrapeTargets: [{ job: "node", instance: `192.0.2.${(h % 250) + 1}:9100` }],
    artifacts: [],
    detail: {
      exporterPorts: [9100],
      cadvisor: false,
      heartbeat: true,
      deliveryForm: "compose",
      commandSignals: Array.from({ length: size.commands }, (_, c) => ({
        name: `cmd-${pad(c, 2)}`,
        interval: "1m",
        command: "true",
        credential: null,
        output: "scalar" as const,
        metric: `pulse_command_${pad(c, 2)}`,
        upMetric: `pulse_command_${pad(c, 2)}_up`,
      })),
    },
  }));
  const services: WebEstateModelV2["services"] = Array.from({ length: size.services }, (_, s) => {
    const owner = hostName(s % size.hosts);
    return {
      name: `svc-${pad(s)}`,
      host: owner,
      managed: true,
      deepHealth: false,
      ingressUrl: "https://pulse.example.com",
      suppressed: null,
      drilldownId: `svc:${owner}/svc-${pad(s)}`,
      kind: "dashboard",
      provenance,
      gatusEndpoints: [],
      artifacts: [],
      deepHealthDetail: null,
      backupFreshness: null,
      alerts: [],
    };
  });
  const model: WebEstateModelV2 = {
    formatVersion: 2,
    bundleId: `sha256:${"0123456789abcdef".repeat(4)}`,
    estate: {
      name: "home",
      domains: ["example.com"],
      timezone: "UTC",
      dnsResolver: null,
      retention: null,
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts,
    services,
    channels: [],
    routingOverrides: [],
    suppressions: [],
  };
  const endpoints: GatusEndpointState[] = Array.from({ length: size.endpoints }, (_, e) => ({
    name: `probe-${pad(e, 3)}`,
    group: "probes",
    key: `probes_probe-${e}`,
    identity: `probe-${e}`,
    expected: true,
    results: Array.from({ length: size.results }, (_, r) => ({
      timestamp: new Date(Date.parse(AT) - (size.results - 1 - r) * 60_000).toISOString(),
      success: true,
      durationMs: 5,
      conditionResults: [],
    })),
  }));
  const alerts: AlertmanagerAlert[] = Array.from({ length: size.alerts }, (_, a) => ({
    fingerprint: `fp-${pad(a)}`,
    state: "firing",
    name: "HighCpu",
    severity: "critical",
    startsAt: AT,
    endsAt: "2026-01-02T00:00:00.000Z",
    labels: { alertname: "HighCpu", severity: "critical", host: hostName(0) },
    annotations: { summary: "cpu high" },
    receivers: ["team"],
    silencedBy: [],
    inhibitedBy: [],
    group: null,
  }));
  const records: CycleSourceRecords = {
    "victoriametrics-signals": ok([]),
    "victoriametrics-targets": ok([]),
    "victoriametrics-buildinfo": ok({ version: "1.102.1", startedAt: null }),
    "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>(alerts),
    "alertmanager-silences": ok([]),
    "alertmanager-status": ok({ version: "0.27.0", uptime: null, cluster: { status: "ready", peerCount: null } }),
    "alertmanager-receivers": ok([]),
    "vmalert-rules": ok([]),
    "gatus-statuses": ok<readonly GatusEndpointState[]>(endpoints),
    "grafana-health": ok({ database: "ok", version: "11.4.0" }),
  };
  return { model, coverage: null, findings: null, records, appVersion: "1.2.3", observedAt: OBSERVED };
}

describe("November 2026 regression — an over-cap estate still renders", () => {
  // 120 hosts, 320 services, 300 endpoints × 7 results (2100 recentChecks against a cap of 2048),
  // 120 + 320 liveness + 120 × 32 command signals (4280), and 1100 firing alerts.
  const SIZE: RegressionSize = { hosts: 120, services: 320, endpoints: 300, results: 7, alerts: 1100, commands: 32 };

  test("the fold output is trimmed and validateOverviewSnapshotV2 accepts it", async () => {
    const ov = foldOverview(regressionInputs(SIZE));

    const verdict = validateOverviewSnapshotV2(ov);
    expect(verdict.ok ? "ok" : verdict.message).toBe("ok");

    expect(ov.hosts.length).toBe(L.hosts);
    expect(ov.hosts.map((h) => h.name)).toEqual(Array.from({ length: L.hosts }, (_, h) => `host-${pad(h + 1, 3)}`));
    const serviceCount = ov.hosts.reduce((sum, h) => sum + h.services.length, 0);
    expect(serviceCount).toBeLessThanOrEqual(L.servicesTotal);
    expect(serviceCount).toBeGreaterThan(0);
    expect(ov.signals.length).toBeLessThanOrEqual(L.signals);
    const retained = new Set(ov.hosts.flatMap((h) => [h.drilldownId, ...h.services.map((s) => s.drilldownId)]));
    expect(ov.signals.every((s) => retained.has(s.target.id))).toBe(true);
    expect(ov.recentChecks.length).toBe(L.recentChecks);
    expect(new Set(ov.recentChecks.map((c) => c.endpoint)).size).toBe(SIZE.endpoints);
    expect(ov.alerts.length).toBe(L.alerts);
    expect(ov.hosts[0]!.activeAlerts.length).toBe(L.alerts);
    expect(ov.hosts[0]!.status).toBe("critical");
    // Counts describe the complete estate, never the trimmed lists.
    expect(ov.alertCounts.firing).toBe(SIZE.alerts);

    // Idempotent, and the trimmed body fits the whole-body limits.
    expect(enforceOverviewLimits(ov)).toBe(ov);
    const materialized = await materializeView("overview", null, ov, ov);
    expect(materialized.ok).toBe(true);
  });

  test("the untrimmed shape is what the validator used to reject", () => {
    const over = snapshot({
      hosts: Array.from({ length: SIZE.hosts }, (_, h) => host(h)),
      signals: [],
    });
    expect(validateOverviewSnapshotV2(over).ok).toBe(false);
    expect(validateOverviewSnapshotV2(enforceOverviewLimits(over)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Alerts, estate and timeline folds: cap+1 → cap through the real folds
// ---------------------------------------------------------------------------

/** A small in-cap estate (no Gatus results, alerts or command signals) to grow one collection at a time. */
function foldInputs(hosts: number, services: number): FoldInputs {
  return regressionInputs({ hosts, services, endpoints: 0, results: 0, alerts: 0, commands: 0 });
}

function withRecords(base: FoldInputs, over: Partial<CycleSourceRecords>): FoldInputs {
  return { ...base, records: { ...base.records, ...over } };
}

describe("alerts fold limits", () => {
  const A = CONTRACT_LIMITS.alerts;

  function amAlert(i: number, state: AlertmanagerAlert["state"], severity = "critical"): AlertmanagerAlert {
    return {
      fingerprint: `fp-${pad(i)}`,
      state,
      name: "HighCpu",
      severity,
      startsAt: AT,
      endsAt: "2026-01-02T00:00:00.000Z",
      labels: { alertname: "HighCpu", severity },
      annotations: {},
      receivers: ["team"],
      silencedBy: state === "silenced" ? ["sil-0000"] : [],
      inhibitedBy: state === "inhibited" ? ["fp-0000"] : [],
      group: null,
    };
  }

  function silence(i: number, state: AlertmanagerSilence["state"] = "active"): AlertmanagerSilence {
    return {
      id: `sil-${pad(i)}`,
      matchers: [{ name: "alertname", value: "HighCpu", isRegex: false, isEqual: true }],
      createdBy: "operator",
      comment: "maintenance",
      startsAt: AT,
      endsAt: "2026-01-02T00:00:00.000Z",
      state,
    };
  }

  function ruleGroup(count: number): VmalertRuleGroup {
    return {
      group: "pulse",
      file: "rules.yml",
      family: "pulse",
      intervalSeconds: 60,
      lastEvaluationAt: AT,
      // Reverse name order, so the test shows the trim runs after the sort.
      rules: Array.from({ length: count }, (_, r) => ({
        name: `rule-${pad(count - 1 - r)}`,
        type: "alerting" as const,
        state: "inactive",
        health: "healthy" as const,
        lastEvaluationAt: AT,
        lastError: null,
        labels: {},
        annotations: {},
        deadman: false,
      })),
    };
  }

  function alertsInputs(over: {
    alerts?: readonly AlertmanagerAlert[];
    silences?: readonly AlertmanagerSilence[];
    rules?: number;
  }): FoldInputs {
    return withRecords(foldInputs(1, 1), {
      "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>(over.alerts ?? []),
      "alertmanager-silences": ok<readonly AlertmanagerSilence[]>(over.silences ?? []),
      "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup(over.rules ?? 0)]),
    });
  }

  test("alerts: 1025 → 1024 in sort order; the last inhibited alert goes first", () => {
    // Fed inhibited → silenced → firing, the reverse of the documented order.
    const fed = [
      ...Array.from({ length: 5 }, (_, i) => amAlert(2000 + i, "inhibited")),
      ...Array.from({ length: 20 }, (_, i) => amAlert(1000 + i, "silenced")),
      ...Array.from({ length: A.alerts - 24 }, (_, i) => amAlert(i, "firing")),
    ];
    expect(fed.length).toBe(A.alerts + 1);
    const out = foldAlerts(alertsInputs({ alerts: fed })).alerts;

    expect(out.length).toBe(A.alerts);
    expect(out.map((a) => a.fingerprint)).toEqual([
      ...Array.from({ length: A.alerts - 24 }, (_, i) => `fp-${pad(i)}`),
      ...Array.from({ length: 20 }, (_, i) => `fp-${pad(1000 + i)}`),
      ...Array.from({ length: 4 }, (_, i) => `fp-${pad(2000 + i)}`),
    ]);
    expect(out.filter((a) => a.state === "firing").length).toBe(A.alerts - 24);
    expect(out.filter((a) => a.state === "silenced").length).toBe(20);
  });

  test("alerts: within a state the lowest severity is trimmed first", () => {
    const fed = [
      amAlert(0, "firing", "info"),
      ...Array.from({ length: A.alerts }, (_, i) => amAlert(i + 1, "firing", i % 2 === 0 ? "critical" : "warning")),
    ];
    const out = foldAlerts(alertsInputs({ alerts: fed })).alerts;
    expect(out.length).toBe(A.alerts);
    expect(out.some((a) => a.severity === "info")).toBe(false);
  });

  test("a kept alert may still name a trimmed silence: references are not rewritten", () => {
    const silenced = amAlert(1, "silenced");
    const out = foldAlerts(alertsInputs({
      alerts: [{ ...silenced, silencedBy: [`sil-${pad(A.silences)}`] }],
      silences: Array.from({ length: A.silences + 1 }, (_, i) => silence(i)),
    }));
    expect(out.silences.some((s) => s.id === `sil-${pad(A.silences)}`)).toBe(false);
    expect(out.alerts[0]!.silencedBy).toEqual([`sil-${pad(A.silences)}`]);
  });

  test("rules: 2049 → 2048 in group → family → name order", () => {
    const out = foldAlerts(alertsInputs({ rules: A.rules + 1 })).rules;
    expect(out.length).toBe(A.rules);
    expect(out.map((r) => r.name)).toEqual(Array.from({ length: A.rules }, (_, r) => `rule-${pad(r)}`));
  });

  test("silences: 1025 active → 1024 in startsAt → id order; expired ones never count", () => {
    const fed = [
      silence(9000, "expired"),
      ...Array.from({ length: A.silences + 1 }, (_, i) => silence(A.silences - i)),
    ];
    const out = foldAlerts(alertsInputs({ silences: fed })).silences;
    expect(out.length).toBe(A.silences);
    expect(out.map((s) => s.id)).toEqual(Array.from({ length: A.silences }, (_, i) => `sil-${pad(i)}`));
  });

  test("exactly at every cap nothing is trimmed", () => {
    const out = foldAlerts(alertsInputs({
      alerts: Array.from({ length: A.alerts }, (_, i) => amAlert(i, "firing")),
      silences: Array.from({ length: A.silences }, (_, i) => silence(i)),
      rules: A.rules,
    }));
    expect(out.alerts.length).toBe(A.alerts);
    expect(out.rules.length).toBe(A.rules);
    expect(out.silences.length).toBe(A.silences);
  });

  test("every CONTRACT_LIMITS.alerts key has a case above", () => {
    expect(Object.keys(A).sort()).toEqual(["alerts", "rules", "silences"]);
  });
});

describe("estate fold limits", () => {
  const E = CONTRACT_LIMITS.estate;
  type Finding = WebFindingsArtifact["findings"][number];

  function findingsArtifact(count: number): WebFindingsArtifact {
    return {
      formatVersion: 2,
      bundleId: `sha256:${"0123456789abcdef".repeat(4)}`,
      findings: Array.from({ length: count }, (_, f): Finding => ({
        severity: "warning",
        code: "unknown_field",
        file: "estate.yml",
        path: `hosts[${f}].extra`,
        message: `unknown field ${f}`,
        fix: "remove it",
      })),
    };
  }

  function discovered(i: number): ScrapeTargetState {
    return {
      job: "extra",
      instance: `extra-${pad(i)}.example.net:9100`,
      scrapeUrl: null,
      health: "up",
      lastScrapeAt: AT,
      lastError: null,
    };
  }

  test("liveTargets: 2049 → 2048; hosts come first, so the last service goes", () => {
    const inputs = foldInputs(100, E.liveTargets + 1 - 100);
    const out = foldEstate(inputs);

    expect(out.liveTargets.length).toBe(E.liveTargets);
    expect(out.liveTargets.map((t) => t.target.id)).toEqual(
      [...inputs.model.hosts, ...inputs.model.services].slice(0, E.liveTargets).map((t) => t.drilldownId),
    );
    expect(out.liveTargets.filter((t) => t.target.kind === "host").length).toBe(100);
    // The rendered model is passed through whole.
    expect(out.estate).toBe(inputs.model);
    expect(out.estate.services.length).toBe(E.liveTargets + 1 - 100);
  });

  test("findings: 1025 → 1024 in artifact order; the input artifact is not mutated", () => {
    const artifact = deepFreeze(findingsArtifact(E.findings + 1));
    const out = foldEstate({ ...foldInputs(1, 1), findings: artifact });

    expect(out.findings.value!.findings.length).toBe(E.findings);
    expect(out.findings.value!.findings).toEqual(artifact.findings.slice(0, E.findings));
    expect(out.findings.value!.bundleId).toBe(artifact.bundleId);
    expect(out.findings.availability.state).toBe("current");
    expect(artifact.findings.length).toBe(E.findings + 1);
  });

  test("findings: at the cap the artifact is passed through by reference; absent stays unavailable", () => {
    const artifact = findingsArtifact(E.findings);
    expect(foldEstate({ ...foldInputs(1, 1), findings: artifact }).findings.value).toBe(artifact);

    const absent = foldEstate({ ...foldInputs(1, 1), findings: null }).findings;
    expect(absent.value).toBeNull();
    expect(absent.availability.state).toBe("unavailable");
  });

  test("declaredVersusScraped: 4097 → 4096; declared rows first, so a discovered-only row goes", () => {
    const base = foldInputs(10, 1);
    const extras = Array.from({ length: E.declaredVersusScraped + 1 - 10 }, (_, i) => discovered(i));
    const out = foldEstate(withRecords(base, {
      "victoriametrics-targets": ok<readonly ScrapeTargetState[]>(extras),
    })).declaredVersusScraped;

    expect(out.availability.state).toBe("current");
    const rows = out.value!;
    expect(rows.length).toBe(E.declaredVersusScraped);
    expect(rows.slice(0, 10).map((r) => r.drilldownId)).toEqual(base.model.hosts.map((h) => h.drilldownId));
    expect(rows.slice(0, 10).every((r) => r.state === "missing")).toBe(true);
    expect(rows.slice(10).map((r) => r.scrapeTarget)).toEqual(
      extras.slice(0, E.declaredVersusScraped - 10).map((t) => t.instance),
    );
    expect(rows.slice(10).every((r) => r.state === "unexpected")).toBe(true);
  });

  test("exactly at every cap nothing is trimmed", () => {
    const base = foldInputs(100, E.liveTargets - 100);
    const out = foldEstate(withRecords(
      { ...base, findings: findingsArtifact(E.findings) },
      {
        "victoriametrics-targets": ok<readonly ScrapeTargetState[]>(
          Array.from({ length: E.declaredVersusScraped - 100 }, (_, i) => discovered(i)),
        ),
      },
    ));
    expect(out.liveTargets.length).toBe(E.liveTargets);
    expect(out.findings.value!.findings.length).toBe(E.findings);
    expect(out.declaredVersusScraped.value!.length).toBe(E.declaredVersusScraped);
  });

  test("every CONTRACT_LIMITS.estate key has a case above", () => {
    expect(Object.keys(E).sort()).toEqual(["declaredVersusScraped", "findings", "liveTargets"]);
  });
});

describe("timeline fold limits", () => {
  const T = CONTRACT_LIMITS.timeline;
  const HOSTS = 4;
  const SERVICES = 40;

  /**
   * An estate whose hosts, services and endpoints all carry an applicable query: managed-linux scrape
   * instances for hosts, an ingress URL for services, and `endpoints` Gatus keys spread over the services.
   */
  function timelineInputs(endpoints: number, domains: readonly string[] = ["example.com"]): FoldInputs {
    const base = foldInputs(HOSTS, SERVICES);
    const model: WebEstateModelV2 = {
      ...base.model,
      estate: { ...base.model.estate, domains: [...domains] },
      hosts: base.model.hosts.map((h) => ({
        ...h,
        scrapeTargets: h.scrapeTargets.map((t) => ({ ...t, job: "managed-linux" })),
      })),
      services: base.model.services.map((s, i) => ({
        ...s,
        gatusEndpoints: Array.from({ length: endpoints }, (_, e) => e)
          .filter((e) => e % SERVICES === i)
          .map((e) => `probe-${pad(e)}`),
      })),
    };
    return { ...base, model };
  }

  const domainNames = (count: number): string[] =>
    Array.from({ length: count }, (_, d) => `zone-${pad(d)}.example.com`);

  test("targets: 2049 → 2048 in host → service → endpoint order; every kept parent resolves", () => {
    const endpoints = T.targets + 1 - HOSTS - SERVICES;
    const inputs = timelineInputs(endpoints);
    const out = foldTimeline(inputs).targets;

    const expected = [
      ...inputs.model.hosts.map((h) => h.drilldownId).sort(),
      ...inputs.model.services.map((s) => s.drilldownId).sort(),
      ...Array.from({ length: endpoints }, (_, e) => `probe-${pad(e)}`),
    ];
    expect(expected.length).toBe(T.targets + 1);
    expect(out.length).toBe(T.targets);
    expect(out.map((t) => t.target.id)).toEqual(expected.slice(0, T.targets));
    expect(out.filter((t) => t.target.kind === "host").length).toBe(HOSTS);
    expect(out.filter((t) => t.target.kind === "service").length).toBe(SERVICES);

    const kept = new Set(out.map((t) => `${t.target.kind}:${t.target.id}`));
    expect(out.filter((t) => t.target.kind !== "host").every((t) => t.parent !== null)).toBe(true);
    expect(out.every((t) => t.parent === null || kept.has(`${t.parent.kind}:${t.parent.id}`))).toBe(true);
  });

  test("domains: 513 → 512 in model order", () => {
    const names = domainNames(T.domains + 1).reverse();
    const out = foldTimeline(timelineInputs(0, names));
    expect(out.domains.length).toBe(T.domains);
    expect(out.domains.map((d) => d.domain)).toEqual(names.slice(0, T.domains));
  });

  test("checkHistory.endpoints: 512 → 511 ascending, built from the untrimmed domain list", () => {
    // 12 service endpoint keys + 500 domain endpoints = 512, one over the cap.
    const names = domainNames(500);
    const out = foldTimeline(timelineInputs(12, names));
    const all = [...names.map((n) => `dns:${n}`), ...Array.from({ length: 12 }, (_, e) => `probe-${pad(e)}`)].sort();
    expect(all.length).toBe(T.checkEndpoints + 1);
    expect(out.checkHistory.endpoints.length).toBe(T.checkEndpoints);
    expect(out.checkHistory.endpoints).toEqual(all.slice(0, T.checkEndpoints));
    expect(out.domains.length).toBe(500);
  });

  test("trimming domains does not change which endpoints are listed", () => {
    // 513 domains: the domain list drops its last entry; the endpoint list is cut from all 513 names.
    const names = domainNames(T.domains + 1);
    const out = foldTimeline(timelineInputs(0, names));
    expect(out.domains.length).toBe(T.domains);
    expect(out.checkHistory.endpoints).toEqual(names.map((n) => `dns:${n}`).sort().slice(0, T.checkEndpoints));
  });

  test("exactly at every cap nothing is trimmed", () => {
    const targets = foldTimeline(timelineInputs(T.targets - HOSTS - SERVICES)).targets;
    expect(targets.length).toBe(T.targets);

    const out = foldTimeline(timelineInputs(0, domainNames(T.checkEndpoints)));
    expect(out.checkHistory.endpoints.length).toBe(T.checkEndpoints);
    expect(foldTimeline(timelineInputs(0, domainNames(T.domains))).domains.length).toBe(T.domains);
  });

  test("every CONTRACT_LIMITS.timeline key has a case above", () => {
    expect(Object.keys(T).sort()).toEqual(["checkEndpoints", "domains", "targets"]);
  });
});
