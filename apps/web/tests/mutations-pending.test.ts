// mutations-pending.test.ts — pending tracker, predicates and observer (09 §4; 00 §10.2; REQ-UX-01).
import { describe, expect, test } from "bun:test";
import type { AlertsPayload } from "@pulse/web-data/wire";
import {
  createPendingTracker,
  installPendingObserver,
  pendingTracker,
  predicates,
  targetKey,
} from "../src/client/mutations/pending.js";
import type { PendingEntry, PendingTarget, PendingTracker } from "../src/client/mutations/pending.js";
import { createAppStore } from "../src/client/store/index.js";
import { PENDING_STALE_MS } from "../src/shared/mutations.js";
import {
  FIXTURE_ACK,
  FIXTURE_FINGERPRINTS,
  FIXTURE_SILENCE_IDS,
  makeAlertsPayload,
  withAck,
} from "./alerts-fixtures.js";

const FP = FIXTURE_FINGERPRINTS.hostDown;
const ALERT: PendingTarget = { kind: "alert", fingerprint: FP };
const SILENCE: PendingTarget = { kind: "silence", silenceId: "silence-new" };

/** A schedule that records callbacks instead of arming real timers. */
function manualSchedule() {
  const calls: { cb: () => void; ms: number }[] = [];
  const schedule = (cb: () => void, ms: number): void => {
    calls.push({ cb, ms });
  };
  return { calls, schedule };
}

function entry(target: PendingTarget, reflected: PendingEntry["reflected"], since = 1_000): PendingEntry {
  return { target, reflected, since };
}

const MIXED = makeAlertsPayload({ scenario: "mixed" });
const ACKED = withAck(MIXED, [FP]);

describe("targetKey (REQ-UX-01)", () => {
  test("alert and silence targets map to distinct prefixed keys", () => {
    expect(targetKey(ALERT)).toBe(`alert:${FP}`);
    expect(targetKey(SILENCE)).toBe("silence:silence-new");
    expect(targetKey({ kind: "alert", fingerprint: "x" })).not.toBe(targetKey({ kind: "silence", silenceId: "x" }));
  });
});

describe("createPendingTracker lifecycle (REQ-UX-01)", () => {
  test("add → pending; since + PENDING_STALE_MS → not-reflected; just before → pending", () => {
    const { schedule } = manualSchedule();
    const t = createPendingTracker(schedule);
    expect(t.stateOf(ALERT, 1_000)).toBeNull();
    t.add(entry(ALERT, () => false, 1_000));
    expect(t.stateOf(ALERT, 1_000)).toBe("pending");
    expect(t.stateOf(ALERT, 1_000 + PENDING_STALE_MS - 1)).toBe("pending");
    expect(t.stateOf(ALERT, 1_000 + PENDING_STALE_MS)).toBe("not-reflected");
    expect(t.stateOf(SILENCE, 1_000)).toBeNull();
  });

  test("observe with a satisfying payload clears the entry → null", () => {
    const t = createPendingTracker(manualSchedule().schedule);
    t.add(entry(ALERT, predicates.ackSet(FP, FIXTURE_ACK.at)));
    t.observe(MIXED); // not yet acked
    expect(t.stateOf(ALERT, 1_000)).toBe("pending");
    t.observe(ACKED);
    expect(t.stateOf(ALERT, 1_000)).toBeNull();
  });

  test("dismiss → null", () => {
    const t = createPendingTracker(manualSchedule().schedule);
    t.add(entry(ALERT, () => false));
    t.dismiss(ALERT);
    expect(t.stateOf(ALERT, 1_000 + PENDING_STALE_MS)).toBeNull();
  });

  test("add on the same target replaces the earlier expectation", () => {
    const t = createPendingTracker(manualSchedule().schedule);
    t.add(entry(ALERT, () => false, 0));
    t.add(entry(ALERT, () => false, 50_000));
    expect(t.stateOf(ALERT, 50_000 + 1)).toBe("pending");
    t.add(entry(ALERT, () => true, 50_000));
    t.observe(MIXED);
    expect(t.stateOf(ALERT, 50_001)).toBeNull();
  });

  test("version bumps on add, observe-change, dismiss and the scheduled stale bump — not on no-ops", () => {
    const { calls, schedule } = manualSchedule();
    const t = createPendingTracker(schedule);
    expect(t.version.value).toBe(0);

    t.add(entry(ALERT, predicates.ackRemoved(FP)));
    expect(t.version.value).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ms).toBe(PENDING_STALE_MS + 1);

    calls[0]!.cb(); // the stale bump
    expect(t.version.value).toBe(2);

    t.observe(ACKED); // ack still present → no change, no bump
    expect(t.version.value).toBe(2);
    t.observe(MIXED); // ack absent → reflected, one bump
    expect(t.version.value).toBe(3);

    t.dismiss(ALERT); // already gone → no bump
    expect(t.version.value).toBe(3);

    t.add(entry(SILENCE, () => false));
    expect(t.version.value).toBe(4);
    t.dismiss(SILENCE);
    expect(t.version.value).toBe(5);
  });

  test("observe clearing several entries bumps exactly once", () => {
    const t = createPendingTracker(manualSchedule().schedule);
    t.add(entry(ALERT, () => true));
    t.add(entry(SILENCE, () => true));
    const before = t.version.value;
    t.observe(MIXED);
    expect(t.version.value).toBe(before + 1);
  });

  test("the app singleton pendingTracker starts empty", () => {
    expect(pendingTracker.stateOf(ALERT, 0)).toBeNull();
    expect(typeof pendingTracker.version.value).toBe("number");
  });
});

