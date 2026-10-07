// Shared history client for /engine and /timeline (D8, 02 §1–§5): curated URL building, fetch with
// per-op success discriminators, failure classification and a priority + FIFO request queue.
// No DOM beyond fetch / AbortSignal / Headers / DOMException (01 §4.4 rule 3).

import type {
  EndpointHistoryPayload, ErrorEnvelope, HistoryPayload, IntervalHistoryPayload, QueryId, RangeId, TargetIdentity,
} from "@pulse/web-data/wire";

// ---------------------------------------------------------------------------------------------
// Shared types (00 §5.1)
// ---------------------------------------------------------------------------------------------

/** Per-cause classification of a failed history request (REQ-HISTERR-01). */
export type HistoryFailureKind =
  | "overloaded" | "timeout" | "unavailable" | "too-many" | "not-applicable"
  | "superseded" | "not-ready" | "unexpected";

/** Classified failure with UI affordances (REQ-HISTERR-01/03). */
export interface ClassifiedFailure {
  /** Failure category. */ readonly kind: HistoryFailureKind;
  /** Original wire code, or "NETWORK" for a transport failure or a body that is neither a success payload nor an error envelope (02 §4). */ readonly code: string;
  /** Whether a Retry control is offered (REQ-HISTERR-03). */ readonly retryable: boolean;
  /** Server-suggested retry delay in seconds, if any. */ readonly retryAfterSeconds: number | null;
}

/** State of one history-backed region (REQ-HISTERR-02, REQ-FOLLOW-03). */
export type HistoryRegionState<T> =
  | { readonly phase: "idle" }
  | { readonly phase: "not-applicable"; readonly reason: string }
  | { readonly phase: "loading"; readonly previous: T | null }
  | { readonly phase: "ready"; readonly data: T }
  | { readonly phase: "error"; readonly failure: ClassifiedFailure; readonly previous: T | null };

/** One curated history request (REQ-SEC-01: ids only, never query text). */
export type HistoryRequest =
  | { readonly op: "alerts"; readonly range: RangeId }
  | { readonly op: "estate"; readonly queryId: QueryId; readonly range: RangeId }
  | { readonly op: "target"; readonly target: TargetIdentity; readonly queryId: QueryId; readonly range: RangeId }
  | { readonly op: "checks"; readonly endpoint: string; readonly range: RangeId };

/** Success body type for each request op. */
export type HistoryResponse<R extends HistoryRequest> =
  R extends { op: "alerts" } ? IntervalHistoryPayload
  : R extends { op: "checks" } ? EndpointHistoryPayload
  : HistoryPayload;

/** Outcome of one fetch: success body or classified failure. Aborts reject instead (see 02 §3). */
export type FetchOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

/** Queue priority: lower runs first; FIFO within a priority (tech-spec §7.2). */
export type RequestPriority = 0 | 1 | 2;

// ---------------------------------------------------------------------------------------------
// Constants (02 §2, 00 §6.3)
// ---------------------------------------------------------------------------------------------

/**
 * Maximum concurrent history requests issued by one page's queue (REQ-SCALE-01, tech-spec §7.2).
 * Matches the data tier's "four active" history operations (EPIC history-service contract).
 */
export const HISTORY_CONCURRENCY = 4;

/**
 * Live-follow and trend refresh period in ms (REQ-FOLLOW-01; /engine trends, tech-spec §3.2).
 * Also the value passed as `UseHistoryOptions.refreshMs` by engine trends.
 */
export const LIVE_REFRESH_MS = 60_000;

// ---------------------------------------------------------------------------------------------
// URL building and fetching (02 §3)
// ---------------------------------------------------------------------------------------------

/**
 * Build the same-origin URL for one curated history request (tech-spec §5.1).
 *
 * Every path segment and the `range` query value pass through `encodeURIComponent` (REQ-SEC-04).
 * Only the single `range` key is emitted: the server rejects any other key with INVALID_REQUEST
 * (`parseHistoryQuery` in apps/web/src/server/routes/history.ts), and the client never sends a
 * window, step or query text (REQ-SEC-01). For `op: "target"` only `target.id` is sent; the server
 * derives the target kind from the catalog (`targetForQuery`).
 *
 * A slash-bearing id (e.g. "web01/nginx") stays one segment, encoded as `%2F`, which the history
 * routes accept on `:endpoint` and `:drilldownId`. This function applies no reachability gate:
 * callers consult `checkHistoryReachable` (09 §1) and issue no request when it is false.
 *
 * @param request - A curated request (ids only).
 * @returns A path plus `?range=` query, e.g. "/api/history/estate/engine.active-series?range=6h".
 */
