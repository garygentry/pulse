// apps/web/tests/metrics.test.ts — the /metrics exposition telemetry families (10 §6).
//
// Unit-drives the pure `renderMetrics` with a hand-built RuntimeStatus, a bounded runtime view (a fake
// cycle observation + history stats + open-stream count), and the process-lifetime counter record
// functions. Asserts: every required `pulse_web_*` family exists with exact closed labels; the
// cycle/source/SSE/history gauges reflect the view and return to zero; counters increment by
// source/outcome/event/query; and no entity/error/label value ever appears. The runtime-driven
// end-to-end wiring (edge events, fixed cardinality) is `telemetry.test.ts`.

import { afterEach, describe, expect, test } from "bun:test";

import {
  renderMetrics,
  recordCyclePublication,
  recordUpstreamCall,
  recordSseEvent,
  recordHistoryRequest,
  recordMutation,
  recordMutationRefusal,
  recordAuditWriteFailure,
  recordAckAutoClears,
  setWritePathStatusProvider,
  __resetMetricsForTest,
  type MetricsRuntimeView,
} from "../src/server/routes/metrics.js";
import type { RuntimeStatus } from "../src/server/refresh.js";
import type { SourceHealth } from "../src/shared/snapshot.js";
import type {
  AvailabilityState,
  CycleObservation,
  SourceId,
  SourceObservation,
} from "@pulse/web-data/wire";
import type { HistoryStats } from "@pulse/web-data/history";
import type { WritePathSnapshot } from "../src/server/mutations/write-path.js";

// ── Builders ────────────────────────────────────────────────────────────────────────────────────

const SOURCE_IDS: readonly SourceId[] = [
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
];

function health(over: Partial<SourceHealth> = {}): SourceHealth {
  return { ok: true, lastSuccess: "2026-08-22T12:00:00.000Z", error: null, ...over };
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    sources: { metrics: health(), alerts: health(), checks: health() },
    model: { loaded: true, formatVersion: 2, error: null },
    lastSnapshotAt: Date.parse("2026-08-22T12:00:00.000Z"),
    lastCycleBuildFailure: null,
    lastCycleDurationMs: null,
    ...over,
  };
}

/** A cycle observation where every source is `current` unless overridden. */
function observation(over: Partial<Record<SourceId, AvailabilityState>> = {}, seq = 7): CycleObservation {
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const sid of SOURCE_IDS) {
    sources[sid] = {
      state: over[sid] ?? "current",
      lastAttemptAt: "2026-08-22T12:00:00.000Z",
      lastSuccess: "2026-08-22T12:00:00.000Z",
    };
  }
  return {
    generation: "6eb63373-6d83-4b0c-8323-f42f6f11ab20",
    seq,
    observedAt: "2026-08-22T12:00:00.000Z",
    appVersion: "test",
    sources,
  };
}

function historyStats(over: Partial<HistoryStats> = {}): HistoryStats {
  return { active: 0, queued: 0, inFlightKeys: 0, cachedKeys: 0, cachedBytes: 0, waiters: 0, ...over };
}

function view(over: Partial<MetricsRuntimeView> = {}): MetricsRuntimeView {
  return { cycleObservation: observation(), history: historyStats(), sseStreams: 0, ...over };
}

const REQUIRED_FAMILIES = [
  // Retained legacy families.
  "pulse_web_build_info",
  "pulse_web_source_up",
  "pulse_web_snapshot_age_seconds",
  "pulse_web_estate_model_loaded",
  "pulse_web_refresh_total",
  "pulse_web_http_requests_total",
  // 10 §6 telemetry families.
  "pulse_web_cycle_sequence",
  "pulse_web_cycle_duration_seconds",
  "pulse_web_cycle_publications_total",
  "pulse_web_upstream_calls_total",
  "pulse_web_sse_streams",
  "pulse_web_sse_events_total",
  "pulse_web_history_requests_total",
  "pulse_web_history_cache_hits_total",
  "pulse_web_history_active",
  "pulse_web_history_queued",
] as const;

