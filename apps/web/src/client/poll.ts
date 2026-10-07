// src/client/poll.ts — the snapshot polling loop (REQ-LIVE-05/06).
//
// A `setTimeout`-chained fetch of `GET /api/overview` every `POLL_INTERVAL_MS`. It never blocks
// interaction, REPLACES (never accumulates) the single retained snapshot (REQ-LIVE-06), raises the
// app-server stale flag after `POLL_STALE_MS` of failures, and fires exactly one `location.reload()`
// on an `appVersion` change (version-skew, REQ-LIVE-06).

import type { OverviewSnapshot } from "../shared/snapshot.js";
import { POLL_INTERVAL_MS, POLL_STALE_MS } from "../shared/constants.js";

/** The observable state of the poll loop. A NEW object is emitted each poll; subscribers replace their
 *  prior value (no mutation, no accumulation — REQ-LIVE-06). */
export interface PollState {
  /** The latest good snapshot, or `null` before the first success. The previous snapshot is dropped on
   *  each replace — client memory stays bounded across multi-week sessions (REQ-LIVE-06). */
  snapshot: OverviewSnapshot | null;
  /** Client-clock epoch ms of the last successful poll; `null` before any success. */
  lastGoodAt: number | null;
  /** Client-clock epoch ms when the current failure streak began; `null` while polls are succeeding. */
  failingSince: number | null;
  /** True once the failure streak exceeds `POLL_STALE_MS` — drives the app-server stale banner (§3.1). */
  appStale: boolean;
  /** Lifecycle phase for first-paint vs steady-state rendering. */
  phase: "initial" | "live" | "stale";
}

/** Handle returned by `startPolling`; the shell subscribes and (in tests) stops it. */
export interface PollController {
  /** Current state without subscribing (used for the shell's initial `useState`). */
  getState(): PollState;
  /** Subscribe to state changes; returns an unsubscribe function. Fired after every poll (success or
   *  failure) that changes state. */
  subscribe(listener: (state: PollState) => void): () => void;
  /** Stop the loop and abort any in-flight fetch (test teardown / HMR). */
  stop(): void;
}

/** Start the poll loop immediately (first fetch fires on the next tick, not after a delay).
 *  @param opts.fetchImpl - injectable fetch for tests (defaults to global `fetch`).
 *  @param opts.intervalMs - poll cadence (defaults to `POLL_INTERVAL_MS`).
 *  @param opts.staleMs - failure window before `appStale` (defaults to `POLL_STALE_MS`).
 *  @param opts.reload - injectable reload for tests (defaults to `() => location.reload()`).
 *  @returns a `PollController`. */
export function startPolling(opts?: {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  staleMs?: number;
  reload?: () => void;
}): PollController {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const intervalMs = opts?.intervalMs ?? POLL_INTERVAL_MS;
  const staleMs = opts?.staleMs ?? POLL_STALE_MS;
  const reload = opts?.reload ?? (() => location.reload());

  const listeners = new Set<(state: PollState) => void>();
  let state: PollState = {
    snapshot: null,
    lastGoodAt: null,
    failingSince: null,
    appStale: false,
    phase: "initial",
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let stopped = false;
  let reloaded = false;
  let initialAppVersion: string | null = null;

  function emit(next: PollState): void {
    state = next;
    for (const listener of listeners) listener(next);
  }

  function schedule(): void {
    if (stopped || reloaded) return;
    timer = setTimeout(tick, intervalMs);
  }

  async function tick(): Promise<void> {
    controller = new AbortController();
    try {
      const res = await fetchImpl("/api/overview", {
        signal: controller.signal,
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`GET /api/overview → HTTP ${res.status}`);
      const snapshot = (await res.json()) as OverviewSnapshot;

      if (initialAppVersion === null) {
        initialAppVersion = snapshot.appVersion;
      } else if (snapshot.appVersion !== initialAppVersion) {
        // Version skew: reload EXACTLY ONCE against the new server build, and stop scheduling.
        if (!reloaded) {
          reloaded = true;
          reload();
        }
        return;
      }

      // Success: the fresh snapshot REPLACES the prior — no array push, no history retained.
      emit({
        snapshot,
        lastGoodAt: Date.now(),
        failingSince: null,
        appStale: false,
        phase: "live",
      });
    } catch (err) {
      if (stopped) return;
      const now = Date.now();
      const failingSince = state.failingSince ?? now;
      const appStale = now - failingSince > staleMs;
      console.warn("[poll] /api/overview poll failed:", err);
      // Retain the LAST GOOD snapshot (never blank it — REQ-LIVE-03); the loop self-heals on recovery.
      emit({
        snapshot: state.snapshot,
        lastGoodAt: state.lastGoodAt,
        failingSince,
        appStale,
        phase: appStale ? "stale" : state.lastGoodAt !== null ? "live" : "initial",
      });
    } finally {
      schedule();
    }
  }

  // First fetch fires on the next tick (not after a full interval) so first paint is fast (REQ-PERF-02).
  timer = setTimeout(tick, 0);

  return {
    getState: () => state,
    subscribe(listener: (state: PollState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop(): void {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      controller?.abort();
    },
  };
}
