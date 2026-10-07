// apps/web/tests/refresh.test.ts — the rendered-model-v2 runtime authority integration
// (06-reload-and-runtime-integration.md §§5-6, 08-testing-strategy.md §8.9).
//
// Drives the real `runRefreshCycle` against a temporary on-disk bundle so the three-file watcher,
// authority replacement, snapshot fold, and structured transition logs are exercised end to end.
// Asserts: `RuntimeState.estate` holds the complete `EstateBundle`; the snapshot receives the exact
// `bundle.model`; a bundle error clears BOTH bundle and snapshot without stopping the loop; and each
// of load / reload / error / recovery emits exactly one structured `bundle_*` event with the §6.2
// nullable fields. Sources are fakes (no network); the model watcher reads real bytes.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime, runRefreshCycle, type RuntimeState } from "../src/server/refresh.js";
import type { SourceResult } from "../src/server/sources/types.js";
import {
  makeEstateBundleFixture,
  makeWebCoverageArtifact,
  makeWebEstateModelV2,
  makeWebFindingsArtifact,
  serializeArtifact,
  type EstateBundleFixture,
} from "./factories/estate-bundle.js";
import type { WebEstateHostV2, WebEstateModelV2 } from "@pulse/renderer";
import type { AckFoldRecord } from "@pulse/web-data/cycle";
import type { AckStore } from "../src/server/mutations/stores/ack-store.js";

// ── On-disk bundle helpers ───────────────────────────────────────────────────────────────────────

let dir: string;
let modelPath: string;
/** Strictly increasing mtime so the watcher's metadata pre-gate always fires for a fresh generation. */
let mtimeSeq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-refresh-"));
  modelPath = join(dir, "web-estate-model.json");
  mtimeSeq = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write the three members (any may be a raw override string) and bump every mtime forward. */
function writeGeneration(members: { model: string; coverage: string; findings: string }): void {
  const t = new Date(mtimeSeq++);
  writeFileSync(modelPath, members.model);
  writeFileSync(join(dir, "web-coverage.json"), members.coverage);
  writeFileSync(join(dir, "web-findings.json"), members.findings);
  for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
    utimesSync(join(dir, name), t, t);
  }
}

/** Write a complete valid generation from a fixture. */
function writeValid(fixture: EstateBundleFixture): void {
  writeGeneration({
    model: fixture.files.model,
    coverage: fixture.files.coverage ?? "",
    findings: fixture.files.findings ?? "",
  });
}

// ── Fake sources (never touch the network) ─────────────────────────────────────────────────────────

function okSource<T>(data: T): () => Promise<SourceResult<T>> {
  return () => Promise.resolve({ ok: true, data });
}

function fullEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PULSE_VM_URL: "http://victoriametrics:8428",
    PULSE_ALERTMANAGER_URL: "http://alertmanager:9093",
    PULSE_GATUS_URL: "http://gatus:8080",
    PULSE_VMALERT_URL: "http://vmalert:8880",
    PULSE_WEB_ESTATE_MODEL: modelPath,
    ...over,
  };
}

function makeState(env: Record<string, string | undefined> = {}): RuntimeState {
  return {
    config: loadServerConfig(fullEnv(env)),
    sources: {
      vm: { queryLiveness: okSource([]) } as RuntimeState["sources"]["vm"],
      alertmanager: { activeAlerts: okSource([]) } as RuntimeState["sources"]["alertmanager"],
      gatus: { endpointStatuses: okSource([]) } as RuntimeState["sources"]["gatus"],
    },
    watcher: null,
    estate: null,
    snapshot: null,
    status: {
      sources: {
        metrics: { ok: false, lastSuccess: null, error: null },
        alerts: { ok: false, lastSuccess: null, error: null },
        checks: { ok: false, lastSuccess: null, error: null },
      },
      model: { loaded: false, formatVersion: null, error: null },
      lastSnapshotAt: null,
    },
  };
}

// ── Structured-log capture ──────────────────────────────────────────────────────────────────────

interface Captured {
  logs: Record<string, unknown>[];
  restore: () => void;
}

/** Intercept `console.log` (which `log()` writes one JSON line to) and collect parsed events. */
function captureLogs(): Captured {
  const logs: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = ((line: unknown) => {
    if (typeof line === "string") {
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
        return;
      } catch {
        /* not a JSON line — fall through to the real console */
      }
    }
    original(line as string);
  }) as typeof console.log;
  return { logs, restore: () => void (console.log = original) };
}