/** The five mutation / write-path families (mutation-foundation 04 §7.1). The first four always emit
 *  `# TYPE`; `pulse_web_write_path_status` only while a status provider is installed. */
const MUTATION_FAMILIES = [
  "pulse_web_mutations_total",
  "pulse_web_mutation_refusals_total",
  "pulse_web_audit_write_failures_total",
  "pulse_web_ack_auto_clears_total",
  "pulse_web_write_path_status",
] as const;

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

describe("renderMetrics — required family set (10 §6)", () => {
  afterEach(() => __resetMetricsForTest());

  test("every required pulse_web_* family emits its TYPE line, even with no series", () => {
    const text = renderMetrics(status(), Date.now(), view());
    for (const family of REQUIRED_FAMILIES) expect(text).toContain(`# TYPE ${family}`);
  });

  test("a legacy 2-arg call still renders (all telemetry families zero-valued)", () => {
    const text = renderMetrics(status(), Date.now());
    for (const family of REQUIRED_FAMILIES) expect(text).toContain(`# TYPE ${family}`);
    expect(text).toContain("pulse_web_cycle_sequence 0");
    expect(text).toContain("pulse_web_sse_streams 0");
    expect(text).toContain("pulse_web_history_active 0");
  });
});

describe("renderMetrics — source_up gauge (10 §6)", () => {
  afterEach(() => __resetMetricsForTest());

  test("SourceId series are 1 iff current; legacy metrics/alerts/checks are retained", () => {
    const text = renderMetrics(
      status({ sources: { metrics: health(), alerts: health({ ok: false, error: "x" }), checks: health() } }),
      Date.now(),
      view({ cycleObservation: observation({ "alertmanager-alerts": "stale", "grafana-health": "not-configured" }) }),
    );
    // Legacy vocabulary retained.
    expect(text).toContain('pulse_web_source_up{source="metrics"} 1');
    expect(text).toContain('pulse_web_source_up{source="alerts"} 0');
    expect(text).toContain('pulse_web_source_up{source="checks"} 1');
    // SourceId vocabulary: current → 1, stale/not-configured → 0.
    expect(text).toContain('pulse_web_source_up{source="victoriametrics-signals"} 1');
    expect(text).toContain('pulse_web_source_up{source="alertmanager-alerts"} 0');
    expect(text).toContain('pulse_web_source_up{source="grafana-health"} 0');
    // Exactly the ten SourceId series exist (no entity-derived source label).
    for (const sid of SOURCE_IDS) expect(text).toContain(`pulse_web_source_up{source="${sid}"}`);
  });

  test("before the first cycle every SourceId source_up is 0", () => {
    const text = renderMetrics(status(), Date.now(), view({ cycleObservation: null }));
    for (const sid of SOURCE_IDS) expect(text).toContain(`pulse_web_source_up{source="${sid}"} 0`);
  });
});

describe("renderMetrics — cycle gauges (10 §6)", () => {
  afterEach(() => __resetMetricsForTest());

  test("cycle_sequence reflects the observation; duration reflects the last publication", () => {
    const text = renderMetrics(status({ lastCycleDurationMs: 1500 }), Date.now(), view({ cycleObservation: observation({}, 42) }));
    expect(text).toContain("pulse_web_cycle_sequence 42");
    expect(text).toContain("pulse_web_cycle_duration_seconds 1.5");
  });

  test("cycle_duration is NaN before the first publication", () => {
    const text = renderMetrics(status({ lastCycleDurationMs: null }), Date.now(), view());
    expect(text).toContain("pulse_web_cycle_duration_seconds NaN");
  });

  test("snapshot_age reflects the observation time carried in lastSnapshotAt", () => {
    const text = renderMetrics(
      status({ lastSnapshotAt: Date.parse("2026-08-22T12:00:00.000Z") }),
      Date.parse("2026-08-22T12:00:07.000Z"),
      view(),
    );
    expect(text).toContain("pulse_web_snapshot_age_seconds 7");
  });
});

