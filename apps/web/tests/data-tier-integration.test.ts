// apps/web/tests/data-tier-integration.test.ts — final cross-cutting data-tier integration
// evidence (item 060, 11-testing-strategy.md §§4,11; TRACEABILITY REQ-CYCLE-04 / SC-01, REQ-SEC-02).
//
// Two closures that no single earlier suite owned:
//   1. A ≥30-simulated-minute healthy-source cadence run driving the REAL `createServerRuntime`
//      scheduler, asserting the p95 interval between authoritative publications is ≤12 s (core)
//      and ≤70 s (slow) — the statistical bound REQ-CYCLE-04 and SC-01 require (the earlier
//      scheduler tests prove the deadline-grid *mechanism*, not the measured p95).
//   2. A positive production guard that the web process never loads `estate.yaml` or the core
//      estate-source loader — it consumes only the rendered bundle (REQ-SEC-02 / REQ-EST-01).
//
// This file uses no DOM: it drives the runtime and reads source from disk, so it needs no
// happy-dom registration and no dom-guard opt-out marker.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadServerConfig } from "../src/server/config.js";
import { createServerRuntime } from "../src/server/refresh.js";
import { makeEstateBundleFixture, type EstateBundleFixture } from "./factories/estate-bundle.js";

// ── On-disk bundle harness (mirrors refresh.test.ts) ───────────────────────────────────────────────

let dir: string;
let modelPath: string;
let mtimeSeq: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pulse-dti-"));
  modelPath = join(dir, "web-estate-model.json");
  mtimeSeq = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeValid(fixture: EstateBundleFixture): void {
  const t = new Date(mtimeSeq++);
  writeFileSync(modelPath, fixture.files.model);
  writeFileSync(join(dir, "web-coverage.json"), fixture.files.coverage ?? "");
  writeFileSync(join(dir, "web-findings.json"), fixture.files.findings ?? "");
  for (const name of ["web-estate-model.json", "web-coverage.json", "web-findings.json"]) {
    utimesSync(join(dir, name), t, t);
  }
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

// ── Routing fetch (minimal valid bodies; healthy every cycle) ──────────────────────────────────────

type Calls = Record<string, number>;

/** Classify a request; the data/legacy path collisions are disambiguated by query string. */
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
      return [];
  }
}

function makeRouter(calls: Calls): typeof fetch {
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input.toString());
    const cat = classify(u);
    calls[cat] = (calls[cat] ?? 0) + 1;
    return new Response(JSON.stringify(bodyFor(cat)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return impl as unknown as typeof fetch;
}

/** Fake chained-timer + monotonic clock. The scheduler keeps exactly one timer pending. */
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
    wallNow: () => new Date(clock),
    setTimer,
    clearTimer,
    setClock(v: number) {
      clock = v;
    },
    lastDelay(): number {
      return delays[delays.length - 1] ?? 0;
    },
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

/** Nearest-rank p95 of a sample set (ms). */
function p95(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1));
  return s[idx]!;
}

// ── SC-01 / REQ-CYCLE-04 healthy-source cadence p95 ────────────────────────────────────────────────

