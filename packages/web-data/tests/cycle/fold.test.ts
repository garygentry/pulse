// packages/web-data/tests/cycle/fold.test.ts — evidence for the pure overview and alerts
// folds (item 020, 04-cycle-and-current-view-folds.md §§7–8). Self-contained V2 model +
// typed-record builders; no apps/web or fetch dependency (the folds are pure functions of
// their inputs, so determinism on repeated calls IS the zero-source-call / purity evidence).

import { describe, expect, test } from "bun:test";

import { foldOverview } from "../../src/cycle/fold-overview.js";
import { foldAlerts } from "../../src/cycle/fold-alerts.js";
import { buildCycleCandidate, foldCurrentViews, materializeCycle } from "../../src/cycle/fold.js";
import { CURRENT_MAX_PLAIN_BYTES, ERROR_MESSAGES } from "../../src/wire/common.js";
import type { CycleObservation, SourceId, SourceObservation, ViewId } from "../../src/wire/common.js";
import type { AckFoldRecord, CycleSourceRecords, FoldInputs } from "../../src/cycle/records.js";
import type { SourceRecord } from "../../src/sources/types.js";
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

const AT = "2026-01-01T00:00:00.000Z";
const OBSERVED = "2026-01-01T00:00:05.000Z";

// --- record builders -------------------------------------------------------

function ok<T>(data: T, at = AT): SourceRecord<T> {
  return { latest: { attemptedAt: at, result: { ok: true, data } }, lastGood: { at, data } };
}
function fail<T>(
  lastGood: { readonly at: string; readonly data: T } | null = null,
  kind: "timeout" | "malformed-json" | "transport" = "timeout",
): SourceRecord<T> {
  return {
    latest: {
      attemptedAt: OBSERVED,
      result: { ok: false, error: { kind, message: `bounded ${kind}`, status: null } },
    },
    lastGood,
  };
}

