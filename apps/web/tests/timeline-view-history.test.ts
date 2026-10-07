// Pure unit tests for the shared history client and the persistent-staleness predicate
// (02 §2–§6.1, 08 §3.2). No DOM, no React: the DOM cases live in timeline-view-history-dom.test.ts.

import { afterEach, describe, expect, test } from "bun:test";

import {
  HISTORY_CONCURRENCY,
  LIVE_REFRESH_MS,
  classifyFailure,
  createRequestQueue,
  fetchHistory,
  historyUrl,
} from "../src/client/views/_shared/timeseries/history/client.js";
import type { HistoryFailureKind, HistoryRequest } from "../src/client/views/_shared/timeseries/history/client.js";
import { isNotCurrent } from "../src/client/views/_shared/timeseries/history/freshness.js";
import { REFRESH_INTERVAL_MS } from "../src/shared/constants.js";
import {
  envelope,
  installHistoryStub,
  makeAlertHistory,
  makeEndpointHistory,
  makeSeriesHistory,
} from "./timeline-fixtures.js";

type Stub = ReturnType<typeof installHistoryStub>;

let stub: Stub | null = null;

/** Install the /api/history stub for one test; restored in afterEach. */
function install(routes: Parameters<typeof installHistoryStub>[0]): Stub {
  stub = installHistoryStub(routes);
  return stub;
}

afterEach(() => {
  stub?.restore();
  stub = null;
});

