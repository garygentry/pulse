// apps/web/tests/alerts-fixtures.ts — alert-triage-owned typed fixture builder (08 §3, settles OQ-03).
//
// Builds `AlertsPayload` / `IntervalHistoryPayload` / `ErrorEnvelope` / `SessionPayload` values from
// `@pulse/web-data/wire` types ONLY (type imports, erased at runtime). Distinct from web-data-tier's
// `tests/factories/wire.ts`, which is neither imported nor edited (tech-spec §6.5). Every literal is
// checked against the wire contract with `satisfies`/annotations and returned deep-frozen, so a wire
// change breaks these fixtures at `typecheck` — the fixture set is a contract tripwire.

import type {
  ActiveAlert,
  ActiveSilence,
  AlertAck,
  AlertHistoryLane,
  AlertsPayload,
  DataAvailability,
  ErrorEnvelope,
  IntervalHistoryPayload,
  RuleState,
  SessionPayload,
} from "@pulse/web-data/wire";

/** The standardized alerts coverage matrix (08 §3). */
export type AlertsScenario =
  | "mixed" // firing + silenced + inhibited mix, both sources current (SC-01)
  | "am-down" // Alertmanager DataAvailability.state = "unavailable" (SC-04)
  | "vmalert-down" // vmalert unavailable (SC-04)
  | "stale" // a source state = "stale" with a non-null lastGoodAt (REQ-DEGRADE-02)
  | "empty-healthy" // no firing alerts, both sources current (REQ-TRIAGE-06)
  | "unknown-sel"; // a payload plus a sel fingerprint matching no firing alert (REQ-ROUTE-03)

/** Every scenario, in declaration order — for table-driven tests. */
export const ALERTS_SCENARIOS: readonly AlertsScenario[] = Object.freeze([
  "mixed",
  "am-down",
  "vmalert-down",
  "stale",
  "empty-healthy",
  "unknown-sel",
]);

/** Kinds accepted by {@link makeHistoryPayload}. */
export type HistoryKind = "ready" | "overflow" | "unmatched";

/** Fixed materialization instant shared by every fixture (deterministic, no `Date.now()`). */
export const FIXTURE_NOW = "2026-09-22T12:00:00.000Z";
/** Last complete success reported by degraded (stale/unavailable) sources. */
export const FIXTURE_LAST_GOOD_AT = "2026-09-22T11:45:00.000Z";

/** Stable fingerprints of the `mixed` alerts, for selection/deep-link assertions. */
export const FIXTURE_FINGERPRINTS = Object.freeze({
  /** Firing critical on host:web-01 with the alerts.firing history ref. */ hostDown: "fp-host-down",
  /** Firing warning on host:web-01 (related-by-target sibling of hostDown). */ diskFull: "fp-disk-full",
  /** Silenced warning on svc:web-01/backup (silencedBy both a known and a missing silence id). */ backupAge: "fp-backup-age",
  /** Inhibited info on host:web-01 with historyRef null. */ loadHigh: "fp-load-high",
  /** Firing critical with target null (unattributed) and historyRef null. */ unattributed: "fp-unattributed",
});

/** A fingerprint that matches no alert in any scenario (the `unknown-sel` deep link). */
export const UNKNOWN_SEL_FINGERPRINT = "fp-no-longer-firing";

/** Silence ids referenced by the `mixed` alerts; `missing` is deliberately absent from `silences`. */
export const FIXTURE_SILENCE_IDS = Object.freeze({
  backup: "silence-backup-window",
  regex: "silence-regex-negated",
  missing: "silence-not-in-snapshot",
});

// ---------------------------------------------------------------------------
// Deep freeze
// ---------------------------------------------------------------------------

