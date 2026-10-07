// overview-freshness.test.ts — surface state and effective status (04 §5, 00 §11, 08 §4.4).
// Uses a real createAppStore(); connection values mirror what live-state publishes for each
// transition (initial contact, NOT_READY failure, stale window, recovery).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type {
  AvailabilityState,
  CycleObservation,
  SourceId,
  SourceObservation,
  TargetStatus,
  TargetStatusEvidence,
  ViewDeliveryState,
} from "@pulse/web-data/wire";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import type { ConnectionState } from "../src/client/store/types.js";
import {
  deriveOverviewSurfaceState,
  effectiveStatus,
  OVERVIEW_LOADING_MESSAGE,
  OVERVIEW_UNAVAILABLE_MESSAGE,
} from "../src/client/views/overview/freshness.js";
import { cycleInstant, fixtureHostId, makeOverviewSnapshot, withTargetStatus } from "./fixtures/overview/factory.js";

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

const T1 = Date.parse(cycleInstant(1));
const T2 = Date.parse(cycleInstant(2));
const T3 = Date.parse(cycleInstant(3));

function observation(seq: number): CycleObservation {
  const at = cycleInstant(seq);
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = { state: "current", lastAttemptAt: at, lastSuccess: at };
  return { generation: "11111111-1111-4111-8111-111111111111", seq, observedAt: at, appVersion: "0.0.0-dev", sources };
}

function freshStore(): AppStore {
  return createAppStore({ storage: null, initialQuery: {} });
}

/** Replace the connection value, overriding the overview delivery state when given. */
function setConnection(
  store: AppStore,
  over: Partial<Omit<ConnectionState, "views">>,
  overview?: ViewDeliveryState,
): void {
  const prev = store.connection.peek();
  store.connection.value = {
    ...prev,
    ...over,
    views: overview === undefined ? prev.views : { ...prev.views, overview },
  };
}

const CURRENT_A: ViewDeliveryState = { phase: "current", identity: "sha256:aaaa" as ViewDeliveryState["identity"], failure: null };
const STALE_A: ViewDeliveryState = { phase: "stale", identity: "sha256:aaaa" as ViewDeliveryState["identity"], failure: null };
const CURRENT_B: ViewDeliveryState = { phase: "current", identity: "sha256:bbbb" as ViewDeliveryState["identity"], failure: null };

describe("deriveOverviewSurfaceState — no accepted snapshot", () => {
  test("initial store is loading with the not-ready copy", () => {
    const state = deriveOverviewSurfaceState(freshStore());
    expect(state).toEqual({ status: "loading", message: OVERVIEW_LOADING_MESSAGE });
  });

  test("NOT_READY responses (failing, never contacted) stay loading — never healthy synthesis", () => {
    const store = freshStore();
    // live-state: an error result sets failingSince; phase stays "initial" with no contact.
    setConnection(store, { failingSince: T1 });
    expect(deriveOverviewSurfaceState(store).status).toBe("loading");
  });

  test("live control channel still awaiting the first overview body is loading", () => {
    const store = freshStore();
    setConnection(store, { phase: "live", lastGoodAt: T1, observation: observation(1), failingSince: T1 });
    expect(deriveOverviewSurfaceState(store).status).toBe("loading");
  });

  test("delivery failing past the stale window with no payload is unavailable and retryable", () => {
    const store = freshStore();
    setConnection(store, { phase: "stale", lastGoodAt: T1, observation: observation(1), failingSince: T1 });
    expect(deriveOverviewSurfaceState(store)).toEqual({
      status: "unavailable",
      message: OVERVIEW_UNAVAILABLE_MESSAGE,
      retryable: true,
    });
  });

  test("an unknown connection phase fails closed to unavailable", () => {
    const store = freshStore();
    setConnection(store, { phase: "bogus" as ConnectionState["phase"] });
    expect(deriveOverviewSurfaceState(store).status).toBe("unavailable");
  });

  test("unavailable → first delivery recovers to ready", () => {
    const store = freshStore();
    setConnection(store, { phase: "stale", lastGoodAt: T1, failingSince: T1 });
    expect(deriveOverviewSurfaceState(store).status).toBe("unavailable");

    const snapshot = makeOverviewSnapshot({ cycle: 2 });
    store.snapshot.value = snapshot;
    setConnection(store, { phase: "live", lastGoodAt: T2, failingSince: null, observation: observation(2) }, CURRENT_A);
    const state = deriveOverviewSurfaceState(store);
    expect(state).toEqual({ status: "ready", snapshot, stale: false });
  });
});

