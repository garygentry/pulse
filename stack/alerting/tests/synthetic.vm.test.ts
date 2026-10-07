// stack/alerting/tests/synthetic.vm.test.ts
// Tier B (Docker-gated, hermetic): evaluates the RENDERED GatusCheckFailed rule (issue #1) against a
// throwaway VictoriaMetrics at the stack's exact pin, over scripted Gatus check histories.
//
// Why not promtool: MetricsQL's increase() is not Prometheus's — it does not extrapolate and it
// counts a brand-new series' first sample — and the rule's whole threshold logic rides on it. So
// this suite imports synthetic `gatus_results_total` scrapes (30s, like the `gatus` job) into the
// real engine and plays vmalert's evaluation loop: every 60s it runs the rule's instant query, and
// for each firing result it writes the ALERTS sample vmalert would remote-write (same label set as
// vmalert v1.102.1 writes: alert labels + alertname/alertstate/alertgroup + the estate external
// label), so the rule's self-referencing HOLD term reads back real state.
//
// Gated like the promtool/amtool suites: `DOCKER_OK ? describe : describe.skip`.
/// <reference path="./bun-test.d.ts" />
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { buildSyntheticRules, syntheticExpr } from "../src/transform/synthetic-rules.js";
import { GATUS_CHECKS } from "../src/constants.js";
import type { EstateModel, Service } from "../src/transform/estate.js";
import { DOCKER_OK, VM_IMAGE, run } from "./harness.js";

const d = DOCKER_OK ? describe : describe.skip;

const M = 60; // one minute, in seconds
const SCRAPE = 30; // the `gatus` scrape interval (scrape.yml global)
const SCRAPE_PHASE = 20; // scrapes land at :20/:50 — off the check and evaluation instants
const CHECK_PHASE = 5; // Gatus checks land at :05 (nominal cadence)
const END = 40 * M; // simulated span
const PROV = { file: "estate.yaml", path: "services", line: 1, col: 1 } as const;

/** One Gatus check result at `at` seconds into the simulation. */
interface Check {
  at: number;
  ok: boolean;
}

/** A scripted Gatus history for one endpoint (one `name`/`group`). */
interface Scenario {
  group: string;
  service: string;
  /** Gatus not running (no scrapes, no checks) over each `[from, to)`. */
  down?: Array<[number, number]>;
  /** Gatus (re)start instants: every counter restarts from zero. */
  resets?: number[];
  checks: Check[];
  /** Override the endpoint name (the same-name-in-two-groups case); default `<group>/<service>`. */
  name?: string;
}

/** `count` checks every `cadence` seconds from `from`, each `ok(i)`. */
function checks(from: number, count: number, cadence: number, ok: (i: number) => boolean): Check[] {
  return Array.from({ length: count }, (_, i) => ({ at: from + i * cadence, ok: ok(i) }));
}
const pass = (): boolean => true;
const fail = (): boolean => false;
/** Nominal-cadence checks for minutes [fromMin, toMin). */
const minutes = (fromMin: number, toMin: number, ok: (i: number) => boolean): Check[] =>
  checks(fromMin * M + CHECK_PHASE, toMin - fromMin, M, ok);

