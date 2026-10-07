// agent-kit/scripts/verify-generated.ts
// Drift check (REQ-DRIFT-03).
//
// Regenerate into a temp dir and byte-compare against the committed `generated/`. Any hand-edit
// to a generated file, or any un-regenerated source change, fails with the offending path + a
// first-diff excerpt. Mirrors the repo's `verify:golden` discipline. The gating test
// `generated-drift.test.ts` (item 006) wraps the exported helpers.

import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { generate } from "./generate.js";

const COMMITTED = resolve(import.meta.dir, "../generated");

/** Recursively list files under `dir`, returned as sorted `dir`-relative paths. */
export async function listGeneratedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out.push(relative(dir, abs));
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * Regenerate the full `generated/**` tree into a fresh temp dir and return its absolute path.
 * Never writes into the committed tree — the drift test (item 006) byte-compares this against
 * `COMMITTED` and cleans the temp dir up itself.
 */
export async function regenerateToTemp(): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), "agent-kit-gen-"));
  await generate(temp);
  return temp;
}

/** One drift finding: a path present/absent/changed vs the committed tree. */
export interface DriftFinding {
  /** Ecosystem-relative path, e.g. "claude/CLAUDE.md". */
  path: string;
  /** What drifted. */
  kind: "missing" | "unexpected" | "changed";
  /** A short first-diff excerpt for `"changed"` (empty otherwise). */
  diff: string;
}

/**
 * Regenerate to a temp dir and byte-compare against the committed `generated/`. Returns the
 * list of findings (empty ⇒ in sync). Deterministic: both sides come from the same pure
 * generator, so a non-empty result means a hand-edit or an un-regenerated source change
 * (REQ-DRIFT-03).
 */
export async function verifyGenerated(): Promise<DriftFinding[]> {
  const temp = await regenerateToTemp();

  const [committed, fresh] = await Promise.all([
    listGeneratedFiles(COMMITTED),
    listGeneratedFiles(temp),
  ]);
  const findings: DriftFinding[] = [];
  const committedSet = new Set(committed);
  const freshSet = new Set(fresh);

  for (const p of committed) {
    if (!freshSet.has(p)) {
      findings.push({ path: p, kind: "unexpected", diff: "" });
      continue;
    }
    const [a, b] = await Promise.all([
      readFile(join(COMMITTED, p), "utf8"),
      readFile(join(temp, p), "utf8"),
    ]);
    if (a !== b) findings.push({ path: p, kind: "changed", diff: firstDiffLine(a, b) });
  }
  for (const p of fresh) {
    if (!committedSet.has(p)) findings.push({ path: p, kind: "missing", diff: "" });
  }
  return findings;
}

/** First differing line as a compact `- committed / + regenerated` excerpt. */
function firstDiffLine(committed: string, fresh: string): string {
  const a = committed.split("\n"),
    b = fresh.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return `@@ line ${i + 1} @@\n- ${a[i] ?? "<eof>"}\n+ ${b[i] ?? "<eof>"}`;
  }
  return "";
}

if (import.meta.main) {
  const findings = await verifyGenerated();
  if (findings.length > 0) {
    console.error("agent-kit: generated/** is stale — regenerate with `generate`:");
    for (const f of findings) console.error(`  [${f.kind}] ${f.path}\n${f.diff}`);
    process.exit(1);
  }
  console.log("agent-kit: generated/** is in sync with source.");
}