/** The single log for one bundle transition event. */
function only(logs: Record<string, unknown>[], event: string): Record<string, unknown> {
  const matches = logs.filter((l) => l["event"] === event);
  expect(matches.length).toBe(1);
  return matches[0]!;
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────────

describe("runRefreshCycle bundle authority (§5)", () => {
  test("initial load exposes the complete bundle and folds the exact bundle.model into the snapshot", async () => {
    const fixture = makeEstateBundleFixture();
    writeValid(fixture);
    const state = makeState();

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }

    // RuntimeState.estate is the complete EstateBundle authority (not the bare model).
    expect(state.estate).not.toBeNull();
    expect(state.estate?.model.bundleId).toBe(fixture.model.bundleId);
    expect(state.estate?.coverage).not.toBeNull();
    expect(state.estate?.findings).not.toBeNull();
    expect(typeof state.estate?.loadedAt).toBe("string");

    // The snapshot received the exact bundle.model (name + rendered timezone are threaded through).
    expect(state.snapshot).not.toBeNull();
    expect(state.snapshot?.estate.name).toBe(fixture.model.estate.name);
    expect(state.snapshot?.estate.timezone).toBe(fixture.model.estate.timezone); // America/Chicago
    expect(state.snapshot?.estate.tzFallback).toBe(false);

    // Status is loaded with the model's format version, no error.
    expect(state.status.model).toEqual({ loaded: true, formatVersion: 2, error: null });

    // Exactly one structured bundle_loaded log with the §6.2 fields.
    const loaded = only(cap.logs, "bundle_loaded");
    expect(loaded["ok"]).toBe(true);
    expect(loaded["artifact"]).toBeNull();
    expect(loaded["kind"]).toBeNull();
    expect(loaded["path"]).toBe(modelPath);
    expect(loaded["field"]).toBeNull();
    expect(loaded["foundVersion"]).toBeNull();
    expect(loaded["formatVersion"]).toBe(2);
    expect(loaded["bundleId"]).toBe(fixture.model.bundleId);
    expect(loaded["hosts"]).toBe(fixture.model.hosts.length);
    expect(loaded["services"]).toBe(fixture.model.services.length);
    expect(loaded["coveragePresent"]).toBe(true);
    expect(loaded["findingsPresent"]).toBe(true);
    expect(typeof loaded["loadedAt"]).toBe("string");
    expect(loaded["error"]).toBeNull();
  });

  test("a coherent byte change reloads and emits exactly one bundle_reloaded", async () => {
    const fixture = makeEstateBundleFixture();
    writeValid(fixture);
    const state = makeState();
    await runRefreshCycle(state); // initial load

    // A byte-distinct, still-coherent generation: rename the estate; recompute coverage from it.
    const model = makeWebEstateModelV2();
    const renamed = { ...model, estate: { ...model.estate, name: "renamed-estate" } };
    writeGeneration({
      model: serializeArtifact(renamed),
      coverage: serializeArtifact(makeWebCoverageArtifact(renamed)),
      findings: fixture.files.findings ?? "",
    });

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }

    expect(state.estate?.model.estate.name).toBe("renamed-estate");
    expect(state.snapshot?.estate.name).toBe("renamed-estate");
    only(cap.logs, "bundle_reloaded");
    expect(cap.logs.filter((l) => l["event"] === "bundle_loaded").length).toBe(0);
  });

  test("a bundle error clears BOTH bundle and snapshot without stopping the loop", async () => {
    const fixture = makeEstateBundleFixture();
    writeValid(fixture);
    const state = makeState();
    await runRefreshCycle(state);
    expect(state.estate).not.toBeNull();
    expect(state.snapshot).not.toBeNull();

    // Corrupt the model bytes (invalid JSON) while siblings stay valid.
    writeGeneration({
      model: "{ this is not json",
      coverage: fixture.files.coverage ?? "",
      findings: fixture.files.findings ?? "",
    });

    const cap = captureLogs();
    try {
      await expect(runRefreshCycle(state)).resolves.toBeUndefined(); // never throws across the loop
    } finally {
      cap.restore();
    }

    expect(state.estate).toBeNull(); // prior bundle is not preserved
    expect(state.snapshot).toBeNull(); // stale snapshot cleared so no route serves a pre-error grid
    expect(state.status.model.loaded).toBe(false);
    expect(state.status.model.error).not.toBeNull();
    expect(state.status.model.error?.artifact).toBe("model");

    const err = only(cap.logs, "bundle_error");
    expect(err["ok"]).toBe(false);
    expect(err["artifact"]).toBe("model");
    expect(err["kind"]).toBe("unparseable");
    expect(err["formatVersion"]).toBeNull();
    expect(err["bundleId"]).toBeNull();
    expect(err["hosts"]).toBeNull();
    expect(err["coveragePresent"]).toBeNull();
    expect(err["loadedAt"]).toBeNull();
    expect(typeof err["error"]).toBe("string");
  });

  test("a coherent replacement after an error emits bundle_recovered without restart", async () => {
    const fixture = makeEstateBundleFixture();
    writeValid(fixture);
    const state = makeState();
    await runRefreshCycle(state); // load

    writeGeneration({
      model: "{ broken",
      coverage: fixture.files.coverage ?? "",
      findings: fixture.files.findings ?? "",
    });
    await runRefreshCycle(state); // error
    expect(state.estate).toBeNull();

    writeValid(makeEstateBundleFixture()); // coherent bytes return

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }

    expect(state.estate).not.toBeNull();
    expect(state.snapshot).not.toBeNull();
    only(cap.logs, "bundle_recovered");
  });

  test("a missing model is an explicit bundle_error and the server stays servable", async () => {
    // No files written → the derived model path does not exist.
    const state = makeState();

    const cap = captureLogs();
    try {
      await runRefreshCycle(state);
    } finally {
      cap.restore();
    }

    expect(state.estate).toBeNull();
    expect(state.snapshot).toBeNull();
    const err = only(cap.logs, "bundle_error");
    expect(err["kind"]).toBe("missing");
    expect(err["artifact"]).toBe("model");
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// The monotonic cycle scheduler + atomic publication (04 §§2–6, 10 §§2, 4). Item 039 code, item 040
// evidence. Drives `createServerRuntime` (never exercised by the legacy `runRefreshCycle` tests above)
// with injected clocks/timers and a routing `fetchImpl` that returns minimal valid bodies for every
// data + legacy source operation, so real cycles acquire, fold, materialize, and publish.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Per-category upstream call counts keyed by a stable `"<tier>:<op>"` label. */
type Calls = Record<string, number>;

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/** Classify one request into a stable category. The two path collisions between the data and legacy
 *  clients are disambiguated by query string: `/api/v1/query` (data carries `label_replace`), and
 *  `/api/v2/alerts` + `/api/v1/endpoints/statuses` (data carries `silenced=true` / `pageSize`). */
function classify(u: URL): string {
  const p = u.pathname;
  const s = u.search;
  if (p === "/api/v1/query") return s.includes("label_replace") ? "data:signals" : "legacy:vm";
  if (p === "/api/v1/targets") return "data:targets";
  if (p === "/api/v1/status/buildinfo") return "data:buildinfo";
  if (p === "/api/v1/rules") return "data:rules";
  if (p === "/api/v2/alerts") return s.includes("silenced=true") ? "data:alerts" : "legacy:am";
  if (p === "/api/v2/silences") return "data:silences";
  if (p === "/api/v2/status") return "data:amstatus";
  if (p === "/api/v2/receivers") return "data:receivers";
  if (p === "/api/v1/endpoints/statuses") return s.includes("pageSize") ? "data:gatus" : "legacy:gatus";
  if (p === "/api/health") return "data:grafana";
  return "unknown";
}

/** A minimal body each category's parser accepts as a success. Gatus (data) returns `[]`; with a
 *  non-empty expected set that yields a bounded overflow — a degraded check source, which still
 *  publishes a coherent cycle (never-silent-green), exactly what the scheduler tests need. */
function bodyFor(cat: string): unknown {
  switch (cat) {
    case "data:signals":
    case "legacy:vm":
      return { status: "success", data: { resultType: "vector", result: [] } };
    case "data:targets":
      return { status: "success", data: { activeTargets: [] } };
    case "data:buildinfo":
      return { status: "success", data: { version: "1.102.1" } };
    case "data:rules":
      return { status: "success", data: { groups: [] } };
    case "data:amstatus":
      return { versionInfo: { version: "0.27.0" }, cluster: { status: "ready" } };
    case "data:grafana":
      return { database: "ok", version: "11.4.0" };
    default:
      return []; // data/legacy alerts, silences, receivers, gatus (both)
  }
}

/** Build a routing `fetchImpl` (`typeof fetch`) that counts calls by category and returns minimal
 *  valid bodies. `intercept` may return a custom `Promise<Response>` (e.g. a gated one) or null. */
function makeRouter(calls: Calls, intercept?: (cat: string, u: URL) => Promise<Response> | null): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input.toString());
    const cat = classify(u);
    calls[cat] = (calls[cat] ?? 0) + 1;
    if (intercept) {
      const custom = intercept(cat, u);
      if (custom) return custom;
    }
    return jsonOk(bodyFor(cat));
  };
  return impl as unknown as typeof fetch;
}

