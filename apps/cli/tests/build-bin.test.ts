// apps/cli/tests/build-bin.test.ts — the compiled-binary build pipeline (item 019, 01 §4).
//
// Covers, per the acceptance criteria:
//   • version injection is deterministic and restores the "0.0.0-dev" sentinel (REQ-DET-01);
//   • the committed src/version.ts is exactly the regenerated sentinel form (never hand-edited);
//   • SHA256SUMS is emitted over exactly the built binaries, in coreutils `sha256sum` format;
//   • an x64 `bun build --compile` binary is runnable and prints PULSE_VERSION + the bundled
//     core's supported schema majors on `--version` (REQ-CLI-06);
//   • `runBuild` produces the glibc default artifacts plus the musl variants (correct ELF machine
//     and interpreter) + SHA256SUMS, and the glibc x64 artifact runs on a glibc x64 host.
//
// A musl binary cannot execute on a glibc build host, so the musl artifacts are asserted by their
// ELF machine byte and PT_INTERP path.

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
  CLI_PACKAGE_JSON,
  VERSION_SENTINEL,
  computeSha256Sums,
  readPackageVersion,
  resolveVersionArg,
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

/** The PT_INTERP path of a 64-bit little-endian ELF (the dynamic loader), or `null` if none. */
function elfInterpreter(path: string): string | null {
  const buf = readFileSync(path);
  const phoff = Number(buf.readBigUInt64LE(32));
  const phentsize = buf.readUInt16LE(54);
  const phnum = buf.readUInt16LE(56);
  for (let i = 0; i < phnum; i++) {
    const at = phoff + i * phentsize;
    if (buf.readUInt32LE(at) !== 3) continue; // PT_INTERP
    const offset = Number(buf.readBigUInt64LE(at + 8));
    const size = Number(buf.readBigUInt64LE(at + 32));
    return buf.subarray(offset, offset + size).toString("utf8").replace(/\0+$/, "");
  }
  return null;
}

/** True when the ELF's dynamic loader exists on this host, so the binary can be executed here. */
function elfInterpreterExists(path: string): boolean {
  const interp = elfInterpreter(path);
  return interp !== null && existsSync(interp);
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

describe("build version resolution", () => {
  const argv = ["bun", "scripts/build-bin.ts"];

  test("falls back to the package.json version when no arg or env is given", () => {
    withTmp((dir) => {
      const pkg = join(dir, "package.json");
      writeFileSync(pkg, JSON.stringify({ name: "@pulse/cli", version: "4.5.6" }));
      expect(resolveVersionArg(argv, {}, pkg)).toBe("4.5.6");
      expect(resolveVersionArg(argv, { PULSE_BUILD_VERSION: "" }, pkg)).toBe("4.5.6");
    });
  });

  test("an explicit arg, then PULSE_BUILD_VERSION, win over package.json", () => {
    withTmp((dir) => {
      const pkg = join(dir, "package.json");
      writeFileSync(pkg, JSON.stringify({ version: "4.5.6" }));
      expect(resolveVersionArg([...argv, "7.0.0"], { PULSE_BUILD_VERSION: "8.0.0" }, pkg)).toBe("7.0.0");
      expect(resolveVersionArg(argv, { PULSE_BUILD_VERSION: "8.0.0" }, pkg)).toBe("8.0.0");
    });
  });

  test("uses the sentinel when package.json is missing, malformed or has no version", () => {
    withTmp((dir) => {
      expect(resolveVersionArg(argv, {}, join(dir, "absent.json"))).toBe(VERSION_SENTINEL);
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{not json");
      expect(readPackageVersion(bad)).toBeNull();
      expect(resolveVersionArg(argv, {}, bad)).toBe(VERSION_SENTINEL);
    });
  });

  test("the real apps/cli/package.json carries a version", () => {
    expect(readPackageVersion(CLI_PACKAGE_JSON)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("SHA256SUMS emission (computeSha256Sums)", () => {
  test("the build matrix: glibc defaults first, then the musl variants", () => {
    expect(BUILD_TARGETS.map((t) => [t.outfile, t.target])).toEqual([
      ["pulse-linux-x64", "bun-linux-x64"],
      ["pulse-linux-arm64", "bun-linux-arm64"],
      ["pulse-linux-x64-musl", "bun-linux-x64-musl"],
      ["pulse-linux-arm64-musl", "bun-linux-arm64-musl"],
    ]);
  });

  test("covers exactly the given binaries in coreutils `sha256sum` format", () => {
    withTmp((dir) => {
      const names = ["pulse-linux-x64", "pulse-linux-arm64"];

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

describe("runBuild — glibc + musl artifacts and checksums (CON-03)", () => {
  test(
    "produces the glibc defaults and musl variants (correct ELF machine + interpreter) and a SHA256SUMS over them",
    async () => {
      await withTmpAsync(async (dir) => {
        const result = await runBuild({ version: "9.8.7", outDir: dir });

        // Every target attempted, in BUILD_TARGETS order; the host-arch ones must build here.
        expect(result.targets.map((t) => t.outfile)).toEqual(BUILD_TARGETS.map((t) => t.outfile));
        for (const name of ["pulse-linux-x64", "pulse-linux-x64-musl"]) {
          expect(result.targets.find((t) => t.outfile === name)!.ok).toBe(true);
        }

        const expectElf = (name: string, machine: number, musl: boolean): void => {
          const elf = elfMachine(join(dir, name));
          expect(elf.isElf).toBe(true);
          expect(elf.machine).toBe(machine);
          const interp = elfInterpreter(join(dir, name));
          if (musl) expect(interp).toMatch(/ld-musl-/);
          else expect(interp).toMatch(/ld-linux-/);
        };
        expectElf("pulse-linux-x64", 62, false); // EM_X86_64, glibc loader
        expectElf("pulse-linux-x64-musl", 62, true);
        for (const [name, musl] of [["pulse-linux-arm64", false], ["pulse-linux-arm64-musl", true]] as const) {
          if (result.targets.find((t) => t.outfile === name)!.ok) expectElf(name, 183, musl); // EM_AARCH64
        }

        // The glibc x64 default asset runs as-is on a glibc x64 host and reports the baked version.
        if (process.arch === "x64" && process.platform === "linux" && elfInterpreterExists(join(dir, "pulse-linux-x64"))) {
          const run = Bun.spawnSync([join(dir, "pulse-linux-x64"), "--version"], { stdout: "pipe", stderr: "pipe" });
          expect(run.exitCode).toBe(0);
          expect(run.stdout.toString()).toContain("pulse 9.8.7");
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
