// packages/web-data/tests/cycle/never-silent-green.test.ts — the dedicated §12
// failure/recovery truth-table evidence for the overview and alerts folds (item 021,
// 04-cycle-and-current-view-folds.md §§7–8, 12) and, added by item 023, the same §12
// matrix for the estate and engine folds (§§9–10, 12). It enumerates every governing source
// against each dependent fold across the states the truth table names:
//
//   current success  → current value, may be healthy
//   failure + last-good (timeout AND malformed) → retained value marked stale; status
//                       unknown/unhealthy, NEVER healthy, NEVER silently zero-green
//   failure, no last-good → unavailable; empty/null placeholder; status unknown
//   later success     → recovery to current
//
// Each row also asserts that an UNRELATED source stays current (isolation) and that the
// failed source's last-good context (lastSuccess/lastGoodAt/retained body) is preserved.
// Finally it proves the folds are pure: zero source calls (a fetch spy is never invoked)
// and no input mutation (the whole FoldInputs is deep-frozen). Self-contained builders —
// no apps/web or fetch dependency.

import { afterEach, describe, expect, test } from "bun:test";

import { foldOverview } from "../../src/cycle/fold-overview.js";
import { foldAlerts } from "../../src/cycle/fold-alerts.js";
import { foldEstate } from "../../src/cycle/fold-estate.js";
import { foldEngine } from "../../src/cycle/fold-engine.js";
import type { AckFoldRecord, CycleSourceRecords, FoldInputs } from "../../src/cycle/records.js";
import type { ScrapeTargetState, SourceRecord } from "../../src/sources/types.js";
import type { MetricSample, VmBuildInfo } from "../../src/sources/vm.js";
import type {
  AlertmanagerAlert,
  AlertmanagerReceiver,
  AlertmanagerSilence,
  AlertmanagerStatus,
} from "../../src/sources/alertmanager.js";
import type { VmalertRuleGroup } from "../../src/sources/vmalert.js";
import type { GatusEndpointState } from "../../src/sources/gatus.js";
import type { GrafanaHealth } from "../../src/sources/grafana.js";
import type { WebCoverageArtifact, WebEstateModelV2 } from "@pulse/renderer";

const AT = "2026-01-01T00:00:00.000Z"; // prior successful attempt / last-good time
const OBSERVED = "2026-01-01T00:00:05.000Z"; // this cycle's observedAt (body materialization)

type FailKind = "timeout" | "malformed-json" | "transport";

// --- record builders -------------------------------------------------------

function ok<T>(data: T, at = AT): SourceRecord<T> {
  return { latest: { attemptedAt: at, result: { ok: true, data } }, lastGood: { at, data } };
}

/** A record whose latest attempt failed; `lastGood` retains prior success when provided. */
function fail<T>(
  lastGood: { readonly at: string; readonly data: T } | null = null,
  kind: FailKind = "timeout",
): SourceRecord<T> {
  return {
    latest: {
      attemptedAt: OBSERVED,
      result: { ok: false, error: { kind, message: `bounded ${kind}`, status: null } },
    },
    lastGood,
  };
}

function metric(
  projection: string,
  host: string,
  value: number | null,
  extra: Record<string, string> = {},
): MetricSample {
  return { metric: { host, ...extra }, timestampMs: Date.parse(AT), value, projection };
}

function amAlert(over: Partial<AlertmanagerAlert> = {}): AlertmanagerAlert {
  return {
    fingerprint: "fp-0001",
    state: "firing",
    name: "HighCpu",
    severity: "critical",
    startsAt: AT,
    endsAt: "2026-01-02T00:00:00.000Z",
    labels: { alertname: "HighCpu", severity: "critical", host: "hostA" },
    annotations: { summary: "cpu high" },
    receivers: ["team"],
    silencedBy: [],
    inhibitedBy: [],
    group: null,
    ...over,
  };
}

function ruleGroup(over: Partial<VmalertRuleGroup> = {}): VmalertRuleGroup {
  return {
    group: "cpu",
    file: "/etc/vmalert/rules/hosts.yml",
    family: "hosts",
    intervalSeconds: 30,
    lastEvaluationAt: AT,
    rules: [
      {
        name: "HighCpu",
        type: "alerting",
        state: "firing",
        health: "healthy",
        lastEvaluationAt: AT,
        lastError: null,
        labels: {},
        annotations: {},
        deadman: false,
      },
    ],
    ...over,
  };
}

function silence(over: Partial<AlertmanagerSilence> = {}): AlertmanagerSilence {
  return {
    id: "sil-1",
    matchers: [{ name: "host", value: "hostA", isRegex: false, isEqual: true }],
    createdBy: "op",
    comment: "maintenance",
    startsAt: AT,
    endsAt: "2026-01-02T00:00:00.000Z",
    state: "active",
    ...over,
  };
}

/** A Gatus endpoint state whose latest result is fresh (timestamp = observedAt) and successful. */
function gatusEndpoint(name: string, success = true): GatusEndpointState {
  return {
    name,
    group: "core",
    key: `core_${name}`,
    identity: name,
    expected: true,
    results: [
      {
        timestamp: OBSERVED,
        success,
        durationMs: 12,
        conditionResults: [{ condition: "[STATUS] == 200", success }],
      },
    ],
  };
}

