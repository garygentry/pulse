// apps/web/tests/timeline-view-history-dom.test.ts — DOM half of the shared history plumbing
// (views/timeline/history/): useNotCurrent, useHistory, HistoryRegion and RegionErrorBoundary.
// Tiny harness components are mounted through dom.mount; every fetch goes through installHistoryStub.
// rAF is routed through a microtask for this file (restored in afterAll), and flushes run inside
// act(), so effects never depend on a real frame or on the faked setTimeout.

import { afterAll, afterEach, beforeAll, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { createElement } from "react";
import { act, render } from "./react-render.js";
import type { ReactNode, ReactElement } from "react";

import type { HistoryPayload } from "@pulse/web-data/wire";
import type { ConnectionPhase } from "../src/client/store/types.js";
import { classifyFailure, createRequestQueue } from "../src/client/views/_shared/timeseries/history/client.js";
import type {
  ClassifiedFailure,
  HistoryFailureKind,
  HistoryRegionState,
  HistoryRequest,
  RequestQueue,
} from "../src/client/views/_shared/timeseries/history/client.js";
import { useNotCurrent } from "../src/client/views/_shared/timeseries/history/freshness.js";
import { historyKey, useHistory } from "../src/client/views/_shared/timeseries/history/use-history.js";
import type { UseHistoryOptions, UseHistoryResult } from "../src/client/views/_shared/timeseries/history/use-history.js";
import { FAILURE_COPY, HistoryRegion, REGION_TEXT } from "../src/client/views/_shared/timeseries/history/region.js";
import { RegionErrorBoundary } from "../src/client/views/_shared/timeseries/history/boundary.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, restoreRealTimers } from "./dom.js";
import { envelope, installHistoryStub, makeSeriesHistory } from "./timeline-fixtures.js";
import type { StubRoute } from "./timeline-fixtures.js";

isolateDomGlobals();

/** `createElement` typed to return a plain element (exactOptionalPropertyTypes rejects ReactElement<P> → ReactElement<{}>). */
const el = createElement as unknown as (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ReactElement;

type Reply = StubRoute["reply"];

const ESTATE_PATH = "/api/history/estate/";
const INGEST: HistoryRequest = { op: "estate", queryId: "engine.ingestion-rate", range: "1h" };
const INGEST_BODY = makeSeriesHistory("engine.ingestion-rate", "1h");
const SERIES_OK: Reply = { status: 200, body: INGEST_BODY };

function failureReply(code: string, status = 503, retryAfter?: number): Reply {
  return { status, body: envelope(code), ...(retryAfter !== undefined ? { retryAfter } : {}) };
}

/** Settle pending microtasks (fetch → json → setState → render → effects). Never uses timers. */
async function flush(rounds = 40): Promise<void> {
  // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  });
}

/** Advance fake timers, then settle the microtasks the fired timers queued. */
async function advance(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flush();
}

let stubRestore: (() => void) | null = null;

/** One installHistoryStub per reply; the n-th fetch (any path) gets reply n, the last one repeats. */
function installSequence(replies: readonly Reply[], delayMs?: number): { readonly calls: string[] } {
  const original = globalThis.fetch;
  const fetchers = replies.map((reply) => {
    const stub = installHistoryStub([{ path: "/api/history", reply, ...(delayMs !== undefined ? { delayMs } : {}) }]);
    const fn = globalThis.fetch;
    stub.restore();
    return fn;
  });
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const fn = fetchers[Math.min(calls.length - 1, fetchers.length - 1)]!;
    return fn(input, init);
  }) as typeof fetch;
  stubRestore = () => {
    globalThis.fetch = original;
  };
  return { calls };
}

function installRoutes(routes: readonly StubRoute[]): ReturnType<typeof installHistoryStub> {
  const stub = installHistoryStub(routes);
  stubRestore = () => stub.restore();
  return stub;
}

// ---------------------------------------------------------------------------------------------
// Harnesses
// ---------------------------------------------------------------------------------------------

interface HistoryProbe {
  readonly states: HistoryRegionState<unknown>[];
  result: UseHistoryResult<unknown> | null;
}

function newProbe(): HistoryProbe {
  return { states: [], result: null };
}

function HistoryHarness(props: {
  readonly request: HistoryRequest | null;
  readonly options: UseHistoryOptions;
  readonly probe: HistoryProbe;
}): ReactElement {
  const r = useHistory(props.request, props.options) as UseHistoryResult<unknown>;
  props.probe.result = r;
  props.probe.states.push(r.state);
  return el("div", { "data-phase": r.state.phase });
}

function harness(request: HistoryRequest | null, opts: UseHistoryOptions, probe: HistoryProbe): ReactElement {
  return el(HistoryHarness, { request, options: opts, probe });
}

let clockMs = 0;
const clock = (): number => clockMs;

function FreshHarness(props: {
  readonly connection: ConnectionPhase;
  readonly view: "initial" | "current" | "stale";
  readonly out: { value: boolean | null };
}): ReactElement {
  const v = useNotCurrent(props.connection, props.view, clock);
  props.out.value = v;
  return el("span", { "data-not-current": String(v) });
}