describe("deriveOverviewSurfaceState — accepted snapshot", () => {
  function readyStore(): AppStore {
    const store = freshStore();
    store.snapshot.value = makeOverviewSnapshot({ cycle: 1 });
    setConnection(store, { phase: "live", lastGoodAt: T1, seq: 1, observation: observation(1) }, CURRENT_A);
    return store;
  }

  test("current delivery on a live connection is ready with the accepted snapshot", () => {
    const store = readyStore();
    const state = deriveOverviewSurfaceState(store);
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("unreachable");
    expect(state.snapshot).toBe(store.snapshot.value!);
    expect(state.stale).toBe(false);
  });

  test("identity advanced without a new body → stale, retaining the snapshot and lastGoodAt", () => {
    const store = readyStore();
    const retained = store.snapshot.value!;
    setConnection(store, { observation: observation(2), lastGoodAt: T2 }, STALE_A);
    const state = deriveOverviewSurfaceState(store);
    expect(state).toEqual({ status: "stale", snapshot: retained, stale: true, lastGoodAt: T2 });
    if (state.status !== "stale") throw new Error("unreachable");
    expect(state.snapshot).toBe(retained);
  });

  test("transport failing past the stale window → stale with the last-good contact time", () => {
    const store = readyStore();
    setConnection(store, { phase: "stale", failingSince: T2 }, STALE_A);
    const state = deriveOverviewSurfaceState(store);
    expect(state.status).toBe("stale");
    if (state.status !== "stale") throw new Error("unreachable");
    expect(state.lastGoodAt).toBe(T1);
  });

  test("a stale connection overrides a current overview delivery", () => {
    const store = readyStore();
    setConnection(store, { phase: "stale" });
    expect(deriveOverviewSurfaceState(store).status).toBe("stale");
  });

  test("a missing observation cannot establish freshness", () => {
    const store = readyStore();
    setConnection(store, { observation: null });
    expect(deriveOverviewSurfaceState(store).status).toBe("stale");
  });

  test("initial connection/delivery with a snapshot present never upgrades to ready", () => {
    const store = freshStore();
    store.snapshot.value = makeOverviewSnapshot();
    const state = deriveOverviewSurfaceState(store);
    expect(state).toEqual({ status: "stale", snapshot: store.snapshot.value, stale: true, lastGoodAt: null });
  });

  test("an unknown delivery phase fails closed to stale", () => {
    const store = readyStore();
    setConnection(store, {}, { phase: "bogus" as ViewDeliveryState["phase"], identity: null, failure: null });
    expect(deriveOverviewSurfaceState(store).status).toBe("stale");
  });

  test("stale retained → reconnect with a new body → ready on the new snapshot", () => {
    const store = readyStore();
    setConnection(store, { phase: "stale", failingSince: T2 }, STALE_A);
    expect(deriveOverviewSurfaceState(store).status).toBe("stale");

    const next = withTargetStatus(makeOverviewSnapshot({ cycle: 3 }), fixtureHostId(0), "warning", 3);
    store.snapshot.value = next;
    setConnection(store, { phase: "live", failingSince: null, lastGoodAt: T3, observation: observation(3) }, CURRENT_B);
    const state = deriveOverviewSurfaceState(store);
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("unreachable");
    expect(state.snapshot).toBe(next);
  });

  test("stale → reconnect with a 304 (same identity current again) → ready on the retained snapshot", () => {
    const store = readyStore();
    const retained = store.snapshot.value!;
    setConnection(store, { phase: "stale", failingSince: T2 }, STALE_A);
    setConnection(store, { phase: "live", failingSince: null, lastGoodAt: T3, observation: observation(3) }, CURRENT_A);
    const state = deriveOverviewSurfaceState(store);
    expect(state).toEqual({ status: "ready", snapshot: retained, stale: false });
  });
});

describe("effectiveStatus", () => {
  const STATUSES: readonly TargetStatus[] = ["ok", "warning", "critical", "unknown", "suppressed"];
  const STATES: readonly AvailabilityState[] = ["current", "stale", "unavailable", "not-configured"];

  function evidence(status: TargetStatus, state: AvailabilityState): TargetStatusEvidence {
    return {
      status,
      availability: {
        state,
        source: "victoriametrics-targets",
        lastGoodAt: state === "current" ? null : cycleInstant(1),
        message: state === "current" ? null : "Source is not current.",
      },
    };
  }

  for (const status of STATUSES) {
    for (const state of STATES) {
      const expected: TargetStatus =
        status === "suppressed" ? "suppressed" : state === "current" ? status : "unknown";
      test(`${status} with ${state} evidence → ${expected}`, () => {
        expect(effectiveStatus(evidence(status, state))).toBe(expected);
      });
    }
  }

  test("stale or unavailable evidence never yields ok", () => {
    for (const status of STATUSES) {
      for (const state of STATES.filter((s) => s !== "current")) {
        expect(effectiveStatus(evidence(status, state))).not.toBe("ok");
      }
    }
  });

  test("an unknown availability state or status fails closed to unknown", () => {
    const badState = { ...evidence("ok", "current"), availability: { ...evidence("ok", "current").availability, state: "bogus" as AvailabilityState } };
    expect(effectiveStatus(badState)).toBe("unknown");
    expect(effectiveStatus(evidence("bogus" as TargetStatus, "current"))).toBe("unknown");
  });

  test("applies to fixture targets: ok with stale evidence renders unknown, suppressed stays", () => {
    const snapshot = makeOverviewSnapshot({
      availability: { state: "stale", source: "victoriametrics-targets", lastGoodAt: cycleInstant(1), message: "stale" },
    });
    for (const host of snapshot.hosts) {
      const effective = effectiveStatus(host.statusEvidence);
      expect(effective).toBe(host.statusEvidence.status === "suppressed" ? "suppressed" : "unknown");
    }
  });
});

describe("freshness.ts module boundaries", () => {
  const source = readFileSync(new URL("../src/client/views/overview/freshness.ts", import.meta.url), "utf8");

  test("imports no React or signals module and never fetches", () => {
    expect(source).not.toMatch(/from\s+["'](react|@preact\/signals)/);
    expect(source).not.toMatch(/\.tsx["']/);
    expect(source).not.toMatch(/\bfetch\s*\(|apiFetch|EventSource|XMLHttpRequest/);
    expect(source).not.toMatch(/setTimeout|setInterval|Date\.now/);
  });
});
