// Shared builders for the four history fixture groups: placeholder targets, point and interval runs, the
// curated-query payload, the at-cap series and the error fixtures every history route can answer with.

import { CONTRACT_LIMITS } from "@pulse/web-data/contract";
import { canonicalJson } from "@pulse/web-data/cycle";
import {
  QUERY_CATALOG,
  RANGE_SECONDS,
  acceptedRangesForQuery,
  effectiveStepSeconds,
  queryIdsForTargetKind,
} from "@pulse/web-data/queries";
import type { HistoryPayload, HistorySeries, QueryId, RangeId, StatusInterval, TargetIdentity } from "@pulse/web-data/wire";

import { HISTORY_STATUS } from "../../../src/server/routes/history.js";
import { apiError, errorResponse } from "../../../src/server/routes/respond.js";
import { ContractToolError } from "../errors.js";
import { bundleErrorBody, responseBody } from "../stub-context.js";
import type { FixtureGroup, ScenarioFixture } from "../types.js";
import { PLACEHOLDER, errorSlug, jsonFixture, utf8OfBytes } from "./common.js";
import type { ScenarioContext } from "./index.js";

/** Offset of `fetchedAt` from the fixed epoch. Every history window ends here. */
export const FETCHED_OFFSET_SECONDS = 0;

/** Placeholder service name on the first placeholder host. */
const SERVICE_NAME = "web";

/** The placeholder host as a drilldown target. */
export const HOST_TARGET = { kind: "host", id: `host:${PLACEHOLDER.hostName(1)}` } satisfies TargetIdentity;
/** A placeholder service on that host as a drilldown target. */
export const SERVICE_TARGET = {
  kind: "service",
  id: `svc:${PLACEHOLDER.hostName(1)}/${SERVICE_NAME}`,
} satisfies TargetIdentity;
/** Endpoint name of that service's check, in `<host>/<service>` form. */
export const ENDPOINT_NAME = `${PLACEHOLDER.hostName(1)}/${SERVICE_NAME}`;
/** The same endpoint as a target. */
export const ENDPOINT_TARGET = { kind: "endpoint", id: ENDPOINT_NAME } satisfies TargetIdentity;

/** One `[timestampMs, value]` sample. */
export type HistoryPoint = HistorySeries["points"][number];

/** Evenly spaced points, oldest first, the last one at `endOffsetSeconds`. */
export function pointRun(
  ctx: ScenarioContext,
  endOffsetSeconds: number,
  spacingSeconds: number,
  values: readonly (number | null)[],
): readonly HistoryPoint[] {
  const last = values.length - 1;
  return values.map((value, i): HistoryPoint => [ctx.atMs(endOffsetSeconds - (last - i) * spacingSeconds), value]);
}

/** One half-open status interval between two offsets from the fixed epoch. */
export function interval(
  ctx: ScenarioContext,
  startOffsetSeconds: number,
  endOffsetSeconds: number,
  state: StatusInterval["state"],
  provenance: StatusInterval["provenance"],
): StatusInterval {
  return { start: ctx.at(startOffsetSeconds), end: ctx.at(endOffsetSeconds), state, provenance } satisfies StatusInterval;
}

/** The sampling step the server uses for `queryId` over `range`. */
export function stepSecondsFor(queryId: QueryId, range: RangeId): number {
  return effectiveStepSeconds(RANGE_SECONDS[range], QUERY_CATALOG[queryId].preferredStepSeconds);
}

const DECODER = new TextDecoder();

/** Canonical JSON text of a label bag: the key series are ordered by. */
function labelOrderKey(labels: HistorySeries["labels"]): string {
  return DECODER.decode(canonicalJson(labels));
}

/** What one curated-query payload is built from. Step and unit come from the query catalog. */
export interface HistoryPayloadSpec {
  readonly queryId: QueryId;
  readonly target: TargetIdentity | null;
  readonly range: RangeId;
  readonly series: readonly HistorySeries[];
}