/** Every scenario, keyed by id. Groups are distinct so all share one VictoriaMetrics. */
const SCENARIOS: Record<string, Scenario> = {
  // Healthy 0–9m, failing 10–19m, healthy again from 20m.
  steady: {
    group: "g-steady",
    service: "web",
    checks: [...minutes(0, 10, pass), ...minutes(10, 20, fail), ...minutes(20, 40, pass)],
  },
  // A lone failure between passes, over and over.
  alternating: {
    group: "g-alt",
    service: "web",
    checks: minutes(0, 40, (i) => i % 2 === 0),
  },
  // Two consecutive failures then a pass, repeated: below the default threshold of 3.
  bursts: {
    group: "g-burst",
    service: "web",
    checks: minutes(0, 40, (i) => i % 3 === 2),
  },
  // Healthy, Gatus down 5–20m, restarts (counters reset) with the endpoint failing.
  restart: {
    group: "g-restart",
    service: "web",
    checks: [...minutes(0, 5, pass), ...minutes(20, 40, fail)],
    down: [[5 * M, 20 * M]],
    resets: [20 * M],
  },
  // Failing 5–9m (fires), Gatus down 9m30–25m mid-outage, restarts healthy.
  gatusDown: {
    group: "g-down",
    service: "web",
    checks: [...minutes(0, 5, pass), ...minutes(5, 10, fail), ...minutes(25, 40, pass)],
    down: [[9 * M + 30, 25 * M]],
    resets: [25 * M],
  },
  // Fires, then pass/fail alternation (F S F …) 10–21m, then clean from 22m.
  flapAfterFiring: {
    group: "g-fsf",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...minutes(5, 10, fail),
      ...minutes(10, 22, (i) => i % 2 === 0),
      ...minutes(22, 40, pass),
    ],
  },
  // Broad outage slows Gatus to one check per 90s, then it recovers at the same slow cadence.
  slow90: {
    group: "g-slow90",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...checks(5 * M + CHECK_PHASE, 10, 90, fail), // 5m05 … 18m35
      ...checks(20 * M + CHECK_PHASE, 12, 90, pass), // 20m05 …
    ],
  },
  // …and one per 120s.
  slow120: {
    group: "g-slow120",
    service: "web",
    checks: [
      ...minutes(0, 5, pass),
      ...checks(5 * M + CHECK_PHASE, 8, 120, fail), // 5m05 … 19m05
      ...checks(21 * M + CHECK_PHASE, 9, 120, pass), // 21m05 …
    ],
  },
  // …one per 180s…
  slow180: {
    group: "g-slow180",
    service: "web",
    checks: [...minutes(0, 5, pass), ...checks(5 * M + CHECK_PHASE, 12, 180, fail)],
  },
  // …and one per 300s: past the window's tolerance, so firing is absent — never a flap.
  slow300: {
    group: "g-slow300",
    service: "web",
    checks: [...minutes(0, 5, pass), ...checks(5 * M + CHECK_PHASE, 7, 300, fail)],
  },
  // The same endpoint name in three groups: a and c fail, b stays healthy.
  dupA: { group: "dup-a", service: "web", name: "shared/web", checks: [...minutes(0, 5, pass), ...minutes(5, 40, fail)] },
  dupB: { group: "dup-b", service: "web", name: "shared/web", checks: minutes(0, 40, pass) },
  dupC: { group: "dup-c", service: "web", name: "shared/web", checks: [...minutes(0, 8, pass), ...minutes(8, 40, fail)] },
};

const endpointOf = (s: Scenario): string => s.name ?? `${s.group}/${s.service}`;

/** The rendered rules for every scenario, keyed by scenario id: `{expr, labels}`. Normal names go
 *  through `buildSyntheticRules` (the full rendered rule); the duplicate-name ones (which an estate
 *  cannot produce — the name embeds the host) through the builder's own `syntheticExpr`. */
