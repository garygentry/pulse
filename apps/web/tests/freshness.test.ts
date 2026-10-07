// apps/web/tests/freshness.test.ts — the shell freshness-consumer migration
// (08-events-live-state-and-freshness-migration.md §10; item 048).
//
// Proves the LiveStatusPill/StaleDataWarning consumers read currentness and per-source state from
// `connection.observation` (never a payload's material `generatedAt`/`snapshot.sources`), and that the
// §10 regression list holds: unchanged healthy cycles stay current, failed→recovered sources degrade
// then clear, due-only slow timestamps do not warn while current, a stalled repeated 304 turns the
// connection stale, a tick advancing before a failed view fetch leaves the view stale (never healthy),
// and source freshness still shows when the overview view is inactive.
//
// Component/consumer cases use describeDom (per-file happy-dom). Two machine-outcome cases drive the
// real `startLiveState` with a deterministic fake scheduler + scripted fetch/EventSource.

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import type { ReactElement } from "react";

import type {
  CycleObservation,
  HashId,
  SourceId,
  SourceObservation,
  ViewDeliveryState,
  ViewId,
} from "@pulse/web-data/wire";
// GEN_A is the single process generation the machine-outcome fixtures reuse.

import { DEV_BUILD_ID_PATH } from "../src/client/api/client.js";
import { createAppStore, type AppStore } from "../src/client/store/index.js";
import {
  startLiveState,
  type EventSourceFactory,
  type LiveEventSource,
  type LiveMessageEvent,
  type LiveStateHandle,
  type LiveStateOptions,
} from "../src/client/store/live-state.js";
import type { ConnectionState } from "../src/client/store/types.js";
import { createEstateClock, TZ_FALLBACK_MARKER, type EstateClock } from "../src/client/format.js";
import { LiveStatusPill } from "../src/client/shell/HealthRegion.js";
import { StaleDataCallout, StaleDataWarning } from "../src/client/shell/StaleDataCallout.js";
import { describeDom } from "./dom.js";
import { overviewSnapshot } from "./factories/wire.js";
import { act } from "./react-render.js";

// ── Fixtures ───────────────────────────────────────────────────────────────────────────────────────

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals", "victoriametrics-targets", "victoriametrics-buildinfo",
  "alertmanager-alerts", "alertmanager-silences", "alertmanager-status",
  "alertmanager-receivers", "vmalert-rules", "gatus-statuses", "grafana-health",
];

/** Two fixed instants in the estate zone (America/Chicago, CDT = UTC−5): 07:00:00 and 07:05:00. */
const T0 = "2026-08-22T12:00:00.000Z";
const T5 = "2026-08-22T12:05:00.000Z";

const ESTATE = { name: "home-estate", timezone: "America/Chicago", tzFallback: false } as const;
const CLOCK: EstateClock = createEstateClock(ESTATE);

const GEN_A = "11111111-1111-4111-8111-111111111111";

/** A per-source observation; defaults to a fresh success at T0. */
function srcObs(over: Partial<SourceObservation> = {}): SourceObservation {
  return { state: "current", lastAttemptAt: T0, lastSuccess: T0, ...over };
}

/** A cycle observation: all ten sources current at T0 unless overridden. */
function observation(
  over: { observedAt?: string; generation?: string; seq?: number; sources?: Partial<Record<SourceId, SourceObservation>> } = {},
): CycleObservation {
  const sources = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) sources[id] = srcObs();
  for (const [id, obs] of Object.entries(over.sources ?? {})) sources[id as SourceId] = obs as SourceObservation;
  return {
    generation: over.generation ?? GEN_A,
    seq: over.seq ?? 1,
    observedAt: over.observedAt ?? T0,
    appVersion: "0.0.0-dev",
    sources,
  };
}

const INITIAL_VIEW: ViewDeliveryState = { phase: "initial", identity: null, failure: null };

