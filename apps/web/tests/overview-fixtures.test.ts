// overview-fixtures.test.ts — proves the deterministic overview fixture factory
// (fixtures/overview/factory.ts, 08-testing-strategy.md §3): determinism, envelope counts,
// all five statuses, validator acceptance, and single-target withTargetStatus changes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { validateOverviewSnapshotV2 } from "@pulse/web-data/wire";
import type { OverviewSnapshotV2, TargetStatus } from "@pulse/web-data/wire";
import {
  ENVELOPE_HOST_COUNT,
  ENVELOPE_SERVICE_COUNT,
  OVERVIEW_FIXTURE_SEED,
  cycleInstant,
  makeEnvelopeOverviewSnapshot,
  makeLivenessHistoryPayload,
  makeOverviewSnapshot,
  withTargetStatus,
  type OverviewFixtureOptions,
} from "./fixtures/overview/factory.js";
import {
  DEFAULT_FIRING_COUNT,
  DEFAULT_HOST_COUNT,
  DEFAULT_HOST_STATUS_COUNTS,
  DEFAULT_SERVICE_COUNT,
  DEFAULT_SERVICE_STATUS_COUNTS,
  ENVELOPE_ALERT_COUNTS,
  ENVELOPE_COVERAGE,
  ENVELOPE_HOST_ROLLUP_COUNTS,
  ENVELOPE_HOST_STATUS_COUNTS,
  ENVELOPE_RECENT_CHECK_COUNT,
  ENVELOPE_SERVICE_STATUS_COUNTS,
  ENVELOPE_SIGNAL_COUNT,
  FIXTURE_IDS,
  type StatusCountRecord,
} from "./fixtures/overview/expected.js";

const ALL_STATUSES: readonly TargetStatus[] = ["ok", "warning", "critical", "unknown", "suppressed"];

function counts(statuses: readonly TargetStatus[]): StatusCountRecord {
  const out: Record<TargetStatus, number> = { ok: 0, warning: 0, critical: 0, unknown: 0, suppressed: 0 };
  for (const status of statuses) out[status] += 1;
  return out;
}

const services = (snapshot: OverviewSnapshotV2) => snapshot.hosts.flatMap((host) => host.services);

function expectValid(snapshot: OverviewSnapshotV2): void {
  const result = validateOverviewSnapshotV2(snapshot);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value).toEqual(snapshot);
}

