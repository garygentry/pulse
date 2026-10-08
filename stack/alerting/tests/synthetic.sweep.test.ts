// stack/alerting/tests/synthetic.sweep.test.ts
// Tier B (Docker-gated): a phase sweep of the RENDERED GatusCheckFailed rule on VictoriaMetrics
// (issue #1). Whether an outage of exactly F failed checks is caught depends on where the checks,
// the 30s scrapes and the rule evaluations fall relative to each other, so a single scripted
// timeline proves little. This sweeps check cadence 60/63/66/70/75s × 10 scrape phases × 5 check
// phases, with ±150ms of deterministic jitter on every check, and asserts:
//   (a) an outage of exactly F=3 consecutive failures fires, in every combination;
//   (b) a repeating F F S pattern (two failures, one pass) never fires, in any combination.
// Only the FIRE term matters for both (the first firing decides (a); (b) never fires), so the
// loop does not write ALERTS back.
/// <reference path="./bun-test.d.ts" />
import { afterAll, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { buildSyntheticRules } from "../src/transform/synthetic-rules.js";
import { GATUS_CHECKS } from "../src/constants.js";
import type { EstateModel, Service } from "../src/transform/estate.js";
import { DOCKER_OK } from "./harness.js";
import { Vm, checks, evalLoop, historicalBase, scrapeLines, type History } from "./vm-emulator.js";

const d = DOCKER_OK ? describe : describe.skip;

const CADENCES = [60, 63, 66, 70, 75] as const;
const SCRAPE_PHASES = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27] as const;
const CHECK_PHASES = [0, 12, 24, 36, 48] as const;
const F = GATUS_CHECKS.defaultFailureThreshold;
const END = 22 * 60;
const PROV = { file: "estate.yaml", path: "services", line: 1, col: 1 } as const;

interface Case extends History {
  kind: "exact" | "ffs";
  cadence: number;
}

/** Deterministic LCG in [0, 1) so the jitter (and thus the sweep) is reproducible. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
}

function cases(): Case[] {
  const rnd = lcg(42);
  const jitter = (): number => (rnd() - 0.5) * 0.3; // ±150ms
  const out: Case[] = [];
  for (const cadence of CADENCES)
    for (const scrapePhase of SCRAPE_PHASES)
      for (const checkPhase of CHECK_PHASES) {
        const from = 60 + checkPhase;
        const id = `${cadence}-${scrapePhase}-${checkPhase}`;
        // 6 passes, exactly F failures, then passes.
        const exact = checks(from, 6 + F + 6, cadence, (i) => i < 6 || i >= 6 + F);
        // F F S repeated (i % 3 === 2 passes), starting with a pass run of 3.
        const ffs = checks(from, 15, cadence, (i) => i < 3 || i % 3 === 2);
        for (const [kind, list] of [["exact", exact], ["ffs", ffs]] as const) {
          out.push({
            kind,
            cadence,
            group: `${kind}-${id}`,
            name: `${kind}-${id}/web`,
            scrapePhase,
            checks: list.map((c) => ({ ...c, at: c.at + jitter() })),
          });
        }
      }
  return out;
}

d("synthetic-check phase sweep on VictoriaMetrics (Tier B, issue #1)", () => {
  let vm: Vm | undefined;
  afterAll(() => vm?.stop());

  test("exactly-F outages always fire and F F S never fires, at 60–75s cadence", async () => {
    const all = cases();
    const services: Service[] = all.map((c) => ({
      name: "web",
      host: c.group,
      kind: "http",
      managed: true,
      ingressUrl: `https://${c.group}.example/`,
      alerts: [{ type: "custom" }],
      provenance: PROV,
    }));
    const estate: EstateModel = {
      schemaMajor: 1,
      estate: { name: "sweep", domains: [], timezone: "UTC", deadmanHook: "x", provenance: PROV },
      hosts: [],
      services,
      channels: [],
      routingOverrides: [],
      suppressions: [],
    };
    const doc = parse(buildSyntheticRules(estate, [])) as {
      groups: Array<{ rules: Array<{ expr: string; labels: Record<string, string> }> }>;
    };
    const exprByGroup = new Map(doc.groups[0]!.rules.map((r) => [r.labels.group!, r.expr]));

    vm = await Vm.start();
    const t0 = historicalBase();
    await vm.import(all.flatMap((c) => scrapeLines(c, t0, END)));
    const fired = await evalLoop(
      vm,
      t0,
      all.map((c) => ({ id: c.group, expr: exprByGroup.get(c.group)!, alertLabels: {} })),
      { interval: GATUS_CHECKS.evaluationIntervalSeconds, end: END, writeAlerts: false },
    );

    const summary = CADENCES.map((cadence) => {
      const of = (kind: Case["kind"]) => all.filter((c) => c.cadence === cadence && c.kind === kind);
      const caught = of("exact").filter((c) => fired[c.group]!.length > 0).length;
      const ffsFired = of("ffs").filter((c) => fired[c.group]!.length > 0).length;
      return { cadence, caught: `${caught}/${of("exact").length}`, ffsFired };
    });
    if (process.env.PULSE_DEBUG_SYNTHETIC) console.log(JSON.stringify(summary));
    const missed = all.filter((c) => c.kind === "exact" && fired[c.group]!.length === 0).map((c) => c.group);
    const falsePositives = all.filter((c) => c.kind === "ffs" && fired[c.group]!.length > 0).map((c) => c.group);
    expect(missed, JSON.stringify(summary)).toEqual([]);
    expect(falsePositives, JSON.stringify(summary)).toEqual([]);
  }, 600_000);
});
