// apps/web/tests/events.test.ts — deterministic evidence for the SSE stream registry, the event-id
// grammar, and the `/api/events` route (08-events-live-state-and-freshness-migration.md §§2–5).
//
// The registry is driven with an injected fake timer (one shared heartbeat) and its `ReadableStream`
// bodies are read one enqueued frame at a time, so every assertion is deterministic — no real sleeps.
// A small runtime-integration block drives `createServerRuntime` against an on-disk bundle to prove
// exactly one tick is published per successful atomic cycle assignment and none before readiness.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createEventStreamRegistry,
  type EventStreamRegistry,
} from "../src/server/events/registry.js";
import {
  RETRY_FRAME,
  HEARTBEAT_FRAME,
  SSE_HEADERS,
  SSE_MAX_STREAMS,
  buildLiveTick,
  frameTick,
  parseEventId,
} from "../src/server/events/stream.js";
import { eventsRoute } from "../src/server/routes/events.js";
import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime } from "../src/server/refresh.js";
import type { RouteRequest, ServerContext } from "../src/shared/registry.js";
import {
  makeEstateBundleFixture,
  makeWebCoverageArtifact,
  makeWebFindingsArtifact,
  makeWebEstateModelV2,
  serializeArtifact,
} from "./factories/estate-bundle.js";
import type { CycleState } from "@pulse/web-data/cycle";
import type { CycleObservation, HashId, SourceId, SourceObservation, StreamRegistryEvent } from "@pulse/web-data/wire";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────────

const RETRY = new TextDecoder().decode(RETRY_FRAME);
const HEARTBEAT = new TextDecoder().decode(HEARTBEAT_FRAME);
const GEN_A = "11111111-1111-4111-8111-111111111111";
const GEN_B = "22222222-2222-4222-8222-222222222222";

const SOURCE_IDS: readonly SourceId[] = [
  "victoriametrics-signals",
  "victoriametrics-targets",
  "victoriametrics-buildinfo",
  "alertmanager-alerts",
  "alertmanager-silences",
  "alertmanager-status",
  "alertmanager-receivers",
  "vmalert-rules",
  "gatus-statuses",
  "grafana-health",
];

function sourceObservations(): Record<SourceId, SourceObservation> {
  const out = {} as Record<SourceId, SourceObservation>;
  for (const id of SOURCE_IDS) {
    out[id] = { state: "current", lastAttemptAt: "2026-09-17T00:00:00.000Z", lastSuccess: "2026-09-17T00:00:00.000Z" };
  }
  return out;
}

/** A valid `sha256:` identity built from a single hex nibble. */
function hid(nibble: string): HashId {
  return `sha256:${nibble.repeat(64).slice(0, 64)}` as HashId;
}

/** A minimal but strictly-valid `CycleState` — the registry reads only `observation` and each view's
 *  `.identity`, and `frameTick` validates the whole `LiveTick`, so the observation must carry all ten
 *  fixed sources and every identity must be a valid strong hash. */
function fakeCycle(generation: string, seq: number, observedAt = "2026-09-17T00:00:00.000Z"): CycleState {
  const observation: CycleObservation = {
    generation,
    seq,
    observedAt,
    appVersion: "test-1",
    sources: sourceObservations(),
  };
  const view = (id: HashId) => ({
    identity: id,
    value: {},
    plain: { etag: id, bytes: new Uint8Array() },
    gzip: { etag: id, bytes: new Uint8Array() },
  });
  return {
    observation,
    sources: {},
    overview: view(hid("a")),
    alerts: view(hid("b")),
    estate: view(hid("c")),
    engine: view(hid("d")),
    timeline: view(hid("e")),
  } as unknown as CycleState;
}

// ── One-pending fake timer (the single shared heartbeat) ──────────────────────────────────────────

