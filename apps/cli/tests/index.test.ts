// apps/cli/tests/index.test.ts — the CLI entry wiring (04 §8/§9, item 017). Drives the real
// `main` in-process via `runCli` (factories.ts): --version to stdout, usage faults → exit 2 with
// empty stdout, one pure envelope per --json command, and verbosity never altering --json stdout.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUPPORTED_SCHEMA_MAJORS } from "@pulse/core";

import { runCli } from "./factories.js";
import { versionText } from "../src/index.js";
import { PULSE_VERSION } from "../src/version.js";
import { ENVELOPE_VERSION } from "../src/envelope.js";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "pulse-cli-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Scaffold a valid estate + config + rendered/ in `repo` via `pulse init` (SC-01). */
async function scaffold(): Promise<void> {
  const r = await runCli(["init", "--json"], { cwd: repo });
  expect(r.exitCode).toBe(0);
}

describe("--version (REQ-CLI-06, REQ-VER-01)", () => {
  test("prints PULSE_VERSION + supported schema majors to stdout, exit 0, no command", async () => {
    const r = await runCli(["--version"], { cwd: repo });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(versionText());
    expect(r.stdout).toContain(`pulse ${PULSE_VERSION}`);
    expect(r.stdout).toContain(
      `supported schema majors: ${SUPPORTED_SCHEMA_MAJORS.join(", ")}`,
    );
    // Routes to no command: stdout is the version text, NOT a JSON envelope.
    expect(() => JSON.parse(r.stdout)).toThrow();
    expect(r.stderr).toBe("");
  });

  test("--version wins even after a verb", async () => {
    const r = await runCli(["render", "--version"], { cwd: repo });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(versionText());
  });
});

describe("usage faults → exit 2, empty stdout, stderr diagnostic (REQ-CLI-02b/03)", () => {
  test("unknown verb", async () => {
    const r = await runCli(["frobnicate"], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe(""); // no fault ever writes stdout
    expect(r.stderr).toContain("pulse:");
    expect(r.stderr).toContain("usage error");
  });

  test("unknown flag", async () => {
    const r = await runCli(["validate", "--bogus"], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("pulse:");
  });

  test("unknown flag with --json still writes NOTHING to stdout (channel stays empty on a fault)", async () => {
    const r = await runCli(["render", "--json", "--bogus"], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("conflicting --verbose/--quiet is a usage fault", async () => {
    const r = await runCli(["validate", "--verbose", "--quiet"], { cwd: repo });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
  });
});

describe("a missing estate directory → ConfigIoError → exit 2 (REQ-VAL-03)", () => {
  test("validate with no scaffold exits 2 with a config-error diagnostic and empty stdout", async () => {
    const r = await runCli(["validate", "--json"], { cwd: repo }); // repo has no estate/
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("config error");
  });
});

describe("--json stdout is exactly one pure envelope (REQ-CLI-03, REQ-OBS-01)", () => {
  const commands = ["validate", "render", "coverage"] as const;

  for (const command of commands) {
    test(`${command} --json writes one JSON.parse-able envelope and nothing else`, async () => {
      await scaffold();
      const r = await runCli([command, "--json"], { cwd: repo });

      // Exactly one object: byte-for-byte the canonical serialization, nothing appended.
      const parsed = JSON.parse(r.stdout);
      expect(r.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);

      // Envelope invariants (00 §5).
      expect(parsed.command).toBe(command);
      expect(parsed.ok).toBe(parsed.exitCode === 0);
      expect(parsed.meta.pulseVersion).toBe(PULSE_VERSION);
      expect(parsed.meta.schemaMajors).toEqual([...SUPPORTED_SCHEMA_MAJORS]);
      expect(parsed.meta.envelopeVersion).toBe(ENVELOPE_VERSION);
      expect(Array.isArray(parsed.findings)).toBe(true);

      // A fresh scaffold validates/renders/covers clean (SC-01).
      expect(r.exitCode).toBe(0);
    });
  }

  test("init --json also emits exactly one pure envelope", async () => {
    const r = await runCli(["init", "--json"], { cwd: repo });
    const parsed = JSON.parse(r.stdout);
    expect(r.stdout).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
    expect(parsed.command).toBe("init");
    expect(r.exitCode).toBe(0);
  });

  test("without --json, stdout is empty (machine channel silent in text mode)", async () => {
    await scaffold();
    const r = await runCli(["validate"], { cwd: repo });
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(0);
  });
});

describe("verbosity never alters --json stdout (REQ-OBS-02)", () => {
  test("quiet / normal / verbose produce byte-identical --json stdout for render", async () => {
    await scaffold();
    const normal = await runCli(["render", "--json"], { cwd: repo });
    const quiet = await runCli(["render", "--json", "--quiet"], { cwd: repo });
    const verbose = await runCli(["render", "--json", "--verbose"], { cwd: repo });

    expect(normal.exitCode).toBe(0);
    expect(quiet.stdout).toBe(normal.stdout);
    expect(verbose.stdout).toBe(normal.stdout);
  });

  test("quiet / normal / verbose produce byte-identical --json stdout for coverage", async () => {
    await scaffold();
    const normal = await runCli(["coverage", "--json"], { cwd: repo });
    const quiet = await runCli(["coverage", "--json", "--quiet"], { cwd: repo });
    const verbose = await runCli(["coverage", "--json", "--verbose"], { cwd: repo });

    expect(quiet.stdout).toBe(normal.stdout);
    expect(verbose.stdout).toBe(normal.stdout);
  });
});