describe("renderMetrics — publication & upstream counters (10 §6)", () => {
  afterEach(() => __resetMetricsForTest());

  test("cycle_publications_total increments by closed outcome", () => {
    recordCyclePublication("success");
    recordCyclePublication("success");
    recordCyclePublication("degraded");
    recordCyclePublication("failed");
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_cycle_publications_total{outcome="success"} 2');
    expect(text).toContain('pulse_web_cycle_publications_total{outcome="degraded"} 1');
    expect(text).toContain('pulse_web_cycle_publications_total{outcome="failed"} 1');
  });

  test("upstream_calls_total increments by SourceId and outcome", () => {
    recordUpstreamCall("victoriametrics-signals", "success");
    recordUpstreamCall("victoriametrics-signals", "success");
    recordUpstreamCall("gatus-statuses", "failure");
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_upstream_calls_total{source="victoriametrics-signals",outcome="success"} 2');
    expect(text).toContain('pulse_web_upstream_calls_total{source="gatus-statuses",outcome="failure"} 1');
  });
});

describe("renderMetrics — SSE telemetry (10 §6)", () => {
  afterEach(() => __resetMetricsForTest());

  test("sse_streams gauge reflects the view and returns to zero", () => {
    expect(renderMetrics(status(), Date.now(), view({ sseStreams: 3 }))).toContain("pulse_web_sse_streams 3");
    expect(renderMetrics(status(), Date.now(), view({ sseStreams: 0 }))).toContain("pulse_web_sse_streams 0");
  });

  test("sse_events_total increments by event and outcome", () => {
    recordSseEvent("connected", "success");
    recordSseEvent("displaced", "success");
    recordSseEvent("write-failed", "failure");
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_sse_events_total{event="connected",outcome="success"} 1');
    expect(text).toContain('pulse_web_sse_events_total{event="displaced",outcome="success"} 1');
    expect(text).toContain('pulse_web_sse_events_total{event="write-failed",outcome="failure"} 1');
  });
});

describe("renderMetrics — history telemetry (10 §6)", () => {
  afterEach(() => __resetMetricsForTest());

  test("history_requests_total records delivery/error by QueryId + fixed operation names", () => {
    recordHistoryRequest("host.cpu.utilization", "hit");
    recordHistoryRequest("host.cpu.utilization", "miss");
    recordHistoryRequest("alert-intervals", "coalesced");
    recordHistoryRequest("endpoint-history", "error");
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_history_requests_total{query="host.cpu.utilization",outcome="hit"} 1');
    expect(text).toContain('pulse_web_history_requests_total{query="host.cpu.utilization",outcome="miss"} 1');
    expect(text).toContain('pulse_web_history_requests_total{query="alert-intervals",outcome="coalesced"} 1');
    expect(text).toContain('pulse_web_history_requests_total{query="endpoint-history",outcome="error"} 1');
  });

  test("history_cache_hits_total counts only the hit deliveries per query", () => {
    recordHistoryRequest("host.cpu.utilization", "hit");
    recordHistoryRequest("host.cpu.utilization", "hit");
    recordHistoryRequest("host.cpu.utilization", "miss");
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_history_cache_hits_total{query="host.cpu.utilization"} 2');
  });

  test("history_active/queued gauges reflect the live stats and return to zero", () => {
    expect(renderMetrics(status(), Date.now(), view({ history: historyStats({ active: 2, queued: 5 }) }))).toContain(
      "pulse_web_history_active 2",
    );
    const idle = renderMetrics(status(), Date.now(), view({ history: historyStats() }));
    expect(idle).toContain("pulse_web_history_active 0");
    expect(idle).toContain("pulse_web_history_queued 0");
  });
});