describe("data-tier integration — healthy cadence p95 over 30 simulated minutes (REQ-CYCLE-04, SC-01)", () => {
  // Every upstream call resolves promptly (no hang/block), which is the "healthy-source operation"
  // precondition the requirement targets: publication timing is then governed purely by the
  // scheduler's chained 10 s / 60 s deadline grid, not by upstream latency. (One source returning a
  // bounded data-completeness degradation does not delay a publication — the cycle still publishes.)
  test("core publication-interval p95 ≤ 12 s and slow-tier p95 ≤ 70 s across ≥180 core cycles", async () => {
    writeValid(makeEstateBundleFixture());
    const calls: Calls = {};
    const sch = fakeScheduler();
    const runtime = createServerRuntime(loadServerConfig(fullEnv()), {
      fetchImpl: makeRouter(calls),
      monotonicNow: sch.monotonicNow,
      wallNow: sch.wallNow,
      setTimer: sch.setTimer,
      clearTimer: sch.clearTimer,
    });

    // Varied but healthy acquisition durations, all well-defined per cycle: mostly fast, a few
    // moderately-slow, and exactly one genuine overrun (>10 s cadence) that the grid absorbs.
    const durFor = (i: number): number => {
      if (i === 100) return 13_000; // one overrun
      if (i === 30 || i === 75 || i === 150) return 7_000; // moderately slow
      return 1_500; // fast/healthy
    };

    const CYCLES = 180; // 180 core cycles × 10 s grid = 1,800 s = 30 minutes
    const coreObserved: number[] = [];
    const slowObserved: number[] = [];

    await runtime.start(); // prime: seq 1 at clock 0; slow tier is due (no prior records)
    let prevPublish = 0;
    coreObserved.push(0);
    slowObserved.push(0); // the prime cycle refreshed the slow tier
    let prevBuildinfo = calls["data:buildinfo"] ?? 0;

    for (let i = 1; i <= CYCLES; i++) {
      // The timer fires at prevPublish + armedDelay; the cycle's acquisition then takes dur(i), so
      // the publication lands at prevPublish + armedDelay + dur(i). Reading the ACTUAL armed delay
      // keeps this faithful across the overrun's grid-anchored catch-up (delay clamps to 0).
      const fireClock = prevPublish + sch.lastDelay() + durFor(i);
      sch.setClock(fireClock);
      await sch.fire();

      const obsAt = Date.parse(runtime.getContext(null).cycle!.observation.observedAt);
      coreObserved.push(obsAt);
      const buildinfo = calls["data:buildinfo"] ?? 0;
      if (buildinfo > prevBuildinfo) {
        slowObserved.push(obsAt); // this publication refreshed the slow tier
        prevBuildinfo = buildinfo;
      }
      prevPublish = fireClock;
    }

    // ≥180 core publications actually happened over the 30-minute window (no overlap/skip/dup).
    expect(runtime.getContext(null).cycle!.observation.seq).toBe(CYCLES + 1);
    expect(coreObserved.length).toBe(CYCLES + 1);

    const coreIntervals = coreObserved.slice(1).map((t, i) => t - coreObserved[i]!);
    const slowIntervals = slowObserved.slice(1).map((t, i) => t - slowObserved[i]!);

    // The core tier refreshes every ~10 s (p95 ≤ 12 s); the overrun is a single tail outlier the
    // grid absorbs, so the 95th-percentile interval stays on the healthy grid.
    expect(p95(coreIntervals)).toBeLessThanOrEqual(12_000);
    // The slow tier refreshes every ~60 s (p95 ≤ 70 s).
    expect(slowObserved.length).toBeGreaterThanOrEqual(25); // ~30 slow refreshes over 30 min
    expect(p95(slowIntervals)).toBeLessThanOrEqual(70_000);

    // Sanity: the healthy grid dominates — the vast majority of core intervals are ~10 s.
    const onGrid = coreIntervals.filter((d) => d <= 12_000).length;
    expect(onGrid / coreIntervals.length).toBeGreaterThanOrEqual(0.95);

    runtime.close();
  }, 60_000);
});

// ── REQ-SEC-02 / REQ-EST-01: the web process never loads estate.yaml ───────────────────────────────

const APP = resolve(import.meta.dir, "..");

/** Every production `.ts`/`.tsx` under `src/server` (excluding the dev-only mock loop) + `src/shared`. */
function productionServerSources(): string[] {
  const roots = [resolve(APP, "src/server"), resolve(APP, "src/shared")];
  const devDir = resolve(APP, "src/server/dev");
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        if (full === devDir) continue; // dev mock loop is not the production web process
        walk(full);
        continue;
      }
      if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/** Strip line and block comments so a doc-comment mention of `estate.yaml` is never a false positive. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("data-tier integration — the web process never loads estate source (REQ-SEC-02, REQ-EST-01)", () => {
  const sources = productionServerSources();

  test("no production server/shared module references estate.yaml", () => {
    expect(sources.length).toBeGreaterThan(5); // the scan actually found the production tree
    const offenders = sources.filter((f) => stripComments(readFileSync(f, "utf8")).includes("estate.yaml"));
    expect(offenders.map((f) => f.replace(APP, "apps/web"))).toEqual([]);
  });

  test("no production server/shared module imports the core estate-source loader", () => {
    // The web tier consumes only the rendered bundle (web-estate-model.json etc.) via its own
    // estate-bundle loader; it must never import @pulse/core's estate.yaml source readers.
    const CORE_ESTATE_LOADERS = ["readEstateDir", "loadAndValidate"];
    const offenders: string[] = [];
    for (const f of sources) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const line of src.split("\n")) {
        const trimmed = line.trimStart();
        if (!trimmed.startsWith("import")) continue;
        if (!line.includes('@pulse/core')) continue;
        if (CORE_ESTATE_LOADERS.some((sym) => new RegExp(`\\b${sym}\\b`).test(line))) {
          offenders.push(`${f.replace(APP, "apps/web")}: ${trimmed}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
