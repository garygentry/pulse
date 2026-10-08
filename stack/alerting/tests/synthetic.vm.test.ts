// stack/alerting/tests/synthetic.vm.test.ts
// Tier B (Docker-gated, hermetic): evaluates the RENDERED GatusCheckFailed rule (issue #1) against a
// throwaway VictoriaMetrics at the stack's exact pin, over scripted Gatus check histories, and
// validates the rendered rule FILE with the pinned vmalert's own `-dryRun`.
//
// Why not promtool: MetricsQL's increase() is not Prometheus's — it does not extrapolate and it
// counts a brand-new series' first sample — and the rule's whole threshold logic rides on it. So
// this suite imports synthetic `gatus_results_total` scrapes (30s, like the `gatus` job) into the
// real engine and plays vmalert's evaluation loop: every 60s it runs the rule's instant query; while
// the result is non-empty it remote-writes the ALERTS sample vmalert would (same label set as
// vmalert v1.102.1: alert labels + alertname/alertstate/alertgroup + the estate external label), and
// on resolve it remote-writes the Prometheus staleness marker vmalert writes. A scripted "failed
// evaluation" (VictoriaMetrics restart / query timeout) changes nothing and writes nothing.
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
import { DOCKER_OK, VM_IMAGE, VMALERT_IMAGE, loadFixtureInput, run } from "./harness.js";

const d = DOCKER_OK ? describe : describe.skip;

const M = 60; // one minute, in seconds
const SCRAPE = 30; // the `gatus` scrape interval (scrape.yml global)
const SCRAPE_PHASE = 20; // scrapes land at :20/:50 — off the check and evaluation instants
const CHECK_PHASE = 5; // Gatus checks land at :05 (nominal cadence)
const END = 45 * M; // simulated span
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
  checks: Check[];
  /** Gatus not running (no scrapes, no checks) over each `[from, to)`. */
  down?: Array<[number, number]>;
  /** Gatus (re)start instants: every counter restarts from zero. */
  resets?: number[];
  /** Evaluations (seconds) that fail outright — no query result, no ALERTS write, state kept. */
  failedEvals?: number[];
  /** Binding thresholds; omitted → the defaults (F=3, S=2). */
  failureThreshold?: number;
  successThreshold?: number;
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
/** Every eval minute in [fromMin, toMin], in seconds. */
const evalRange = (fromMin: number, toMin: number): number[] =>
  Array.from({ length: toMin - fromMin + 1 }, (_, i) => (fromMin + i) * M);

