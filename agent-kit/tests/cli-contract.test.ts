// agent-kit/tests/cli-contract.test.ts
// CLI contract lock (06-testing-and-eval.md §5.3; REQ-DRIFT-02).
//
// Drives the REAL `pulse` CLI in-process (via the run-cli helper, 04 §3) over a per-test copy of
// the committed reference estate (examples/reference) and asserts the authored `CLI_CONTRACT`
// slot (00 §4.2) matches observed behavior: the verb set, every documented exit-code case, the
// `--json` envelope's top-level keys, and each verb's `data` field names. A drift in any verb,
// exit code, or envelope field breaks this suite → breaks the build (Success Criterion 2).
//
// Discipline (spec §1): a GATING suite — no mocks, no self-skip. The reference estate and the
// `@pulse/cli` deep import are hard dependencies; if either is missing the suite fails RED
// (the copy throws, or runCli throws) rather than skipping. Every temp dir is removed in a
// `finally`; the committed reference estate is never mutated (only per-test copies are).
//
// NOTE on the exit-2 case: the real CLI maps YAML-parse / schema problems to *findings*
// (exit 1), not thrown faults. The genuine "thrown tool fault → exit 2" path is a
// `ConfigIoError` from an absent estate (apps/cli/tests/exit-code.test.ts drives it the same
// way), so this suite reproduces exit 2 by removing the copied `estate/` directory.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "./helpers/run-cli.js";
import { CLI_CONTRACT } from "../src/slots/cli-contract.js";

/** Absolute path to deploy-toolkit's committed reference estate (05 §6.5, REQ-INTEG-03). */
const REFERENCE_ESTATE = resolve(import.meta.dir, "../../examples/reference");

/**
 * Copy the reference estate (pulse.config.yaml + estate/ + rendered/) into a fresh temp dir and
 * return its path. Callers cwd the CLI into this dir and remove it in a `finally`. Never mutates
 * the committed source. (Inlined rather than imported from tests/fixtures/estate.ts, which is
 * authored by a later backlog item — this suite must stand alone.)
 */
function copyReferenceEstate(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-cli-"));
  cpSync(REFERENCE_ESTATE, dir, { recursive: true });
  return dir;
}