describe("renderMetrics — mutation & write-path families (REQ-OBS-01, REQ-OBS-02, 04 §7.1)", () => {
  afterEach(() => __resetMetricsForTest());

  const HEALTHY: WritePathSnapshot = {
    audit: { ok: true, reason: null },
    acks: { ok: true, reason: null },
    proposals: { ok: true, reason: null },
    secret: { ok: false, reason: "secret-missing" },
    alertmanager: { ok: true, reason: null },
  };

  test("empty state: the four counters emit # TYPE, ack auto-clears is 0, no gauge without a provider (REQ-OBS-01)", () => {
    const text = renderMetrics(status(), Date.now(), view());
    for (const family of MUTATION_FAMILIES.slice(0, 4)) expect(text).toContain(`# TYPE ${family} counter`);
    expect(text).toContain("\npulse_web_ack_auto_clears_total 0\n");
    expect(text).not.toContain("pulse_web_write_path_status");
  });

  test("mutations_total counts by action and closed outcome (REQ-OBS-01)", () => {
    recordMutation("silence.create", "succeeded");
    recordMutation("silence.create", "succeeded");
    recordMutation("silence.create", "replayed");
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_mutations_total{action="silence.create",outcome="succeeded"} 2');
    expect(text).toContain('pulse_web_mutations_total{action="silence.create",outcome="replayed"} 1');
  });

  test("mutation_refusals_total counts by action and bounded reason; no `unmatched` label (REQ-OBS-01, V-013)", () => {
    recordMutationRefusal("ack.set", "cross-origin");
    // Type-level only — never invoked, so no series is recorded.
    const _typeOnly = (): void => {
      // @ts-expect-error — `unmatched` is not a MutationAction (V-013).
      recordMutationRefusal("unmatched", "cross-origin");
    };
    void _typeOnly;
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_mutation_refusals_total{action="ack.set",reason="cross-origin"} 1');
    expect(text).not.toContain("unmatched");
  });

  test("audit_write_failures_total counts by phase (REQ-OBS-02)", () => {
    recordAuditWriteFailure("finalize");
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain('pulse_web_audit_write_failures_total{phase="finalize"} 1');
    expect(text).not.toContain('phase="attempted"');
  });

  test("ack_auto_clears_total ignores non-positive and non-integer counts (REQ-OBS-01)", () => {
    recordAckAutoClears(3);
    recordAckAutoClears(0);
    recordAckAutoClears(-1);
    recordAckAutoClears(1.5);
    expect(renderMetrics(status(), Date.now(), view())).toContain("\npulse_web_ack_auto_clears_total 3\n");
  });

  test("an installed provider yields exactly 5 write_path_status series of value 1 (REQ-OBS-02)", () => {
    setWritePathStatusProvider(() => HEALTHY);
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).toContain("# TYPE pulse_web_write_path_status gauge");
    const series = text.split("\n").filter((l) => l.startsWith("pulse_web_write_path_status{"));
    expect(series).toEqual([
      'pulse_web_write_path_status{store="audit",reason="ok"} 1',
      'pulse_web_write_path_status{store="acks",reason="ok"} 1',
      'pulse_web_write_path_status{store="proposals",reason="ok"} 1',
      'pulse_web_write_path_status{store="secret",reason="secret-missing"} 1',
      'pulse_web_write_path_status{store="alertmanager",reason="ok"} 1',
    ]);
  });

  test("a throwing provider omits the gauge family and render does not throw (REQ-OBS-02)", () => {
    setWritePathStatusProvider(() => {
      throw new Error("boom");
    });
    let text = "";
    expect(() => {
      text = renderMetrics(status(), Date.now(), view());
    }).not.toThrow();
    expect(text).not.toContain("pulse_web_write_path_status");
    expect(text).not.toContain("boom");
  });

  test("__resetMetricsForTest clears the mutation state and uninstalls the provider (REQ-OBS-01)", () => {
    recordMutation("ack.set", "failed");
    recordAckAutoClears(2);
    setWritePathStatusProvider(() => HEALTHY);
    __resetMetricsForTest();
    const text = renderMetrics(status(), Date.now(), view());
    expect(text).not.toContain("pulse_web_mutations_total{");
    expect(text).toContain("\npulse_web_ack_auto_clears_total 0\n");
    expect(text).not.toContain("pulse_web_write_path_status");
  });
});
