// stack/alerting/tests/synthetic.vm.test.ts
// Tier B (Docker-gated, hermetic): evaluates the RENDERED GatusCheckFailed rule (issue #1) against a
// throwaway VictoriaMetrics at the stack's exact pin, over scripted Gatus check histories, replaying
// vmalert's evaluation loop (see vm-emulator.ts for what is modelled: ALERTS write-back, the resolve
// staleness marker, failed evaluations, vmalert outages that lose state). Also validates the
// rendered rule FILE with the pinned vmalert's own `-dryRun`.
//
// Gated like the promtool/amtool suites: `DOCKER_OK ? describe : describe.skip`.
/// <reference path="./bun-test.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { buildAlertingConfig } from "../src/index.js";
import { buildSyntheticRules, syntheticExpr } from "../src/transform/synthetic-rules.js";
import { GATUS_CHECKS } from "../src/constants.js";
import type { EstateModel, Service } from "../src/transform/estate.js";
import { DOCKER_OK, VMALERT_IMAGE, loadFixtureInput, run } from "./harness.js";
import {
  Vm,
  checks,
  evalLoop,
  gatusAlertLabels,
  historicalBase,
  scrapeLines,
  type Check,
  type History,
} from "./vm-emulator.js";

const d = DOCKER_OK ? describe : describe.skip;

const M = 60; // one minute, in seconds
const EVAL = GATUS_CHECKS.evaluationIntervalSeconds; // the rendered group's interval (30s)
const CHECK_PHASE = 5; // Gatus checks land at :05 (nominal cadence); scrapes at :20/:50
const END = 45 * M; // simulated span
const PROV = { file: "estate.yaml", path: "services", line: 1, col: 1 } as const;

/** A scripted scenario: a Gatus history plus binding thresholds and vmalert faults. */
interface Scenario extends Omit<History, "name"> {
  service: string;
  /** Override the endpoint name (the same-name-in-two-groups case); default `<group>/<service>`. */
  name?: string;
  failureThreshold?: number;
  successThreshold?: number;
  /** Evaluations (seconds) that fail outright — no result, no ALERTS write, state kept. */
  failedEvals?: number[];
  /** vmalert down over each `[from, to)` — no evaluations, and it returns with no state. */
  vmalertDown?: Array<[number, number]>;
}

const pass = (): boolean => true;
const fail = (): boolean => false;
/** Nominal-cadence checks for minutes [fromMin, toMin). */
const minutes = (fromMin: number, toMin: number, ok: (i: number) => boolean): Check[] =>
  checks(fromMin * M + CHECK_PHASE, toMin - fromMin, M, ok);
/** Every evaluation in [from, to] seconds. */
const evalsBetween = (from: number, to: number): number[] =>
  Array.from({ length: Math.floor((to - from) / EVAL) + 1 }, (_, i) => from + i * EVAL);

