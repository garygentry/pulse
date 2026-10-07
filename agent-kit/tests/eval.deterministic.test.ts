// agent-kit/tests/eval.deterministic.test.ts
// The per-PR deterministic eval gate (06-testing-and-eval.md §6.1; REQ-EVAL-01/02, REQ-PERF-01).
//
// For each of the three rehearsed operator tasks — add a host, add a deep-health probe, explain a
// coverage finding — copy the reference estate, apply the SCRIPTED fixture mutation (NO model
// call), drive the REAL `pulse` CLI in-process via `runCli`, and assert the verb result + exit
// code + `--json` payload. Deterministic and non-flaky: no network, no subprocess, no model, so
// the runtime is dominated by in-process CLI calls over small fixtures and stays well under the
// 2-min ceiling (REQ-PERF-01). The ceiling is guaranteed STRUCTURALLY — the elapsed line below is
// a SOFT, non-gating observability signal, never a wall-clock assertion (spec §7).
//
// Discipline (spec §1): GATING — no mocks, no self-skip. Each task removes its temp copy in a
// `finally` and never mutates the committed reference estate. Each emits a greppable
// `[eval] <task>: PASS|FAIL` line (REQ-OBS-01).

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { runCli } from "./helpers/run-cli.js";
import { copyReferenceEstate, estateYamlPath } from "./fixtures/estate.js";
import { addHostPatch } from "./fixtures/add-host.patch.js";
import { addProbePatch, PROBE_HOST } from "./fixtures/add-probe.patch.js";
import { coverageGapPatch } from "./fixtures/coverage-gap.estate.js";
import { coverageInterpretation } from "../src/content/skills/coverage-interpretation.js";
import { buildSlots } from "../src/slots/index.js";

/** Soft, non-gating elapsed-time signal around the whole task loop (spec §7 — never asserted). */
const suiteStart = performance.now();

/** Emit the per-task PASS/FAIL line (REQ-OBS-01), then re-throw on failure so the gate still fails. */
async function evalTask(task: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    console.log(`[eval] ${task}: PASS`);
  } catch (e) {
    console.log(`[eval] ${task}: FAIL`);
    throw e;
  }
}

describe("eval.deterministic (REQ-EVAL-01/02, REQ-PERF-01)", () => {
  afterAll(() => {
    // Non-gating: visible in CI logs so a slowdown surfaces without flaking the gate.
    console.log(`[eval] total: ${Math.round(performance.now() - suiteStart)}ms`);
  });

  // ── add-host: validate 0 + render writes the new host's agent target ──────────────────────
  test("[add-host] validate 0, render 0 writes the new host's target, host id in estate.yaml", async () => {
    await evalTask("add-host", async () => {
      const cwd = copyReferenceEstate();
      try {
        addHostPatch.apply(cwd);

        // The scripted mutation lands in the estate-config.
        expect(readFileSync(estateYamlPath(cwd), "utf8")).toContain(addHostPatch.subject);

        const v = await runCli(["validate", "--json"], cwd);
        expect(v.exitCode).toBe(0);

        const r = await runCli(["render", "--json"], cwd);
        expect(r.exitCode).toBe(0);
        const data = JSON.parse(r.stdout).data;
        // A managed-linux host renders a per-host agent config → subject appears in filesWritten.
        expect(data.filesWritten.some((f: string) => f.includes(addHostPatch.subject))).toBe(true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  // ── add-probe: validate 0 + rendered prober gains the deep-health probe ───────────────────
  test("[add-probe] validate 0, rendered prober gains the probe, probe in estate.yaml", async () => {
    await evalTask("add-probe", async () => {
      const cwd = copyReferenceEstate();
      try {
        addProbePatch.apply(cwd);

        // The deep_health block is present in the estate-config (endpoint + service name).
        const estate = readFileSync(estateYamlPath(cwd), "utf8");
        expect(estate).toContain(addProbePatch.subject);
        expect(estate).toContain("deep_health");

        const v = await runCli(["validate", "--json"], cwd);
        expect(v.exitCode).toBe(0);

        const r = await runCli(["render", "--json"], cwd);
        expect(r.exitCode).toBe(0);

        // The rendered prober config gains a deep-health probe named svc:<host>/<subject>.
        const prober = readFileSync(join(cwd, "rendered", "prober", "config.yaml"), "utf8");
        expect(prober).toContain(`svc:${PROBE_HOST}/${addProbePatch.subject}`);
        expect(prober).toContain("deep-health");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  // ── explain-coverage: coverage exit 1 + interpretation names the exact gap service ────────
  test("[explain-coverage] coverage exit 1 with the known gap; interpretation names the gap service", async () => {
    await evalTask("explain-coverage", async () => {
      const cwd = copyReferenceEstate();
      try {
        coverageGapPatch.apply(cwd);

        const c = await runCli(["coverage", "--json"], cwd);
        expect(c.exitCode).toBe(1); // a declared-but-unmonitored target → coverage exits 1
        const gaps: Array<{ name: string }> = JSON.parse(c.stdout).data.gaps;

        // The known gap is present in the oracle payload.
        const gap = gaps.find((g) => g.name.includes(coverageGapPatch.subject));
        expect(gap, `coverage gaps did not report ${coverageGapPatch.subject}`).toBeDefined();

        // The coverage-interpretation skill's PROCEDURE is to read data.gaps and name the
        // affected host/service — confirm the content teaches exactly that.
        const proseHasGapsStep = coverageInterpretation
          .render(buildSlots())
          .some((s) => s.text.includes("data.gaps"));
        expect(proseHasGapsStep).toBe(true);

        // Deterministic analogue of the live "explain" answer: apply that procedure to the oracle
        // payload (no model) — the interpretation NAMES the exact declared-but-unmonitored service.
        const interpretation = interpretGaps(gaps);
        expect(interpretation).toContain(coverageGapPatch.subject);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});

/**
 * The deterministic interpretation the coverage-interpretation skill prescribes: read `data.gaps`
 * and name each affected host/service. Uses the CLI's `gaps` output as the sole oracle — no model,
 * no LLM-judge (the deterministic analogue of §6.2's live explain task, spec §6.1).
 */
function interpretGaps(gaps: ReadonlyArray<{ name: string }>): string {
  return gaps.map((g) => `Unmonitored target: ${g.name}`).join("\n");
}
