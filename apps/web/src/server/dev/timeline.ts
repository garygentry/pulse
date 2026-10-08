// src/server/dev/timeline.ts — declarative drift fold for mock scenarios.
//
// Pure functions: `applyTimeline` folds a base scenario against every step whose offset lies at or
// before elapsedMs; `freshenGatus` re-bases fixture timestamps onto the wall clock so a frozen
// fixture stays inside the 300s Gatus staleness rule (spec 05 §2.4); `rebaseAlertmanager`,
// `rebaseVmalert`, and `rebaseVm` re-base the other fixture timestamps onto the scenario start so
// alert ages are realistic (GitHub #3). No I/O, no clock reads.

import type {
  AmAlertsResponse,
  AmGettableAlert,
  GatusStatusesResponse,
  VmQueryResponse,
} from "../sources/index.js";

/** The four fixed engine sources the dev loop routes (REQ-MOCK-02, 00 §3): VictoriaMetrics,
 *  Alertmanager, Gatus, and vmalert. Home per spec 00 §3.1 is `mock-engine.ts` (item 014);
 *  declared here so item 013 can ship without that file, and item 014 re-exports from this module.
 *  Value union is a stable leaf. Order matches the fixed `--engine` tuple. */
export type MockSource = "vm" | "alertmanager" | "gatus" | "vmalert";

/** One declarative change (REQ-MOCK-04). Vocabulary is closed in this member (spec 00 §3.2). */
export type TimelineOp =
  /** Set the VM liveness `up` sample for `host` to `"0"` (host flap, down). */
  | {
      /** Operation discriminator. */ op: "host-down";
      /** Target host name. */ host: string;
    }
  /** Restore `up` to `"1"` for `host`. */
  | {
      /** Operation discriminator. */ op: "host-up";
      /** Target host name. */ host: string;
    }
  /** Append a raw Alertmanager alert (the wire shape). */
  | {
      /** Operation discriminator. */ op: "alert-fire";
      /** Raw Alertmanager alert to append. */ alert: AmGettableAlert;
    }
  /** Remove every alert whose `labels.alertname` and `labels.instance` (or `labels.host`) match. */
  | {
      /** Operation discriminator. */ op: "alert-resolve";
      /** Alert name to resolve. */ alertname: string;
      /** Instance (or host) label to match. */ instance: string;
    }
  /** Set the latest Gatus result of `endpoint` (by `name`) to `success: false`. */
  | {
      /** Operation discriminator. */ op: "check-fail";
      /** Gatus endpoint name. */ endpoint: string;
    }
  /** Set it back to `success: true`. */
  | {
      /** Operation discriminator. */ op: "check-pass";
      /** Gatus endpoint name. */ endpoint: string;
    }
  /** Mark `source` unreachable: its fetch rejects until `outage-end`. */
  | {
      /** Operation discriminator. */ op: "outage-begin";
      /** Source whose fetch begins failing. */ source: MockSource;
    }
  | {
      /** Operation discriminator. */ op: "outage-end";
      /** Source whose fetch recovers. */ source: MockSource;
    };

/** One timed step. `atMs` is the offset from scenario start; steps must be ascending by `atMs`. */
export interface TimelineStep {
  /** Offset from scenario start in milliseconds. */ atMs: number;
  /** Declarative change applied at this offset. */ step: TimelineOp;
}

/** The `timeline.json` document. */
export interface Timeline {
  /** Ordered timeline steps ascending by `atMs`. */ steps: TimelineStep[];
}

/** One rule inside a vmalert `/api/v1/rules` group (00 §4.1). A structural fixture shape — this
 *  document ships no production parser; later work (item 015) pins the real client contract.
 *  Extra additive upstream fields are tolerated because the fixture is loaded as JSON. */
export interface VmalertRule {
  /** `"firing" | "inactive" | "pending"` — closed here to a string for fixture tolerance. */
  state: string;
  /** Alerting/recording rule name. */
  name: string;
  /** Server-authored PromQL (sanitized; never a real estate secret). */
  query?: string;
  /** `"ok" | "err" | "nodata"`. */
  health: string;
  /** Bounded last-evaluation error text; empty string when healthy. */
  lastError?: string;
  /** `"alerting" | "recording"`. */
  type?: string;
  /** ISO-8601 last evaluation instant. */
  lastEvaluation?: string;
  /** Rule labels (sanitized). */
  labels?: Record<string, string>;
  /** Rule annotations (sanitized). */
  annotations?: Record<string, string>;
  /** Active alert instances for a firing alerting rule. */
  alerts?: unknown[];
}

/** One vmalert rule group inside `data.groups` (00 §4.1). */
export interface VmalertRuleGroup {
  /** Group name. */
  name: string;
  /** Source rule file the group was loaded from (sanitized path). */
  file?: string;
  /** Group evaluation interval, seconds. */
  interval?: number;
  /** ISO-8601 last group evaluation instant. */
  lastEvaluation?: string;
  /** The group's rules. */
  rules: VmalertRule[];
}

/** The vmalert `/api/v1/rules` envelope (00 §4.1). Sanitized fixture input only — no production
 *  acquisition or parser is added by this document. */
