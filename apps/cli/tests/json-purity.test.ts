// apps/cli/tests/json-purity.test.ts — the machine-channel contract (REQ-CLI-03, REQ-VAL-02,
// REQ-VER-01, REQ-CLI-05, 07 §3.7). For every command a `--json` run writes EXACTLY ONE
// JSON.parse-able envelope to stdout and no human text there; findings/diagnostics go to
// stderr; `envelope.findings` preserves @pulse/core's order verbatim (no re-sort); `meta`
// draws its envelope version + supported majors from the single sources of truth; and both
// `NO_COLOR` and a non-TTY stderr suppress colour/control sequences.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUPPORTED_SCHEMA_MAJORS, loadAndValidate } from "@pulse/core";

import { runCli } from "./factories.js";
import type { PulseEnvelope } from "../src/envelope.js";
import { ENVELOPE_VERSION } from "../src/envelope.js";
import { PULSE_VERSION } from "../src/version.js";

const FIXTURES = join(import.meta.dir, "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pulse-json-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Scaffold a valid estate + config + rendered/ in `repo` so read commands have something. */
async function scaffold(): Promise<void> {
  const r = await runCli(["init", "--json"], { cwd: repo });
  expect(r.exitCode).toBe(0);
}

describe("--json stdout is exactly one pure envelope (REQ-CLI-03)", () => {
  const commands = ["init", "validate", "render", "coverage"] as const;

  for (const command of commands) {
    test(`${command} --json: stdout is one canonical object, nothing else`, async () => {
      if (command !== "init") await scaffold();
      const r = await runCli([command, "--json"], { cwd: repo });

      // Parses as exactly one object AND is byte-for-byte the canonical serialization
      // (2-space indent + a single trailing newline) — no human text can hide in stdout.
      const parsed = JSON.parse(r.stdout) as PulseEnvelope;
      expect(r.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);

      // Universal envelope invariants (00 §5).
      expect(parsed.command).toBe(command);
      expect(parsed.ok).toBe(parsed.exitCode === 0);
      expect(Array.isArray(parsed.findings)).toBe(true);

      // meta draws from the single sources of truth (REQ-VER-01), no clock/PID/host.
      expect(parsed.meta.envelopeVersion).toBe(ENVELOPE_VERSION);
      expect(parsed.meta.schemaMajors).toEqual([...SUPPORTED_SCHEMA_MAJORS]);
      expect(parsed.meta.pulseVersion).toBe(PULSE_VERSION);
      expect(Object.keys(parsed.meta).sort()).toEqual(
        ["envelopeVersion", "pulseVersion", "schemaMajors"],
      );
    });
  }

  test("without --json, stdout is empty (the machine channel is silent in text mode)", async () => {
    await scaffold();
    const r = await runCli(["validate"], { cwd: repo });
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
  });
});

describe("findings/diagnostics go to stderr, stdout stays pure (REQ-CLI-03)", () => {
  test("validate --json on an error estate: findings on stderr, stdout is pure JSON", async () => {
    const r = await runCli(["validate", "--json"], {
      cwd: repo,
      env: { PULSE_ESTATE_DIR: fixture("error") },
    });
    expect(r.exitCode).toBe(1);

    // stdout is still exactly one canonical envelope — no diagnostic text leaked there.
    const parsed = JSON.parse(r.stdout) as PulseEnvelope;
    expect(r.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);

    // The human-formatted finding block landed on stderr (via reportFindings).
    expect(r.stderr).toContain("missing_field");
    expect(r.stderr).toContain("fix:");
  });
});

describe("envelope.findings preserves core's order verbatim (REQ-VAL-02)", () => {
  for (const name of ["error", "multi-error", "unsupported", "secret-literal"] as const) {
    test(`${name}: envelope.findings deep-equals loadAndValidate(...).findings, same order`, async () => {
      const coreOrder = loadAndValidate(fixture(name)).findings;
      const r = await runCli(["validate", "--json"], {
        cwd: repo,
        env: { PULSE_ESTATE_DIR: fixture(name) },
      });
      const parsed = JSON.parse(r.stdout) as PulseEnvelope;
      // Byte-for-byte the same findings, in the same order — the CLI never re-sorts.
      expect(parsed.findings).toEqual(coreOrder);
    });
  }

  test("multi-error carries TWO findings in core order (proves no re-sort, not just passthrough)", async () => {
    const coreOrder = loadAndValidate(fixture("multi-error")).findings;
    expect(coreOrder.length).toBe(2);
    const r = await runCli(["validate", "--json"], {
      cwd: repo,
      env: { PULSE_ESTATE_DIR: fixture("multi-error") },
    });
    const parsed = JSON.parse(r.stdout) as PulseEnvelope;
    expect(parsed.findings.map((f) => f.path)).toEqual(coreOrder.map((f) => f.path));
  });
});

describe("NO_COLOR and non-TTY stderr suppress colour/control sequences (REQ-CLI-05)", () => {
  // Drive a run that PRINTS findings to stderr (the error estate) so there is human text that
  // could carry colour, then assert no ANSI escape byte (ESC = \x1b) appears in either stream.
  const ESC = String.fromCharCode(0x1b);

  test("NO_COLOR=1 with a TTY stderr → no escape sequences", async () => {
    const r = await runCli(["validate", "--json"], {
      cwd: repo,
      env: { PULSE_ESTATE_DIR: fixture("error"), NO_COLOR: "1" },
      stderrIsTTY: true,
    });
    expect(r.stderr).toContain("missing_field"); // there IS human text on stderr
    expect(r.stderr).not.toContain(ESC);
    expect(r.stdout).not.toContain(ESC);
  });

  test("non-TTY stderr (no NO_COLOR) → no escape sequences", async () => {
    const r = await runCli(["validate", "--json"], {
      cwd: repo,
      env: { PULSE_ESTATE_DIR: fixture("error") },
      stderrIsTTY: false,
    });
    expect(r.stderr).toContain("missing_field");
    expect(r.stderr).not.toContain(ESC);
    expect(r.stdout).not.toContain(ESC);
  });
});