/** The authored contract for one verb (asserted against the real CLI). */
function verb(name: string) {
  const v = CLI_CONTRACT.verbs.find((x) => x.name === name);
  if (v === undefined) throw new Error(`CLI_CONTRACT has no verb '${name}'`); // fail RED, never skip
  return v;
}

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe("cli-contract (REQ-DRIFT-02)", () => {
  // ── Verb set ────────────────────────────────────────────────────────────────────────────
  test("authored verb set == real CLI verb set (drift lock)", () => {
    expect(sorted(CLI_CONTRACT.verbs.map((v) => v.name))).toEqual([
      "coverage",
      "init",
      "render",
      "validate",
    ]);
  });

  test("an undocumented verb is rejected by the real CLI (exit 2, no envelope)", async () => {
    const cwd = copyReferenceEstate();
    try {
      const r = await runCli(["frobnicate", "--json"], cwd);
      expect(r.exitCode).toBe(2); // unknown verb → thrown UsageError → exit 2
      expect(r.stdout).toBe(""); // a fault never writes the machine channel
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── validate: exit 0 + envelope shape + data null ─────────────────────────────────────────
  test("validate on the clean reference estate → exit 0; envelope keys == envelopeFields; data null", async () => {
    const cwd = copyReferenceEstate();
    try {
      const { exitCode, stdout } = await runCli(["validate", "--json"], cwd);
      expect(exitCode).toBe(0);
      const env = JSON.parse(stdout);
      // Top-level envelope keys == the authored PulseEnvelope field set (00 §5).
      expect(sorted(Object.keys(env))).toEqual(sorted(CLI_CONTRACT.envelopeFields));
      // validate carries no data payload (ValidateData = null; dataFields == []).
      expect(env.data).toBeNull();
      expect(verb("validate").dataFields).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── validate: seeded error finding → exit 1 ───────────────────────────────────────────────
  test("validate on a seeded-error estate → exit 1", async () => {
    const cwd = copyReferenceEstate();
    try {
      const estateYaml = join(cwd, "estate", "estate.yaml");
      // An unsupported schema major yields exactly one error-severity finding → exit 1.
      writeFileSync(
        estateYaml,
        readFileSync(estateYaml, "utf8").replace("schema_version: 1", "schema_version: 99"),
        "utf8",
      );
      const { exitCode } = await runCli(["validate", "--json"], cwd);
      expect(exitCode).toBe(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── validate: thrown tool fault → exit 2 ──────────────────────────────────────────────────
  test("validate against an absent estate → thrown fault → exit 2 (no envelope)", async () => {
    const cwd = copyReferenceEstate();
    try {
      rmSync(join(cwd, "estate"), { recursive: true, force: true }); // ConfigIoError on load
      const { exitCode, stdout } = await runCli(["validate", "--json"], cwd);
      expect(exitCode).toBe(2);
      expect(stdout).toBe("");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── coverage: gap → exit 1 + data field names ─────────────────────────────────────────────
  test("coverage on an estate with a declared-but-unmonitored gap → exit 1; data fields == coverage.dataFields", async () => {
    const cwd = copyReferenceEstate();
    try {
      const estateYaml = join(cwd, "estate", "estate.yaml");
      // Inject an orphan managed http service (no ingress/deep_health/backup) → a coverage gap.
      const orphan =
        "\nservices:\n" +
        "  - name: orphan-svc\n" +
        "    host: harbor-web-01\n" +
        "    kind: http\n" +
        "    managed: true\n";
      writeFileSync(
        estateYaml,
        readFileSync(estateYaml, "utf8").replace("\nservices:\n", orphan),
        "utf8",
      );
      const { exitCode, stdout } = await runCli(["coverage", "--json"], cwd);
      expect(exitCode).toBe(1);
      const data = JSON.parse(stdout).data;
      expect(sorted(Object.keys(data))).toEqual(sorted(verb("coverage").dataFields));
      expect(data.gaps.some((g: { name: string }) => g.name.includes("orphan-svc"))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── render: --check drift → exit 1 + data field names ─────────────────────────────────────
  test("render --check with drift → exit 1; data fields == render.dataFields", async () => {
    const cwd = copyReferenceEstate();
    try {
      // Hand-edit a committed rendered file so a fresh render --check sees drift.
      const rendered = join(cwd, "rendered", "gatus", "config.yaml");
      writeFileSync(rendered, readFileSync(rendered, "utf8") + "\n# hand-edit\n", "utf8");
      const { exitCode, stdout } = await runCli(["render", "--json", "--check"], cwd);
      expect(exitCode).toBe(1);
      const data = JSON.parse(stdout).data;
      // --check mode carries all four render fields (drift present, non-empty here).
      expect(sorted(Object.keys(data))).toEqual(sorted(verb("render").dataFields));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // ── init: would-clobber → exit 1 + data field names (all three) ───────────────────────────
  test("init exit codes + data fields == init.dataFields", async () => {
    const repo = mkdtempSync(join(tmpdir(), "agent-kit-init-"));
    try {
      const first = await runCli(["init", "--json"], repo);
      expect(first.exitCode).toBe(0); // clean scaffold → exit 0

      const second = await runCli(["init", "--json"], repo);
      expect(second.exitCode).toBe(1); // files already present, no --force → wouldClobber
      const data = JSON.parse(second.stdout).data;
      // The refusal envelope exposes all three InitData fields.
      expect(sorted(Object.keys(data))).toEqual(sorted(verb("init").dataFields));
      expect(data.wouldClobber.length).toBeGreaterThan(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
