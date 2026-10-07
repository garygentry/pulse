// agent-kit/tests/pack-scaffold.test.ts
// Pack-scaffold + secret-safety locks (06-testing-and-eval.md §5.5/§5.6; REQ-GUIDE-06, REQ-SEC-01/03).
//
// Proves the guidance pack `buildGuidancePack()` produces applies create-only through the REAL
// CLI `runInit` (05 §6.2; apps/cli/src/commands/init.ts), that every target is repo-relative and
// non-escaping (so the CLI's path-escape → exit 2 branch can never trigger from a well-formed
// pack), and that the shipped pack teaches secret REFERENCES only — no literal. agent-kit does
// not re-implement init behavior; it asserts the CLI's existing behavior holds for its pack.
//
// Discipline (spec §1): GATING — deep-imports the REAL `runInit` and the REAL committed
// `PACK_BYTES` (no mock). A missing target throws at import / `buildGuidancePack` (fails RED),
// never self-skips. Every temp dir is removed in a `finally`.
//
// runInit returns CommandResult<InitData> (findings/data/outcomeFailed) — it has NO `exitCode`
// field; the shell maps `outcomeFailed` to exit 1 and a clean result to exit 0, so this suite
// derives the exit code the same way.

import { beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { runInit } from "@pulse/cli/src/commands/init.ts"; // deep import (OT-03, no exports gate)
import { buildGuidancePack } from "../src/index.js"; // barrel export (item 005)
import { PACK_BYTES } from "../generated/guidance-pack.generated.js"; // committed pack bytes
import { assertNoSecretLiterals } from "../src/emit/secret-lint.js"; // 04 §6 (the REAL lint)
import { SecretLiteralError } from "../src/emit/errors.js";
import { claudeEmitter } from "../src/emit/claude.js";
import { buildSlots } from "../src/slots/index.js";
import type { ContentUnit } from "../src/emit/types.js";

/** Exit code the shell derives from a CommandResult (00 §2): outcomeFailed → 1, else 0. */
const exitOf = (res: { outcomeFailed: boolean }): 0 | 1 => (res.outcomeFailed ? 1 : 0);

describe("pack-scaffold (REQ-GUIDE-06, REQ-SEC-01/03)", () => {
  // buildGuidancePack is async (reads the committed generated/** trees — 03 §11); resolve once.
  let pack: Awaited<ReturnType<typeof buildGuidancePack>>;
  beforeAll(async () => {
    pack = await buildGuidancePack();
  });

  test("the pack is non-empty (fail RED if generated/** is missing)", () => {
    expect(pack.files.length).toBeGreaterThan(0);
  });

  test("every pack target is repo-relative, non-escaping, and create-only", () => {
    const root = resolve("/repo-root");
    for (const f of pack.files) {
      expect(f.target.startsWith("/")).toBe(false); // not absolute
      expect(f.target.split("/")).not.toContain(".."); // no parent-escape segment
      // Resolves strictly inside a repo root — the CLI's joinRepo escape branch can't fire.
      expect(resolve(root, f.target).startsWith(root + "/")).toBe(true);
      expect(f.merge).toBe("create-only");
    }
  });

  test("applies create-only on a clean repo (exit 0, every pack target created, none clobbered)", () => {
    const repo = mkdtempSync(join(tmpdir(), "agent-kit-init-"));
    try {
      const res = runInit({ repoRoot: repo, force: false, pack });
      expect(exitOf(res)).toBe(0);
      expect(res.data).not.toBeNull();
      for (const f of pack.files) expect(res.data!.created).toContain(f.target);
      expect(res.data!.wouldClobber ?? []).toHaveLength(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("collision without --force → exit 1, wouldClobber names it, nothing else written", () => {
    const repo = mkdtempSync(join(tmpdir(), "agent-kit-init-"));
    try {
      const victim = pack.files[0]!.target;
      const other = pack.files[pack.files.length - 1]!.target; // a distinct, untouched target
      const victimAbs = join(repo, victim);
      mkdirSync(dirname(victimAbs), { recursive: true });
      writeFileSync(victimAbs, "pre-existing\n", "utf8"); // pre-write ONE target

      const res = runInit({ repoRoot: repo, force: false, pack });
      expect(exitOf(res)).toBe(1); // refuse rather than clobber (REQ-SEC-03)
      expect(res.data!.wouldClobber).toContain(victim);
      expect(res.data!.created).toEqual([]); // wrote nothing

      // Nothing else was written: another pack target and the base scaffold are both absent...
      expect(existsSync(join(repo, other))).toBe(false);
      expect(existsSync(join(repo, "pulse.config.yaml"))).toBe(false);
      // ...and the pre-existing file was not overwritten.
      expect(readFileSync(victimAbs, "utf8")).toBe("pre-existing\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // ── Secret safety (REQ-SEC-01, spec §5.6) ─────────────────────────────────────────────────
  test("no committed PACK_BYTES entry contains a secret literal", () => {
    const entries = Object.entries(PACK_BYTES);
    expect(entries.length).toBeGreaterThan(0); // fail RED on an empty pack, never vacuously green
    for (const [source, contents] of entries) {
      // The REAL emit-path lint — the shipped pack must teach ${ENV}/op:// references only.
      expect(() => assertNoSecretLiterals(source, contents)).not.toThrow();
    }
  });

  test("feeding a secret-bearing content unit through the emit path throws SecretLiteralError", () => {
    const emitWithSecret = (): void => {
      const slots = buildSlots();
      const unit: ContentUnit = {
        id: "secret-bearing",
        kind: "guidance",
        frontmatter: { name: "Secret Bearing", description: "A deliberately secret-bearing unit." },
        targets: ["claude"],
        requirements: [],
        // A bare credential literal (not a ${ENV} / op:// reference) in the rendered body.
        render: () => [{ heading: "Credential", text: "api_key: AKIA1234567890ABCDEF0" }],
      };
      // Emit exactly as the generator does, then run the same secret lint over every file (03 §9).
      for (const f of claudeEmitter.emit({ units: [unit] }, slots)) {
        assertNoSecretLiterals(join("claude", f.path), f.contents);
      }
    };
    expect(emitWithSecret).toThrow(SecretLiteralError);
  });
});