/** Recursively freeze a plain JSON-shaped value in place and return it with its type intact. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze<unknown>(child);
    Object.freeze(value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

function availability(
  source: DataAvailability["source"],
  state: DataAvailability["state"],
): DataAvailability {
  switch (state) {
    case "current":
      return { state, source, lastGoodAt: FIXTURE_NOW, message: null };
    case "stale":
      return { state, source, lastGoodAt: FIXTURE_LAST_GOOD_AT, message: "Evidence is older than its freshness window." };
    case "unavailable":
      return { state, source, lastGoodAt: FIXTURE_LAST_GOOD_AT, message: "The upstream source could not be reached." };
    case "not-configured":
      return { state, source, lastGoodAt: null, message: "The upstream source is not configured." };
  }
}

function mixedAlerts(): readonly ActiveAlert[] {
  return [
    {
      fingerprint: FIXTURE_FINGERPRINTS.hostDown,
      state: "firing",
      severity: "critical",
      name: "HostDown",
      target: { kind: "host", id: "host:web-01" },
      startsAt: "2026-09-22T11:30:00.000Z",
      labels: { alertname: "HostDown", severity: "critical", host: "web-01", instance: "web-01:9100", team: "platform" },
      annotations: {
        summary: "web-01 is not reporting heartbeats",
        description: "No heartbeat from web-01 for more than 5 minutes.",
        runbook_url: "https://runbooks.example.test/host-down",
      },
      receivers: ["pager", "chat"],
      silencedBy: [],
      inhibitedBy: [],
      group: "host-liveness",
      historyRef: { queryId: "alerts.firing", target: { kind: "host", id: "host:web-01" } },
    },
    {
      fingerprint: FIXTURE_FINGERPRINTS.diskFull,
      state: "firing",
      severity: "warning",
      name: "DiskAlmostFull",
      target: { kind: "host", id: "host:web-01" },
      startsAt: "2026-09-22T09:00:00.000Z",
      labels: { alertname: "DiskAlmostFull", severity: "warning", host: "web-01", instance: "web-01:9100", mountpoint: "/var" },
      annotations: {
        summary: "/var on web-01 is above 90%",
        runbook_url: "javascript:alert(1)",
      },
      receivers: ["chat"],
      silencedBy: [],
      inhibitedBy: [],
      group: "host-capacity",
      historyRef: { queryId: "alerts.firing", target: { kind: "host", id: "host:web-01" } },
    },
    {
      fingerprint: FIXTURE_FINGERPRINTS.backupAge,
      state: "silenced",
      severity: "warning",
      name: "BackupTooOld",
      target: { kind: "service", id: "svc:web-01/backup" },
      startsAt: "2026-09-21T06:00:00.000Z",
      labels: { alertname: "BackupTooOld", severity: "warning", host: "web-01", service: "backup" },
      annotations: { description: "The last successful backup is older than 26 hours." },
      receivers: [],
      silencedBy: [FIXTURE_SILENCE_IDS.backup, FIXTURE_SILENCE_IDS.missing],
      inhibitedBy: [],
      group: null,
      historyRef: { queryId: "alerts.firing", target: { kind: "service", id: "svc:web-01/backup" } },
    },
    {
      fingerprint: FIXTURE_FINGERPRINTS.loadHigh,
      state: "inhibited",
      severity: "info",
      name: "LoadHigh",
      target: { kind: "host", id: "host:web-01" },
      startsAt: "2026-09-22T11:55:00.000Z",
      labels: { alertname: "LoadHigh", severity: "info", host: "web-01", instance: "web-01:9100" },
      annotations: {},
      receivers: ["chat"],
      silencedBy: [],
      inhibitedBy: [FIXTURE_FINGERPRINTS.hostDown],
      group: "host-capacity",
      historyRef: null,
    },
    {
      fingerprint: FIXTURE_FINGERPRINTS.unattributed,
      state: "firing",
      severity: "critical",
      name: "OrphanProbeFailing",
      target: null,
      startsAt: "not-a-timestamp",
      labels: { alertname: "OrphanProbeFailing", severity: "critical", instance: "10.0.0.99:9115" },
      annotations: { summary: "A probe with no rendered target is failing" },
      receivers: ["pager"],
      silencedBy: [],
      inhibitedBy: [],
      group: null,
      historyRef: null,
    },
  ];
}

function fixtureRules(): readonly RuleState[] {
  return [
    {
      group: "host-liveness",
      family: "host",
      name: "HostDown",
      state: "firing",
      health: "healthy",
      lastEvaluationAt: "2026-09-22T11:59:30.000Z",
      lastError: null,
      deadman: false,
    },
    {
      group: "host-capacity",
      family: "host",
      name: "DiskAlmostFull",
      state: "firing",
      health: "healthy",
      lastEvaluationAt: "2026-09-22T11:59:30.000Z",
      lastError: null,
      deadman: false,
    },
    {
      group: "host-capacity",
      family: "host",
      name: "LoadHigh",
      state: "firing",
      health: "unknown",
      lastEvaluationAt: null,
      lastError: null,
      deadman: false,
    },
    {
      group: "backups",
      family: "service",
      name: "BackupTooOld",
      state: "firing",
      health: "unhealthy",
      lastEvaluationAt: "2026-09-22T11:58:00.000Z",
      lastError: "query returned no data",
      deadman: false,
    },
    {
      group: "meta",
      family: "deadman",
      name: "Watchdog",
      state: "inactive",
      health: "healthy",
      lastEvaluationAt: "2026-09-22T11:59:45.000Z",
      lastError: null,
      deadman: true,
    },
  ];
}

function fixtureSilences(): readonly ActiveSilence[] {
  return [
    {
      id: FIXTURE_SILENCE_IDS.backup,
      matchers: [
        { name: "alertname", value: "BackupTooOld", isRegex: false, isEqual: true },
        { name: "service", value: "backup", isRegex: false, isEqual: true },
      ],
      createdBy: "operator@example.test",
      comment: "Backup window maintenance",
      startsAt: "2026-09-22T06:00:00.000Z",
      endsAt: "2026-09-22T18:00:00.000Z",
      state: "active",
    },
    {
      id: FIXTURE_SILENCE_IDS.regex,
      matchers: [
        { name: "instance", value: "lab-.*", isRegex: true, isEqual: true },
        { name: "env", value: "prod", isRegex: false, isEqual: false },
        { name: "team", value: "qa|dev", isRegex: true, isEqual: false },
      ],
      createdBy: "lab-bot",
      comment: "",
      startsAt: "2026-09-23T00:00:00.000Z",
      endsAt: "2026-09-24T00:00:00.000Z",
      state: "pending",
    },
  ];
}

/**
 * Build a deep-frozen `AlertsPayload` for one coverage scenario (default `"mixed"`). Degraded
 * scenarios keep the same rows so the partial-render path is exercised; `"empty-healthy"` has zero
 * alerts under two current sources. `"unknown-sel"` returns the mixed payload — pair it with
 * {@link UNKNOWN_SEL_FINGERPRINT}, which matches none of its alerts.
 */