function currentState(p: HistoryProbe): HistoryRegionState<unknown> {
  return p.result!.state;
}

describeDom("timeline history plumbing (DOM)", (dom) => {
  let queue: RequestQueue;
  const mounted: { unmount(): void }[] = [];

  beforeAll(() => {
  });
  afterAll(() => {
  });
  beforeEach(() => {
    jest.useFakeTimers();
    queue = createRequestQueue(4);
    clockMs = 1_000_000;
  });
  afterEach(() => {
    for (const m of mounted.splice(0)) m.unmount();
    stubRestore?.();
    stubRestore = null;
    restoreRealTimers();
  });

  async function mount(vnode: ReactElement): Promise<{ container: HTMLElement; update(v: ReactElement): Promise<void>; unmount(): void }> {
    const m = await dom.mount(vnode);
    mounted.push(m);
    await flush();
    return {
      container: m.container,
      async update(v: ReactElement): Promise<void> {
        // Inside act() so the effect the update triggers commits its first state (e.g. a refresh's
        // loading phase) before the stubbed fetch settles, as it would against a real network.
        await act(() => render(v, m.container as unknown as Element));
        await flush();
      },
      unmount: () => m.unmount(),
    };
  }

  // -------------------------------------------------------------------------------------------
  // useNotCurrent
  // -------------------------------------------------------------------------------------------

  async function tickClock(ms: number): Promise<void> {
    clockMs += ms;
    await advance(ms);
  }

  test("REQ-EFRESH-02: useNotCurrent stays false through a 5 s stale blip", async () => {
    const out = { value: null as boolean | null };
    const m = await mount(el(FreshHarness, { connection: "live", view: "stale", out }));
    expect(out.value).toBe(false);
    await tickClock(5_000);
    expect(out.value).toBe(false);
    await m.update(el(FreshHarness, { connection: "live", view: "current", out }));
    expect(out.value).toBe(false);
    await tickClock(20_000);
    expect(out.value).toBe(false);
    expect(m.container.querySelector("[data-not-current]")?.getAttribute("data-not-current")).toBe("false");
  });

  test("REQ-EFRESH-02: useNotCurrent flips true once stale passes 10 s, with no store change", async () => {
    const out = { value: null as boolean | null };
    const m = await mount(el(FreshHarness, { connection: "live", view: "stale", out }));
    await tickClock(10_000);
    expect(out.value).toBe(false);
    await tickClock(1);
    expect(out.value).toBe(true);
    expect(m.container.querySelector("[data-not-current]")?.getAttribute("data-not-current")).toBe("true");
  });

  test("REQ-EFRESH-02: useNotCurrent resets when the phase leaves stale and restarts on re-entry", async () => {
    const out = { value: null as boolean | null };
    const m = await mount(el(FreshHarness, { connection: "live", view: "stale", out }));
    await tickClock(10_001);
    expect(out.value).toBe(true);
    await m.update(el(FreshHarness, { connection: "live", view: "current", out }));
    expect(out.value).toBe(false);
    await m.update(el(FreshHarness, { connection: "live", view: "stale", out }));
    expect(out.value).toBe(false);
    await tickClock(5_000);
    expect(out.value).toBe(false);
    await tickClock(5_001);
    expect(out.value).toBe(true);
  });

  test("REQ-EFRESH-02: a stale connection is not current regardless of the view phase", async () => {
    const out = { value: null as boolean | null };
    await mount(el(FreshHarness, { connection: "stale", view: "current", out }));
    expect(out.value).toBe(true);
  });

  test("REQ-EFRESH-02: useNotCurrent clears its timer on phase change and on unmount", async () => {
    const out = { value: null as boolean | null };
    const m = await mount(el(FreshHarness, { connection: "live", view: "stale", out }));
    expect(jest.getTimerCount()).toBe(1);
    await m.update(el(FreshHarness, { connection: "live", view: "current", out }));
    expect(jest.getTimerCount()).toBe(0);
    await m.update(el(FreshHarness, { connection: "live", view: "stale", out }));
    expect(jest.getTimerCount()).toBe(1);
    m.unmount();
    await flush();
    expect(jest.getTimerCount()).toBe(0);
  });

  // -------------------------------------------------------------------------------------------
  // useHistory — key and supersession
  // -------------------------------------------------------------------------------------------

  test("PRD §7: historyKey is the URI-encoded op|target|queryId|range|end|generation", () => {
    const target: HistoryRequest = {
      op: "target",
      target: { kind: "host", id: "web|01/a b" },
      queryId: "host.cpu.utilization",
      range: "6h",
    };
    expect(historyKey(target, 1_790_000_000, "gen|1")).toBe(
      ["target", encodeURIComponent("host:web|01/a b"), "host.cpu.utilization", "6h", "1790000000", encodeURIComponent("gen|1")].join("|"),
    );
    expect(historyKey(INGEST, null, null)).toBe("estate||engine.ingestion-rate|1h||");
    expect(historyKey({ op: "alerts", range: "24h" }, null, "g")).toBe("alerts|||24h||g");
    expect(historyKey({ op: "checks", endpoint: "web01/nginx", range: "1h" }, 5, null)).toBe(
      `checks|${encodeURIComponent("web01/nginx")}||1h|5|`,
    );
  });

  test("PRD §7: useHistory exposes the key and an equal-but-new request object issues no new fetch", async () => {
    const stub = installRoutes([{ path: ESTATE_PATH, reply: SERIES_OK }]);
    const probe = newProbe();
    const opts = { queue, priority: 0 as const, end: 42, generation: "g1" };
    const m = await mount(harness({ ...INGEST }, opts, probe));
    expect(probe.result!.key).toBe(historyKey(INGEST, 42, "g1"));
    expect(currentState(probe)).toEqual({ phase: "ready", data: INGEST_BODY });
    expect(stub.calls).toEqual(["/api/history/estate/engine.ingestion-rate?range=1h"]);
    await m.update(harness({ ...INGEST }, { ...opts }, probe));
    await m.update(harness({ op: "estate", queryId: "engine.ingestion-rate", range: "1h" }, { ...opts }, probe));
    expect(stub.calls.length).toBe(1);
    expect(currentState(probe).phase).toBe("ready");
  });

  test("PRD §7: a key change aborts the old request and its result never changes state", async () => {
    const active = makeSeriesHistory("engine.active-series", "6h");
    const stub = installRoutes([
      { path: `${ESTATE_PATH}engine.ingestion-rate`, reply: SERIES_OK, delayMs: 1_000 },
      { path: `${ESTATE_PATH}engine.active-series`, reply: { status: 200, body: active } },
    ]);
    const probe = newProbe();
    const m = await mount(harness(INGEST, { queue, priority: 0 }, probe));
    expect(stub.inFlight()).toBe(1);
    await m.update(harness({ op: "estate", queryId: "engine.active-series", range: "6h" }, { queue, priority: 0 }, probe));
    expect(stub.inFlight()).toBe(0); // the old request was aborted
    expect(currentState(probe)).toEqual({ phase: "ready", data: active });
    await advance(2_000);
    expect(currentState(probe)).toEqual({ phase: "ready", data: active });
    expect(probe.states.some((s) => s.phase === "error")).toBe(false);
  });

  test("PRD §7: a late response for the old key (transport ignores abort) is discarded", async () => {
    const active = makeSeriesHistory("engine.active-series", "6h");
    installRoutes([
      { path: `${ESTATE_PATH}engine.ingestion-rate`, reply: SERIES_OK, delayMs: 1_000 },
      { path: `${ESTATE_PATH}engine.active-series`, reply: { status: 200, body: active }, delayMs: 100 },
    ]);
    const stubFetch = globalThis.fetch;
    // Drop the signal so the superseded response really arrives late.
    globalThis.fetch = ((input: RequestInfo | URL) => stubFetch(input)) as typeof fetch;
    const probe = newProbe();
    const m = await mount(harness(INGEST, { queue, priority: 0 }, probe));
    await m.update(harness({ op: "estate", queryId: "engine.active-series", range: "6h" }, { queue, priority: 0 }, probe));
    await advance(100);
    expect(currentState(probe)).toEqual({ phase: "ready", data: active });
    const rendered = probe.states.length;
    await advance(1_000); // the old key's response lands now
    expect(currentState(probe)).toEqual({ phase: "ready", data: active });
    expect(probe.states.slice(rendered).every((s) => s.phase === "ready")).toBe(true);
  });

  test("PRD §7: a result that resolves despite the abort (queue ignores the signal) is discarded", async () => {
    const active = makeSeriesHistory("engine.active-series", "6h");
    installRoutes([
      { path: `${ESTATE_PATH}engine.ingestion-rate`, reply: SERIES_OK, delayMs: 1_000 },
      { path: `${ESTATE_PATH}engine.active-series`, reply: { status: 200, body: active }, delayMs: 100 },
    ]);
    // A queue that hands every task a fresh, never-aborted signal: the old fetch resolves with ok:true.
    const leaky: RequestQueue = {
      run: (_priority, _signal, task) => task(new AbortController().signal),
      get active() {
        return 0;
      },
      get queued() {
        return 0;
      },
    };
    const probe = newProbe();
    const m = await mount(harness(INGEST, { queue: leaky, priority: 0 }, probe));
    await m.update(harness({ op: "estate", queryId: "engine.active-series", range: "6h" }, { queue: leaky, priority: 0 }, probe));
    await advance(100);
    expect(currentState(probe)).toEqual({ phase: "ready", data: active });
    await advance(1_000); // the old key's ok:true outcome arrives now
    expect(currentState(probe)).toEqual({ phase: "ready", data: active });
  });

  test("PRD §7: an AbortError (disable, unmount, retry while in flight) never produces an error state", async () => {
    const stub = installRoutes([{ path: ESTATE_PATH, reply: SERIES_OK, delayMs: 1_000 }]);
    const probe = newProbe();
    const m = await mount(harness(INGEST, { queue, priority: 0 }, probe));
    probe.result!.retry(); // aborts the first attempt, starts a second
    await flush();
    await m.update(harness(INGEST, { queue, priority: 0, enabled: false }, probe));
    expect(currentState(probe)).toEqual({ phase: "idle" });
    await m.update(harness(INGEST, { queue, priority: 0 }, probe));
    m.unmount();
    await advance(2_000);
    expect(stub.calls.length).toBe(3);
    expect(stub.inFlight()).toBe(0);
    expect(probe.states.some((s) => s.phase === "error")).toBe(false);
  });

  // -------------------------------------------------------------------------------------------
  // useHistory — retry, retention and refresh
  // -------------------------------------------------------------------------------------------

  test("REQ-HISTERR-03: one MODEL_CHANGED then success goes loading → ready and never renders superseded", async () => {
    const seq = installSequence([failureReply("MODEL_CHANGED", 409), SERIES_OK]);
    const probe = newProbe();
    await mount(harness(INGEST, { queue, priority: 0 }, probe));
    expect(seq.calls.length).toBe(2);
    expect(currentState(probe)).toEqual({ phase: "ready", data: INGEST_BODY });
    expect(probe.states.map((s) => s.phase).filter((p, i, a) => a[i - 1] !== p)).toEqual(["loading", "ready"]);
    expect(probe.states.some((s) => s.phase === "error")).toBe(false);
  });

  test("REQ-HISTERR-03: MODEL_CHANGED twice gives error/superseded after exactly two fetches", async () => {
    const seq = installSequence([failureReply("MODEL_CHANGED", 409), failureReply("MODEL_CHANGED", 409), SERIES_OK]);
    const probe = newProbe();
    await mount(harness(INGEST, { queue, priority: 0 }, probe));
    await advance(5_000);
    expect(seq.calls.length).toBe(2);
    const s = currentState(probe);
    expect(s.phase).toBe("error");
    if (s.phase === "error") {
      expect(s.failure.kind).toBe("superseded");
      expect(s.failure.code).toBe("MODEL_CHANGED");
      expect(s.previous).toBeNull();
    }
  });

  test("REQ-HISTERR-03: retry() re-issues the request and starts a fresh auto-retry episode", async () => {
    const seq = installSequence([
      failureReply("MODEL_CHANGED", 409),
      failureReply("MODEL_CHANGED", 409),
      failureReply("MODEL_CHANGED", 409),
      SERIES_OK,
    ]);
    const probe = newProbe();
    await mount(harness(INGEST, { queue, priority: 0 }, probe));
    expect(currentState(probe).phase).toBe("error");
    probe.result!.retry();
    await flush();
    expect(seq.calls.length).toBe(4);
    expect(currentState(probe)).toEqual({ phase: "ready", data: INGEST_BODY });
  });

  test("REQ-HISTERR-02: a same-identity refresh (new end) that fails keeps previous", async () => {
    installSequence([SERIES_OK, failureReply("HISTORY_OVERLOADED")]);
    const probe = newProbe();
    const m = await mount(harness(INGEST, { queue, priority: 0, end: null }, probe));
    expect(currentState(probe).phase).toBe("ready");
    await m.update(harness(INGEST, { queue, priority: 0, end: 1_790_000_000 }, probe));
    const s = currentState(probe);
    expect(s.phase).toBe("error");
    if (s.phase === "error") {
      expect(s.failure.kind).toBe("overloaded");
      expect(s.previous).toEqual(INGEST_BODY);
    }
    // While the refresh was loading, the previous data was retained (REQ-FOLLOW-03).
    expect(probe.states.some((x) => x.phase === "loading" && x.previous !== null)).toBe(true);
  });

  test("REQ-HISTERR-02: a failure after a range change has previous null", async () => {
    installSequence([SERIES_OK, failureReply("SOURCE_TIMEOUT", 504)]);
    const probe = newProbe();
    const m = await mount(harness(INGEST, { queue, priority: 0 }, probe));
    expect(currentState(probe).phase).toBe("ready");
    await m.update(harness({ ...INGEST, range: "6h" }, { queue, priority: 0 }, probe));
    const s = currentState(probe);
    expect(s.phase).toBe("error");
    if (s.phase === "error") expect(s.previous).toBeNull();
    expect(probe.states.some((x) => x.phase === "loading" && x.previous !== null)).toBe(false);
  });

  test("REQ-HISTERR-04: a too-many failure always has previous null, even for the same identity", async () => {
    installSequence([SERIES_OK, failureReply("HISTORY_LIMIT_EXCEEDED", 502)]);
    const probe = newProbe();
    await mount(harness(INGEST, { queue, priority: 0 }, probe));
    expect(currentState(probe).phase).toBe("ready");
    probe.result!.retry();
    await flush();
    const s = currentState(probe);
    expect(s.phase).toBe("error");
    if (s.phase === "error") {
      expect(s.failure.kind).toBe("too-many");
      expect(s.previous).toBeNull();
    }
  });

  test("REQ-FOLLOW-03: refreshMs re-requests on the interval and stops on unmount", async () => {
    const stub = installRoutes([{ path: ESTATE_PATH, reply: SERIES_OK }]);
    const probe = newProbe();
    const m = await mount(harness(INGEST, { queue, priority: 0, refreshMs: 1_000 }, probe));
    expect(stub.calls.length).toBe(1);
    await advance(1_000);
    expect(stub.calls.length).toBe(2);
    await advance(1_000);
    expect(stub.calls.length).toBe(3);
    expect(currentState(probe).phase).toBe("ready");
    m.unmount();
    await flush();
    await advance(5_000);
    expect(stub.calls.length).toBe(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("REQ-FOLLOW-03: refreshMs skips a tick while a request is in flight", async () => {
    const stub = installRoutes([{ path: ESTATE_PATH, reply: SERIES_OK, delayMs: 2_500 }]);
    const probe = newProbe();
    await mount(harness(INGEST, { queue, priority: 0, refreshMs: 1_000 }, probe));
    expect(stub.calls.length).toBe(1);
    await advance(1_000);
    await advance(1_000);
    expect(stub.calls.length).toBe(1); // ticks at 1 s and 2 s skipped: still in flight
    await advance(500); // the reply lands at 2.5 s
    expect(currentState(probe).phase).toBe("ready");
    expect(stub.calls.length).toBe(1);
    await advance(500); // tick at 3 s
    expect(stub.calls.length).toBe(2);
    expect(stub.inFlight()).toBe(1);
  });

  test("REQ-SCALE-01: enabled:false gives idle and notApplicable gives not-applicable, both with zero fetches", async () => {
    const stub = installRoutes([{ path: ESTATE_PATH, reply: SERIES_OK }]);
    const idle = newProbe();
    await mount(harness(INGEST, { queue, priority: 0, enabled: false }, idle));
    expect(currentState(idle)).toEqual({ phase: "idle" });
    expect(idle.result!.key).toBeNull();
    idle.result!.retry();
    const na = newProbe();
    await mount(harness(INGEST, { queue, priority: 1, notApplicable: "Not available at this range (max 24h)" }, na));
    expect(currentState(na)).toEqual({ phase: "not-applicable", reason: "Not available at this range (max 24h)" });
    expect(na.result!.key).toBeNull();
    na.result!.retry();
    const none = newProbe();
    await mount(harness(null, { queue, priority: 0 }, none));
    expect(currentState(none)).toEqual({ phase: "idle" });
    await advance(1_000);
    expect(stub.calls.length).toBe(0);
  });

  test("REQ-HISTERR-03: retry() re-issues the current request", async () => {
    const stub = installRoutes([{ path: ESTATE_PATH, reply: SERIES_OK }]);
    const probe = newProbe();
    await mount(harness(INGEST, { queue, priority: 0 }, probe));
    expect(stub.calls.length).toBe(1);
    probe.result!.retry();
    await flush();
    expect(stub.calls).toEqual([
      "/api/history/estate/engine.ingestion-rate?range=1h",
      "/api/history/estate/engine.ingestion-rate?range=1h",
    ]);
    expect(currentState(probe).phase).toBe("ready");
  });

  test("REQ-HISTERR-01: a network rejection becomes error/unexpected with code NETWORK", async () => {
    installRoutes([{ path: ESTATE_PATH, reply: { network: true } }]);
    const probe = newProbe();
    await mount(harness(INGEST, { queue, priority: 0 }, probe));
    const s = currentState(probe);
    expect(s.phase).toBe("error");
    if (s.phase === "error") expect(s.failure).toEqual(classifyFailure("NETWORK", null));
  });

  // -------------------------------------------------------------------------------------------
  // HistoryRegion
  // -------------------------------------------------------------------------------------------

  const children = (data: HistoryPayload, stale: boolean): ReactNode =>
    el("div", { className: "probe-child", "data-stale": String(stale) }, data.queryId);

  function region(
    state: HistoryRegionState<HistoryPayload>,
    extra: {
      readonly label?: string;
      readonly onRetry?: () => void;
      readonly onShorterRange?: (() => void) | null;
      readonly idle?: ReactNode;
    } = {},
  ): ReactElement {
    return el(HistoryRegion<HistoryPayload>, { state, label: extra.label ?? "ingestion rate", children, ...omitUndefined(extra) });
  }

  function omitUndefined<T extends object>(o: T): Partial<T> {
    return Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k !== "label")) as Partial<T>;
  }

  function section(c: HTMLElement): HTMLElement {
    const s = c.querySelector("section[data-slot=history-region]");
    if (s === null) throw new Error("no region section");
    return s as HTMLElement;
  }

  /** The region's Retry button ("Retry" or "Retry in Ns"), or null. */
  function retryButton(s: ParentNode): HTMLButtonElement | null {
    return [...s.querySelectorAll("button")].find((b) => /^Retry\b/.test(b.textContent ?? "")) ?? null;
  }

  /** The region's "Try a shorter range" button, or null. */
  function shorterButton(s: ParentNode): HTMLButtonElement | null {
    return [...s.querySelectorAll("button")].find((b) => b.textContent === "Try a shorter range") ?? null;
  }

  /** Title text of the region's EmptyState (its first paragraph). */
  function emptyTitle(s: ParentNode): string | null | undefined {
    return s.querySelector("[data-slot=empty-state] p")?.textContent;
  }

  const CODE_FOR_KIND: Readonly<Record<HistoryFailureKind, string>> = {
    overloaded: "HISTORY_OVERLOADED",
    timeout: "SOURCE_TIMEOUT",
    unavailable: "SOURCE_UNAVAILABLE",
    "too-many": "HISTORY_LIMIT_EXCEEDED",
    "not-applicable": "QUERY_NOT_APPLICABLE",
    superseded: "MODEL_CHANGED",
    "not-ready": "NOT_READY",
    unexpected: "SOMETHING_NEW",
  };
  const KINDS = Object.keys(CODE_FOR_KIND) as HistoryFailureKind[];

  function failure(kind: HistoryFailureKind, retryAfterSeconds: number | null = null): ClassifiedFailure {
    return classifyFailure(CODE_FOR_KIND[kind], retryAfterSeconds);
  }

  const stalePayload: HistoryPayload = { ...INGEST_BODY, stale: true };

  test("REQ-HISTERR-01: FAILURE_COPY and REGION_TEXT carry the exact strings", () => {
    expect(FAILURE_COPY).toEqual({
      overloaded: "History service is busy.",
      timeout: "History query timed out.",
      unavailable: "Metrics source unavailable.",
      "too-many": "Too many lanes/series for this range — try a shorter range.",
      "not-applicable": "Not applicable to this target/range.",
      superseded: "Estate model changed — history could not be reloaded.",
      "not-ready": "Engine starting — history not ready yet.",
      unexpected: "Unexpected error loading history.",
    });
    expect(REGION_TEXT.stalePrevious).toBe("Stale — showing previously loaded data.");
    expect(REGION_TEXT.staleCache).toBe("Stale — history served from cache.");
    expect(REGION_TEXT.retry).toBe("Retry");
    expect(REGION_TEXT.retryIn(3)).toBe("Retry in 3s");
    expect(REGION_TEXT.shorterRange).toBe("Try a shorter range");
    expect(REGION_TEXT.tooManyNoShorter).toBe("Too many lanes/series for this range.");
    expect(REGION_TEXT.loading("alert history")).toBe("Loading alert history…");
  });

  test("REQ-HISTERR-01: idle and not-applicable phases render their content and data attributes", async () => {
    const idle = await mount(region({ phase: "idle" }, { idle: el("p", null, "Select a lane") }));
    const s1 = section(idle.container);
    expect(s1.getAttribute("data-history-phase")).toBe("idle");
    expect(s1.getAttribute("aria-label")).toBe("ingestion rate");
    expect(s1.textContent).toBe("Select a lane");
    const na = await mount(region({ phase: "not-applicable", reason: "Not available at this range (max 24h)" }));
    const s2 = section(na.container);
    expect(s2.getAttribute("data-history-phase")).toBe("not-applicable");
    expect(s2.querySelector("p[data-slot=history-region-note]")?.textContent).toBe("Not available at this range (max 24h)");
    expect(s2.querySelector("button")).toBeNull();
    expect(s2.querySelector("svg")).toBeNull();
  });

  test("REQ-HISTERR-01: loading without previous renders a skeleton, loading text and aria-busy", async () => {
    const m = await mount(region({ phase: "loading", previous: null }));
    const s = section(m.container);
    expect(s.getAttribute("data-history-phase")).toBe("loading");
    expect(s.getAttribute("aria-busy")).toBe("true");
    expect(s.querySelector("[data-slot=skeleton]")).not.toBeNull();
    expect(s.querySelector("p[data-slot=history-region-note]")?.textContent).toBe("Loading ingestion rate…");
    expect(s.querySelector(".probe-child")).toBeNull();
  });

  test("REQ-FOLLOW-03: loading with previous renders the previous data unchanged", async () => {
    const m = await mount(region({ phase: "loading", previous: INGEST_BODY }));
    const s = section(m.container);
    expect(s.getAttribute("data-history-phase")).toBe("loading");
    expect(s.getAttribute("data-history-refreshing")).toBe("true");
    expect(s.getAttribute("aria-busy")).toBe("true");
    expect(s.querySelector(".probe-child")?.textContent).toBe("engine.ingestion-rate");
    expect(s.querySelector(".probe-child")?.getAttribute("data-stale")).toBe("false");
    expect(s.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  test("REQ-HISTERR-02: ready renders data, and a cache-stale payload adds the cache marker", async () => {
    const fresh = await mount(region({ phase: "ready", data: INGEST_BODY }));
    const s1 = section(fresh.container);
    expect(s1.getAttribute("data-history-phase")).toBe("ready");
    expect(s1.getAttribute("data-history-stale")).toBe("false");
    expect(s1.getAttribute("aria-busy")).toBeNull();
    expect(s1.querySelector(".probe-child")?.getAttribute("data-stale")).toBe("false");
    expect(s1.querySelector("[data-slot=history-region-stale]")).toBeNull();
    const stale = await mount(region({ phase: "ready", data: stalePayload }));
    const s2 = section(stale.container);
    expect(s2.getAttribute("data-history-stale")).toBe("true");
    expect(s2.querySelector("[data-slot=history-region-stale]")?.textContent).toBe("Stale — history served from cache.");
    expect(s2.querySelector(".probe-child")?.getAttribute("data-stale")).toBe("true");
  });

  test("REQ-HISTERR-02: error with previous renders a compact notice, the stale marker and the data", async () => {
    const onRetry = jest.fn();
    const m = await mount(region({ phase: "error", failure: failure("timeout"), previous: INGEST_BODY }, { onRetry }));
    const s = section(m.container);
    expect(s.getAttribute("data-history-phase")).toBe("error");
    expect(s.getAttribute("data-history-kind")).toBe("timeout");
    expect(s.getAttribute("data-history-code")).toBe("SOURCE_TIMEOUT");
    expect(s.getAttribute("data-history-stale")).toBe("true");
    const notice = s.querySelector("p[data-slot=history-region-failure]");
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.textContent).toContain("History query timed out.");
    expect(s.querySelector("[data-slot=empty-state]")).toBeNull();
    expect(s.querySelector("[data-slot=history-region-stale]")?.textContent).toBe("Stale — showing previously loaded data.");
    expect(s.querySelector(".probe-child")?.getAttribute("data-stale")).toBe("true");
    retryButton(s)!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("REQ-HISTERR-01: error without previous renders an EmptyState with kind/code attributes and no data", async () => {
    const m = await mount(region({ phase: "error", failure: failure("unavailable"), previous: null }));
    const s = section(m.container);
    expect(s.getAttribute("data-history-kind")).toBe("unavailable");
    expect(s.getAttribute("data-history-code")).toBe("SOURCE_UNAVAILABLE");
    expect(s.getAttribute("data-history-stale")).toBeNull();
    const empty = s.querySelector("[data-slot=empty-state]");
    expect(empty?.getAttribute("role")).toBe("status");
    expect(empty?.querySelector("svg[data-slot=icon]")).not.toBeNull();
    expect(emptyTitle(s)).toBe("Metrics source unavailable.");
    expect(s.querySelector(".probe-child")).toBeNull();
  });

  test("REQ-HISTERR-01: no phase leaves the section empty", async () => {
    const states: HistoryRegionState<HistoryPayload>[] = [
      { phase: "idle" },
      { phase: "not-applicable", reason: "n/a" },
      { phase: "loading", previous: null },
      { phase: "loading", previous: INGEST_BODY },
      { phase: "ready", data: INGEST_BODY },
      ...KINDS.map((k): HistoryRegionState<HistoryPayload> => ({ phase: "error", failure: failure(k), previous: null })),
      { phase: "error", failure: failure("overloaded"), previous: INGEST_BODY },
    ];
    for (const st of states) {
      const m = await mount(region(st, { idle: "Select a lane to see its charts" }));
      const s = section(m.container);
      expect(s.getAttribute("data-history-phase")).toBe(st.phase);
      expect((s.textContent ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  for (const kind of KINDS) {
    test(`REQ-HISTERR-01: failure kind ${kind} shows its exact FAILURE_COPY string`, async () => {
      const m = await mount(
        region({ phase: "error", failure: failure(kind), previous: null }, { onRetry: () => {}, onShorterRange: () => {} }),
      );
      expect(emptyTitle(section(m.container))).toBe(FAILURE_COPY[kind]);
    });
  }

  test("REQ-HISTERR-03: Retry is present for retryable kinds and absent for too-many/not-applicable", async () => {
    const withRetry: HistoryFailureKind[] = ["overloaded", "timeout", "unavailable", "not-ready", "unexpected", "superseded"];
    for (const kind of KINDS) {
      const m = await mount(region({ phase: "error", failure: failure(kind), previous: null }, { onRetry: () => {} }));
      const btn = retryButton(section(m.container));
      expect([kind, btn !== null]).toEqual([kind, withRetry.includes(kind)]);
    }
    // Without onRetry, no Retry button even for a retryable kind.
    const bare = await mount(region({ phase: "error", failure: failure("timeout"), previous: null }));
    expect(section(bare.container).querySelector("button")).toBeNull();
  });

  test("REQ-HISTERR-03: retryAfterSeconds 1 renders a disabled 'Retry in 1s' that becomes an enabled 'Retry'", async () => {
    const onRetry = jest.fn();
    const m = await mount(region({ phase: "error", failure: failure("overloaded", 1), previous: null }, { onRetry }));
    const btn = (): HTMLButtonElement => retryButton(section(m.container))!;
    expect(btn().textContent).toBe("Retry in 1s");
    expect(btn().disabled).toBe(true);
    await advance(1_000);
    expect(btn().textContent).toBe("Retry");
    expect(btn().disabled).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    btn().click();
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("REQ-HISTERR-03: too-many with onShorterRange renders 'Try a shorter range' and clicking calls it", async () => {
    const onShorterRange = jest.fn();
    const m = await mount(
      region({ phase: "error", failure: failure("too-many"), previous: null }, { onShorterRange, onRetry: () => {} }),
    );
    const s = section(m.container);
    expect(emptyTitle(s)).toBe(FAILURE_COPY["too-many"]);
    const btn = shorterButton(s)!;
    expect(btn.textContent).toBe("Try a shorter range");
    expect(retryButton(s)).toBeNull();
    expect(s.querySelector(".probe-child")).toBeNull();
    btn.click();
    expect(onShorterRange).toHaveBeenCalledTimes(1);
  });

  test("REQ-HISTERR-04: too-many with onShorterRange null or absent renders the no-suggestion title and no button", async () => {
    for (const extra of [{ onShorterRange: null }, {}]) {
      const m = await mount(region({ phase: "error", failure: failure("too-many"), previous: null }, extra));
      const s = section(m.container);
      expect(emptyTitle(s)).toBe("Too many lanes/series for this range.");
      expect(s.querySelector("button")).toBeNull();
      expect((s.textContent ?? "").toLowerCase()).not.toContain("shorter range");
    }
  });

  test("REQ-SEC-02: a label or reason containing <b>x</b> renders literally", async () => {
    const m = await mount(region({ phase: "not-applicable", reason: "<b>x</b>" }, { label: "<b>x</b>" }));
    const s = section(m.container);
    expect(s.getAttribute("aria-label")).toBe("<b>x</b>");
    expect(s.querySelector("b")).toBeNull();
    expect(s.textContent).toBe("<b>x</b>");
    const loading = await mount(region({ phase: "loading", previous: null }, { label: "<b>x</b>" }));
    const s2 = section(loading.container);
    expect(s2.querySelector("b")).toBeNull();
    expect(s2.querySelector("[data-slot=history-region-note]")?.textContent).toBe("Loading <b>x</b>…");
  });

  // -------------------------------------------------------------------------------------------
  // RegionErrorBoundary
  // -------------------------------------------------------------------------------------------

  function Thrower(props: { readonly boom: boolean }): ReactElement {
    if (props.boom) throw new Error("chart adapter exploded");
    return el("p", { className: "probe-ok" }, "chart ok");
  }

  function boundaries(boom: boolean, resetKey: string): ReactElement {
    return el(
      "div",
      null,
      el(RegionErrorBoundary, { label: "CPU <b>x</b>", resetKey }, el(Thrower, { boom })),
      el(RegionErrorBoundary, { label: "Memory", resetKey }, el("p", { className: "probe-sibling" }, "memory ok")),
    );
  }

  test("REQ-OBS-01: a throwing child renders the fault notice while a sibling keeps rendering", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const m = await mount(boundaries(true, "1h"));
      const fault = m.container.querySelector("[data-slot=region-fault] [role=status]");
      expect(fault).not.toBeNull();
      expect(fault?.querySelector("svg[data-slot=icon]")).not.toBeNull();
      expect(fault?.querySelector("[data-slot=alert-title]")?.textContent).toBe("This panel failed to render");
      expect(fault?.querySelector("[data-slot=alert-description]")?.textContent).toBe(
        "CPU <b>x</b> could not be displayed. Reload the page to try again; other panels are unaffected.",
      );
      expect(fault?.querySelector("b")).toBeNull();
      expect(m.container.textContent).not.toContain("chart adapter exploded");
      expect(m.container.querySelector(".probe-sibling")?.textContent).toBe("memory ok");
      expect(m.container.querySelectorAll("[data-slot=region-fault]").length).toBe(1);
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  test("REQ-OBS-01: changing resetKey after a fault re-renders the children", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const m = await mount(boundaries(true, "1h"));
      expect(m.container.querySelector("[data-slot=region-fault]")).not.toBeNull();
      // Same resetKey: the fault state holds even though the child would now render.
      await m.update(boundaries(false, "1h"));
      expect(m.container.querySelector("[data-slot=region-fault]")).not.toBeNull();
      await m.update(boundaries(false, "6h"));
      expect(m.container.querySelector("[data-slot=region-fault]")).toBeNull();
      expect(m.container.querySelector(".probe-ok")?.textContent).toBe("chart ok");
      expect(m.container.querySelector(".probe-sibling")?.textContent).toBe("memory ok");
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});