/**
 * A curated-query payload fetched at the fixed instant, with the catalog unit, the server's step for the
 * range, and the series in canonical label order.
 *
 * @throws {ContractToolError} SCENARIO_INVALID when the query does not apply to the target kind or the
 *   range exceeds the query's maximum
 */
export function historyPayload(ctx: ScenarioContext, spec: HistoryPayloadSpec): HistoryPayload {
  const definition = QUERY_CATALOG[spec.queryId];
  const subject = `history ${spec.queryId}`;
  if (!queryIdsForTargetKind(spec.target?.kind ?? "estate").includes(spec.queryId)) {
    throw new ContractToolError("SCENARIO_INVALID", subject, "query does not apply to the target kind");
  }
  if (!acceptedRangesForQuery(definition).includes(spec.range)) {
    throw new ContractToolError("SCENARIO_INVALID", subject, `range ${spec.range} exceeds the query maximum`);
  }
  const series = spec.series
    .map((entry) => ({ entry, key: labelOrderKey(entry.labels) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ entry }) => entry);
  return {
    queryId: spec.queryId,
    target: spec.target,
    range: spec.range,
    fetchedAt: ctx.at(FETCHED_OFFSET_SECONDS),
    effectiveStepSeconds: stepSecondsFor(spec.queryId, spec.range),
    unit: definition.unit,
    stale: false,
    series,
  } satisfies HistoryPayload;
}

/** Series at the series cap: one point each, no labels. */
export function seriesAtCap(ctx: ScenarioContext): readonly HistorySeries[] {
  const point: HistoryPoint = [ctx.atMs(FETCHED_OFFSET_SECONDS), 1];
  return Array.from({ length: CONTRACT_LIMITS.history.series }, () => ({ labels: {}, points: [point] }) satisfies HistorySeries);
}

/**
 * Labels at the label cap: every key at the key byte cap and every value at the value byte cap. Keys differ
 * by a zero-padded index prefix and all end in a multi-byte code point.
 */
function labelsAtCap(): HistorySeries["labels"] {
  const { labels, labelKeyBytes, labelValueBytes } = CONTRACT_LIMITS.history;
  const width = String(labels - 1).length;
  const keyTail = utf8OfBytes(labelKeyBytes - width);
  const value = utf8OfBytes(labelValueBytes);
  return Object.fromEntries(
    Array.from({ length: labels }, (_, i): [string, string] => [`${String(i).padStart(width, "0")}${keyTail}`, value]),
  );
}

/**
 * One series with points at the points-per-series cap and labels at every label cap. The points are spread
 * evenly so that all of them lie inside the `range` window.
 */
export function pointsAtCap(ctx: ScenarioContext, range: RangeId): HistorySeries {
  const count = CONTRACT_LIMITS.history.pointsPerSeries;
  const spacingSeconds = Math.floor(RANGE_SECONDS[range] / count);
  const values = Array.from({ length: count }, (_, i) => i % 100);
  return {
    labels: labelsAtCap(),
    points: pointRun(ctx, FETCHED_OFFSET_SECONDS, spacingSeconds, values),
  } satisfies HistorySeries;
}

/** Every failure code a history route answers with, in status-table order. */
const HISTORY_ERROR_CODES = Object.keys(HISTORY_STATUS) as (keyof typeof HISTORY_STATUS)[];

/**
 * The error fixtures shared by every history group: one `error-<slug>` per history failure code, built with
 * the route's own envelope composition, and the bundle-error body.
 */
export async function historyErrorFixtures(target: {
  readonly group: FixtureGroup;
  readonly operation: string;
}): Promise<ScenarioFixture[]> {
  const fixtures: ScenarioFixture[] = [];
  for (const code of HISTORY_ERROR_CODES) {
    const status = HISTORY_STATUS[code];
    const body = await responseBody(errorResponse(apiError(code), status), status);
    fixtures.push(jsonFixture(target, `error-${errorSlug(code)}`, "error", status, body));
  }
  fixtures.push(jsonFixture(target, "bundle-error", "error", 503, await bundleErrorBody("missing")));
  return fixtures;
}
