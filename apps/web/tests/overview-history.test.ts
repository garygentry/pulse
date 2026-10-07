// overview-history.test.ts — lazy liveness-history controller (05 §6, 00 §9, 08 §4.6 cases 1–11).
// Every case injects `HistoryFetch` and a monotonic fake clock; no real network. Case 12 mounts
// LivenessSparkline through describeDom and drives it only through the controller's subscription.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "./react-render.js";
import type { ReactElement } from "react";
import { act } from "./react-render.js";
import {
  ERROR_MESSAGES,
  HISTORY_MAX_LABELS,
  HISTORY_MAX_POINTS,
  HISTORY_TTL_MS,
  type ApiErrorCode,
  type HistoryPayload,
} from "@pulse/web-data/wire";
import type { ApiFetchResult } from "../src/client/api/client.js";
import { LivenessSparkline, RETRY_LIVENESS_HISTORY_LABEL } from "../src/client/views/overview/drawer/LivenessSparkline.js";
import {
  HISTORY_UNAVAILABLE_MESSAGE,
  createHistoryController,
  historyErrorCode,
  targetHistoryPath,
  validateTargetLivenessPayload,
} from "../src/client/views/overview/history.js";
import type {
  HistoryController,
  HistoryErrorCode,
  OverviewTarget,
  TargetHistoryState,
} from "../src/client/views/overview/model.js";
import { resolveOverviewTarget } from "../src/client/views/overview/selectors.js";
import {
  fixtureHostId,
  fixtureServiceId,
  makeLivenessHistoryPayload,
  makeOverviewSnapshot,
} from "./fixtures/overview/factory.js";
import { isolateDomGlobals } from "./alerts-dom-isolation.js";
import { describeDom, renderWithStore } from "./dom.js";

// Case 12 registers happy-dom; restore globalThis afterwards so later non-DOM suites never see it.
isolateDomGlobals();

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

const SNAPSHOT = makeOverviewSnapshot();

function target(id: string): OverviewTarget {
  const resolved = resolveOverviewTarget(SNAPSHOT, id);
  if (resolved === null) throw new Error(`fixture target ${id} missing`);
  return resolved;
}

const HOST_A = target(fixtureHostId(0));
const HOST_B = target(fixtureHostId(1));
const SERVICE_A = target(fixtureServiceId(0, 0));

type Result = ApiFetchResult<unknown>;

interface PendingCall {
  readonly path: string;
  readonly signal: AbortSignal | undefined;
  resolve(result: Result): void;
  reject(error: unknown): void;
}

/** Deferred fake transport: every call stays pending until the test settles it. */
function deferredFetch() {
  const calls: PendingCall[] = [];
  const fetch = (path: string, options?: { readonly signal?: AbortSignal }): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      calls.push({ path, signal: options?.signal, resolve, reject });
    });
  return { calls, fetch };
}

/** Monotonic fake clock. */
function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

function ok(value: unknown): Result {
  return { status: "ok", value, etag: null, identity: null, observation: null };
}

function apiError(code: ApiErrorCode, httpStatus = 503): Result {
  return { status: "error", error: { code, message: `server text for ${code} <b>raw</b>` }, httpStatus };
}

function payloadFor(t: OverviewTarget, options: Parameters<typeof makeLivenessHistoryPayload>[1] = {}): HistoryPayload {
  return makeLivenessHistoryPayload(t.identity, options);
}

/** Plain JSON clone — what apiFetch would hand over after parsing. */
function json<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function recordStates(controller: HistoryController): TargetHistoryState[] {
  const seen: TargetHistoryState[] = [];
  controller.subscribe((s) => seen.push(s));
  return seen;
}

