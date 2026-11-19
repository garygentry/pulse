// Endpoint check-history fixtures: hand-built `EndpointHistoryPayload` bodies and the history error envelopes.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import { RANGE_SECONDS } from "@pulse/web-data/queries";
import type {
  EndpointHistoryPayload,
  EndpointHistoryResult,
  StatusInterval,
  TargetIdentity,
} from "@pulse/web-data/wire";

import { CHECKS_DEFAULT_RANGE } from "../../../src/server/routes/history.js";
import { jsonFixture } from "./common.js";
import {
  ENDPOINT_NAME,
  ENDPOINT_TARGET,
  FETCHED_OFFSET_SECONDS,
  historyErrorFixtures,
  interval,
} from "./history-common.js";
import type { ScenarioContext, ScenarioModule } from "./index.js";

/** What one check-history payload is built from. */
interface ChecksSpec {
  readonly target: TargetIdentity | null;
  readonly effectiveStepSeconds: number | null;
  readonly results: readonly EndpointHistoryResult[];
  readonly incidents: readonly StatusInterval[];
}

/** The placeholder endpoint's payload over the default range, fetched at the fixed instant. */
function checksPayload(ctx: ScenarioContext, spec: ChecksSpec): EndpointHistoryPayload {
  return {
    operation: "endpoint-history",
    endpoint: ENDPOINT_NAME,
    target: spec.target,
    range: CHECKS_DEFAULT_RANGE,
    fetchedAt: ctx.at(FETCHED_OFFSET_SECONDS),
    effectiveStepSeconds: spec.effectiveStepSeconds,
    unit: "milliseconds",
    stale: false,
    provenance: "gatus",
    results: spec.results,
    incidents: spec.incidents,
  } satisfies EndpointHistoryPayload;
}

/** Seconds between two checks in the hand-built runs. */
const CHECK_STEP_SECONDS = 60;
/** How long before the fetch the latest check ran. */
const LAST_CHECK_AGE_SECONDS = 20;
/** Checks in a hand-built run. */
const RUN_LENGTH = 10;
/** Index of the first of two consecutive failed checks in a run. */
const FIRST_FAILURE = 4;

/** Offset of check `i` of a run from the fixed epoch. */
function checkOffset(i: number): number {
  return FETCHED_OFFSET_SECONDS - LAST_CHECK_AGE_SECONDS - (RUN_LENGTH - 1 - i) * CHECK_STEP_SECONDS;
}

/** A run of checks with two consecutive failures. The second failure carries `failedDurationMs`. */
function checkRun(ctx: ScenarioContext, failedDurationMs: number | null): readonly EndpointHistoryResult[] {
  return Array.from({ length: RUN_LENGTH }, (_, i) => {
    const failed = i === FIRST_FAILURE || i === FIRST_FAILURE + 1;
    return {
      timestamp: ctx.at(checkOffset(i)),
      success: !failed,
      durationMs: i === FIRST_FAILURE + 1 ? failedDurationMs : failed ? 5000 : 40 + ((i * 7) % 25),
    } satisfies EndpointHistoryResult;
  });
}

export const historyChecksScenarios: ScenarioModule = {
  group: "history-checks",
  operation: "GET /api/history/checks/:endpoint",
  async build(ctx) {
    // The two failures form one incident, from the first failed check to the next successful one.
    const incident = interval(ctx, checkOffset(FIRST_FAILURE), checkOffset(FIRST_FAILURE + 2), "failed", "gatus");

    // One failed check has no duration.
    const typical = checksPayload(ctx, {
      target: ENDPOINT_TARGET,
      effectiveStepSeconds: CHECK_STEP_SECONDS,
      results: checkRun(ctx, null),
      incidents: [incident],
    }) satisfies EndpointHistoryPayload;

    // No results: no step can be derived.
    const empty = checksPayload(ctx, {
      target: ENDPOINT_TARGET,
      effectiveStepSeconds: null,
      results: [],
      incidents: [],
    }) satisfies EndpointHistoryPayload;

    const allOptional = checksPayload(ctx, {
      target: ENDPOINT_TARGET,
      effectiveStepSeconds: CHECK_STEP_SECONDS,
      results: checkRun(ctx, 5000),
      incidents: [incident],
    }) satisfies EndpointHistoryPayload;

    // Results and incidents both at their caps, spread evenly over the window: every check fails with no
    // duration, and each incident starts at one check and ends before the next.
    const { endpointResults, incidents: incidentCap } = CONTRACT_LIMITS.history;
    const spacing = Math.floor(RANGE_SECONDS[CHECKS_DEFAULT_RANGE] / Math.max(endpointResults, incidentCap));
    const slotOffset = (count: number, i: number): number => FETCHED_OFFSET_SECONDS - (count - i) * spacing;
    const maxSize = checksPayload(ctx, {
      target: null,
      effectiveStepSeconds: null,
      results: Array.from(
        { length: endpointResults },
        (_, i) =>
          ({ timestamp: ctx.at(slotOffset(endpointResults, i)), success: false, durationMs: null }) satisfies EndpointHistoryResult,
      ),
      incidents: Array.from({ length: incidentCap }, (_, i) => {
        const start = slotOffset(incidentCap, i);
        return interval(ctx, start, start + Math.floor(spacing / 2), "failed", "gatus");
      }),
    }) satisfies EndpointHistoryPayload;

    return [
      jsonFixture(this, "typical", "response", 200, typical),
      jsonFixture(this, "empty", "response", 200, empty),
      jsonFixture(this, "all-optional", "response", 200, allOptional),
      jsonFixture(this, "max-size", "response", 200, maxSize),
      ...(await historyErrorFixtures(this)),
    ];
  },
};
