// Alert-interval history fixtures: hand-built `IntervalHistoryPayload` bodies and the history error envelopes.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import { RANGE_SECONDS } from "@pulse/web-data/queries";
import type {
  AlertHistoryLane,
  IntervalHistoryPayload,
  RangeId,
  StatusInterval,
  TargetIdentity,
} from "@pulse/web-data/wire";

import { PLACEHOLDER, jsonFixture, utf8OfBytes } from "./common.js";
import {
  FETCHED_OFFSET_SECONDS,
  SERVICE_TARGET,
  historyErrorFixtures,
  interval,
  stepSecondsFor,
} from "./history-common.js";
import type { ScenarioContext, ScenarioModule } from "./index.js";

type LaneLabels = AlertHistoryLane["labels"];

/** The display severity of a raw severity label: anything outside the closed set is "unknown". */
function displaySeverity(severity: string | null): AlertHistoryLane["severity"] {
  return severity === "critical" || severity === "warning" || severity === "info" ? severity : "unknown";
}

/** One lane. Its id is the hash of its labels, and it is "matched" exactly when it has a target. */
async function lane(
  ctx: ScenarioContext,
  labels: LaneLabels,
  target: TargetIdentity | null,
  intervals: readonly StatusInterval[],
): Promise<AlertHistoryLane> {
  return {
    id: await ctx.hash(labels),
    alertname: labels.alertname ?? "",
    severity: displaySeverity(labels.severity),
    target,
    attribution: target !== null ? "matched" : "unmatched",
    labels,
    provenance: "vmalert",
    intervals,
  } satisfies AlertHistoryLane;
}

/** A firing interval between two offsets from the fixed epoch. */
function firing(ctx: ScenarioContext, startOffsetSeconds: number, endOffsetSeconds: number): StatusInterval {
  return interval(ctx, startOffsetSeconds, endOffsetSeconds, "firing", "vmalert");
}

/** The payload for `range` fetched at the fixed instant, with the lanes in ascending id order. */
function alertIntervals(
  ctx: ScenarioContext,
  range: RangeId,
  target: TargetIdentity | null,
  lanes: readonly AlertHistoryLane[],
): IntervalHistoryPayload {
  return {
    operation: "alert-intervals",
    target,
    range,
    fetchedAt: ctx.at(FETCHED_OFFSET_SECONDS),
    effectiveStepSeconds: stepSecondsFor("alerts.firing", range),
    unit: "state",
    stale: false,
    lanes: [...lanes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  } satisfies IntervalHistoryPayload;
}

export const historyAlertsScenarios: ScenarioModule = {
  group: "history-alerts",
  operation: "GET /api/history/alerts",
  async build(ctx) {
    const now = FETCHED_OFFSET_SECONDS;
    const serviceLabels = {
      alertname: "ServiceDeepHealthFailing",
      severity: "warning",
      host: PLACEHOLDER.hostName(1),
      service: "web",
      instance: `${PLACEHOLDER.ipv4(1)}:9100`,
    } satisfies LaneLabels;

    // A host lane still firing at fetch time, a resolved service lane and a lane with no attribution.
    const typical = alertIntervals(ctx, "6h", null, [
      await lane(
        ctx,
        {
          alertname: "HostDown",
          severity: "critical",
          host: PLACEHOLDER.hostName(2),
          service: null,
          instance: `${PLACEHOLDER.ipv4(2)}:9100`,
        },
        { kind: "host", id: `host:${PLACEHOLDER.hostName(2)}` },
        [firing(ctx, now - 7200, now - 6600), firing(ctx, now - 1800, now)],
      ),
      await lane(ctx, { ...serviceLabels, instance: null }, SERVICE_TARGET, [firing(ctx, now - 3600, now - 3000)]),
      await lane(
        ctx,
        { alertname: "WatchdogStale", severity: null, host: null, service: null, instance: null },
        null,
        [firing(ctx, now - 600, now - 300)],
      ),
    ]) satisfies IntervalHistoryPayload;

    const empty = alertIntervals(ctx, "6h", null, []) satisfies IntervalHistoryPayload;

    // Target filter set, and one lane whose target and every label value are set.
    const allOptional = alertIntervals(ctx, "6h", SERVICE_TARGET, [
      await lane(ctx, serviceLabels, SERVICE_TARGET, [firing(ctx, now - 3600, now - 3000), firing(ctx, now - 900, now)]),
    ]) satisfies IntervalHistoryPayload;

    // Lanes at the lanes cap: distinct shortest alert names, no other labels, one interval each.
    const laneStep = stepSecondsFor("alerts.firing", "6h");
    const capLanes: AlertHistoryLane[] = [];
    for (let i = 0; i < CONTRACT_LIMITS.history.lanes; i += 1) {
      capLanes.push(
        await lane(ctx, { alertname: `A${i}`, severity: null, host: null, service: null, instance: null }, null, [
          firing(ctx, now - laneStep, now),
        ]),
      );
    }
    const maxSizeLanes = alertIntervals(ctx, "6h", null, capLanes) satisfies IntervalHistoryPayload;

    // One lane with intervals at the per-lane cap, spread evenly over the window, and every label value at
    // the value byte cap.
    const intervalCount = CONTRACT_LIMITS.history.intervalsPerLane;
    const period = Math.floor(RANGE_SECONDS["7d"] / intervalCount);
    const capValue = utf8OfBytes(CONTRACT_LIMITS.history.labelValueBytes);
    const capIntervals = Array.from({ length: intervalCount }, (_, i) => {
      const start = now - (intervalCount - i) * period;
      return firing(ctx, start, start + Math.floor(period / 2));
    });
    const maxSizeIntervals = alertIntervals(ctx, "7d", null, [
      await lane(
        ctx,
        { alertname: capValue, severity: capValue, host: capValue, service: capValue, instance: capValue },
        null,
        capIntervals,
      ),
    ]) satisfies IntervalHistoryPayload;

    return [
      jsonFixture(this, "typical", "response", 200, typical),
      jsonFixture(this, "empty", "response", 200, empty),
      jsonFixture(this, "all-optional", "response", 200, allOptional),
      jsonFixture(this, "max-size-lanes", "response", 200, maxSizeLanes),
      jsonFixture(this, "max-size-intervals", "response", 200, maxSizeIntervals),
      ...(await historyErrorFixtures(this)),
    ];
  },
};