export function historyUrl(request: HistoryRequest): string {
  const query = `?range=${encodeURIComponent(request.range)}`;
  switch (request.op) {
    case "alerts":
      return `/api/history/alerts${query}`;
    case "estate":
      return `/api/history/estate/${encodeURIComponent(request.queryId)}${query}`;
    case "target":
      return `/api/history/target/${encodeURIComponent(request.target.id)}/${encodeURIComponent(request.queryId)}${query}`;
    case "checks":
      return `/api/history/checks/${encodeURIComponent(request.endpoint)}${query}`;
  }
}

/** True when `body` is the success payload for `request` (tech-spec §5.1). Total; never throws. */
function isSuccessBody<R extends HistoryRequest>(request: R, body: unknown): body is HistoryResponse<R> {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { readonly operation?: unknown; readonly queryId?: unknown };
  switch (request.op) {
    case "alerts":
      return b.operation === "alert-intervals";
    case "checks":
      return b.operation === "endpoint-history";
    case "estate":
    case "target":
      return b.queryId === request.queryId;
  }
}

/**
 * The failure code carried by a non-success body. A body that is not an object with a string
 * `code` is treated as a transport fault and yields "NETWORK" (alerts precedent: `errorCode`).
 */
function envelopeCode(body: unknown): string {
  const code =
    typeof body === "object" && body !== null ? (body as Partial<ErrorEnvelope>).code : undefined;
  return typeof code === "string" ? code : "NETWORK";
}

/**
 * Parse a `Retry-After` header value as whole seconds. Only the delta-seconds form is accepted;
 * the HTTP-date form, empty, negative or absurd values (> 86 400) give null.
 */
function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n <= 86_400 ? n : null;
}

/**
 * Issue one curated history GET and resolve to a success body or a classified failure.
 *
 * - Uses `globalThis.fetch`, read at call time so tests can stub it (alerts History.tsx precedent),
 *   with `{ signal, headers: { accept: "application/json" } }`.
 * - Success iff the body matches the op discriminator (§3.2), regardless of HTTP status.
 * - Otherwise the body is read as an ErrorEnvelope, and `classifyFailure(code, retryAfter)` (§4) is
 *   applied, with `retryAfter` parsed only for HISTORY_OVERLOADED (§3.3).
 * - A non-abort fetch rejection, or a body that is not JSON, resolves to
 *   `{ ok: false, failure: classifyFailure("NETWORK", null) }` (kind "unexpected").
 *
 * Aborts are lifecycle events, not errors (00 §8.5, tech-spec §7.1). If `signal` aborts at any
 * point, the returned promise REJECTS with a DOMException named "AbortError" and never resolves to a
 * failure outcome. That is the only way this function rejects.
 *
 * @param request - Curated request (00 §5.1).
 * @param signal - Abort signal owned by the caller (useHistory's per-attempt AbortController).
 * @returns The typed success body, or a classified failure.
 * @throws {DOMException} name "AbortError" when `signal` is aborted.
 */
export async function fetchHistory<R extends HistoryRequest>(
  request: R,
  signal: AbortSignal,
): Promise<FetchOutcome<HistoryResponse<R>>> {
  let res: Response;
  try {
    res = await globalThis.fetch(historyUrl(request), {
      signal,
      headers: { accept: "application/json" },
    });
  } catch (err) {
    if (signal.aborted || isAbortError(err)) throw abortError();
    return { ok: false, failure: classifyFailure("NETWORK", null) };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    if (signal.aborted || isAbortError(err)) throw abortError();
    return { ok: false, failure: classifyFailure("NETWORK", null) };
  }
  if (signal.aborted) throw abortError(); // a late body for a cancelled attempt is dropped

  if (isSuccessBody(request, body)) return { ok: true, data: body };

  const code = envelopeCode(body);
  const retryAfter =
    code === "HISTORY_OVERLOADED" ? parseRetryAfter(res.headers.get("retry-after")) : null;
  return { ok: false, failure: classifyFailure(code, retryAfter) };
}

/** True when `err` is an abort rejection (DOMException or Error named "AbortError"). */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

/** A fresh abort rejection value. DOMException is a runtime global in Bun, happy-dom and browsers. */
function abortError(): DOMException {
  return new DOMException("The history request was aborted.", "AbortError");
}

// ---------------------------------------------------------------------------------------------
// Failure classification (02 §4)
// ---------------------------------------------------------------------------------------------

/**
 * Classify a history failure code (tech-spec §7.1, REQ-HISTERR-01/03, REQ-SCALE-03).
 *
 * Pure and total: every string maps to exactly one kind, and unknown codes map to "unexpected".
 * `HISTORY_LIMIT_EXCEEDED` always maps to "too-many" and is never retryable, so overflow is an
 * explicit error and never a truncated result (REQ-SCALE-03, REQ-HISTERR-04).
 *
 * @param code - Wire `ErrorEnvelope.code`, or "NETWORK" for a transport/malformed-body failure.
 * @param retryAfterSeconds - Parsed Retry-After seconds; kept only for kind "overloaded".
 * @returns The classified failure; `code` is echoed unchanged for diagnostics and data attributes.
 */
