// src/server/dev/timeline.ts — declarative drift fold for mock scenarios.
//
// Pure functions: `applyTimeline` folds a base scenario against every step whose offset lies at or
// before elapsedMs; `freshenGatus` re-bases fixture timestamps onto the wall clock so a frozen
// fixture stays inside the 300s Gatus staleness rule (spec 05 §2.4). No I/O, no clock reads.

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

/** The fixed instant every committed Gatus `results[].timestamp` is authored against. */
export const GATUS_FIXTURE_ANCHOR = "2026-01-01T00:00:00.000Z" as const;
export const GATUS_FIXTURE_ANCHOR_MS = 1_767_225_600_000 as const;

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