const CORE_CATS = ["data:signals", "data:targets", "data:alerts", "data:silences", "data:rules", "data:gatus"] as const;
const SLOW_CATS = ["data:buildinfo", "data:amstatus", "data:receivers"] as const;

/** A fake chained-timer + monotonic clock. The scheduler uses a single chained `setTimeout`, so only
 *  one timer is pending at a time; `delays` records every scheduled delay for deadline-series proof. */
function fakeScheduler() {
  let clock = 0;
  let pending: (() => void) | null = null;
  const delays: number[] = [];
  const setTimer = ((cb: () => void, delay?: number) => {
    delays.push(delay ?? 0);
    pending = cb;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimer = (() => {
    pending = null;
  }) as unknown as typeof clearTimeout;
  return {
    delays,
    monotonicNow: () => clock,
    setTimer,
    clearTimer,
    setClock(v: number) {
      clock = v;
    },
    /** Fire the single pending timer, then yield real macrotasks until the cycle settles and the
     *  scheduler re-arms (the cycle does real fs I/O in `syncBundle`, so a microtask flush is not
     *  enough). */
    async fire(): Promise<void> {
      const cb = pending;
      pending = null;
      if (cb === null) throw new Error("no pending timer");
      cb();
      for (let i = 0; i < 500 && pending === null; i++) {
        await new Promise((r) => setTimeout(r, 0));
      }
    },
  };
}

/** Build a bigger-but-coherent bundle: the baseline model plus `extra` cloned managed hosts, with
 *  coverage/findings recomputed so the loader accepts it. Proves the fixed acquisition plan does not
 *  scale with estate size. */
function biggerGeneration(extra: number): { model: string; coverage: string; findings: string } {
  const base = makeWebEstateModelV2();
  const template = base.hosts.find((h) => h.collectionClass === "managed-linux") ?? base.hosts[0]!;
  const clones: WebEstateHostV2[] = [];
  for (let i = 0; i < extra; i++) {
    const addr = `10.9.${Math.floor(i / 254)}.${(i % 254) + 1}`;
    clones.push({
      ...template,
      name: `extra-host-${i}`,
      drilldownId: `host:extra-host-${i}`,
      addresses: [addr],
      artifacts: [],
      suppressed: null,
      ...("scrapeTargets" in template ? { scrapeTargets: [{ job: "node", instance: `${addr}:9100` }] } : {}),
    } as WebEstateHostV2);
  }
  const model: WebEstateModelV2 = { ...base, hosts: [...base.hosts, ...clones] };
  return {
    model: serializeArtifact(model),
    coverage: serializeArtifact(makeWebCoverageArtifact(model)),
    findings: serializeArtifact(makeWebFindingsArtifact(model.bundleId)),
  };
}

describe("cycle scheduler — fixed acquisition cardinality (§3, 10 §6)", () => {
  test("one core cycle issues exactly the six core calls; a due slow cycle adds exactly the configured slow calls", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    const clock = { t: 0 };
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls),
      monotonicNow: () => clock.t,
      wallNow: () => new Date(clock.t),
    });

    // Cycle 1: the slow tier is due (no prior records to reuse) → six core + three configured slow.
    await runtime.runOnce();
    for (const c of CORE_CATS) expect(calls[c]).toBe(1);
    for (const c of SLOW_CATS) expect(calls[c]).toBe(1);
    expect(calls["data:grafana"] ?? 0).toBe(0); // Grafana unconfigured → zero calls
    runtime.close();
  });

  test("a not-due cycle reruns only the six core calls; the slow tier fires again when its deadline passes", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    const clock = { t: 0 };
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls),
      monotonicNow: () => clock.t,
      wallNow: () => new Date(1_000_000 + clock.t),
    });

    clock.t = 0;
    await runtime.runOnce(); // slow due (first)
    clock.t = 10_000;
    await runtime.runOnce(); // 10s < 60s slow deadline → core only
    clock.t = 70_000;
    await runtime.runOnce(); // ≥ 60s → slow due again

    for (const c of CORE_CATS) expect(calls[c]).toBe(3); // core every cycle
    for (const c of SLOW_CATS) expect(calls[c]).toBe(2); // slow only on cycles 1 and 3
    runtime.close();
  });

  test("configured Grafana is acquired on due cycles; call cardinality is independent of estate size", async () => {
    // Configured Grafana → its health is the fourth slow call on a due cycle.
    writeValid(makeEstateBundleFixture());
    const grafanaCalls: Calls = {};
    const gr = createServerRuntime(loadServerConfig(fullEnv({ PULSE_GRAFANA_URL: "http://grafana:3000" })), {
      fetchImpl: makeRouter(grafanaCalls),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await gr.runOnce();
    expect(grafanaCalls["data:grafana"]).toBe(1);
    gr.close();

    // A much larger estate produces identical core cardinality (no per-host/per-service fan-out).
    writeGeneration(biggerGeneration(60));
    const bigCalls: Calls = {};
    const big = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(bigCalls),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });
    await big.runOnce();
    expect(big.getContext(null).cycle).not.toBeNull(); // the bigger bundle loaded and published
    for (const c of CORE_CATS) expect(bigCalls[c]).toBe(1);
    big.close();
  });
});