function metric(projection: string, host: string, value: number | null, extra: Record<string, string> = {}): MetricSample {
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
      {
        name: "DeadMansSwitch",
        type: "alerting",
        state: "firing",
        health: "healthy",
        lastEvaluationAt: AT,
        lastError: null,
        labels: {},
        annotations: {},
        deadman: true,
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

function coverage(over: Partial<WebCoverageArtifact> = {}): WebCoverageArtifact {
  return {
    formatVersion: 2,
    bundleId: BUNDLE_ID,
    covered: [
      { kind: "host", name: "hostA", collectionClass: "managed-linux", artifacts: ["a"], suppressed: null },
    ],
    gaps: [
      { kind: "service", name: "hostA/grafana", collectionClass: "managed-linux", artifacts: [], suppressed: null },
    ],
    suppressed: [],
    ...over,
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

// ---------------------------------------------------------------------------
// Overview fold
// ---------------------------------------------------------------------------

describe("foldOverview — compatibility + additive fields", () => {
  test("preserves compatibility fields with material generatedAt", () => {
    const ov = foldOverview(inputs());
    expect(ov.appVersion).toBe("1.2.3");
    expect(ov.generatedAt).toBe(OBSERVED); // body materialization time, not a source freshness
    expect(ov.estate).toEqual({ name: "home", timezone: "America/New_York", tzFallback: false });
    expect(ov.hosts.map((h) => h.name)).toEqual(["hostA", "hostD"]); // model declaration order
    expect(ov.sources.metrics.ok).toBe(true);
    expect(ov.hosts[0]!.services.map((s) => s.name)).toEqual(["grafana"]);
    // additive sections present
    expect(Array.isArray(ov.signals)).toBe(true);
    expect(Array.isArray(ov.recentChecks)).toBe(true);
    expect(ov.alertCounts).toEqual({ firing: 0, silenced: 0, inhibited: 0 });
    expect(ov.coverage.value).toEqual({ covered: 1, gaps: 1, extras: 0 });
  });

  test("host is ok only with affirmative liveness and no colouring alert", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": ok<readonly MetricSample[]>([
            metric("pulse_agent_up", "hostA", 1, { instance: "10.0.0.1:9100" }),
            metric("up", "hostA", 1, { instance: "10.0.0.1:9100" }),
          ]),
        }),
      }),
    );
    const hostA = ov.hosts.find((h) => h.name === "hostA")!;
    expect(hostA.live).toBe(true);
    expect(hostA.status).toBe("ok");
    // grafana link resolved from observed `up` series instance
    expect(hostA.grafana).toEqual({ boardUid: "pulse-host", url: "" }); // no origin ⇒ disabled url
  });

  test("a critical firing alert colours the host and appears in the strip", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": ok<readonly MetricSample[]>([metric("up", "hostA", 1)]),
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()]),
        }),
      }),
    );
    const hostA = ov.hosts.find((h) => h.name === "hostA")!;
    expect(hostA.status).toBe("critical");
    expect(hostA.activeAlerts.map((a) => a.name)).toEqual(["HighCpu"]);
    expect(ov.alerts.map((a) => a.name)).toEqual(["HighCpu"]);
    expect(ov.alerts[0]!.fingerprint).toBe("fp-0001");
    expect(ov.alerts[0]!.target).toEqual({ kind: "host", id: "host:hostA" });
  });

  test("counts retain all states and DeadMansSwitch is excluded from strip/counts", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([
            amAlert({ fingerprint: "f1", state: "firing" }),
            amAlert({ fingerprint: "f2", state: "silenced" }),
            amAlert({ fingerprint: "f3", state: "inhibited" }),
            amAlert({ fingerprint: "f4", name: "DeadMansSwitch", labels: { alertname: "DeadMansSwitch" } }),
          ]),
        }),
      }),
    );
    expect(ov.alertCounts).toEqual({ firing: 1, silenced: 1, inhibited: 1 });
    // strip is firing-only, unsilenced, and never the canary
    expect(ov.alerts.map((a) => a.name)).toEqual(["HighCpu"]);
  });

  test("coverage absence is unavailable with re-render guidance, not empty coverage", () => {
    const ov = foldOverview(inputs({ coverage: null }));
    expect(ov.coverage.value).toBeNull();
    expect(ov.coverage.availability.state).toBe("unavailable");
    expect(ov.coverage.availability.message).toContain("pulse render");
  });

  test("per-target liveness signals carry governing availability", () => {
    const ov = foldOverview(inputs());
    const hostSignal = ov.signals.find((s) => s.id === "host:hostA:liveness")!;
    expect(hostSignal.unit).toBe("state");
    expect(hostSignal.availability.source).toBe("victoriametrics-signals");
    const probeSignal = ov.signals.find((s) => s.id === "host:hostD:liveness")!;
    expect(probeSignal.availability.source).toBe("gatus-statuses"); // probe-only liveness ← gatus
  });

  test("status evidence is target-specific and retains last-good context", () => {
    const ov = foldOverview(inputs({
      records: records({
        "victoriametrics-signals": fail<readonly MetricSample[]>({
          at: AT,
          data: [metric("up", "hostA", 1)],
        }),
      }),
    }));
    const host = ov.hosts.find((item) => item.name === "hostA")!;
    expect(host.statusEvidence.availability.state).toBe("stale");
    expect(host.statusEvidence.availability.lastGoodAt).toBe(AT);
    expect(host.rollupEvidence.availability.lastGoodAt).toBe(AT);
  });

  test("retains multiple attributed check outcomes and an engine availability summary", () => {
    const endpoint: GatusEndpointState = {
      name: "hostA/grafana",
      group: "hostA",
      key: "hostA_hostA/grafana",
      identity: "hostA/grafana",
      expected: true,
      results: [
        { timestamp: AT, success: false, durationMs: 20, conditionResults: [] },
        { timestamp: OBSERVED, success: true, durationMs: 10, conditionResults: [] },
      ],
    };
    const ov = foldOverview(inputs({ records: records({ "gatus-statuses": ok([endpoint]) }) }));
    expect(ov.recentChecks).toHaveLength(2);
    expect(ov.recentChecks[0]!.target).toEqual({ kind: "service", id: "svc:hostA/grafana" });
    expect(ov.engine.value).toEqual({ ok: true });
  });

  test("declared deep-health signal values are attributed to the canonical service", () => {
    const ov = foldOverview(inputs({ records: records({
      "victoriametrics-signals": ok([metric("db", "hostA", 7, { service: "grafana" })]),
    }) }));
    const signal = ov.signals.find((item) => item.id.endsWith(":deep-health:db"))!;
    expect(signal.target).toEqual({ kind: "service", id: "svc:hostA/grafana" });
    expect(signal.value).toBe(7);
  });

  test("is deterministic across repeated calls (pure, zero source calls)", () => {
    const i = inputs({
      records: records({
        "victoriametrics-signals": ok<readonly MetricSample[]>([metric("up", "hostA", 1)]),
        "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()]),
      }),
    });
    expect(JSON.stringify(foldOverview(i))).toBe(JSON.stringify(foldOverview(i)));
  });
});

