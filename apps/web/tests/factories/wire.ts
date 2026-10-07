// apps/web/tests/factories/wire.ts — typed builders for the overview wire shapes.
//
// The overview contracts now live in `@pulse/web-data/wire` and `src/shared/snapshot.ts`
// re-exports them (01-core-definitions.md §9); these builders construct fixtures validated
// against those migrated readonly wire types, so `bun run typecheck` fails if a builder
// drifts from the authoritative contract.
//
// Timestamps default to a fixed `NOW` so freshness math and staleness assertions are deterministic;
// `buildSnapshot(model, sourceData, now)` is always called with an explicit `now`, never `Date.now()`.

import type {
  ActiveAlert,
  CheckResult,
  HostStatus,
  OverviewSnapshot,
  ServiceStatus,
  SourceHealth,
} from "../../src/shared/snapshot.js";

/** The fixed "now" every clock-independent test builds against (ISO-8601 UTC). */
export const NOW = "2026-08-22T12:00:00.000Z" as const;

/** A resolved `ServiceStatus` — defaults to a live, ok, actively-monitored service. */
export function serviceStatus(over: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    name: "grafana",
    host: "web01",
    managed: true,
    deepHealth: false,
    drilldownId: "svc:web01/grafana",
    suppressed: null,
    status: "ok",
    statusEvidence: {
      status: "ok",
      availability: { state: "current", source: "victoriametrics-signals", lastGoodAt: NOW, message: null },
    },
    live: true,
    activeAlerts: [],
    checks: [],
    grafana: null,
    ...over,
  };
}

/** A resolved `HostStatus` — defaults to a live, ok, actively-monitored host with no services. */
export function hostStatus(over: Partial<HostStatus> = {}): HostStatus {
  return {
    name: "web01",
    collectionClass: "managed-linux",
    addresses: ["10.0.0.4"],
    drilldownId: "host:web01",
    suppressed: null,
    status: "ok",
    statusEvidence: {
      status: "ok",
      availability: { state: "current", source: "victoriametrics-signals", lastGoodAt: NOW, message: null },
    },
    rollup: "ok",
    rollupEvidence: {
      status: "ok",
      availability: { state: "current", source: "victoriametrics-signals", lastGoodAt: NOW, message: null },
    },
    live: true,
    activeAlerts: [],
    checks: [],
    grafana: null,
    services: [],
    ...over,
  };
}

/** A whole `OverviewSnapshot` — defaults to a healthy, all-sources-ok estate with one host. */
export function overviewSnapshot(over: Partial<OverviewSnapshot> = {}): OverviewSnapshot {
  return {
    appVersion: "0.0.0-dev",
    generatedAt: NOW,
    estate: { name: "home-estate", timezone: "America/Chicago", tzFallback: false },
    sources: { metrics: ok(NOW), alerts: ok(NOW), checks: ok(NOW) },
    hosts: [hostStatus()],
    alerts: [],
    signals: [],
    recentChecks: [],
    engine: {
      availability: { state: "current", source: "victoriametrics-signals", lastGoodAt: NOW, message: null },
      value: { ok: true },
    },
    alertCounts: { firing: 0, silenced: 0, inhibited: 0 },
    coverage: {
      availability: { state: "current", source: "rendered-estate", lastGoodAt: NOW, message: null },
      value: { covered: 0, gaps: 0, extras: 0 },
    },
    ...over,
  };
}

/** A resolved `SourceHealth` — healthy now, with an optional prior `lastSuccess` (defaults to NOW). */
export function ok(lastSuccess: string = NOW): SourceHealth {
  return { ok: true, lastSuccess, error: null };
}

/** A resolved `SourceHealth` — failing with `error` and an optional prior `lastSuccess`. */
export function down(error: string, lastSuccess: string | null = null): SourceHealth {
  return { ok: false, lastSuccess, error };
}

/** An `ActiveAlert` attributed to a host or service, defaulting severity `critical`. */
export function alert(over: Partial<ActiveAlert> = {}): ActiveAlert {
  return {
    fingerprint: "fp-host-down",
    name: "HostDown",
    severity: "critical",
    startsAt: NOW,
    target: { kind: "host", id: "host:web01" },
    ...over,
  };
}

/** An overview alert summary carrying the Pulse-local `acked: true` marker (REQ-ACK-07). */
export function ackedAlert(over: Partial<ActiveAlert> = {}): ActiveAlert {
  return alert({ acked: true, ...over });
}

/** A `CheckResult` for a Gatus endpoint, defaulting `success: true`, evaluated at NOW. */
export function check(over: Partial<CheckResult> = {}): CheckResult {
  return {
    endpoint: "web01/grafana",
    success: true,
    lastEvaluatedAt: NOW,
    ...over,
  };
}

/**
 * The raw source-data bundle `snapshot/build.ts` consumes (04 §2) — the three sources' parsed
 * payloads plus per-source health, all overridable so a test asserts one facet at a time.
 *
 * NOTE: `liveness` is the VM instant-query series shape (03 §2). When item 004's parsed source
 * types land, they become the compile-time contract that keeps this factory honest (`bun run
 * typecheck` fails if they drift) — see 08-testing-strategy.md §2.2.
 */
export interface SourceDataFixture {
  /** VM instant-query series (03 §2): one entry per observed liveness metric. */
  liveness: Array<{ metric: Record<string, string>; value: number }>;
  /** Parsed Alertmanager alerts (03 §3). */
  alerts: ActiveAlert[];
  /** Parsed Gatus statuses (03 §4). */
  checks: CheckResult[];
  /** Per-source reachability for this cycle. */
  health: { metrics: SourceHealth; alerts: SourceHealth; checks: SourceHealth };
}

/** A source-data bundle defaulting to all-sources-healthy with no observed signal. */
export function sourceData(over: Partial<SourceDataFixture> = {}): SourceDataFixture {
  return {
    liveness: [],
    alerts: [],
    checks: [],
    health: { metrics: ok(NOW), alerts: ok(NOW), checks: ok(NOW) },
    ...over,
  };
}
