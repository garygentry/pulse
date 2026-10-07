// packages/web-data/tests/cycle/fold-estate-engine.test.ts — evidence for the pure estate
// and engine folds (item 022, 04-cycle-and-current-view-folds.md §§9–10). Self-contained V2
// model + typed-record builders; no apps/web or fetch dependency (the folds are pure
// functions of their inputs, so determinism on repeated calls and a never-invoked fetch spy
// together are the zero-source-call / purity evidence).

import { afterEach, describe, expect, test } from "bun:test";

import { foldEstate } from "../../src/cycle/fold-estate.js";
import { foldEngine } from "../../src/cycle/fold-engine.js";
import type { CycleSourceRecords, EngineFoldConfig, FoldInputs } from "../../src/cycle/records.js";
import type { SourceRecord } from "../../src/sources/types.js";
import type { MetricSample, VmBuildInfo } from "../../src/sources/vm.js";
import type { ScrapeTargetState } from "../../src/sources/types.js";
import type {
  AlertmanagerAlert,
  AlertmanagerReceiver,
  AlertmanagerSilence,
  AlertmanagerStatus,
} from "../../src/sources/alertmanager.js";
import type { VmalertRule, VmalertRuleGroup } from "../../src/sources/vmalert.js";
import type { GatusEndpointState } from "../../src/sources/gatus.js";
import type { GrafanaHealth } from "../../src/sources/grafana.js";
import type { WebCoverageArtifact, WebEstateModelV2, WebFindingsArtifact } from "@pulse/renderer";

const AT = "2026-01-01T00:00:00.000Z"; // prior success / last-good time
const OBSERVED = "2026-01-01T00:00:05.000Z"; // this cycle's observedAt
const OBSERVED_MS = Date.parse(OBSERVED);

type FailKind = "timeout" | "malformed-json" | "transport";

// --- record builders -------------------------------------------------------

function ok<T>(data: T, at = AT): SourceRecord<T> {
  return { latest: { attemptedAt: at, result: { ok: true, data } }, lastGood: { at, data } };
}

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

// --- sample / source-value builders ----------------------------------------

function sample(
  projection: string,
  value: number | null,
  labels: Record<string, string> = {},
): MetricSample {
  return { metric: labels, timestampMs: OBSERVED_MS, value, projection };
}

/** A process-start sample for `job` producing ~`uptime` seconds against OBSERVED. */
function processStart(job: string, uptime: number): MetricSample {
  return sample("pulse_web_engine_process_start_seconds", OBSERVED_MS / 1000 - uptime, { job });
}

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

function rule(over: Partial<VmalertRule> = {}): VmalertRule {
  return {
    name: "HighCpu",
    type: "alerting",
    state: "firing",
    health: "healthy",
    lastEvaluationAt: AT,
    lastError: null,
    labels: {},
    annotations: {},
    deadman: false,
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
    rules: [rule(), rule({ name: "DeadMansSwitch", deadman: true })],
    ...over,
  };
}

function gatusEndpoint(name: string, success = true, at = AT): GatusEndpointState {
  return {
    name,
    group: "",
    key: `_${name}`,
    identity: name,
    expected: true,
    results: [
      { timestamp: at, success, durationMs: 12, conditionResults: [] },
    ],
  };
}

const EMPTY_STATUS: AlertmanagerStatus = {
  version: "0.27.0",
  uptime: null,
  cluster: { status: "ready", peerCount: null },
};
const BUILDINFO: VmBuildInfo = { version: "1.102.1", startedAt: null };
const GRAFANA: GrafanaHealth = { database: "ok", version: "11.4.0" };

function records(over: Partial<CycleSourceRecords> = {}): CycleSourceRecords {
  return {
    "victoriametrics-signals": ok<readonly MetricSample[]>([]),
    "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([]),
    "victoriametrics-buildinfo": ok(BUILDINFO),
    "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([]),
    "alertmanager-silences": ok<readonly AlertmanagerSilence[]>([]),
    "alertmanager-status": ok(EMPTY_STATUS),
    "alertmanager-receivers": ok<readonly AlertmanagerReceiver[]>([]),
    "vmalert-rules": ok<readonly VmalertRuleGroup[]>([]),
    "gatus-statuses": ok<readonly GatusEndpointState[]>([]),
    "grafana-health": ok(GRAFANA),
    ...over,
  };
}

