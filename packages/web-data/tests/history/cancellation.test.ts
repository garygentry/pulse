// packages/web-data/tests/history/cancellation.test.ts — evidence for the history service's
// lifecycle behavior (item 027, 07-history-service.md §§5–8, 11): the five-second total
// deadline covering queue plus execution with real upstream/body abort, single- vs
// last-waiter cancellation, model invalidation, and idempotent close with exact
// timer/waiter/slot/byte teardown. Deterministic injected clock + fake deadline timer; no
// real timers. Package test files are not typechecked, so mocks implement only what the
// service calls.

import { describe, expect, test } from "bun:test";

import { createHistoryService } from "../../src/history/service.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

// --- deterministic clock + fake deadline timer ----------------------------

function makeTimers() {
  let now = 0;
  interface FakeTimer {
    readonly id: number;
    readonly at: number;
    readonly cb: () => void;
    done: boolean;
  }
  const timers: FakeTimer[] = [];
  let nextId = 1;
  const setTimer = ((cb: () => void, delay = 0): number => {
    const id = nextId;
    nextId += 1;
    timers.push({ id, at: now + delay, cb, done: false });
    return id;
  }) as unknown as typeof setTimeout;
  const clearTimer = ((handle: unknown): void => {
    const t = timers.find((x) => x.id === handle);
    if (t !== undefined) t.done = true;
  }) as unknown as typeof clearTimeout;
  return {
    now: () => now,
    setTimer,
    clearTimer,
    /** Advance the clock, firing every timer whose deadline is now due in scheduled order. */
    advance(ms: number): void {
      now += ms;
      for (const t of timers) {
        if (!t.done && t.at <= now) {
          t.done = true;
          t.cb();
        }
      }
    },
    /** Armed (neither fired nor cleared) timers — must return to zero after cleanup. */
    pending: (): number => timers.filter((t) => !t.done).length,
  };
}

/** Flush enough microtask turns for a run's settle chain (run.then → settleWork) to complete. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

// --- deferred VM/Gatus mocks ----------------------------------------------

interface Pending {
  resolve: (r: unknown) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal | undefined;
  aborted: boolean;
}

function makeVm() {
  const pending: Pending[] = [];
  let calls = 0;
  const state = {
    mode: "manual" as "immediate" | "manual",
    /** When true, an aborted signal rejects the pending upstream (client abort-through-body). */
    abortAware: false,
    result: { ok: true, data: { series: [] as unknown[] } } as unknown,
    get calls() {
      return calls;
    },
    pending,
  };
  const vm = {
    statusSignals: async () => ({ ok: true, data: [] }),
    targets: async () => ({ ok: true, data: [] }),
    buildInfo: async () => ({ ok: true, data: {} }),
    queryRange: (_req: unknown, opts?: { signal?: AbortSignal }) => {
      calls += 1;
      if (state.mode === "immediate") return Promise.resolve(state.result);
      const signal = opts?.signal;
      return new Promise((resolve, reject) => {
        const entry: Pending = { resolve, reject, signal, aborted: false };
        pending.push(entry);
        if (signal !== undefined) {
          signal.addEventListener(
            "abort",
            () => {
              entry.aborted = true;
              if (state.abortAware) reject(new Error("aborted"));
            },
            { once: true },
          );
        }
      });
    },
  };
  return { vm, state };
}

function makeGatus() {
  return {
    endpointStatuses: async () => ({ ok: true, data: [] }),
    endpointHistory: async () => ({ ok: true, data: { key: "e", results: [] } }),
  };
}

// --- model factory ---------------------------------------------------------

function prov(): WebEstateModelV2["hosts"][number]["provenance"] {
  return { file: "estate.yml", path: "hosts[0]", line: 1, col: 1 };
}

function host(n: number): WebEstateModelV2["hosts"][number] {
  return {
    name: `host${n}`,
    collectionClass: "managed-linux",
    addresses: [`10.0.0.${n}`],
    suppressed: null,
    drilldownId: `host:host${n}`,
    expectedChurn: false,
    scrapeIntervalClass: null,
    provenance: prov(),
    scrapeTargets: [{ job: "node", instance: `10.0.0.${n}:9100` }],
    artifacts: [],
    detail: { exporterPorts: [9100], cadvisor: false, heartbeat: true, deliveryForm: "compose", commandSignals: [] },
  };
}

