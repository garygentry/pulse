// packages/web-data/src/history/intervals.ts — attributed alert-lane and Gatus-incident
// coalescing (07-history-service.md §§9, 10.2, 10.3). Package internal: `history/service.ts`
// composes these into the interval/endpoint payloads. Server-side only (reached through the
// `/history` barrel, never `/wire`): it uses `node:crypto` for lane identities.
//
// Alert lanes are keyed by the canonical `(alertname,severity,host,service,instance)` tuple —
// never an Alertmanager fingerprint — so distinct target/severity tuples stay distinct and a
// lane id is reproducible from its attribution alone. Positive firing samples open a half-open
// interval; a non-firing sample or a gap greater than two effective steps closes it, and a
// still-open interval resolves deterministically at range end. Attribution resolves each tuple
// against the captured model by exact equality (unique match → matched target; removed/unknown/
// ambiguous → null, unmatched, retaining only the safe tuple). Gatus incidents coalesce
// consecutive failures with the same gap rule. Every §9 lane/interval/label bound rejects the
// whole operation at boundary+1 rather than truncating.

import { createHash } from "node:crypto";

import { canonicalJson } from "../canonical.js";
import {
  HISTORY_MAX_LABEL_VALUE_BYTES,
  HISTORY_MAX_POINTS,
  HISTORY_MAX_SERIES,
} from "../wire/common.js";
import type { HashId, RangeId } from "../wire/common.js";
import type {
  AlertHistoryLane,
  EndpointHistoryPayload,
  EndpointHistoryResult,
  IntervalHistoryPayload,
  StatusInterval,
  TargetIdentity,
} from "../wire/history.js";
import type { GatusCheckResult } from "../sources/gatus.js";
import type { VmRangeSeries } from "../sources/vm.js";
import type { WebEstateModelV2 } from "@pulse/renderer";
import { historyLimitExceeded, sortDedupeByTimestamp } from "./points.js";
import type { TimestampedSample } from "./points.js";
import type { HistoryResult } from "./service.js";

const utf8 = new TextEncoder();
const decoder = new TextDecoder();

/** The fixed minimized alert-attribution tuple; every member is the bounded label or null. */
type AlertTuple = Readonly<Record<"alertname" | "severity" | "host" | "service" | "instance", string | null>>;

/** The five canonical alert-attribution label names, in fixed order. */
const TUPLE_KEYS = ["alertname", "severity", "host", "service", "instance"] as const;

/** UTF-8 byte length of `value`. */
function byteLength(value: string): number {
  return utf8.encode(value).length;
}

/** A half-open time interval in epoch milliseconds. */
interface RawInterval {
  /** Inclusive start. */ readonly startMs: number;
  /** Exclusive end. */ readonly endMs: number;
}

/** Construct one closed status interval from an epoch-ms range. */
function makeInterval(raw: RawInterval, state: StatusInterval["state"], provenance: StatusInterval["provenance"]): StatusInterval {
  return { start: new Date(raw.startMs).toISOString(), end: new Date(raw.endMs).toISOString(), state, provenance };
}

/**
 * Coalesce a boolean-active timeline into half-open intervals (07 §§10.2–10.3). A run of
 * active samples opens one interval; a non-active sample closes it at that sample's time; a
 * gap greater than two effective steps closes it at the last contiguous sample plus one step
 * (never implying continuous activity across the gap); a run still open at the end resolves at
 * `rangeEndMs`. `stepMs <= 0` disables gap closure (an irregular series with no derivable step).
 */
function coalesceIntervals(
  samples: readonly TimestampedSample<boolean>[],
  stepMs: number,
  rangeEndMs: number,
): RawInterval[] {
  const intervals: RawInterval[] = [];
  let openStart: number | null = null;
  let lastActive: number | null = null;
  for (const sample of samples) {
    if (sample.value) {
      if (openStart === null) {
        openStart = sample.timestampMs;
      } else if (stepMs > 0 && lastActive !== null && sample.timestampMs - lastActive > 2 * stepMs) {
        intervals.push({ startMs: openStart, endMs: lastActive + stepMs });
        openStart = sample.timestampMs;
      }
      lastActive = sample.timestampMs;
    } else if (openStart !== null) {
      intervals.push({ startMs: openStart, endMs: sample.timestampMs });
      openStart = null;
      lastActive = null;
    }
  }
  if (openStart !== null && lastActive !== null) {
    const stepFloor = lastActive + (stepMs > 0 ? stepMs : 1);
    intervals.push({ startMs: openStart, endMs: Math.max(rangeEndMs, stepFloor) });
  }
  return intervals;
}

