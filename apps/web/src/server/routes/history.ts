// src/server/routes/history.ts — the four bounded-history routes (05 §§6, 8; 07-history-service.md).
//
//   GET /api/history/estate/:queryId              → estate-wide curated VM history (target null)
//   GET /api/history/target/:drilldownId/:queryId → target-scoped curated VM history
//   GET /api/history/alerts                        → vmalert-derived firing intervals (target null)
//   GET /api/history/checks/:endpoint              → exact-endpoint Gatus history
//
// Each handler parses ONLY the optional single `range` key (start/end/step/PromQL and every other
// key are rejected), resolves the exact captured target/endpoint identity, forwards the request's
// cancellation signal to the process-local `HistoryService`, and serializes the bounded direct
// payload. Every binder/service result maps to the exact §8 status/code table below, including
// `Retry-After: 1` for overload. Failures carry only the exact `ERROR_MESSAGES` text and no closed
// detail keys (the service strips binder details), so PromQL, source bodies, raw paths, identity/
// header values, credentials, and exception text never appear. History responses are bounded
// service values — NOT cycle representations — so they carry no current-view ETag/observation
// protocol (§8). Malformed/repeated/unknown query input is rejected here, before any source/history
// allocation. The path-parameter decode/bounds/control/slash guards already ran in the router
// (`compile.ts`), so the params reaching a handler are decoded, control-free, and ≤512 bytes. The
// target route's `:drilldownId` and the checks route's `:endpoint` opt in via `slashParams` to a
// percent-encoded `/` (`svc%3Ahost%2Fname`, `host%2Fservice`; amendment 12 §1) — every service
// drilldown id and Gatus endpoint name carries one. The value is only ever an exact lookup key into
// the captured model, never a filesystem path or an upstream URL segment.

import type { WebEstateModelV2 } from "@pulse/renderer";
import type { HistoryFailure, HistoryResult } from "@pulse/web-data/history";
import { QUERY_CATALOG, RANGE_IDS, isQueryId } from "@pulse/web-data/queries";
import type { QueryId, RangeId, TargetIdentity, TargetKind } from "@pulse/web-data/wire";

import { defineRoute } from "../../shared/registry.js";
import { validateQuery } from "./compile.js";
import { apiError, errorFor, errorResponse } from "./respond.js";

/** Gatus check-history default window when the request omits `range`. Endpoint history is not a
 *  curated VM catalog query, so it has no per-query default; a full day of checks is the natural
 *  operator view and every closed range id is accepted by `HistoryService.endpointHistory`. */
const CHECKS_DEFAULT_RANGE: RangeId = "24h";

/**
 * Map each bounded `HistoryFailure` code to its exact HTTP status (05 §8). Every code is a subset
 * of `ApiErrorCode`, so the response body reuses the canonical `ERROR_MESSAGES` text via `apiError`.
 */
const HISTORY_STATUS: Readonly<Record<HistoryFailure["code"], number>> = {
  INVALID_REQUEST: 400,
  QUERY_NOT_FOUND: 404,
  TARGET_NOT_FOUND: 404,
  QUERY_NOT_APPLICABLE: 422,
  RANGE_UNSUPPORTED: 422,
  HISTORY_OVERLOADED: 503,
  SOURCE_UNAVAILABLE: 502,
  SOURCE_TIMEOUT: 504,
  HISTORY_LIMIT_EXCEEDED: 502,
  MODEL_CHANGED: 503,
  HISTORY_CANCELLED: 503,
};

/** Whether `value` is one of the four closed range ids. */
function isRangeId(value: string): value is RangeId {
  return (RANGE_IDS as readonly string[]).includes(value);
}

/** The raw query string of a request, or `""` when its URL is unparseable (a synthetic test request). */
function rawSearch(request: Request): string {
  try {
    return new URL(request.url).search;
  } catch {
    return "";
  }
}

/** The outcome of parsing a history request's query string: the resolved range, or a rejection. */
type ParsedQuery = { readonly ok: true; readonly range: RangeId } | { readonly ok: false };

/**
 * Parse the optional single `range` key (05 §6). Any other key, a repeated key, or an
 * over-length query string is rejected (`ok:false` → `INVALID_REQUEST`) before any source/history
 * allocation, so client `start`/`end`/`step`/PromQL never reach the service. An absent `range`
 * resolves to `defaultRange`; a present value must be one of the four closed range ids (an
 * id longer than the query's max is left for the binder to reject as `RANGE_UNSUPPORTED`).
 */
function parseHistoryQuery(request: Request, defaultRange: RangeId): ParsedQuery {
  const search = rawSearch(request);
  if (!validateQuery(search, ["range"]).ok) return { ok: false };
  const raw = search.startsWith("?") ? search.slice(1) : search;
  const value = new URLSearchParams(raw).get("range");
  if (value === null) return { ok: true, range: defaultRange };
  if (!isRangeId(value)) return { ok: false };
  return { ok: true, range: value };
}