export function classifyFailure(code: string, retryAfterSeconds: number | null): ClassifiedFailure {
  const kind = failureKind(code);
  return {
    kind,
    code,
    retryable: kind !== "too-many" && kind !== "not-applicable",
    retryAfterSeconds: kind === "overloaded" ? retryAfterSeconds : null,
  };
}

/** Code → kind table (tech-spec §7.1). */
function failureKind(code: string): HistoryFailureKind {
  switch (code) {
    case "HISTORY_OVERLOADED":
      return "overloaded";
    case "SOURCE_TIMEOUT":
      return "timeout";
    case "SOURCE_UNAVAILABLE":
      return "unavailable";
    case "HISTORY_LIMIT_EXCEEDED":
      return "too-many";
    case "QUERY_NOT_APPLICABLE":
    case "RANGE_UNSUPPORTED":
    case "TARGET_NOT_FOUND":
      return "not-applicable";
    case "MODEL_CHANGED":
    case "HISTORY_CANCELLED":
      return "superseded";
    case "NOT_READY":
      return "not-ready";
    default:
      return "unexpected";
  }
}

// ---------------------------------------------------------------------------------------------
// Request queue (02 §5)
// ---------------------------------------------------------------------------------------------

/** A priority + FIFO concurrency limiter for history requests (tech-spec §7.2). */
export interface RequestQueue {
  /**
   * Run `task` when a slot is free. Lower `priority` runs first; equal priorities run in
   * submission order (FIFO).
   *
   * - If `signal` is already aborted, rejects immediately with AbortError and never runs `task`.
   * - If `signal` aborts while queued, the entry is removed, the promise rejects with AbortError and
   *   no slot is consumed.
   * - If `signal` aborts while running, the task's own fetch rejects (fetchHistory, §3.4). The slot
   *   is released when the task settles, and the next entry starts in the same tick.
   *
   * @param priority - 0 = alerts, coverage probe, engine trends; 1 = selected target charts;
   *   2 = expanded-service checks (00 §5.1).
   * @param signal - The caller's abort signal; also passed through to `task`.
   * @param task - The work to run; receives `signal`.
   * @returns The task's result, or a rejection with the task's error or an AbortError.
   */
  run<T>(priority: RequestPriority, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Number of tasks currently running (0..limit). For tests and diagnostics. */
  readonly active: number;
  /** Number of tasks waiting for a slot, across all priorities. For tests and diagnostics. */
  readonly queued: number;
}

interface QueueEntry {
  /** Queue priority bucket. */ readonly priority: RequestPriority;
  /** Starts the task; called once when a slot is granted. */ readonly start: () => void;
  /** Rejects the caller's promise with AbortError and detaches the abort listener. */ readonly cancel: () => void;
}

/**
 * Create a request queue with at most `limit` concurrent tasks.
 *
 * @param limit - Concurrency cap; defaults to HISTORY_CONCURRENCY (4).
 * @returns A new, independent queue.
 * @throws {RangeError} If `limit` is not a positive integer (a programming error, not a runtime
 *   condition; 00 §8 bans custom error classes, so the built-in RangeError is used).
 */
export function createRequestQueue(limit: number = HISTORY_CONCURRENCY): RequestQueue {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`createRequestQueue: limit must be a positive integer, got ${String(limit)}`);
  }
  const buckets: readonly [QueueEntry[], QueueEntry[], QueueEntry[]] = [[], [], []];
  let active = 0;

  const pump = (): void => {
    while (active < limit) {
      const bucket = buckets.find((b) => b.length > 0);
      const entry = bucket?.shift();
      if (entry === undefined) return;
      active++;
      entry.start();
    }
  };

  return {
    run<T>(priority: RequestPriority, signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        const bucket = buckets[priority];
        const onAbort = (): void => {
          const i = bucket.indexOf(entry);
          if (i >= 0) bucket.splice(i, 1);
          entry.cancel();
        };
        const entry: QueueEntry = {
          priority,
          start: () => {
            signal.removeEventListener("abort", onAbort);
            let settled = false;
            const release = (): void => {
              if (settled) return;
              settled = true;
              active--;
              pump();
            };
            let running: Promise<T>;
            try {
              running = task(signal);
            } catch (err) {
              running = Promise.reject(err);
            }
            Promise.resolve(running).then(
              (value) => {
                release();
                resolve(value);
              },
              (err: unknown) => {
                release();
                reject(err);
              },
            );
          },
          cancel: () => {
            signal.removeEventListener("abort", onAbort);
            reject(abortError());
          },
        };
        signal.addEventListener("abort", onAbort, { once: true });
        bucket.push(entry);
        pump();
      });
    },
    get active(): number {
      return active;
    },
    get queued(): number {
      return buckets[0].length + buckets[1].length + buckets[2].length;
    },
  };
}