/** Epoch-ms range end from the payload's fetched time, falling back when unparseable. */
function rangeEndMsFrom(fetchedAt: string, fallbackMs: number): number {
  const parsed = Date.parse(fetchedAt);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/** Extract the canonical attribution tuple; an absent or empty label member is null. */
function extractTuple(metric: Readonly<Record<string, string>>): AlertTuple {
  const tuple: Record<"alertname" | "severity" | "host" | "service" | "instance", string | null> = {
    alertname: null,
    severity: null,
    host: null,
    service: null,
    instance: null,
  };
  for (const key of TUPLE_KEYS) {
    const raw = metric[key];
    tuple[key] = raw === undefined || raw === "" ? null : raw;
  }
  return tuple;
}

/** Deterministic `sha256:` identity of the canonical attribution tuple (never a fingerprint). */
function laneId(tuple: AlertTuple): HashId {
  const hex = createHash("sha256").update(canonicalJson(tuple)).digest("hex");
  return `sha256:${hex}`;
}

/** Normalize a raw severity label to the closed display union. */
function normalizeSeverity(severity: string | null): AlertHistoryLane["severity"] {
  return severity === "critical" || severity === "warning" || severity === "info" ? severity : "unknown";
}

/**
 * Attribute a tuple to a rendered target by exact model equality. A unique host/service match
 * yields the drilldown identity; a removed, unknown, or ambiguous (non-unique) identity yields
 * null (the lane is `unmatched`, retaining only the safe tuple).
 */
function attributeTuple(model: WebEstateModelV2, tuple: AlertTuple): TargetIdentity | null {
  const { host, service } = tuple;
  if (host !== null && service !== null) {
    const matches = model.services.filter((s) => s.host === host && s.name === service);
    return matches.length === 1 ? { kind: "service", id: `svc:${host}/${service}` } : null;
  }
  if (host !== null) {
    const matches = model.hosts.filter((h) => h.name === host);
    return matches.length === 1 ? { kind: "host", id: `host:${host}` } : null;
  }
  return null;
}

/** True when every present tuple member is within the §9 label-value byte bound. */
function tupleWithinBounds(tuple: AlertTuple): boolean {
  for (const key of TUPLE_KEYS) {
    const value = tuple[key];
    if (value !== null && byteLength(value) > HISTORY_MAX_LABEL_VALUE_BYTES) return false;
  }
  return true;
}

/**
 * Build attributed firing-alert lanes from the `alerts.firing` VM range result (07 §10.2).
 * Series are grouped by the canonical attribution tuple (including null missing members),
 * each group's samples are sorted/deduped, firing runs are coalesced with gap closure, and
 * empty lanes (no firing history) are dropped. Lanes are attributed against the captured model
 * and emitted in ascending lane-id order. The whole operation rejects at boundary+1 for the
 * ≤1,024-lane, ≤600-interval, and label-byte bounds — never truncated.
 *
 * @param input - The validated `alerts.firing` matrix series (`sum by (alertname,severity,host,service,instance)`).
 * @param model - The captured rendered estate model for attribution.
 * @param range - The requested closed range.
 * @param fetchedAt - Upstream completion time (UTC ISO-8601); also the range-end resolution instant.
 * @param effectiveStepSeconds - The query's effective step, in seconds, driving gap closure.
 * @returns The estate-wide interval payload (target null), or `HISTORY_LIMIT_EXCEEDED`.
 */
export function buildAlertIntervals(
  input: readonly VmRangeSeries[],
  model: WebEstateModelV2,
  range: RangeId,
  fetchedAt: string,
  effectiveStepSeconds: number,
): HistoryResult<IntervalHistoryPayload> {
  const stepMs = Math.max(1, Math.round(effectiveStepSeconds * 1000));
  const rangeEndMs = rangeEndMsFrom(fetchedAt, 0);

  const groups = new Map<string, { readonly tuple: AlertTuple; readonly samples: TimestampedSample<boolean>[] }>();
  for (const series of input) {
    const tuple = extractTuple(series.metric);
    if (!tupleWithinBounds(tuple)) return historyLimitExceeded();
    const groupKey = decoder.decode(canonicalJson(tuple));
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = { tuple, samples: [] };
      groups.set(groupKey, group);
    }
    for (const sample of series.samples) {
      group.samples.push({ timestampMs: sample.timestampMs, value: sample.value !== null && sample.value > 0 });
    }
  }

  const lanes: AlertHistoryLane[] = [];
  for (const group of groups.values()) {
    const ordered = sortDedupeByTimestamp(group.samples);
    const intervals = coalesceIntervals(ordered, stepMs, rangeEndMs);
    if (intervals.length === 0) continue; // a tuple with no firing history is not a lane
    if (intervals.length > HISTORY_MAX_POINTS) return historyLimitExceeded();
    const target = attributeTuple(model, group.tuple);
    lanes.push({
      id: laneId(group.tuple),
      alertname: group.tuple.alertname ?? "",
      severity: normalizeSeverity(group.tuple.severity),
      target,
      attribution: target !== null ? "matched" : "unmatched",
      labels: group.tuple,
      provenance: "vmalert",
      intervals: intervals.map((iv) => makeInterval(iv, "firing", "vmalert")),
    });
  }
  if (lanes.length > HISTORY_MAX_SERIES) return historyLimitExceeded();
  lanes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const payload: IntervalHistoryPayload = {
    operation: "alert-intervals",
    target: null,
    range,
    fetchedAt,
    effectiveStepSeconds,
    unit: "state",
    stale: false,
    lanes,
  };
  return { ok: true, data: payload, delivery: "miss" };
}