export function makeAlertsPayload(opts: { readonly scenario?: AlertsScenario } = {}): AlertsPayload {
  const scenario = opts.scenario ?? "mixed";
  const amState: DataAvailability["state"] =
    scenario === "am-down" ? "unavailable" : scenario === "stale" ? "stale" : "current";
  const vmState: DataAvailability["state"] = scenario === "vmalert-down" ? "unavailable" : "current";
  const empty = scenario === "empty-healthy";
  const payload: AlertsPayload = {
    generatedAt: FIXTURE_NOW,
    alertmanager: availability("alertmanager-alerts", amState),
    vmalert: availability("vmalert-rules", vmState),
    alerts: empty ? [] : mixedAlerts(),
    rules: fixtureRules(),
    silences: empty ? [] : fixtureSilences(),
  };
  return deepFreeze(payload);
}

/** A fixed Pulse-local acknowledgement (06 §5.5, REQ-ACK-07) for {@link withAck}. */
export const FIXTURE_ACK: AlertAck = Object.freeze({
  by: "Gary Gentry",
  at: FIXTURE_NOW,
  note: "Investigating; disk replacement scheduled.",
});

/**
 * Return a deep-frozen copy of `payload` whose alerts matching `fingerprints` carry `ack`
 * (default {@link FIXTURE_ACK}). Other alerts are copied unchanged (no `ack` key).
 */