const EMPTY_STATUS: AlertmanagerStatus = {
  version: "0.27.0",
  uptime: null,
  cluster: { status: "ready", peerCount: null },
};
const EMPTY_BUILDINFO: VmBuildInfo = { version: "1.102.1", startedAt: null };
const EMPTY_GRAFANA: GrafanaHealth = { database: "ok", version: "11.4.0" };

function records(over: Partial<CycleSourceRecords> = {}): CycleSourceRecords {
  return {
    "victoriametrics-signals": ok<readonly MetricSample[]>([]),
    "victoriametrics-targets": ok([]),
    "victoriametrics-buildinfo": ok(EMPTY_BUILDINFO),
    "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([]),
    "alertmanager-silences": ok<readonly AlertmanagerSilence[]>([]),
    "alertmanager-status": ok(EMPTY_STATUS),
    "alertmanager-receivers": ok<readonly AlertmanagerReceiver[]>([]),
    "vmalert-rules": ok<readonly VmalertRuleGroup[]>([]),
    "gatus-statuses": ok<readonly GatusEndpointState[]>([]),
    "grafana-health": ok(EMPTY_GRAFANA),
    ...over,
  };
}

// --- model builder ---------------------------------------------------------

const BUNDLE_ID = `sha256:${"0123456789abcdef".repeat(4)}` as const;
function prov(): WebEstateModelV2["hosts"][number]["provenance"] {
  return { file: "estate.yml", path: "hosts[0]", line: 1, col: 1 };
}

/** A model with a managed-linux host (metrics-governed) and a probe-only host (gatus-governed). */
function model(over: Partial<WebEstateModelV2> = {}): WebEstateModelV2 {
  const hosts: WebEstateModelV2["hosts"] = [
    {
      name: "hostA",
      collectionClass: "managed-linux",
      addresses: ["10.0.0.1"],
      suppressed: null,
      drilldownId: "host:hostA",
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: prov(),
      scrapeTargets: [{ job: "node", instance: "10.0.0.1:9100" }],
      artifacts: [],
      detail: {
        exporterPorts: [9100],
        cadvisor: false,
        heartbeat: true,
        deliveryForm: "compose",
        commandSignals: [],
      },
    },
    {
      name: "hostD",
      collectionClass: "probe-only",
      addresses: ["10.0.0.4"],
      suppressed: null,
      drilldownId: "host:hostD",
      expectedChurn: false,
      scrapeIntervalClass: null,
      provenance: prov(),
      scrapeTargets: [],
      artifacts: [],
      detail: { probe: { kind: "tcp", target: "10.0.0.9:22", expect: null } },
    },
  ];
  const services: WebEstateModelV2["services"] = [];
  return {
    formatVersion: 2,
    bundleId: BUNDLE_ID,
    estate: {
      name: "home",
      domains: ["example.com"],
      timezone: "America/New_York",
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
    ...over,
  };
}

function coverage(): WebCoverageArtifact {
  return {
    formatVersion: 2,
    bundleId: BUNDLE_ID,
    covered: [
      { kind: "host", name: "hostA", collectionClass: "managed-linux", artifacts: ["a"], suppressed: null },
    ],
    gaps: [],
    suppressed: [],
  };
}

function inputs(over: Partial<FoldInputs> = {}): FoldInputs {
  return {
    model: model(),
    coverage: coverage(),
    findings: null,
    records: records(),
    appVersion: "1.2.3",
    observedAt: OBSERVED,
    ...over,
  };
}

/** A live-metrics record proving `hostA` is up (managed-linux liveness). */
function liveMetrics(at = AT): SourceRecord<readonly MetricSample[]> {
  return ok<readonly MetricSample[]>(
    [metric("pulse_agent_up", "hostA", 1, { instance: "10.0.0.1:9100" })],
    at,
  );
}

function hostA(ov: ReturnType<typeof foldOverview>) {
  return ov.hosts.find((h) => h.name === "hostA")!;
}
function hostD(ov: ReturnType<typeof foldOverview>) {
  return ov.hosts.find((h) => h.name === "hostD")!;
}

// ===========================================================================
// Overview fold — metrics (victoriametrics-signals) governs managed-host liveness
// ===========================================================================

describe("overview never-silent-green — metrics source", () => {
  test("current success: managed host is live and may be ok", () => {
    const ov = foldOverview(inputs({ records: records({ "victoriametrics-signals": liveMetrics(OBSERVED) }) }));
    expect(hostA(ov).live).toBe(true);
    expect(hostA(ov).status).toBe("ok");
    expect(ov.sources.metrics.ok).toBe(true);
  });

  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: liveness null, status unknown, last-good preserved, alerts isolated`, () => {
      const ov = foldOverview(
        inputs({
          records: records({
            "victoriametrics-signals": fail<readonly MetricSample[]>(
              { at: AT, data: [metric("pulse_agent_up", "hostA", 1)] },
              kind,
            ),
            "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([]), // unrelated, stays current
          }),
        }),
      );
      // never silently green: a failed governing source forces unknown, not ok and not zero-green.
      expect(hostA(ov).live).toBeNull();
      expect(hostA(ov).status).toBe("unknown");
      // failed source: not ok, but the stable last-good time is retained (context preserved).
      expect(ov.sources.metrics.ok).toBe(false);
      expect(ov.sources.metrics.lastSuccess).toBe(AT);
      expect(ov.sources.metrics.error).toBe(`bounded ${kind}`);
      // unrelated source is unaffected and current.
      expect(ov.sources.alerts.ok).toBe(true);
    });
  }

  test("failure, no last-good: liveness null, status unknown, lastSuccess null", () => {
    const ov = foldOverview(
      inputs({ records: records({ "victoriametrics-signals": fail<readonly MetricSample[]>(null, "malformed-json") }) }),
    );
    expect(hostA(ov).live).toBeNull();
    expect(hostA(ov).status).toBe("unknown");
    expect(ov.sources.metrics.ok).toBe(false);
    expect(ov.sources.metrics.lastSuccess).toBeNull();
  });

  test("recovery: the next success restores a current, live, ok host", () => {
    const ov = foldOverview(inputs({ records: records({ "victoriametrics-signals": liveMetrics(OBSERVED) }) }));
    expect(hostA(ov).status).toBe("ok");
    expect(ov.sources.metrics.ok).toBe(true);
    expect(ov.sources.metrics.lastSuccess).toBe(OBSERVED);
  });
});

// ===========================================================================
// Overview fold — alerts (alertmanager-alerts) governs colouring + counts + strip
// ===========================================================================

describe("overview never-silent-green — alerts source", () => {
  test("current success: a firing critical alert colours the host", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": liveMetrics(OBSERVED),
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()]),
        }),
      }),
    );
    expect(hostA(ov).status).toBe("critical");
    expect(ov.alertCounts).toEqual({ firing: 1, silenced: 0, inhibited: 0 });
  });

  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: status unknown (never green/critical), retained counts, metrics isolated`, () => {
      const ov = foldOverview(
        inputs({
          records: records({
            "victoriametrics-signals": liveMetrics(OBSERVED), // unrelated, current & live
            "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>({ at: AT, data: [amAlert()] }, kind),
          }),
        }),
      );
      // colour is undeterminable when alerts are unavailable ⇒ unknown, never green, never a
      // falsely-current critical either — the honest state under a failed governing source.
      expect(hostA(ov).status).toBe("unknown");
      // last-good context IS retained in the body (counts + the host's retained alert list).
      expect(ov.alertCounts).toEqual({ firing: 1, silenced: 0, inhibited: 0 });
      expect(hostA(ov).activeAlerts.map((a) => a.name)).toEqual(["HighCpu"]);
      expect(ov.sources.alerts.ok).toBe(false);
      expect(ov.sources.alerts.lastSuccess).toBe(AT);
      // metrics unaffected and current: live signal still true.
      expect(hostA(ov).live).toBe(true);
      expect(ov.sources.metrics.ok).toBe(true);
    });
  }

  test("failure, no last-good: status unknown, counts zero-empty, lastSuccess null", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": liveMetrics(OBSERVED),
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>(null, "timeout"),
        }),
      }),
    );
    expect(hostA(ov).status).toBe("unknown"); // NOT ok despite a live, alert-free host
    expect(ov.alertCounts).toEqual({ firing: 0, silenced: 0, inhibited: 0 });
    expect(ov.alerts).toEqual([]);
    expect(ov.sources.alerts.ok).toBe(false);
    expect(ov.sources.alerts.lastSuccess).toBeNull();
  });

  test("recovery: the next alerts success restores a colourable, current host", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": liveMetrics(OBSERVED),
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([], OBSERVED),
        }),
      }),
    );
    expect(hostA(ov).status).toBe("ok");
    expect(ov.sources.alerts.ok).toBe(true);
  });
});