function fakeTimer() {
  let pending: (() => void) | null = null;
  const setTimer = ((cb: () => void) => {
    pending = cb;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = (() => {
    pending = null;
  }) as unknown as typeof clearTimeout;
  return {
    setTimer,
    clearTimer,
    hasPending: () => pending !== null,
    fire() {
      const cb = pending;
      pending = null;
      if (cb === null) throw new Error("no pending heartbeat timer");
      cb();
    },
  };
}

// ── Frame reading (one enqueued chunk at a time; never blocks past what was enqueued) ──────────────

type Reader = ReadableStreamDefaultReader<Uint8Array>;

async function nextFrame(reader: Reader): Promise<{ done: boolean; text: string }> {
  const { value, done } = await reader.read();
  return { done, text: done || value === undefined ? "" : new TextDecoder().decode(value) };
}

// ── Route request helper ──────────────────────────────────────────────────────────────────────────

function routeReq(headers: Record<string, string> = {}): RouteRequest<"/api/events"> {
  let timeoutDisabled = false;
  const req = new Request("http://web:8080/api/events", { method: "GET", headers });
  return {
    request: req,
    params: {},
    routePattern: "/api/events",
    peerIp: null,
    disableTimeout() {
      timeoutDisabled = true;
      (req as unknown as { __timeoutDisabled: boolean }).__timeoutDisabled = timeoutDisabled;
    },
  };
}

// ── Registry lifecycle ─────────────────────────────────────────────────────────────────────────────

describe("event id grammar (§4)", () => {
  test("parses exact <UUID>:<positive-safe-integer> and rejects everything else", () => {
    expect(parseEventId(`${GEN_A}:1`)).toEqual({ generation: GEN_A, seq: 1 });
    expect(parseEventId(`${GEN_A}:9007199254740991`)).toEqual({ generation: GEN_A, seq: 9007199254740991 });
    // null / absent / malformed → null (converge, not error)
    expect(parseEventId(null)).toBeNull();
    expect(parseEventId("")).toBeNull();
    expect(parseEventId(GEN_A)).toBeNull(); // no sequence
    expect(parseEventId(`${GEN_A}:`)).toBeNull(); // empty sequence
    expect(parseEventId(`:5`)).toBeNull(); // empty generation
    expect(parseEventId("not-a-uuid:5")).toBeNull();
    expect(parseEventId(`${GEN_A}:0`)).toBeNull(); // not positive
    expect(parseEventId(`${GEN_A}:-1`)).toBeNull(); // sign rejected by strict digits
    expect(parseEventId(`${GEN_A}:1.5`)).toBeNull(); // decimal rejected
    expect(parseEventId(`${GEN_A}: 5`)).toBeNull(); // whitespace rejected
    expect(parseEventId(`${GEN_A}:9007199254740992`)).toBeNull(); // beyond safe integer
  });
});

describe("SSE framing (§2)", () => {
  test("retry and heartbeat frames are exact", () => {
    expect(RETRY).toBe("retry: 10000\n\n");
    expect(HEARTBEAT).toBe(": heartbeat\n\n");
  });

  test("the SSE response headers are exactly the §2 set", () => {
    expect(SSE_HEADERS).toEqual({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
  });

  test("a tick carries only the observation and five identities — no body, etag, history, or secret", () => {
    const cycle = fakeCycle(GEN_A, 7);
    const tick = buildLiveTick(cycle);
    expect(Object.keys(tick).sort()).toEqual(["identities", "observation"]);
    expect(Object.keys(tick.identities).sort()).toEqual(["alerts", "engine", "estate", "overview", "timeline"]);

    const frame = frameTick(cycle);
    expect(frame).not.toBeNull();
    const text = new TextDecoder().decode(frame!);
    expect(text.startsWith(`id: ${GEN_A}:7\nevent: tick\ndata: `)).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    const data = text.slice(text.indexOf("data: ") + 6, text.length - 2);
    const parsed = JSON.parse(data) as Record<string, unknown>;
    // The tick data is exactly the LiveTick — nothing more can leak through the frame.
    expect(Object.keys(parsed).sort()).toEqual(["identities", "observation"]);
    for (const forbidden of ["value", "plain", "gzip", "etag", "bytes", "history", "session"]) {
      expect(text).not.toContain(`"${forbidden}"`);
    }
  });
});

describe("connection framing & convergence (§3/§4)", () => {
  test("before the first publication a connection gets retry only — no invented tick", async () => {
    const reg = createEventStreamRegistry();
    const reader = reg.connect(null).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);
    expect(reg.count()).toBe(1);
    reg.close();
  });

  test("with a current cycle, an absent Last-Event-ID converges immediately (retry then current tick)", async () => {
    const reg = createEventStreamRegistry();
    reg.publish(fakeCycle(GEN_A, 3)); // establish current before connecting (no open streams yet)
    const reader = reg.connect(null).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);
    const tick = await nextFrame(reader);
    expect(tick.text).toContain(`id: ${GEN_A}:3`);
    expect(tick.text).toContain("event: tick");
    reg.close();
  });

  test("a Last-Event-ID equal to the current generation:sequence waits (retry only, no tick)", async () => {
    const reg = createEventStreamRegistry();
    reg.publish(fakeCycle(GEN_A, 5));
    const reader = reg.connect(`${GEN_A}:5`).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);
    // The next enqueued frame must be a fresh publication, NOT a convergence tick.
    reg.publish(fakeCycle(GEN_A, 6));
    expect((await nextFrame(reader)).text).toContain(`id: ${GEN_A}:6`);
    reg.close();
  });

  test.each([
    ["malformed", "garbage"],
    ["prior generation", `${GEN_B}:5`],
    ["lower sequence", `${GEN_A}:1`],
    ["higher sequence", `${GEN_A}:99`],
  ])("a %s Last-Event-ID converges immediately to current", async (_label, lastEventId) => {
    const reg = createEventStreamRegistry();
    reg.publish(fakeCycle(GEN_A, 5));
    const reader = reg.connect(lastEventId).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);
    expect((await nextFrame(reader)).text).toContain(`id: ${GEN_A}:5`);
    reg.close();
  });

  test("same-version restart (new generation, lower sequence) converges immediately", async () => {
    const reg = createEventStreamRegistry();
    // Client last saw GEN_A:10000; the process restarted under a NEW generation whose seq fell to 1.
    reg.publish(fakeCycle(GEN_B, 1));
    const reader = reg.connect(`${GEN_A}:10000`).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);
    expect((await nextFrame(reader)).text).toContain(`id: ${GEN_B}:1`);
    reg.close();
  });
});