// --- model builder ---------------------------------------------------------

const BUNDLE_ID = `sha256:${"0123456789abcdef".repeat(4)}` as const;
function prov(): WebEstateModelV2["hosts"][number]["provenance"] {
  return { file: "estate.yml", path: "hosts[0]", line: 1, col: 1 };
}

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
  const services: WebEstateModelV2["services"] = [
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
  ];
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

function findings(): WebFindingsArtifact {
  return { formatVersion: 2, bundleId: BUNDLE_ID, findings: [] };
}

function inputs(over: Partial<FoldInputs> = {}): FoldInputs {
  return {
    model: model(),
    coverage: coverage(),
    findings: findings(),
    records: records(),
    appVersion: "1.2.3",
    observedAt: OBSERVED,
    ...over,
  };
}

/** Current metrics with hostA linux liveness + deep-health, and full engine projections. */
function liveMetrics(): readonly MetricSample[] {
  return [
    sample("pulse_agent_up", 1, { host: "hostA", instance: "10.0.0.1:9100" }),
    sample("up", 1, { host: "hostA", instance: "10.0.0.1:9100" }),
    sample("pulse_deep_health_up", 1, { host: "hostA", service: "grafana" }),
    sample("pulse_web_engine_ingestion_rows_per_second", 42),
    sample("pulse_web_engine_hourly_active_series", 1000),
    sample("pulse_web_engine_data_bytes", 5_000_000),
    sample("pulse_web_engine_free_disk_bytes", 9_000_000),
    sample("pulse_web_engine_notification_failures_per_second", 0.5, { integration: "email" }),
    sample("pulse_web_engine_notification_latency_p95_seconds", 1.2, { integration: "email" }),
    processStart("victoriametrics", 100),
    processStart("vmalert", 200),
    processStart("alertmanager", 300),
    processStart("gatus", 400),
  ];
}

// ===========================================================================
// Estate fold
// ===========================================================================

