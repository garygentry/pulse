// agent-kit/tests/eval.smoke.test.ts
// Codex/Pi pack-present smoke suite (06-testing-and-eval.md §6.3; REQ-EVAL-04).
//
// The non-reference-ecosystem first-class packs (Codex, Pi) are SMOKE-checked, not live-evaluated
// (PRD §6). This suite reads the committed `generated/<eco>/**` tree and asserts the expected
// guidance/skill files are PRESENT, NON-EMPTY, and WELL-FORMED (runnable-skill frontmatter keys
// where applicable), that the expected skill ids appear, and that every emitted path is
// repo-relative + non-escaping. It is a presence + well-formedness check on committed outputs (a
// currency companion to generated-drift.test.ts) — NOT a real `runInit` scaffold (that create-only
// behavior is proven once, ecosystem-agnostically, by pack-scaffold.test.ts §5.5).
//
// Discipline (spec §1): GATING — a missing/empty/malformed committed file fails RED, never
// self-skips. Reads only; writes nothing. Emits a per-ecosystem `[eval:smoke] <eco>: PASS|FAIL`
// line (REQ-OBS-01).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Root of the committed generated tree. */
const GENERATED = resolve(import.meta.dir, "../generated");

/** The runnable skill/subagent ids every first-class pack must surface (spec §6.3 #2). */
const EXPECTED_SKILL_IDS = [
  "estate-authoring",
  "render-validate-coverage",
  "coverage-interpretation",
  "alert-triage",
] as const;

/** One emitted file: its ecosystem-relative POSIX path + contents. */
interface EmittedFile {
  path: string; // relative to generated/<eco>, POSIX separators
  contents: string;
}

/** Recursively list every file under `dir` as POSIX paths relative to it. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...walk(abs).map((p) => `${entry}/${p}`));
    } else {
      out.push(entry);
    }
  }
  return out;
}

/** Read the committed `generated/<eco>/**` tree into EmittedFile records. */
function emittedFilesFor(eco: string): EmittedFile[] {
  const root = join(GENERATED, eco);
  return walk(root).map((rel) => ({
    // Normalize to POSIX so path assertions hold regardless of the host separator.
    path: rel.split(sep).join("/"),
    contents: readFileSync(join(root, rel), "utf8"),
  }));
}

/**
 * Extract the YAML frontmatter key set from a runnable file (the block fenced by the first two
 * `---` lines). Returns null when the file has no frontmatter (e.g. a Codex playbook / guidance).
 */
function frontmatterKeys(contents: string): Set<string> | null {
  if (!contents.startsWith("---\n")) return null;
  const end = contents.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = contents.slice(4, end);
  const keys = new Set<string>();
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z][\w-]*):/.exec(line);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/** Per-ecosystem shape: which files are the runnable skills, and whether they carry frontmatter. */
interface EcoSpec {
  /** A file that MUST exist (the ecosystem's root guidance entrypoint). */
  requiredFile: string;
  /** Is this emitted path a runnable skill/subagent file for this ecosystem? */
  isRunnableSkill(path: string): boolean;
  /** Do this ecosystem's runnable skills carry name/description frontmatter? */
  runnableHasFrontmatter: boolean;
}

const ECO_SPECS: Record<"codex" | "pi", EcoSpec> = {
  // Codex: one AGENTS.md + skills/NN-<id>.md instruction playbooks (no runnable frontmatter, 03 §5).
  codex: {
    requiredFile: "AGENTS.md",
    isRunnableSkill: (p) => /^skills\/\d\d-.+\.md$/.test(p),
    runnableHasFrontmatter: false,
  },
  // Pi: native guidance + runnable skill (.pi/skills) + subagent (.pi/agents) files (03 §6).
  pi: {
    requiredFile: ".pi/guidance/vocab-primer.md",
    isRunnableSkill: (p) => p.startsWith(".pi/skills/") || p.startsWith(".pi/agents/"),
    runnableHasFrontmatter: true,
  },
};

for (const eco of ["codex", "pi"] as const) {
  describe(`eval.smoke [${eco}] (REQ-EVAL-04)`, () => {
    const spec = ECO_SPECS[eco];

    test(`${eco} pack is present, well-formed, and surfaces the expected skills`, () => {
      try {
        const files = emittedFilesFor(eco);

        // (1) Present — a non-empty tree with the required guidance entrypoint.
        expect(files.length).toBeGreaterThan(0);
        expect(files.some((f) => f.path === spec.requiredFile)).toBe(true);

        for (const f of files) {
          // (2) Well-formed — non-empty contents.
          expect(f.contents.trim().length, `empty file ${eco}/${f.path}`).toBeGreaterThan(0);
          // (3) Repo-relative & non-escaping (the same path shape pack-scaffold.test.ts guards).
          expect(f.path.startsWith("/"), `absolute path ${f.path}`).toBe(false);
          expect(f.path.split("/"), `escaping path ${f.path}`).not.toContain("..");

          // (2b) Runnable-skill frontmatter well-formedness for this ecosystem.
          if (spec.isRunnableSkill(f.path)) {
            const keys = frontmatterKeys(f.contents);
            if (spec.runnableHasFrontmatter) {
              expect(keys, `missing frontmatter in ${eco}/${f.path}`).not.toBeNull();
              expect(keys!.has("name"), `no name in ${eco}/${f.path}`).toBe(true);
              expect(keys!.has("description"), `no description in ${eco}/${f.path}`).toBe(true);
            }
          }
        }

        // (1/2) Every expected skill id appears somewhere in the tree (as a file path segment).
        for (const id of EXPECTED_SKILL_IDS) {
          expect(files.some((f) => f.path.includes(id)), `missing skill id ${id} in ${eco}`).toBe(
            true,
          );
        }

        console.log(`[eval:smoke] ${eco}: PASS`); // REQ-OBS-01 (per-ecosystem line)
      } catch (e) {
        console.log(`[eval:smoke] ${eco}: FAIL`);
        throw e;
      }
    });
  });
}