// ===========================================================================
// Overview fold — checks (gatus-statuses) governs probe-only host liveness + recentChecks
// ===========================================================================

describe("overview never-silent-green — checks source", () => {
  test("current success: a fresh, successful probe makes the probe-only host live/ok", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "gatus-statuses": ok<readonly GatusEndpointState[]>([gatusEndpoint("host:hostD")]),
        }),
      }),
    );
    expect(hostD(ov).live).toBe(true);
    expect(hostD(ov).status).toBe("ok");
    expect(ov.sources.checks.ok).toBe(true);
    expect(ov.recentChecks.map((c) => c.endpoint)).toEqual(["host:hostD"]);
  });

  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: probe liveness null/unknown, recentChecks retained, metrics isolated`, () => {
      const ov = foldOverview(
        inputs({
          records: records({
            "victoriametrics-signals": liveMetrics(OBSERVED), // hostA stays current/ok
            "gatus-statuses": fail<readonly GatusEndpointState[]>(
              { at: AT, data: [gatusEndpoint("host:hostD")] },
              kind,
            ),
          }),
        }),
      );
      // probe-only liveness is governed by gatus ⇒ null/unknown under failure, never green.
      expect(hostD(ov).live).toBeNull();
      expect(hostD(ov).status).toBe("unknown");
      // last-good check context retained in the compact recentChecks body.
      expect(ov.recentChecks.map((c) => c.endpoint)).toEqual(["host:hostD"]);
      expect(ov.sources.checks.ok).toBe(false);
      expect(ov.sources.checks.lastSuccess).toBe(AT);
      // metrics-governed host is isolated and current.
      expect(hostA(ov).status).toBe("ok");
    });
  }

  test("failure, no last-good: probe liveness null, recentChecks empty, lastSuccess null", () => {
    const ov = foldOverview(
      inputs({ records: records({ "gatus-statuses": fail<readonly GatusEndpointState[]>(null, "transport") }) }),
    );
    expect(hostD(ov).live).toBeNull();
    expect(hostD(ov).status).toBe("unknown");
    expect(ov.recentChecks).toEqual([]);
    expect(ov.sources.checks.lastSuccess).toBeNull();
  });

  test("recovery: the next checks success restores probe liveness", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "gatus-statuses": ok<readonly GatusEndpointState[]>([gatusEndpoint("host:hostD")], OBSERVED),
        }),
      }),
    );
    expect(hostD(ov).live).toBe(true);
    expect(ov.sources.checks.ok).toBe(true);
  });
});

// ===========================================================================
// Alerts fold — AM alerts / AM silences / vmalert rules each independently governed
// ===========================================================================

describe("alerts never-silent-green — alertmanager-alerts source", () => {
  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: alerts stale-retained (never empty-current), vmalert isolated`, () => {
      const al = foldAlerts(
        inputs({
          records: records({
            "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>({ at: AT, data: [amAlert()] }, kind),
            "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
          }),
        }),
      );
      expect(al.alerts).toHaveLength(1); // retained last-good, never silently emptied
      expect(al.alertmanager.state).toBe("stale");
      expect(al.alertmanager.lastGoodAt).toBe(AT);
      expect(al.alertmanager.message).toBe(`bounded ${kind}`);
      expect(al.vmalert.state).toBe("current"); // independent availability
      expect(al.rules).toHaveLength(1);
    });
  }

  test("failure, no last-good: alertmanager unavailable with an empty set (never zero-green healthy)", () => {
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>(null, "malformed-json"),
          "alertmanager-silences": fail<readonly AlertmanagerSilence[]>(null, "malformed-json"),
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
        }),
      }),
    );
    expect(al.alerts).toEqual([]);
    expect(al.alertmanager.state).toBe("unavailable");
    expect(al.alertmanager.lastGoodAt).toBeNull();
    expect(al.vmalert.state).toBe("current"); // unrelated source stays current
  });

  test("recovery: the next AM success is current with the fresh set", () => {
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()], OBSERVED),
        }),
      }),
    );
    expect(al.alertmanager.state).toBe("current");
    expect(al.alerts).toHaveLength(1);
  });
});

