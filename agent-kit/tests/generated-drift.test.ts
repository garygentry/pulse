// agent-kit/tests/generated-drift.test.ts
// Source-currency gate (06-testing-and-eval.md §5.2; REQ-DRIFT-01/03, REQ-PERF-02).
//
// Proves the committed `generated/**` tree equals a fresh regeneration — the single-source
// guarantee and generation determinism. Drives the REAL generator via the exported helpers
// `regenerateToTemp` / `listGeneratedFiles` (03 §10, item 005). A hand-edit, an
// un-regenerated source change, or a hand-added/deleted generated file fails the build.
//
// Discipline (spec §1): this is a GATING suite — it never self-skips. If `generated/**` is
// missing, `listGeneratedFiles(GENERATED)` throws at load and the suite errors RED. It never
// writes into the committed tree: regeneration goes to temp dirs created by the helper, whose
// bytes are read into memory upfront so each temp dir is removed in a `finally` before the
// per-file assertions run.

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { listGeneratedFiles, regenerateToTemp } from "../scripts/verify-generated.js";

const GENERATED = resolve(import.meta.dir, "../generated");

/** Read every file under `dir` (given its sorted relative paths) into an in-memory map. */
function readTree(dir: string, rels: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of rels) out[rel] = readFileSync(join(dir, rel), "utf8");
  return out;
}

/**
 * Regenerate twice into temp dirs, snapshot the committed tree and both regenerations into
 * memory, and remove each temp dir in a `finally`. Everything the tests below need is captured
 * here so no temp dir outlives this function and the committed tree is never touched.
 */
async function collect() {
  const committedFiles = await listGeneratedFiles(GENERATED);
  const committed = readTree(GENERATED, committedFiles);

  const temp1 = await regenerateToTemp();
  let regen1Files: string[];
  let regen1: Record<string, string>;
  try {
    regen1Files = await listGeneratedFiles(temp1);
    regen1 = readTree(temp1, regen1Files);
  } finally {
    rmSync(temp1, { recursive: true, force: true });
  }

  const temp2 = await regenerateToTemp();
  let regen2Files: string[];
  let regen2: Record<string, string>;
  try {
    regen2Files = await listGeneratedFiles(temp2);
    regen2 = readTree(temp2, regen2Files);
  } finally {
    rmSync(temp2, { recursive: true, force: true });
  }

  return { committedFiles, committed, regen1Files, regen1, regen2Files, regen2 };
}

const snap = await collect();

describe("generated-drift (REQ-DRIFT-03, REQ-PERF-02)", () => {
  // Fail RED on an empty/absent tree rather than passing vacuously (no self-skip, spec §1).
  test("the committed generated tree is non-empty", () => {
    expect(snap.committedFiles.length).toBeGreaterThan(0);
  });

  test("committed generated file set == regeneration file set", () => {
    expect(snap.regen1Files.slice().sort()).toEqual(snap.committedFiles.slice().sort());
  });

  // One test per committed file, titled by path, so a reviewer sees exactly which file drifted.
  for (const rel of snap.committedFiles) {
    test(`generated/${rel} is byte-current with its source`, () => {
      expect(snap.regen1[rel]).toBe(snap.committed[rel]);
    });
  }

  // REQ-PERF-02: two independent regenerations must be byte-identical (deterministic output).
  test("regeneration is idempotent (twice → identical file set)", () => {
    expect(snap.regen2Files.slice().sort()).toEqual(snap.regen1Files.slice().sort());
  });

  for (const rel of snap.regen1Files) {
    test(`generated/${rel} regenerates byte-identically twice`, () => {
      expect(snap.regen2[rel]).toBe(snap.regen1[rel]);
    });
  }
});