export function withAck(
  payload: AlertsPayload,
  fingerprints: readonly string[],
  ack: AlertAck = FIXTURE_ACK,
): AlertsPayload {
  const targets = new Set(fingerprints);
  const copy: AlertsPayload = structuredClone(payload);
  return deepFreeze({
    ...copy,
    alerts: copy.alerts.map((a): ActiveAlert => (targets.has(a.fingerprint) ? { ...a, ack: { ...ack } } : a)),
  });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function hostDownLane(): AlertHistoryLane {
  return {
    id: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    alertname: "HostDown",
    severity: "critical",
    target: { kind: "host", id: "host:web-01" },
    attribution: "matched",
    labels: { alertname: "HostDown", severity: "critical", host: "web-01", service: null, instance: "web-01:9100" },
    provenance: "vmalert",
    intervals: [
      { start: "2026-09-22T02:00:00.000Z", end: "2026-09-22T02:20:00.000Z", state: "firing", provenance: "vmalert" },
      { start: "2026-09-22T11:30:00.000Z", end: "2026-09-22T12:00:00.000Z", state: "firing", provenance: "vmalert" },
    ],
  };
}

function diskFullLane(): AlertHistoryLane {
  return {
    id: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    alertname: "DiskAlmostFull",
    severity: "warning",
    target: { kind: "host", id: "host:web-01" },
    attribution: "matched",
    labels: { alertname: "DiskAlmostFull", severity: "warning", host: "web-01", service: null, instance: "web-01:9100" },
    provenance: "vmalert",
    intervals: [
      { start: "2026-09-22T09:00:00.000Z", end: "2026-09-22T12:00:00.000Z", state: "firing", provenance: "vmalert" },
    ],
  };
}

function unmatchedLane(): AlertHistoryLane {
  return {
    id: "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    alertname: "HostDown",
    severity: "critical",
    target: null,
    attribution: "unmatched",
    labels: { alertname: "HostDown", severity: "critical", host: null, service: null, instance: "10.0.0.42:9100" },
    provenance: "vmalert",
    intervals: [
      { start: "2026-09-22T05:00:00.000Z", end: "2026-09-22T05:45:00.000Z", state: "firing", provenance: "vmalert" },
    ],
  };
}

/**
 * History `"overflow"` is an `ErrorEnvelope` (`HISTORY_LIMIT_EXCEEDED`), never a partial payload.
 * Use it as the stubbed `/api/history/alerts` body to drive the error state.
 */
export function makeHistoryOverflow(): ErrorEnvelope {
  const envelope: ErrorEnvelope = {
    code: "HISTORY_LIMIT_EXCEEDED",
    message: "The history result exceeded a safety limit.",
    details: { limit: "series", max: 1024 },
  };
  return deepFreeze(envelope);
}

/**
 * Build a deep-frozen history body. `"ready"` (default) = matched lanes whose canonical tuples equal
 * the mixed HostDown/DiskAlmostFull alerts; `"unmatched"` = those plus a lane with
 * `attribution: "unmatched"`; `"overflow"` = the `ErrorEnvelope` from {@link makeHistoryOverflow}.
 */
export function makeHistoryPayload(opts: { readonly kind: "overflow" }): ErrorEnvelope;
export function makeHistoryPayload(opts?: { readonly kind?: "ready" | "unmatched" }): IntervalHistoryPayload;
export function makeHistoryPayload(
  opts: { readonly kind?: HistoryKind } = {},
): IntervalHistoryPayload | ErrorEnvelope {
  const kind = opts.kind ?? "ready";
  if (kind === "overflow") return makeHistoryOverflow();
  const lanes: readonly AlertHistoryLane[] =
    kind === "unmatched" ? [hostDownLane(), diskFullLane(), unmatchedLane()] : [hostDownLane(), diskFullLane()];
  const payload: IntervalHistoryPayload = {
    operation: "alert-intervals",
    target: null,
    range: "24h",
    fetchedAt: FIXTURE_NOW,
    effectiveStepSeconds: 60,
    unit: "state",
    stale: false,
    lanes,
  };
  return deepFreeze(payload);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/**
 * Build a deep-frozen `SessionPayload`. Capabilities stay literal `false` (M1); only identity and
 * auth mode vary. Tests exercising a `true` capability must construct that override themselves.
 */
export function makeSession(
  opts: { readonly identity?: SessionPayload["identity"]; readonly authMode?: SessionPayload["authMode"] } = {},
): SessionPayload {
  const session: SessionPayload = {
    identity: opts.identity ?? null,
    authMode: opts.authMode ?? "none",
    capabilities: { silence: false, ack: false, proposeEstateEdit: false },
  };
  return deepFreeze(session);
}
