// packages/web-data/tests/history/limits.test.ts — dedicated evidence for the bounded
// history service's hard limits and deterministic accounting (item 026, 07-history-service.md
// §§4–6, 9). Complements service.test.ts by proving: the global 256-waiter bound and FIFO
// promotion order (criterion 3); the §9 series/sample/label/label-byte limits reject the
// whole operation at boundary+1 and cache nothing while boundary passes (criterion 4); and,
// via direct HistoryCache unit tests, exact 64-entry / 64-MiB LRU accounting with an
// insertion-order tie-break, read-refreshed recency, oversize skipping, and TTL expiry.
// Deterministic injected clock; no real timers. Package test files are not typechecked, so
// mocks implement only what the service calls.

import { describe, expect, test } from "bun:test";

import { createHistoryService } from "../../src/history/service.js";
import { HistoryCache } from "../../src/history/cache.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

// --- deferred VM mock recording each range request ------------------------

function makeVm() {
  const pending: Array<{ resolve: (r: unknown) => void; promql: string; signal?: AbortSignal | undefined }> = [];
  const promqls: string[] = [];
  const state = {
    mode: "immediate" as "immediate" | "manual",
    result: { ok: true, data: { series: [] as unknown[] } } as unknown,
    get calls() {
      return promqls.length;
    },
    promqls,
    pending,
  };
  const vm = {
    statusSignals: async () => ({ ok: true, data: [] }),
    targets: async () => ({ ok: true, data: [] }),
    buildInfo: async () => ({ ok: true, data: {} }),
    queryRange: (req: { promql: string }, opts?: { signal?: AbortSignal }) => {
      promqls.push(req.promql);
      if (state.mode === "immediate") return Promise.resolve(state.result);
      return new Promise((resolve) => pending.push({ resolve, promql: req.promql, signal: opts?.signal }));
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

function service(over: { now?: () => number; hostCount?: number } = {}) {
  const { vm, state } = makeVm();
  const svc = createHistoryService({
    vm: vm as never,
    gatus: makeGatus() as never,
    model: () => model(over.hostCount ?? 40),
    ...(over.now ? { now: over.now } : {}),
  });
  return { svc, vm: state };
}

const hostReq = (n: number, range = "1h") => ({ queryId: "host.load.1m", target: { kind: "host", id: `host:host${n}` }, range });

/** Build a VM range result with `seriesCount` series of `samplesPerSeries` samples and `labelCount` extra labels. */
function rangeResult(opts: { seriesCount: number; samplesPerSeries?: number; labelCount?: number; labelKeyBytes?: number; labelValueBytes?: number }): unknown {
  const samples = Array.from({ length: opts.samplesPerSeries ?? 1 }, (_, i) => ({ timestampMs: 1_000 + i, value: i }));
  const series = Array.from({ length: opts.seriesCount }, (_, s) => {
    const metric: Record<string, string> = { __name__: `node_load1_${s}` };
    if (opts.labelKeyBytes !== undefined) metric["k".repeat(opts.labelKeyBytes)] = "v";
    if (opts.labelValueBytes !== undefined) metric.big = "v".repeat(opts.labelValueBytes);
    for (let l = 0; l < (opts.labelCount ?? 0); l += 1) metric[`label_${l}`] = String(l);
    return { metric, samples };
  });
  return { ok: true, data: { series } };
}

// --- criterion 3: global waiter bound + FIFO promotion --------------------

describe("global waiter bound and FIFO order (criterion 3)", () => {
  test("the global 256-waiter bound overloads a new distinct request", async () => {
    const { svc, vm } = service();
    vm.mode = "manual";
    // Fill four distinct active keys to 64 waiters each = 256 global waiters.
    for (let k = 0; k < 4; k += 1) {
      for (let j = 0; j < 64; j += 1) svc.query(hostReq(k) as never);
    }
    expect(svc.stats().active).toBe(4);
    expect(svc.stats().queued).toBe(0);
    expect(svc.stats().waiters).toBe(256);
    // A new distinct key would otherwise queue, but the global waiter bound is already
    // saturated → explicit overload with retry hint, and no new waiter is allocated.
    const overflow = await svc.query(hostReq(4) as never);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) {
      expect(overflow.error.code).toBe("HISTORY_OVERLOADED");
      expect(overflow.error.retryAfterSeconds).toBe(1);
    }
    expect(svc.stats().waiters).toBe(256);
    expect(svc.stats().queued).toBe(0);
  });

  test("queued work promotes in FIFO order when an active slot frees", async () => {
    const { svc, vm } = service({ hostCount: 10 });
    vm.mode = "manual";
    // Saturate four active slots (hosts 0..3), then queue hosts 4, 5, 6 in order.
    for (let i = 0; i < 4; i += 1) svc.query(hostReq(i) as never);
    for (let i = 4; i < 7; i += 1) svc.query(hostReq(i) as never);
    expect(svc.stats().active).toBe(4);
    expect(svc.stats().queued).toBe(3);
    expect(vm.calls).toBe(4); // queued work has not issued upstream calls

    // Resolve the first active item; the FIFO head (host4) must start next, not host5/6.
    vm.pending[0]!.resolve({ ok: true, data: { series: [] } });
    for (let i = 0; i < 10 && vm.calls < 5; i += 1) await Promise.resolve();
    expect(vm.calls).toBe(5);
    expect(vm.promqls[4]).toContain("10.0.0.4:9100");
    expect(svc.stats().active).toBe(4);
    expect(svc.stats().queued).toBe(2);
  });
});

// --- criterion 4: §9 hard limits reject the whole operation ---------------

describe("§9 series/sample/label limits (criterion 4)", () => {
  async function run(result: unknown) {
    const { svc, vm } = service();
    vm.result = result;
    const r = await svc.query(hostReq(0) as never);
    return { r, svc };
  }

  test("series count passes at 1024 and rejects the whole operation at 1025", async () => {
    const ok = await run(rangeResult({ seriesCount: 1024 }));
    expect(ok.r.ok).toBe(true);
    if (ok.r.ok) expect(ok.r.data.series.length).toBe(1024);
    expect(ok.svc.stats().cachedKeys).toBe(1);

    const over = await run(rangeResult({ seriesCount: 1025 }));
    expect(over.r.ok).toBe(false);
    if (!over.r.ok) expect(over.r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
    expect(over.svc.stats().cachedKeys).toBe(0);
    expect(over.svc.stats().cachedBytes).toBe(0);
  });

  test("samples per series pass at 600 and reject at 601", async () => {
    const ok = await run(rangeResult({ seriesCount: 1, samplesPerSeries: 600 }));
    expect(ok.r.ok).toBe(true);
    expect(ok.svc.stats().cachedKeys).toBe(1);

    const over = await run(rangeResult({ seriesCount: 1, samplesPerSeries: 601 }));
    expect(over.r.ok).toBe(false);
    if (!over.r.ok) expect(over.r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
    expect(over.svc.stats().cachedKeys).toBe(0);
  });

  test("labels per series pass at 32 and reject at 33", async () => {
    // __name__ counts toward the label total, so labelCount 31 → 32 labels, 32 → 33 labels.
    const ok = await run(rangeResult({ seriesCount: 1, labelCount: 31 }));
    expect(ok.r.ok).toBe(true);

    const over = await run(rangeResult({ seriesCount: 1, labelCount: 32 }));
    expect(over.r.ok).toBe(false);
    if (!over.r.ok) expect(over.r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
    expect(over.svc.stats().cachedKeys).toBe(0);
  });

  test("a label key over 128 bytes rejects the whole operation", async () => {
    const ok = await run(rangeResult({ seriesCount: 1, labelKeyBytes: 128 }));
    expect(ok.r.ok).toBe(true);

    const over = await run(rangeResult({ seriesCount: 1, labelKeyBytes: 129 }));
    expect(over.r.ok).toBe(false);
    if (!over.r.ok) expect(over.r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
    expect(over.svc.stats().cachedKeys).toBe(0);
  });

  test("a label value over 256 bytes rejects the whole operation", async () => {
    const ok = await run(rangeResult({ seriesCount: 1, labelValueBytes: 256 }));
    expect(ok.r.ok).toBe(true);

    const over = await run(rangeResult({ seriesCount: 1, labelValueBytes: 257 }));
    expect(over.r.ok).toBe(false);
    if (!over.r.ok) expect(over.r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
    expect(over.svc.stats().cachedKeys).toBe(0);
  });
});

// --- criterion 4: canonical-response 32 MiB bound -------------------------

describe("§9 canonical-response bound (criterion 4)", () => {
  // The "decoded upstream body" 32 MiB bound is enforced by the shared source-fetch primitive
  // and is proven in packages/web-data/tests/sources/fetch.test.ts (streamed overflow → the
  // source result never reaches the service), so it is not re-exercised here. The "canonical
  // response" 32 MiB bound lives in the service's finalizePayload and is unreachable through the
  // numeric-query path (series ≤1024 × samples ≤600 × bounded labels stays well under 32 MiB);
  // the alert-intervals path is the only place it can be hit while the §9 lane/interval
  // cardinality bounds individually pass.
  test("an estate-wide alert result within the lane/interval caps but exceeding 32 MiB canonical rejects wholly and caches nothing", async () => {
    const { svc, vm } = service();
    // 1024 lanes (the lane cap) each with 600 firing intervals (the interval cap): both §9
    // cardinality bounds pass, but the canonical payload is ~65 MiB — well over the 32 MiB
    // response bound. Every lane is unmatched (host "ghost"), so an estate-wide request retains
    // all 1024 and the payload is materialized in full before the bound rejects it.
    const STEP = 60;
    const MS = 1_000_000;
    const seriesInput = Array.from({ length: 1024 }, (_, l) => {
      const samples: Array<{ timestampMs: number; value: number }> = [];
      for (let i = 0; i < 600; i += 1) {
        samples.push({ timestampMs: MS + i * STEP * 2000, value: 1 });
        samples.push({ timestampMs: MS + i * STEP * 2000 + STEP * 1000, value: 0 });
      }
      return { metric: { alertname: `A${l}`, severity: "critical", host: "ghost" }, samples };
    });
    vm.result = { ok: true, data: { series: seriesInput } };

    const r = await svc.alertIntervals({ range: "7d", target: null } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("HISTORY_LIMIT_EXCEEDED");
    // No partial cache: the whole operation was rejected before any cache insertion.
    expect(svc.stats().cachedKeys).toBe(0);
    expect(svc.stats().cachedBytes).toBe(0);
    // Accounting returned to zero (the run settled, releasing its active slot and waiter).
    expect(svc.stats().active).toBe(0);
    expect(svc.stats().waiters).toBe(0);
    expect(svc.stats().inFlightKeys).toBe(0);
  }, 60_000);
});

// --- criterion 4: deterministic 64-entry / 64-MiB LRU accounting ----------

const MIB = 1024 * 1024;
const CACHE_BYTES = 64 * MIB;

describe("HistoryCache deterministic entry/byte accounting (criterion 4)", () => {
  test("byte accounting is exact across insert, replace, and clear", () => {
    const c = new HistoryCache();
    c.set("a", 0, { v: 1 }, 100, 1_000);
    c.set("b", 0, { v: 2 }, 200, 1_000);
    expect(c.stats()).toEqual({ cachedKeys: 2, cachedBytes: 300 });
    // Replacing a key releases its prior charge before charging the new bytes.
    c.set("a", 0, { v: 3 }, 50, 1_000);
    expect(c.stats()).toEqual({ cachedKeys: 2, cachedBytes: 250 });
    c.clear();
    expect(c.stats()).toEqual({ cachedKeys: 0, cachedBytes: 0 });
  });

  test("the 64-entry limit evicts the least-recently-used entry on insert", () => {
    const c = new HistoryCache();
    for (let i = 0; i < 64; i += 1) c.set(`k${i}`, 0, { i }, 1, 1_000 + i);
    expect(c.stats().cachedKeys).toBe(64);
    // Insert a 65th entry: k0 (oldest lastUsed) is evicted, count stays 64.
    c.set("k64", 0, { i: 64 }, 1, 1_100);
    expect(c.stats().cachedKeys).toBe(64);
    expect(c.stats().cachedBytes).toBe(64);
    expect(c.get("k0", 0, 1_200)).toBeNull();
    expect(c.get("k64", 0, 1_200)).toEqual({ i: 64 });
  });

  test("the 64-MiB byte limit evicts LRU entries until the new item fits", () => {
    const c = new HistoryCache();
    c.set("a", 0, { v: "a" }, 40 * MIB, 1_000);
    c.set("b", 0, { v: "b" }, 40 * MIB, 1_001); // 80 MiB > 64 MiB → evict a
    expect(c.stats().cachedKeys).toBe(1);
    expect(c.stats().cachedBytes).toBe(40 * MIB);
    expect(c.get("a", 0, 1_002)).toBeNull();
    expect(c.get("b", 0, 1_002)).toEqual({ v: "b" });
  });

  test("a single item larger than the byte budget is never cached; the exact budget fits", () => {
    const c = new HistoryCache();
    c.set("too-big", 0, { v: 1 }, CACHE_BYTES + 1, 1_000);
    expect(c.stats()).toEqual({ cachedKeys: 0, cachedBytes: 0 });
    c.set("exact", 0, { v: 1 }, CACHE_BYTES, 1_000);
    expect(c.stats()).toEqual({ cachedKeys: 1, cachedBytes: CACHE_BYTES });
  });

  test("eviction breaks equal-recency ties by earliest insertion order", () => {
    const c = new HistoryCache();
    // Three 30-MiB entries inserted at the same instant → equal lastUsedAt.
    c.set("a", 0, { v: "a" }, 30 * MIB, 1_000);
    c.set("b", 0, { v: "b" }, 30 * MIB, 1_000);
    // a + b = 60 MiB fits; inserting c forces eviction. Tie on lastUsedAt → earliest
    // insertionSeq (a) is evicted first.
    c.set("c", 0, { v: "c" }, 30 * MIB, 1_000);
    expect(c.get("a", 0, 1_000)).toBeNull();
    expect(c.get("b", 0, 1_000)).toEqual({ v: "b" });
    expect(c.get("c", 0, 1_000)).toEqual({ v: "c" });
  });

  test("a read refreshes recency so the read entry is not the next victim", () => {
    const c = new HistoryCache();
    c.set("a", 0, { v: "a" }, 30 * MIB, 1_000);
    c.set("b", 0, { v: "b" }, 30 * MIB, 1_001); // b newer than a
    // Read a → its recency advances past b.
    expect(c.get("a", 0, 1_002)).toEqual({ v: "a" });
    // Inserting c must evict the now-least-recently-used entry, which is b (not the read a).
    c.set("c", 0, { v: "c" }, 30 * MIB, 1_003);
    expect(c.get("b", 0, 1_004)).toBeNull();
    expect(c.get("a", 0, 1_004)).toEqual({ v: "a" });
    expect(c.get("c", 0, 1_004)).toEqual({ v: "c" });
  });

  test("entries expire exactly 60 seconds after insert via get and sweep", () => {
    const c = new HistoryCache();
    c.set("a", 0, { v: 1 }, 100, 1_000);
    expect(c.get("a", 0, 1_000 + 59_999)).toEqual({ v: 1 }); // within TTL
    expect(c.get("a", 0, 1_000 + 60_000)).toBeNull(); // at expiry → removed
    expect(c.stats()).toEqual({ cachedKeys: 0, cachedBytes: 0 });

    c.set("b", 0, { v: 2 }, 100, 2_000);
    c.sweepExpired(2_000 + 60_000);
    expect(c.stats()).toEqual({ cachedKeys: 0, cachedBytes: 0 });
  });

  test("a generation mismatch is a miss without disturbing accounting", () => {
    const c = new HistoryCache();
    c.set("a", 5, { v: 1 }, 100, 1_000);
    expect(c.get("a", 6, 1_000)).toBeNull(); // different generation
    expect(c.get("a", 5, 1_000)).toEqual({ v: 1 });
    expect(c.stats()).toEqual({ cachedKeys: 1, cachedBytes: 100 });
  });
});