describe("alerts never-silent-green — alertmanager-silences source", () => {
  test("a silences-only failure degrades the shared alertmanager section (worse-of), alerts retained", () => {
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()], OBSERVED), // current
          "alertmanager-silences": fail<readonly AlertmanagerSilence[]>({ at: AT, data: [silence()] }, "timeout"),
        }),
      }),
    );
    // The section availability is the worse of the two AM records: silences stale ⇒ section stale,
    // even though the alerts read succeeded — a silences failure is never silently ignored.
    expect(al.alertmanager.state).toBe("stale");
    expect(al.silences.map((s) => s.id)).toEqual(["sil-1"]); // retained last-good silence
    expect(al.alerts).toHaveLength(1);
  });
});

describe("alerts never-silent-green — vmalert-rules source", () => {
  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: rules stale-retained, alertmanager isolated`, () => {
      const al = foldAlerts(
        inputs({
          records: records({
            "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()], OBSERVED),
            "vmalert-rules": fail<readonly VmalertRuleGroup[]>({ at: AT, data: [ruleGroup()] }, kind),
          }),
        }),
      );
      expect(al.rules).toHaveLength(1); // retained
      expect(al.vmalert.state).toBe("stale");
      expect(al.vmalert.lastGoodAt).toBe(AT);
      expect(al.alertmanager.state).toBe("current"); // isolated
    });
  }

  test("failure, no last-good: vmalert unavailable with empty rules, alertmanager isolated", () => {
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()], OBSERVED),
          "vmalert-rules": fail<readonly VmalertRuleGroup[]>(null, "transport"),
        }),
      }),
    );
    expect(al.rules).toEqual([]);
    expect(al.vmalert.state).toBe("unavailable");
    expect(al.vmalert.lastGoodAt).toBeNull();
    expect(al.alertmanager.state).toBe("current");
  });

  test("recovery: the next vmalert success is current with the fresh rules", () => {
    const al = foldAlerts(
      inputs({
        records: records({ "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()], OBSERVED) }),
      }),
    );
    expect(al.vmalert.state).toBe("current");
    expect(al.rules).toHaveLength(1);
  });
});

// ===========================================================================
// Estate/engine helpers (deep-health service + full engine projection series)
// ===========================================================================

/** A scrape target for the declared-versus-scraped and scrape-job dimensions. */
function scrapeTarget(over: Partial<ScrapeTargetState> = {}): ScrapeTargetState {
  return {
    job: "node",
    instance: "10.0.0.1:9100",
    scrapeUrl: "http://10.0.0.1:9100/metrics",
    health: "up",
    lastScrapeAt: AT,
    lastError: null,
    ...over,
  };
}

/** The shared model plus a deep-health service on hostA (metrics-governed liveness). */
function modelWithService(): WebEstateModelV2 {
  return model({
    services: [
      {
        name: "grafana",
        host: "hostA",
        managed: true,
        deepHealth: true,
        ingressUrl: "https://grafana.example",
        suppressed: null,
        drilldownId: "svc:hostA/grafana",
        kind: "dashboard",
        provenance: prov(),
        gatusEndpoints: ["hostA/grafana"],
        artifacts: [],
        deepHealthDetail: {
          endpoint: "https://grafana.example/api/health",
          metrics: ["db"],
          responseMapping: { db: "$.db" },
          alertExpression: "up == 0",
          hostLocal: false,
          credential: null,
        },
        backupFreshness: null,
        alerts: [],
      },
    ],
  });
}

/** Full current VM instant series: hostA liveness + deep-health + engine projections. */
function engineMetrics(): readonly MetricSample[] {
  const startSec = Date.parse(OBSERVED) / 1000;
  return [
    metric("pulse_agent_up", "hostA", 1, { instance: "10.0.0.1:9100" }),
    metric("pulse_deep_health_up", "hostA", 1, { service: "grafana" }),
    metric("pulse_web_engine_ingestion_rows_per_second", "", 42),
    metric("pulse_web_engine_hourly_active_series", "", 1000),
    metric("pulse_web_engine_data_bytes", "", 5_000_000),
    metric("pulse_web_engine_free_disk_bytes", "", 9_000_000),
    metric("pulse_web_engine_notification_failures_per_second", "", 0.5, { integration: "email" }),
    metric("pulse_web_engine_notification_latency_p95_seconds", "", 1.2, { integration: "email" }),
    { metric: { job: "victoriametrics" }, timestampMs: Date.parse(OBSERVED), value: startSec - 100, projection: "pulse_web_engine_process_start_seconds" },
  ];
}

function estTarget(est: ReturnType<typeof foldEstate>, id: string) {
  return est.liveTargets.find((t) => t.target.id === id)!;
}
function engComponent(eng: ReturnType<typeof foldEngine>, id: string) {
  return eng.components.find((c) => c.id === id)!;
}

// ===========================================================================
// Estate fold — every governing source, stale/missing evidence never greens a target
// ===========================================================================

describe("estate never-silent-green — metrics source (managed-linux host liveness)", () => {
  test("current success: hostA joins to a healthy target with verbatim model passthrough", () => {
    const model_ = modelWithService();
    const i = inputs({
      model: model_,
      records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(engineMetrics(), OBSERVED) }),
    });
    const est = foldEstate(i);
    // criterion 1: model passes through verbatim (exact reference, provenance intact).
    expect(est.estate).toBe(model_);
    expect(est.estate.hosts[0]!.provenance).toEqual({ file: "estate.yml", path: "hosts[0]", line: 1, col: 1 });
    expect(estTarget(est, "host:hostA").state).toBe("healthy");
    expect(estTarget(est, "svc:hostA/grafana").state).toBe("healthy"); // deep-health up
  });

  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: hostA/service never green (unknown, stale), probe host isolated`, () => {
      const est = foldEstate(
        inputs({
          model: modelWithService(),
          records: records({
            "victoriametrics-signals": fail<readonly MetricSample[]>({ at: AT, data: engineMetrics() }, kind),
            // probe-only host governed by gatus stays current/live (isolation).
            "gatus-statuses": ok<readonly GatusEndpointState[]>([gatusEndpoint("host:hostD")]),
          }),
        }),
      );
      const hostA = estTarget(est, "host:hostA");
      expect(hostA.state).toBe("unknown"); // NOT healthy despite live last-good
      expect(hostA.availability.state).toBe("stale");
      expect(hostA.availability.lastGoodAt).toBe(AT);
      expect(estTarget(est, "svc:hostA/grafana").state).toBe("unknown"); // service also never greens
      expect(estTarget(est, "host:hostD").state).toBe("healthy"); // gatus-governed, isolated
    });
  }

  test("failure, no last-good: hostA unknown with unavailable governing evidence", () => {
    const est = foldEstate(
      inputs({ records: records({ "victoriametrics-signals": fail<readonly MetricSample[]>(null, "transport") }) }),
    );
    const hostA = estTarget(est, "host:hostA");
    expect(hostA.state).toBe("unknown");
    expect(hostA.availability.state).toBe("unavailable");
    expect(hostA.availability.lastGoodAt).toBeNull();
  });

  test("recovery: the next metrics success restores a healthy hostA", () => {
    const est = foldEstate(
      inputs({
        model: modelWithService(),
        records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(engineMetrics(), OBSERVED) }),
      }),
    );
    expect(estTarget(est, "host:hostA").state).toBe("healthy");
  });
});

