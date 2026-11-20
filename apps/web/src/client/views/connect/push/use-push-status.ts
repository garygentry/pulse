// apps/web/src/client/views/connect/push/use-push-status.ts — the push status for /connect: one fetch on mount,
// then a 5 s poll while the caller asks for it. Reads no signals.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PushStatusPayload } from "@pulse/web-data/wire";

import { getPushStatus, type PushClientError } from "./push-api.js";

/** Poll interval while a pairing code is outstanding. */
export const PUSH_POLL_MS = 5_000;

/** What the push sections render from. */
export type PushStatusState =
  /** The first request is in flight. */
  | { readonly kind: "loading" }
  /** Push is disabled (404/405), misconfigured, or the first load failed: render nothing. */
  | { readonly kind: "hidden" }
  /** A configured status; `refreshError` is the last later-load failure, or null. */
  | { readonly kind: "ready"; readonly status: PushStatusPayload; readonly refreshError: PushClientError | null };

/** The hook's result. */
export interface UsePushStatus {
  /** Current state. */
  readonly state: PushStatusState;
  /** Fetch now; resolves with the new payload or null on failure. Used after issue, cancel, revoke. */
  readonly refresh: () => Promise<PushStatusPayload | null>;
}

const LOADING: PushStatusState = { kind: "loading" };
const HIDDEN: PushStatusState = { kind: "hidden" };

/**
 * Fetch once on mount (null fetchImpl → never fetch, state "hidden"). While `poll` is true, refetch every
 * PUSH_POLL_MS through a setTimeout chain (not setInterval, so a frozen visual clock keeps captures deterministic).
 * Aborts in-flight requests on unmount.
 * - First load: ok + configured → ready; ok + misconfigured → hidden; error → hidden.
 * - Later loads: ok + configured → ready; misconfigured or "unavailable" → hidden; other errors keep the last
 *   payload and set refreshError.
 */
export function usePushStatus(fetchImpl: typeof fetch | null, poll: boolean): UsePushStatus {
  const [state, setState] = useState<PushStatusState>(fetchImpl === null ? HIDDEN : LOADING);
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const loadedOnce = useRef(false);

  const load = useCallback(async (): Promise<PushStatusPayload | null> => {
    if (fetchImpl === null || !mounted.current) return null;
    const controller = new AbortController();
    controllers.current.add(controller);
    const result = await getPushStatus(controller.signal, fetchImpl);
    controllers.current.delete(controller);
    if (controller.signal.aborted || !mounted.current) return null;
    const first = !loadedOnce.current;
    loadedOnce.current = true;

    if (result.ok) {
      if (result.value.state === "configured") {
        setState({ kind: "ready", status: result.value, refreshError: null });
        return result.value;
      }
      setState(HIDDEN);
      return null;
    }
    if (first || result.error === "unavailable") {
      setState(HIDDEN);
      return null;
    }
    const error = result.error;
    setState((prev) => (prev.kind === "ready" ? { kind: "ready", status: prev.status, refreshError: error } : HIDDEN));
    return null;
  }, [fetchImpl]);

  // Mount: one fetch; unmount: abort everything in flight.
  useEffect(() => {
    mounted.current = true;
    loadedOnce.current = false;
    const live = controllers.current;
    if (fetchImpl === null) setState(HIDDEN);
    else void load();
    return () => {
      mounted.current = false;
      for (const controller of live) controller.abort();
      live.clear();
    };
  }, [fetchImpl, load]);

  // Poll: a setTimeout chain, one request at a time.
  useEffect(() => {
    if (!poll || fetchImpl === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (): void => {
      timer = setTimeout(() => {
        timer = null;
        void load().then(() => {
          if (!cancelled) schedule();
        });
      }, PUSH_POLL_MS);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [poll, fetchImpl, load]);

  return { state, refresh: load };
}
