// agent-kit/tests/fixtures/estate.ts
// Reference-estate copy factory + the shared EstatePatch type (06-testing-and-eval.md §4).
//
// The deterministic eval (eval.deterministic.test.ts) exercises the three rehearsed operator
// tasks against a COPY of deploy-toolkit's committed reference estate (examples/reference,
// REQ-INTEG-03). The committed source is NEVER mutated — each task copies the tree into a fresh
// mkdtemp dir, applies its scripted mutation there, drives the CLI cwd'd into the copy, and
// removes the copy in a `finally` (PRD §7 single-writer; spec §1 determinism discipline).

import { cpSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

/**
 * Absolute path to deploy-toolkit's committed reference estate (REQ-INTEG-03).
 * From agent-kit/tests/fixtures → ../../../ reaches the repo root, then examples/reference.
 */
export const REFERENCE_ESTATE = resolve(import.meta.dir, "../../../examples/reference");

/**
 * Copy the reference estate (pulse.config.yaml + estate/estate.yaml + rendered/) into a fresh
 * temp dir and return its path. The caller runs the CLI cwd'd into this dir and removes it in a
 * `finally`. Never mutates the committed source — determinism is the whole point of the gate.
 */
export function copyReferenceEstate(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-kit-estate-"));
  cpSync(REFERENCE_ESTATE, dir, { recursive: true });
  return dir;
}

/**
 * A scripted operator mutation for one rehearsed task — the deterministic stand-in for what a
 * human/agent would author (NO model call, spec §4.2). Each fixture applies its edit to a copied
 * estate and exposes the identifier it introduces/targets so post-conditions can assert on it.
 *
 * Fixtures MUST be secret-safe: any credential field they write uses only `${ENV}` / `op://`
 * reference grammar, never a bare literal (mirrors REQ-SEC-01).
 */
export interface EstatePatch {
  /** Stable task id, used in the per-task pass/fail log line (REQ-OBS-01). */
  task: "add-host" | "add-probe" | "explain-coverage";
  /**
   * Apply the scripted mutation to a copied estate dir (mutates `<estateDir>/estate/estate.yaml`
   * in place). `estateDir` is the temp path returned by {@link copyReferenceEstate}.
   */
  apply(estateDir: string): void;
  /** The identifier the mutation introduces / targets, asserted in post-conditions. */
  subject: string; // the new host id, the new service/probe name, or the gap service name
}

/** Absolute path to the estate-config YAML inside a copied estate dir. */
export function estateYamlPath(estateDir: string): string {
  return join(estateDir, "estate", "estate.yaml");
}