describe("estate never-silent-green — checks source (probe-only host liveness)", () => {
  test("current success: a fresh probe makes hostD healthy", () => {
    const est = foldEstate(
      inputs({ records: records({ "gatus-statuses": ok<readonly GatusEndpointState[]>([gatusEndpoint("host:hostD")]) }) }),
    );
    expect(estTarget(est, "host:hostD").state).toBe("healthy");
  });

  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: hostD never green (unknown, stale), metrics host isolated`, () => {
      const est = foldEstate(
        inputs({
          records: records({
            "victoriametrics-signals": liveMetrics(OBSERVED), // hostA current/live (isolation)
            "gatus-statuses": fail<readonly GatusEndpointState[]>({ at: AT, data: [gatusEndpoint("host:hostD")] }, kind),
          }),
        }),
      );
      const hostD = estTarget(est, "host:hostD");
      expect(hostD.state).toBe("unknown"); // NOT healthy
      expect(hostD.availability.state).toBe("stale");
      expect(hostD.availability.source).toBe("gatus-statuses");
      expect(estTarget(est, "host:hostA").state).toBe("healthy"); // metrics-governed, isolated
    });
  }

  test("recovery: the next checks success restores a healthy hostD", () => {
    const est = foldEstate(
      inputs({
        records: records({ "gatus-statuses": ok<readonly GatusEndpointState[]>([gatusEndpoint("host:hostD")], OBSERVED) }),
      }),
    );
    expect(estTarget(est, "host:hostD").state).toBe("healthy");
  });
});

describe("estate never-silent-green — alerts source (colouring) and vm-targets (drift)", () => {
  test("alerts failure forces target unknown (never a stale-current colour, never green)", () => {
    // hostA is live via current metrics; a firing critical alert existed in last-good AM data.
    const est = foldEstate(
      inputs({
        records: records({
          "victoriametrics-signals": liveMetrics(OBSERVED),
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>({ at: AT, data: [amAlert()] }, "timeout"),
        }),
      }),
    );
    // alert evidence is not current ⇒ colour is undeterminable ⇒ unknown, never healthy and
    // never a falsely-current unhealthy either.
    expect(estTarget(est, "host:hostA").state).toBe("unknown");
  });

  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`vm-targets ${kind}: declared-versus-scraped is unknown with VM-target context, never no-drift`, () => {
      const est = foldEstate(
        inputs({
          records: records({
            "victoriametrics-targets": fail<readonly ScrapeTargetState[]>({ at: AT, data: [scrapeTarget()] }, kind),
          }),
        }),
      );
      expect(est.declaredVersusScraped.value?.every((row) => row.state === "unknown")).toBe(true);
      expect(est.declaredVersusScraped.availability.source).toBe("victoriametrics-targets");
      expect(est.declaredVersusScraped.availability.state).toBe("stale");
    });
  }

  test("vm-targets recovery: a current discovery resolves drift explicitly", () => {
    const est = foldEstate(
      inputs({
        records: records({
          "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([scrapeTarget()], OBSERVED),
        }),
      }),
    );
    expect(est.declaredVersusScraped.availability.state).toBe("current");
    expect(est.declaredVersusScraped.value?.map((row) => row.state)).toEqual(["matched"]);
  });
});

// ===========================================================================
// Engine fold — every governing source, stale/missing evidence never greens a component
// ===========================================================================

describe("engine never-silent-green — victoriametrics-signals (component, capacity, notifications)", () => {
  test("current success: VM component healthy with live projections", () => {
    const eng = foldEngine(
      inputs({ records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(engineMetrics(), OBSERVED) }) }),
    );
    expect(engComponent(eng, "victoriametrics").state).toBe("healthy");
    expect(eng.capacity.ingestionRowsPerSecond).toBe(42);
    expect(eng.notifications.failuresPerSecond).toEqual({ email: 0.5 });
  });

  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: VM component unknown, projections null (never zero/green), grafana isolated`, () => {
      const eng = foldEngine(
        inputs({
          records: records({
            "victoriametrics-signals": fail<readonly MetricSample[]>({ at: AT, data: engineMetrics() }, kind),
          }),
        }),
      );
      const vm = engComponent(eng, "victoriametrics");
      expect(vm.state).toBe("unknown"); // stale, never healthy
      expect(vm.availability.state).toBe("stale");
      expect(vm.uptimeSeconds).toBeNull(); // last-good process-start is not trusted
      // projections come only from the current instant series ⇒ null, never a stale/zero value.
      expect(eng.capacity.ingestionRowsPerSecond).toBeNull();
      expect(eng.capacity.dataBytes).toBeNull();
      expect(eng.notifications.failuresPerSecond).toBeNull();
      expect(eng.capacity.availability.state).toBe("stale");
      // an unrelated component is isolated and current.
      expect(engComponent(eng, "grafana").state).toBe("healthy");
    });
  }

  test("failure, no last-good: VM component unhealthy (unavailable)", () => {
    const eng = foldEngine(
      inputs({ records: records({ "victoriametrics-signals": fail<readonly MetricSample[]>(null, "transport") }) }),
    );
    expect(engComponent(eng, "victoriametrics").state).toBe("unhealthy");
    expect(engComponent(eng, "victoriametrics").availability.state).toBe("unavailable");
  });

  test("recovery: the next VM success restores a healthy component with live projections", () => {
    const eng = foldEngine(
      inputs({ records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(engineMetrics(), OBSERVED) }) }),
    );
    expect(engComponent(eng, "victoriametrics").state).toBe("healthy");
    expect(eng.capacity.ingestionRowsPerSecond).toBe(42);
  });
});