function model(hostCount = 40): WebEstateModelV2 {
  const hosts = Array.from({ length: hostCount }, (_, i) => host(i));
  return {
    formatVersion: 2,
    bundleId: "sha256:bundle-1",
    estate: {
      name: "home",
      domains: ["example.com"],
      timezone: "America/New_York",
      dnsResolver: null,
      retention: null,
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts,
    services: [],
    channels: [],
    routingOverrides: [],
    suppressions: [],
  } as WebEstateModelV2;
}

function service() {
  const timers = makeTimers();
  const { vm, state } = makeVm();
  const svc = createHistoryService({
    vm: vm as never,
    gatus: makeGatus() as never,
    model: () => model(),
    now: timers.now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return { svc, vm: state, timers };
}

const hostReq = (n: number, range = "1h") => ({ queryId: "host.load.1m", target: { kind: "host", id: `host:host${n}` }, range });

// --- criterion 1: five-second total deadline + upstream abort --------------

describe("five-second total deadline (criterion 1)", () => {
  test("active queue-plus-fetch work resolves SOURCE_TIMEOUT at five seconds and aborts upstream", async () => {
    const { svc, vm, timers } = service();
    const p = svc.query(hostReq(0) as never);
    expect(vm.calls).toBe(1);
    expect(svc.stats().active).toBe(1);

    timers.advance(4_999);
    expect(svc.stats().active).toBe(1); // not yet due
    expect(vm.pending[0]!.aborted).toBe(false);

    timers.advance(1); // reach the 5_000 ms deadline
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SOURCE_TIMEOUT");
      expect(r.error.message).toBe("The history request exceeded its deadline.");
    }
    // Abort reached the forwarded upstream signal (the client forwards it to fetch + body reader).
    expect(vm.pending[0]!.aborted).toBe(true);
    // Join eligibility removed and every waiter resolved by the deadline...
    expect(svc.stats().inFlightKeys).toBe(0);
    expect(svc.stats().waiters).toBe(0);
    // ...but the active slot stays charged until the ignored run's own cleanup settles.
    expect(svc.stats().active).toBe(1);

    // When the ignored run finally settles, the slot releases and nothing is cached.
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    await flush();
    expect(svc.stats().active).toBe(0);
    expect(svc.stats().cachedKeys).toBe(0);
    expect(timers.pending()).toBe(0);
  });

  test("active work that succeeds before the deadline resolves success by five seconds and clears the timer", async () => {
    const { svc, vm, timers } = service();
    const p = svc.query(hostReq(0) as never);
    expect(svc.stats().active).toBe(1);
    expect(timers.pending()).toBe(1); // one armed five-second deadline

    // The upstream fetch/body read completes successfully at t=3000, before the 5s deadline.
    timers.advance(3_000);
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    const r = await p;
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.delivery).toBe("miss");

    // Settling clears the deadline timer (no leak), releases the slot, and caches the success.
    expect(timers.pending()).toBe(0);
    expect(svc.stats().active).toBe(0);
    expect(svc.stats().cachedKeys).toBe(1);
    expect(vm.pending[0]!.aborted).toBe(false); // a successful run is never aborted

    // Advancing past the original deadline fires nothing — the timer was already cleared.
    timers.advance(5_000);
    expect(svc.stats().cachedKeys).toBe(1);
    expect(svc.stats().active).toBe(0);
  });

  test("an abort-aware upstream: the deadline abort reaches the streamed body reader and settles the run", async () => {
    const { svc, vm, timers } = service();
    // The upstream honors abort by rejecting the in-flight promise, modeling the VM client
    // forwarding the composed signal into both fetch and the streamed body reader.
    vm.abortAware = true;
    const p = svc.query(hostReq(0) as never);
    expect(svc.stats().active).toBe(1);

    timers.advance(5_000); // deadline fires → controller.abort() → forwarded upstream signal aborts
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SOURCE_TIMEOUT");
    // The abort reached the forwarded upstream signal (fetch + streamed body reader boundary).
    expect(vm.pending[0]!.aborted).toBe(true);

    // Because the upstream honored the abort (rejected mid fetch/body read), its run settles;
    // the active slot releases with no late cache and every timer returns to zero.
    await flush();
    expect(svc.stats().active).toBe(0);
    expect(svc.stats().cachedKeys).toBe(0);
    expect(svc.stats().inFlightKeys).toBe(0);
    expect(svc.stats().waiters).toBe(0);
    expect(timers.pending()).toBe(0);
  });

  test("the deadline covers queue time: still-queued work times out from its admission instant", async () => {
    const { svc, vm, timers } = service();
    // Saturate the four active slots at t=0.
    for (let i = 0; i < 4; i += 1) svc.query(hostReq(i) as never);
    expect(svc.stats().active).toBe(4);
    // Admit a fifth distinct key at t=1000; it queues with its own deadline at t=6000.
    timers.advance(1_000);
    const queued = svc.query(hostReq(4) as never);
    expect(svc.stats().queued).toBe(1);

    // At t=5000 the four active deadlines fire (ignored, slots stay charged) — the queued item
    // is neither promoted (slots still charged) nor yet due.
    timers.advance(4_000);
    expect(svc.stats().queued).toBe(1);

    // At t=6000 the queued item's own deadline fires while it was queued the entire time.
    timers.advance(1_000);
    const r = await queued;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SOURCE_TIMEOUT");
    expect(svc.stats().queued).toBe(0);
    expect(svc.stats().inFlightKeys).toBe(0);
    void vm;
  });
});

// --- criterion 2: single- vs last-waiter cancellation ----------------------

describe("waiter cancellation (criterion 2)", () => {
  test("one waiter cancel resolves only it and preserves the shared work", async () => {
    const { svc, vm } = service();
    const c1 = new AbortController();
    const a = svc.query({ ...hostReq(0), signal: c1.signal } as never);
    const b = svc.query(hostReq(0) as never); // coalesced onto the same work
    expect(svc.stats().waiters).toBe(2);
    expect(svc.stats().active).toBe(1);
    expect(vm.calls).toBe(1);

    c1.abort();
    const ra = await a;
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.error.code).toBe("HISTORY_CANCELLED");

    // Shared work remains: one waiter, still active/joinable, upstream NOT aborted.
    expect(svc.stats().waiters).toBe(1);
    expect(svc.stats().active).toBe(1);
    expect(svc.stats().inFlightKeys).toBe(1);
    expect(vm.pending[0]!.aborted).toBe(false);

    // The surviving waiter still receives the shared success.
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    const rb = await b;
    expect(rb.ok).toBe(true);
  });

  test("last-waiter cancel removes join eligibility and aborts upstream without releasing the slot early", async () => {
    const { svc, vm } = service();
    const c = new AbortController();
    const a = svc.query({ ...hostReq(0), signal: c.signal } as never);
    expect(svc.stats().active).toBe(1);

    c.abort();
    const ra = await a;
    expect(ra.ok).toBe(false);
    if (!ra.ok) expect(ra.error.code).toBe("HISTORY_CANCELLED");

    // Join eligibility removed, upstream aborted, but the active slot stays charged (the
    // upstream here ignores abort, so its run has not settled).
    expect(svc.stats().inFlightKeys).toBe(0);
    expect(vm.pending[0]!.aborted).toBe(true);
    expect(svc.stats().active).toBe(1);
    expect(svc.stats().waiters).toBe(0);

    // A later identical request cannot join the aborted promise — it creates new work.
    const b = svc.query(hostReq(0) as never);
    void b;
    expect(vm.calls).toBe(2);
    expect(svc.stats().active).toBe(2);

    // When the aborted run finally settles, its slot releases and the ignored late completion
    // never caches; only the new work remains active.
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    await flush();
    expect(svc.stats().active).toBe(1);
    expect(svc.stats().cachedKeys).toBe(0);
  });
});