// ---------------------------------------------------------------------------
// never-silent-green matrix (success → failure w/ last-good → recovery)
// ---------------------------------------------------------------------------

describe("foldOverview — never-silent-green source matrix", () => {
  test("metrics failure forces unknown while unrelated data stays current", () => {
    const good: readonly MetricSample[] = [metric("up", "hostA", 1)];
    const ov = foldOverview(
      inputs({
        records: records({
          // metrics failed but retains last-good (live series is NOT trusted for a failed source)
          "victoriametrics-signals": fail<readonly MetricSample[]>({ at: AT, data: good }),
          // alerts remain current and empty
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([]),
        }),
      }),
    );
    const hostA = ov.hosts.find((h) => h.name === "hostA")!;
    expect(hostA.live).toBeNull(); // failed governing source ⇒ liveness unknown
    expect(hostA.status).toBe("unknown"); // never silently green
    expect(ov.sources.metrics.ok).toBe(false);
    expect(ov.sources.metrics.lastSuccess).toBe(AT); // stable last-good retained
    expect(ov.sources.alerts.ok).toBe(true); // unrelated source unaffected
  });

  test("alerts failure with no last-good yields unavailable, never zero-green", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": ok<readonly MetricSample[]>([metric("up", "hostA", 1)]),
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>(null),
        }),
      }),
    );
    const hostA = ov.hosts.find((h) => h.name === "hostA")!;
    expect(hostA.status).toBe("unknown"); // alerts unavailable ⇒ colour undeterminable
    expect(ov.sources.alerts.ok).toBe(false);
    expect(ov.sources.alerts.lastSuccess).toBeNull();
  });

  test("recovery restores current status on the next success", () => {
    const ov = foldOverview(
      inputs({
        records: records({
          "victoriametrics-signals": ok<readonly MetricSample[]>([metric("up", "hostA", 1)], OBSERVED),
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([]),
        }),
      }),
    );
    const hostA = ov.hosts.find((h) => h.name === "hostA")!;
    expect(hostA.status).toBe("ok");
    expect(ov.sources.metrics.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Alerts fold
// ---------------------------------------------------------------------------

describe("foldAlerts", () => {
  test("retains all AM states, rules incl deadman, active silences, attribution + historyRef", () => {
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([
            amAlert({ fingerprint: "f2", state: "silenced" }),
            amAlert({ fingerprint: "f1", state: "firing" }),
            amAlert({ fingerprint: "f3", state: "inhibited" }),
          ]),
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
          "alertmanager-silences": ok<readonly AlertmanagerSilence[]>([
            silence({ id: "s-expired", state: "expired" }),
            silence({ id: "s-active", state: "active" }),
          ]),
        }),
      }),
    );
    // all three states retained; ordering is state (firing<silenced<inhibited)
    expect(al.alerts.map((a) => a.state)).toEqual(["firing", "silenced", "inhibited"]);
    // exact model attribution + history ref for a matched host alert
    const firing = al.alerts.find((a) => a.state === "firing")!;
    expect(firing.target).toEqual({ kind: "host", id: "host:hostA" });
    expect(firing.historyRef).toEqual({ queryId: "alerts.firing", target: { kind: "host", id: "host:hostA" } });
    // rules include deadman entry
    expect(al.rules.map((r) => r.name).sort()).toEqual(["DeadMansSwitch", "HighCpu"]);
    expect(al.rules.find((r) => r.name === "DeadMansSwitch")!.deadman).toBe(true);
    // expired silence excluded; active retained
    expect(al.silences.map((s) => s.id)).toEqual(["s-active"]);
    expect(al.generatedAt).toBe(OBSERVED);
    expect(al.alertmanager.state).toBe("current");
    expect(al.vmalert.state).toBe("current");
  });

  test("unmatched alert has null target but still a valid estate-wide historyRef", () => {
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([
            amAlert({ labels: { alertname: "X", severity: "warning" } }),
          ]),
        }),
      }),
    );
    expect(al.alerts[0]!.target).toBeNull();
    expect(al.alerts[0]!.historyRef).toEqual({ queryId: "alerts.firing", target: null });
  });

  test("AM failure with last-good retains stale array; vmalert independent", () => {
    const lastGoodAlerts: readonly AlertmanagerAlert[] = [amAlert()];
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>({ at: AT, data: lastGoodAlerts }),
          "alertmanager-silences": fail<readonly AlertmanagerSilence[]>({ at: AT, data: [silence()] }),
          "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
        }),
      }),
    );
    expect(al.alerts).toHaveLength(1); // stale last-good retained, never an empty current set
    expect(al.alertmanager.state).toBe("stale");
    expect(al.alertmanager.lastGoodAt).toBe(AT);
    expect(al.vmalert.state).toBe("current"); // independent availability
  });

  test("AM failure with no last-good is unavailable with an empty set", () => {
    const al = foldAlerts(
      inputs({
        records: records({
          "alertmanager-alerts": fail<readonly AlertmanagerAlert[]>(null),
          "alertmanager-silences": fail<readonly AlertmanagerSilence[]>(null),
        }),
      }),
    );
    expect(al.alerts).toEqual([]);
    expect(al.alertmanager.state).toBe("unavailable");
    expect(al.alertmanager.lastGoodAt).toBeNull();
  });

  test("is deterministic across repeated calls", () => {
    const i = inputs({
      records: records({
        "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert(), amAlert({ fingerprint: "f2", state: "silenced" })]),
        "vmalert-rules": ok<readonly VmalertRuleGroup[]>([ruleGroup()]),
      }),
    });
    expect(JSON.stringify(foldAlerts(i))).toBe(JSON.stringify(foldAlerts(i)));
  });
});