/** Flush pending microtasks and zero-delay replies. */
async function flush(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

/** A promise controlled from outside. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the promise to reject");
}

const HOST = { kind: "host", id: "host:web01" } as const;

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

describe("constants", () => {
  test("REQ-SCALE-01: HISTORY_CONCURRENCY is 4", () => {
    expect(HISTORY_CONCURRENCY).toBe(4);
  });
  test("REQ-FOLLOW-01: LIVE_REFRESH_MS is 60 000", () => {
    expect(LIVE_REFRESH_MS).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------------------------
// historyUrl
// ---------------------------------------------------------------------------------------------

describe("historyUrl", () => {
  test("REQ-SEC-01: alerts URL is exactly /api/history/alerts?range=24h", () => {
    expect(historyUrl({ op: "alerts", range: "24h" })).toBe("/api/history/alerts?range=24h");
  });

  test("REQ-SEC-01: estate URL is exactly /api/history/estate/engine.active-series?range=6h", () => {
    expect(historyUrl({ op: "estate", queryId: "engine.active-series", range: "6h" })).toBe(
      "/api/history/estate/engine.active-series?range=6h",
    );
  });

  test("REQ-SEC-04: target URL encodes the drilldown id and query id as separate segments", () => {
    expect(historyUrl({ op: "target", target: HOST, queryId: "host.cpu.utilization", range: "1h" })).toBe(
      `/api/history/target/${encodeURIComponent("host:web01")}/host.cpu.utilization?range=1h`,
    );
    expect(historyUrl({ op: "target", target: HOST, queryId: "host.cpu.utilization", range: "1h" })).toBe(
      "/api/history/target/host%3Aweb01/host.cpu.utilization?range=1h",
    );
  });

  test("REQ-SEC-04: checks URL encodes the endpoint key", () => {
    expect(historyUrl({ op: "checks", endpoint: "web01/nginx", range: "24h" })).toBe(
      "/api/history/checks/web01%2Fnginx?range=24h",
    );
  });

  test("REQ-SEC-04: an id containing '/', '?', '#' or '%' stays inside one percent-encoded segment", () => {
    const hostile = "a/b?c=1#d%2Fe&range=7d";
    const targetUrl = historyUrl({
      op: "target",
      target: { kind: "service", id: hostile },
      queryId: "estate.liveness",
      range: "1h",
    });
    const checksUrl = historyUrl({ op: "checks", endpoint: hostile, range: "1h" });
    for (const url of [targetUrl, checksUrl]) {
      expect(url).not.toContain("#");
      const parsed = new URL(url, "http://pulse.invalid");
      expect(parsed.hash).toBe("");
      expect([...parsed.searchParams.keys()]).toEqual(["range"]);
      expect(parsed.searchParams.get("range")).toBe("1h");
      expect(parsed.pathname).toContain(encodeURIComponent(hostile));
    }
    // Segment count is unchanged by the hostile id: target has 5 segments, checks has 4.
    expect(new URL(targetUrl, "http://pulse.invalid").pathname.split("/").filter(Boolean)).toHaveLength(5);
    expect(new URL(checksUrl, "http://pulse.invalid").pathname.split("/").filter(Boolean)).toHaveLength(4);
    const segments = new URL(targetUrl, "http://pulse.invalid").pathname.split("/").filter(Boolean);
    expect(decodeURIComponent(segments[3] ?? "")).toBe(hostile);
  });

  test("REQ-SEC-01: no URL has any query key other than range, and none carries end", () => {
    const requests: readonly HistoryRequest[] = [
      { op: "alerts", range: "1h" },
      { op: "estate", queryId: "engine.ingestion-rate", range: "7d" },
      { op: "target", target: HOST, queryId: "host.load.1m", range: "24h" },
      { op: "checks", endpoint: "abc", range: "6h" },
    ];
    for (const r of requests) {
      const url = historyUrl(r);
      const parsed = new URL(url, "http://pulse.invalid");
      expect([...parsed.searchParams.keys()]).toEqual(["range"]);
      expect(url).not.toContain("end=");
      expect(url.startsWith("/api/history/")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// fetchHistory
// ---------------------------------------------------------------------------------------------

describe("fetchHistory", () => {
  const signal = (): AbortSignal => new AbortController().signal;

  test("REQ-SEC-01: a matching alerts body at 200 gives ok:true and sends only the curated URL", async () => {
    const body = makeAlertHistory("24h", []);
    const s = install([{ path: "/api/history/alerts", reply: { status: 200, body } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out).toEqual({ ok: true, data: body });
    expect(s.calls).toEqual(["/api/history/alerts?range=24h"]);
  });

  test("REQ-HISTERR-01: a matching body at a non-200 status still gives ok:true", async () => {
    const body = makeSeriesHistory("engine.active-series", "6h");
    install([{ path: "/api/history/estate/", reply: { status: 503, body } }]);
    const out = await fetchHistory({ op: "estate", queryId: "engine.active-series", range: "6h" }, signal());
    expect(out.ok).toBe(true);
  });

  test("REQ-HISTERR-01: a matching checks body gives ok:true", async () => {
    const body = makeEndpointHistory("abc");
    install([{ path: "/api/history/checks/", reply: { status: 200, body } }]);
    const out = await fetchHistory({ op: "checks", endpoint: "abc", range: "24h" }, signal());
    expect(out).toEqual({ ok: true, data: body });
  });

  test("REQ-HISTERR-01: a matching target body gives ok:true", async () => {
    const body = makeSeriesHistory("host.cpu.utilization", "1h", { target: HOST });
    install([{ path: "/api/history/target/", reply: { status: 200, body } }]);
    const out = await fetchHistory({ op: "target", target: HOST, queryId: "host.cpu.utilization", range: "1h" }, signal());
    expect(out.ok).toBe(true);
  });

  test("REQ-HISTERR-01: an estate body for a different queryId is not a success", async () => {
    const body = makeSeriesHistory("engine.ingestion-rate", "6h");
    install([{ path: "/api/history/estate/", reply: { status: 200, body } }]);
    const out = await fetchHistory({ op: "estate", queryId: "engine.active-series", range: "6h" }, signal());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure).toEqual({ kind: "unexpected", code: "NETWORK", retryable: true, retryAfterSeconds: null });
  });

  test("REQ-HISTERR-01: a target body for a different queryId is not a success", async () => {
    const body = makeSeriesHistory("host.memory.utilization", "1h", { target: HOST });
    install([{ path: "/api/history/target/", reply: { status: 200, body } }]);
    const out = await fetchHistory({ op: "target", target: HOST, queryId: "host.cpu.utilization", range: "1h" }, signal());
    expect(out.ok).toBe(false);
  });

  test("REQ-HISTERR-01: an alerts request answered with an endpoint body is not a success", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 200, body: makeEndpointHistory("abc") } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out.ok).toBe(false);
  });

  test("REQ-HISTERR-01: an error envelope at 200 gives the classified failure", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 200, body: envelope("SOURCE_TIMEOUT") } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out).toEqual({
      ok: false,
      failure: { kind: "timeout", code: "SOURCE_TIMEOUT", retryable: true, retryAfterSeconds: null },
    });
  });

  test("REQ-HISTERR-01: an error envelope at 5xx gives the classified failure", async () => {
    install([{ path: "/api/history/estate/", reply: { status: 502, body: envelope("SOURCE_UNAVAILABLE") } }]);
    const out = await fetchHistory({ op: "estate", queryId: "engine.active-series", range: "6h" }, signal());
    expect(out).toEqual({
      ok: false,
      failure: { kind: "unavailable", code: "SOURCE_UNAVAILABLE", retryable: true, retryAfterSeconds: null },
    });
  });

  test("REQ-HISTERR-03: HISTORY_OVERLOADED with retry-after: 1 gives retryAfterSeconds 1", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 503, body: envelope("HISTORY_OVERLOADED"), retryAfter: 1 } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out).toEqual({
      ok: false,
      failure: { kind: "overloaded", code: "HISTORY_OVERLOADED", retryable: true, retryAfterSeconds: 1 },
    });
  });

  test("REQ-HISTERR-03: HISTORY_OVERLOADED without retry-after gives retryAfterSeconds null", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 503, body: envelope("HISTORY_OVERLOADED") } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(!out.ok && out.failure.retryAfterSeconds).toBeNull();
  });

  test("REQ-HISTERR-03: retry-after on another code gives retryAfterSeconds null", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 504, body: envelope("SOURCE_TIMEOUT"), retryAfter: 1 } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.failure.retryAfterSeconds).toBeNull();
  });

  test("REQ-HISTERR-01: a garbage JSON body (neither payload nor envelope) gives unexpected/NETWORK", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 200, body: "<html>bad gateway</html>" } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out).toEqual({
      ok: false,
      failure: { kind: "unexpected", code: "NETWORK", retryable: true, retryAfterSeconds: null },
    });
  });

  test("REQ-HISTERR-01: a non-JSON body (proxy HTML 502) gives unexpected/NETWORK", async () => {
    const s = install([{ path: "/api/history/alerts", reply: { status: 502, body: null } }]);
    // Route through the stub, then swap the JSON reply for an HTML body the way a proxy would.
    const viaStub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await viaStub(input, init);
      return new Response("<html>502 Bad Gateway</html>", { status: res.status, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out).toEqual({
      ok: false,
      failure: { kind: "unexpected", code: "NETWORK", retryable: true, retryAfterSeconds: null },
    });
    expect(s.calls).toEqual(["/api/history/alerts?range=24h"]);
  });

  test("REQ-HISTERR-01: a fetch rejection gives unexpected/NETWORK", async () => {
    install([{ path: "/api/history/alerts", reply: { network: true } }]);
    const out = await fetchHistory({ op: "alerts", range: "24h" }, signal());
    expect(out).toEqual({
      ok: false,
      failure: { kind: "unexpected", code: "NETWORK", retryable: true, retryAfterSeconds: null },
    });
  });

  test("PRD §7: aborting before the request rejects with AbortError and never resolves to a failure", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 200, body: makeAlertHistory("24h", []) } }]);
    const ac = new AbortController();
    ac.abort();
    const err = await rejectionOf(fetchHistory({ op: "alerts", range: "24h" }, ac.signal));
    expect((err as { name?: unknown }).name).toBe("AbortError");
    expect(err).toBeInstanceOf(DOMException);
  });

  test("PRD §7: aborting while the response is pending rejects with AbortError", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 200, body: makeAlertHistory("24h", []) }, delayMs: 20 }]);
    const ac = new AbortController();
    const p = fetchHistory({ op: "alerts", range: "24h" }, ac.signal);
    ac.abort();
    const err = await rejectionOf(p);
    expect((err as { name?: unknown }).name).toBe("AbortError");
  });

  test("PRD §7: aborting after the response arrives rejects with AbortError (late body dropped)", async () => {
    install([{ path: "/api/history/alerts", reply: { status: 503, body: envelope("SOURCE_TIMEOUT") } }]);
    const ac = new AbortController();
    const viaStub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await viaStub(input, init);
      ac.abort(); // the response has arrived; the caller cancels before the body is consumed
      return res;
    }) as typeof fetch;
    const err = await rejectionOf(fetchHistory({ op: "alerts", range: "24h" }, ac.signal));
    expect((err as { name?: unknown }).name).toBe("AbortError");
  });

  test("REQ-SEC-01: fetchHistory reads globalThis.fetch at call time", async () => {
    const first = install([{ path: "/api/history/alerts", reply: { status: 200, body: makeAlertHistory("1h", []) } }]);
    await fetchHistory({ op: "alerts", range: "1h" }, signal());
    first.restore();
    const second = install([{ path: "/api/history/alerts", reply: { status: 200, body: makeAlertHistory("6h", []) } }]);
    await fetchHistory({ op: "alerts", range: "6h" }, signal());
    expect(first.calls).toEqual(["/api/history/alerts?range=1h"]);
    expect(second.calls).toEqual(["/api/history/alerts?range=6h"]);
  });
});

// ---------------------------------------------------------------------------------------------
// classifyFailure — one named test per 02 §4 row
// ---------------------------------------------------------------------------------------------

describe("classifyFailure", () => {
  const cases: readonly (readonly [code: string, kind: HistoryFailureKind, retryable: boolean, req: string])[] = [
    ["HISTORY_OVERLOADED", "overloaded", true, "REQ-HISTERR-03"],
    ["SOURCE_TIMEOUT", "timeout", true, "REQ-HISTERR-01"],
    ["SOURCE_UNAVAILABLE", "unavailable", true, "REQ-HISTERR-01"],
    ["HISTORY_LIMIT_EXCEEDED", "too-many", false, "REQ-SCALE-03"],
    ["QUERY_NOT_APPLICABLE", "not-applicable", false, "REQ-HISTERR-01"],
    ["RANGE_UNSUPPORTED", "not-applicable", false, "REQ-HISTERR-01"],
    ["TARGET_NOT_FOUND", "not-applicable", false, "REQ-HISTERR-01"],
    ["MODEL_CHANGED", "superseded", true, "REQ-HISTERR-03"],
    ["HISTORY_CANCELLED", "superseded", true, "REQ-HISTERR-03"],
    ["NOT_READY", "not-ready", true, "REQ-HISTERR-01"],
    ["NETWORK", "unexpected", true, "REQ-HISTERR-01"],
    ["INVALID_REQUEST", "unexpected", true, "REQ-HISTERR-01"],
    ["QUERY_NOT_FOUND", "unexpected", true, "REQ-HISTERR-01"],
    ["INTERNAL_ERROR", "unexpected", true, "REQ-HISTERR-01"],
    ["CYCLE_BUILD_FAILED", "unexpected", true, "REQ-HISTERR-01"],
    ["ESTATE_BUNDLE_MISSING", "unexpected", true, "REQ-HISTERR-01"],
    ["ESTATE_BUNDLE_UNREADABLE", "unexpected", true, "REQ-HISTERR-01"],
    ["ESTATE_BUNDLE_UNPARSEABLE", "unexpected", true, "REQ-HISTERR-01"],
    ["ESTATE_BUNDLE_VERSION", "unexpected", true, "REQ-HISTERR-01"],
    ["ESTATE_BUNDLE_STRUCTURE", "unexpected", true, "REQ-HISTERR-01"],
    ["ESTATE_BUNDLE_INCOHERENT", "unexpected", true, "REQ-HISTERR-01"],
    ["API_NOT_FOUND", "unexpected", true, "REQ-HISTERR-01"],
    ["METHOD_NOT_ALLOWED", "unexpected", true, "REQ-HISTERR-01"],
    ["SOMETHING_NEW", "unexpected", true, "REQ-HISTERR-01"],
  ];

  for (const [code, kind, retryable, req] of cases) {
    test(`${req}: ${code} → ${kind}, retryable ${String(retryable)}`, () => {
      expect(classifyFailure(code, null)).toEqual({ kind, code, retryable, retryAfterSeconds: null });
    });
  }

  test("REQ-SCALE-03: HISTORY_LIMIT_EXCEEDED gives too-many and is never retryable", () => {
    const f = classifyFailure("HISTORY_LIMIT_EXCEEDED", 5);
    expect(f.kind).toBe("too-many");
    expect(f.retryable).toBe(false);
    expect(f.retryAfterSeconds).toBeNull();
  });

  test("REQ-HISTERR-03: retryAfterSeconds is kept only for overloaded", () => {
    expect(classifyFailure("HISTORY_OVERLOADED", 1).retryAfterSeconds).toBe(1);
    for (const [code, kind] of cases) {
      if (kind !== "overloaded") expect(classifyFailure(code, 1).retryAfterSeconds).toBeNull();
    }
  });

  test("REQ-HISTERR-03: retryable is false only for too-many and not-applicable", () => {
    for (const [code] of cases) {
      const f = classifyFailure(code, null);
      expect(f.retryable).toBe(f.kind !== "too-many" && f.kind !== "not-applicable");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// createRequestQueue
// ---------------------------------------------------------------------------------------------

describe("createRequestQueue", () => {
  test("REQ-SCALE-01: with 6 fetch tasks, active and inFlight never exceed 4", async () => {
    const s = install([
      { path: "/api/history/estate/", reply: { status: 200, body: makeSeriesHistory("engine.active-series", "6h") }, delayMs: 5 },
    ]);
    const queue = createRequestQueue(4);
    let maxActive = 0;
    let maxInFlight = 0;
    const sample = (): void => {
      maxActive = Math.max(maxActive, queue.active);
      maxInFlight = Math.max(maxInFlight, s.inFlight());
    };
    const runs = Array.from({ length: 6 }, () => {
      const ac = new AbortController();
      return queue.run(0, ac.signal, async (sig) => {
        sample();
        const p = fetchHistory({ op: "estate", queryId: "engine.active-series", range: "6h" }, sig);
        sample();
        const out = await p;
        sample();
        return out;
      });
    });
    sample();
    expect(queue.active).toBe(4);
    expect(queue.queued).toBe(2);
    const outs = await Promise.all(runs);
    expect(outs.every((o) => o.ok)).toBe(true);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxActive).toBe(4);
    expect(s.calls).toHaveLength(6);
    expect(queue.active).toBe(0);
    expect(queue.queued).toBe(0);
  });

  test("REQ-SCALE-01: priority 0 submitted after priority 2 starts first", async () => {
    const queue = createRequestQueue(4);
    const gates = Array.from({ length: 4 }, () => deferred());
    const order: string[] = [];
    const sig = new AbortController().signal;
    const blockers = gates.map((g, i) => queue.run(1, sig, async () => {
      order.push(`block${i}`);
      await g.promise;
    }));
    const low = queue.run(2, sig, async () => { order.push("p2"); });
    const high = queue.run(0, sig, async () => { order.push("p0"); });
    expect(queue.queued).toBe(2);
    gates[0]?.resolve();
    await flush();
    expect(order.slice(4)).toEqual(["p0", "p2"]);
    for (const g of gates) g.resolve();
    await Promise.all([...blockers, low, high]);
  });

  test("REQ-SCALE-01: equal priorities run FIFO", async () => {
    const queue = createRequestQueue(4);
    const gates = Array.from({ length: 4 }, () => deferred());
    const order: string[] = [];
    const sig = new AbortController().signal;
    const blockers = gates.map((g) => queue.run(1, sig, () => g.promise));
    const hold = deferred();
    const a = queue.run(1, sig, async () => { order.push("a"); await hold.promise; });
    const b = queue.run(1, sig, async () => { order.push("b"); await hold.promise; });
    const c = queue.run(1, sig, async () => { order.push("c"); await hold.promise; });
    gates[0]?.resolve();
    await flush();
    expect(order).toEqual(["a"]);
    gates[1]?.resolve();
    await flush();
    expect(order).toEqual(["a", "b"]);
    for (const g of gates) g.resolve();
    await flush();
    expect(order).toEqual(["a", "b", "c"]);
    hold.resolve();
    await Promise.all([...blockers, a, b, c]);
  });

  test("PRD §7: aborting a queued entry rejects with AbortError and never runs the task", async () => {
    const queue = createRequestQueue(4);
    const gates = Array.from({ length: 4 }, () => deferred());
    const sig = new AbortController().signal;
    const blockers = gates.map((g) => queue.run(0, sig, () => g.promise));
    const ac = new AbortController();
    let ran = false;
    const queued = queue.run(0, ac.signal, async () => { ran = true; });
    expect(queue.queued).toBe(1);
    ac.abort();
    const err = await rejectionOf(queued);
    expect((err as { name?: unknown }).name).toBe("AbortError");
    expect(queue.queued).toBe(0);
    expect(queue.active).toBe(4);
    for (const g of gates) g.resolve();
    await Promise.all(blockers);
    await flush();
    expect(ran).toBe(false);
    expect(queue.active).toBe(0);
  });

  test("PRD §7: an already-aborted signal rejects immediately and never runs the task", async () => {
    const queue = createRequestQueue(4);
    const ac = new AbortController();
    ac.abort();
    let ran = false;
    const err = await rejectionOf(queue.run(0, ac.signal, async () => { ran = true; }));
    expect((err as { name?: unknown }).name).toBe("AbortError");
    expect(ran).toBe(false);
    expect(queue.active).toBe(0);
  });

  test("REQ-SCALE-01: aborting a running entry frees its slot for the next one", async () => {
    const s = install([
      { path: "/api/history/estate/", reply: { status: 200, body: makeSeriesHistory("engine.active-series", "6h") }, delayMs: 30 },
    ]);
    const queue = createRequestQueue(4);
    const controllers = Array.from({ length: 5 }, () => new AbortController());
    const started: number[] = [];
    const runs = controllers.map((ac, i) =>
      queue.run(0, ac.signal, (sig) => {
        started.push(i);
        return fetchHistory({ op: "estate", queryId: "engine.active-series", range: "6h" }, sig);
      }),
    );
    expect(started).toEqual([0, 1, 2, 3]);
    expect(s.inFlight()).toBe(4);
    controllers[0]?.abort();
    const err = await rejectionOf(runs[0] as Promise<unknown>);
    expect((err as { name?: unknown }).name).toBe("AbortError");
    await flush(1);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(queue.active).toBe(4);
    expect(s.inFlight()).toBeLessThanOrEqual(4);
    await Promise.all(runs.slice(1));
    expect(queue.active).toBe(0);
  });

  test("REQ-SCALE-01: a synchronously throwing task frees its slot", async () => {
    const queue = createRequestQueue(1);
    const sig = new AbortController().signal;
    const boom = new Error("boom");
    const thrower = queue.run(0, sig, (): Promise<void> => {
      throw boom;
    });
    let ran = false;
    const next = queue.run(0, sig, async () => { ran = true; });
    expect(await rejectionOf(thrower)).toBe(boom);
    await next;
    expect(ran).toBe(true);
    expect(queue.active).toBe(0);
  });

  test("REQ-SCALE-01: a synchronously throwing task frees its slot in a full queue of 4", async () => {
    const queue = createRequestQueue(4);
    const gates = Array.from({ length: 3 }, () => deferred());
    const sig = new AbortController().signal;
    const blockers = gates.map((g) => queue.run(0, sig, () => g.promise));
    const thrower = queue.run(0, sig, (): Promise<void> => {
      throw new Error("sync");
    });
    let ran = false;
    const next = queue.run(0, sig, async () => { ran = true; });
    await rejectionOf(thrower);
    await next;
    expect(ran).toBe(true);
    expect(queue.active).toBe(3);
    for (const g of gates) g.resolve();
    await Promise.all(blockers);
  });

  test("REQ-SCALE-01: a rejecting task passes its error through and frees its slot", async () => {
    const queue = createRequestQueue(1);
    const sig = new AbortController().signal;
    const err = new Error("async");
    expect(await rejectionOf(queue.run(0, sig, async () => { throw err; }))).toBe(err);
    expect(await queue.run(0, sig, async () => 7)).toBe(7);
    expect(queue.active).toBe(0);
  });

  test("REQ-SCALE-01: abort listeners are removed once an entry starts", async () => {
    const queue = createRequestQueue(1);
    const ac = new AbortController();
    const added: string[] = [];
    const removed: string[] = [];
    const sig = ac.signal;
    const origAdd = sig.addEventListener.bind(sig);
    const origRemove = sig.removeEventListener.bind(sig);
    sig.addEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: AddEventListenerOptions | boolean) => {
      added.push(type);
      expect(typeof o === "object" && o.once === true).toBe(true);
      origAdd(type, l, o);
    }) as typeof sig.addEventListener;
    sig.removeEventListener = ((type: string, l: EventListenerOrEventListenerObject, o?: EventListenerOptions | boolean) => {
      removed.push(type);
      origRemove(type, l, o);
    }) as typeof sig.removeEventListener;
    await queue.run(0, sig, async () => 1);
    expect(added).toEqual(["abort"]);
    expect(removed).toEqual(["abort"]);
  });

  test("REQ-SCALE-01: createRequestQueue(0) and other non-positive-integer limits throw RangeError", () => {
    expect(() => createRequestQueue(0)).toThrow(RangeError);
    expect(() => createRequestQueue(-1)).toThrow(RangeError);
    expect(() => createRequestQueue(1.5)).toThrow(RangeError);
    expect(() => createRequestQueue(Number.NaN)).toThrow(RangeError);
    expect(createRequestQueue().active).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// isNotCurrent
// ---------------------------------------------------------------------------------------------

describe("isNotCurrent", () => {
  const NOW = 1_790_251_200_000;

  test("REQ-EFRESH-02: connection stale gives true", () => {
    expect(isNotCurrent({ connectionPhase: "stale", viewPhase: "current", viewStaleSinceMs: null, nowMs: NOW })).toBe(true);
  });

  test("REQ-EFRESH-02: view stale for exactly 10 000 ms gives false", () => {
    expect(REFRESH_INTERVAL_MS).toBe(10_000);
    expect(isNotCurrent({ connectionPhase: "live", viewPhase: "stale", viewStaleSinceMs: NOW - 10_000, nowMs: NOW })).toBe(false);
  });

  test("REQ-EFRESH-02: view stale for 10 001 ms gives true", () => {
    expect(isNotCurrent({ connectionPhase: "live", viewPhase: "stale", viewStaleSinceMs: NOW - 10_001, nowMs: NOW })).toBe(true);
  });

  test("REQ-EFRESH-02: view stale with viewStaleSinceMs null gives false", () => {
    expect(isNotCurrent({ connectionPhase: "live", viewPhase: "stale", viewStaleSinceMs: null, nowMs: NOW })).toBe(false);
  });

  test("REQ-EFRESH-02: view current or initial with connection live gives false", () => {
    expect(isNotCurrent({ connectionPhase: "live", viewPhase: "current", viewStaleSinceMs: null, nowMs: NOW })).toBe(false);
    expect(isNotCurrent({ connectionPhase: "live", viewPhase: "initial", viewStaleSinceMs: null, nowMs: NOW })).toBe(false);
  });

  test("REQ-EFRESH-02: negative elapsed time (clock skew) counts as current", () => {
    expect(isNotCurrent({ connectionPhase: "initial", viewPhase: "stale", viewStaleSinceMs: NOW + 60_000, nowMs: NOW })).toBe(false);
  });
});