describe("overview fixture factory constants", () => {
  test("seed and envelope sizes", () => {
    expect(OVERVIEW_FIXTURE_SEED).toBe(0x50_55_4c_53);
    expect(ENVELOPE_HOST_COUNT).toBe(100);
    expect(ENVELOPE_SERVICE_COUNT).toBe(300);
  });

  test("factory source uses no randomness, wall clock, UUIDs or I/O", () => {
    const source = readFileSync(new URL("./fixtures/overview/factory.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Math\.random|Date\.now|new Date\(\)|randomUUID|crypto\.|fetch\(|node:fs|Bun\.file|toLocale/);
  });
});

describe("determinism", () => {
  test("repeated calls are deep-equal", () => {
    expect(makeOverviewSnapshot()).toEqual(makeOverviewSnapshot());
    expect(makeEnvelopeOverviewSnapshot()).toEqual(makeEnvelopeOverviewSnapshot());
    expect(makeEnvelopeOverviewSnapshot(7)).toEqual(makeEnvelopeOverviewSnapshot(7));
  });

  test("cycle advances only snapshot-level timestamps", () => {
    const one = makeOverviewSnapshot({ cycle: 1 });
    const two = makeOverviewSnapshot({ cycle: 2 });
    expect(one.generatedAt).toBe("2026-09-01T12:00:00.000Z");
    expect(two.generatedAt).toBe(cycleInstant(2));
    expect(two.generatedAt).toBe("2026-09-01T12:00:10.000Z");
    expect(two.sources.metrics.lastSuccess).toBe(cycleInstant(2));
    expect(two.hosts).toEqual(one.hosts);
    expect(two.alerts).toEqual(one.alerts);
    expect(two.signals).toEqual(one.signals);
    expect(two.recentChecks).toEqual(one.recentChecks);
  });
});

describe("default snapshot", () => {
  const snapshot = makeOverviewSnapshot();

  test("4 hosts × 3 services with stable identities", () => {
    expect(snapshot.hosts).toHaveLength(DEFAULT_HOST_COUNT);
    expect(services(snapshot)).toHaveLength(DEFAULT_SERVICE_COUNT);
    expect(snapshot.hosts.map((host) => host.drilldownId)).toEqual([
      FIXTURE_IDS.okHost, FIXTURE_IDS.warningHost, FIXTURE_IDS.criticalHost, FIXTURE_IDS.unknownHost,
    ]);
    expect(snapshot.hosts[0]!.services.map((service) => service.drilldownId))
      .toEqual([FIXTURE_IDS.okService, FIXTURE_IDS.okServiceNoBoard, "svc:host-001/cache"]);
  });

  test("status counts and firing count match expected.ts", () => {
    expect(counts(snapshot.hosts.map((host) => host.status))).toEqual(DEFAULT_HOST_STATUS_COUNTS);
    expect(counts(snapshot.hosts.map((host) => host.rollup))).toEqual(DEFAULT_HOST_STATUS_COUNTS);
    expect(counts(services(snapshot).map((service) => service.status))).toEqual(DEFAULT_SERVICE_STATUS_COUNTS);
    expect(snapshot.alerts).toHaveLength(DEFAULT_FIRING_COUNT);
    expect(snapshot.alertCounts.firing).toBe(DEFAULT_FIRING_COUNT);
  });

  test("validateOverviewSnapshotV2 accepts it", () => {
    expectValid(snapshot);
  });

  test("attribution, suppression, Grafana, checks and signals are coherent", () => {
    const ids = new Set([...snapshot.hosts.map((host) => host.drilldownId), ...services(snapshot).map((service) => service.drilldownId)]);
    for (const alert of snapshot.alerts) {
      if (alert.target === null) expect(alert.severity).toBe("info");
      else expect(ids.has(alert.target.id)).toBe(true);
    }
    expect(new Set(snapshot.alerts.map((alert) => alert.fingerprint)).size).toBe(snapshot.alerts.length);
    const suppressed = services(snapshot).find((service) => service.drilldownId === FIXTURE_IDS.suppressedService)!;
    expect(suppressed.status).toBe("suppressed");
    expect(suppressed.suppressed?.rationale).toContain("planned maintenance");
    for (const service of services(snapshot)) expect(service.suppressed === null).toBe(service.status !== "suppressed");
    expect(services(snapshot).find((service) => service.drilldownId === FIXTURE_IDS.okService)!.grafana?.url)
      .toBe("https://grafana.example.test/d/pulse-host-001-api");
    expect(services(snapshot).find((service) => service.drilldownId === FIXTURE_IDS.okServiceNoBoard)!.grafana).toBeNull();
    expect(snapshot.recentChecks.some((check) => check.target === null && check.success === null)).toBe(true);
    for (const signal of snapshot.signals) expect(ids.has(signal.target.id)).toBe(true);
  });
});

describe("envelope snapshot", () => {
  const snapshot = makeEnvelopeOverviewSnapshot();

  test("exactly 100 hosts and 300 services, three per host", () => {
    expect(snapshot.hosts).toHaveLength(100);
    expect(services(snapshot)).toHaveLength(300);
    for (const host of snapshot.hosts) expect(host.services).toHaveLength(3);
  });

  test("every status is present on hosts, rollups and services", () => {
    for (const status of ALL_STATUSES) {
      expect(snapshot.hosts.some((host) => host.status === status)).toBe(true);
      expect(snapshot.hosts.some((host) => host.rollup === status)).toBe(true);
      expect(services(snapshot).some((service) => service.status === status)).toBe(true);
    }
    expect(counts(snapshot.hosts.map((host) => host.status))).toEqual(ENVELOPE_HOST_STATUS_COUNTS);
    expect(counts(snapshot.hosts.map((host) => host.rollup))).toEqual(ENVELOPE_HOST_ROLLUP_COUNTS);
    expect(counts(services(snapshot).map((service) => service.status))).toEqual(ENVELOPE_SERVICE_STATUS_COUNTS);
  });

  test("alerts, signals, checks and coverage match expected.ts", () => {
    expect(snapshot.alerts).toHaveLength(ENVELOPE_ALERT_COUNTS.firing);
    expect(snapshot.alertCounts.firing).toBe(ENVELOPE_ALERT_COUNTS.firing);
    expect(snapshot.alerts.filter((alert) => alert.severity === "critical")).toHaveLength(ENVELOPE_ALERT_COUNTS.critical);
    expect(snapshot.alerts.filter((alert) => alert.severity === "warning")).toHaveLength(ENVELOPE_ALERT_COUNTS.warning);
    expect(snapshot.alerts.filter((alert) => alert.severity === "info")).toHaveLength(ENVELOPE_ALERT_COUNTS.info);
    expect(snapshot.alerts.filter((alert) => alert.target === null)).toHaveLength(ENVELOPE_ALERT_COUNTS.unattributed);
    expect(snapshot.signals).toHaveLength(ENVELOPE_SIGNAL_COUNT);
    expect(snapshot.recentChecks).toHaveLength(ENVELOPE_RECENT_CHECK_COUNT);
    expect(snapshot.coverage.value).toEqual(ENVELOPE_COVERAGE);
  });

  test("identities are unique and stable across cycles", () => {
    const ids = [...snapshot.hosts.map((host) => host.drilldownId), ...services(snapshot).map((service) => service.drilldownId)];
    expect(new Set(ids).size).toBe(400);
    const later = makeEnvelopeOverviewSnapshot(5);
    expect(later.hosts).toEqual(snapshot.hosts);
  });

  test("validateOverviewSnapshotV2 accepts it", () => {
    expectValid(snapshot);
  });
});

describe("selectable options", () => {
  const cases: readonly [string, OverviewFixtureOptions][] = [
    ["stale evidence", { availability: { state: "stale", source: "victoriametrics-signals", lastGoodAt: "2026-09-01T11:50:00.000Z", message: "Source is stale." } }],
    ["no coverage", { includeCoverage: false }],
    ["engine unavailable", { engineAvailable: false }],
    ["zero-service hosts", { hostCount: 5, serviceCount: 6, zeroServiceHosts: 2 }],
    ["zero hosts", { hostCount: 0 }],
    ["single status", { statuses: ["ok"] }],
    ["unavailable liveness", { live: null }],
    ["no alerts/grafana/signals/checks", { alerts: false, grafana: false, signals: false, checks: false }],
    ["excluded class", { classes: ["excluded"] }],
  ];
  for (const [name, options] of cases) {
    test(`${name} validates and is deterministic`, () => {
      const snapshot = makeOverviewSnapshot(options);
      expectValid(snapshot);
      expect(makeOverviewSnapshot(options)).toEqual(snapshot);
    });
  }

  test("coverage/engine unavailability is explicit, never zero/ok", () => {
    const snapshot = makeOverviewSnapshot({ includeCoverage: false, engineAvailable: false });
    expect(snapshot.coverage.value).toBeNull();
    expect(snapshot.coverage.availability.state).toBe("unavailable");
    expect(snapshot.engine.value).toBeNull();
    expect(snapshot.engine.availability.state).toBe("unavailable");
  });

  test("zero-service hosts omit services and per-target availability overrides only that target", () => {
    const stale = { state: "stale", source: "victoriametrics-targets", lastGoodAt: "2026-09-01T11:00:00.000Z", message: null } as const;
    const snapshot = makeOverviewSnapshot({ hostCount: 3, serviceCount: 3, zeroServiceHosts: 1, targetAvailability: { [FIXTURE_IDS.okService]: stale } });
    expect(snapshot.hosts.map((host) => host.services.length)).toEqual([2, 1, 0]);
    const all = services(snapshot);
    expect(all[0]!.statusEvidence.availability).toEqual(stale);
    expect(all.slice(1).every((service) => service.statusEvidence.availability.state === "current")).toBe(true);
    expect(snapshot.hosts[0]!.rollupEvidence.availability).toEqual(stale);
  });

  test("liveness history keeps selected null samples", () => {
    const payload = makeLivenessHistoryPayload({ kind: "host", id: FIXTURE_IDS.okHost }, { nullEvery: 10 });
    expect(payload.series).toHaveLength(1);
    expect(payload.series[0]!.points).toHaveLength(60);
    expect(payload.series[0]!.points.filter(([, value]) => value === null)).toHaveLength(6);
    expect(makeLivenessHistoryPayload({ kind: "host", id: FIXTURE_IDS.okHost }, { nullEvery: 10 })).toEqual(payload);
  });
});

describe("withTargetStatus", () => {
  test("changing a service changes only that service (and its host's derived rollup)", () => {
    const before = makeEnvelopeOverviewSnapshot(1);
    const after = withTargetStatus(before, FIXTURE_IDS.okService, "critical", 2);
    expectValid(after);
    expect(after.generatedAt).toBe(cycleInstant(2));
    expect(after.hosts).toHaveLength(before.hosts.length);
    after.hosts.forEach((host, i) => {
      const prior = before.hosts[i]!;
      if (host.drilldownId !== FIXTURE_IDS.okHost) {
        expect(host).toEqual(prior);
        return;
      }
      host.services.forEach((service, j) => {
        const priorService = prior.services[j]!;
        if (service.drilldownId === FIXTURE_IDS.okService) {
          expect(service.status).toBe("critical");
          expect(service.statusEvidence.status).toBe("critical");
          expect({ ...service, status: priorService.status, statusEvidence: priorService.statusEvidence }).toEqual(priorService);
        } else {
          expect(service).toEqual(priorService);
        }
      });
      const { services: _s, rollup: _r, rollupEvidence: _re, ...rest } = host;
      const { services: _ps, rollup: _pr, rollupEvidence: _pre, ...priorRest } = prior;
      expect(rest).toEqual(priorRest);
      expect(host.rollup).toBe("critical");
    });
    expect(after.alerts).toEqual(before.alerts);
    expect(after.signals).toEqual(before.signals);
    // The input snapshot is not mutated.
    expect(before).toEqual(makeEnvelopeOverviewSnapshot(1));
  });

  test("changing a host changes only that host's status", () => {
    const before = makeEnvelopeOverviewSnapshot(1);
    const after = withTargetStatus(before, FIXTURE_IDS.warningHost, "ok", 2);
    expectValid(after);
    after.hosts.forEach((host, i) => {
      const prior = before.hosts[i]!;
      if (host.drilldownId !== FIXTURE_IDS.warningHost) {
        expect(host).toEqual(prior);
        return;
      }
      expect(host.status).toBe("ok");
      expect(host.statusEvidence.status).toBe("ok");
      expect(host.services).toEqual(prior.services);
      expect({ ...host, status: prior.status, statusEvidence: prior.statusEvidence, rollup: prior.rollup, rollupEvidence: prior.rollupEvidence })
        .toEqual(prior);
    });
  });

  test("suppression declaration follows the status and default snapshot validates", () => {
    const before = makeOverviewSnapshot();
    const after = withTargetStatus(before, FIXTURE_IDS.okService, "suppressed", 2);
    expectValid(after);
    const service = services(after).find((item) => item.drilldownId === FIXTURE_IDS.okService)!;
    expect(service.status).toBe("suppressed");
    expect(service.suppressed).not.toBeNull();
    const restored = withTargetStatus(after, FIXTURE_IDS.okService, "ok", 3);
    expect(services(restored).find((item) => item.drilldownId === FIXTURE_IDS.okService)!.suppressed).toBeNull();
  });

  test("unknown drilldown id throws", () => {
    expect(() => withTargetStatus(makeOverviewSnapshot(), "svc:missing/none", "ok", 2)).toThrow();
  });
});