describe("heartbeat — one shared timer (§3)", () => {
  test("a single injected timer serves every stream every heartbeat", async () => {
    const timer = fakeTimer();
    const reg = createEventStreamRegistry({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    const r1 = reg.connect(null).getReader();
    const r2 = reg.connect(null).getReader();
    // Draining the retry frames leaves both streams idle; exactly one timer is pending for both.
    expect((await nextFrame(r1)).text).toBe(RETRY);
    expect((await nextFrame(r2)).text).toBe(RETRY);
    expect(timer.hasPending()).toBe(true);

    timer.fire(); // one fire → a heartbeat to EVERY open stream
    expect((await nextFrame(r1)).text).toBe(HEARTBEAT);
    expect((await nextFrame(r2)).text).toBe(HEARTBEAT);
    expect(timer.hasPending()).toBe(true); // re-armed while streams remain

    reg.close();
    expect(timer.hasPending()).toBe(false); // close clears the shared timer
  });

  test("heartbeat continues before the first publication", async () => {
    const timer = fakeTimer();
    const reg = createEventStreamRegistry({ setTimer: timer.setTimer, clearTimer: timer.clearTimer });
    const reader = reg.connect(null).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);
    timer.fire();
    expect((await nextFrame(reader)).text).toBe(HEARTBEAT); // no cycle yet, still heartbeats
    reg.close();
  });
});

describe("capacity, cleanup, and the gauge (§3)", () => {
  test("stream 65 displaces the oldest before admission; the cap holds at 64", async () => {
    const events: StreamRegistryEvent[] = [];
    const reg = createEventStreamRegistry({ onEvent: (e) => events.push(e) });
    const readers: Reader[] = [];
    for (let i = 0; i < SSE_MAX_STREAMS; i++) readers.push(reg.connect(null).getReader());
    expect(reg.count()).toBe(SSE_MAX_STREAMS);

    const displaced = events.filter((e) => e.event === "displaced");
    expect(displaced).toHaveLength(0);

    reg.connect(null).getReader(); // the 65th connection
    expect(reg.count()).toBe(SSE_MAX_STREAMS); // never exceeds the cap
    expect(events.filter((e) => e.event === "displaced")).toHaveLength(1);

    // The oldest stream was closed before the newcomer was admitted: its reader drains retry then done.
    expect((await nextFrame(readers[0]!)).text).toBe(RETRY);
    expect((await nextFrame(readers[0]!)).done).toBe(true);
    reg.close();
  });

  test("the newcomer admitted after displacement is live; the displaced oldest receives no tick", async () => {
    // Displacement must not merely drop the oldest — the 65th connection has to be genuinely admitted
    // and wired for later ticks. Fill to the cap, then connect the 65th (displacing readers[0]).
    const reg = createEventStreamRegistry();
    const readers: Reader[] = [];
    for (let i = 0; i < SSE_MAX_STREAMS; i++) readers.push(reg.connect(null).getReader());
    const newest = reg.connect(null).getReader(); // 65th → displaces the oldest (readers[0])
    expect(reg.count()).toBe(SSE_MAX_STREAMS);

    // The displaced oldest ends after its retry frame — it is excluded from the fan-out below.
    expect((await nextFrame(readers[0]!)).text).toBe(RETRY);
    expect((await nextFrame(readers[0]!)).done).toBe(true);

    // The newcomer is live: it drains its own retry frame, then receives the published tick.
    expect((await nextFrame(newest)).text).toBe(RETRY);
    reg.publish(fakeCycle(GEN_A, 3));
    expect((await nextFrame(newest)).text).toContain(`id: ${GEN_A}:3`);
    // A surviving mid-list stream still receives the same tick (only the oldest was displaced).
    expect((await nextFrame(readers[1]!)).text).toBe(RETRY);
    expect((await nextFrame(readers[1]!)).text).toContain(`id: ${GEN_A}:3`);
    reg.close();
  });

  // NOTE (AC-3 write-failure cleanup): the `safeEnqueue` write-failure branch (release + forget the
  // ONE dead stream + emit `write-failed`) is defensive and, on Bun, unreachable through this public
  // API: a browser disconnect runs the stream's `cancel` callback synchronously (which forgets the
  // stream before any enqueue can throw), and the heartbeat/publish fan-out iterates a snapshot with
  // no interleaving await. Forcing it would require injecting a throwing controller — a production
  // seam this evidence unit must not add — so it is left proven by construction rather than fabricated.

  test("a cancelled (disconnected) stream is removed and excluded from later ticks; the gauge drops", async () => {
    const reg = createEventStreamRegistry();
    const keep = reg.connect(null).getReader();
    const goneStream = reg.connect(null);
    const gone = goneStream.getReader();
    expect(reg.count()).toBe(2);
    await gone.cancel(); // browser disconnect → cleanup for that stream only
    expect(reg.count()).toBe(1);

    // A subsequent publish reaches only the surviving stream.
    expect((await nextFrame(keep)).text).toBe(RETRY);
    reg.publish(fakeCycle(GEN_A, 2));
    expect((await nextFrame(keep)).text).toContain(`id: ${GEN_A}:2`);
    reg.close();
  });

  test("close() closes every stream and returns the gauge to zero (idempotent)", async () => {
    const reg = createEventStreamRegistry();
    const r1 = reg.connect(null).getReader();
    const r2 = reg.connect(null).getReader();
    expect(reg.count()).toBe(2);
    reg.close();
    expect(reg.count()).toBe(0);
    // Both bodies end after their retry frame.
    expect((await nextFrame(r1)).text).toBe(RETRY);
    expect((await nextFrame(r1)).done).toBe(true);
    expect((await nextFrame(r2)).text).toBe(RETRY);
    expect((await nextFrame(r2)).done).toBe(true);
    expect(() => reg.close()).not.toThrow(); // idempotent
    expect(reg.count()).toBe(0);
  });

  test("publish fans exactly one tick to every open stream", async () => {
    const reg = createEventStreamRegistry();
    const r1 = reg.connect(null).getReader();
    const r2 = reg.connect(null).getReader();
    expect((await nextFrame(r1)).text).toBe(RETRY);
    expect((await nextFrame(r2)).text).toBe(RETRY);
    reg.publish(fakeCycle(GEN_A, 8));
    expect((await nextFrame(r1)).text).toContain(`id: ${GEN_A}:8`);
    expect((await nextFrame(r2)).text).toContain(`id: ${GEN_A}:8`);
    reg.close();
  });
});

// ── /api/events route wiring ───────────────────────────────────────────────────────────────────────

describe("/api/events route (§2/§9)", () => {
  test("disables its Bun timeout, connects with Last-Event-ID, and returns the SSE headers", async () => {
    let seenLastEventId: string | null | undefined;
    let connects = 0;
    const registry: EventStreamRegistry = {
      connect: (id) => {
        connects += 1;
        seenLastEventId = id;
        return new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(RETRY_FRAME) });
      },
      publish: () => {},
      count: () => 0,
      close: () => {},
    };
    const ctx = { events: registry } as unknown as ServerContext;
    const req = routeReq({ "last-event-id": `${GEN_A}:4` });

    const res = await eventsRoute.handler(req, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(connects).toBe(1);
    expect(seenLastEventId).toBe(`${GEN_A}:4`);
    expect((req.request as unknown as { __timeoutDisabled?: boolean }).__timeoutDisabled).toBe(true);
  });

  test("a fresh connection with no Last-Event-ID passes null through to the registry", async () => {
    let seen: string | null | undefined = "unset";
    const registry: EventStreamRegistry = {
      connect: (id) => {
        seen = id;
        return new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(RETRY_FRAME) });
      },
      publish: () => {},
      count: () => 0,
      close: () => {},
    };
    await eventsRoute.handler(routeReq(), { events: registry } as unknown as ServerContext);
    expect(seen).toBeNull();
  });
});