describe("cycle scheduler — monotonic chained deadlines (§2)", () => {
  test("retains the 10s deadline series across an overrun instead of adding 10s to settlement", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    const sch = fakeScheduler();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls),
      monotonicNow: sch.monotonicNow,
      wallNow: () => new Date(),
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
    });

    await runtime.start(); // prime cycle at D0=0, then arm the next deadline
    expect(sch.delays).toEqual([10_000]); // D1 = 10_000, delay from clock 0

    // Steady cadence: each cycle fires exactly on its deadline; the next delay is a clean 10s.
    sch.setClock(10_000);
    await sch.fire();
    sch.setClock(20_000);
    await sch.fire();
    expect(sch.delays).toEqual([10_000, 10_000, 10_000]);

    // Overrun: the clock is already well past the next deadline (30_000) when the cycle runs. The
    // series stays on the 10s grid — the following deadlines are 40_000 then 50_000, so their delays
    // clamp to 0 (immediate catch-up, never concurrent), NOT a fresh 10_000 from settlement.
    sch.setClock(55_000);
    await sch.fire(); // runs the 30_000 cycle; next deadline 40_000 → delay max(0, 40_000-55_000)=0
    expect(sch.delays.at(-1)).toBe(0);
    await sch.fire(); // runs the 40_000 cycle; next deadline 50_000 → delay 0
    expect(sch.delays.at(-1)).toBe(0);
    await sch.fire(); // runs the 50_000 cycle; next deadline 60_000 → delay max(0, 60_000-55_000)=5_000
    expect(sch.delays.at(-1)).toBe(5_000); // grid-anchored (60_000), not settlement+10_000 (65_000)

    // Every fired cycle published exactly once, in order — no overlap, no skipped/duplicated seq.
    expect(runtime.getContext(null).cycle?.observation.seq).toBe(6);
    runtime.close();
  });

  test("cycles never overlap: a second runOnce does not acquire until the first settles", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gatedFirstTargets = false;
    const router = makeRouter(calls, (cat) => {
      if (cat === "data:targets" && !gatedFirstTargets) {
        gatedFirstTargets = true;
        return gate.then(() => jsonOk(bodyFor(cat))); // block the first cycle's core acquisition
      }
      return null;
    });
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: router,
      monotonicNow: () => 0,
      wallNow: () => new Date(),
    });

    const p1 = runtime.runOnce();
    const p2 = runtime.runOnce();
    // Let microtasks + fs settle: cycle 1 is parked on the gated targets fetch; cycle 2 must be
    // queued behind it (serialized), so it has not reached its own targets call yet.
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
    expect(calls["data:targets"]).toBe(1); // only cycle 1 reached acquisition

    release();
    await Promise.all([p1, p2]);
    expect(calls["data:targets"]).toBe(2); // cycle 2 acquired only after cycle 1 settled
    expect(runtime.getContext(null).cycle?.observation.seq).toBe(2); // both published, ordered
    runtime.close();
  });
});

