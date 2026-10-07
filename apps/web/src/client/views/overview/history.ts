// apps/web/src/client/views/overview/history.ts — the lazy target liveness-history controller
// behind the drawer's sparkline. This is the ONLY overview module that
// performs I/O: one fixed curated request per load/retry, strictly validated before it becomes a
// `HistoryPayload`, success-cached per target for `HISTORY_TTL_MS`, and guarded by a monotonically
// increasing request token so a late/obsolete completion can never replace newer state. Pure
// TypeScript — no React; the drawer's LivenessSparkline owns the reactive bridge.

import {
  ERROR_MESSAGES,
  HISTORY_MAX_LABELS,
  HISTORY_MAX_LABEL_KEY_BYTES,
  HISTORY_MAX_LABEL_VALUE_BYTES,
  HISTORY_MAX_POINTS,
  HISTORY_TTL_MS,
  type ApiErrorCode,
  type HistoryPayload,
  type HistorySeries,
  type TargetIdentity,
} from "@pulse/web-data/wire";
import { apiFetch, type ApiFetchResult } from "../../api/client.js";
import {
  OVERVIEW_HISTORY_QUERY,
  OVERVIEW_HISTORY_RANGE,
  type HistoryController,
  type HistoryControllerOptions,
  type HistoryErrorCode,
  type HistoryFetch,
  type HistoryListener,
  type OverviewTarget,
  type TargetHistoryState,
} from "./model.js";

/** Bounded drawer-local copy for `INTERNAL_ERROR` (malformed payload, protocol or network failure). */
export const HISTORY_UNAVAILABLE_MESSAGE = "History unavailable";

/** The exact, fixed liveness-history request path for one canonical target. */
export function targetHistoryPath(drilldownId: string): string {
  return `/api/history/target/${encodeURIComponent(drilldownId)}/estate.liveness?range=1h`;
}

/**
 * Production transport: the sole overview `apiFetch` call. `<unknown>` because `apiFetch` parses
 * JSON but does not validate `HistoryPayload`; the controller validates it.
 */
export const apiHistoryFetch: HistoryFetch = (path, options) =>
  apiFetch<unknown>(path, options?.signal !== undefined ? { signal: options.signal } : {});

// ---------------------------------------------------------------------------------------------
// Strict payload validation
// ---------------------------------------------------------------------------------------------

const PAYLOAD_KEYS = [
  "queryId",
  "target",
  "range",
  "fetchedAt",
  "effectiveStepSeconds",
  "unit",
  "stale",
  "series",
] as const;
const TARGET_KEYS = ["kind", "id"] as const;
const SERIES_KEYS = ["labels", "points"] as const;

const utf8 = new TextEncoder();

/** A plain (Object.prototype or null-prototype) non-array object. */
function isPlainRecord(value: unknown): value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Read the own enumerable DATA properties of a plain record. Returns null when the value is not a
 * plain record, has symbol/non-enumerable/accessor properties, or (when `keys` is given) its key
 * set is not exactly `keys`. Never invokes getters.
 */
function readRecord(value: unknown, keys?: readonly string[]): Map<string, unknown> | null {
  if (!isPlainRecord(value)) return null;
  const own = Reflect.ownKeys(value);
  if (keys !== undefined && own.length !== keys.length) return null;
  const out = new Map<string, unknown>();
  for (const key of own) {
    if (typeof key !== "string") return null;
    if (keys !== undefined && !keys.includes(key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    out.set(key, descriptor.value);
  }
  return out;
}

/** A real array's elements read without invoking accessors; null for holes/accessors/non-arrays. */
function readArray(value: unknown, maxLength: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maxLength) return null;
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    out.push(descriptor.value);
  }
  return out;
}