// ── Runtime integration: exactly one tick per atomic publication (§3, AC-4) ─────────────────────────

describe("runtime publishes one tick per successful cycle (§3)", () => {
  let dir: string;
  let modelPath: string;
  let mtimeSeq: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-events-"));
    modelPath = join(dir, "web-estate-model.json");
    mtimeSeq = 1_000_000;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function fullEnv(): Record<string, string | undefined> {
    return {
      PULSE_VM_URL: "http://victoriametrics:8428",
      PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
      PULSE_GATUS_URL: "http://gatus:8080",
      PULSE_VMALERT_URL: "http://vmalert:8880",
      PULSE_WEB_ESTATE_MODEL: modelPath,
    };
  }

  function writeValidBundle(): void {
    const fixture = makeEstateBundleFixture();
    const t = new Date(mtimeSeq++);
    writeFileSync(modelPath, fixture.files.model);
    writeFileSync(join(dir, "web-coverage.json"), fixture.files.coverage ?? "");
    writeFileSync(join(dir, "web-findings.json"), fixture.files.findings ?? "");
    for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
      utimesSync(join(dir, name), t, t);
    }
  }

  /** Write a structurally-valid bundle whose estate metadata carries a >5 MiB string. The loader's
   *  lenient version+structure validation accepts it (so readiness passes and `state.estate` is set),
   *  but the estate view's canonical plain bytes exceed the 5 MiB representation limit, so
   *  `buildCycleCandidate` returns a classified `payload-limit` failure AFTER readiness — the
   *  post-readiness "failed candidate construction" path. */
  function writeOversizedBundle(): void {
    const base = makeWebEstateModelV2();
    const huge = "x".repeat(6 * 1024 * 1024); // repeated char → tiny gzip, >5 MiB plain (plain-limit)
    const model = { ...base, estate: { ...base.estate, domains: [huge] } };
    const coverage = makeWebCoverageArtifact(model);
    const findings = makeWebFindingsArtifact(model.bundleId);
    const t = new Date(mtimeSeq++);
    writeFileSync(modelPath, serializeArtifact(model));
    writeFileSync(join(dir, "web-coverage.json"), serializeArtifact(coverage));
    writeFileSync(join(dir, "web-findings.json"), serializeArtifact(findings));
    for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
      utimesSync(join(dir, name), t, t);
    }
  }

  /** A routing fetch that returns a minimal valid body for every data/legacy source op so a real
   *  cycle acquires, folds, materializes, and publishes. */
  function router(): typeof fetch {
    const impl = async (input: string | URL | Request): Promise<Response> => {
      const u = new URL(input.toString());
      const p = u.pathname;
      let body: unknown = [];
      if (p === "/api/v1/query") body = { status: "success", data: { resultType: "vector", result: [] } };
      else if (p === "/api/v1/targets") body = { status: "success", data: { activeTargets: [] } };
      else if (p === "/api/v1/status/buildinfo") body = { status: "success", data: { version: "1.102.1" } };
      else if (p === "/api/v1/rules") body = { status: "success", data: { groups: [] } };
      else if (p === "/api/v2/status") body = { versionInfo: { version: "0.27.0" }, cluster: { status: "ready" } };
      else if (p === "/api/health") body = { database: "ok", version: "11.4.0" };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
    return impl as unknown as typeof fetch;
  }

  test("no tick before readiness; one tick per publication with an advancing sequence", async () => {
    writeValidBundle();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), { fetchImpl: router() });
    const reader = runtime.getContext(null).events.connect(null).getReader();
    // Before any cycle: retry only, and no published cycle authority exists.
    expect((await nextFrame(reader)).text).toBe(RETRY);
    expect(runtime.getContext(null).cycle).toBeNull();

    await runtime.runOnce(); // first atomic publication → exactly one tick
    const cycle1 = runtime.getContext(null).cycle!;
    expect(cycle1).not.toBeNull();
    const tick1 = await nextFrame(reader);
    expect(tick1.text).toContain(`id: ${cycle1.observation.generation}:${cycle1.observation.seq}`);
    expect(tick1.text).toContain("event: tick");

    await runtime.runOnce(); // second publication → one more tick, sequence advanced
    const cycle2 = runtime.getContext(null).cycle!;
    expect(cycle2.observation.seq).toBe(cycle1.observation.seq + 1);
    expect((await nextFrame(reader)).text).toContain(`id: ${cycle2.observation.generation}:${cycle2.observation.seq}`);

    runtime.close();
  });

  test("no tick after a failed candidate construction; a later valid cycle recovers with one tick", async () => {
    // Readiness passes (the oversized bundle loads), but the estate view exceeds the 5 MiB plain
    // limit, so candidate construction fails AFTER readiness — the runtime performs no atomic
    // `state.cycle` assignment, so the registry publishes NO tick (distinct from the pre-readiness
    // no-bundle path, which never reaches construction at all).
    writeOversizedBundle();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), { fetchImpl: router() });
    const reader = runtime.getContext(null).events.connect(null).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);

    await runtime.runOnce();
    expect(runtime.getContext(null).cycle ?? null).toBeNull(); // no assignment ⇒ no authority
    expect(runtime.getStatus().lastCycleBuildFailure?.kind).toBe("payload-limit"); // classified failure

    // Recovery: a subsequent valid bundle publishes exactly one cycle, and the ONLY frame the reader
    // sees after its retry frame is that recovery tick — the failed candidate enqueued nothing.
    writeValidBundle();
    await runtime.runOnce();
    const recovered = runtime.getContext(null).cycle!;
    expect(recovered).not.toBeNull();
    expect(runtime.getStatus().lastCycleBuildFailure ?? null).toBeNull(); // failure cleared on recovery
    const tick = await nextFrame(reader);
    expect(tick.text).toContain(`id: ${recovered.observation.generation}:${recovered.observation.seq}`);
    expect(tick.text).toContain("event: tick");

    runtime.close();
  });

  test("a runtime with no bundle publishes no tick (none before readiness)", async () => {
    // No bundle written → the cycle never becomes ready, so the scheduler assigns no cycle and the
    // registry publishes nothing (only the retry frame reaches the connection).
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), { fetchImpl: router() });
    const reader = runtime.getContext(null).events.connect(null).getReader();
    expect((await nextFrame(reader)).text).toBe(RETRY);
    await runtime.runOnce();
    expect(runtime.getContext(null).cycle ?? null).toBeNull(); // no publication ⇒ no tick
    runtime.close();
  });
});