describe("cycle scheduler — atomic publication & ordering (§§5–6, 10 §4)", () => {
  test("before the first successful cycle a context is NOT_READY; publication is a single coherent atomic swap with an ordered monotonic observation", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    let wall = Date.parse("2026-01-01T00:00:00.000Z");
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls),
      monotonicNow: () => 0,
      wallNow: () => new Date(wall),
    });

    expect(runtime.getContext(null).cycle).toBeNull(); // NOT_READY before the first cycle

    await runtime.runOnce();
    const c1 = runtime.getContext(null).cycle;
    expect(c1).not.toBeNull();
    expect(c1!.observation.seq).toBe(1);
    expect(c1!.observation.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // A coherent cycle: all five views materialized together with distinct plain/gzip validators.
    for (const v of ["overview", "alerts", "estate", "engine", "timeline"] as const) {
      expect(c1![v].identity).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(c1![v].plain.etag).not.toBe(c1![v].gzip.etag);
    }

    wall += 10_000;
    await runtime.runOnce();
    const c2 = runtime.getContext(null).cycle;
    expect(c2!.observation.seq).toBe(2);
    expect(Date.parse(c2!.observation.observedAt)).toBeGreaterThan(Date.parse(c1!.observation.observedAt));
    expect(c2!.observation.generation).toBe(c1!.observation.generation); // process-fixed generation
    // The earlier captured reference is unchanged — a request reads exactly one coherent cycle.
    expect(c1!.observation.seq).toBe(1);

    // Wall-clock regression is clamped so publication order stays strictly monotonic (§6).
    wall -= 60_000;
    await runtime.runOnce();
    const c3 = runtime.getContext(null).cycle;
    expect(c3!.observation.seq).toBe(3);
    expect(Date.parse(c3!.observation.observedAt)).toBeGreaterThanOrEqual(
      Date.parse(c2!.observation.observedAt) + 1,
    );
    runtime.close();
  });

  test("a construction cannot publish before a valid bundle, and a bundle loss clears prior authority; recovery needs no restart", async () => {
    // No model on disk → bundle error → estate null → the scheduler makes zero data-core calls and
    // never publishes (stays NOT_READY): no partial record/sequence/tick.
    const calls: Calls = {};
    let wall = Date.parse("2026-01-01T00:00:00.000Z");
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls),
      monotonicNow: () => 0,
      wallNow: () => new Date((wall += 10_000)),
    });
    await runtime.runOnce();
    expect(runtime.getContext(null).cycle).toBeNull();
    expect(calls["data:targets"] ?? 0).toBe(0); // no data acquisition without a bundle

    // A coherent bundle appears → the next cycle publishes without a restart.
    writeValid(makeEstateBundleFixture());
    await runtime.runOnce();
    expect(runtime.getContext(null).cycle?.observation.seq).toBe(1);

    // A bundle loss clears the published authority so no route serves stale cycle data (10 §3).
    writeGeneration({ model: "{ not json", coverage: "", findings: "" });
    await runtime.runOnce();
    expect(runtime.getContext(null).cycle).toBeNull();

    // Recovery: a coherent bundle republishes automatically without a restart. Because the bundle
    // loss cleared cycle authority (like a cold start), the fresh sequence restarts at 1 (§6:
    // seq = (previous?.observation.seq ?? 0) + 1 with previous now null).
    writeValid(makeEstateBundleFixture());
    await runtime.runOnce();
    expect(runtime.getContext(null).cycle?.observation.seq).toBe(1);
    runtime.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Ack reconcile + slow-cycle hook wiring (06 §6, item 020). A structural fake AckStore records the
