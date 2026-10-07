// apps/cli/tests/smoke.test.ts — the agent-loop end-to-end smoke (SC-01/SC-03, 07 §3.8).
//
// Wired as forge.config.json's `smokeCommand = "bun run smoke"` (root script, item 001). It
// drives the full author→validate→render→coverage loop on a SCRATCH estate using ONLY the
// `--json` payloads and exit codes — no human-text scraping — proving an automated operator
// could complete the loop unaided. Each step asserts stdout is exactly one parseable
// PulseEnvelope with `ok === (exitCode === 0)` and the expected `data` shape.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runCli } from "./factories.js";
import type {
  PulseEnvelope,
  InitData,
  RenderData,
  CoverageData,
} from "../src/envelope.js";
import type { ExitCode } from "../src/exit.js";

/** Parse the sole stdout object into a typed envelope, asserting the universal invariants. */
function envelope<D>(
  stdout: string,
  exitCode: ExitCode,
  command: PulseEnvelope["command"],
): PulseEnvelope<D> {
  // Exactly one object: byte-for-byte the canonical 2-space serialization + one newline.
  const parsed = JSON.parse(stdout) as PulseEnvelope<D>;
  expect(stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  // The agent keys on these three signals alone (SC-05).
  expect(parsed.command).toBe(command);
  expect(parsed.exitCode).toBe(exitCode);
  expect(parsed.ok).toBe(exitCode === 0);
  return parsed;
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pulse-smoke-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("agent-loop smoke: init → validate → render → coverage (SC-01/SC-03)", () => {
  test("an operator completes the loop on a scratch estate using only --json + exit codes", async () => {
    // (1) init — scaffold a valid estate into an EMPTY temp dir. Exit 0; scaffold created.
    const initRun = await runCli(["init", "--json"], { cwd: repo });
    expect(initRun.exitCode).toBe(0);
    const init = envelope<InitData>(initRun.stdout, 0, "init");
    expect(init.data).not.toBeNull();
    expect(init.data!.created).toContain("pulse.config.yaml");
    expect(init.data!.created).toContain("estate/estate.yaml");
    expect(init.data!.wouldClobber).toBeUndefined();
    // The scaffold is physically on disk (init is not a dry run).
    expect(existsSync(join(repo, "estate", "estate.yaml"))).toBe(true);

    // (2) validate — the fresh scaffold loads clean: exit 0, no findings, data null.
    const validateRun = await runCli(["validate", "--json"], { cwd: repo });
    expect(validateRun.exitCode).toBe(0);
    const validate = envelope<null>(validateRun.stdout, 0, "validate");
    expect(validate.findings).toEqual([]);
    expect(validate.data).toBeNull();

    // (3) render — writes a tree. Exit 0, write mode, at least one file, no drift key.
    const renderRun = await runCli(["render", "--json"], { cwd: repo });
    expect(renderRun.exitCode).toBe(0);
    const render = envelope<RenderData>(renderRun.stdout, 0, "render");
    expect(render.data).not.toBeNull();
    expect(render.data!.mode).toBe("write");
    expect(render.data!.filesWritten.length).toBeGreaterThan(0);
    expect(render.data!.drift).toBeUndefined();
    // Every listed relative path exists under the rendered output root (which the config
    // layer resolves to an absolute path; `resolve` handles absolute-or-relative).
    for (const rel of render.data!.filesWritten) {
      expect(existsSync(resolve(repo, render.data!.outputRoot, rel))).toBe(true);
    }

    // (4) coverage — the scaffold is fully covered: exit 0, no gaps, ≥1 covered entity.
    const coverageRun = await runCli(["coverage", "--json"], { cwd: repo });
    expect(coverageRun.exitCode).toBe(0);
    const coverage = envelope<CoverageData>(coverageRun.stdout, 0, "coverage");
    expect(coverage.data).not.toBeNull();
    expect(coverage.data!.gaps).toEqual([]);
    expect(coverage.data!.covered.length).toBeGreaterThan(0);
  });

  test("each step's stdout is a self-describing envelope — no stderr scraping needed", async () => {
    // Drive the loop and assert that for EVERY step the machine channel alone carries the
    // full outcome: `ok` matches the exit code and the command discriminant is present.
    await runCli(["init", "--json"], { cwd: repo });
    for (const command of ["validate", "render", "coverage"] as const) {
      const run = await runCli([command, "--json"], { cwd: repo });
      const parsed = JSON.parse(run.stdout) as PulseEnvelope;
      expect(parsed.command).toBe(command);
      expect(parsed.ok).toBe(run.exitCode === 0);
      // The whole outcome is decidable from stdout + exit code alone.
      expect(run.exitCode).toBe(0);
    }
  });
});