export interface VmalertRulesResponse {
  /** `"success"` on the happy path. */
  status: string;
  /** The rule catalog. */
  data: {
    /** Rule groups in the catalog. */ groups: VmalertRuleGroup[];
  };
}

/** The four literal fixture bodies of a scenario directory (00 §3–§4). */
export interface ScenarioBase {
  /** VictoriaMetrics instant-query fixture body. */ vm: VmQueryResponse;
  /** Alertmanager alerts fixture body. */ alertmanager: AmAlertsResponse;
  /** Gatus statuses fixture body. */ gatus: GatusStatusesResponse;
  /** vmalert rules fixture body. */ vmalert: VmalertRulesResponse;
}

/** The scenario after folding every step with `atMs <= elapsedMs`. */
export interface ScenarioState {
  /** Current VictoriaMetrics instant-query body. */ vm: VmQueryResponse;
  /** Current Alertmanager alerts body. */ alertmanager: AmAlertsResponse;
  /** Current Gatus statuses body. */ gatus: GatusStatusesResponse;
  /** Current vmalert rules body. */ vmalert: VmalertRulesResponse;
  /** Sources currently in an outage window. */ outages: ReadonlySet<MockSource>;
  /** Number of timeline steps applied to reach this state. */ appliedSteps: number;
}

/**
 * The fixture reference instant: every committed scenario timestamp (Gatus results, Alertmanager
 * `startsAt`/`endsAt`/`updatedAt`, vmalert `lastEvaluation`/`activeAt`, VM sample times, and the
 * `timeline.json` alerts, whose `startsAt` is this instant plus their `atMs`) is authored as if the
 * scenario started at exactly this instant. The mock engine preserves each timestamp's offset from
 * it, so author new fixtures against it too.
 */
export const FIXTURE_ANCHOR = "2026-01-01T00:00:00.000Z" as const;
export const FIXTURE_ANCHOR_MS = 1_767_225_600_000 as const;
/** Historical names for {@link FIXTURE_ANCHOR}; the Gatus re-base was the first user. */
export const GATUS_FIXTURE_ANCHOR = FIXTURE_ANCHOR;
export const GATUS_FIXTURE_ANCHOR_MS = FIXTURE_ANCHOR_MS;

interface Accumulator {
  vm: VmQueryResponse;
  alertmanager: AmAlertsResponse;
  gatus: GatusStatusesResponse;
  vmalert: VmalertRulesResponse;
  outages: Set<MockSource>;
}

/**
 * Pure fold: `base` plus every step with `atMs <= elapsedMs`, in array order. Never mutates
 * inputs (structured-clones `base` first). Deterministic: equal inputs → deep-equal output
 * (REQ-MOCK-04/05, SC-12).
 */
export function applyTimeline(
  base: ScenarioBase,
  timeline: Timeline,
  elapsedMs: number,
): ScenarioState {
  const acc: Accumulator = {
    vm: structuredClone(base.vm),
    alertmanager: structuredClone(base.alertmanager),
    gatus: structuredClone(base.gatus),
    vmalert: structuredClone(base.vmalert),
    outages: new Set<MockSource>(),
  };
  let appliedSteps = 0;
  for (const { atMs, step } of timeline.steps) {
    if (atMs > elapsedMs) continue;
    applyOp(acc, step);
    appliedSteps += 1;
  }
  return {
    vm: acc.vm,
    alertmanager: acc.alertmanager,
    gatus: acc.gatus,
    vmalert: acc.vmalert,
    outages: acc.outages,
    appliedSteps,
  };
}

function applyOp(acc: Accumulator, op: TimelineOp): void {
  switch (op.op) {
    case "host-down":
      setHostValue(acc.vm, op.host, "0");
      return;
    case "host-up":
      setHostValue(acc.vm, op.host, "1");
      return;
    case "alert-fire":
      acc.alertmanager.push(structuredClone(op.alert));
      return;
    case "alert-resolve": {
      const keep: AmGettableAlert[] = [];
      for (const a of acc.alertmanager) {
        const key = a.labels.instance ?? a.labels.host;
        if (a.labels.alertname === op.alertname && key === op.instance) continue;
        keep.push(a);
      }
      acc.alertmanager.length = 0;
      acc.alertmanager.push(...keep);
      return;
    }
    case "check-fail":
      setCheckSuccess(acc.gatus, op.endpoint, false);
      return;
    case "check-pass":
      setCheckSuccess(acc.gatus, op.endpoint, true);
      return;
    case "outage-begin":
      acc.outages.add(op.source);
      return;
    case "outage-end":
      acc.outages.delete(op.source);
      return;
  }
}

function setHostValue(vm: VmQueryResponse, host: string, value: "0" | "1"): void {
  const samples = vm.data?.result;
  if (!samples) return;
  for (const s of samples) {
    if (s.metric.host !== host) continue;
    s.value = [s.value[0], value];
  }
}

