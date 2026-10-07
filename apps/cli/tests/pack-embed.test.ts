// apps/cli/tests/pack-embed.test.ts — the shipped-bytes proof for the agent-kit pack wire-in
// (item 009; specs 04 §5.4, 05 §2.4). The one justified subprocess test in the CLI suite.
//
// It proves two things:
//   • a DEV build (no wire-in) leaves BUNDLED_GUIDANCE_PACK === undefined — `pulse init` from the
//     committed source scaffolds base-only, so the pack only ever ships via the release wire-in;
//   • a RELEASE build (wirePackIntoInit + `bun build --compile`) produces a native binary whose
//     `pulse init` lays every pack file down CREATE-ONLY with the exact GUIDANCE_PACK bytes —
//     the temp repo starts empty, so those bytes could only have shipped INSIDE the binary.
//
// A musl artifact can't exec on a glibc host, so the runnable proof builds the host-native
// target (matching build-bin.test.ts's --version proof). The wire-in is restored in a `finally`
// so the committed init.ts is never left carrying a real pack.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BUNDLED_GUIDANCE_PACK } from "../src/commands/init.js";
import { INIT_FILE, wirePackIntoInit } from "../scripts/build-bin.js";
import { GUIDANCE_PACK, PACK_BYTES } from "../../../agent-kit/generated/guidance-pack.generated.js";

const CLI_ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(CLI_ROOT, "src/index.ts");

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

describe("pack embedding — dev build (no wire-in)", () => {
  test("the committed source leaves BUNDLED_GUIDANCE_PACK === undefined", () => {
    // A dev/local build never runs wirePackIntoInit, so the pack seam stays undefined and
    // `pulse init` emits only the base scaffold (REQ-INIT-02). The wire-in is release-only.
    expect(BUNDLED_GUIDANCE_PACK).toBeUndefined();
  });
});

describe("pack embedding — release build ships the pack bytes (04 §5.4)", () => {
  test(
    "a wired --compile binary lays every pack file down create-only in a temp repo",
    () => {
      // Sanity: the pack is non-empty and its byte map is total over the file sources — otherwise
      // a "all files present" assertion could vacuously pass on an empty pack.
      expect(GUIDANCE_PACK.files.length).toBeGreaterThan(0);
      for (const f of GUIDANCE_PACK.files) {
        expect(f.merge).toBe("create-only");
        expect(typeof PACK_BYTES[f.source]).toBe("string");
      }

      const buildDir = freshTmp("pulse-packbin-");
      const outPath = join(buildDir, "pulse-native");

      // Wire the pack into init.ts, compile a host-native binary, then ALWAYS restore init.ts.
      const originalInit = wirePackIntoInit();
      try {
        const nativeTarget = process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
        const build = Bun.spawnSync(
          [process.execPath, "build", ENTRY, "--compile", `--target=${nativeTarget}`, "--outfile", outPath],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(build.stderr.toString()).not.toContain("error");
        expect(build.success).toBe(true);
      } finally {
        writeFileSync(INIT_FILE, originalInit, "utf8");
      }
      // The restore leaves the committed source byte-identical (pack-less again).
      expect(readFileSync(INIT_FILE, "utf8")).toBe(originalInit);

      // Run `pulse init --json` in a pristine (empty) temp repo — nothing pre-exists there, so
      // any pack file that lands must have been carried inside the binary.
      const repo = freshTmp("pulse-packrepo-");
      for (const f of GUIDANCE_PACK.files) expect(existsSync(join(repo, f.target))).toBe(false);

      const run = Bun.spawnSync([outPath, "init", "--json"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      expect(run.exitCode).toBe(0);

      const env = JSON.parse(run.stdout.toString()) as {
        exitCode: number;
        data: { created: string[]; skipped: string[]; wouldClobber?: string[] };
      };
      expect(env.exitCode).toBe(0);

      // Every pack file was CREATED (not skipped, not clobbered) with the exact shipped bytes.
      for (const f of GUIDANCE_PACK.files) {
        const abs = join(repo, f.target);
        expect(env.data.created).toContain(f.target);
        expect(existsSync(abs)).toBe(true);
        expect(readFileSync(abs, "utf8")).toBe(PACK_BYTES[f.source]!);
      }
      expect(env.data.wouldClobber ?? []).toEqual([]);
    },
    120_000,
  );
});
