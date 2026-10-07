// scripts/update-golden.ts — DELIBERATELY (re)generate EVERY committed rendered tree
// (07 §3.2, REQ-RENDER-05, REQ-MAINT-01). NEVER run automatically: regenerating a golden is a
// reviewed act. Run it by hand when a rendering change is intentional, then review the complete
// generated diff before committing:
//
//     bun run golden:update      # → bun run scripts/update-golden.ts
//
// It (1) runs the renderer golden updater (packages/renderer/tests/golden-update.ts), which
// re-renders the multiclass golden tree under packages/renderer/tests/golden/, then (2) renders
// each source-backed CLI fixture with the SOURCE CLI (bun run apps/cli/src/index.ts render), with
// the fixture directory as the CLI's cwd so the fixture's own pulse.config.yaml
// (estateDir: estate, outputRoot: rendered) resolves into that fixture's subtree. It stops at the
// FIRST failure with a non-zero exit and never swallows a failed loader/renderer/write result.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this script's location (scripts/ is a repo-root child). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The source CLI entry (D9) — invoked as `bun run <this> render` per fixture. */
const CLI_ENTRY = resolve(REPO_ROOT, "apps/cli/src/index.ts");

/** The renderer golden updater — re-renders packages/renderer/tests/golden/multiclass.golden/. */
const RENDERER_GOLDEN_UPDATER = resolve(REPO_ROOT, "packages/renderer/tests/golden-update.ts");

/** One checked-in source and generated-tree pair (07 §3.2). */
interface CliGoldenFixture {
  /** Stable log/review identifier. */
  readonly id: "minimal" | "reference" | "stack";
  /** Directory used as the CLI process working directory (holds estate/ + rendered/ + config). */
  readonly cwd: string;
}

/** Every source-backed CLI fixture, in deterministic declaration order (07 §3.2). */
const CLI_FIXTURES: readonly CliGoldenFixture[] = [
  { id: "minimal", cwd: resolve(REPO_ROOT, "examples", "minimal") },
  { id: "reference", cwd: resolve(REPO_ROOT, "examples", "reference") },
  { id: "stack", cwd: resolve(REPO_ROOT, "stack", "tests", "fixtures") },
];

/**
 * Run the renderer golden updater as a child process. Throws (via process exit) on launch failure
 * or a non-zero exit — a fatal web projection there writes no golden and exits non-zero (07 §3.2).
 */
function renderRendererGolden(): void {
  console.log("↻ regenerating renderer golden tree (packages/renderer/tests/golden/) …");
  const result = spawnSync("bun", ["run", RENDERER_GOLDEN_UPDATER], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    console.error(`✗ failed to launch the renderer golden updater: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`✗ renderer golden update failed (exit ${result.status ?? "signal"})`);
    process.exit(result.status ?? 1);
  }
  console.log("✓ wrote packages/renderer/tests/golden/");
}

/**
 * Render one CLI fixture in write mode into its own `rendered/` tree.
 *
 * Runs `bun run apps/cli/src/index.ts render` with the fixture directory as cwd, so the committed
 * `pulse.config.yaml` (or the CLI defaults) resolves `estateDir`/`outputRoot` into this fixture
 * (apps/cli/src/config.ts). Inherits stdio so render findings surface to the operator.
 *
 * @param fixture - The fixture id and cwd.
 * @throws Never; on a non-zero CLI exit it prints the code and exits the process (1/2).
 */
function renderFixture(fixture: CliGoldenFixture): void {
  console.log(`↻ regenerating golden tree for ${fixture.id} (${fixture.cwd}/rendered/) …`);

  const result = spawnSync("bun", ["run", CLI_ENTRY, "render"], {
    cwd: fixture.cwd, // estateDir/outputRoot resolve relative to THIS dir (config.ts)
    stdio: "inherit",
  });

  if (result.error !== undefined) {
    console.error(`✗ failed to launch the CLI for ${fixture.id}: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`✗ render failed for ${fixture.id} (exit ${result.status ?? "signal"})`);
    process.exit(result.status ?? 1);
  }
  console.log(`✓ wrote ${fixture.cwd}/rendered/`);
}

/** Regenerate every committed renderer/example/stack tree, stopping at the first failure. */
function main(): void {
  renderRendererGolden();
  for (const fixture of CLI_FIXTURES) renderFixture(fixture);
  console.log(
    "\nGolden corpus regenerated. Review the generated diff before committing:\n" +
      "  packages/renderer/tests/golden/\n" +
      "  examples/minimal/rendered/\n" +
      "  examples/reference/rendered/\n" +
      "  stack/tests/fixtures/rendered/",
  );
}

main();