/** Every scenario, keyed by id. Groups are distinct so all share one VictoriaMetrics. */
const SCENARIOS: Record<string, Scenario> = {
  // Healthy 0–9m, failing 10–19m, healthy again from 20m.
  steady: {
    group: "g-steady",
    service: "web",
    checks: [...minutes(0, 10, pass), ...minutes(10, 20, fail), ...minutes(20, 45, pass)],
  },
  // As steady, then ONE failure (26m05) right after the alert resolved: must not re-fire.
  blipAfterResolve: {
    group: "g-blip",
    service: "web",
    checks: [
      ...minutes(0, 10, pass),
      ...minutes(10, 20, fail),
      ...minutes(20, 26, pass),
      ...minutes(26, 27, fail),
      ...minutes(27, 45, pass),
    ],
  },
  // A lone failure between passes, over and over.
  alternating: { group: "g-alt", service: "web", checks: minutes(0, 45, (i) => i % 2 === 0) },
  // Two consecutive failures then a pass, repeated: below the default threshold of 3.
  bursts: { group: "g-burst", service: "web", checks: minutes(0, 45, (i) => i % 3 === 2) },
  // …and the same F F S pattern at a slightly slow 70s cadence.
  ffs70: { group: "g-ffs70", service: "web", checks: checks(CHECK_PHASE, 38, 70, (i) => i % 3 === 2) },
  // Healthy, Gatus down 5–20m, restarts (counters reset) with the endpoint failing.
  restart: {
    group: "g-restart",
    service: "web",
    checks: [...minutes(0, 5, pass), ...minutes(20, 45, fail)],
    down: [[5 * M, 20 * M]],
    resets: [20 * M],
  },
  // Two failures, a pass, Gatus down 6m, back (counters reset) with ONE failure, then healthy.
  gapOldFails: {
    group: "g-gap",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...minutes(5, 7, fail),
      ...minutes(7, 8, pass),
      ...minutes(14, 15, fail),
      ...minutes(15, 45, pass),
    ],
    down: [[8 * M, 14 * M]],
    resets: [14 * M],
  },
  // Failing 5–9m (fires), Gatus down 9m30–25m mid-outage, restarts healthy.
  gatusDown: {
    group: "g-down",
    service: "web",
    checks: [...minutes(0, 5, pass), ...minutes(5, 10, fail), ...minutes(25, 45, pass)],
    down: [[9 * M + 30, 25 * M]],
    resets: [25 * M],
  },
  // Same, plus 4 minutes of failed vmalert evaluations (a VM restart) during the hold.
  holdGap: {
    group: "g-gap4",
    service: "web",
    checks: [...minutes(0, 5, pass), ...minutes(5, 10, fail), ...minutes(25, 45, pass)],
    down: [[9 * M + 30, 25 * M]],
    resets: [25 * M],
    failedEvals: evalsBetween(14 * M, 18 * M),
  },
  // Same, but vmalert itself is down 14–16m and comes back with no memory.
  vmalertRestart: {
    group: "g-varestart",
    service: "web",
    checks: [...minutes(0, 5, pass), ...minutes(5, 10, fail), ...minutes(25, 45, pass)],
    down: [[9 * M + 30, 25 * M]],
    resets: [25 * M],
    vmalertDown: [[14 * M, 16 * M]],
  },
  // KNOWN LIMIT: as steady, but vmalert is down 21m–24m30, across the evaluation where CLEAR first
  // holds (23m30), so no staleness marker is written; then ONE failure at 24m05.
  vmalertDownAtClear: {
    group: "g-vadown",
    service: "web",
    checks: [
      ...minutes(0, 10, pass),
      ...minutes(10, 20, fail),
      ...minutes(20, 24, pass),
      ...minutes(24, 25, fail),
      ...minutes(25, 45, pass),
    ],
    vmalertDown: [[21 * M, 24 * M + 30]],
  },
  // Fires, then F/S alternation 10–21m (only the HOLD keeps it), then clean from 22m.
  flapAfterFiring: {
    group: "g-fsf",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...minutes(5, 10, fail),
      ...minutes(10, 22, (i) => i % 2 === 0),
      ...minutes(22, 45, pass),
    ],
  },
  // Same, with ONE failed vmalert evaluation in the hold-only phase.
  holdDropOne: {
    group: "g-drop1",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...minutes(5, 10, fail),
      ...minutes(10, 22, (i) => i % 2 === 0),
      ...minutes(22, 45, pass),
    ],
    failedEvals: [15 * M],
  },
  // Broad outage slows Gatus to one check per 90s, then it recovers at the same slow cadence.
  slow90: {
    group: "g-slow90",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...checks(5 * M + CHECK_PHASE, 14, 90, fail), // 5m05 … 24m35
      ...checks(26 * M + CHECK_PHASE, 12, 90, pass),
    ],
  },
  // …one per 120s…
  slow120: {
    group: "g-slow120",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...checks(5 * M + CHECK_PHASE, 11, 120, fail), // 5m05 … 25m05
      ...checks(27 * M + CHECK_PHASE, 9, 120, pass),
    ],
  },
  // …one per 180s…
  slow180: {
    group: "g-slow180",
    service: "web",
    checks: [...minutes(0, 5, pass), ...checks(5 * M + CHECK_PHASE, 14, 180, fail)],
  },
  // …and one per 300s.
  slow300: {
    group: "g-slow300",
    service: "web",
    checks: [...minutes(0, 5, pass), ...checks(5 * M + CHECK_PHASE, 8, 300, fail)],
  },
  // success_threshold 10, recovering at a slightly slow 63s cadence: must still clear.
  largeS63: {
    group: "g-large-s",
    service: "web",
    successThreshold: 10,
    checks: [...minutes(0, 5, pass), ...minutes(5, 10, fail), ...checks(10 * M + CHECK_PHASE, 33, 63, pass)],
  },
  // The same endpoint name in three groups: a and c fail, b stays healthy.
  dupA: {
    group: "dup-a",
    service: "web",
    name: "shared/web",
    checks: [...minutes(0, 5, pass), ...minutes(5, 45, fail)],
  },
  dupB: { group: "dup-b", service: "web", name: "shared/web", checks: minutes(0, 45, pass) },
  dupC: {
    group: "dup-c",
    service: "web",
    name: "shared/web",
    checks: [...minutes(0, 8, pass), ...minutes(8, 45, fail)],
  },
};

