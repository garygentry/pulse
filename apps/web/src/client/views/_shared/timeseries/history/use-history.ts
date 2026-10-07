// Keyed, abortable, stale-retaining history loader for one region (02 §7, tech-spec §7.2).
// The hook depends on the primitive key string only, never on the request object's identity, so a
// live store update that rebuilds an equal request never refetches (PRD §7 idempotency).

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyFailure, fetchHistory } from "./client.js";
import type { HistoryRegionState, HistoryRequest, HistoryResponse, RequestPriority, RequestQueue } from "./client.js";

/** Options for useHistory. Every field is read on each render; only the key (§7.2) triggers a new request. */
export interface UseHistoryOptions {
  /** Shared page queue; one per mounted view. */
  readonly queue: RequestQueue;
  /** Queue priority for this region. */
  readonly priority: RequestPriority;
  /** Pause anchor in epoch seconds, or null when live. A key component only; never sent. */
  readonly end?: number | null;
  /** `store.connection.value.observation?.generation ?? null`; a server restart re-keys every region. */
  readonly generation?: string | null;
  /** Re-request period in ms while the key is stable (engine trends: LIVE_REFRESH_MS); null/absent = none. */
  readonly refreshMs?: number | null;
  /** When false the region is idle and no request is issued (e.g. collapsed, kiosk-hidden). Default true. */
  readonly enabled?: boolean;
  /**
   * When non-null the region is "not-applicable" with this plain-text reason and no request is
   * issued (e.g. rangeExceedsMax → "Not available at this range (max 24h)", the
   * checkHistoryReachable gate → "Check latency history not available"). Takes precedence over
   * `enabled` and `request`.
   */
  readonly notApplicable?: string | null;
}

/** Result of useHistory. */
export interface UseHistoryResult<T> {
  /** Region state to hand to HistoryRegion. */
  readonly state: HistoryRegionState<T>;
  /** Re-issue the current request now (manual Retry). No-op when idle or not-applicable. */
  retry(): void;
  /** The current primitive key, or null when idle/not-applicable. For tests and data attributes. */
  readonly key: string | null;
}

/**
 * Build the region key `op|target|queryId|range|end|generation` (tech-spec §7.2).
 * Each field is encodeURIComponent-encoded, so a "|" inside an id cannot collide.
 * - target: `${kind}:${id}` for op "target"; the endpoint key for op "checks"; "" otherwise.
 * - queryId: the query id for "estate"/"target"; "" otherwise.
 * - end: String(end) or ""; generation: the generation string or "".
 * Pure and total.
 */
export function historyKey(request: HistoryRequest, end: number | null, generation: string | null): string {
  const target =
    request.op === "target" ? `${request.target.kind}:${request.target.id}`
    : request.op === "checks" ? request.endpoint
    : "";
  const queryId = request.op === "estate" || request.op === "target" ? request.queryId : "";
  return [request.op, target, queryId, request.range, end === null ? "" : String(end), generation ?? ""]
    .map(encodeURIComponent)
    .join("|");
}

/** The data identity: the first four key fields (op|target|queryId|range). */
function historyIdentity(request: HistoryRequest): string {
  return historyKey(request, null, null).split("|").slice(0, 4).join("|");
}

/**
 * Keyed, abortable, stale-retaining history loader for one region (tech-spec §7.2).
 *
 * - A key change aborts the previous attempt; late results for an old key are discarded.
 * - `previous` is retained only for the same data identity, and never after a `too-many` failure.
 * - A `superseded` failure is re-requested automatically once per episode.
 * - `refreshMs` re-runs the attempt on an interval, skipping ticks while one is in flight.
 * - An AbortError never becomes a state. Never throws.
 *
 * @param request - The curated request, or null for "nothing to load" (idle).
 * @param options - Queue, priority, key extras and refresh policy.
 * @returns The region state, a retry function and the active key.
 */
export function useHistory<R extends HistoryRequest>(
  request: R | null,
  options: UseHistoryOptions,
): UseHistoryResult<HistoryResponse<R>> {
  type T = HistoryResponse<R>;
  const notApplicable = options.notApplicable ?? null;
  const enabled = options.enabled ?? true;
  const key =
    notApplicable !== null || !enabled || request === null
      ? null
      : historyKey(request, options.end ?? null, options.generation ?? null);

  const [state, setState] = useState<HistoryRegionState<T>>(() =>
    notApplicable !== null ? { phase: "not-applicable", reason: notApplicable }
    : key === null ? { phase: "idle" }
    : { phase: "loading", previous: null },
  );
  const requestRef = useRef<R | null>(request);
  requestRef.current = request;
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const keyRef = useRef<string | null>(key);
  const ctrlRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const lastGoodRef = useRef<{ readonly identity: string; readonly data: T } | null>(null);

  const start = useCallback((): void => {
    const req = requestRef.current;
    const attemptKey = keyRef.current;
    if (req === null || attemptKey === null) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    const identity = historyIdentity(req);
    const retained = (): T | null =>
      lastGoodRef.current !== null && lastGoodRef.current.identity === identity ? lastGoodRef.current.data : null;
    const stillCurrent = (): boolean => !ctrl.signal.aborted && keyRef.current === attemptKey;

    setState({ phase: "loading", previous: retained() });
    inFlightRef.current = true;
    let autoRetried = false;

    const attempt = async (): Promise<void> => {
      try {
        const { queue, priority } = optionsRef.current;
        const outcome = await queue.run(priority, ctrl.signal, (s) => fetchHistory(req, s));
        if (!stillCurrent()) return; // late result for a superseded key (PRD §7)
        if (outcome.ok) {
          lastGoodRef.current = { identity, data: outcome.data };
          setState({ phase: "ready", data: outcome.data });
        } else if (outcome.failure.kind === "superseded" && !autoRetried) {
          autoRetried = true; // REQ-HISTERR-03: re-request automatically once
          await attempt();
        } else {
          const previous = outcome.failure.kind === "too-many" ? null : retained(); // §7.4
          setState({ phase: "error", failure: outcome.failure, previous });
        }
      } catch {
        if (!stillCurrent()) return; // AbortError: lifecycle, never a state (tech-spec §7.1)
        setState({ phase: "error", failure: classifyFailure("NETWORK", null), previous: retained() });
      }
    };
    void attempt().finally(() => {
      if (ctrlRef.current === ctrl) inFlightRef.current = false;
    });
  }, []);

  useEffect(() => {
    keyRef.current = key;
    if (notApplicable !== null) {
      ctrlRef.current?.abort();
      setState({ phase: "not-applicable", reason: notApplicable });
      return;
    }
    if (key === null) {
      ctrlRef.current?.abort();
      setState({ phase: "idle" });
      return;
    }
    start();
    return () => ctrlRef.current?.abort();
  }, [key, notApplicable, start]);

  const refreshMs = options.refreshMs ?? null;
  useEffect(() => {
    if (key === null || refreshMs === null || !(refreshMs > 0)) return;
    const id = setInterval(() => {
      if (!inFlightRef.current) start();
    }, refreshMs);
    return () => clearInterval(id);
  }, [key, refreshMs, start]);

  const retry = useCallback((): void => {
    if (keyRef.current !== null) start();
  }, [start]);

  return { state, retry, key };
}
