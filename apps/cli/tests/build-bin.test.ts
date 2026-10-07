// apps/cli/tests/build-bin.test.ts — the compiled-binary build pipeline (item 019, 01 §4).
//
// Covers, per the acceptance criteria:
//   • version injection is deterministic and restores the "0.0.0-dev" sentinel (REQ-DET-01);
//   • the committed src/version.ts is exactly the regenerated sentinel form (never hand-edited);
//   • SHA256SUMS is emitted over exactly the two arch binaries, in coreutils `sha256sum` format;
//   • an x64 `bun build --compile` binary is runnable and prints PULSE_VERSION + the bundled
//     core's supported schema majors on `--version` (REQ-CLI-06);
//   • `runBuild` produces both musl-static arch artifacts (correct ELF machine) + SHA256SUMS.
//
// A musl binary cannot execute on a glibc build host, so the *runnable* --version check builds
// the host-native target; the release *artifacts* (musl) are asserted by their ELF machine byte.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { SUPPORTED_SCHEMA_MAJORS } from "@pulse/core";

import { PULSE_VERSION } from "../src/version.js";
import {
  BUILD_TARGETS,
  CHECKSUMS_FILENAME,
  VERSION_SENTINEL,
  computeSha256Sums,
  renderVersionModule,
  runBuild,
  sha256File,
  writeVersionFile,
} from "../scripts/build-bin.js";

const CLI_ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(CLI_ROOT, "src/index.ts");
const COMMITTED_VERSION_FILE = resolve(CLI_ROOT, "src/version.ts");

/** A fresh temp dir, auto-removed after a synchronous callback. */
function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pulse-buildbin-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A fresh temp dir, auto-removed after an async callback resolves (never removed mid-build). */
async function withTmpAsync<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pulse-buildbin-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The ELF `e_machine` (little-endian u16 at offset 18): 62 = x86-64, 183 = AArch64. */
function elfMachine(path: string): { isElf: boolean; machine: number } {
  const buf = readFileSync(path);
  const isElf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  return { isElf, machine: buf.readUInt16LE(18) };
}

describe("version injection (renderVersionModule / writeVersionFile)", () => {
  test("emits exactly `export const PULSE_VERSION = \"<version>\";` for a passed version", () => {
    const src = renderVersionModule("1.2.3");
    expect(src).toContain('export const PULSE_VERSION = "1.2.3";');
  });

  test("is deterministic — two calls with the same version are byte-identical", () => {
    expect(renderVersionModule("9.9.9")).toBe(renderVersionModule("9.9.9"));
    expect(renderVersionModule(VERSION_SENTINEL)).toBe(renderVersionModule(VERSION_SENTINEL));
  });

  test("introduces no nondeterministic content (no clock/host/pid/random)", () => {
    const src = renderVersionModule("1.0.0");
    for (const forbidden of [/\bDate\b/, /Date\.now/, /\bhostname\b/, /process\.pid\b/, /Math\.random\b/]) {
      expect(src).not.toMatch(forbidden);
    }
  });

  test("round-trips version arg → restore sentinel deterministically on a temp file", () => {
    withTmp((dir) => {
      const file = join(dir, "version.ts");

      writeVersionFile("2.5.0", file);
      expect(readFileSync(file, "utf8")).toBe(renderVersionModule("2.5.0"));
      expect(readFileSync(file, "utf8")).toContain('export const PULSE_VERSION = "2.5.0";');

      // Restore: writing the sentinel yields byte-identical bytes to the committed source.
      writeVersionFile(VERSION_SENTINEL, file);
      expect(readFileSync(file, "utf8")).toBe(renderVersionModule(VERSION_SENTINEL));
    });
  });

  test("the committed src/version.ts IS the regenerated sentinel form (never hand-edited)", () => {
    expect(PULSE_VERSION).toBe(VERSION_SENTINEL);
    expect(readFileSync(COMMITTED_VERSION_FILE, "utf8")).toBe(renderVersionModule(VERSION_SENTINEL));
  });
});