function setCheckSuccess(gatus: GatusStatusesResponse, name: string, success: boolean): void {
  const ep = gatus.find((e) => e.name === name);
  if (!ep) return;
  if (!ep.results || ep.results.length === 0) {
    ep.results = [
      { success, timestamp: GATUS_FIXTURE_ANCHOR, duration: 0, status: 0 },
    ];
    return;
  }
  const last = ep.results[ep.results.length - 1]!;
  last.success = success;
}

/**
 * Re-base every Gatus `results[].timestamp` from `GATUS_FIXTURE_ANCHOR_MS` onto `wallNowMs`,
 * preserving each result's authored age relative to the anchor. Frozen fixtures then stay under
 * the 300s Gatus staleness rule regardless of wall clock (spec 05 §2.4, REQ-MOCK-05 refinement).
 * Pure with respect to `wallNowMs`; never mutates its input.
 */
export function freshenGatus(
  body: GatusStatusesResponse,
  wallNowMs: number,
): GatusStatusesResponse {
  return body.map((ep) => {
    if (!ep.results) return { ...ep };
    const results = ep.results.map((r) => {
      const authored = Date.parse(r.timestamp);
      if (Number.isNaN(authored)) return { ...r };
      const ageMs = GATUS_FIXTURE_ANCHOR_MS - authored;
      return { ...r, timestamp: new Date(wallNowMs - ageMs).toISOString() };
    });
    return { ...ep, results };
  });
}

// ── Scenario-clock re-base (GitHub #3) ──────────────────────────────────────────────────────────
//
// `rebaseAlertmanager`/`rebaseVmalert`/`rebaseVm` shift every authored timestamp by
// `scenarioStartMs - FIXTURE_ANCHOR_MS`, so each keeps its authored offset from the anchor but
// relative to the scenario start (`--clock`, or process start). An alert authored 19 minutes before
// the anchor is 19 minutes old when the scenario starts and ages normally from there; an `endsAt` in
// the future stays in the future by the same margin, so firing/resolved semantics at scenario start
// match the fixture. Timeline-fired alerts are covered too: they are authored at anchor + `atMs`, so
// they read as just-fired when they appear.
//
// Unlike `freshenGatus` (anchored to the current wall clock, so check results never go stale) these
// depend only on the scenario start, so a pinned `--clock` serves byte-identical bodies on every run.
// At `scenarioStartMs === FIXTURE_ANCHOR_MS` the bodies come back unchanged. Unset sentinels (Go's
// zero time `0001-01-01T00:00:00Z`, or anything at or before the epoch) and unparseable strings are
// left as-is. All pure; none mutates its input.

/** Shift one ISO-8601 instant by `deltaMs`; unset sentinels and unparseable strings pass through. */
export function shiftInstant(iso: string, deltaMs: number): string {
  if (deltaMs === 0) return iso;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms) || ms <= 0) return iso;
  return new Date(ms + deltaMs).toISOString();
}

function shiftField<T extends object>(obj: T, key: string, deltaMs: number): T {
  const value = (obj as Record<string, unknown>)[key];
  if (typeof value !== "string") return obj;
  return { ...obj, [key]: shiftInstant(value, deltaMs) };
}

const AM_TIME_FIELDS = ["startsAt", "endsAt", "updatedAt"] as const;

/** Re-base Alertmanager alert `startsAt`/`endsAt`/`updatedAt` onto the scenario start. */
export function rebaseAlertmanager(body: AmAlertsResponse, scenarioStartMs: number): AmAlertsResponse {
  const deltaMs = scenarioStartMs - FIXTURE_ANCHOR_MS;
  return body.map((alert) => {
    let next = { ...alert };
    for (const key of AM_TIME_FIELDS) next = shiftField(next, key, deltaMs);
    return next;
  });
}

/** Re-base vmalert group/rule `lastEvaluation` and rule `alerts[].activeAt` onto the scenario start. */
export function rebaseVmalert(body: VmalertRulesResponse, scenarioStartMs: number): VmalertRulesResponse {
  const deltaMs = scenarioStartMs - FIXTURE_ANCHOR_MS;
  const groups = body.data.groups.map((group) => ({
    ...shiftField(group, "lastEvaluation", deltaMs),
    rules: group.rules.map((rule) => {
      const next = shiftField({ ...rule }, "lastEvaluation", deltaMs);
      if (!Array.isArray(rule.alerts)) return next;
      return {
        ...next,
        alerts: rule.alerts.map((a) =>
          typeof a === "object" && a !== null ? shiftField({ ...a }, "activeAt", deltaMs) : a,
        ),
      };
    }),
  }));
  return { ...body, data: { ...body.data, groups } };
}

/** Re-base VM instant-query sample times (`value[0]`, epoch seconds) onto the scenario start. */
export function rebaseVm(body: VmQueryResponse, scenarioStartMs: number): VmQueryResponse {
  const deltaMs = scenarioStartMs - FIXTURE_ANCHOR_MS;
  const data = body.data;
  if (data === undefined || deltaMs === 0) return body;
  return {
    ...body,
    data: {
      ...data,
      result: data.result.map((s) => {
        const at = s.value[0];
        if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return { ...s };
        return { ...s, value: [at + deltaMs / 1000, s.value[1]] };
      }),
    },
  };
}