// ---------------------------------------------------------------------------
// Cycle composition boundary — foldCurrentViews / materializeCycle / buildCycleCandidate
// (item 039 code, item 040 evidence; 04 §§1, 5, 6, 6.1). Proves: all five payloads are
// built off-side and assembled into one coherent immutable CycleState with an ordered safe
// observation; a sequence-only / observedAt-only change reuses payload objects, bytes, and
// ETags; and every construction failure is classified as data with NO partial cycle, after
// which a valid candidate recovers automatically.
// ---------------------------------------------------------------------------

const VIEW_IDS = ["overview", "alerts", "estate", "engine", "timeline"] as const satisfies readonly ViewId[];

const SOURCE_IDS = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "victoriametrics-buildinfo",
  "alertmanager-alerts",
  "alertmanager-silences",
  "alertmanager-status",
  "alertmanager-receivers",
  "vmalert-rules",
  "gatus-statuses",
  "grafana-health",
] as const satisfies readonly SourceId[];

/** A fixed publication observation with a current entry for every source (the coordinator
 *  builds the real one from records; composition only reads seq/observedAt/generation). */
function observation(seq: number, observedAt = OBSERVED, generation = "gen-uuid-0001"): CycleObservation {
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = { state: "current", lastAttemptAt: AT, lastSuccess: AT };
  return { generation, seq, observedAt, appVersion: "1.2.3", sources };
}