describe("SHA256SUMS emission (computeSha256Sums)", () => {
  test("covers exactly the two arch binaries in coreutils `sha256sum` format", () => {
    withTmp((dir) => {
      const names = BUILD_TARGETS.map((t) => t.outfile);
      expect(names).toEqual(["pulse-linux-x64", "pulse-linux-arm64"]);

      const x64Bytes = Buffer.from("x64-binary-bytes");
      const armBytes = Buffer.from("arm64-binary-bytes");
      writeFileSync(join(dir, "pulse-linux-x64"), x64Bytes);
      writeFileSync(join(dir, "pulse-linux-arm64"), armBytes);

      const sums = computeSha256Sums(dir, names);
      const lines = sums.split("\n").filter((l) => l.length > 0);

      // Exactly two lines, one per arch binary, nothing else.
      expect(lines).toHaveLength(2);
      const listed = lines.map((l) => l.split("  ")[1]);
      expect(new Set(listed)).toEqual(new Set(names));

      // Each line: <64 hex>  <name>, hash matching an independent computation (two-space sep).
      const x64Hash = createHash("sha256").update(x64Bytes).digest("hex");
      const armHash = createHash("sha256").update(armBytes).digest("hex");
      expect(sums).toBe(`${x64Hash}  pulse-linux-x64\n${armHash}  pulse-linux-arm64\n`);
      for (const line of lines) expect(line).toMatch(/^[0-9a-f]{64} {2}pulse-linux-(x64|arm64)$/);
    });
  });

  test("sha256File matches node:crypto over the same bytes", () => {
    withTmp((dir) => {
      const f = join(dir, "blob");
      const bytes = Buffer.from("hello pulse");
      writeFileSync(f, bytes);
      expect(sha256File(f)).toBe(createHash("sha256").update(bytes).digest("hex"));
    });
  });
});

describe("compiled binary --version (REQ-CLI-06)", () => {
  test(
    "an x64 --compile binary is runnable and prints PULSE_VERSION + supported schema majors",
    () => {
      withTmp((dir) => {
        // A musl binary can't exec on a glibc host; build the host-native target for the run.
        const nativeTarget = process.arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
        const outPath = join(dir, "pulse-native");
        const build = Bun.spawnSync(
          [process.execPath, "build", ENTRY, "--compile", `--target=${nativeTarget}`, "--outfile", outPath],
          { stdout: "pipe", stderr: "pipe" },
        );
        expect(build.success).toBe(true);
        expect(existsSync(outPath)).toBe(true);

        const run = Bun.spawnSync([outPath, "--version"], { stdout: "pipe", stderr: "pipe" });
        expect(run.exitCode).toBe(0);
        const out = run.stdout.toString();
        expect(out).toContain(`pulse ${PULSE_VERSION}`);
        expect(out).toContain(`supported schema majors: ${SUPPORTED_SCHEMA_MAJORS.join(", ")}`);
      });
    },
    60_000,
  );
});

describe("runBuild — musl artifacts + checksums (CON-03)", () => {
  test(
    "produces both musl-static arch binaries (correct ELF machine) and a SHA256SUMS over them",
    async () => {
      await withTmpAsync(async (dir) => {
        const result = await runBuild({ version: VERSION_SENTINEL, outDir: dir });

        // Both v1 targets attempted, in BUILD_TARGETS order; every one built here.
        expect(result.targets.map((t) => t.outfile)).toEqual(["pulse-linux-x64", "pulse-linux-arm64"]);
        const x64 = result.targets.find((t) => t.outfile === "pulse-linux-x64")!;
        expect(x64.ok).toBe(true);

        // The x64 artifact is a real x86-64 ELF; when arm64 cross-compiles, it is an AArch64 ELF.
        const x64Elf = elfMachine(join(dir, "pulse-linux-x64"));
        expect(x64Elf.isElf).toBe(true);
        expect(x64Elf.machine).toBe(62); // EM_X86_64

        const arm = result.targets.find((t) => t.outfile === "pulse-linux-arm64")!;
        if (arm.ok) {
          const armElf = elfMachine(join(dir, "pulse-linux-arm64"));
          expect(armElf.isElf).toBe(true);
          expect(armElf.machine).toBe(183); // EM_AARCH64
        }

        // SHA256SUMS covers exactly the built binaries and verifies against their bytes.
        const sums = readFileSync(join(dir, CHECKSUMS_FILENAME), "utf8");
        const lines = sums.split("\n").filter((l) => l.length > 0);
        expect(lines.map((l) => l.split("  ")[1]).sort()).toEqual([...result.built].sort());
        for (const name of result.built) {
          expect(sums).toContain(`${sha256File(join(dir, name))}  ${name}`);
        }

        // The build restores the committed sentinel — no injected version left in the tree.
        expect(readFileSync(COMMITTED_VERSION_FILE, "utf8")).toBe(renderVersionModule(VERSION_SENTINEL));
      });
    },
    120_000,
  );
});