// --- criterion 3: model invalidation ---------------------------------------

describe("model replacement or loss (criterion 3)", () => {
  test("invalidateModel clears cache, cancels active work with MODEL_CHANGED, and blocks late results", async () => {
    const { svc, vm } = service();
    // Seed a cached success under the current generation.
    vm.mode = "immediate";
    await svc.query(hostReq(0) as never);
    expect(svc.stats().cachedKeys).toBe(1);

    // Start an active in-flight operation under the same generation.
    vm.mode = "manual";
    const a = svc.query(hostReq(1) as never);
    expect(svc.stats().active).toBe(1);

    svc.invalidateModel();
    const ra = await a;
    expect(ra.ok).toBe(false);
    if (!ra.ok) {
      expect(ra.error.code).toBe("MODEL_CHANGED");
      expect(ra.error.message).toBe("The rendered estate changed while history was loading.");
    }
    // Cache cleared synchronously; the active operation's upstream was aborted.
    expect(svc.stats().cachedKeys).toBe(0);
    expect(vm.pending[0]!.aborted).toBe(true);
    expect(svc.stats().inFlightKeys).toBe(0);

    // A late completion from the old generation must neither cache nor resolve anew.
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    await flush();
    expect(svc.stats().cachedKeys).toBe(0);
    expect(svc.stats().active).toBe(0);

    // New work under the new generation is a fresh miss (the old host0 entry is gone).
    vm.mode = "immediate";
    const fresh = await svc.query(hostReq(0) as never);
    expect(fresh.ok && fresh.delivery).toBe("miss");
  });

  test("invalidateModel cancels queued work with MODEL_CHANGED and empties the queue", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    for (let i = 0; i < 4; i += 1) svc.query(hostReq(i) as never); // 4 active
    const queued = svc.query(hostReq(4) as never); // 1 queued
    expect(svc.stats().queued).toBe(1);

    svc.invalidateModel();
    const rq = await queued;
    expect(rq.ok).toBe(false);
    if (!rq.ok) expect(rq.error.code).toBe("MODEL_CHANGED");
    expect(svc.stats().queued).toBe(0);
    expect(svc.stats().inFlightKeys).toBe(0);
  });
});