// order of reconcile/foldView calls so the tests prove reconcile runs before the fold in the SAME
// cycle; the upstream router counts calls so PERF-03 (no new recurring upstream call) is asserted.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

type AlertsRecord = Parameters<AckStore["reconcile"]>[0];

/** A minimal Alertmanager v2 alert the data client parses as a firing alert. */
function amAlert(fingerprint: string): unknown {
  return {
    fingerprint,
    labels: { alertname: `Alert_${fingerprint}`, severity: "warning" },
    annotations: {},
    startsAt: "2026-01-01T00:00:00.000Z",
    endsAt: "2026-01-01T01:00:00.000Z",
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    receivers: [{ name: "default" }],
  };
}

const ACK: AckFoldRecord = { by: "Gary Gentry", at: "2026-01-01T00:05:00.000Z", note: "looking" };

interface FakeAckStore extends AckStore {
  readonly events: string[];
  readonly reconciled: AlertsRecord[];
  readonly acks: Map<string, AckFoldRecord>;
}

/** Structural AckStore fake: `reconcile` runs `onReconcile` (default: nothing cleared) and records
 *  the record it saw; `foldView` returns a snapshot of `acks`. */
function fakeAckStore(
  initial: readonly string[],
  onReconcile: (store: FakeAckStore, record: AlertsRecord) => Promise<number> = () => Promise.resolve(0),
): FakeAckStore {
  const events: string[] = [];
  const reconciled: AlertsRecord[] = [];
  const acks = new Map<string, AckFoldRecord>(initial.map((fp) => [fp, ACK]));
  const store: FakeAckStore = {
    events,
    reconciled,
    acks,
    loadStatus: { ok: true, reason: null },
    set: () => Promise.resolve({ ok: false, error: "write-failed" }),
    remove: () => Promise.resolve({ ok: false, error: "write-failed" }),
    get: () => undefined,
    reconcile(record) {
      events.push("reconcile");
      reconciled.push(record);
      return onReconcile(store, record);
    },
    foldView() {
      events.push("foldView");
      return new Map(acks);
    },
  };
  return store;
}