/** Median consecutive gap (ms) across ascending timestamps, or 0 when underivable. */
function medianGapMs(timestamps: readonly number[]): number {
  if (timestamps.length < 2) return 0;
  const gaps: number[] = [];
  for (let i = 1; i < timestamps.length; i += 1) gaps.push(timestamps[i]! - timestamps[i - 1]!);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 === 1 ? gaps[mid]! : Math.round((gaps[mid - 1]! + gaps[mid]!) / 2);
}

/**
 * Build the exact-endpoint Gatus history payload (07 §10.3). Results are sorted/deduped by
 * timestamp (last-sample rule), `durationMs` stays null when unavailable, and consecutive
 * failures coalesce into `failed`/`gatus` incidents that close on a success, a gap greater than
 * two derived check steps, or the range end. Both the retained results and the incidents are
 * bounded to 600 and reject the whole operation at boundary+1 rather than truncating.
 *
 * @param input - The validated recent endpoint results in upstream order.
 * @param endpoint - The exact validated Gatus endpoint key.
 * @param target - The renderer target attribution, or null when unavailable.
 * @param range - The requested closed range.
 * @param fetchedAt - Upstream completion time (UTC ISO-8601); also the range-end resolution instant.
 * @returns The complete bounded endpoint payload, or `HISTORY_LIMIT_EXCEEDED`.
 */
export function buildEndpointHistory(
  input: readonly GatusCheckResult[],
  endpoint: string,
  target: TargetIdentity | null,
  range: RangeId,
  fetchedAt: string,
): HistoryResult<EndpointHistoryPayload> {
  const ordered = sortDedupeByTimestamp(
    input.map((result) => ({ timestampMs: Date.parse(result.timestamp), value: result })),
  );
  if (ordered.length > HISTORY_MAX_POINTS) return historyLimitExceeded();

  const results: EndpointHistoryResult[] = ordered.map((entry) => ({
    timestamp: entry.value.timestamp,
    success: entry.value.success,
    durationMs: entry.value.durationMs,
  }));

  const stepMs = medianGapMs(ordered.map((entry) => entry.timestampMs));
  const rangeEndMs = rangeEndMsFrom(fetchedAt, 0);
  const active: TimestampedSample<boolean>[] = ordered.map((entry) => ({
    timestampMs: entry.timestampMs,
    value: !entry.value.success,
  }));
  const rawIncidents = coalesceIntervals(active, stepMs, rangeEndMs);
  if (rawIncidents.length > HISTORY_MAX_POINTS) return historyLimitExceeded();
  const incidents = rawIncidents.map((iv) => makeInterval(iv, "failed", "gatus"));

  const payload: EndpointHistoryPayload = {
    operation: "endpoint-history",
    endpoint,
    target,
    range,
    fetchedAt,
    effectiveStepSeconds: stepMs > 0 ? Math.round(stepMs / 1000) : null,
    unit: "milliseconds",
    stale: false,
    provenance: "gatus",
    results,
    incidents,
  };
  return { ok: true, data: payload, delivery: "miss" };
}