/** Every scenario, keyed by id. Groups are distinct so all share one VictoriaMetrics. */
const SCENARIOS: Record<string, Scenario> = {
  // Healthy 0–9m, failing 10–19m, healthy again from 20m.
  steady: {
    group: "g-steady",
    service: "web",
    checks: [...minutes(0, 10, pass), ...minutes(10, 20, fail), ...minutes(20, 45, pass)],
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
  // Same, with ONE failed vmalert evaluation (no ALERTS write) in the hold-only phase.
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
  // Gatus down mid-outage AND four failed evaluations in a row during the hold (VM restart).
  holdGap: {
    group: "g-gap4",
    service: "web",
    checks: [...minutes(0, 5, pass), ...minutes(5, 10, fail), ...minutes(25, 45, pass)],
    down: [[9 * M + 30, 25 * M]],
    resets: [25 * M],
    failedEvals: evalRange(14, 17),
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
    checks: [
      ...minutes(0, 5, pass),
      ...minutes(5, 10, fail),
      ...checks(10 * M + CHECK_PHASE, 33, 63, pass),
    ],
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

// ── Prometheus remote-write encoding (what vmalert sends), so ALERTS can carry staleness markers ──

/** Protobuf base-128 varint. */
function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

/** A length-delimited protobuf field. */
function field(tag: number, payload: number[]): number[] {
  return [tag, ...varint(payload.length), ...payload];
}

const utf8 = (s: string): number[] => [...new TextEncoder().encode(s)];

/** One remote-write sample: label set, value (`null` = Prometheus staleness marker), ms timestamp. */
interface RwSample {
  labels: Record<string, string>;
  value: number | null;
  tsMs: number;
}

/** Encode a prometheus.WriteRequest (timeseries=1 {labels=1 {name=1,value=2}, samples=2 {value=1
 *  double, timestamp=2 int64}}). A `null` value is the staleness NaN 0x7ff0000000000002. */
function writeRequest(samples: RwSample[]): Uint8Array {
  const body: number[] = [];
  for (const s of samples) {
    const labels = Object.entries(s.labels)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([k, v]) => field(0x0a, [...field(0x0a, utf8(k)), ...field(0x12, utf8(v))]));
    const dv = new DataView(new ArrayBuffer(8));
    if (s.value === null) {
      dv.setUint32(0, 0x00000002, true);
      dv.setUint32(4, 0x7ff00000, true);
    } else {
      dv.setFloat64(0, s.value, true);
    }
    const sample = [0x09, ...new Uint8Array(dv.buffer), 0x10, ...varint(s.tsMs)];
    body.push(...field(0x0a, [...labels, ...field(0x12, sample)]));
  }
  return new Uint8Array(body);
}

/** Snappy block format with a single literal element (valid, uncompressed). */
function snappyLiteral(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const n = data.length;
  const len = n - 1;
  const tag =
    len < 60
      ? [len << 2]
      : len < 1 << 8
        ? [60 << 2, len]
        : len < 1 << 16
          ? [61 << 2, len & 0xff, len >> 8]
          : [62 << 2, len & 0xff, (len >> 8) & 0xff, len >> 16];
  return new Uint8Array([...varint(n), ...tag, ...data]);
}

d("synthetic-check rules on VictoriaMetrics (Tier B, issue #1)", () => {
  let container = "";
  let base = "";
  let t0 = 0;
  /** Eval times (seconds into the simulation) at which each scenario's rule fired. */
  const firing: Record<string, number[]> = {};

  async function vmImport(lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const res = await fetch(`${base}/api/v1/import/prometheus`, { method: "POST", body: lines.join("\n") });
    expect(res.status, await res.text()).toBe(204);
    await fetch(`${base}/internal/force_flush`);
  }

  async function vmRemoteWrite(samples: RwSample[]): Promise<void> {
    if (samples.length === 0) return;
    const res = await fetch(`${base}/api/v1/write`, {
      method: "POST",
      headers: {
        "Content-Encoding": "snappy",
        "Content-Type": "application/x-protobuf",
        "X-Prometheus-Remote-Write-Version": "0.1.0",
      },
      body: snappyLiteral(writeRequest(samples)),
    });
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
    t0 = Math.floor(Date.now() / 1000 / 3600) * 3600 - 3 * 3600;
    await vmImport(Object.values(SCENARIOS).flatMap((s) => scrapeLines(s, t0)));

    // vmalert's loop: evaluate every 60s; while firing, remote-write ALERTS; on resolve, a
    // staleness marker. A failed evaluation keeps the state and writes nothing.
    const rules = renderRules();
    const active: Record<string, boolean> = {};
    for (const id of Object.keys(SCENARIOS)) firing[id] = [];
    for (let t = M; t <= END; t += M) {
      const writes: RwSample[] = [];
      for (const [id, rule] of Object.entries(rules)) {
        const s = SCENARIOS[id]!;
        if ((s.failedEvals ?? []).includes(t)) continue;
        const labels = {
          ...rule.labels,
          __name__: "ALERTS",
          name: endpointOf(s),
          group: s.group,
          alertname: "GatusCheckFailed",
          alertstate: "firing",
          alertgroup: "synthetic-checks",
          estate: "vm-fixture",
        };
        const tsMs = (t0 + t) * 1000;
        if ((await vmQueryCount(rule.expr, t0 + t)) > 0) {
          firing[id]!.push(t);
          active[id] = true;
          writes.push({ labels, value: 1, tsMs });
        } else if (active[id]) {
          active[id] = false;
          writes.push({ labels, value: null, tsMs }); // vmalert's staleness marker on resolve
        }
      }
      await vmRemoteWrite(writes);
    }
  }, 300_000);

  afterAll(() => {
    // PULSE_DEBUG_SYNTHETIC=1 prints each scenario's firing evaluations (in minutes).
    if (process.env.PULSE_DEBUG_SYNTHETIC) {
      for (const [id, ts] of Object.entries(firing)) console.log(id, ts.map((t) => t / M).join(","));
    }
    if (container !== "") run(["docker", "rm", "-f", container]);
  });

  /** True iff the firing evaluations form one unbroken run, treating the scenario's failed
   *  evaluations (which produce nothing) as neutral — no flap, no false resolve. */
  const contiguous = (id: string): boolean => {
    const ts = firing[id]!;
    const skipped = new Set(SCENARIOS[id]!.failedEvals ?? []);
    return ts.every((t, i) => {
      if (i === 0) return true;
      for (let g = ts[i - 1]! + M; g < t; g += M) if (!skipped.has(g)) return false;
      return true;
    });
  };
  const first = (id: string): number => firing[id]![0] ?? Number.NaN;
  const last = (id: string): number => firing[id]!.at(-1) ?? Number.NaN;

  test("steady outage fires at ~the 3rd failure and stays firing", () => {
    // Failures 10m05, 11m05, 12m05 (scraped 12m20); the nominal 210s window drops the 9m05 pass
    // (scraped 9m20) from the 13m evaluation.
    expect(first("steady")).toBe(13 * M);
    expect(contiguous("steady")).toBe(true);
  });

  test("recovery resolves only after 2 clean checks and a failure-free clear window", () => {
    // Last failure 19m05 (scraped 19m20) leaves the 4m clear window after 23m20 → resolved at 24m.
    expect(last("steady")).toBe(23 * M);
  });

  test("the resolve staleness marker ends ALERTS at once (the 330s bound cannot resurrect it)", async () => {
    // steady last fired at 23m and resolved at 24m: 30s later its 23m sample is well inside 330s.
    const sel = 'ALERTS{alertname="GatusCheckFailed",group="g-steady"}';
    expect(await vmQueryCount(sel, t0 + 23 * M + 30)).toBe(1);
    expect(await vmQueryCount(sel, t0 + 24 * M + 30)).toBe(0);
  });

  test("single (alternating) failures never fire", () => {
    expect(firing.alternating).toEqual([]);
  });

  test("two-failure bursts never fire, at 60s or at 70s cadence", () => {
    expect(firing.bursts).toEqual([]);
    expect(firing.ffs70).toEqual([]);
  });

  test("restart after a long Gatus gap needs 3 fresh failures (not the first)", () => {
    // Gatus back at 20m with reset counters; failures 20m05, 21m05, 22m05 → not before 23m.
    expect(first("restart")).toBe(23 * M);
    expect(contiguous("restart")).toBe(true);
  });

  test("failures before a Gatus gap (separated by a pass) never add up to a firing", () => {
    expect(firing.gapOldFails).toEqual([]);
  });

  test("Gatus down mid-outage keeps the alert firing until fresh clean checks", () => {
    expect(first("gatusDown")).toBe(8 * M);
    expect(contiguous("gatusDown")).toBe(true);
    // Down 9m30–25m: no data at all, still firing. Back healthy at 25m05, 26m05 → clears at 27m.
    expect(last("gatusDown")).toBe(26 * M);
  });

  test("F S F after firing does not resolve; the clean run then does", () => {
    expect(first("flapAfterFiring")).toBe(8 * M);
    expect(contiguous("flapAfterFiring")).toBe(true);
    // Last failure 21m05 (scraped 21m20) leaves the 4m clear window after 25m20.
    expect(last("flapAfterFiring")).toBe(25 * M);
  });

  test("one failed vmalert evaluation during the hold does not resolve the alert", () => {
    expect(contiguous("holdDropOne")).toBe(true);
    expect(first("holdDropOne")).toBe(first("flapAfterFiring"));
    expect(last("holdDropOne")).toBe(last("flapAfterFiring"));
  });

  test("four failed evaluations in a row (within the 330s bound) do not resolve the alert", () => {
    expect(contiguous("holdGap")).toBe(true);
    expect(firing.holdGap).toEqual(firing.gatusDown!.filter((t) => t < 14 * M || t > 17 * M));
  });

  test("slow cadence (90/120/180/300s) still fires — later — and never flaps", () => {
    for (const id of ["slow90", "slow120", "slow180", "slow300"]) {
      expect(firing[id]!.length, `${id} fires`).toBeGreaterThan(0);
      expect(contiguous(id), `${id} contiguous`).toBe(true);
    }
    expect(first("slow90")).toBeLessThanOrEqual(10 * M); // nominal window catches 3 × 90s
    expect(first("slow120")).toBeLessThanOrEqual(18 * M); // slow window: no pass in 12m
    expect(first("slow180")).toBeLessThanOrEqual(18 * M);
    expect(first("slow300")).toBeLessThanOrEqual(21 * M);
  });

  test("slow recovery needs 2 passes, not 1", () => {
    // slow90 passes at 26m05, 27m35 (scraped 27m50); slow120 at 27m05, 29m05 (scraped 29m20).
    expect(last("slow90")).toBeGreaterThanOrEqual(27 * M);
    expect(last("slow90")).toBeLessThan(END);
    expect(last("slow120")).toBeGreaterThanOrEqual(29 * M);
    expect(last("slow120")).toBeLessThan(END);
  });

  test("a large success threshold (10) still clears at a slightly slow (63s) cadence", () => {
    expect(contiguous("largeS63")).toBe(true);
    // Passes from 10m05 every 63s; the 10th lands at 19m32 — never resolved before that.
    expect(last("largeS63")).toBeGreaterThanOrEqual(19 * M);
    expect(last("largeS63")).toBeLessThan(END);
  });

  test("the same name in different groups gives independent alerts", () => {
    expect(first("dupA")).toBe(8 * M);
    expect(first("dupC")).toBe(11 * M);
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