describe("buildCycleCandidate — coherent atomic composition (§§1,5,6)", () => {
  test("composes one coherent cycle: five materialized views, distinct ETags, full source map", async () => {
    const obs = observation(1);
    const result = await buildCycleCandidate(null, obs, inputs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cycle = result.cycle;

    // The exact publication observation is carried through unchanged (ordered safe seq/time).
    expect(cycle.observation).toBe(obs);
    expect(cycle.observation.seq).toBe(1);
    expect(cycle.observation.observedAt).toBe(OBSERVED);

    // Every view is materialized with a semantic identity and distinct strong plain/gzip ETags.
    for (const view of VIEW_IDS) {
      const p = cycle[view];
      expect(p.identity).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(p.plain.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(p.gzip.etag).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(p.plain.etag).not.toBe(p.gzip.etag);
      expect(p.plain.bytes.byteLength).toBeGreaterThan(0);
      expect(p.gzip.bytes.byteLength).toBeGreaterThan(0);
    }

    // The composed view values equal the pure fold outputs (built off-side, no mutation).
    const values = foldCurrentViews(inputs());
    expect(JSON.stringify(cycle.overview.value)).toBe(JSON.stringify(values.overview));
    expect(JSON.stringify(cycle.alerts.value)).toBe(JSON.stringify(values.alerts));
    expect(JSON.stringify(cycle.estate.value)).toBe(JSON.stringify(values.estate));
    expect(JSON.stringify(cycle.engine.value)).toBe(JSON.stringify(values.engine));
    expect(JSON.stringify(cycle.timeline.value)).toBe(JSON.stringify(values.timeline));

    // The retained record authority carries every fixed SourceId.
    expect(Object.keys(cycle.sources).sort()).toEqual([...SOURCE_IDS].sort());
  });

  test("a sequence-only / observedAt-only change reuses every payload object, bytes, and ETags", async () => {
    const a = await buildCycleCandidate(null, observation(1, OBSERVED), inputs());
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // The next cycle keeps identical records/model; only seq + observedAt advance. The per-view
    // generatedAt (= observedAt) is observation-only and excluded from semantic identity, so each
    // representation is reused verbatim while the observation advances (§5).
    const later = "2026-01-01T00:00:15.000Z";
    const b = await buildCycleCandidate(a.cycle, observation(2, later), inputs());
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    expect(b.cycle.observation.seq).toBe(2); // observation advanced
    for (const view of VIEW_IDS) {
      expect(b.cycle[view]).toBe(a.cycle[view]); // same payload object identity
      expect(b.cycle[view].value).toBe(a.cycle[view].value); // retained value + generatedAt
      expect(b.cycle[view].plain.bytes).toBe(a.cycle[view].plain.bytes);
      expect(b.cycle[view].gzip.bytes).toBe(a.cycle[view].gzip.bytes);
      expect(b.cycle[view].plain.etag).toBe(a.cycle[view].plain.etag);
      expect(b.cycle[view].gzip.etag).toBe(a.cycle[view].gzip.etag);
      expect(b.cycle[view].identity).toBe(a.cycle[view].identity);
    }
  });

  test("a genuine material change re-materializes with a distinct identity and fresh bytes", async () => {
    const a = await buildCycleCandidate(null, observation(1), inputs());
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // A firing alert changes the alerts (and overview) material — not merely a timestamp.
    const changed = inputs({
      records: records({
        "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([amAlert()]),
      }),
    });
    const b = await buildCycleCandidate(a.cycle, observation(2, "2026-01-01T00:00:15.000Z"), changed);
    expect(b.ok).toBe(true);
    if (!b.ok) return;

    expect(b.cycle.alerts.identity).not.toBe(a.cycle.alerts.identity);
    expect(b.cycle.alerts.plain.bytes).not.toBe(a.cycle.alerts.plain.bytes);
    // Timeline is unaffected by alert state, so it still reuses its prior representation.
    expect(b.cycle.timeline).toBe(a.cycle.timeline);
  });
});

describe("materializeCycle — record authority (§§1,6)", () => {
  test("retains a record for every SourceId, synthesizing a disabled grafana record when not configured", async () => {
    const recs = records({ "grafana-health": null });
    const values = foldCurrentViews(inputs({ records: recs }));
    const result = await materializeCycle(null, observation(1), recs, values);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.cycle.sources).sort()).toEqual([...SOURCE_IDS].sort());
    const grafana = result.cycle.sources["grafana-health"];
    expect(grafana.latest.result.ok).toBe(false); // synthetic disabled record stands in for null
    expect(grafana.lastGood).toBeNull();
  });
});