/** A router whose data:alerts returns `alertsBody()` (or a 500 when it returns null). */
function alertsRouter(calls: Calls, alertsBody: () => unknown[] | null): typeof fetch {
  return makeRouter(calls, (cat) => {
    if (cat !== "data:alerts") return null;
    const body = alertsBody();
    return Promise.resolve(body === null ? new Response("boom", { status: 500 }) : jsonOk(body));
  });
}

/** Yield real macrotasks so fire-and-forget microtask chains settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("refresh — ack reconcile and slow-cycle hook (REQ-ACK-04, REQ-ACK-06, REQ-PERF-03)", () => {
  test("reconcile runs exactly once per cycle with records['alertmanager-alerts'] before the fold; a fingerprint it clears is absent from the SAME cycle's /api/alerts payload (REQ-ACK-04)", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    // The fake clears fp-1 on reconcile while AM still lists it: if foldView were read before the
    // reconcile (or the fold ran first), fp-1 would still carry its ack.
    const store = fakeAckStore(["fp-1", "fp-2"], (s) => {
      s.acks.delete("fp-1");
      return Promise.resolve(1);
    });
    const clock = { t: 0 };
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: alertsRouter(calls, () => [amAlert("fp-1"), amAlert("fp-2")]),
      monotonicNow: () => clock.t,
      wallNow: () => new Date(1_000_000 + clock.t),
      ackStore: store,
    });

    await runtime.runOnce();
    expect(store.events).toEqual(["reconcile", "foldView"]);
    expect(store.reconciled).toHaveLength(1);
    const rec = store.reconciled[0]!;
    expect(rec.latest.result.ok).toBe(true);
    expect(rec.latest.result.ok && rec.latest.result.data.map((a) => a.fingerprint).sort()).toEqual(["fp-1", "fp-2"]);

    const cycle = runtime.getContext(null).cycle!;
    const byFp = new Map(cycle.alerts.value.alerts.map((a) => [a.fingerprint, a]));
    expect(byFp.get("fp-1")).toBeDefined();
    expect("ack" in byFp.get("fp-1")!).toBe(false); // cleared by this cycle's reconcile
    expect(byFp.get("fp-2")!.ack).toEqual(ACK);

    clock.t = 10_000;
    await runtime.runOnce();
    expect(store.events).toEqual(["reconcile", "foldView", "reconcile", "foldView"]); // once per cycle
    expect(store.reconciled).toHaveLength(2);
    runtime.close();
  });

  test("with an Alertmanager failure (latest not ok) the store's ack is still joined on the last-good alert (REQ-ACK-04, REQ-ACK-06)", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    let fail = false;
    const store = fakeAckStore(["fp-1"]);
    const clock = { t: 0 };
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: alertsRouter(calls, () => (fail ? null : [amAlert("fp-1")])),
      monotonicNow: () => clock.t,
      wallNow: () => new Date(1_000_000 + clock.t),
      ackStore: store,
    });

    await runtime.runOnce();
    fail = true;
    clock.t = 10_000;
    await runtime.runOnce();

    expect(store.reconciled).toHaveLength(2);
    expect(store.reconciled[1]!.latest.result.ok).toBe(false);
    const cycle = runtime.getContext(null).cycle!;
    expect(cycle.observation.seq).toBe(2);
    const alerts = cycle.alerts.value.alerts;
    expect(alerts.map((a) => a.fingerprint)).toEqual(["fp-1"]);
    expect(alerts[0]!.ack).toEqual(ACK);
    runtime.close();
  });

  test("without an ackStore no published alert has an 'ack' key and no overview summary has 'acked' (REQ-ACK-06)", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: alertsRouter(calls, () => [amAlert("fp-1"), amAlert("fp-2")]),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
    });

    await runtime.runOnce();
    const cycle = runtime.getContext(null).cycle!;
    expect(cycle.alerts.value.alerts).toHaveLength(2);
    for (const a of cycle.alerts.value.alerts) expect("ack" in a).toBe(false);
    // Deep scan of the overview body: no `acked` key anywhere (alerts + host/service activeAlerts).
    const keys: string[] = [];
    JSON.stringify(cycle.overview.value, (k, v: unknown) => {
      keys.push(k);
      return v;
    });
    expect(keys).not.toContain("acked");
    expect(keys).not.toContain("ack");
    runtime.close();
  });

  test("with an ackStore configured a core cycle issues exactly the six core upstream calls, the same as without one (REQ-PERF-03)", async () => {
    writeValid(makeEstateBundleFixture());

    /** Run a slow-due cycle then a core-only cycle; return the second cycle's per-category delta. */
    async function coreCycleDelta(withStore: boolean): Promise<{ delta: Calls; first: Calls; store: FakeAckStore }> {
      const calls: Calls = {};
      const store = fakeAckStore(["fp-1"]);
      const clock = { t: 0 };
      const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
        fetchImpl: alertsRouter(calls, () => [amAlert("fp-1")]),
        monotonicNow: () => clock.t,
        wallNow: () => new Date(1_000_000 + clock.t),
        ...(withStore ? { ackStore: store, onSlowCycle: () => undefined } : {}),
      });
      await runtime.runOnce(); // slow due: six core + three slow
      const first = { ...calls };
      clock.t = 10_000;
      await runtime.runOnce(); // core only
      runtime.close();
      const delta: Calls = {};
      for (const [k, v] of Object.entries(calls)) if (v - (first[k] ?? 0) !== 0) delta[k] = v - (first[k] ?? 0);
      return { delta, first, store };
    }

    const withStore = await coreCycleDelta(true);
    const baseline = await coreCycleDelta(false);
    for (const c of CORE_CATS) expect(withStore.first[c]).toBe(1);
    for (const c of SLOW_CATS) expect(withStore.first[c]).toBe(1);
    const dataDelta = Object.fromEntries(Object.entries(withStore.delta).filter(([k]) => k.startsWith("data:")));
    expect(dataDelta).toEqual(Object.fromEntries(CORE_CATS.map((c) => [c, 1])));
    expect(withStore.delta).toEqual(baseline.delta); // the ack store adds no upstream call at all
    expect(withStore.first).toEqual(baseline.first);
    expect(withStore.store.reconciled).toHaveLength(2);
  });

  test("onSlowCycle fires only on slow-due cycles; a throwing, rejecting or never-settling hook does not fail or delay publication (REQ-PERF-03)", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    let hookCalls = 0;
    const clock = { t: 0 };
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls),
      monotonicNow: () => clock.t,
      wallNow: () => new Date(1_000_000 + clock.t),
      onSlowCycle: () => {
        hookCalls++;
      },
    });
    await runtime.runOnce(); // slow due (first)
    await flush();
    expect(hookCalls).toBe(1);
    clock.t = 10_000;
    await runtime.runOnce(); // not due
    await flush();
    expect(hookCalls).toBe(1);
    clock.t = 70_000;
    await runtime.runOnce(); // slow due again
    await flush();
    expect(hookCalls).toBe(2);
    runtime.close();

    const hooks: Array<() => Promise<void> | void> = [
      () => {
        throw new Error("sync throw");
      },
      () => Promise.reject(new Error("async reject")),
      () => new Promise<void>(() => {}), // never settles
    ];
    for (const hook of hooks) {
      let invoked = 0;
      const rt = createServerRuntime(loadServerConfig(fullEnv()), {
        fetchImpl: makeRouter({}),
        monotonicNow: () => clock.t,
        wallNow: () => new Date(1_000_000 + clock.t),
        onSlowCycle: () => {
          invoked++;
          return hook();
        },
      });
      clock.t = 0;
      await rt.runOnce(); // resolves even though the hook never settles
      expect(rt.getContext(null).cycle?.observation.seq).toBe(1);
      await flush();
      expect(invoked).toBe(1);
      clock.t = 70_000;
      await rt.runOnce(); // the next slow-due cycle still publishes
      expect(rt.getContext(null).cycle?.observation.seq).toBe(2);
      rt.close();
    }
  });

  test("a reconcile that rejects does not stall the cycle; publication still happens with the store's acks joined (REQ-ACK-04)", async () => {
    writeValid(makeEstateBundleFixture());
    const store = fakeAckStore(["fp-1"], () => Promise.reject(new Error("reconcile fault")));
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: alertsRouter({}, () => [amAlert("fp-1")]),
      monotonicNow: () => 0,
      wallNow: () => new Date(0),
      ackStore: store,
    });

    await runtime.runOnce();
    const cycle = runtime.getContext(null).cycle;
    expect(cycle).not.toBeNull();
    expect(cycle!.observation.seq).toBe(1);
    expect(store.events).toEqual(["reconcile", "foldView"]);
    expect(cycle!.alerts.value.alerts[0]!.ack).toEqual(ACK);
    runtime.close();
  });
});