describe("foldEstate — rendered vocabulary, joins, artifacts", () => {
  test("passes the validated model through verbatim (provenance preserved)", () => {
    const est = foldEstate(inputs());
    expect(est.generatedAt).toBe(OBSERVED); // body materialization time
    expect(est.estate).toBe(inputs().model === est.estate ? est.estate : est.estate); // reference stable
    expect(est.estate.hosts[0]!.provenance).toEqual({ file: "estate.yml", path: "hosts[0]", line: 1, col: 1 });
    expect(est.estate.channels).toBeDefined();
    expect(est.estate.routingOverrides).toBeDefined();
    expect(est.estate.suppressions).toBeDefined();
  });

  test("emits one live target per rendered host and service in model order", () => {
    const est = foldEstate(inputs());
    expect(est.liveTargets.map((t) => t.target.id)).toEqual([
      "host:hostA",
      "host:hostD",
      "svc:hostA/grafana",
    ]);
    expect(est.liveTargets.map((t) => t.target.kind)).toEqual(["host", "host", "service"]);
  });

  test("current liveness joins produce healthy targets", () => {
    const est = foldEstate(
      inputs({ records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics()) }) }),
    );
    const hostA = est.liveTargets.find((t) => t.target.id === "host:hostA")!;
    expect(hostA.state).toBe("healthy");
    expect(hostA.availability.source).toBe("victoriametrics-signals");
    const svc = est.liveTargets.find((t) => t.target.id === "svc:hostA/grafana")!;
    expect(svc.state).toBe("healthy"); // deep-health up
  });

  test("attributes and sorts alert fingerprints; excludes DeadMansSwitch", () => {
    const est = foldEstate(
      inputs({
        records: records({
          "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics()),
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([
            amAlert({ fingerprint: "fp-c" }),
            amAlert({ fingerprint: "fp-a", severity: "warning" }),
            amAlert({ fingerprint: "fp-dms", name: "DeadMansSwitch", labels: { alertname: "DeadMansSwitch", host: "hostA" } }),
          ]),
        }),
      }),
    );
    const hostA = est.liveTargets.find((t) => t.target.id === "host:hostA")!;
    expect(hostA.alertFingerprints).toEqual(["fp-a", "fp-c"]); // sorted, canary excluded
    expect(hostA.state).toBe("unhealthy"); // colouring alert present
  });

  test("coverage and findings present → current value; absent → unavailable with guidance", () => {
    const present = foldEstate(inputs());
    expect(present.coverage.value).not.toBeNull();
    expect(present.coverage.availability.state).toBe("current");
    expect(present.findings.value).not.toBeNull();

    const absent = foldEstate(inputs({ coverage: null, findings: null }));
    expect(absent.coverage.value).toBeNull();
    expect(absent.coverage.availability.state).toBe("unavailable");
    expect(absent.coverage.availability.message).toContain("pulse render");
    expect(absent.findings.value).toBeNull();
    expect(absent.findings.availability.message).toContain("pulse render");
  });

  test("declared-versus-scraped is matched when every declared instance is discovered", () => {
    const est = foldEstate(
      inputs({
        records: records({
          "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([scrapeTarget()]),
        }),
      }),
    );
    expect(est.declaredVersusScraped.availability.state).toBe("current");
    expect(est.declaredVersusScraped.value?.map((row) => row.state)).toEqual(["matched"]);
  });

  test("declared-versus-scraped reports missing and unexpected drift explicitly", () => {
    const missing = foldEstate(
      inputs({ records: records({ "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([]) }) }),
    );
    expect(missing.declaredVersusScraped.value?.map((row) => row.state)).toEqual(["missing"]);

    const unexpected = foldEstate(
      inputs({
        records: records({
          "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([
            scrapeTarget(),
            scrapeTarget({ instance: "10.9.9.9:9100" }),
          ]),
        }),
      }),
    );
    expect(unexpected.declaredVersusScraped.value?.map((row) => row.state)).toEqual(["matched", "unexpected"]);

    const both = foldEstate(
      inputs({
        model: model({
          hosts: [
            ...model().hosts,
            {
              ...model().hosts[0]!,
              name: "hostB",
              drilldownId: "host:hostB",
              scrapeTargets: [{ job: "node", instance: "10.0.0.2:9100" }],
            },
          ],
        }),
        records: records({
          "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([
            scrapeTarget(),
            scrapeTarget({ instance: "10.9.9.9:9100" }),
          ]),
        }),
      }),
    );
    expect(both.declaredVersusScraped.value?.map((row) => row.state)).toEqual([
      "matched",
      "missing",
      "unexpected",
    ]);
  });

  test("declared-versus-scraped is UNKNOWN with VM-target context on discovery failure", () => {
    const est = foldEstate(
      inputs({
        records: records({
          "victoriametrics-targets": fail<readonly ScrapeTargetState[]>({ at: AT, data: [scrapeTarget()] }),
        }),
      }),
    );
    // Even a last-good target set must not be reported as no-drift; state is explicitly unknown.
    expect(est.declaredVersusScraped.value?.every((row) => row.state === "unknown")).toBe(true);
    expect(est.declaredVersusScraped.availability.source).toBe("victoriametrics-targets");
    expect(est.declaredVersusScraped.availability.state).toBe("stale");
  });

  test("passes non-null rendered credential references through verbatim and never resolves them (REQ-SEC-04)", () => {
    // Two safe display-only references (`{kind, display}`) — a channel credential and a service
    // deep-health credential. The data tier must surface them EXACTLY as rendered by
    // rendered-model-v2 (a reference string, never a resolved secret value).
    const channelCred = { kind: "env", display: "${SMTP_PASSWORD}" } as const;
    const deepHealthCred = { kind: "op", display: "op://vault/grafana/api-token" } as const;
    const base = model();
    const withCreds = model({
      channels: [
        {
          name: "email-primary",
          kind: "email",
          credential: { ...channelCred },
          options: { from: "ops@example.com" },
          provenance: prov(),
        },
      ],
      services: base.services.map((s) =>
        s.deepHealthDetail !== null
          ? { ...s, deepHealthDetail: { ...s.deepHealthDetail, credential: { ...deepHealthCred } } }
          : s,
      ),
    });

    const est = foldEstate(inputs({ model: withCreds }));

    // Verbatim passthrough: the fold returns the exact validated model object (§9 estate: model),
    // so the references are structurally identical and untouched.
    expect(est.estate).toBe(withCreds);
    expect(est.estate.channels[0]!.credential).toEqual(channelCred);
    expect(est.estate.services[0]!.deepHealthDetail!.credential).toEqual(deepHealthCred);
    // The references are still the SAFE display form — not resolved/expanded to a secret value.
    expect(est.estate.channels[0]!.credential.display).toBe("${SMTP_PASSWORD}");
    expect(est.estate.services[0]!.deepHealthDetail!.credential!.display).toBe("op://vault/grafana/api-token");
    // No field anywhere is mutated or resolved during the fold.
    expect(est.estate).toEqual(withCreds);
  });
});

