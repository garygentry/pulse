// mutations/pending.ts — post-success expectation tracker (REQ-UX-01).
// The tracker records expectations, never a synthesized state: the UI shows `pending` until the
// live AlertsPayload satisfies the predicate, and never writes store.alerts.
import { effect, signal } from "@preact/signals-core";
import type { Signal } from "@preact/signals-core";
import type { AlertsPayload } from "@pulse/web-data/wire";
import { PENDING_STALE_MS } from "../../shared/mutations.js";
import type { AppStore } from "../store/index.js";

/** What the pending marker is attached to. */
export type PendingTarget =
  | { readonly kind: "alert"; readonly fingerprint: string }
  | { readonly kind: "silence"; readonly silenceId: string };
/** One outstanding post-success expectation (REQ-UX-01). */
export interface PendingEntry {
  /** What the pending marker is attached to. */
  readonly target: PendingTarget;
  /** True once live data reflects the change. */
  readonly reflected: (payload: AlertsPayload) => boolean;
  /** Monotonic ms when the success was received. */
  readonly since: number;
}
/** Tracks post-success expectations until the next payloads reflect them. */
export interface PendingTracker {
  /** Start tracking a post-success expectation. */
  add(entry: PendingEntry): void;
  /** Called on every alerts payload publication; removes reflected entries. */
  observe(payload: AlertsPayload): void;
  /** State for a target: pending, stale-pending (≥ PENDING_STALE_MS), or none. */
  stateOf(target: PendingTarget, nowMs: number): "pending" | "not-reflected" | null;
  /** Stop tracking a target (user dismissed the not-reflected marker). */
  dismiss(target: PendingTarget): void;
  /** Signal bumped on every change (re-renders subscribed components). */
  readonly version: Signal<number>;
}

/** Stable map key for a target. */
export function targetKey(t: PendingTarget): string {
  return t.kind === "alert" ? `alert:${t.fingerprint}` : `silence:${t.silenceId}`;
}

/**
 * Predicates: when each action counts as reflected in the payload. Refinement: an alert absent from the payload has resolved and its ack
 * auto-cleared, so set-ack counts as reflected. Otherwise the marker could never clear. This is not
 * a faked state: nothing is displayed as acked.
 */
export const predicates = {
  ackSet: (fingerprint: string, at: string) => (p: AlertsPayload): boolean => {
    const a = p.alerts.find((x) => x.fingerprint === fingerprint);
    return a === undefined || a.ack?.at === at;
  },
  ackRemoved: (fingerprint: string) => (p: AlertsPayload): boolean =>
    p.alerts.find((x) => x.fingerprint === fingerprint)?.ack === undefined,
  silenceCreated: (silenceId: string) => (p: AlertsPayload): boolean => p.silences.some((s) => s.id === silenceId),
  silenceExpired: (silenceId: string) => (p: AlertsPayload): boolean => !p.silences.some((s) => s.id === silenceId),
} as const;

/**
 * Create a tracker. Entry `since` is monotonic (performance.now). `schedule` bumps `version` when an
 * entry crosses PENDING_STALE_MS, so the badge text changes without new data arriving.
 */
export function createPendingTracker(
  schedule: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
): PendingTracker {
  const entries = new Map<string, PendingEntry>();
  const version: Signal<number> = signal(0);
  const bump = (): void => {
    version.value = version.peek() + 1;
  };
  return {
    add(entry) {
      entries.set(targetKey(entry.target), entry); // a newer action on the same target replaces the old expectation
      bump();
      schedule(bump, PENDING_STALE_MS + 1);
    },
    observe(payload) {
      let changed = false;
      for (const [k, e] of entries) {
        if (e.reflected(payload)) {
          entries.delete(k);
          changed = true;
        }
      }
      if (changed) bump();
    },
    stateOf(target, nowMs) {
      const e = entries.get(targetKey(target));
      if (e === undefined) return null;
      return nowMs - e.since >= PENDING_STALE_MS ? "not-reflected" : "pending";
    },
    dismiss(target) {
      if (entries.delete(targetKey(target))) bump();
    },
    version,
  };
}

/** App singleton. Read `pendingTracker.version.value` in render to subscribe. */
export const pendingTracker: PendingTracker = createPendingTracker();

const OBSERVED = new WeakSet<AppStore>();
/**
 * Feed the tracker from the alerts payload signal (store.alerts). This is idempotent per store. It is
 * installed from the same mount effects as ensureSession, so no Shell edit is needed. The effect lives
 * for the page, like the store.
 */
export function installPendingObserver(store: AppStore, tracker: PendingTracker = pendingTracker): void {
  if (OBSERVED.has(store)) return;
  OBSERVED.add(store);
  effect(() => {
    const p = store.alerts.value;
    if (p !== null) tracker.observe(p);
  });
}