describe("buildCycleCandidate — classified construction failure, no partial cycle (§6.1)", () => {
  test("an oversized view payload is a classified payload-limit failure with no cycle built", async () => {
    // The estate view embeds the captured model verbatim, so an oversized model field pushes the
    // estate representation past the 5 MiB plain budget. Overview/alerts serialize small subsets
    // and materialize first, so the failure is attributed to the estate view.
    const big = "x".repeat(CURRENT_MAX_PLAIN_BYTES + 1024);
    const oversized = model({ routingOverrides: [{ note: big }] as never });
    const result = await buildCycleCandidate(null, observation(1), inputs({ model: oversized }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("payload-limit");
    expect(result.error.view).toBe("estate");
    expect(result.error.message).toBe(ERROR_MESSAGES.CYCLE_BUILD_FAILED);
    expect("cycle" in result).toBe(false); // no partial cycle object leaks
  });

  test("a fold contract violation is caught and classified kind:'fold' without a partial cycle", async () => {
    // A malformed model (missing hosts) makes a fold dereference throw; buildCycleCandidate catches
    // the programmer bug at the single boundary and maps it to kind:'fold' with no raw exception text.
    const broken = { ...model(), hosts: undefined } as unknown as WebEstateModelV2;
    const result = await buildCycleCandidate(null, observation(1), inputs({ model: broken }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("fold");
    expect(result.error.view).toBeNull();
    expect(result.error.message).toBe(ERROR_MESSAGES.CYCLE_BUILD_FAILED);
    expect("cycle" in result).toBe(false);
  });

  test("a valid candidate after a construction failure recovers automatically", async () => {
    const big = "x".repeat(CURRENT_MAX_PLAIN_BYTES + 1024);
    const failed = await buildCycleCandidate(
      null,
      observation(1),
      inputs({ model: model({ routingOverrides: [{ note: big }] as never }) }),
    );
    expect(failed.ok).toBe(false);

    // The very next valid candidate builds a complete cycle — no lingering partial state.
    const recovered = await buildCycleCandidate(null, observation(1), inputs());
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    for (const view of VIEW_IDS) expect(recovered.cycle[view].identity).toMatch(/^sha256:/);
  });
});

// ---------------------------------------------------------------------------
// Ack join (mutation-foundation item 018, 06 §5.1–§5.4). App-local ack state rides on
// FoldInputs.acks: omitted ⇒ byte-identical to today's output (no `ack`/`acked` keys);
// present ⇒ a fresh `ack` copy on the matching alert in any state and an `acked: true`
// marker on the firing overview summary only. Ack fields are material to identity/ETag.
// ---------------------------------------------------------------------------

describe("fold ack join (REQ-ACK-06, REQ-ACK-07, REQ-SEC-06)", () => {
  const ACK_A: AckFoldRecord = { by: "Gary Gentry", at: "2026-01-01T00:00:03.000Z", note: "looking" };
  const ACK_B: AckFoldRecord = { by: "Op Two", at: "2026-01-01T00:00:04.000Z", note: null };

  /** Firing host alert, firing service alert, silenced and inhibited alerts. */
  function ackRecords(): CycleSourceRecords {
    return records({
      "victoriametrics-signals": ok<readonly MetricSample[]>([metric("up", "hostA", 1)]),
      "alertmanager-alerts": ok<readonly AlertmanagerAlert[]>([
        amAlert({ fingerprint: "f-host" }),
        amAlert({
          fingerprint: "f-svc",
          name: "GrafanaDown",
          labels: { alertname: "GrafanaDown", severity: "warning", host: "hostA", service: "grafana" },
          severity: "warning",
        }),
        amAlert({ fingerprint: "f-sil", state: "silenced" }),
        amAlert({ fingerprint: "f-inh", state: "inhibited" }),
      ]),
    });
  }

  const hasKey = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

  test("acks omitted: no alert carries `ack` and no summary carries `acked` (output unchanged)", () => {
    const base = inputs({ records: ackRecords() });
    const al = foldAlerts(base);
    const ov = foldOverview(base);
    for (const a of al.alerts) expect(hasKey(a, "ack")).toBe(false);
    for (const a of ov.alerts) expect(hasKey(a, "acked")).toBe(false);
    for (const h of ov.hosts) {
      for (const a of h.activeAlerts) expect(hasKey(a, "acked")).toBe(false);
      for (const s of h.services) for (const a of s.activeAlerts) expect(hasKey(a, "acked")).toBe(false);
    }
    // Exact pre-change shape of the firing host alert (no additive key).
    expect(al.alerts.find((a) => a.fingerprint === "f-host")).toStrictEqual({
      fingerprint: "f-host",
      state: "firing",
      severity: "critical",
      name: "HighCpu",
      target: { kind: "host", id: "host:hostA" },
      startsAt: AT,
      labels: { alertname: "HighCpu", severity: "critical", host: "hostA" },
      annotations: { summary: "cpu high" },
      receivers: ["team"],
      silencedBy: [],
      inhibitedBy: [],
      group: null,
      historyRef: { queryId: "alerts.firing", target: { kind: "host", id: "host:hostA" } },
    });
    expect(ov.alerts.find((a) => a.fingerprint === "f-host")).toStrictEqual({
      fingerprint: "f-host",
      name: "HighCpu",
      severity: "critical",
      startsAt: AT,
      target: { kind: "host", id: "host:hostA" },
      summary: "cpu high",
    });
    // An empty map is equivalent to omission.
    const empty = inputs({ records: ackRecords(), acks: new Map() });
    expect(foldAlerts(empty)).toStrictEqual(al);
    expect(foldOverview(empty)).toStrictEqual(ov);
  });

  test("acks present: only matching alerts carry a fresh {by,at,note} copy, silenced included", () => {
    const acks = new Map<string, AckFoldRecord>([
      ["f-host", ACK_A],
      ["f-sil", ACK_B],
      ["f-unknown", ACK_A], // no such alert: joins nothing
    ]);
    const al = foldAlerts(inputs({ records: ackRecords(), acks }));
    const byFp = new Map(al.alerts.map((a) => [a.fingerprint, a]));
    expect(byFp.get("f-host")!.ack).toStrictEqual({ by: ACK_A.by, at: ACK_A.at, note: "looking" });
    expect(byFp.get("f-sil")!.state).toBe("silenced");
    expect(byFp.get("f-sil")!.ack).toStrictEqual({ by: "Op Two", at: ACK_B.at, note: null });
    expect(hasKey(byFp.get("f-svc")!, "ack")).toBe(false);
    expect(hasKey(byFp.get("f-inh")!, "ack")).toBe(false);
    // Fresh object: never aliases the input map entry; exactly three keys, no `subject`.
    expect(byFp.get("f-host")!.ack).not.toBe(ACK_A);
    expect(byFp.get("f-sil")!.ack).not.toBe(ACK_B);
    expect(Object.keys(byFp.get("f-host")!.ack!).sort()).toEqual(["at", "by", "note"]);
    expect(JSON.stringify(al)).not.toContain("subject");
    // Everything else about the alert is unchanged vs. the no-acks fold.
    const plain = foldAlerts(inputs({ records: ackRecords() }));
    const { ack: _dropped, ...rest } = byFp.get("f-host")!;
    expect(rest).toStrictEqual(plain.alerts.find((a) => a.fingerprint === "f-host")!);
    expect(al.alerts.map((a) => a.fingerprint)).toEqual(plain.alerts.map((a) => a.fingerprint));
  });

  test("acked:true only on firing summaries, in the strip and host/service activeAlerts; engine unchanged", () => {
    const acks = new Map<string, AckFoldRecord>([
      ["f-host", ACK_A],
      ["f-svc", ACK_B],
      ["f-sil", ACK_A], // silenced: not in the firing strip, so no marker anywhere
    ]);
    const ov = foldOverview(inputs({ records: ackRecords(), acks }));
    const plain = foldOverview(inputs({ records: ackRecords() }));
    const strip = new Map(ov.alerts.map((a) => [a.fingerprint, a]));
    expect(strip.get("f-host")!.acked).toBe(true);
    expect(strip.get("f-svc")!.acked).toBe(true);
    expect(strip.has("f-sil")).toBe(false);
    const hostA = ov.hosts.find((h) => h.name === "hostA")!;
    expect(hostA.activeAlerts.map((a) => [a.fingerprint, a.acked])).toEqual([["f-host", true]]);
    const grafana = hostA.services.find((s) => s.name === "grafana")!;
    expect(grafana.activeAlerts.map((a) => [a.fingerprint, a.acked])).toEqual([["f-svc", true]]);
    // Partial ack set: an unacked firing alert stays marker-free.
    const partial = foldOverview(inputs({ records: ackRecords(), acks: new Map([["f-host", ACK_A]]) }));
    expect(hasKey(partial.alerts.find((a) => a.fingerprint === "f-svc")!, "acked")).toBe(false);
    // Nothing but the marker differs: statuses, counts, strip order and engine summary are identical.
    expect(ov.engine).toStrictEqual(plain.engine);
    expect(ov.alertCounts).toStrictEqual(plain.alertCounts);
    expect(hostA.status).toBe(plain.hosts.find((h) => h.name === "hostA")!.status);
    expect(ov.alerts.map((a) => a.fingerprint)).toEqual(plain.alerts.map((a) => a.fingerprint));
    const strip0 = ov.alerts.map(({ acked: _a, ...r }) => r);
    expect(strip0).toStrictEqual([...plain.alerts]);
  });

  test("an ack change alters the alerts identity/ETag; an unchanged ack map reuses it", async () => {
    const withAck = (acks: ReadonlyMap<string, AckFoldRecord>): FoldInputs =>
      inputs({ records: ackRecords(), acks });
    const a = await buildCycleCandidate(null, observation(1), withAck(new Map([["f-host", ACK_A]])));
    expect(a.ok).toBe(true);
    if (!a.ok) return;

    // Unchanged ack map (fresh but equal Map) ⇒ same payload objects and ETags.
    const same = await buildCycleCandidate(
      a.cycle,
      observation(2, "2026-01-01T00:00:15.000Z"),
      withAck(new Map([["f-host", { ...ACK_A }]])),
    );
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.cycle.alerts).toBe(a.cycle.alerts);
    expect(same.cycle.overview).toBe(a.cycle.overview);

    // A changed note is material: new alerts identity and ETag; the overview marker is unchanged.
    const noteChanged = await buildCycleCandidate(
      same.cycle,
      observation(3, "2026-01-01T00:00:25.000Z"),
      withAck(new Map([["f-host", { ...ACK_A, note: "different" }]])),
    );
    expect(noteChanged.ok).toBe(true);
    if (!noteChanged.ok) return;
    expect(noteChanged.cycle.alerts.identity).not.toBe(a.cycle.alerts.identity);
    expect(noteChanged.cycle.alerts.plain.etag).not.toBe(a.cycle.alerts.plain.etag);
    expect(noteChanged.cycle.overview).toBe(a.cycle.overview);

    // Removing the ack changes both alerts and (firing) overview identities; the timeline reuses.
    const removed = await buildCycleCandidate(
      noteChanged.cycle,
      observation(4, "2026-01-01T00:00:35.000Z"),
      withAck(new Map()),
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.cycle.alerts.identity).not.toBe(noteChanged.cycle.alerts.identity);
    expect(removed.cycle.overview.identity).not.toBe(noteChanged.cycle.overview.identity);
    expect(removed.cycle.overview.plain.etag).not.toBe(noteChanged.cycle.overview.plain.etag);
    expect(removed.cycle.timeline).toBe(noteChanged.cycle.timeline);

    // materializeCycle carries the joined ack into the published alerts value.
    const mi = withAck(new Map([["f-host", ACK_A]]));
    const m = await materializeCycle(null, observation(5), mi.records, foldCurrentViews(mi));
    const joined = m.ok ? m.cycle.alerts.value.alerts.find((x) => x.fingerprint === "f-host") : undefined;
    expect(joined?.ack).toStrictEqual({ by: ACK_A.by, at: ACK_A.at, note: ACK_A.note });
  });
});
