// packages/web-data/tests/history/service.test.ts — evidence for the bounded history
// cache/admission/coalescing service (item 025, 07-history-service.md §§1–6, 9). Focused
// on the four item acceptance criteria: binder-first validation with zero allocation,
// coalescing before admission onto one work identity, the 4-active/32-FIFO-queued and
// waiter bounds returning explicit overload, and 60-second success caching with exact
// deterministic entry/byte LRU accounting. Deterministic injected clock; no real timers.
// Package test files are not typechecked, so mocks implement only what the service calls.

import { describe, expect, test } from "bun:test";

import { createHistoryService } from "../../src/history/service.js";
import { canonicalJson } from "../../src/canonical.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

// --- deferred VM/Gatus mocks ----------------------------------------------

function makeVm() {
  const pending: Array<{ resolve: (r: unknown) => void; signal?: AbortSignal | undefined }> = [];
  let calls = 0;
  const state = {
    mode: "immediate" as "immediate" | "manual",
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
      return new Promise((resolve) => pending.push({ resolve, signal: opts?.signal }));
    },
  };
  return { vm, state };
}

function makeGatus() {
  const vm = {
    endpointStatuses: async () => ({ ok: true, data: [] }),
    endpointHistory: async () => ({ ok: true, data: { key: "e", results: [] } }),
  };
  return vm;
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

function service(over: { model?: () => WebEstateModelV2 | null; now?: () => number } = {}) {
  const { vm, state } = makeVm();
  const svc = createHistoryService({
    vm: vm as never,
    gatus: makeGatus() as never,
    model: over.model ?? (() => model()),
    ...(over.now ? { now: over.now } : {}),
  });
  return { svc, vm: state };
}

const hostReq = (n: number, range = "1h") => ({ queryId: "host.load.1m", target: { kind: "host", id: `host:host${n}` }, range });

/** A model whose single service declares one Gatus endpoint key `svc-endpoint`. */
function modelWithEndpoint(): WebEstateModelV2 {
  const base = model(1);
  const svc = {
    name: "portal",
    host: "host0",
    managed: true,
    deepHealth: false,
    suppressed: null,
    drilldownId: "svc:host0/portal",
    kind: "web",
    provenance: prov(),
    gatusEndpoints: ["svc-endpoint"],
    artifacts: [],
    deepHealthDetail: null,
    backupFreshness: null,
    alerts: [],
  } as unknown as WebEstateModelV2["services"][number];
  return { ...base, services: [svc] } as WebEstateModelV2;
}

/** A service backed by a model that declares the `svc-endpoint` Gatus endpoint. */
function serviceWithGatus() {
  return service({ model: () => modelWithEndpoint() });
}

// --- criterion 1: binder-first, zero allocation ---------------------------

describe("validate and bind first (criterion 1)", () => {
  test("null model returns SOURCE_UNAVAILABLE and allocates nothing", async () => {
    const { svc } = service({ model: () => null });
    const r = await svc.query({ queryId: "estate.liveness", target: null, range: "1h" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("SOURCE_UNAVAILABLE");
    expect(svc.stats()).toEqual({ active: 0, queued: 0, inFlightKeys: 0, cachedKeys: 0, cachedBytes: 0, waiters: 0 });
  });

  test("unknown query id returns the exact binder QUERY_NOT_FOUND with no work", async () => {
    const { svc, vm } = service();
    const r = await svc.query({ queryId: "does.not.exist", target: null, range: "1h" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("QUERY_NOT_FOUND");
      expect(r.error.message).toBe("The requested history query does not exist.");
    }
    expect(vm.calls).toBe(0);
    expect(svc.stats().active).toBe(0);
    expect(svc.stats().waiters).toBe(0);
  });

  test("wrong target kind returns QUERY_NOT_APPLICABLE without source work", async () => {
    const { svc, vm } = service();
    const r = await svc.query({ queryId: "host.load.1m", target: { kind: "endpoint", id: "x" }, range: "1h" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("QUERY_NOT_APPLICABLE");
    expect(vm.calls).toBe(0);
  });

  const ZERO_STATS = { active: 0, queued: 0, inFlightKeys: 0, cachedKeys: 0, cachedBytes: 0, waiters: 0 };

  test("a range beyond the query maximum returns RANGE_UNSUPPORTED and allocates nothing", async () => {
    const { svc, vm } = service();
    // host.load.1m maxRange is 24h; 7d exceeds it.
    const r = await svc.query({ queryId: "host.load.1m", target: { kind: "host", id: "host:host0" }, range: "7d" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("RANGE_UNSUPPORTED");
      expect(r.error.message).toBe("The requested range is not supported for this query.");
    }
    expect(vm.calls).toBe(0);
    expect(svc.stats()).toEqual(ZERO_STATS);
  });

  test("a malformed range returns INVALID_REQUEST and allocates nothing", async () => {
    const { svc, vm } = service();
    const r = await svc.query({ queryId: "host.load.1m", target: { kind: "host", id: "host:host0" }, range: "5m" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_REQUEST");
      expect(r.error.message).toBe("The request is invalid.");
    }
    expect(vm.calls).toBe(0);
    expect(svc.stats()).toEqual(ZERO_STATS);
  });

  test("alertIntervals with a malformed range returns the binder INVALID_REQUEST and allocates nothing", async () => {
    const { svc, vm } = service();
    const r = await svc.alertIntervals({ range: "nope", target: null } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    expect(vm.calls).toBe(0);
    expect(svc.stats()).toEqual(ZERO_STATS);
  });

  test("endpointHistory with a control-character key returns INVALID_REQUEST with no admission", async () => {
    const { svc, vm } = service();
    const r = await svc.endpointHistory({ endpoint: "bad\nkey", range: "1h" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    expect(vm.calls).toBe(0);
    expect(svc.stats()).toEqual(ZERO_STATS);
  });

  test("endpointHistory for an unknown endpoint returns TARGET_NOT_FOUND with no admission", async () => {
    const { svc, vm } = service();
    const r = await svc.endpointHistory({ endpoint: "no-such-endpoint", range: "1h" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TARGET_NOT_FOUND");
      expect(r.error.message).toBe("The requested target does not exist.");
    }
    expect(vm.calls).toBe(0);
    expect(svc.stats()).toEqual(ZERO_STATS);
  });
});

// --- criterion 2: coalescing before admission ------------------------------

describe("coalescing before admission (criterion 2)", () => {
  test("two identical active requests share one work identity", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    const a = svc.query(hostReq(0) as never);
    const b = svc.query(hostReq(0) as never);
    // one upstream call, one active slot, one joinable key, two waiters.
    expect(vm.calls).toBe(1);
    expect(svc.stats().active).toBe(1);
    expect(svc.stats().inFlightKeys).toBe(1);
    expect(svc.stats().waiters).toBe(2);
    // resolve the shared work.
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    const deliveries = [ra.ok && ra.delivery, rb.ok && rb.delivery].sort();
    expect(deliveries).toEqual(["coalesced", "miss"]);
    expect(vm.calls).toBe(1);
  });

  test("an identical request coalesces onto queued work without a second queue entry", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    // Saturate the 4 active slots with 4 distinct keys.
    for (let i = 0; i < 4; i += 1) svc.query(hostReq(i) as never);
    expect(svc.stats().active).toBe(4);
    // A 5th distinct key queues; an identical 5th coalesces onto that queued item.
    svc.query(hostReq(4) as never);
    svc.query(hostReq(4) as never);
    expect(svc.stats().queued).toBe(1);
    expect(svc.stats().waiters).toBe(6);
    expect(vm.calls).toBe(4); // queued work has not started
  });

  test("a cache hit short-circuits before any coalescing or admission", async () => {
    let clock = 2_000_000;
    const { svc, vm } = service({ now: () => clock });
    const first = await svc.query(hostReq(0) as never);
    expect(first.ok && first.delivery).toBe("miss");
    expect(vm.calls).toBe(1);
    // A second identical request within the TTL is served from cache — no new source
    // work, no waiter, no active/queued allocation.
    clock += 1;
    const hit = await svc.query(hostReq(0) as never);
    expect(hit.ok && hit.delivery).toBe("hit");
    expect(vm.calls).toBe(1);
    expect(svc.stats().active).toBe(0);
    expect(svc.stats().queued).toBe(0);
    expect(svc.stats().waiters).toBe(0);
    expect(svc.stats().inFlightKeys).toBe(0);
  });

  test("requests that differ only by range are distinct work and do not coalesce", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    const a = svc.query(hostReq(0, "1h") as never);
    const b = svc.query(hostReq(0, "6h") as never);
    void a;
    void b;
    // Two distinct keys → two active slots, two joinable keys, two upstream calls.
    expect(vm.calls).toBe(2);
    expect(svc.stats().active).toBe(2);
    expect(svc.stats().inFlightKeys).toBe(2);
    expect(svc.stats().waiters).toBe(2);
  });

  test("identical endpointHistory requests coalesce onto one work identity", async () => {
    const { svc } = serviceWithGatus();
    const a = svc.endpointHistory({ endpoint: "svc-endpoint", range: "1h" } as never);
    const b = svc.endpointHistory({ endpoint: "svc-endpoint", range: "1h" } as never);
    // Coalesced before admission: one active slot, one joinable key, two waiters.
    expect(svc.stats().active).toBe(1);
    expect(svc.stats().inFlightKeys).toBe(1);
    expect(svc.stats().waiters).toBe(2);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ok && rb.ok).toBe(true);
    expect([ra.ok && ra.delivery, rb.ok && rb.delivery].sort()).toEqual(["coalesced", "miss"]);
  });
});

// --- criterion 3: admission and waiter bounds ------------------------------

describe("admission and waiter bounds (criterion 3)", () => {
  test("four active and thirty-two queued are never exceeded; overflow overloads", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    // 4 active + 32 queued = 36 distinct keys admitted (pending in manual mode; do not await).
    const inflight: Promise<unknown>[] = [];
    for (let i = 0; i < 36; i += 1) inflight.push(svc.query(hostReq(i) as never));
    void inflight;
    expect(svc.stats().active).toBe(4);
    expect(svc.stats().queued).toBe(32);
    // The 37th distinct request overloads explicitly.
    const overflow = await svc.query(hostReq(36) as never);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe("HISTORY_OVERLOADED");
      expect(overflow.error.retryAfterSeconds).toBe(1);
    }
    expect(svc.stats().active).toBe(4);
    expect(svc.stats().queued).toBe(32);
  });

  test("the per-key waiter bound of 64 overloads the 65th coalescing request", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 64; i += 1) pending.push(svc.query(hostReq(0) as never));
    expect(svc.stats().waiters).toBe(64);
    const overflow = await svc.query(hostReq(0) as never);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error.code).toBe("HISTORY_OVERLOADED");
    expect(svc.stats().waiters).toBe(64);
    void pending;
  });
});

// --- criterion 4: caching, TTL, LRU, byte accounting ----------------------

describe("cache TTL and LRU accounting (criterion 4)", () => {
  test("a complete success caches for 60 seconds then expires", async () => {
    let clock = 1_000_000;
    const { svc } = service({ now: () => clock });
    const first = await svc.query(hostReq(0) as never);
    expect(first.ok && first.delivery).toBe("miss");
    expect(svc.stats().cachedKeys).toBe(1);

    clock += 59_999;
    const hit = await svc.query(hostReq(0) as never);
    expect(hit.ok && hit.delivery).toBe("hit");

    clock += 1; // now exactly at expiry (60_000 ms after insert)
    const afterExpiry = await svc.query(hostReq(0) as never);
    expect(afterExpiry.ok && afterExpiry.delivery).toBe("miss");
  });

  test("failures are never cached", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    const p = svc.query(hostReq(0) as never);
    vm.pending[0]!.resolve({ ok: false, error: { kind: "transport", message: "x", status: null } });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(svc.stats().cachedKeys).toBe(0);
    expect(svc.stats().cachedBytes).toBe(0);
  });

  test("byte accounting is exact and single-entry", async () => {
    let clock = 5_000_000;
    const { svc } = service({ now: () => clock });
    const r = await svc.query(hostReq(0) as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const expected = canonicalJson(r.data).byteLength;
      expect(svc.stats().cachedBytes).toBe(expected);
      expect(svc.stats().cachedKeys).toBe(1);
    }
  });

  test("LRU evicts to keep at most 64 entries", async () => {
    let clock = 9_000_000;
    const { svc } = service({ now: () => clock, model: () => model(70) });
    for (let i = 0; i < 64; i += 1) {
      clock += 1; // distinct lastUsed for deterministic LRU
      await svc.query(hostReq(i) as never);
    }
    expect(svc.stats().cachedKeys).toBe(64);
    // Insert a 65th distinct key; oldest (host0) is evicted.
    clock += 1;
    await svc.query(hostReq(64) as never);
    expect(svc.stats().cachedKeys).toBe(64);
    // host0 was the least-recently-used → its next request is a miss, not a hit.
    clock += 1;
    const evicted = await svc.query(hostReq(0) as never);
    expect(evicted.ok && evicted.delivery).toBe("miss");
    // host64 (just inserted) is still cached.
    clock += 1;
    const kept = await svc.query(hostReq(64) as never);
    expect(kept.ok && kept.delivery).toBe("hit");
  });

  test("close and invalidateModel clear the cache and reject/retire work", async () => {
    let clock = 11_000_000;
    const { svc } = service({ now: () => clock });
    await svc.query(hostReq(0) as never);
    expect(svc.stats().cachedKeys).toBe(1);
    svc.invalidateModel();
    expect(svc.stats().cachedKeys).toBe(0);
    // A fresh request under the new generation is a miss (old cache gone).
    const afterInvalidate = await svc.query(hostReq(0) as never);
    expect(afterInvalidate.ok && afterInvalidate.delivery).toBe("miss");
    svc.close();
    const afterClose = await svc.query(hostReq(0) as never);
    expect(afterClose.ok).toBe(false);
    if (!afterClose.ok) expect(afterClose.error.code).toBe("HISTORY_CANCELLED");
  });
});
