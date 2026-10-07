// apps/web/tests/live-state.test.ts — the unified auto/SSE/poll live-state machine
// (08-events-live-state-and-freshness-migration.md §§7–9; item 046).
//
// Every case is driven by a deterministic fake scheduler + fake clock (no real sleeps) and a
// scripted fetch/EventSource. Covers: poll bootstrap + conditional 304 (observation advances, no
// payload write), selective active/kiosk/bootstrap fetching, stall→stale; SSE authority/takeover,
// immediate poll fallback, and the exact 10/20/40/60 reconnect backoff with tick-reset; auto-mode
// factory selection; the §8 race matrix (generation reset, equal-seq collision, stale/older
// responses, token supersession, stop races); and the one shared reload-once guard + full stop
// cleanup.

import { describe, expect, test } from "bun:test";

import type { CycleObservation, HashId, SourceId, ViewId } from "@pulse/web-data/wire";

import { DEV_BUILD_ID_PATH } from "../src/client/api/client.js";
import { overviewSnapshot } from "./factories/wire.js";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import {
  DEV_BUILD_CHECK_INTERVAL_MS,
  startLiveState,
  type EventSourceFactory,
  type LiveEventSource,
  type LiveMessageEvent,
  type LiveStateHandle,
  type LiveStateOptions,
  type NextKioskView,
} from "../src/client/store/live-state.js";

// Exercise the exported types so `bun run typecheck` catches drift.
type _typesInUse = LiveStateOptions | LiveStateHandle | NextKioskView | EventSourceFactory;

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];
const VIEW_IDS: readonly ViewId[] = ["overview", "alerts", "estate", "engine", "timeline"];
const GEN_A = "11111111-1111-4111-8111-111111111111";
const GEN_B = "22222222-2222-4222-8222-222222222222";

/** A distinct valid `sha256:` identity from a single hex char. */
const hash = (c: string): HashId => (`sha256:${c.repeat(64)}`) as HashId;

// ── Deterministic scheduler + clock ──────────────────────────────────────────────────────────────

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/** A fake timer set + clock. `setTimer`/`clearTimer` satisfy `typeof setTimeout`; `advance(ms)` fires
 *  due timers in (at, id) order and flushes microtasks after each so async fetch chains settle. */
class Scheduler {
  now = 0;
  private nextId = 1;
  private timers = new Map<number, Timer>();

  readonly setTimer = ((fn: () => void, ms = 0): number => {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.now + ms, fn });
    return id;
  }) as unknown as typeof setTimeout;

  readonly clearTimer = ((id: number): void => {
    this.timers.delete(id);
  }) as unknown as typeof clearTimeout;

  readonly nowFn = (): number => this.now;

  private due(target: number): Timer | null {
    let best: Timer | null = null;
    for (const t of this.timers.values()) {
      if (t.at <= target && (best === null || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    }
    return best;
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const t = this.due(target);
      if (t === null) break;
      this.now = t.at;
      this.timers.delete(t.id);
      t.fn();
      await flush();
    }
    this.now = target;
    await flush();
  }

  pendingCount(): number {
    return this.timers.size;
  }
}

/** Flush queued microtasks so an async fetch chain (`apiFetch` → `res.json()` → publish) settles. */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

// ── Scripted fetch ───────────────────────────────────────────────────────────────────────────────

interface Call {
  readonly path: string;
  readonly ifNoneMatch: string | null;
}

function encodeObs(obs: unknown): string {
  return Buffer.from(JSON.stringify(obs)).toString("base64url");
}

function observation(gen: string, seq: number, over: Partial<CycleObservation> = {}): CycleObservation {
  const sources = Object.fromEntries(
    SOURCE_IDS.map((id) => [id, { state: "current", lastAttemptAt: "2026-09-17T00:00:00.000Z", lastSuccess: "2026-09-17T00:00:00.000Z" }]),
  ) as CycleObservation["sources"];
  return { generation: gen, seq, observedAt: "2026-09-17T00:00:00.000Z", appVersion: "1.0.0", sources, ...over };
}

let activeResponsePath: string | null = null;

function overviewFixture(body: unknown, appVersion = "1.0.0"): ReturnType<typeof overviewSnapshot> {
  return overviewSnapshot({
    appVersion,
    estate: { name: `fixture:${JSON.stringify(body)}`, timezone: "UTC", tzFallback: false },
  });
}

/** A cycle-route 200 with genuine metadata headers (etag/payload-id/observation). */
function ok200(body: unknown, opts: { etag: HashId; payloadId: HashId; obs: CycleObservation }): Response {
  const candidate = body as { readonly appVersion?: unknown } | null;
  const responseBody = activeResponsePath === "/api/overview" &&
      (candidate === null || typeof candidate !== "object" || candidate.appVersion === undefined)
    ? overviewFixture(body, opts.obs.appVersion)
    : body;
  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      "content-type": "application/json",
      etag: `"${opts.etag}"`,
      "x-pulse-payload-id": opts.payloadId,
      "x-pulse-observation": encodeObs(opts.obs),
    },
  });
}

/** A cycle-route 304 (bodyless) carrying the current payload-id + observation. */
function notModified(opts: { payloadId: HashId; obs: CycleObservation }): Response {
  return new Response(null, {
    status: 304,
    headers: { "x-pulse-payload-id": opts.payloadId, "x-pulse-observation": encodeObs(opts.obs) },
  });
}