describe("engine never-silent-green — vmalert-rules (component, rule groups, deadman)", () => {
  for (const kind of ["timeout", "malformed-json"] as const) {
    test(`${kind} + last-good: vmalert component & rule groups unknown, deadman unknown, AM isolated`, () => {
      const eng = foldEngine(
        inputs({
          records: records({
            "vmalert-rules": fail<readonly VmalertRuleGroup[]>(
              { at: AT, data: [ruleGroup({ rules: [{ name: "DeadMansSwitch", type: "alerting", state: "firing", health: "healthy", lastEvaluationAt: AT, lastError: null, labels: {}, annotations: {}, deadman: true }] })] },
              kind,
            ),
          }),
        }),
      );
      expect(engComponent(eng, "vmalert").state).toBe("unknown"); // stale, never healthy
      expect(eng.ruleGroups).toHaveLength(1); // retained last-good group
      expect(eng.ruleGroups[0]!.health).toBe("unknown"); // never healthy under stale discovery
      expect(eng.deadman.configured).toBe(true); // known from last-good identity
      expect(eng.deadman.state).toBe("unknown"); // stale evidence never greens the canary
      expect(engComponent(eng, "alertmanager").state).toBe("healthy"); // isolated
    });
  }

  test("failure, no last-good: vmalert unhealthy, no rule groups, deadman not-configured", () => {
    const eng = foldEngine(
      inputs({ records: records({ "vmalert-rules": fail<readonly VmalertRuleGroup[]>(null, "transport") }) }),
    );
    expect(engComponent(eng, "vmalert").state).toBe("unhealthy");
    expect(eng.ruleGroups).toEqual([]);
    expect(eng.deadman.configured).toBe(false);
    expect(eng.deadman.state).toBe("not-configured");
  });

  test("recovery: the next vmalert success restores healthy groups and a healthy canary", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>(
            [ruleGroup({ rules: [{ name: "DeadMansSwitch", type: "alerting", state: "firing", health: "healthy", lastEvaluationAt: AT, lastError: null, labels: {}, annotations: {}, deadman: true }] })],
            OBSERVED,
          ),
        }),
      }),
    );
    expect(engComponent(eng, "vmalert").state).toBe("healthy");
    expect(eng.deadman.state).toBe("healthy");
  });
});