// --- criterion 4: idempotent close returns everything to zero --------------

describe("idempotent close and full teardown (criterion 4)", () => {
  test("close is idempotent and all maps, listeners, timers, waiters, slots, and bytes reach zero", async () => {
    const { svc, vm, timers } = service();
    // A cached entry, four active operations, and one queued operation.
    vm.mode = "immediate";
    await svc.query(hostReq(0) as never);
    vm.mode = "manual";
    for (let i = 1; i <= 4; i += 1) svc.query(hostReq(i) as never); // hosts 1..4 active
    svc.query(hostReq(5) as never); // queued
    expect(svc.stats().active).toBe(4);
    expect(svc.stats().queued).toBe(1);
    expect(svc.stats().cachedKeys).toBe(1);
    expect(svc.stats().waiters).toBe(5);
    expect(timers.pending()).toBeGreaterThan(0);

    svc.close();
    svc.close(); // idempotent — the second call is a no-op

    // Synchronously after close: waiters resolved, queue emptied, cache cleared, joins gone,
    // and every armed deadline timer cleared.
    const s = svc.stats();
    expect(s.queued).toBe(0);
    expect(s.inFlightKeys).toBe(0);
    expect(s.cachedKeys).toBe(0);
    expect(s.cachedBytes).toBe(0);
    expect(s.waiters).toBe(0);
    expect(timers.pending()).toBe(0);

    // Active slots stay charged until the aborted runs settle; once they do, active → 0.
    for (const p of vm.pending) p.resolve({ ok: true, data: { series: [] } });
    await flush();
    expect(svc.stats().active).toBe(0);

    // Future requests are rejected through result values with HISTORY_CANCELLED.
    const after = await svc.query(hostReq(9) as never);
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.error.code).toBe("HISTORY_CANCELLED");
      expect(after.error.message).toBe("The history request was cancelled.");
    }
  });

  test("a cancelled waiter's abort listener is removed so a post-settle abort is inert", async () => {
    const { svc, vm } = service();
    const c = new AbortController();
    const a = svc.query({ ...hostReq(0), signal: c.signal } as never);
    // Resolve the shared work normally first.
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    const ra = await a;
    expect(ra.ok).toBe(true);
    expect(svc.stats().waiters).toBe(0);
    // Aborting after settlement must not double-resolve or corrupt accounting (listener removed).
    c.abort();
    expect(svc.stats().waiters).toBe(0);
    expect(svc.stats().active).toBe(0);
  });
});