interface Server {
  readonly fetchImpl: typeof fetch;
  readonly calls: Call[];
  script(path: string, ...responses: Array<() => Response>): void;
  paths(): string[];
  count(path: string): number;
}

function makeServer(): Server {
  const calls: Call[] = [];
  const scripts = new Map<string, Array<() => Response>>();

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.split("?", 1)[0] ?? url;
    const headers = new Headers(init?.headers);
    calls.push({ path, ifNoneMatch: headers.get("if-none-match") });
    if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    if (path === DEV_BUILD_ID_PATH) {
      return new Response(JSON.stringify({ buildId: "shell-v0" }), { status: 200 });
    }
    const queued = scripts.get(path)?.shift();
    if (queued !== undefined) {
      activeResponsePath = path;
      try {
        return queued();
      } finally {
        activeResponsePath = null;
      }
    }
    // Default: a bounded error (NOT_READY-shaped) so an unscripted cycle fetch resolves as
    // `status:"error"` (never an uncaught throw), keeping fallback-poll noise inert.
    return new Response(JSON.stringify({ code: "NOT_READY", message: "not ready" }), { status: 503 });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    script(path, ...responses) {
      const q = scripts.get(path) ?? [];
      q.push(...responses);
      scripts.set(path, q);
    },
    paths: () => calls.map((c) => c.path),
    count: (path) => calls.filter((c) => c.path === path).length,
  };
}

// ── Fake EventSource ─────────────────────────────────────────────────────────────────────────────

class FakeEventSource implements LiveEventSource {
  static instances: FakeEventSource[] = [];
  static reset(): void {
    FakeEventSource.instances = [];
  }
  static last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (es === undefined) throw new Error("no EventSource opened");
    return es;
  }

  closed = false;
  private readonly tickListeners: Array<(e: LiveMessageEvent) => void> = [];
  private readonly errorListeners: Array<(e: LiveMessageEvent) => void> = [];

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: "tick" | "error", listener: (e: LiveMessageEvent) => void): void {
    (type === "tick" ? this.tickListeners : this.errorListeners).push(listener);
  }
  close(): void {
    this.closed = true;
  }
  emitTick(observationValue: CycleObservation, identities: Record<ViewId, HashId>): void {
    const data = JSON.stringify({ observation: observationValue, identities });
    for (const l of this.tickListeners.slice()) l({ data });
  }
  emitRaw(data: string): void {
    for (const l of this.tickListeners.slice()) l({ data });
  }
  emitError(): void {
    for (const l of this.errorListeners.slice()) l({});
  }
}

const esFactory: EventSourceFactory = (url) => new FakeEventSource(url);

function identitiesAll(id: HashId): Record<ViewId, HashId> {
  return { overview: id, alerts: id, estate: id, engine: id, timeline: id };
}

// ── Shared harness ───────────────────────────────────────────────────────────────────────────────