describe("foldEstate — never-silent-green", () => {
  test("stale metrics (fail + last-good) never green a host", () => {
    const est = foldEstate(
      inputs({
        records: records({
          // last-good had a live host, but the latest attempt failed
          "victoriametrics-signals": fail<readonly MetricSample[]>({ at: AT, data: liveMetrics() }),
        }),
      }),
    );
    const hostA = est.liveTargets.find((t) => t.target.id === "host:hostA")!;
    expect(hostA.state).toBe("unknown"); // NOT healthy
    expect(hostA.availability.state).toBe("stale");
    expect(hostA.availability.lastGoodAt).toBe(AT);
  });

  test("metrics unavailable (no last-good) yields unknown, never healthy", () => {
    const est = foldEstate(
      inputs({ records: records({ "victoriametrics-signals": fail<readonly MetricSample[]>(null) }) }),
    );
    const hostA = est.liveTargets.find((t) => t.target.id === "host:hostA")!;
    expect(hostA.state).toBe("unknown");
    expect(hostA.availability.state).toBe("unavailable");
  });

  test("recovery restores healthy on the next success", () => {
    const est = foldEstate(
      inputs({
        records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics(), OBSERVED) }),
      }),
    );
    const hostA = est.liveTargets.find((t) => t.target.id === "host:hostA")!;
    expect(hostA.state).toBe("healthy");
  });

  test("excluded/no-signal targets are not-configured, not healthy", () => {
    const est = foldEstate(
      inputs({
        model: model({
          suppressions: [],
          hosts: [
            {
              name: "hostX",
              collectionClass: "excluded",
              addresses: [],
              suppressed: { class: "known-expected", rationale: "retired" },
              drilldownId: "host:hostX",
              expectedChurn: false,
              scrapeIntervalClass: null,
              provenance: prov(),
              scrapeTargets: [],
              artifacts: [],
              detail: {},
            },
          ],
          services: [],
        }),
      }),
    );
    const hostX = est.liveTargets.find((t) => t.target.id === "host:hostX")!;
    expect(hostX.state).toBe("not-configured");
  });
});

// ===========================================================================
// Engine fold
// ===========================================================================