describe("predicates on AlertsPayload fixtures (REQ-UX-01)", () => {
  test("ackSet: true when the ack at matches, false when absent or a different at", () => {
    expect(predicates.ackSet(FP, FIXTURE_ACK.at)(ACKED)).toBe(true);
    expect(predicates.ackSet(FP, FIXTURE_ACK.at)(MIXED)).toBe(false);
    expect(predicates.ackSet(FP, "2026-01-01T00:00:00.000Z")(ACKED)).toBe(false);
  });

  test("ackSet: true when the alert is absent from the payload (resolved → ack auto-cleared)", () => {
    expect(predicates.ackSet("fp-resolved-and-gone", FIXTURE_ACK.at)(MIXED)).toBe(true);
    expect(predicates.ackSet(FP, FIXTURE_ACK.at)(makeAlertsPayload({ scenario: "empty-healthy" }))).toBe(true);
  });

  test("ackRemoved: true when the ack key is absent, false while it is present", () => {
    expect("ack" in MIXED.alerts.find((a) => a.fingerprint === FP)!).toBe(false);
    expect(predicates.ackRemoved(FP)(MIXED)).toBe(true);
    expect(predicates.ackRemoved(FP)(ACKED)).toBe(false);
    expect(predicates.ackRemoved("fp-resolved-and-gone")(ACKED)).toBe(true);
  });

  test("silenceCreated / silenceExpired follow the silences list", () => {
    const id = FIXTURE_SILENCE_IDS.backup;
    expect(MIXED.silences.some((s) => s.id === id)).toBe(true);
    expect(predicates.silenceCreated(id)(MIXED)).toBe(true);
    expect(predicates.silenceExpired(id)(MIXED)).toBe(false);
    expect(predicates.silenceCreated(FIXTURE_SILENCE_IDS.missing)(MIXED)).toBe(false);
    expect(predicates.silenceExpired(FIXTURE_SILENCE_IDS.missing)(MIXED)).toBe(true);
  });
});

describe("installPendingObserver (REQ-UX-01)", () => {
  function spyTracker(): { tracker: PendingTracker; seen: AlertsPayload[] } {
    const inner = createPendingTracker(manualSchedule().schedule);
    const seen: AlertsPayload[] = [];
    return {
      seen,
      tracker: {
        ...inner,
        observe(p) {
          seen.push(p);
          inner.observe(p);
        },
      },
    };
  }

  test("calls observe when store.alerts changes and skips null", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const { tracker, seen } = spyTracker();
    installPendingObserver(store, tracker);
    expect(seen).toHaveLength(0); // initial value is null
    store.alerts.value = MIXED;
    expect(seen).toEqual([MIXED]);
    store.alerts.value = ACKED;
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(ACKED);
  });

  test("is idempotent per store: a second install adds no second observer", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const { tracker, seen } = spyTracker();
    installPendingObserver(store, tracker);
    installPendingObserver(store, tracker);
    store.alerts.value = MIXED;
    expect(seen).toHaveLength(1);

    const other = createAppStore({ storage: null, initialQuery: {} });
    const second = spyTracker();
    installPendingObserver(other, second.tracker);
    other.alerts.value = MIXED;
    expect(second.seen).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  test("never writes store.alerts: value identity is unchanged after the tracker clears entries", () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const tracker = createPendingTracker(manualSchedule().schedule);
    tracker.add(entry(ALERT, predicates.ackSet(FP, FIXTURE_ACK.at)));
    const writes: (AlertsPayload | null)[] = [];
    const unsubscribe = store.alerts.subscribe((v) => writes.push(v));
    installPendingObserver(store, tracker);
    store.alerts.value = ACKED;
    expect(tracker.stateOf(ALERT, 1_000)).toBeNull(); // reflected and cleared
    expect(store.alerts.value).toBe(ACKED);
    expect(writes).toEqual([null, ACKED]); // only the initial value and our own write
    unsubscribe();
  });
});