function harness(
  optsOver: Partial<LiveStateOptions> & Pick<LiveStateOptions, "transport">,
): { store: AppStore; server: Server; sched: Scheduler; live: LiveStateHandle } {
  const store = createAppStore({ storage: null, initialQuery: {} });
  const server = makeServer();
  const sched = new Scheduler();
  const live = startLiveState(store, {
    fetchImpl: server.fetchImpl,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    now: sched.nowFn,
    reload: () => {},
    ...optsOver,
  });
  return { store, server, sched, live };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Poll transport (§9)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("poll transport", () => {
  test("bootstraps overview, publishes snapshot, phase live, observation + view current", async () => {
    const { store, server, sched, live } = harness({ transport: "poll" });
    server.script("/api/overview", () => ok200({ marker: "ov1" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));

    await sched.advance(0); // fire the initial 0 ms poll
    live.stop();

    expect(store.snapshot.value?.estate.name).toBe('fixture:{"marker":"ov1"}');
    const conn = store.connection.value;
    expect(conn.transport).toBe("poll");
    expect(conn.phase).toBe("live");
    expect(conn.observation?.seq).toBe(1);
    expect(conn.seq).toBe(1);
    expect(conn.views.overview.phase).toBe("current");
    expect(conn.views.overview.identity).toBe(hash("b"));
  });

  test("a malformed initial overview body remains unavailable and records delivery failure", async () => {
    const { store, server, sched, live } = harness({ transport: "poll" });
    server.script("/api/overview", () => ok200({ appVersion: "malformed" }, {
      etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1),
    }));

    await sched.advance(0);
    live.stop();

    expect(store.snapshot.peek()).toBeNull();
    expect(store.connection.peek().views.overview.phase).toBe("initial");
    expect(store.connection.peek().failingSince).not.toBeNull();
    expect(store.connection.peek().seq).toBe(0);
  });

  test("a malformed overview refresh retains the last accepted body and marks delivery stale", async () => {
    const { store, server, sched, live } = harness({
      transport: "poll", intervalMs: 5_000, staleMs: 100_000, activeView: () => "overview",
    });
    server.script(
      "/api/overview",
      () => ok200({ marker: "accepted" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }),
      () => ok200({ appVersion: "malformed" }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 2) }),
    );

    await sched.advance(0);
    const acceptedSnapshot = store.snapshot.peek();
    await sched.advance(5_000);
    live.stop();

    expect(store.snapshot.peek()).toBe(acceptedSnapshot);
    expect(store.connection.peek().views.overview.phase).toBe("stale");
    expect(store.connection.peek().views.overview.identity).toBe(hash("b"));
    expect(store.connection.peek().failingSince).not.toBeNull();
    expect(store.connection.peek().seq).toBe(1);
  });

  test("publishes per-view failure causes and explicit refetch clears and retries them", async () => {
    const { store, server, sched, live } = harness({
      transport: "poll",
      activeView: () => "estate",
      intervalMs: 100_000,
    });
    server.script(
      "/api/overview",
      () => ok200({ marker: "ov" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }),
    );
    server.script(
      "/api/estate",
      () => new Response(JSON.stringify({ code: "NOT_READY", message: "estate warming up" }), { status: 503 }),
      () => ok200({ marker: "estate" }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 2) }),
    );

    await sched.advance(0);
    expect(store.connection.value.views.estate.failure).toEqual({
      code: "NOT_READY",
      status: 503,
      message: "estate warming up",
    });

    live.refetch("estate");
    expect(store.connection.value.views.estate.failure).toBeNull();
    await flush();
    expect(store.connection.value.views.estate.phase).toBe("current");
    expect(store.connection.value.views.estate.failure).toBeNull();
    expect(store.estate.value as unknown).toEqual({ marker: "estate" });
    expect(server.count("/api/estate")).toBe(2);
    live.stop();
  });

  test("never opens an EventSource even when a factory is available", async () => {
    FakeEventSource.reset();
    const { server, sched, live } = harness({ transport: "poll", eventSourceFactory: esFactory });
    server.script("/api/overview", () => ok200({ marker: "ov" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    await sched.advance(0);
    live.stop();
    expect(FakeEventSource.instances.length).toBe(0);
  });

  test("second poll sends If-None-Match; a 304 advances observation without a snapshot write", async () => {
    const { store, server, sched, live } = harness({ transport: "poll", intervalMs: 10_000, staleMs: 100_000, activeView: () => "overview" });
    server.script(
      "/api/overview",
      () => ok200({ marker: "ov1" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }),
      () => notModified({ payloadId: hash("b"), obs: observation(GEN_A, 2) }),
    );

    await sched.advance(0); // first poll → 200
    const afterFirst = store.snapshot.value;
    const seqAfterFirst = store.connection.value.seq;
    await sched.advance(10_000); // second poll → 304
    live.stop();

    expect(store.snapshot.value).toBe(afterFirst); // identical signal object — no payload write
    expect(store.connection.value.seq).toBe(seqAfterFirst); // no new accepted payload
    expect(store.connection.value.observation?.seq).toBe(2); // observation advanced on the 304
    const conditional = server.calls.find((c) => c.ifNoneMatch !== null);
    expect(conditional?.ifNoneMatch).toBe(`"${hash("a")}"`);
  });

  test("only active + bootstrap overview fetch; inactive views are never requested", async () => {
    const { server, sched, live } = harness({ transport: "poll", activeView: () => "alerts" });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    server.script("/api/alerts", () => ok200({ a: 1 }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 1) }));

    await sched.advance(0);
    live.stop();

    expect(server.count("/api/overview")).toBe(1); // bootstrap
    expect(server.count("/api/alerts")).toBe(1); // active
    expect(server.count("/api/estate")).toBe(0);
    expect(server.count("/api/engine")).toBe(0);
    expect(server.count("/api/timeline")).toBe(0);
  });

  test("shell publication seam prefetches an imminent kiosk view", async () => {
    const { server, sched, live } = harness({ transport: "poll", activeView: () => "overview" });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    server.script("/api/engine", () => ok200({ e: 1 }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 1) }));
    live.setNextKioskView({ view: "engine", dueWithinMs: 5_000 });
    await sched.advance(0);
    live.stop();
    expect(server.count("/api/engine")).toBe(1);
  });

  test("imminent kiosk view is prefetched; a distant one is not", async () => {
    const { server, sched, live } = harness({
      transport: "poll",
      activeView: () => "overview",
      nextKioskView: (): NextKioskView => ({ view: "engine", dueWithinMs: 5_000 }),
    });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    server.script("/api/engine", () => ok200({ e: 1 }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 1) }));
    await sched.advance(0);
    live.stop();
    expect(server.count("/api/engine")).toBe(1);

    const distant = harness({
      transport: "poll",
      activeView: () => "overview",
      nextKioskView: (): NextKioskView => ({ view: "engine", dueWithinMs: 60_000 }),
    });
    distant.server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    await distant.sched.advance(0);
    distant.live.stop();
    expect(distant.server.count("/api/engine")).toBe(0);
  });

  test("repeated 304s on a stalled observation eventually go stale despite HTTP contact", async () => {
    const { store, server, sched, live } = harness({ transport: "poll", intervalMs: 5_000, staleMs: 12_000, activeView: () => "overview" });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    // Every later poll is a 304 whose observation NEVER advances (stalled cycle).
    for (let i = 0; i < 10; i++) server.script("/api/overview", () => notModified({ payloadId: hash("b"), obs: observation(GEN_A, 1) }));

    await sched.advance(0);
    expect(store.connection.value.phase).toBe("live");
    await sched.advance(20_000); // several 304 polls, all with a stalled observation
    live.stop();

    expect(store.connection.value.phase).toBe("stale");
    expect(store.connection.value.lastGoodAt).not.toBeNull(); // HTTP contact still succeeded
    expect(store.connection.value.views.overview.phase).toBe("stale");
  });

  test("a network error starts a failure streak (failingSince set), snapshot retained", async () => {
    const { store, server, sched, live } = harness({ transport: "poll", intervalMs: 5_000, staleMs: 100_000, activeView: () => "overview" });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    // next fetch: a hard network failure (thrown) → apiFetch bounds it to status:"error".
    server.script("/api/overview", () => {
      throw new Error("network down");
    });

    await sched.advance(0);
    await sched.advance(5_000);
    live.stop();

    expect(store.snapshot.value?.estate.name).toBe('fixture:{"o":1}'); // retained
    expect(store.connection.value.failingSince).not.toBeNull();
  });

  test("bootstrap overview fetches once; later cycles with a non-overview active view never refetch it (§8.6)", async () => {
    const { server, sched, live } = harness({ transport: "poll", intervalMs: 5_000, staleMs: 1_000_000, activeView: () => "alerts" });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    for (let i = 0; i < 6; i++) {
      server.script("/api/alerts", () => ok200({ a: i }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 1) }));
    }

    await sched.advance(0); // cycle 1: overview (bootstrap) + alerts (active control)
    await sched.advance(5_000); // cycle 2: alerts only
    await sched.advance(5_000); // cycle 3: alerts only
    live.stop();

    // Overview is fetched exactly once (the estate-identity/timezone bootstrap) and is never refetched
    // merely for shell freshness while inactive; the active alerts view remains the per-cycle control.
    expect(server.count("/api/overview")).toBe(1);
    expect(server.count("/api/alerts")).toBeGreaterThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// SSE transport (§7)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("sse transport", () => {
  test("a valid tick takes authority, fetches active + bootstrap, transport becomes sse", async () => {
    FakeEventSource.reset();
    const { store, server, sched, live } = harness({ transport: "sse", eventSourceFactory: esFactory, activeView: () => "alerts" });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 5) }));
    server.script("/api/alerts", () => ok200({ a: 1 }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 5) }));

    expect(FakeEventSource.instances.length).toBe(1); // opened immediately, no polling yet
    FakeEventSource.last().emitTick(observation(GEN_A, 5), { overview: hash("b"), alerts: hash("d"), estate: hash("e"), engine: hash("f"), timeline: hash("0") });
    await flush();
    live.stop();

    expect(store.connection.value.transport).toBe("sse");
    expect(store.connection.value.observation?.seq).toBe(5);
    expect(server.count("/api/overview")).toBe(1); // bootstrap
    expect(server.count("/api/alerts")).toBe(1); // active
    expect(store.alerts.value as unknown).toEqual({ a: 1 });
  });

  test("stream failure falls back to polling immediately and reconnects at 10/20/40/60s", async () => {
    FakeEventSource.reset();
    const { server, sched, live } = harness({
      transport: "sse",
      eventSourceFactory: esFactory,
      activeView: () => "overview",
      intervalMs: 1_000_000, // keep periodic polling out of the reconnect windows
      staleMs: 1_000_000,
    });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));

    // Establish authority, then fail: fallback poll fires immediately (a request is made).
    FakeEventSource.last().emitTick(observation(GEN_A, 1), identitiesAll(hash("b")));
    await flush();
    FakeEventSource.last().emitError();
    await flush();
    const pollCallsRightAfterFailure = server.count("/api/overview");
    await sched.advance(0); // the immediate fallback poll
    expect(server.count("/api/overview")).toBeGreaterThan(pollCallsRightAfterFailure);

    const before = FakeEventSource.instances.length;
    await sched.advance(9_999);
    expect(FakeEventSource.instances.length).toBe(before); // not yet
    await sched.advance(1); // 10s → reconnect
    expect(FakeEventSource.instances.length).toBe(before + 1);

    FakeEventSource.last().emitError();
    await flush();
    await sched.advance(19_999);
    expect(FakeEventSource.instances.length).toBe(before + 1);
    await sched.advance(1); // 20s
    expect(FakeEventSource.instances.length).toBe(before + 2);

    FakeEventSource.last().emitError();
    await flush();
    await sched.advance(40_000); // 40s
    expect(FakeEventSource.instances.length).toBe(before + 3);

    FakeEventSource.last().emitError();
    await flush();
    await sched.advance(60_000); // 60s
    expect(FakeEventSource.instances.length).toBe(before + 4);

    FakeEventSource.last().emitError();
    await flush();
    await sched.advance(60_000); // stays at 60s
    expect(FakeEventSource.instances.length).toBe(before + 5);

    live.stop();
  });

  test("a valid tick resets the reconnect backoff to 10s", async () => {
    FakeEventSource.reset();
    const { sched, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    // Drive the backoff out to 60s, then deliver a valid tick and fail again.
    FakeEventSource.last().emitError(); await flush();
    await sched.advance(10_000); // reconnect #1
    FakeEventSource.last().emitError(); await flush();
    await sched.advance(20_000); // reconnect #2
    FakeEventSource.last().emitError(); await flush();
    await sched.advance(40_000); // reconnect #3 (backoff now at 60s)

    const n = FakeEventSource.instances.length;
    FakeEventSource.last().emitTick(observation(GEN_A, 1), identitiesAll(hash("b"))); // valid tick → reset
    await flush();
    FakeEventSource.last().emitError(); await flush();
    await sched.advance(9_999);
    expect(FakeEventSource.instances.length).toBe(n); // reconnect is back to a 10s wait
    await sched.advance(1);
    expect(FakeEventSource.instances.length).toBe(n + 1);
    live.stop();
  });

  test("a malformed tick is a protocol failure: fall back to polling, retain last-good", async () => {
    FakeEventSource.reset();
    const { store, server, sched, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 3) }));
    FakeEventSource.last().emitTick(observation(GEN_A, 3), identitiesAll(hash("b")));
    await flush();
    expect(store.connection.value.transport).toBe("sse");

    FakeEventSource.last().emitRaw("{ this is not json"); // malformed → protocol failure
    await flush();
    expect(FakeEventSource.last().closed).toBe(true); // stream torn down
    await sched.advance(0); // immediate fallback poll
    expect(server.count("/api/overview")).toBeGreaterThan(0);
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"o":1}'); // last-good retained
    live.stop();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// auto transport (§7)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("auto transport", () => {
  test("uses SSE when a factory exists", async () => {
    FakeEventSource.reset();
    const { live } = harness({ transport: "auto", eventSourceFactory: esFactory });
    expect(FakeEventSource.instances.length).toBe(1);
    live.stop();
  });

  test("polls when no EventSource factory exists", async () => {
    FakeEventSource.reset();
    const { server, sched, live } = harness({ transport: "auto", eventSourceFactory: null, activeView: () => "overview" });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    await sched.advance(0);
    live.stop();
    expect(FakeEventSource.instances.length).toBe(0);
    expect(server.count("/api/overview")).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Acceptance / race matrix (§8)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("tick/fetch acceptance", () => {
  test("new generation with a LOWER sequence is accepted and revalidates the active view", async () => {
    FakeEventSource.reset();
    const { store, server, sched, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    server.script("/api/overview",
      () => ok200({ gen: "A" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 10_000) }),
      () => ok200({ gen: "B" }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_B, 1) }),
    );

    FakeEventSource.last().emitTick(observation(GEN_A, 10_000), identitiesAll(hash("b")));
    await flush();
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"gen":"A"}');
    expect(store.connection.value.observation?.generation).toBe(GEN_A);

    // Same app version, brand-new generation, sequence falls 10000 → 1 (§4 restart). Accepted.
    FakeEventSource.last().emitTick(observation(GEN_B, 1), identitiesAll(hash("d")));
    await flush();
    live.stop();

    expect(store.snapshot.value?.estate.name).toBe('fixture:{"gen":"B"}');
    expect(store.connection.value.observation?.generation).toBe(GEN_B);
    expect(store.connection.value.observation?.seq).toBe(1);
  });

  test("a duplicate/late tick (same generation, seq <= controlSeq) is ignored", async () => {
    FakeEventSource.reset();
    const { store, server, sched, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    server.script("/api/overview",
      () => ok200({ seq: 5 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 5) }),
    );
    FakeEventSource.last().emitTick(observation(GEN_A, 5), identitiesAll(hash("b")));
    await flush();
    const callsAfterFirst = server.count("/api/overview");

    // A stale duplicate at seq 3 (< 5): ignored, no refetch, observation stays at 5.
    FakeEventSource.last().emitTick(observation(GEN_A, 3), identitiesAll(hash("z")));
    await flush();
    live.stop();

    expect(server.count("/api/overview")).toBe(callsAfterFirst);
    expect(store.connection.value.observation?.seq).toBe(5);
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"seq":5}');
  });

  test("a stale (older) HTTP response is rejected and refetched, never resurrecting old state", async () => {
    FakeEventSource.reset();
    const { store, server, sched, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "alerts",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 9) }));
    // The active alerts view: first response is an OLD one (seq 4, old identity), then the correct one.
    server.script("/api/alerts",
      () => ok200({ old: true }, { etag: hash("1"), payloadId: hash("2"), obs: observation(GEN_A, 4) }),
      () => ok200({ current: true }, { etag: hash("3"), payloadId: hash("9"), obs: observation(GEN_A, 9) }),
    );

    FakeEventSource.last().emitTick(observation(GEN_A, 9), { overview: hash("b"), alerts: hash("9"), estate: hash("e"), engine: hash("f"), timeline: hash("0") });
    await flush();
    live.stop();

    // The older alerts response (seq 4, identity != desired hash("9")) was rejected and refetched.
    expect(store.alerts.value as unknown).toEqual({ current: true });
    expect(server.count("/api/alerts")).toBe(2);
  });

  test("SSE takeover invalidates a pending poll response", async () => {
    FakeEventSource.reset();
    const { store, server, sched, live } = harness({
      transport: "auto", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    // Force a fallback-poll window first: fail the stream, then a poll is in flight, then a tick.
    FakeEventSource.last().emitError();
    await flush();
    // Script the fallback poll's overview to a value we will assert is NOT what wins.
    server.script("/api/overview", () => ok200({ from: "poll" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    // reconnect at 10s creates a fresh ES; deliver a tick on it (takeover) then serve the SSE fetch.
    await sched.advance(10_000);
    server.script("/api/overview", () => ok200({ from: "sse" }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 7) }));
    FakeEventSource.last().emitTick(observation(GEN_A, 7), identitiesAll(hash("d")));
    await flush();
    live.stop();

    expect(store.connection.value.transport).toBe("sse");
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"from":"sse"}');
    expect(store.connection.value.observation?.seq).toBe(7);
  });

  test("a generation mismatch from a view GET while SSE controls triggers a stream reconnect", async () => {
    FakeEventSource.reset();
    const { server, sched, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    // Tick establishes generation A; the overview GET returns a DIFFERENT generation B.
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_B, 2) }));
    const openedBefore = FakeEventSource.instances.length;
    FakeEventSource.last().emitTick(observation(GEN_A, 1), identitiesAll(hash("b")));
    await flush();
    live.stop();

    // The mismatched view GET did not switch generation; it forced a serialized stream reconnect.
    expect(FakeEventSource.instances.length).toBe(openedBefore + 1);
  });

  test("a new generation with an EQUAL sequence is accepted (generation-first, not ignored as a duplicate)", async () => {
    FakeEventSource.reset();
    const { store, server, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    server.script("/api/overview",
      () => ok200({ gen: "A" }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 5) }),
      () => ok200({ gen: "B" }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_B, 5) }),
    );

    FakeEventSource.last().emitTick(observation(GEN_A, 5), identitiesAll(hash("b")));
    await flush();
    expect(store.connection.value.observation?.generation).toBe(GEN_A);

    // Different generation, SAME seq (5): the generation-first check accepts it as a reset — the
    // `seq <= controlSeq` duplicate rule only applies WITHIN a generation, so seq 5 == 5 is NOT ignored.
    FakeEventSource.last().emitTick(observation(GEN_B, 5), identitiesAll(hash("d")));
    await flush();
    live.stop();

    expect(store.connection.value.observation?.generation).toBe(GEN_B);
    expect(store.connection.value.observation?.seq).toBe(5);
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"gen":"B"}');
  });

  test("a newer view response is accepted before its own tick, advancing observation past the control cursor", async () => {
    FakeEventSource.reset();
    const { store, server, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    // The control tick is at seq 5, but the view GET it triggers returns a NEWER observation (seq 6) —
    // a newer cycle published between tick and fetch. §8: "a newer response may be accepted before its tick."
    server.script("/api/overview", () => ok200({ newer: true }, { etag: hash("a"), payloadId: hash("6"), obs: observation(GEN_A, 6) }));
    FakeEventSource.last().emitTick(observation(GEN_A, 5), identitiesAll(hash("5")));
    await flush();
    live.stop();

    // The highest accepted observation advanced to seq 6 from the HTTP response even though the control
    // tick only reached seq 5 (the control-tick cursor is kept separate from highest-HTTP observation).
    expect(store.connection.value.observation?.seq).toBe(6);
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"newer":true}');
  });

  test("token supersession: an older in-flight same-view request cannot overwrite the newer one", async () => {
    FakeEventSource.reset();
    const store = createAppStore({ storage: null, initialQuery: {} });
    const sched = new Scheduler();
    // A manual-release fetch: every call parks its resolver so the test settles them out of order.
    const pending: Array<{ path: string; resolve: (r: Response) => void }> = [];
    const gatedFetch = ((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const path = url.split("?", 1)[0] ?? url;
      return new Promise<Response>((resolve) => { pending.push({ path, resolve }); });
    }) as unknown as typeof fetch;

    const live = startLiveState(store, {
      transport: "sse", eventSourceFactory: esFactory, fetchImpl: gatedFetch,
      setTimer: sched.setTimer, clearTimer: sched.clearTimer, now: sched.nowFn,
      activeView: () => "overview", intervalMs: 1_000_000, staleMs: 1_000_000, reload: () => {},
    });

    // Tick 1 (seq 5, identity "1") issues overview fetch token 1 — it hangs, unresolved.
    FakeEventSource.last().emitTick(observation(GEN_A, 5), identitiesAll(hash("1")));
    await flush();
    // Tick 2 (seq 6, identity "2") supersedes: it re-issues overview fetch token 2 (same epoch — SSE is
    // already authoritative, so this is token supersession, not an epoch bump).
    FakeEventSource.last().emitTick(observation(GEN_A, 6), identitiesAll(hash("2")));
    await flush();

    const overviewCalls = pending.filter((p) => p.path === "/api/overview");
    expect(overviewCalls.length).toBe(2); // two same-view requests in flight

    // Settle the NEWER request (token 2) first — it wins and writes identity "2".
    overviewCalls[1]?.resolve(ok200(overviewFixture({ from: "token2" }), { etag: hash("e"), payloadId: hash("2"), obs: observation(GEN_A, 6) }));
    await flush();
    // Then settle the OLDER request (token 1) — its callback is superseded (myToken !== requestTokens) and
    // must NOT resurrect the stale payload.
    overviewCalls[0]?.resolve(ok200(overviewFixture({ from: "token1" }), { etag: hash("a"), payloadId: hash("1"), obs: observation(GEN_A, 5) }));
    await flush();
    live.stop();

    expect(store.snapshot.value?.estate.name).toBe('fixture:{"from":"token2"}');
    expect(store.connection.value.observation?.seq).toBe(6);
  });

  test("poll-mode same-version restart accepts a new generation even with a lower sequence (§9)", async () => {
    const { store, server, sched, live } = harness({
      transport: "poll", activeView: () => "overview", intervalMs: 10_000, staleMs: 1_000_000,
    });
    // The poll active-view GET is the control channel. Poll 1: generation A at a high sequence. Poll 2:
    // a same-version RESTART — brand-new generation B whose sequence falls 10000 → 1. §9: the poll
    // control channel accepts the reset and discards old state (no SSE tick is involved here).
    server.script("/api/overview",
      () => ok200({ gen: "A" }, { etag: hash("1"), payloadId: hash("a"), obs: observation(GEN_A, 10_000) }),
      () => ok200({ gen: "B" }, { etag: hash("2"), payloadId: hash("c"), obs: observation(GEN_B, 1) }),
    );

    await sched.advance(0); // poll 1 → gen A seq 10000
    expect(store.connection.value.observation?.generation).toBe(GEN_A);
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"gen":"A"}');

    await sched.advance(10_000); // poll 2 → gen B seq 1 (restart, lower seq)
    live.stop();

    expect(store.connection.value.observation?.generation).toBe(GEN_B);
    expect(store.connection.value.observation?.seq).toBe(1);
    expect(store.snapshot.value?.estate.name).toBe('fixture:{"gen":"B"}'); // the restart payload won
  });

  test("an advancing tick whose active-view identity is UNCHANGED refetches nothing (unchanged identities do not fetch)", async () => {
    FakeEventSource.reset();
    const { store, server, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview",
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 5) }));

    // Tick 1 (seq 5) establishes overview at identity "b" and fetches it once.
    FakeEventSource.last().emitTick(observation(GEN_A, 5), identitiesAll(hash("b")));
    await flush();
    expect(server.count("/api/overview")).toBe(1);

    // Tick 2 (seq 6) advances the observation, but every view identity is UNCHANGED ("b"): the active
    // overview does not need a refetch (§8.5), so NO new request is issued even though the cursor moved.
    FakeEventSource.last().emitTick(observation(GEN_A, 6), identitiesAll(hash("b")));
    await flush();
    live.stop();

    expect(server.count("/api/overview")).toBe(1); // unchanged identity → no fetch (only 304 polls are conditional)
    expect(store.connection.value.observation?.seq).toBe(6); // the observation still advanced
    expect(store.connection.value.views.overview.phase).toBe("current");
    expect(store.connection.value.views.overview.identity).toBe(hash("b"));
  });

  test("a tick advancing an INACTIVE view's desired identity marks it stale without refetching it (§8.4)", async () => {
    FakeEventSource.reset();
    let active: ViewId = "alerts";
    const { store, server, live } = harness({
      transport: "sse", eventSourceFactory: esFactory, activeView: () => active,
      intervalMs: 1_000_000, staleMs: 1_000_000,
    });
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 5) }));
    server.script("/api/alerts", () => ok200({ a: 1 }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 5) }));

    // Tick 1 (seq 5): alerts is the active view → fetched and delivered current at identity "d".
    FakeEventSource.last().emitTick(observation(GEN_A, 5), { overview: hash("b"), alerts: hash("d"), estate: hash("e"), engine: hash("f"), timeline: hash("0") });
    await flush();
    expect(store.connection.value.views.alerts.phase).toBe("current");
    expect(server.count("/api/alerts")).toBe(1);

    // Navigate away, then Tick 2 (seq 6) advances the alerts DESIRED identity ("7") while overview is
    // active. alerts is inactive so it is not refetched — its accepted identity ("d") no longer matches
    // the desired one, so its delivery state is stale, retaining the old identity: never resurrected healthy.
    active = "overview";
    FakeEventSource.last().emitTick(observation(GEN_A, 6), { overview: hash("b"), alerts: hash("7"), estate: hash("e"), engine: hash("f"), timeline: hash("0") });
    await flush();
    live.stop();

    expect(server.count("/api/alerts")).toBe(1); // inactive → not refetched
    expect(store.connection.value.views.alerts.phase).toBe("stale");
    expect(store.connection.value.views.alerts.identity).toBe(hash("d")); // old identity retained, not advanced to "7"
    expect(store.alerts.value as unknown).toEqual({ a: 1 }); // last-good payload retained, not cleared
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// stop() cleanup + shared reload guard (§7, AC-4)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("stop() and reload guard", () => {
  test("stop() closes the stream, clears every timer, and is idempotent", async () => {
    FakeEventSource.reset();
    const { sched, live } = harness({ transport: "sse", eventSourceFactory: esFactory, activeView: () => "overview" });
    FakeEventSource.last().emitError(); // schedule a reconnect timer + fallback poll timer
    await flush();
    expect(sched.pendingCount()).toBeGreaterThan(0);

    live.stop();
    expect(FakeEventSource.last().closed).toBe(true);
    expect(sched.pendingCount()).toBe(0); // no timer left alive
    expect(() => live.stop()).not.toThrow(); // idempotent
  });

  test("a superseded fetch callback cannot write after stop() (stop race)", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const server = makeServer();
    const sched = new Scheduler();
    let release: () => void = () => {};
    // A poll fetch that hangs until we release it — so we can stop() mid-flight.
    server.script("/api/overview", () =>
      new Response(JSON.stringify({ o: 1 }), {
        status: 200,
        headers: { etag: `"${hash("a")}"`, "x-pulse-payload-id": hash("b"), "x-pulse-observation": encodeObs(observation(GEN_A, 1)) },
      }),
    );
    const slowFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return server.fetchImpl(input, init);
    }) as unknown as typeof fetch;

    const live = startLiveState(store, {
      transport: "poll", fetchImpl: slowFetch, setTimer: sched.setTimer, clearTimer: sched.clearTimer,
      now: sched.nowFn, activeView: () => "overview", reload: () => {},
    });
    await sched.advance(0); // starts the hanging fetch
    live.stop(); // supersede via epoch bump before the fetch resolves
    release();
    await flush();

    expect(store.snapshot.value).toBeNull(); // the late callback did not write
    expect(store.connection.value.transport).toBe("poll");
  });

  test("app-version change and the dev build-id check share one reload-once guard", async () => {
    FakeEventSource.reset();
    const store = createAppStore({ storage: null, initialQuery: {} });
    const server = makeServer();
    const sched = new Scheduler();
    let reloads = 0;

    // SSE with a version change AND a dev build check both firing → still exactly one reload.
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1, { appVersion: "1.0.0" }) }));
    const live = startLiveState(store, {
      transport: "sse", eventSourceFactory: esFactory, fetchImpl: server.fetchImpl,
      setTimer: sched.setTimer, clearTimer: sched.clearTimer, now: sched.nowFn,
      activeView: () => "overview", devBuildCheck: { buildId: "shell-v1" }, reload: () => { reloads += 1; },
    });

    FakeEventSource.last().emitTick(observation(GEN_A, 1, { appVersion: "1.0.0" }), identitiesAll(hash("b")));
    await flush();
    // A later generation with a DIFFERENT app version → reload.
    FakeEventSource.last().emitTick(observation(GEN_B, 1, { appVersion: "2.0.0" }), identitiesAll(hash("b")));
    await flush();
    // The dev build-id loop would also fire (server returns "shell-v0" ≠ "shell-v1") — same guard.
    await sched.advance(DEV_BUILD_CHECK_INTERVAL_MS + 10);
    live.stop();

    expect(reloads).toBe(1);
  });

  test("reloadOnce() is exposed and fires at most once", () => {
    const { live } = harness({ transport: "poll", activeView: () => "overview" });
    let n = 0;
    const store2 = createAppStore({ storage: null, initialQuery: {} });
    const sched = new Scheduler();
    const live2 = startLiveState(store2, {
      transport: "poll", fetchImpl: makeServer().fetchImpl, setTimer: sched.setTimer,
      clearTimer: sched.clearTimer, now: sched.nowFn, reload: () => { n += 1; },
    });
    live2.reloadOnce();
    live2.reloadOnce();
    live2.stop();
    live.stop();
    expect(n).toBe(1);
  });

  test("stop() unsubscribes the route listener: a later navigation triggers no fetch", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    const server = makeServer();
    const sched = new Scheduler();
    // Default (route-based) active-view resolution: a navigation changes which view the listener fetches.
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1) }));
    server.script("/api/alerts", () => ok200({ a: 1 }, { etag: hash("c"), payloadId: hash("d"), obs: observation(GEN_A, 1) }));
    const live = startLiveState(store, {
      transport: "poll", fetchImpl: server.fetchImpl, setTimer: sched.setTimer, clearTimer: sched.clearTimer,
      now: sched.nowFn, intervalMs: 1_000_000, staleMs: 1_000_000, reload: () => {},
    });

    await sched.advance(0); // bootstrap poll (route view "" → overview fallback control)

    // Pre-stop the listener is live: navigating fetches the newly-active view.
    store.route.value = { path: "/alerts", view: "alerts", params: {}, query: {} };
    await flush();
    expect(server.count("/api/alerts")).toBe(1);

    live.stop();

    // Post-stop the route subscription is removed: navigating to a fresh view fetches nothing.
    store.route.value = { path: "/estate", view: "estate", params: {}, query: {} };
    await flush();
    expect(server.count("/api/estate")).toBe(0);
  });

  test("the ViewHost chunk-mismatch reloadOnce shares the guard with the app-version reload", async () => {
    FakeEventSource.reset();
    const store = createAppStore({ storage: null, initialQuery: {} });
    const server = makeServer();
    const sched = new Scheduler();
    let reloads = 0;
    server.script("/api/overview", () => ok200({ o: 1 }, { etag: hash("a"), payloadId: hash("b"), obs: observation(GEN_A, 1, { appVersion: "1.0.0" }) }));
    const live = startLiveState(store, {
      transport: "sse", eventSourceFactory: esFactory, fetchImpl: server.fetchImpl,
      setTimer: sched.setTimer, clearTimer: sched.clearTimer, now: sched.nowFn,
      activeView: () => "overview", reload: () => { reloads += 1; }, intervalMs: 1_000_000, staleMs: 1_000_000,
    });

    // Establish the initial app version, then a new generation with a DIFFERENT version reloads once.
    FakeEventSource.last().emitTick(observation(GEN_A, 1, { appVersion: "1.0.0" }), identitiesAll(hash("b")));
    await flush();
    FakeEventSource.last().emitTick(observation(GEN_B, 1, { appVersion: "2.0.0" }), identitiesAll(hash("b")));
    await flush();
    expect(reloads).toBe(1);

    // ViewHost now detects a chunk mismatch and calls the same shared reloadOnce — the guard already
    // fired, so it is a silent no-op (all three paths converge on one reload).
    live.reloadOnce();
    live.stop();
    expect(reloads).toBe(1);
  });
});