const endpointOf = (s: Scenario): string => s.name ?? `${s.group}/${s.service}`;

/** The rendered rule expression for every scenario, keyed by id. Normal names go through
 *  `buildSyntheticRules` (the full rendered rule); the duplicate-name ones (which an estate cannot
 *  produce — the name embeds the host) through the builder's own `syntheticExpr`. */
function renderExprs(): Record<string, string> {
  const services: Service[] = Object.values(SCENARIOS)
    .filter((s) => s.name === undefined)
    .map((s) => ({
      name: s.service,
      host: s.group,
      kind: "http",
      managed: true,
      ingressUrl: `https://${s.group}.example/`,
      alerts: [
        {
          type: "custom",
          ...(s.failureThreshold !== undefined ? { failureThreshold: s.failureThreshold } : {}),
          ...(s.successThreshold !== undefined ? { successThreshold: s.successThreshold } : {}),
        },
      ],
      provenance: PROV,
    }));
  const estate: EstateModel = {
    schemaMajor: 1,
    estate: { name: "vm-fixture", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
    hosts: [],
    services,
    channels: [],
    routingOverrides: [],
    suppressions: [],
  };
  const doc = parse(buildSyntheticRules(estate, [])) as {
    groups: Array<{ interval: string; rules: Array<{ expr: string; labels: Record<string, string> }> }>;
  };
  expect(doc.groups[0]!.interval).toBe(`${EVAL}s`);
  const byEndpoint = new Map(doc.groups[0]!.rules.map((r) => [r.labels.endpoint!, r.expr]));
  const out: Record<string, string> = {};
  for (const [id, s] of Object.entries(SCENARIOS)) {
    const endpoint = endpointOf(s);
    out[id] =
      s.name === undefined
        ? byEndpoint.get(endpoint)!
        : syntheticExpr(endpoint, s.group, {
            failures: GATUS_CHECKS.defaultFailureThreshold,
            successes: GATUS_CHECKS.defaultSuccessThreshold,
          });
  }
  return out;
}

d("synthetic-check rules on VictoriaMetrics (Tier B, issue #1)", () => {
  let vm: Vm | undefined;
  /** Eval times (seconds into the simulation) at which each scenario's rule fired. */
  let firing: Record<string, number[]> = {};

  beforeAll(async () => {
    vm = await Vm.start();
    const t0 = historicalBase();
    await vm.import(
      Object.values(SCENARIOS).flatMap((s) => scrapeLines({ ...s, name: endpointOf(s) }, t0, END)),
    );
    const exprs = renderExprs();
    firing = await evalLoop(
      vm,
      t0,
      Object.entries(SCENARIOS).map(([id, s]) => ({
        id,
        expr: exprs[id]!,
        alertLabels: gatusAlertLabels(endpointOf(s), s.group),
        ...(s.failedEvals ? { failedEvals: s.failedEvals } : {}),
        ...(s.vmalertDown ? { vmalertDown: s.vmalertDown } : {}),
      })),
      { interval: EVAL, end: END },
    );
  }, 300_000);

  afterAll(() => {
    // PULSE_DEBUG_SYNTHETIC=1 prints each scenario's firing evaluations (in minutes).
    if (process.env.PULSE_DEBUG_SYNTHETIC) {
      for (const [id, ts] of Object.entries(firing)) console.log(id, ts.map((t) => t / M).join(","));
    }
    vm?.stop();
  });

  /** True iff the firing evaluations form one unbroken run, treating the scenario's failed
   *  evaluations and vmalert-down evaluations (which produce nothing) as neutral. */
  const contiguous = (id: string): boolean => {
    const ts = firing[id]!;
    const s = SCENARIOS[id]!;
    const neutral = (t: number): boolean =>
      (s.failedEvals ?? []).includes(t) || (s.vmalertDown ?? []).some(([a, b]) => t >= a && t < b);
    return ts.every((t, i) => {
      if (i === 0) return true;
      for (let g = ts[i - 1]! + EVAL; g < t; g += EVAL) if (!neutral(g)) return false;
      return true;
    });
  };
  const first = (id: string): number => firing[id]![0] ?? Number.NaN;
  const last = (id: string): number => firing[id]!.at(-1) ?? Number.NaN;

  test("steady outage fires at the 3rd failure and stays firing", () => {
    // Failures 10m05, 11m05, 12m05 (3rd scraped 12m20); the 3m window drops the 9m05 pass
    // (scraped 9m20) from the 12m30 evaluation.
    expect(first("steady")).toBe(12 * M + 30);
    expect(contiguous("steady")).toBe(true);
  });

  test("recovery resolves only after 2 clean checks and a failure-free clear window", () => {
    // Last failure 19m05 (scraped 19m20) leaves the 4m clear window after 23m20 → resolved 23m30.
    expect(last("steady")).toBe(23 * M);
  });

  test("one failure right after resolve does not re-fire (no resurrection through the hold)", () => {
    expect(firing.blipAfterResolve).toEqual(firing.steady);
  });

  test("single (alternating) failures never fire", () => {
    expect(firing.alternating).toEqual([]);
  });

  test("two-failure bursts never fire, at 60s or at 70s cadence", () => {
    expect(firing.bursts).toEqual([]);
    expect(firing.ffs70).toEqual([]);
  });

  test("restart after a long Gatus gap needs 3 fresh failures (not the first)", () => {
    // Gatus back at 20m with reset counters; failures 20m05, 21m05, 22m05 (scraped 22m20).
    expect(first("restart")).toBe(22 * M + 30);
    expect(contiguous("restart")).toBe(true);
  });

  test("failures before a Gatus gap (separated by a pass) never add up to a firing", () => {
    expect(firing.gapOldFails).toEqual([]);
  });

  test("Gatus down mid-outage keeps the alert firing until fresh clean checks", () => {
    expect(first("gatusDown")).toBe(7 * M + 30);
    expect(contiguous("gatusDown")).toBe(true);
    // Down 9m30–25m: no data, still firing. Gatus comes back with reset counters and passes at
    // 25m05, 26m05 (scraped 26m20): 2 passes, no failure in the clear window → resolved at 26m30.
    expect(last("gatusDown")).toBe(26 * M);
  });

  test("4 minutes of failed evaluations during the hold (within the 5m lookback) do not resolve it", () => {
    expect(contiguous("holdGap")).toBe(true);
    expect(firing.holdGap).toEqual(
      firing.gatusDown!.filter((t) => !SCENARIOS.holdGap!.failedEvals!.includes(t)),
    );
  });

  test("a vmalert restart (state lost) during the hold resumes firing from its own ALERTS", () => {
    expect(contiguous("vmalertRestart")).toBe(true);
    expect(last("vmalertRestart")).toBe(last("gatusDown"));
  });

  test("KNOWN LIMIT: vmalert down when CLEAR first holds → one later failure re-fires", () => {
    // No staleness marker was written (vmalert was down), so the last ALERTS sample (20m30) is
    // still inside the 5m lookback at 24m30, when the 24m05 failure makes CLEAR false → it
    // re-fires on a single failure. Pinned here so a future fix shows up as a change.
    expect(firing.vmalertDownAtClear!.some((t) => t >= 24 * M + 30)).toBe(true);
  });

  test("F S F after firing does not resolve; the clean run then does", () => {
    expect(first("flapAfterFiring")).toBe(7 * M + 30);
    expect(contiguous("flapAfterFiring")).toBe(true);
    // Last failure 21m05 (scraped 21m20) leaves the 4m clear window after 25m20.
    expect(last("flapAfterFiring")).toBe(25 * M);
  });

  test("one failed vmalert evaluation during the hold does not resolve the alert", () => {
    expect(contiguous("holdDropOne")).toBe(true);
    expect(first("holdDropOne")).toBe(first("flapAfterFiring"));
    expect(last("holdDropOne")).toBe(last("flapAfterFiring"));
  });

  test("slow cadence (90/120/180/300s) still fires — later — and never flaps", () => {
    for (const id of ["slow90", "slow120", "slow180", "slow300"]) {
      expect(firing[id]!.length, `${id} fires`).toBeGreaterThan(0);
      expect(contiguous(id), `${id} contiguous`).toBe(true);
    }
    expect(first("slow90")).toBeLessThanOrEqual(10 * M); // the 210s window catches 3 × 90s
    expect(first("slow120")).toBeLessThanOrEqual(18 * M); // slow window: no pass in 12m
    expect(first("slow180")).toBeLessThanOrEqual(18 * M);
    expect(first("slow300")).toBeLessThanOrEqual(21 * M);
  });

  test("slow recovery needs 2 passes, not 1", () => {
    // slow90 passes at 26m05, 27m35 (scraped 27m50); slow120 at 27m05, 29m05 (scraped 29m20).
    expect(last("slow90")).toBeGreaterThanOrEqual(27 * M + 30);
    expect(last("slow90")).toBeLessThan(END);
    expect(last("slow120")).toBeGreaterThanOrEqual(29 * M);
    expect(last("slow120")).toBeLessThan(END);
  });

  test("a large success threshold (10) still clears at a slightly slow (63s) cadence", () => {
    expect(contiguous("largeS63")).toBe(true);
    // Passes from 10m05 every 63s; the 10th lands at 19m32 — never resolved before that.
    expect(last("largeS63")).toBeGreaterThanOrEqual(19 * M + 30);
    expect(last("largeS63")).toBeLessThan(END);
  });

  test("the same name in different groups gives independent alerts", () => {
    expect(first("dupA")).toBe(7 * M + 30);
    expect(first("dupC")).toBe(10 * M + 30);
    expect(firing.dupB).toEqual([]);
    expect(contiguous("dupA")).toBe(true);
    expect(contiguous("dupC")).toBe(true);
  });
});

d("rendered synthetic.yml loads in the pinned vmalert (-dryRun, Tier B)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pulse-vmalert-dryrun-"));
    chmodSync(dir, 0o755); // the image's non-root user must traverse the mount
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const dryRun = (file: string) =>
    run(["docker", "run", "--rm", "-v", `${dir}:/w:ro`, VMALERT_IMAGE, "-dryRun", `-rule=/w/${file}`]);

  test("the multi-service fixture's synthetic.yml passes vmalert -dryRun", () => {
    const yaml = buildAlertingConfig(loadFixtureInput("multi-service")).syntheticRules;
    expect(yaml).toContain("GatusCheckFailed");
    writeFileSync(join(dir, "synthetic.yml"), yaml, { mode: 0o644 });
    const res = dryRun("synthetic.yml");
    expect(res.exitCode, res.stdout + res.stderr).toBe(0);
  }, 120_000);

  test("sanity: vmalert -dryRun rejects a malformed rule file", () => {
    writeFileSync(join(dir, "bad.yml"), "groups:\n  - name: x\n    interval: soon\n    rules: []\n", {
      mode: 0o644,
    });
    expect(dryRun("bad.yml").exitCode).not.toBe(0);
  }, 120_000);
});
