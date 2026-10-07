// apps/cli/tests/exit-code.test.ts — the 0/1/2 exit-code contract, row by row (REQ-CLI-02,
// SC-05, 07 §3.6). This is the single most important table for an automated operator: clean
// (0) / findings-or-outcome (1) / tool-fault (2) must always be distinguishable.
//
// Every producible row is driven end-to-end through the in-process `runCli` on local source
// (the dev path — no compiled binary). The one row that CANNOT be produced end-to-end is the
// `--strict` warning promotion: @pulse/core v1 emits ONLY error-severity findings (verified —
// every `severity:` in the loader/validator/version layer is `"error"`), so no real estate
// yields a warning finding through `loadAndValidate`. That row is asserted at the exact seam
// `runCli` uses to decide the code — `computeOutcomeExit` — with a synthetic warning finding,
// and the reachable strict paths (clean stays 0, error stays 1) are still driven via `runCli`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Finding } from "@pulse/core";

import { runCli } from "./factories.js";
import { computeOutcomeExit } from "../src/exit.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

/** Run a read command against a fixture estate via `PULSE_ESTATE_DIR`, in a config-less cwd. */
async function runOnFixture(
  args: string[],
  fixtureName: string,
  cwd: string,
): Promise<number> {
  const r = await runCli(args, { cwd, env: { PULSE_ESTATE_DIR: fixture(fixtureName) } });
  return r.exitCode;
}

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pulse-exit-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("exit-code table (07 §3.6) — driven row-by-row via runCli", () => {
  test("clean validate/render/coverage → 0", async () => {
    await runCli(["init", "--json"], { cwd: repo }); // scaffold a clean estate in-place
    for (const command of ["validate", "render", "coverage"] as const) {
      const r = await runCli([command, "--json"], { cwd: repo });
      expect(r.exitCode).toBe(0);
    }
  });

  test("≥1 error finding → 1 (validate on an estate with a MISSING_FIELD error)", async () => {
    expect(await runOnFixture(["validate", "--json"], "error", repo)).toBe(1);
  });

  test("coverage gap present → 1", async () => {
    expect(await runOnFixture(["coverage", "--json"], "gap", repo)).toBe(1);
  });

  test("--check drift present → 1", async () => {
    // Write the clean scaffold, hand-edit a rendered file, then --check sees the drift.
    await runCli(["init", "--json"], { cwd: repo });
    const written = await runCli(["render", "--json"], { cwd: repo });
    expect(written.exitCode).toBe(0);

    const drifted = join(repo, "rendered", "gatus", "config.yaml");
    writeFileSync(drifted, readFileSync(drifted, "utf8") + "\n# hand-edit\n", "utf8");

    const check = await runCli(["render", "--json", "--check"], { cwd: repo });
    expect(check.exitCode).toBe(1);
  });

  test("init would-clobber (no --force) → 1", async () => {
    await runCli(["init", "--json"], { cwd: repo }); // first init succeeds
    const second = await runCli(["init", "--json"], { cwd: repo }); // files already present
    expect(second.exitCode).toBe(1);
    const parsed = JSON.parse(second.stdout);
    expect(parsed.data.wouldClobber.length).toBeGreaterThan(0);
    // ...and --force turns the same situation back into a clean overwrite → 0.
    const forced = await runCli(["init", "--json", "--force"], { cwd: repo });
    expect(forced.exitCode).toBe(0);
  });

  test("warning finding, no --strict → 0; same finding with --strict → 1", () => {
    // @pulse/core v1 emits no warning-severity finding via loadAndValidate (all findings are
    // errors), so this row cannot be produced end-to-end. It IS asserted at the seam runCli
    // uses to pick the code — computeOutcomeExit — with a synthetic warning finding.
    const warning: Finding = {
      severity: "warning",
      code: "secret_literal",
      file: "estate/estate.yaml",
      path: "channels[0]",
      message: "synthetic warning",
      fix: "n/a",
    };
    expect(computeOutcomeExit({ findings: [warning], outcomeFailed: false, strict: false })).toBe(0);
    expect(computeOutcomeExit({ findings: [warning], outcomeFailed: false, strict: true })).toBe(1);
  });

  test("--strict does not change the reachable rows: clean stays 0, error stays 1", async () => {
    await runCli(["init", "--json"], { cwd: repo });
    // A clean estate under --strict is still 0 (no warning to promote).
    expect((await runCli(["validate", "--json", "--strict"], { cwd: repo })).exitCode).toBe(0);
    // An error finding is 1 with or without --strict (error precedence).
    expect(await runOnFixture(["validate", "--json", "--strict"], "error", repo)).toBe(1);
  });

  test("ConfigIoError (missing estate dir) → 2", async () => {
    // `repo` is an empty temp dir: no estate/ and no config → the loader throws ConfigIoError.
    const r = await runCli(["validate", "--json"], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(""); // a tool fault never writes the machine channel
  });

  test("unknown verb → 2", async () => {
    const r = await runCli(["frobnicate"], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("unknown flag → 2", async () => {
    const r = await runCli(["validate", "--bogus"], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
  });
});