function validateLabels(value: unknown): Readonly<Record<string, string>> | null {
  const record = readRecord(value);
  if (record === null || record.size > HISTORY_MAX_LABELS) return null;
  const entries: [string, string][] = [];
  for (const [key, label] of record) {
    if (typeof label !== "string") return null;
    if (utf8.encode(key).byteLength > HISTORY_MAX_LABEL_KEY_BYTES) return null;
    if (utf8.encode(label).byteLength > HISTORY_MAX_LABEL_VALUE_BYTES) return null;
    entries.push([key, label]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function validatePoints(value: unknown): HistorySeries["points"] | null {
  const raw = readArray(value, HISTORY_MAX_POINTS);
  if (raw === null) return null;
  const points: (readonly [number, number | null])[] = [];
  let previous = -Infinity;
  for (const item of raw) {
    const pair = readArray(item, 2);
    if (pair === null || pair.length !== 2) return null;
    const [at, sample] = pair;
    if (typeof at !== "number" || !Number.isFinite(at) || at < 0 || at > Number.MAX_SAFE_INTEGER) return null;
    if (at <= previous) return null;
    if (sample !== null && (typeof sample !== "number" || !Number.isFinite(sample))) return null;
    previous = at;
    points.push(Object.freeze([at, sample] as const));
  }
  return Object.freeze(points);
}

function validateSeries(value: unknown): HistorySeries | null {
  const record = readRecord(value, SERIES_KEYS);
  if (record === null) return null;
  const labels = validateLabels(record.get("labels"));
  const points = validatePoints(record.get("points"));
  if (labels === null || points === null) return null;
  return Object.freeze({ labels, points });
}

function validatePayload(input: unknown, expected: TargetIdentity): HistoryPayload | null {
  const record = readRecord(input, PAYLOAD_KEYS);
  if (record === null) return null;
  if (record.get("queryId") !== OVERVIEW_HISTORY_QUERY) return null;
  if (record.get("range") !== OVERVIEW_HISTORY_RANGE) return null;
  if (record.get("unit") !== "state") return null;

  const target = readRecord(record.get("target"), TARGET_KEYS);
  if (target === null || target.get("kind") !== expected.kind || target.get("id") !== expected.id) return null;

  const fetchedAt = record.get("fetchedAt");
  if (typeof fetchedAt !== "string" || fetchedAt === "" || Number.isNaN(Date.parse(fetchedAt))) return null;
  const step = record.get("effectiveStepSeconds");
  if (typeof step !== "number" || !Number.isFinite(step) || step <= 0) return null;
  const stale = record.get("stale");
  if (typeof stale !== "boolean") return null;

  const rawSeries = readArray(record.get("series"), 1);
  if (rawSeries === null || rawSeries.length !== 1) return null;
  const series = validateSeries(rawSeries[0]);
  if (series === null) return null;

  return Object.freeze({
    queryId: OVERVIEW_HISTORY_QUERY,
    target: Object.freeze({ ...expected }),
    range: OVERVIEW_HISTORY_RANGE,
    fetchedAt,
    effectiveStepSeconds: step,
    unit: "state",
    stale,
    series: Object.freeze([series]),
  });
}

/** Strictly validate and copy one target-liveness response; return null without throwing on failure. */
export function validateTargetLivenessPayload(
  input: unknown,
  expectedTarget: TargetIdentity,
): HistoryPayload | null {
  try {
    return validatePayload(input, expectedTarget);
  } catch {
    // Proxies/exotic objects that throw during inspection are invalid, never a crash.
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------------------------

/** Map every shared `ApiErrorCode` (and any unrecognized runtime string) to a closed history code. */
export function historyErrorCode(code: ApiErrorCode | string): HistoryErrorCode {
  const known = code as ApiErrorCode;
  switch (known) {
    case "INVALID_REQUEST":
    case "QUERY_NOT_FOUND":
    case "TARGET_NOT_FOUND":
    case "QUERY_NOT_APPLICABLE":
    case "RANGE_UNSUPPORTED":
    case "HISTORY_OVERLOADED":
    case "SOURCE_UNAVAILABLE":
    case "SOURCE_TIMEOUT":
    case "HISTORY_LIMIT_EXCEEDED":
    case "HISTORY_CANCELLED":
    case "MODEL_CHANGED":
    case "INTERNAL_ERROR":
      return known;
    case "API_NOT_FOUND":
    case "METHOD_NOT_ALLOWED":
    case "NOT_READY":
    case "CYCLE_BUILD_FAILED":
    case "ESTATE_BUNDLE_MISSING":
    case "ESTATE_BUNDLE_UNREADABLE":
    case "ESTATE_BUNDLE_UNPARSEABLE":
    case "ESTATE_BUNDLE_VERSION":
    case "ESTATE_BUNDLE_STRUCTURE":
    case "ESTATE_BUNDLE_INCOHERENT":
      return "INTERNAL_ERROR";
    default: {
      const _exhaustive: never = known;
      void _exhaustive;
      return "INTERNAL_ERROR";
    }
  }
}

/** Bounded catalog copy for a history error; never server-provided or interpolated text. */
export function historyErrorMessage(code: HistoryErrorCode): string {
  return code === "INTERNAL_ERROR" ? HISTORY_UNAVAILABLE_MESSAGE : ERROR_MESSAGES[code];
}

function errorState(targetId: string, code: HistoryErrorCode): TargetHistoryState {
  return Object.freeze({
    status: "error",
    targetId,
    code,
    message: historyErrorMessage(code),
    retryable: true,
  });
}

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

const IDLE: TargetHistoryState = Object.freeze({ status: "idle" });

type ReadyState = Extract<TargetHistoryState, { status: "ready" }>;

interface ActiveRequest {
  readonly target: OverviewTarget;
  readonly token: number;
  readonly abort: AbortController;
  /** Shared by concurrent duplicate loads; assigned right after the request starts. */
  promise: Promise<TargetHistoryState>;
}

/** Cache key: (kind, drilldownId) — query id and range are fixed constants for this controller. */
function cacheKey(target: OverviewTarget): string {
  return `${target.identity.kind}\u0000${target.drilldownId}\u0000${OVERVIEW_HISTORY_QUERY}\u0000${OVERVIEW_HISTORY_RANGE}`;
}

function sameTarget(a: OverviewTarget, b: OverviewTarget): boolean {
  return a.identity.kind === b.identity.kind && a.drilldownId === b.drilldownId;
}

/** Create a per-mounted-overview lazy liveness-history controller. */
export function createHistoryController(options: HistoryControllerOptions): HistoryController {
  const fetchHistory = options.fetch;
  const now = options.now ?? Date.now;
  const cache = new Map<string, ReadyState>();
  let listeners: HistoryListener[] = [];
  let current: TargetHistoryState = IDLE;
  let selected: OverviewTarget | null = null;
  let active: ActiveRequest | null = null;
  let token = 0;
  let disposed = false;

  /** Store `next`, then notify a snapshot of listeners in registration order, isolating failures. */
  function publish(next: TargetHistoryState): void {
    current = next;
    for (const listener of listeners.slice()) {
      try {
        listener(next);
      } catch {
        // One failing consumer must not starve the others.
      }
    }
  }

  /** Invalidate and abort the in-flight request, if any. Token first: abort alone is insufficient. */
  function invalidate(): void {
    token += 1;
    const request = active;
    active = null;
    request?.abort.abort();
  }

  function disposedState(target: OverviewTarget | null): TargetHistoryState {
    return target === null ? errorState("", "INTERNAL_ERROR") : errorState(target.drilldownId, "INTERNAL_ERROR");
  }

  async function run(target: OverviewTarget, requestToken: number, signal: AbortSignal): Promise<TargetHistoryState> {
    let result: ApiFetchResult<unknown> | null;
    try {
      result = await fetchHistory(targetHistoryPath(target.drilldownId), { signal });
    } catch {
      result = null; // an injected transport that rejects is a bounded network failure
    }
    // Late/obsolete completion (cancel, target switch, retry, dispose) is ignored completely.
    if (disposed || requestToken !== token || selected === null || !sameTarget(selected, target)) return current;
    if (active?.token === requestToken) active = null;

    let next: TargetHistoryState;
    if (result === null || result.status === "not-modified") {
      next = errorState(target.drilldownId, "INTERNAL_ERROR");
    } else if (result.status === "error") {
      next = errorState(target.drilldownId, historyErrorCode(result.error.code));
    } else {
      const payload = validateTargetLivenessPayload(result.value, target.identity);
      if (payload === null) {
        next = errorState(target.drilldownId, "INTERNAL_ERROR");
      } else {
        const ready: ReadyState = Object.freeze({
          status: "ready",
          targetId: target.drilldownId,
          payload,
          receivedAt: now(),
        });
        cache.set(cacheKey(target), ready);
        next = ready;
      }
    }
    publish(next);
    return next;
  }

  /** Start one fresh request for `target` under a new token and AbortController. */
  function start(target: OverviewTarget): Promise<TargetHistoryState> {
    invalidate();
    const requestToken = token;
    const abort = new AbortController();
    selected = target;
    publish(Object.freeze({ status: "loading", targetId: target.drilldownId }));
    // Register before running: an injected transport may complete synchronously.
    const request: ActiveRequest = { target, token: requestToken, abort, promise: Promise.resolve(current) };
    active = request;
    // Every expected failure resolves through state; never leak a rejection regardless.
    request.promise = run(target, requestToken, abort.signal).catch(() => current);
    return request.promise;
  }

  return {
    state: () => current,

    subscribe(listener) {
      if (disposed) return () => {};
      listeners.push(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      };
    },

    load(target) {
      if (disposed) return Promise.resolve(disposedState(target));

      const key = cacheKey(target);
      const hit = cache.get(key);
      if (hit !== undefined) {
        if (now() - hit.receivedAt < HISTORY_TTL_MS) {
          if (active !== null) invalidate();
          selected = target;
          if (current !== hit) publish(hit);
          return Promise.resolve(hit);
        }
        cache.delete(key); // expired entries are deleted before a new request
      }

      // A concurrent duplicate load for the in-flight target shares the one request.
      if (active !== null && sameTarget(active.target, target)) return active.promise;
      return start(target);
    },

    retry() {
      if (disposed) return Promise.resolve(disposedState(selected));
      if (selected === null) return Promise.resolve(current);
      cache.delete(cacheKey(selected));
      return start(selected);
    },

    cancel() {
      if (disposed) return;
      invalidate();
      selected = null;
      if (current.status !== "idle") publish(IDLE);
    },

    dispose() {
      if (disposed) return;
      invalidate();
      selected = null;
      cache.clear();
      if (current.status !== "idle") publish(IDLE);
      disposed = true;
      listeners = [];
    },
  };
}