function renderRules(): Record<string, { expr: string; labels: Record<string, string> }> {
  const out: Record<string, { expr: string; labels: Record<string, string> }> = {};
  const services: Service[] = Object.values(SCENARIOS)
    .filter((s) => s.name === undefined)
    .map((s) => ({
      name: s.service,
      host: s.group,
      kind: "http",
      managed: true,
      ingressUrl: `https://${s.group}.example/`,
      alerts: [{ type: "custom" }],
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
    groups: Array<{ rules: Array<{ expr: string; labels: Record<string, string> }> }>;
  };
  const byEndpoint = new Map(doc.groups[0]!.rules.map((r) => [r.labels.endpoint!, r]));
  const defaults = {
    failures: GATUS_CHECKS.defaultFailureThreshold,
    successes: GATUS_CHECKS.defaultSuccessThreshold,
  };
  for (const [id, s] of Object.entries(SCENARIOS)) {
    const endpoint = endpointOf(s);
    out[id] =
      s.name === undefined
        ? byEndpoint.get(endpoint)!
        : {
            expr: syntheticExpr(endpoint, s.group, defaults),
            labels: { endpoint, group: s.group, severity: "critical", source: "gatus" },
          };
  }
  return out;
}

/** Prometheus text-format lines for every scrape of one scenario, at absolute base `t0`. */
function scrapeLines(s: Scenario, t0: number): string[] {
  const lines: string[] = [];
  const name = endpointOf(s);
  const isDown = (t: number): boolean => (s.down ?? []).some(([a, b]) => t >= a && t < b);
  for (let t = SCRAPE_PHASE; t <= END; t += SCRAPE) {
    if (isDown(t)) continue;
    const since = Math.max(-1, ...(s.resets ?? []).filter((r) => r <= t));
    for (const ok of [true, false]) {
      const n = s.checks.filter((c) => c.ok === ok && c.at > since && c.at <= t).length;
      if (n === 0) continue; // Gatus registers a labelled counter only on its first increment
      lines.push(
        `gatus_results_total{group="${s.group}",key="k-${s.group}",name="${name}",success="${ok}",type="HTTP"} ${n} ${(t0 + t) * 1000}`,
      );
    }
  }
  return lines;
}

d("synthetic-check rules on VictoriaMetrics (Tier B, issue #1)", () => {
  let container = "";
  let base = "";
  /** Eval times (seconds into the simulation) at which each scenario's rule fired. */
  const firing: Record<string, number[]> = {};

  async function vmImport(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const res = await fetch(`${base}/api/v1/import/prometheus`, { method: "POST", body: lines.join("\n") });
    expect(res.status, await res.text()).toBe(204);
    await fetch(`${base}/internal/force_flush`);
  }

  async function vmQueryCount(expr: string, at: number): Promise<number> {
    const url = `${base}/api/v1/query?nocache=1&time=${at}&query=${encodeURIComponent(expr)}`;
    const body = (await (await fetch(url)).json()) as {
      status: string;
      data?: { result: unknown[] };
      error?: string;
    };
    expect(body.status, body.error ?? "").toBe("success");
    return body.data!.result.length;
  }

  beforeAll(async () => {
    const started = run(["docker", "run", "-d", "--rm", "-p", "127.0.0.1::8428", VM_IMAGE]);
    expect(started.exitCode, started.stderr).toBe(0);
    container = started.stdout.trim();
    const port = run(["docker", "port", container, "8428/tcp"]).stdout.trim().split("\n")[0]!;
    base = `http://${port}`;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${base}/health`)).ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Simulate on a past, hour-aligned base so every sample is historical (no latency offset).
    const t0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3 * 3600;
    await vmImport(Object.values(SCENARIOS).flatMap((s) => scrapeLines(s, t0)));

    // vmalert's loop: evaluate every 60s; a firing result is remote-written as ALERTS.
    const rules = renderRules();
    for (const id of Object.keys(SCENARIOS)) firing[id] = [];
    for (let t = M; t <= END; t += M) {
      const alerts: string[] = [];
      for (const [id, rule] of Object.entries(rules)) {
        if ((await vmQueryCount(rule.expr, t0 + t)) === 0) continue;
        firing[id]!.push(t);
        const s = SCENARIOS[id]!;
        const labels = {
          ...rule.labels,
          name: endpointOf(s),
          group: s.group,
          alertname: "GatusCheckFailed",
          alertstate: "firing",
          alertgroup: "synthetic-checks",
          estate: "vm-fixture",
        };
        const sel = Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(",");
        alerts.push(`ALERTS{${sel}} 1 ${(t0 + t) * 1000}`);
      }
      await vmImport(alerts);
    }
  }, 240_000);

  afterAll(() => {
    // PULSE_DEBUG_SYNTHETIC=1 prints each scenario's firing evaluations (in minutes).
    if (process.env.PULSE_DEBUG_SYNTHETIC) {
      for (const [id, ts] of Object.entries(firing)) console.log(id, ts.map((t) => t / M).join(","));
    }
    if (container !== "") run(["docker", "rm", "-f", container]);
  });

  /** True iff the firing evaluations form one unbroken run (no flap / false resolve). */
  const contiguous = (ts: number[]): boolean => ts.every((t, i) => i === 0 || t - ts[i - 1]! === M);
  const first = (id: string): number => firing[id]![0] ?? Number.NaN;
  const last = (id: string): number => firing[id]!.at(-1) ?? Number.NaN;

  test("steady outage fires at ~the 3rd failure and stays firing", () => {
    // Failures at 10m05, 11m05, 12m05 (3rd scraped 12m20) → first eval that can see 3 is 13m.
    expect(first("steady")).toBe(13 * M);
    expect(contiguous(firing.steady!)).toBe(true);
  });

  test("recovery resolves only after ~2 clean checks", () => {
    // Passes at 20m05, 21m05: still firing at 21m (one pass seen); resolved once the last failure
    // (19m05, scraped 19m20) leaves the 3m clear window → resolved from the 23m evaluation.
    expect(last("steady")).toBeGreaterThanOrEqual(21 * M);
    expect(last("steady")).toBeLessThanOrEqual(22 * M);
  });

  test("single (alternating) failures never fire", () => {
    expect(firing.alternating).toEqual([]);
  });

  test("two-failure bursts below the threshold never fire", () => {
    expect(firing.bursts).toEqual([]);
  });

  test("restart after a long Gatus gap needs 3 fresh failures (not the first)", () => {
    // Gatus back at 20m with reset counters; failures 20m05, 21m05, 22m05 → not before 23m.
    expect(first("restart")).toBeGreaterThanOrEqual(23 * M);
    expect(first("restart")).toBeLessThanOrEqual(24 * M);
    expect(contiguous(firing.restart!)).toBe(true);
  });

  test("Gatus down mid-outage keeps the alert firing until fresh clean checks", () => {
    expect(first("gatusDown")).toBeLessThanOrEqual(9 * M);
    expect(contiguous(firing.gatusDown!)).toBe(true);
    // Down 9m30–25m: no data at all, still firing. Back healthy at 25m05, 26m05 → resolves after.
    expect(last("gatusDown")).toBeGreaterThanOrEqual(26 * M);
    expect(last("gatusDown")).toBeLessThanOrEqual(27 * M);
  });

  test("F S F after firing does not resolve; clean checks then do", () => {
    expect(first("flapAfterFiring")).toBeLessThanOrEqual(9 * M);
    expect(contiguous(firing.flapAfterFiring!)).toBe(true);
    // Last failure 21m05; passes 22m05, 23m05, … → resolves once 21m20 leaves the 3m window.
    expect(last("flapAfterFiring")).toBeGreaterThanOrEqual(22 * M);
    expect(last("flapAfterFiring")).toBeLessThanOrEqual(24 * M);
  });

  test("90s cadence fires (later) without flapping and needs 2 passes to resolve", () => {
    expect(first("slow90")).toBeLessThanOrEqual(10 * M);
    expect(contiguous(firing.slow90!)).toBe(true);
    // Passes at 20m05 and 21m35 (scraped 21m50): still firing at 21m.
    expect(last("slow90")).toBeGreaterThanOrEqual(21 * M);
    expect(last("slow90")).toBeLessThanOrEqual(23 * M);
  });

  test("120s cadence fires (later) without flapping", () => {
    expect(first("slow120")).toBeLessThanOrEqual(12 * M);
    expect(contiguous(firing.slow120!)).toBe(true);
    expect(last("slow120")).toBeGreaterThanOrEqual(23 * M);
  });

  test("180s and 300s cadence (a broad outage stalling Gatus) still fire, later, and hold", () => {
    // Failures 5m05, 8m05, 11m05 → seen by the 12m evaluation (12m failure window).
    expect(first("slow180")).toBeLessThanOrEqual(12 * M);
    expect(contiguous(firing.slow180!)).toBe(true);
    // Failures 5m05, 10m05, 15m05 → the third lands at the window edge; fires, then holds.
    expect(first("slow300")).toBeLessThanOrEqual(16 * M);
    expect(contiguous(firing.slow300!)).toBe(true);
    expect(last("slow300")).toBe(END);
  });

  test("the same name in different groups gives independent alerts", () => {
    expect(first("dupA")).toBe(8 * M);
    expect(first("dupC")).toBe(11 * M);
    expect(firing.dupB).toEqual([]);
    expect(contiguous(firing.dupA!)).toBe(true);
    expect(contiguous(firing.dupC!)).toBe(true);
  });
});