/** A full ConnectionState; defaults to a healthy live poll connection with no observation. */
function conn(over: Partial<ConnectionState> = {}): ConnectionState {
  return {
    phase: "live",
    transport: "poll",
    lastGoodAt: Date.parse(T0),
    failingSince: null,
    seq: 1,
    observation: null,
    views: {
      overview: INITIAL_VIEW, alerts: INITIAL_VIEW, estate: INITIAL_VIEW,
      engine: INITIAL_VIEW, timeline: INITIAL_VIEW,
    },
    ...over,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// LiveStatusPill — currentness from the cycle observation (§10, AC1)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describeDom("LiveStatusPill — observedAt currentness", (dom) => {
  async function textOf(connection: ConnectionState): Promise<{ text: string; status: string | null; unmount(): void }> {
    const { container, unmount } = await dom.mount(
      createElement(LiveStatusPill, { connection, clock: CLOCK }) as ReactElement,
    );
    const el = container.querySelector('[data-slot="staleness-indicator"]');
    return { text: el?.textContent ?? "", status: el?.getAttribute("data-status") ?? null, unmount };
  }

  test("shows the cycle observation's observedAt (not a payload generatedAt)", async () => {
    const { text, status, unmount } = await textOf(conn({ observation: observation({ observedAt: T5 }) }));
    expect(text).toContain("Updated");
    expect(text).toContain("07:05:00"); // T5 in the estate zone
    expect(text).toContain("CDT");
    expect(status).toBe("ok");
    unmount();
  });

  test("stays current across unchanged healthy cycles — the advancing observedAt is displayed", async () => {
    // Cycle N: observedAt T0. Cycle N+K (same identities, a plain 304/tick): observedAt advanced to T5.
    const first = await textOf(conn({ observation: observation({ seq: 1, observedAt: T0 }) }));
    expect(first.text).toContain("07:00:00");
    first.unmount();

    const later = await textOf(conn({ observation: observation({ seq: 9, observedAt: T5 }) }));
    expect(later.text).toContain("07:05:00"); // currentness advanced without any payload change
    expect(later.status).toBe("ok");
    later.unmount();
  });

  test('a stalled connection is critical even though a payload is still on screen', async () => {
    const { status, unmount } = await textOf(conn({ phase: "stale", observation: observation({ observedAt: T0 }) }));
    expect(status).toBe("critical");
    unmount();
  });

  test("waits for the first update when no observation has arrived", async () => {
    const { text, unmount } = await textOf(conn({ observation: null }));
    expect(text).toContain("Waiting for first update…");
    expect(text).not.toContain("Updated");
    unmount();
  });

  test("surfaces the tz-fallback marker when the estate clock is UTC", async () => {
    const utcClock = createEstateClock({ name: "e", timezone: "UTC", tzFallback: true });
    const { container, unmount } = await dom.mount(
      createElement(LiveStatusPill, { connection: conn({ observation: observation() }), clock: utcClock }) as ReactElement,
    );
    expect(container.textContent).toContain(TZ_FALLBACK_MARKER);
    unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// StaleDataWarning — per-source freshness from the observation (§10, AC2)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describeDom("StaleDataWarning — observation.sources drive the warning", (dom) => {
  async function render(connection: ConnectionState): Promise<{ el: Element | null; unmount(): void }> {
    const { container, unmount } = await dom.mount(
      createElement(StaleDataWarning, { connection, clock: CLOCK }) as ReactElement,
    );
    return { el: container.querySelector("[data-stale-warning]"), unmount };
  }

  test("renders nothing when every source is current and the connection is live", async () => {
    const { el, unmount } = await render(conn({ observation: observation() }));
    expect(el).toBeNull();
    unmount();
  });

  test("a stale governing source warns with its label and last-good time", async () => {
    const { el, unmount } = await render(
      conn({ observation: observation({ sources: { "alertmanager-alerts": srcObs({ state: "stale", lastSuccess: T0 }) } }) }),
    );
    expect(el).not.toBeNull();
    expect(el!.getAttribute("role")).toBe("alert");
    const line = el!.querySelector('[data-source="alerts"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain('Source "alerts" unreachable');
    expect(line!.textContent).toContain(CLOCK.format(T0));
    unmount();
  });

  test("an unavailable source with no prior success shows 'never'", async () => {
    const { el, unmount } = await render(
      conn({ observation: observation({ sources: { "victoriametrics-signals": srcObs({ state: "unavailable", lastSuccess: null }) } }) }),
    );
    const line = el!.querySelector('[data-source="metrics"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("never");
    unmount();
  });

  test("current and not-configured sources never warn (due-only slow timestamps do not degrade)", async () => {
    // Grafana is a slow/optional source: not-configured must not warn; and a still-current slow source
    // whose lastSuccess lags the fast cycle observedAt must not warn either.
    const { el, unmount } = await render(
      conn({
        observation: observation({
          observedAt: T5, // fast cycle advanced
          sources: {
            "grafana-health": srcObs({ state: "not-configured", lastAttemptAt: null, lastSuccess: null }),
            "victoriametrics-buildinfo": srcObs({ state: "current", lastAttemptAt: T0, lastSuccess: T0 }), // slow, still current
          },
        }),
      }),
    );
    expect(el).toBeNull();
    unmount();
  });

  test("failure then recovery — the warning appears while stale, then clears when current again", async () => {
    const failing = await render(
      conn({ observation: observation({ sources: { "gatus-statuses": srcObs({ state: "unavailable", lastSuccess: T0 }) } }) }),
    );
    expect(failing.el).not.toBeNull();
    expect(failing.el!.querySelector('[data-source="checks"]')).not.toBeNull();
    failing.unmount();

    const recovered = await render(conn({ observation: observation({ observedAt: T5 }) })); // all current again
    expect(recovered.el).toBeNull();
    recovered.unmount();
  });

  test("app-server refresh failure names the last-good and the last good data time (observedAt)", async () => {
    const { el, unmount } = await render(
      conn({ phase: "stale", lastGoodAt: Date.parse(T0), observation: observation({ observedAt: T0 }) }),
    );
    const line = el!.querySelector('[data-source="app"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain("app server unreachable");
    expect(line!.textContent).toContain(`Showing last good data from ${CLOCK.format(T0)}`);
    unmount();
  });

  test("app-server stale before any cycle — 'since never', no last-good suffix, no source lines", async () => {
    // phase stale with no prior success AND no observation: the app line's lastGoodAt-null and
    // observation-null branches, and the per-source loop is skipped entirely (observation === null).
    const { el, unmount } = await render(conn({ phase: "stale", lastGoodAt: null, observation: null }));
    const app = el!.querySelector('[data-source="app"]');
    expect(app).not.toBeNull();
    expect(app!.textContent).toContain("app server unreachable since never");
    expect(app!.textContent).not.toContain("Showing last good data"); // observation null → no suffix
    expect(el!.querySelectorAll("[data-source]")).toHaveLength(1); // only the app line
    unmount();
  });

  test("a stale connection and a stale source render both the app line and the source line", async () => {
    // A compound outage: the stale phase must NOT suppress the per-source warning; the two
    // independent line generators compose in order (app first, then governing sources).
    const { el, unmount } = await render(
      conn({
        phase: "stale",
        lastGoodAt: Date.parse(T0),
        observation: observation({
          observedAt: T0,
          sources: { "gatus-statuses": srcObs({ state: "stale", lastSuccess: T0 }) },
        }),
      }),
    );
    const sources = Array.from(el!.querySelectorAll("[data-source]")).map((l) =>
      l.getAttribute("data-source"),
    );
    expect(sources).toEqual(["app", "checks"]);
    expect(el!.querySelector('[data-source="app"]')!.textContent).toContain("Showing last good data");
    expect(el!.querySelector('[data-source="checks"]')!.textContent).toContain('Source "checks" unreachable');
    unmount();
  });

  test("overview inactive (clock null) still warns, formatting last-good as the raw ISO fallback", async () => {
    // With no snapshot the estate clock is null; the warning must still render from the observation
    // (AC2 "remain correct when overview is inactive") and fall back to the raw ISO for last-good.
    const { container, unmount } = await dom.mount(
      createElement(StaleDataWarning, {
        connection: conn({
          observation: observation({
            sources: { "victoriametrics-signals": srcObs({ state: "unavailable", lastSuccess: T0 }) },
          }),
        }),
        clock: null,
      }) as ReactElement,
    );
    const line = container.querySelector('[data-stale-warning] [data-source="metrics"]');
    expect(line).not.toBeNull();
    expect(line!.textContent).toContain(T0); // raw ISO, not the estate-zone formatted time…
    expect(line!.textContent).not.toContain("07:00:00"); // …which the CLOCK path would have produced
    unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Shell composition — inactive overview still shows source freshness (§10, AC2)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describeDom("StaleDataCallout — source freshness independent of the overview payload", (dom) => {
  test("warns from connection.observation even when no overview snapshot is loaded (overview inactive)", async () => {
    const store = createAppStore({ storage: null, initialQuery: {} });
    // Overview view inactive: no snapshot has ever been written, so snapshot.sources is unavailable.
    expect(store.snapshot.peek()).toBeNull();
    store.connection.value = conn({
      observation: observation({ sources: { "alertmanager-alerts": srcObs({ state: "stale", lastSuccess: T0 }) } }),
    });

    const { container, unmount } = await dom.mount(
      createElement(StaleDataCallout, { store, clock: CLOCK }) as ReactElement,
    );
    const warning = container.querySelector("[data-stale-warning]");
    expect(warning).not.toBeNull();
    expect(warning!.querySelector('[data-source="alerts"]')).not.toBeNull();
    unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Machine outcomes — the connection freshness the consumers render (§10, AC3)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

interface Timer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/** Fake timer set + clock. `advance(ms)` fires due timers in (at, id) order, flushing microtasks. */
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
}

async function flush(): Promise<void> {
  // React runs non-urgent updates on a scheduler task; act() flushes them with the microtasks.
  await act(async () => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  });
}

function encodeObs(obs: unknown): string {
  return Buffer.from(JSON.stringify(obs)).toString("base64url");
}

function ok200(body: unknown, opts: { etag: HashId; payloadId: HashId; obs: CycleObservation }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      etag: `"${opts.etag}"`,
      "x-pulse-payload-id": opts.payloadId,
      "x-pulse-observation": encodeObs(opts.obs),
    },
  });
}

function notModified(opts: { payloadId: HashId; obs: CycleObservation }): Response {
  return new Response(null, {
    status: 304,
    headers: { "x-pulse-payload-id": opts.payloadId, "x-pulse-observation": encodeObs(opts.obs) },
  });
}

interface Server {
  readonly fetchImpl: typeof fetch;
  script(path: string, ...responses: Array<() => Response>): void;
  count(path: string): number;
}

function makeServer(): Server {
  const counts = new Map<string, number>();
  const scripts = new Map<string, Array<() => Response>>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.split("?", 1)[0] ?? url;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
    if (path === DEV_BUILD_ID_PATH) return new Response(JSON.stringify({ buildId: "shell-v0" }), { status: 200 });
    const queued = scripts.get(path)?.shift();
    if (queued !== undefined) return queued();
    return new Response(JSON.stringify({ code: "NOT_READY", message: "not ready" }), { status: 503 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    script(path, ...responses) {
      const q = scripts.get(path) ?? [];
      q.push(...responses);
      scripts.set(path, q);
    },
    count: (path) => counts.get(path) ?? 0,
  };
}

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
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: "tick" | "error", listener: (e: LiveMessageEvent) => void): void {
    if (type === "tick") this.tickListeners.push(listener);
  }
  close(): void {
    this.closed = true;
  }
  emitTick(obs: CycleObservation, identities: Record<ViewId, HashId>): void {
    const data = JSON.stringify({ observation: obs, identities });
    for (const l of this.tickListeners.slice()) l({ data });
  }
}

const esFactory: EventSourceFactory = (url) => new FakeEventSource(url);
const hash = (c: string): HashId => `sha256:${c.repeat(64)}` as HashId;
function identitiesAll(id: HashId): Record<ViewId, HashId> {
  return { overview: id, alerts: id, estate: id, engine: id, timeline: id };
}

function harness(over: Partial<LiveStateOptions> & Pick<LiveStateOptions, "transport">): {
  store: AppStore;
  server: Server;
  sched: Scheduler;
  live: LiveStateHandle;
} {
  const store = createAppStore({ storage: null, initialQuery: {} });
  const server = makeServer();
  const sched = new Scheduler();
  const live = startLiveState(store, {
    fetchImpl: server.fetchImpl,
    setTimer: sched.setTimer,
    clearTimer: sched.clearTimer,
    now: sched.nowFn,
    reload: () => {},
    ...over,
  });
  return { store, server, sched, live };
}

describe("live-state → connection freshness (machine outcomes)", () => {
  test("repeated 304 with a stalled observation turns the connection stale despite HTTP contact", async () => {
    const stalled = observation({ seq: 1, observedAt: T0 }); // never advances
    const { store, sched, server, live } = harness({
      transport: "poll",
      intervalMs: 10_000,
      staleMs: 30_000,
      activeView: () => "overview",
    });
    server.script(
      "/api/overview",
      () => ok200(overviewSnapshot({ estate: { name: "fixture:ov", timezone: "UTC", tzFallback: false } }), { etag: hash("a"), payloadId: hash("b"), obs: stalled }),
      () => notModified({ payloadId: hash("b"), obs: stalled }),
      () => notModified({ payloadId: hash("b"), obs: stalled }),
      () => notModified({ payloadId: hash("b"), obs: stalled }),
      () => notModified({ payloadId: hash("b"), obs: stalled }),
      () => notModified({ payloadId: hash("b"), obs: stalled }),
    );

    await sched.advance(0); // first poll → 200, observation seq 1
    expect(store.connection.value.phase).toBe("live");

    await sched.advance(45_000); // several 304s; observation never advances past its arrival at t=0
    live.stop();

    const c = store.connection.value;
    expect(c.observation?.seq).toBe(1); // stalled — never advanced
    expect(server.count("/api/overview")).toBeGreaterThan(1); // HTTP contact continued (304s)
    expect(c.phase).toBe("stale"); // …yet the connection went stale (§9/§10)
    expect(c.views.overview.phase).toBe("stale"); // the view is stale too, not silently current
  });

  test("a tick advancing desired before a failed view fetch leaves the view stale, never healthy", async () => {
    FakeEventSource.reset();
    const { store, sched, server, live } = harness({
      transport: "sse",
      staleMs: 10_000_000, // isolate the identity-mismatch path from any time-based staleness
      activeView: () => "overview",
      eventSourceFactory: esFactory,
    });
    // First tick (gen A, idA): the overview fetch succeeds → overview current at idA.
    server.script("/api/overview", () => ok200(overviewSnapshot({ estate: { name: "fixture:a", timezone: "UTC", tzFallback: false } }), { etag: hash("a"), payloadId: hash("a"), obs: observation({ seq: 1 }) }));
    FakeEventSource.last().emitTick(observation({ seq: 1 }), identitiesAll(hash("a")));
    await flush();
    await sched.advance(0);
    expect(store.connection.value.views.overview).toEqual({ phase: "current", identity: hash("a"), failure: null });

    // Second tick (gen A, idB) advances desired; the ensuing overview fetch FAILS (503).
    server.script("/api/overview", () => new Response(JSON.stringify({ code: "NOT_READY", message: "x" }), { status: 503 }));
    FakeEventSource.last().emitTick(observation({ seq: 2, observedAt: T5 }), identitiesAll(hash("b")));
    await flush();
    await sched.advance(0);
    live.stop();

    const view = store.connection.value.views.overview;
    expect(view.phase).toBe("stale"); // desired idB ≠ accepted idA and the fetch failed
    expect(view.identity).toBe(hash("a")); // retains the last good identity, never idB
    expect(view.identity).not.toBe(hash("b")); // the advancing header did not make it healthy
  });
});