/** Let pending promise continuations run. */
async function flush(): Promise<void> {
  // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------------------------
// Path and validation
// ---------------------------------------------------------------------------------------------

describe("targetHistoryPath", () => {
  test("is the exact fixed, encoded estate.liveness 1h path", () => {
    expect(targetHistoryPath("a b")).toBe("/api/history/target/a%20b/estate.liveness?range=1h");
    expect(targetHistoryPath("svc:host-001/api")).toBe(
      "/api/history/target/svc%3Ahost-001%2Fapi/estate.liveness?range=1h",
    );
  });
});

describe("validateTargetLivenessPayload", () => {
  const identity = HOST_A.identity;

  test("accepts a valid one-series payload as a fresh copy preserving null samples", () => {
    const source = payloadFor(HOST_A, { nullEvery: 3, pointCount: 9 });
    const input = json(source);
    const out = validateTargetLivenessPayload(input, identity);
    expect(out).toEqual(source);
    expect(out).not.toBe(input);
    expect(out?.series[0]?.points[2]?.[1]).toBeNull();
    expect(out?.series[0]?.points.filter(([, v]) => v === null)).toHaveLength(3);
    expect(Object.isFrozen(out)).toBe(true);
  });

  const invalid: readonly [string, (p: Record<string, unknown>) => unknown][] = [
    ["non-object", () => "nope"],
    ["null", () => null],
    ["array", () => []],
    ["extra top-level key", (p) => ({ ...p, extra: 1 })],
    ["missing top-level key", ({ stale: _s, ...rest }) => rest],
    ["wrong query id", (p) => ({ ...p, queryId: "host.cpu.utilization" })],
    ["wrong range", (p) => ({ ...p, range: "6h" })],
    ["wrong unit", (p) => ({ ...p, unit: "percent" })],
    ["null target", (p) => ({ ...p, target: null })],
    ["mismatched target id", (p) => ({ ...p, target: { kind: "host", id: fixtureHostId(1) } })],
    ["mismatched target kind", (p) => ({ ...p, target: { kind: "service", id: identity.id } })],
    ["target extra key", (p) => ({ ...p, target: { ...identity, name: "x" } })],
    ["empty fetchedAt", (p) => ({ ...p, fetchedAt: "" })],
    ["unparseable fetchedAt", (p) => ({ ...p, fetchedAt: "yesterday-ish" })],
    ["zero step", (p) => ({ ...p, effectiveStepSeconds: 0 })],
    ["non-finite step", (p) => ({ ...p, effectiveStepSeconds: Number.POSITIVE_INFINITY })],
    ["string stale", (p) => ({ ...p, stale: "false" })],
    ["missing series (zero)", (p) => ({ ...p, series: [] })],
    ["extra series (two)", (p) => ({ ...p, series: [...(p.series as unknown[]), ...(p.series as unknown[])] })],
    ["series not an array", (p) => ({ ...p, series: {} })],
    ["series extra key", (p) => ({ ...p, series: [{ labels: {}, points: [], extra: true }] })],
    ["labels array", (p) => ({ ...p, series: [{ labels: [], points: [] }] })],
    ["label non-string value", (p) => ({ ...p, series: [{ labels: { a: 1 }, points: [] }] })],
    [
      "too many labels",
      (p) => ({
        ...p,
        series: [
          {
            labels: Object.fromEntries(Array.from({ length: HISTORY_MAX_LABELS + 1 }, (_, i) => [`k${i}`, "v"])),
            points: [],
          },
        ],
      }),
    ],
    ["oversize label value", (p) => ({ ...p, series: [{ labels: { a: "x".repeat(10_000) }, points: [] }] })],
    ["oversize label key", (p) => ({ ...p, series: [{ labels: { ["k".repeat(10_000)]: "v" }, points: [] }] })],
    [
      "too many points",
      (p) => ({
        ...p,
        series: [{ labels: {}, points: Array.from({ length: HISTORY_MAX_POINTS + 1 }, (_, i) => [i + 1, 1]) }],
      }),
    ],
    ["point not a pair", (p) => ({ ...p, series: [{ labels: {}, points: [[1, 1, 1]] }] })],
    ["point value string", (p) => ({ ...p, series: [{ labels: {}, points: [[1, "1"]] }] })],
    ["point non-finite timestamp", (p) => ({ ...p, series: [{ labels: {}, points: [[Number.NaN, 1]] }] })],
    ["duplicate timestamps", (p) => ({ ...p, series: [{ labels: {}, points: [[5, 1], [5, 0]] }] })],
    ["decreasing timestamps", (p) => ({ ...p, series: [{ labels: {}, points: [[6, 1], [5, 0]] }] })],
    [
      "throwing getter",
      (p) =>
        Object.defineProperty({ ...p }, "stale", {
          enumerable: true,
          get() {
            throw new Error("boom");
          },
        }),
    ],
    ["class instance", (p) => Object.assign(Object.create({ inherited: true }) as object, p)],
  ];

  for (const [name, mutate] of invalid) {
    test(`rejects ${name} without throwing`, () => {
      const base = json(payloadFor(HOST_A)) as Record<string, unknown>;
      expect(() => validateTargetLivenessPayload(mutate(base), identity)).not.toThrow();
      expect(validateTargetLivenessPayload(mutate(base), identity)).toBeNull();
    });
  }

  test("rejects a cyclic object without throwing", () => {
    const base = json(payloadFor(HOST_A)) as Record<string, unknown>;
    const cyclic: Record<string, unknown> = { ...base };
    cyclic.target = cyclic;
    expect(validateTargetLivenessPayload(cyclic, identity)).toBeNull();
  });

  test("rejects a proxy whose traps throw", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("trap");
        },
      },
    );
    expect(validateTargetLivenessPayload(hostile, identity)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Controller (08 §4.6 cases 1–11)
// ---------------------------------------------------------------------------------------------

describe("createHistoryController", () => {
  test("case 1: no request is issued until load()", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    await flush();
    expect(t.calls).toHaveLength(0);
    expect(controller.state()).toEqual({ status: "idle" });
    controller.dispose();
  });

  test("case 2: one request with the exact encoded path and one AbortSignal", () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    void controller.load(SERVICE_A);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.path).toBe(targetHistoryPath(SERVICE_A.drilldownId));
    expect(t.calls[0]?.path).toBe(
      `/api/history/target/${encodeURIComponent(SERVICE_A.drilldownId)}/estate.liveness?range=1h`,
    );
    expect(t.calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(t.calls[0]?.signal?.aborted).toBe(false);
    controller.dispose();
  });

  test("case 3: loading is published synchronously while the request is pending", () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const seen = recordStates(controller);
    void controller.load(HOST_A);
    expect(controller.state()).toEqual({ status: "loading", targetId: HOST_A.drilldownId });
    expect(seen).toEqual([{ status: "loading", targetId: HOST_A.drilldownId }]);
    controller.dispose();
  });

  test("case 4: valid one-series success keeps unit and null samples", async () => {
    const t = deferredFetch();
    const clock = fakeClock(5_000);
    const controller = createHistoryController({ fetch: t.fetch, now: clock.now });
    const pending = controller.load(HOST_A);
    const payload = payloadFor(HOST_A, { nullEvery: 4, pointCount: 12 });
    t.calls[0]?.resolve(ok(json(payload)));
    const state = await pending;
    expect(state.status).toBe("ready");
    if (state.status !== "ready") throw new Error("unreachable");
    expect(state.targetId).toBe(HOST_A.drilldownId);
    expect(state.receivedAt).toBe(5_000);
    expect(state.payload).toEqual(payload);
    expect(state.payload.unit).toBe("state");
    expect(state.payload.series).toHaveLength(1);
    expect(state.payload.series[0]?.points.map(([, v]) => v)).toEqual(payload.series[0]?.points.map(([, v]) => v));
    expect(state.payload.series[0]?.points.filter(([, v]) => v === null)).toHaveLength(3);
    expect(controller.state()).toBe(state);
    controller.dispose();
  });

  test("case 5: cache hit below HISTORY_TTL_MS; refetch at and after expiry", async () => {
    const t = deferredFetch();
    const clock = fakeClock();
    const controller = createHistoryController({ fetch: t.fetch, now: clock.now });
    const first = controller.load(HOST_A);
    t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
    const ready = await first;

    clock.advance(HISTORY_TTL_MS - 1);
    const hit = await controller.load(HOST_A);
    expect(hit).toBe(ready);
    expect(t.calls).toHaveLength(1);

    clock.advance(1); // exactly HISTORY_TTL_MS → expired
    const refetch = controller.load(HOST_A);
    expect(t.calls).toHaveLength(2);
    expect(controller.state().status).toBe("loading");
    t.calls[1]?.resolve(ok(json(payloadFor(HOST_A))));
    const fresh = await refetch;
    expect(fresh).not.toBe(ready);
    if (fresh.status !== "ready") throw new Error("expected ready");
    expect(fresh.receivedAt).toBe(clock.now());

    clock.advance(HISTORY_TTL_MS + 5); // well past expiry
    void controller.load(HOST_A);
    expect(t.calls).toHaveLength(3);
    controller.dispose();
  });

  test("case 5b: cache is keyed per target; a hit for B does not serve A", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const a = controller.load(HOST_A);
    t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
    const readyA = await a;
    const b = controller.load(HOST_B);
    expect(t.calls).toHaveLength(2);
    t.calls[1]?.resolve(ok(json(payloadFor(HOST_B))));
    await b;
    // Switching back to A within TTL is a cache hit with no new request.
    expect(await controller.load(HOST_A)).toBe(readyA);
    expect(controller.state()).toBe(readyA);
    expect(t.calls).toHaveLength(2);
    controller.dispose();
  });

  test("case 6: A→B aborts A; a late A success neither replaces B nor enters the cache", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const seen = recordStates(controller);
    const a = controller.load(HOST_A);
    const b = controller.load(HOST_B);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0]?.signal?.aborted).toBe(true);
    expect(t.calls[1]?.signal?.aborted).toBe(false);

    // Late A success (the injected transport ignored its signal).
    t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
    await a;
    await flush();
    expect(controller.state()).toEqual({ status: "loading", targetId: HOST_B.drilldownId });

    t.calls[1]?.resolve(ok(json(payloadFor(HOST_B))));
    const readyB = await b;
    expect(readyB.status).toBe("ready");
    expect(controller.state()).toBe(readyB);
    expect(seen.map((s) => [s.status, "targetId" in s ? s.targetId : null])).toEqual([
      ["loading", HOST_A.drilldownId],
      ["loading", HOST_B.drilldownId],
      ["ready", HOST_B.drilldownId],
    ]);

    // A was never cached: loading A again issues a fresh request.
    void controller.load(HOST_A);
    expect(t.calls).toHaveLength(3);
    controller.dispose();
  });

  test("case 6b: late A error after switching to B is ignored", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const a = controller.load(HOST_A);
    void controller.load(HOST_B);
    t.calls[0]?.resolve(apiError("SOURCE_TIMEOUT"));
    await a;
    expect(controller.state()).toEqual({ status: "loading", targetId: HOST_B.drilldownId });
    controller.dispose();
  });

  test("case 7: cancel aborts silently — idle, no error, no cache entry", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const seen = recordStates(controller);
    const a = controller.load(HOST_A);
    controller.cancel();
    expect(t.calls[0]?.signal?.aborted).toBe(true);
    expect(controller.state()).toEqual({ status: "idle" });

    // apiFetch reports an abort as bounded INTERNAL_ERROR; the token guard discards it.
    t.calls[0]?.resolve(apiError("INTERNAL_ERROR", 0));
    await a;
    expect(controller.state()).toEqual({ status: "idle" });
    expect(seen.some((s) => s.status === "error")).toBe(false);

    void controller.load(HOST_A);
    expect(t.calls).toHaveLength(2); // nothing was cached
    controller.dispose();
  });

  test("case 7b: a late success after cancel is not cached", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const a = controller.load(HOST_A);
    controller.cancel();
    t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
    await a;
    expect(controller.state()).toEqual({ status: "idle" });
    void controller.load(HOST_A);
    expect(t.calls).toHaveLength(2);
    controller.dispose();
  });

  test("case 7c: cancel keeps the success cache", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const a = controller.load(HOST_A);
    t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
    const ready = await a;
    controller.cancel();
    expect(controller.state()).toEqual({ status: "idle" });
    expect(await controller.load(HOST_A)).toBe(ready);
    expect(t.calls).toHaveLength(1);
    controller.dispose();
  });

  test("case 7d: dispose aborts, clears cache and listeners, ignores late work, is idempotent", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const seen = recordStates(controller);
    const a = controller.load(HOST_A);
    controller.dispose();
    controller.dispose();
    expect(t.calls[0]?.signal?.aborted).toBe(true);
    expect(controller.state()).toEqual({ status: "idle" });
    const countAfterDispose = seen.length;

    t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
    await a;
    expect(controller.state()).toEqual({ status: "idle" });
    expect(seen.some((s) => s.status === "error" || s.status === "ready")).toBe(false);

    // A later load resolves to INTERNAL_ERROR without I/O, throwing, or notifying cleared listeners.
    const later = await controller.load(HOST_A);
    expect(later.status).toBe("error");
    if (later.status === "error") expect(later.code).toBe("INTERNAL_ERROR");
    expect(t.calls).toHaveLength(1);
    expect(seen).toHaveLength(countAfterDispose);
    expect((await controller.retry()).status).toBe("error");
    expect(() => controller.cancel()).not.toThrow();
  });

  test("case 8: retry uses a new AbortController, bypasses cache, and caches only success", async () => {
    const t = deferredFetch();
    const clock = fakeClock();
    const controller = createHistoryController({ fetch: t.fetch, now: clock.now });

    // Retry with no current target: idle, no I/O.
    expect(await controller.retry()).toEqual({ status: "idle" });
    expect(t.calls).toHaveLength(0);

    const first = controller.load(HOST_A);
    t.calls[0]?.resolve(apiError("SOURCE_UNAVAILABLE"));
    const failed = await first;
    expect(failed.status).toBe("error");

    // Failure was not cached: load again would refetch; retry does so with a fresh signal.
    const retried = controller.retry();
    expect(t.calls).toHaveLength(2);
    expect(t.calls[1]?.path).toBe(targetHistoryPath(HOST_A.drilldownId));
    expect(t.calls[1]?.signal).not.toBe(t.calls[0]?.signal);
    expect(controller.state()).toEqual({ status: "loading", targetId: HOST_A.drilldownId });
    t.calls[1]?.resolve(ok(json(payloadFor(HOST_A))));
    const ready = await retried;
    expect(ready.status).toBe("ready");

    // Success is cached for load, but retry bypasses and replaces it.
    expect(await controller.load(HOST_A)).toBe(ready);
    const again = controller.retry();
    expect(t.calls).toHaveLength(3);
    t.calls[2]?.resolve(apiError("HISTORY_OVERLOADED"));
    expect((await again).status).toBe("error");
    void controller.load(HOST_A);
    expect(t.calls).toHaveLength(4); // the old success was removed by retry
    controller.dispose();
  });

  test("case 8b: retry while loading aborts the prior request and ignores its late result", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const first = controller.load(HOST_A);
    const retried = controller.retry();
    expect(t.calls[0]?.signal?.aborted).toBe(true);
    t.calls[0]?.resolve(apiError("SOURCE_TIMEOUT"));
    await first;
    expect(controller.state().status).toBe("loading");
    t.calls[1]?.resolve(ok(json(payloadFor(HOST_A))));
    expect((await retried).status).toBe("ready");
    controller.dispose();
  });

  describe("case 9: error mapping is bounded, retryable, and never cached", () => {
    const passthrough: readonly HistoryErrorCode[] = [
      "INVALID_REQUEST",
      "QUERY_NOT_FOUND",
      "TARGET_NOT_FOUND",
      "QUERY_NOT_APPLICABLE",
      "RANGE_UNSUPPORTED",
      "HISTORY_OVERLOADED",
      "SOURCE_UNAVAILABLE",
      "SOURCE_TIMEOUT",
      "HISTORY_LIMIT_EXCEEDED",
      "HISTORY_CANCELLED",
      "MODEL_CHANGED",
      "INTERNAL_ERROR",
    ];
    const toInternal: readonly ApiErrorCode[] = [
      "API_NOT_FOUND",
      "METHOD_NOT_ALLOWED",
      "NOT_READY",
      "CYCLE_BUILD_FAILED",
      "ESTATE_BUNDLE_MISSING",
      "ESTATE_BUNDLE_UNREADABLE",
      "ESTATE_BUNDLE_UNPARSEABLE",
      "ESTATE_BUNDLE_VERSION",
      "ESTATE_BUNDLE_STRUCTURE",
      "ESTATE_BUNDLE_INCOHERENT",
    ];

    test("every ApiErrorCode is covered by the tables", () => {
      expect(new Set<string>([...passthrough, ...toInternal])).toEqual(new Set(Object.keys(ERROR_MESSAGES)));
      for (const code of toInternal) expect(historyErrorCode(code)).toBe("INTERNAL_ERROR");
      for (const code of passthrough) expect(historyErrorCode(code)).toBe(code);
      expect(historyErrorCode("SOMETHING_NEW")).toBe("INTERNAL_ERROR");
    });

    const cases: readonly [string, HistoryErrorCode, (settle: PendingCall) => void][] = [
      ...passthrough.map((code): [string, HistoryErrorCode, (c: PendingCall) => void] => [
        `API ${code}`,
        code,
        (c) => c.resolve(apiError(code)),
      ]),
      ...toInternal.map((code): [string, HistoryErrorCode, (c: PendingCall) => void] => [
        `API ${code}`,
        "INTERNAL_ERROR",
        (c) => c.resolve(apiError(code)),
      ]),
      ["unrecognized server code", "INTERNAL_ERROR", (c) => c.resolve(apiError("NOPE" as ApiErrorCode))],
      ["network rejection", "INTERNAL_ERROR", (c) => c.reject(new TypeError("Failed to fetch"))],
      ["network failure result (httpStatus 0)", "INTERNAL_ERROR", (c) => c.resolve(apiError("INTERNAL_ERROR", 0))],
      ["malformed JSON body", "INTERNAL_ERROR", (c) => c.resolve(ok("{not json"))],
      ["malformed result value", "INTERNAL_ERROR", (c) => c.resolve(ok({ hello: "world" }))],
      [
        "unexpected 304 not-modified",
        "INTERNAL_ERROR",
        (c) => c.resolve({ status: "not-modified", etag: "e", identity: "i", observation: null }),
      ],
      [
        "missing series",
        "INTERNAL_ERROR",
        (c) => c.resolve(ok({ ...(json(payloadFor(HOST_A)) as object), series: [] })),
      ],
      [
        "extra series",
        "INTERNAL_ERROR",
        (c) => {
          const p = json(payloadFor(HOST_A)) as { series: unknown[] };
          c.resolve(ok({ ...p, series: [...p.series, ...p.series] }));
        },
      ],
      [
        "series attributed to another target",
        "INTERNAL_ERROR",
        (c) => c.resolve(ok(json(payloadFor(HOST_B)))),
      ],
    ];

    for (const [name, code, settle] of cases) {
      test(name, async () => {
        const t = deferredFetch();
        const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
        const pending = controller.load(HOST_A);
        const call = t.calls[0];
        if (call === undefined) throw new Error("no request");
        settle(call);
        const state = await pending;
        expect(state.status).toBe("error");
        if (state.status !== "error") throw new Error("unreachable");
        expect(state.targetId).toBe(HOST_A.drilldownId);
        expect(state.code).toBe(code);
        expect(state.retryable).toBe(true);
        expect(state.message.length).toBeGreaterThan(0);
        expect(state.message.length).toBeLessThanOrEqual(120);
        expect(state.message).not.toContain("server text");
        expect(state.message).not.toContain("<b>");
        if (code === "INTERNAL_ERROR") expect(state.message).toBe(HISTORY_UNAVAILABLE_MESSAGE);
        expect(controller.state()).toBe(state);
        // No success-cache write: the next load issues a new request.
        void controller.load(HOST_A);
        expect(t.calls).toHaveLength(2);
        controller.dispose();
        await flush(); // bun fails the run on any unhandled rejection surfacing here
      });
    }

    test("a synchronously throwing transport becomes INTERNAL_ERROR without rejecting", async () => {
      const controller = createHistoryController({
        fetch: () => {
          throw new Error("sync boom");
        },
        now: fakeClock().now,
      });
      const state = await controller.load(HOST_A);
      expect(state.status).toBe("error");
      if (state.status === "error") expect(state.code).toBe("INTERNAL_ERROR");
      expect(controller.state()).toBe(state);
      controller.dispose();
    });
  });

  test("case 10: concurrent duplicate load for one target issues one request", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const seen = recordStates(controller);
    const first = controller.load(HOST_A);
    const second = controller.load(HOST_A);
    const third = controller.load(HOST_A);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]?.signal?.aborted).toBe(false);
    t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(seen.map((s) => s.status)).toEqual(["loading", "ready"]);
    controller.dispose();
  });

  describe("case 11: subscriptions", () => {
    test("state is stored before listeners run; loading then ready in order", async () => {
      const t = deferredFetch();
      const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
      const observed: [string, boolean][] = [];
      controller.subscribe((s) => observed.push([s.status, controller.state() === s]));
      const pending = controller.load(HOST_A);
      t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
      await pending;
      expect(observed).toEqual([
        ["loading", true],
        ["ready", true],
      ]);
      controller.dispose();
    });

    test("loading then error in order", async () => {
      const t = deferredFetch();
      const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
      const seen = recordStates(controller);
      const pending = controller.load(HOST_A);
      t.calls[0]?.resolve(apiError("MODEL_CHANGED", 409));
      await pending;
      expect(seen.map((s) => s.status)).toEqual(["loading", "error"]);
    });

    test("listeners run in registration order and a throwing listener does not starve others", async () => {
      const t = deferredFetch();
      const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
      const order: string[] = [];
      controller.subscribe((s) => order.push(`first:${s.status}`));
      controller.subscribe(() => {
        order.push("thrower");
        throw new Error("listener failure");
      });
      controller.subscribe((s) => order.push(`third:${s.status}`));
      const pending = controller.load(HOST_A);
      t.calls[0]?.resolve(ok(json(payloadFor(HOST_A))));
      const state = await pending;
      expect(state.status).toBe("ready");
      expect(order).toEqual(["first:loading", "thrower", "third:loading", "first:ready", "thrower", "third:ready"]);
      controller.dispose();
    });

    test("unsubscribe is idempotent and only removes its own listener", () => {
      const t = deferredFetch();
      const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
      const calls: string[] = [];
      const listener = () => calls.push("dup");
      const offA = controller.subscribe(listener);
      controller.subscribe(listener); // same function registered twice
      const offOther = controller.subscribe(() => calls.push("other"));
      offA();
      offA();
      offA();
      void controller.load(HOST_A);
      expect(calls).toEqual(["dup", "other"]);
      offOther();
      offOther();
      controller.dispose();
    });

    test("unsubscribing during publication does not skip later listeners", () => {
      const t = deferredFetch();
      const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
      const calls: string[] = [];
      const off = controller.subscribe(() => {
        calls.push("self-removing");
        off();
      });
      controller.subscribe(() => calls.push("next"));
      void controller.load(HOST_A);
      expect(calls).toEqual(["self-removing", "next"]);
      controller.dispose();
    });

    test("dispose publishes idle, then clears listeners; unsubscribers stay safe", async () => {
      const t = deferredFetch();
      const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
      const seen: string[] = [];
      const off = controller.subscribe((s) => seen.push(s.status));
      void controller.load(HOST_A);
      controller.dispose();
      expect(seen).toEqual(["loading", "idle"]);
      expect(() => off()).not.toThrow();
      const lateOff = controller.subscribe(() => seen.push("late"));
      await controller.load(HOST_B);
      await controller.retry();
      controller.cancel();
      expect(seen).toEqual(["loading", "idle"]);
      expect(() => lateOff()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Case 12: LivenessSparkline subscription lifecycle (05 §6.4.1)
// ---------------------------------------------------------------------------------------------

/** Wrap a real controller, logging calls and counting live subscriptions. */
function instrument(inner: HistoryController) {
  const log: string[] = [];
  let active = 0;
  const controller: HistoryController = {
    state: () => inner.state(),
    subscribe(listener) {
      log.push("subscribe");
      active++;
      const unsubscribe = inner.subscribe(listener);
      let done = false;
      return () => {
        if (!done) {
          done = true;
          active--;
          log.push("unsubscribe");
        }
        unsubscribe();
      };
    },
    load(t) {
      log.push(`load:${t.drilldownId}`);
      return inner.load(t);
    },
    retry() {
      log.push("retry");
      return inner.retry();
    },
    cancel() {
      log.push("cancel");
      inner.cancel();
    },
    dispose: () => inner.dispose(),
  };
  return { controller, log, active: () => active };
}

describeDom("case 12: LivenessSparkline lifecycle", () => {
  const mounted: Array<{ unmount(): void }> = [];
  afterEach(() => {
    for (const m of mounted.splice(0)) m.unmount();
  });

  async function mount(t: OverviewTarget, controller: HistoryController) {
    let result!: Awaited<ReturnType<typeof renderWithStore>>;
    await act(async () => {
      result = await renderWithStore(createElement(LivenessSparkline, { target: t, controller }) as unknown as ReactElement);
    });
    mounted.push(result);
    const container = result.container;
    return {
      container,
      state: () => container.querySelector("[data-history-state]")?.getAttribute("data-history-state") ?? null,
      rerender(next: OverviewTarget) {
        act(() => {
          render(createElement(LivenessSparkline, { target: next, controller }), container);
        });
      },
      unmount: () => result.unmount(),
    };
  }

  test("mount subscribes before one load and rerenders loading → ready only via the subscription", async () => {
    const t = deferredFetch();
    const { controller, log, active } = instrument(createHistoryController({ fetch: t.fetch, now: fakeClock().now }));
    const view = await mount(HOST_A, controller);
    expect(log).toEqual(["subscribe", `load:${HOST_A.drilldownId}`]);
    expect(active()).toBe(1);
    expect(t.calls).toHaveLength(1);
    expect(view.state()).toBe("loading");
    await act(async () => t.calls[0]!.resolve(ok(json(payloadFor(HOST_A, { nullEvery: 3 })))));
    expect(view.state()).toBe("ready");
    expect(view.container.querySelector('svg[role="img"]')).not.toBeNull();
    expect(t.calls).toHaveLength(1);
    controller.dispose();
  });

  test("render/effect race: a load already in flight is joined, not duplicated, and its result still renders", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    void controller.load(HOST_A);
    expect(t.calls).toHaveLength(1);
    const view = await mount(HOST_A, controller);
    expect(t.calls).toHaveLength(1);
    expect(view.state()).toBe("loading");
    await act(async () => t.calls[0]!.resolve(ok(json(payloadFor(HOST_A)))));
    expect(view.state()).toBe("ready");
    controller.dispose();
  });

  test("render/effect race: a success published before mount renders ready with no request", async () => {
    const t = deferredFetch();
    const controller = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const pending = controller.load(HOST_A);
    t.calls[0]!.resolve(ok(json(payloadFor(HOST_A))));
    await pending;
    const view = await mount(HOST_A, controller);
    expect(view.state()).toBe("ready");
    expect(t.calls).toHaveLength(1);
    controller.dispose();
  });

  test("target change aborts A, loads B once, ignores a late A result; a re-derived same-id target does not reload", async () => {
    const t = deferredFetch();
    const { controller, log } = instrument(createHistoryController({ fetch: t.fetch, now: fakeClock().now }));
    const view = await mount(HOST_A, controller);
    const aSignal = t.calls[0]!.signal!;

    view.rerender(HOST_B);
    expect(aSignal.aborted).toBe(true);
    expect(t.calls.map((c) => c.path)).toEqual([targetHistoryPath(HOST_A.drilldownId), targetHistoryPath(HOST_B.drilldownId)]);
    expect(log).toEqual([
      "subscribe",
      `load:${HOST_A.drilldownId}`,
      "unsubscribe",
      "cancel",
      "subscribe",
      `load:${HOST_B.drilldownId}`,
    ]);
    expect(view.state()).toBe("loading");

    await act(async () => t.calls[0]!.resolve(ok(json(payloadFor(HOST_A)))));
    expect(view.state()).toBe("loading");

    await act(async () => t.calls[1]!.resolve(ok(json(payloadFor(HOST_B)))));
    expect(view.state()).toBe("ready");
    expect(view.container.querySelector("svg")?.getAttribute("aria-label")).toBe(`One-hour liveness for ${HOST_B.host.name}`);

    // A new snapshot re-derives the target object with the same canonical id: no new request.
    const rederived = resolveOverviewTarget(makeOverviewSnapshot({ cycle: 2 }), HOST_B.drilldownId)!;
    expect(rederived).not.toBe(HOST_B);
    view.rerender(rederived);
    expect(t.calls).toHaveLength(2);
    expect(view.state()).toBe("ready");
    controller.dispose();
  });

  test("retry after an error issues one new request and renders through the subscription", async () => {
    const t = deferredFetch();
    const { controller, log } = instrument(createHistoryController({ fetch: t.fetch, now: fakeClock().now }));
    const view = await mount(SERVICE_A, controller);
    await act(async () => t.calls[0]!.resolve(apiError("HISTORY_OVERLOADED")));
    expect(view.state()).toBe("error");
    const retry = Array.from(view.container.querySelectorAll("button")).find(
      (b) => b.textContent === RETRY_LIVENESS_HISTORY_LABEL,
    ) as HTMLButtonElement;
    await act(async () => retry.click());
    expect(log.filter((entry) => entry === "retry")).toHaveLength(1);
    expect(t.calls).toHaveLength(2);
    expect(view.state()).toBe("loading");
    expect(view.container.querySelector("button")).toBeNull();
    await act(async () => t.calls[1]!.resolve(ok(json(payloadFor(SERVICE_A)))));
    expect(view.state()).toBe("ready");
    expect(t.calls).toHaveLength(2);
    controller.dispose();
  });

  test("unmount unsubscribes and cancels the in-flight request; a late result is silently dropped", async () => {
    const t = deferredFetch();
    const inner = createHistoryController({ fetch: t.fetch, now: fakeClock().now });
    const { controller, log, active } = instrument(inner);
    const view = await mount(HOST_A, controller);
    const signal = t.calls[0]!.signal!;
    view.unmount();
    mounted.splice(0);
    expect(active()).toBe(0);
    expect(log.slice(-2)).toEqual(["unsubscribe", "cancel"]);
    expect(signal.aborted).toBe(true);
    expect(inner.state()).toEqual({ status: "idle" });
    await act(async () => t.calls[0]!.resolve(ok(json(payloadFor(HOST_A)))));
    await flush();
    expect(inner.state()).toEqual({ status: "idle" });
    expect(t.calls).toHaveLength(1);
    inner.dispose();
  });

  test("never polls: time passing beyond HISTORY_TTL_MS issues no request while mounted", async () => {
    const t = deferredFetch();
    const clock = fakeClock();
    const controller = createHistoryController({ fetch: t.fetch, now: clock.now });
    const view = await mount(HOST_A, controller);
    await act(async () => t.calls[0]!.resolve(ok(json(payloadFor(HOST_A)))));
    clock.advance(HISTORY_TTL_MS * 5);
    await act(async () => {
      await flush();
    });
    expect(t.calls).toHaveLength(1);
    expect(view.state()).toBe("ready");
    const src = readFileSync(join(import.meta.dir, "../src/client/views/overview/drawer/LivenessSparkline.tsx"), "utf8");
    expect(src).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    controller.dispose();
  });
});

// ---------------------------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------------------------

describe("history.ts boundaries", () => {
  const overviewDir = join(import.meta.dir, "../src/client/views/overview");

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
  }

  test("history.ts is the only overview module referencing apiFetch", () => {
    const referencing = sources(overviewDir)
      .filter((path) => /\bapiFetch\b/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(overviewDir.length + 1));
    expect(referencing).toEqual(["history.ts"]);
  });

  test("history.ts imports no React", () => {
    const text = readFileSync(join(overviewDir, "history.ts"), "utf8");
    expect(text).not.toMatch(/from\s+["']react/);
    expect(text).not.toMatch(/import\(\s*["']react/);
  });
});