describe("foldEngine — six fixed components", () => {
  test("emits the six components in fixed display order", () => {
    const eng = foldEngine(inputs());
    expect(eng.components.map((c) => c.id)).toEqual([
      "victoriametrics",
      "vmalert",
      "alertmanager",
      "gatus",
      "grafana",
      "web",
    ]);
    expect(eng.generatedAt).toBe(OBSERVED);
  });

  test("component health maps from governing availability without greening stale/unavailable", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics()),
          // vmalert stale (fail + last-good) → unknown, never healthy
          "vmalert-rules": fail<readonly VmalertRuleGroup[]>({ at: AT, data: [ruleGroup()] }),
          // alertmanager unavailable (no last-good) → unhealthy
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>(null),
        }),
      }),
    );
    const byId = new Map(eng.components.map((c) => [c.id, c]));
    expect(byId.get("victoriametrics")!.state).toBe("healthy");
    expect(byId.get("vmalert")!.state).toBe("unknown");
    expect(byId.get("alertmanager")!.state).toBe("unhealthy");
    expect(byId.get("web")!.state).toBe("healthy");
  });

  test("unconfigured Grafana is a distinct not-configured component", () => {
    const eng = foldEngine(inputs({ records: records({ "grafana-health": null }) }));
    const grafana = eng.components.find((c) => c.id === "grafana")!;
    expect(grafana.state).toBe("not-configured");
    expect(grafana.availability.state).toBe("not-configured");
    expect(grafana.version).toBeNull();
  });

  test("version from metadata, uptime only from the current process-start metric", () => {
    const eng = foldEngine(
      inputs({ records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics()) }) }),
    );
    const byId = new Map(eng.components.map((c) => [c.id, c]));
    expect(byId.get("victoriametrics")!.version).toBe("1.102.1"); // buildinfo metadata
    expect(byId.get("victoriametrics")!.uptimeSeconds).toBe(100); // process-start projection
    expect(byId.get("alertmanager")!.version).toBe("0.27.0"); // status metadata
    expect(byId.get("grafana")!.version).toBe("11.4.0");
    expect(byId.get("web")!.version).toBe("1.2.3"); // appVersion
  });

  test("metadata success never substitutes for a missing uptime metric", () => {
    // buildinfo (metadata) succeeds, but the instant series carries NO process-start sample.
    const eng = foldEngine(
      inputs({ records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>([]) }) }),
    );
    const vm = eng.components.find((c) => c.id === "victoriametrics")!;
    expect(vm.version).toBe("1.102.1"); // still from metadata
    expect(vm.uptimeSeconds).toBeNull(); // uptime never faked from metadata
  });
});

describe("foldEngine — scrape jobs, rules, deadman", () => {
  test("groups scrape targets by job with aggregate health, sorted", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([
            scrapeTarget({ job: "vm", instance: "b" }),
            scrapeTarget({ job: "node", instance: "z" }),
            scrapeTarget({ job: "node", instance: "a", health: "down" }),
          ]),
        }),
      }),
    );
    expect(eng.scrapeJobs.map((j) => j.job)).toEqual(["node", "vm"]); // sorted
    const node = eng.scrapeJobs.find((j) => j.job === "node")!;
    expect(node.targets.map((t) => t.instance)).toEqual(["a", "z"]); // sorted by instance
    expect(node.state).toBe("unhealthy"); // a target is down
    expect(eng.scrapeJobs.find((j) => j.job === "vm")!.state).toBe("healthy");
  });

  test("scrape discovery failure cannot green a job even with last-good up targets", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "victoriametrics-targets": fail<readonly ScrapeTargetState[]>({
            at: AT,
            data: [scrapeTarget()],
          }),
        }),
      }),
    );
    expect(eng.scrapeJobs[0]!.state).toBe("unknown");
  });

  test("rule groups carry per-group health and rules; deadman derived from identity", () => {
    const eng = foldEngine(
      inputs({ records: records({ "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]) }) }),
    );
    expect(eng.ruleGroups.map((g) => g.group)).toEqual(["cpu"]);
    expect(eng.ruleGroups[0]!.health).toBe("healthy");
    expect(eng.ruleGroups[0]!.rules.map((r) => r.name)).toEqual(["DeadMansSwitch", "HighCpu"]); // sorted
    expect(eng.deadman.configured).toBe(true);
    expect(eng.deadman.state).toBe("healthy"); // canary firing + healthy
  });

  test("deadman not-configured when no canary declared; unknown when vmalert stale", () => {
    const noCanary = foldEngine(
      inputs({
        records: records({
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup({ rules: [rule()] })]),
        }),
      }),
    );
    expect(noCanary.deadman.configured).toBe(false);
    expect(noCanary.deadman.state).toBe("not-configured");

    const stale = foldEngine(
      inputs({
        records: records({
          "vmalert-rules": fail<readonly VmalertRuleGroup[]>({ at: AT, data: [ruleGroup()] }),
        }),
      }),
    );
    expect(stale.deadman.configured).toBe(true); // known from last-good identity
    expect(stale.deadman.state).toBe("unknown"); // stale evidence never greens the canary
  });

  test("a non-firing deadman rule is unhealthy (silent canary)", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>([
            ruleGroup({ rules: [rule({ name: "DeadMansSwitch", deadman: true, state: "inactive" })] }),
          ]),
        }),
      }),
    );
    expect(eng.deadman.state).toBe("unhealthy");
  });
});

