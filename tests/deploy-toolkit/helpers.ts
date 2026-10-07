// tests/deploy-toolkit/helpers.ts
// Feature-local test support for the pure tiers (golden/estate/secret-safety). Uses only
// Bun/Node built-ins; invokes the `pulse` CLI from source (D9, 00 §2.2). NOT a @pulse/* import.

import { resolve } from "node:path";

/** Repo root: tests/deploy-toolkit → up two. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Absolute path to the source CLI entry (invoked from source, D9). */
export const CLI_ENTRY = resolve(REPO_ROOT, "apps", "cli", "src", "index.ts");

/** The two fixtures and their committed golden trees (01 §1, 02). */
export const FIXTURES = ["minimal", "reference"] as const;
export type FixtureName = (typeof FIXTURES)[number];

/**
 * Absolute path to a fixture's self-contained CLI workspace (`examples/<fixture>/`).
 * This is the CWD every CLI invocation runs under (see §1.2 / 00 §3): with cwd set here the
 * CLI auto-discovers `pulse.config.yaml` and resolves `estate/` + `rendered/` INSIDE the
 * fixture — NOT relative to REPO_ROOT.
 */
export const fixtureDir = (name: FixtureName): string => resolve(REPO_ROOT, "examples", name);

/** Absolute committed `rendered/` root for a fixture (the `--check` equality target). */
export const fixtureRendered = (name: FixtureName): string => resolve(fixtureDir(name), "rendered");

/**
 * The source-backed stack rendered fixture workspace (07 §3.1). Unlike the example fixtures it
 * lives under `stack/tests/fixtures/` (its own `estate/` + `rendered/` + `pulse.config.yaml`), so
 * the golden drift check runs the CLI with this directory as cwd.
 */
export const STACK_FIXTURE_DIR = resolve(REPO_ROOT, "stack", "tests", "fixtures");

/** Result of a captured process run (mirrors harness `Ran`; never throws on non-zero exit). */
export interface Ran {
  exitCode: number;  // process exit status (0 = success); mirrors `stack/tests/harness.ts` `Ran`
  stdout: string;    // captured standard output
  stderr: string;    // captured standard error
}

/**
 * Invoke the `pulse` CLI from source (D9) against a fixture, capturing streams.
 *
 * CRITICAL (00 §3, apps/cli/src/config.ts:83-84): the CLI resolves `estateDir`/`outputRoot`
 * relative to its PROCESS CWD, and `estateDir` is NOT flag-overridable. So we spawn with
 * `cwd = fixtureDir(name)` and DROP `--config`: `pulse.config.yaml` auto-discovers and the
 * estate/rendered paths resolve inside the fixture. Always passes `--json` so tests parse the
 * envelope (00 §2.2) rather than scraping text.
 *
 * @param name - Which fixture workspace to run in (its dir becomes the CLI CWD).
 * @param verb - `validate` | `render` | `coverage` (never `init`/host-touching).
 * @param args - Additional CLI args (e.g. `["--check"]`); `--config` is intentionally omitted.
 * @param env - Extra env overlaid on `process.env` (e.g. `PULSE_*`).
 * @returns The captured exit code and streams. Exit 0 clean / 1 findings-or-outcome / 2 fault.
 */
export function pulse(
  name: FixtureName,
  verb: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Ran {
  return pulseAt(fixtureDir(name), verb, args, env);
}

/**
 * Invoke the `pulse` CLI from source against an ARBITRARY workspace directory, capturing streams.
 * Same contract as `pulse` but the cwd is passed explicitly, so a source-backed fixture outside
 * `examples/` (e.g. the stack rendered fixture, 07 §3.1) can be drift-checked through the same
 * `render --check` path.
 *
 * @param cwd - The CLI process working directory (holds `pulse.config.yaml` + estate/rendered).
 */
export function pulseAt(
  cwd: string,
  verb: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Ran {
  const p = Bun.spawnSync(
    ["bun", "run", CLI_ENTRY, verb, ...args, "--json"],
    { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" },
  );
  return {
    exitCode: p.exitCode,
    stdout: new TextDecoder().decode(p.stdout),
    stderr: new TextDecoder().decode(p.stderr),
  };
}

/** Parse the single `--json` envelope emitted on stdout (00 §2.2). */
export function envelope(ran: Ran): {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  command: string;
  findings: unknown[];
  data: unknown;
} {
  return JSON.parse(ran.stdout);
}