describe("engine never-silent-green — alertmanager / gatus / grafana components", () => {
  for (const source of ["alertmanager-alerts", "gatus-statuses"] as const) {
    const componentId = source === "alertmanager-alerts" ? "alertmanager" : "gatus";
    test(`${source} stale (fail + last-good) → ${componentId} unknown, never healthy`, () => {
      const eng = foldEngine(
        inputs({ records: records({ [source]: fail({ at: AT, data: [] }, "timeout") }) }),
      );
      expect(engComponent(eng, componentId).state).toBe("unknown");
      expect(engComponent(eng, componentId).availability.state).toBe("stale");
    });

    test(`${source} unavailable (no last-good) → ${componentId} unhealthy`, () => {
      const eng = foldEngine(inputs({ records: records({ [source]: fail(null, "malformed-json") }) }));
      expect(engComponent(eng, componentId).state).toBe("unhealthy");
    });
  }

  test("grafana unconfigured (null record) is distinctly not-configured, never healthy", () => {
    const eng = foldEngine(inputs({ records: records({ "grafana-health": null }) }));
    expect(engComponent(eng, "grafana").state).toBe("not-configured");
    expect(engComponent(eng, "grafana").version).toBeNull();
  });

  test("grafana configured failure with last-good is stale/unknown, isolated from other components", () => {
    const eng = foldEngine(
      inputs({ records: records({ "grafana-health": fail({ at: AT, data: EMPTY_GRAFANA }, "timeout") }) }),
    );
    expect(engComponent(eng, "grafana").state).toBe("unknown");
    expect(engComponent(eng, "victoriametrics").state).toBe("healthy"); // isolated
  });
});

describe("engine never-silent-green — victoriametrics-targets (scrape jobs)", () => {
  test("discovery failure cannot green a scrape job even with up last-good targets", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "victoriametrics-targets": fail<readonly ScrapeTargetState[]>({ at: AT, data: [scrapeTarget()] }, "timeout"),
        }),
      }),
    );
    expect(eng.scrapeJobs[0]!.state).toBe("unknown"); // never healthy under stale discovery
  });

  test("recovery: a current discovery reports true aggregate job health", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([scrapeTarget()], OBSERVED),
        }),
      }),
    );
    expect(eng.scrapeJobs[0]!.state).toBe("healthy");
  });
});

// ===========================================================================
// Purity: zero source calls + no input mutation (criterion 4)
// ===========================================================================

describe("folds are pure — zero source calls, no input mutation", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("neither fold performs any fetch/source call", () => {
    let calls = 0;
    // Any network/source access would go through fetch; a fold that touched a client would
    // trip this spy. The folds take already-settled records, so the count must stay zero.
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("folds must not perform source calls");
    }) as unknown as typeof fetch;

    const i = inputs({
      records: records({
        "victoriametrics-signals": liveMetrics(OBSERVED),
        "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([scrapeTarget()]),
        "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()]),
        "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
        "gatus-statuses": ok<readonly GatusEndpointState[]>([gatusEndpoint("host:hostD")]),
      }),
    });
    foldOverview(i);
    foldAlerts(i);
    foldEstate(i);
    foldEngine(i);
    expect(calls).toBe(0);
  });

  test("a deep-frozen input is never mutated by either fold (determinism holds)", () => {
    const deepFreeze = <T>(v: T): T => {
      if (v !== null && typeof v === "object") {
        for (const key of Object.keys(v as Record<string, unknown>)) {
          deepFreeze((v as Record<string, unknown>)[key]);
        }
        Object.freeze(v);
      }
      return v;
    };
    const i = deepFreeze(
      inputs({
        records: records({
          "victoriametrics-signals": liveMetrics(OBSERVED),
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()]),
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
        }),
      }),
    );
    // A mutation of any (frozen) input would throw in strict-mode ESM; two identical outputs
    // prove the folds neither mutate their inputs nor carry hidden state between calls.
    expect(JSON.stringify(foldOverview(i))).toBe(JSON.stringify(foldOverview(i)));
    expect(JSON.stringify(foldAlerts(i))).toBe(JSON.stringify(foldAlerts(i)));
    expect(JSON.stringify(foldEstate(i))).toBe(JSON.stringify(foldEstate(i)));
    expect(JSON.stringify(foldEngine(i))).toBe(JSON.stringify(foldEngine(i)));
  });
});