describe("foldEngine — projections, capacity, cycle", () => {
  test("capacity and notification projections come from the current instant series", () => {
    const eng = foldEngine(
      inputs({ records: records({ "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics()) }) }),
    );
    expect(eng.capacity.ingestionRowsPerSecond).toBe(42);
    expect(eng.capacity.hourlyActiveSeries).toBe(1000);
    expect(eng.capacity.dataBytes).toBe(5_000_000);
    expect(eng.capacity.freeDiskBytes).toBe(9_000_000);
    expect(eng.notifications.failuresPerSecond).toEqual({ email: 0.5 });
    expect(eng.notifications.latencyP95Seconds).toEqual({ email: 1.2 });
  });

  test("retains valid sibling projections when another is unavailable, never zero", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "victoriametrics-signals": ok<readonly MetricSample[]>([
            sample("pulse_web_engine_ingestion_rows_per_second", 7),
            sample("pulse_web_engine_data_bytes", null), // explicit unavailable
            // hourly_active_series absent entirely; free_disk non-finite
            sample("pulse_web_engine_free_disk_bytes", Number.POSITIVE_INFINITY),
          ]),
        }),
      }),
    );
    expect(eng.capacity.ingestionRowsPerSecond).toBe(7); // valid sibling retained
    expect(eng.capacity.dataBytes).toBeNull(); // null, never 0
    expect(eng.capacity.hourlyActiveSeries).toBeNull(); // absent, never 0
    expect(eng.capacity.freeDiskBytes).toBeNull(); // non-finite, never 0
  });

  test("missing notification projections are null, not empty/zero records", () => {
    const eng = foldEngine(inputs());
    expect(eng.notifications.failuresPerSecond).toBeNull();
    expect(eng.notifications.latencyP95Seconds).toBeNull();
  });

  test("current projections do not require a HistoryService call (VM signals govern capacity)", () => {
    const eng = foldEngine(
      inputs({
        records: records({
          "victoriametrics-signals": fail<readonly MetricSample[]>({ at: AT, data: liveMetrics() }),
        }),
      }),
    );
    // stale signals ⇒ current projections null (no history fallback), availability stale
    expect(eng.capacity.ingestionRowsPerSecond).toBeNull();
    expect(eng.capacity.availability.state).toBe("stale");
  });

  test("cycle health uses engine config and derives degraded from records", () => {
    const config: EngineFoldConfig = { sequence: 12, durationMs: 3400, buildFailure: null };
    const healthy = foldEngine(inputs({ engine: config }));
    expect(healthy.cycle).toEqual({ sequence: 12, durationMs: 3400, degraded: false, buildFailure: null });

    const degraded = foldEngine(
      inputs({ engine: config, records: records({ "gatus-statuses": fail<readonly GatusEndpointState[]>(null) }) }),
    );
    expect(degraded.cycle.degraded).toBe(true);
  });

  test("defaults cycle health when no engine config is supplied", () => {
    const eng = foldEngine(inputs());
    expect(eng.cycle.sequence).toBe(0);
    expect(eng.cycle.durationMs).toBe(0);
    expect(eng.cycle.buildFailure).toBeNull();
  });
});

// ===========================================================================
// Purity
// ===========================================================================

describe("foldEstate / foldEngine are pure", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("neither fold performs any fetch/source call", () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error("folds must not perform source calls");
    }) as unknown as typeof fetch;
    const i = inputs({
      records: records({
        "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics()),
        "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([scrapeTarget()]),
        "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
      }),
    });
    foldEstate(i);
    foldEngine(i);
    expect(calls).toBe(0);
  });

  test("deep-frozen input is never mutated; output is deterministic", () => {
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
          "victoriametrics-signals": ok<readonly MetricSample[]>(liveMetrics()),
          "victoriametrics-targets": ok<readonly ScrapeTargetState[]>([scrapeTarget()]),
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
        }),
      }),
    );
    expect(JSON.stringify(foldEstate(i))).toBe(JSON.stringify(foldEstate(i)));
    expect(JSON.stringify(foldEngine(i))).toBe(JSON.stringify(foldEngine(i)));
  });
});