/**
 * Build the target identity for a target-scoped request from the query's catalog target kind and
 * the exact captured drilldown id. An estate-kind query has no per-target identity, so it maps to a
 * `host` placeholder whose non-null presence makes the binder return `QUERY_NOT_APPLICABLE` (an
 * estate query cannot be scoped to a target).
 */
function targetForQuery(kind: TargetKind, id: string): TargetIdentity {
  if (kind === "service") return { kind: "service", id };
  if (kind === "endpoint") return { kind: "endpoint", id };
  return { kind: "host", id };
}

/**
 * Build the target identity for a target-scoped request. `estate.liveness` is the one query the
 * binder scopes to either a host or a service, so its kind comes from the captured model: a host
 * drilldown id first, then a service drilldown id — never inferred from the id's shape. An id that
 * matches neither keeps the host placeholder, which the binder answers with `TARGET_NOT_FOUND`.
 * Every other query takes its catalog target kind.
 */
function targetForRequest(queryId: QueryId, id: string, model: WebEstateModelV2 | null): TargetIdentity {
  if (queryId !== "estate.liveness") return targetForQuery(QUERY_CATALOG[queryId].targetKind, id);
  const isHost = model?.hosts.some((host) => host.drilldownId === id) ?? false;
  const isService = !isHost && (model?.services.some((service) => service.drilldownId === id) ?? false);
  return isService ? { kind: "service", id } : { kind: "host", id };
}

/**
 * Serialize a bounded history result (05 §8). A success is the direct typed payload as JSON with
 * `private, no-cache` (history is per-request and never a shared/cycle representation). A failure
 * is the canonical error envelope at its mapped status, with `Retry-After` only when the service
 * supplies a retry hint (overload).
 */
function respondHistory<T>(result: HistoryResult<T>): Response {
  if (result.ok) {
    return Response.json(result.data, { status: 200, headers: { "cache-control": "private, no-cache" } });
  }
  const failure = result.error;
  const status = HISTORY_STATUS[failure.code];
  const headers =
    failure.retryAfterSeconds !== null ? { "retry-after": String(failure.retryAfterSeconds) } : undefined;
  return errorResponse(apiError(failure.code), status, headers);
}

/** `GET /api/history/estate/:queryId` — estate-wide curated VM history (05 §§6, 8). */
export const historyEstateRoute = defineRoute({
  method: "GET",
  path: "/api/history/estate/:queryId",
  async handler(request, ctx) {
    const { queryId } = request.params;
    if (!isQueryId(queryId)) return errorFor("QUERY_NOT_FOUND", 404);
    const parsed = parseHistoryQuery(request.request, QUERY_CATALOG[queryId].defaultRange);
    if (!parsed.ok) return errorFor("INVALID_REQUEST", 400);
    return respondHistory(
      await ctx.history.query({ queryId, target: null, range: parsed.range, signal: request.request.signal }),
    );
  },
});

/** `GET /api/history/target/:drilldownId/:queryId` — target-scoped curated VM history (05 §§6, 8). */
export const historyTargetRoute = defineRoute({
  method: "GET",
  path: "/api/history/target/:drilldownId/:queryId",
  slashParams: ["drilldownId"],
  async handler(request, ctx) {
    const { drilldownId, queryId } = request.params;
    if (!isQueryId(queryId)) return errorFor("QUERY_NOT_FOUND", 404);
    const parsed = parseHistoryQuery(request.request, QUERY_CATALOG[queryId].defaultRange);
    if (!parsed.ok) return errorFor("INVALID_REQUEST", 400);
    const target = targetForRequest(queryId, drilldownId, ctx.estate?.model ?? null);
    return respondHistory(
      await ctx.history.query({ queryId, target, range: parsed.range, signal: request.request.signal }),
    );
  },
});

/** `GET /api/history/alerts` — estate-wide vmalert-derived firing intervals (05 §§6, 8). */
export const historyAlertsRoute = defineRoute({
  method: "GET",
  path: "/api/history/alerts",
  async handler(request, ctx) {
    const parsed = parseHistoryQuery(request.request, QUERY_CATALOG["alerts.firing"].defaultRange);
    if (!parsed.ok) return errorFor("INVALID_REQUEST", 400);
    return respondHistory(
      await ctx.history.alertIntervals({ range: parsed.range, target: null, signal: request.request.signal }),
    );
  },
});

/** `GET /api/history/checks/:endpoint` — exact-endpoint Gatus history (05 §§6, 8). */
export const historyChecksRoute = defineRoute({
  method: "GET",
  path: "/api/history/checks/:endpoint",
  slashParams: ["endpoint"],
  async handler(request, ctx) {
    const { endpoint } = request.params;
    const parsed = parseHistoryQuery(request.request, CHECKS_DEFAULT_RANGE);
    if (!parsed.ok) return errorFor("INVALID_REQUEST", 400);
    return respondHistory(
      await ctx.history.endpointHistory({ endpoint, range: parsed.range, signal: request.request.signal }),
    );
  },
});
