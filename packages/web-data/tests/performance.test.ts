// packages/web-data/tests/performance.test.ts — history latency method for item 058
// (07-history-service.md, 11-testing-strategy.md §§6, 10).
//
// Warms the cache, then times ≥100 repeated cache-hit samples with monotonic `performance.now()`
// and asserts p95 < 250 ms, printing method/Bun/host-class/count/p95. Separately proves a
// non-returning miss resolves as SOURCE_TIMEOUT by five *simulated* seconds using an injected
// clock + fake deadline timer (no real sleeps). Package test files are not typechecked.

import { describe, expect, test } from "bun:test";

import { createHistoryService } from "../src/history/service.js";
import type { WebEstateModelV2 } from "@pulse/renderer";

// ── deterministic clock + fake deadline timer ─────────────────────────────────────────────────

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
    advance(ms: number): void {
      now += ms;
      for (const t of timers) {
        if (!t.done && t.at <= now) {
          t.done = true;
          t.cb();
        }
      }
    },
    pending: (): number => timers.filter((t) => !t.done).length,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

// ── VM / Gatus mocks ──────────────────────────────────────────────────────────────────────────

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

const gatus = {
  endpointStatuses: async () => ({ ok: true, data: [] }),
  endpointHistory: async () => ({ ok: true, data: { key: "e", results: [] } }),
};

function prov(): WebEstateModelV2["hosts"][number]["provenance"] {
  return { file: "estate.yml", path: "hosts[0]", line: 1, col: 1 };
}

function model(): WebEstateModelV2 {
  return {
    formatVersion: 2,
    bundleId: "sha256:bundle-perf",
    estate: {
      name: "perf",
      domains: ["example.com"],
      timezone: "America/Chicago",
      dnsResolver: null,
      retention: null,
      schemaMajor: 1,
      deadman: { configured: true, kind: "plain" },
    },
    hosts: [
      {
        name: "host0",
        collectionClass: "managed-linux",
        addresses: ["10.0.0.1"],
        suppressed: null,
        drilldownId: "host:host0",
        expectedChurn: false,
        scrapeIntervalClass: null,
        provenance: prov(),
        scrapeTargets: [{ job: "node", instance: "10.0.0.1:9100" }],
        artifacts: [],
        detail: { exporterPorts: [9100], cadvisor: false, heartbeat: true, deliveryForm: "compose", commandSignals: [] },
      },
    ],
    services: [],
    channels: [],
    routingOverrides: [],
    suppressions: [],
  } as WebEstateModelV2;
}

const hostReq = { queryId: "host.load.1m", target: { kind: "host", id: "host:host0" }, range: "1h" };

/** p95 of a sample array (nearest-rank on the sorted samples). */
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

// ── cache-hit latency (warm samples, monotonic time, printed methodology) ─────────────────────────

describe("history cache-hit latency (11 §§6, 10)", () => {
  test("warmed repeated cache hits: ≥100 samples, monotonic p95 < 250 ms, printed method", async () => {
    // Fixed clock so every hit stays inside the 60 s TTL; measurement uses real monotonic time.
    const clock = 1_000_000;
    const { vm } = makeVm();
    const svc = createHistoryService({
      vm: vm as never,
      gatus: gatus as never,
      model: () => model(),
      now: () => clock,
    });

    // Warm-up: the first identical query is a miss that populates the cache.
    const warm = await svc.query(hostReq as never);
    expect(warm.ok && warm.delivery).toBe("miss");

    const SAMPLE_COUNT = 200;
    const samples: number[] = [];
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const start = performance.now();
      const r = await svc.query(hostReq as never);
      samples.push(performance.now() - start);
      expect(r.ok && r.delivery).toBe("hit"); // served from cache, no upstream call
    }

    const p = p95(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] method=history-cache-hit bun=${Bun.version} host=${process.platform}/${process.arch} ` +
        `count=${SAMPLE_COUNT} p95=${p.toFixed(3)}ms`,
    );

    expect(samples.length).toBe(SAMPLE_COUNT);
    expect(p).toBeLessThan(250); // fast-path goal
    // No extra upstream work happened during the hit phase (warm-up issued exactly one).
    expect((svc.stats() as { cachedKeys: number }).cachedKeys).toBe(1);
    svc.close();
  });
});

// ── five-second non-returning miss (injected time, no real sleep) ─────────────────────────────────

describe("history non-returning miss resolves by five simulated seconds (11 §6)", () => {
  test("an upstream that never returns resolves SOURCE_TIMEOUT exactly at the 5 s deadline", async () => {
    const timers = makeTimers();
    const { vm, state } = makeVm();
    state.mode = "manual"; // queryRange never resolves on its own
    const svc = createHistoryService({
      vm: vm as never,
      gatus: gatus as never,
      model: () => model(),
      now: timers.now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const p = svc.query(hostReq as never);
    expect(state.calls).toBe(1);
    expect(svc.stats().active).toBe(1);

    timers.advance(4_999);
    expect(svc.stats().active).toBe(1); // not yet due — no real sleep occurred

    timers.advance(1); // reach the simulated 5_000 ms deadline
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("SOURCE_TIMEOUT");
      expect(r.error.message).toBe("The history request exceeded its deadline.");
    }
    // The forwarded upstream signal was aborted by the deadline.
    expect(state.pending[0]!.signal?.aborted).toBe(true);
    await flush();
    svc.close();
  });
});