// ===========================================================================
// Acks never mask status (mutation-foundation item 018, 06 §5.4): re-run representative
// alerts/overview matrix rows with an ack for EVERY firing fingerprint. Availability,
// status, rollup and alertCounts are identical to the no-acks run — an ack is a Pulse-only
// annotation, not a suppression, so an acked critical alert still colours its cell.
// ===========================================================================

describe("never-silent-green with acks present (REQ-ACK-07)", () => {
  const ACK: AckFoldRecord = { by: "Gary Gentry", at: OBSERVED, note: "on it" };
  const ALERTS: readonly AlertmanagerAlert[] = [
    amAlert({ fingerprint: "fp-crit" }),
    amAlert({ fingerprint: "fp-warn", name: "DiskFull", severity: "warning" }),
    amAlert({ fingerprint: "fp-sil", state: "silenced" }),
  ];
  const ACKS: ReadonlyMap<string, AckFoldRecord> = new Map(ALERTS.map((a) => [a.fingerprint, ACK]));

  /** Drop the additive ack keys so the remaining body can be compared to the no-acks run. */
  function stripAcks(v: unknown): unknown {
    return JSON.parse(JSON.stringify(v), (k, val: unknown) => (k === "ack" || k === "acked" ? undefined : val));
  }

  const ROWS: ReadonlyArray<readonly [string, CycleSourceRecords]> = [
    ["current success", records({ "victoriametrics-signals": liveMetrics(OBSERVED), "alertmanager-alerts": ok(ALERTS) })],
    [
      "timeout + last-good",
      records({
        "victoriametrics-signals": liveMetrics(OBSERVED),
        "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>({ at: AT, data: ALERTS }, "timeout"),
      }),
    ],
    [
      "malformed + last-good",
      records({
        "victoriametrics-signals": liveMetrics(OBSERVED),
        "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>({ at: AT, data: ALERTS }, "malformed-json"),
      }),
    ],
    [
      "failure, no last-good",
      records({
        "victoriametrics-signals": liveMetrics(OBSERVED),
        "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>(null, "transport"),
      }),
    ],
    ["metrics failure", records({ "victoriametrics-signals": fail<readonly MetricSample[]>(null), "alertmanager-alerts": ok(ALERTS) })],
  ];

  for (const [label, recs] of ROWS) {
    test(`overview ${label}: availability, status, rollup and alertCounts identical with acks`, () => {
      const plain = foldOverview(inputs({ records: recs }));
      const acked = foldOverview(inputs({ records: recs, acks: ACKS }));
      expect(acked.sources).toStrictEqual(plain.sources);
      expect(acked.alertCounts).toStrictEqual(plain.alertCounts);
      expect(acked.engine).toStrictEqual(plain.engine);
      for (const h of plain.hosts) {
        const a = acked.hosts.find((x) => x.name === h.name)!;
        expect([a.status, a.rollup, a.live]).toEqual([h.status, h.rollup, h.live]);
        expect(a.statusEvidence).toStrictEqual(h.statusEvidence);
        expect(a.rollupEvidence).toStrictEqual(h.rollupEvidence);
      }
      // Only the additive marker differs anywhere in the body.
      expect(stripAcks(acked)).toStrictEqual(stripAcks(plain));
    });

    test(`alerts ${label}: availability and retained set identical with acks`, () => {
      const plain = foldAlerts(inputs({ records: recs }));
      const acked = foldAlerts(inputs({ records: recs, acks: ACKS }));
      expect(acked.alertmanager).toStrictEqual(plain.alertmanager);
      expect(acked.vmalert).toStrictEqual(plain.vmalert);
      expect(acked.alerts.map((a) => [a.fingerprint, a.state])).toEqual(plain.alerts.map((a) => [a.fingerprint, a.state]));
      for (const a of acked.alerts) expect(a.ack).toStrictEqual(ACK);
      expect(stripAcks(acked)).toStrictEqual(stripAcks(plain));
    });
  }

  test("an acked critical alert still colours its host critical and is counted as firing", () => {
    const ov = foldOverview(
      inputs({
        records: records({ "victoriametrics-signals": liveMetrics(OBSERVED), "alertmanager-alerts": ok(ALERTS) }),
        acks: ACKS,
      }),
    );
    expect(hostA(ov).status).toBe("critical");
    expect(hostA(ov).rollup).toBe("critical");
    expect(ov.alertCounts).toEqual({ firing: 2, silenced: 1, inhibited: 0 });
    expect(ov.alerts.every((a) => a.acked === true)).toBe(true);
  });

  test("acks cannot make an unavailable alerts source look green", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": liveMetrics(OBSERVED),
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>(null, "timeout"),
        }),
        acks: ACKS,
      }),
    );
    expect(hostA(ov).status).toBe("unknown");
    expect(ov.sources.alerts.ok).toBe(false);
    expect(ov.alerts).toEqual([]);
  });
});
